package expo.modules.kulallama

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The JS face of kula-llama (src/llm/native.ts). The app process is the master / local
 * runner: it loads a model, generates, downloads, finds peers and opens tunnels. The worker
 * runs in WorkerService's own process and is only started/stopped/read from here.
 */
class KulaLlamaModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw CodedException("no react context")
  private val exec = Executors.newSingleThreadExecutor { Thread(it, "kula-llama").apply { isDaemon = true } }
  private val requestIds = AtomicInteger(1)
  private val tunnels = mutableMapOf<String, Gate.Tunnel>()
  /** This phone's certificate as a master (protocol v2); the same files the worker process uses, so one identity per phone. */
  private val identity: GateIdentity by lazy {
    GateIdentity.loadOrCreate(WorkerService.gateDir(context), expo.modules.kulallama.audit.SoftwareKey.loadOrCreate(WorkerService.deviceKeyFile(context)))
  }
  /** `{fp, pin?}` from JS (a v3 peer) → the tls client side; null for a v2 peer (protocol v1 with the secret). */
  private fun tlsOf(m: Map<String, Any?>?): Gate.TlsClient? {
    val fp = m?.get("fp") as? String ?: return null
    return Gate.TlsClient(identity, fp.lowercase(), m["pin"] as? String)
  }
  private var discovery: Discovery? = null
  private var downloader: ModelDownloader? = null
  private var bound = false
  private val workerPriority = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, service: IBinder?) {}
    override fun onServiceDisconnected(name: ComponentName?) {}
  }

  override fun definition() = ModuleDefinition {
    Name("KulaLlama")
    Events("onToken", "onDone", "onDownload", "onPeerFound", "onPeerLost")

    Constants("abi" to (Build.SUPPORTED_ABIS.firstOrNull() ?: "?"), "gatePort" to Gate.DEFAULT_PORT)

    OnCreate {
      // the worker borrows the app's priority while the app is on screen (Samsung cpusets)
      runCatching {
        context.bindService(Intent(context, WorkerService::class.java), workerPriority, Context.BIND_IMPORTANT)
        bound = true
      }
    }
    OnDestroy {
      if (bound) runCatching { context.unbindService(workerPriority) }
      tunnels.values.forEach { it.stop() }
      discovery?.stop()
    }

    // --- device ---------------------------------------------------------------------
    AsyncFunction("info") {
      val arm64 = Build.SUPPORTED_ABIS.contains("arm64-v8a")
      val ok = arm64 && runCatching { Native.initBackends(context.applicationInfo.nativeLibraryDir) }.getOrDefault(false)
      mapOf(
        "available" to ok,
        "abi" to (Build.SUPPORTED_ABIS.firstOrNull() ?: "?"),
        "fastCores" to Native.fastCoreCount(),
        "ramFreeMb" to WorkerService.availableRamMb(context),
        "modelsDir" to WorkerService.modelsDir(context).apply { mkdirs() }.absolutePath,
        "freeDiskMb" to context.filesDir.usableSpace / (1024 * 1024),
        "workerId" to WorkerService.workerId(context),
        "wifiIp" to wifiIp(),
      )
    }

    AsyncFunction("memBandwidth") { threads: Int -> Native.memBandwidth(if (threads > 0) threads else Native.fastCoreCount()) }
    AsyncFunction("ggufMeta") { path: String -> Native.meta(path) }
    AsyncFunction("sha256") { path: String -> ModelDownloader.sha256Of(File(path)) }
    AsyncFunction("deleteFile") { path: String -> File(path).delete() || File("$path.part").delete() }
    AsyncFunction("listModels") {
      WorkerService.modelsDir(context).listFiles()?.map { mapOf("name" to it.name, "path" to it.absolutePath, "size" to it.length(), "partial" to it.name.endsWith(".part")) } ?: emptyList<Map<String, Any>>()
    }

    // --- download ---------------------------------------------------------------------
    AsyncFunction("download") { id: String, url: String, name: String, sha256: String?, size: Double ->
      val dl = downloader ?: ModelDownloader { did, got, total, state, error ->
        sendEvent("onDownload", mapOf("id" to did, "got" to got.toDouble(), "total" to total.toDouble(), "state" to state, "error" to error))
      }.also { downloader = it }
      dl.start(id, url, File(WorkerService.modelsDir(context).apply { mkdirs() }, name), sha256, size.toLong())
    }
    AsyncFunction("cancelDownload") { id: String -> downloader?.cancel(id) }

    // --- model ------------------------------------------------------------------------
    AsyncFunction("loadModel") { path: String, ctx: Int, threads: Int, peers: List<Map<String, Any?>>, localWeight: Double ->
      // peers: [{host, port, secret, weight, fp?, pin?}] → one tunnel each, llama connects to 127.0.0.1
      tunnels.values.forEach { it.stop() }; tunnels.clear()
      val endpoints = ArrayList<String>()
      val weights = ArrayList<Float>()
      for (p in peers) {
        val host = p["host"] as String
        val port = (p["port"] as Number).toInt()
        val secret = p["secret"] as? String ?: ""
        val tls = tlsOf(p)
        Gate.probe(host, port, secret, "rpc", tls = tls)?.let { throw CodedException("peer $host: $it") }
        val t = Gate.Tunnel(host, port, secret, "rpc", tls)
        val local = t.start()
        tunnels["$host:$port"] = t
        endpoints.add("127.0.0.1:$local")
        weights.add(((p["weight"] as? Number)?.toFloat() ?: 1f))
      }
      Native.initBackends(context.applicationInfo.nativeLibraryDir)
      if (Native.isLoaded()) Native.freeModel()
      val start = System.currentTimeMillis()
      val info = try {
        Native.loadModel(path, if (threads > 0) threads else Native.fastCoreCount(), ctx, endpoints.toTypedArray(), weights.toFloatArray(), localWeight.toFloat())
      } catch (e: RuntimeException) {
        tunnels.values.forEach { it.stop() }; tunnels.clear()
        throw CodedException(e.message ?: "load failed")
      }.split('\t')
      val split = Native.lastLoadBuffers().lines().filter { it.contains('\t') }.map {
        mapOf("buffer" to it.substringBefore('\t'), "mb" to it.substringAfter('\t').toDoubleOrNull())
      }
      mapOf("loadMs" to System.currentTimeMillis() - start, "localLayers" to info[0].toInt(), "layers" to info[1].toInt(), "ctx" to info[2].toInt(), "split" to split)
    }
    AsyncFunction("unload") {
      Native.freeModel()
      tunnels.values.forEach { it.stop() }; tunnels.clear()
    }
    Function("isLoaded") { Native.isLoaded() }
    Function("tokensUsed") { Native.tokensUsed() }
    Function("contextSize") { Native.contextSize() }
    AsyncFunction("clearContext") { Native.clearContext() }

    // Streams onToken {id, text} and ends with onDone {id, tokens, ms, firstMs, tps, stopped}.
    Function("generate") { messages: List<Map<String, String>>, maxTokens: Int, temperature: Double, topP: Double, reset: Boolean ->
      val id = requestIds.getAndIncrement()
      exec.execute {
        val start = System.currentTimeMillis()
        var first = 0L
        try {
          if (reset) Native.clearContext()
          val prompt = Native.applyTemplate(messages.map { it["role"] ?: "user" }.toTypedArray(), messages.map { it["content"] ?: "" }.toTypedArray())
          val n = Native.generate(prompt, maxTokens, temperature.toFloat(), topP.toFloat(), 40, 0.05f, 1.1f, -1) { piece ->
            if (first == 0L) first = System.currentTimeMillis()
            sendEvent("onToken", mapOf("id" to id, "text" to piece))
          }
          val ms = System.currentTimeMillis() - start
          sendEvent("onDone", mapOf("id" to id, "tokens" to n, "ms" to ms, "firstMs" to (if (first > 0) first - start else ms),
            "tps" to (if (n > 0 && ms > 0) n * 1000.0 / ms else 0.0), "stopped" to (n < 0), "error" to null))
        } catch (e: Exception) {
          sendEvent("onDone", mapOf("id" to id, "tokens" to 0, "ms" to (System.currentTimeMillis() - start), "firstMs" to 0, "tps" to 0.0, "stopped" to false, "error" to (e.message ?: "generate failed")))
        }
      }
      id
    }
    Function("stop") { Native.stop() }

    // --- peers --------------------------------------------------------------------------
    /** `tls` is `{fp, pin?}` for a v3 peer (protocol v2 over tls), null for a v2 peer (the secret). */
    AsyncFunction("probePeer") { host: String, port: Int, secret: String, channel: String, tls: Map<String, Any?>? -> Gate.probe(host, port, secret, channel, tls = tlsOf(tls)) }
    /** Opens (or reuses) an `api` tunnel to a peer; JS talks HTTP to 127.0.0.1:<port>. */
    AsyncFunction("apiTunnel") { host: String, port: Int, secret: String, tls: Map<String, Any?>? ->
      val key = "api:$host:$port"
      tunnels[key]?.localPort ?: Gate.Tunnel(host, port, secret, "api", tlsOf(tls)).let { t -> t.start().also { tunnels[key] = t } }
    }
    /** This phone's own certificate fingerprint (what a worker pins once paired). */
    AsyncFunction("gateFingerprint") { identity.fp }
    AsyncFunction("closeTunnels") { tunnels.values.forEach { it.stop() }; tunnels.clear() }
    AsyncFunction("discover") { on: Boolean ->
      if (on) {
        if (discovery == null) discovery = Discovery(context, { sendEvent("onPeerFound", it) }, { sendEvent("onPeerLost", mapOf("serviceName" to it)) })
        discovery?.start()
      } else { discovery?.stop() }
    }

    // --- worker (this phone shared) --------------------------------------------------------
    AsyncFunction("startWorker") { port: Int, secret: String, name: String ->
      val intent = Intent(context, WorkerService::class.java).putExtra(WorkerService.EXTRA_PORT, port)
        .putExtra(WorkerService.EXTRA_SECRET, secret).putExtra(WorkerService.EXTRA_NAME, name)
      ContextCompat.startForegroundService(context, intent)
    }
    AsyncFunction("stopWorker") {
      if (WorkerService.isRunning(context)) context.startService(Intent(context, WorkerService::class.java).setAction(WorkerService.ACTION_STOP))
    }
    AsyncFunction("workerStatus") {
      val s = WorkerService.readStatus(context)
      val alive = WorkerService.isRunning(context)
      val state = s.optString("state", "stopped").let { if (!alive && it != "error") "stopped" else it }
      mapOf(
        "state" to state, "error" to s.optString("error").ifEmpty { null },
        "peer" to s.optString("peer").ifEmpty { null }?.takeIf { alive },
        "heldMb" to s.optLong("heldMb"), "ramMb" to s.optLong("ramMb"), "bandwidth" to s.optDouble("bandwidth", 0.0),
        "throttled" to (alive && s.optBoolean("throttled")), "connects" to s.optInt("connects"), "rejects" to s.optInt("rejects"),
        "id" to WorkerService.workerId(context), "batteryUnrestricted" to batteryUnrestricted(),
        // protocol v2: the worker's certificate and the open pairing code for the v3 qr
        "fp" to s.optString("fp").ifEmpty { null }?.takeIf { alive }, "pin" to s.optString("pin").ifEmpty { null }?.takeIf { alive && !s.isNull("pin") },
        "paired" to s.optInt("paired"),
      )
    }
    AsyncFunction("gateLedger") { limit: Int ->
      // beyin's signed ledger (one JSON string per line); the old plain file is read while one is still around
      val ledger = WorkerService.ledgerFile(context)
      if (ledger.exists()) expo.modules.kulallama.audit.Ledger.tail(ledger, limit)
      else File(context.filesDir, "kula_gate_ledger.jsonl").takeIf { it.exists() }?.readLines()?.takeLast(limit) ?: emptyList()
    }
    AsyncFunction("keepScreenOn") { on: Boolean ->
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        if (on) activity.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
    AsyncFunction("requestBatteryUnrestricted") {
      if (!batteryUnrestricted()) {
        @Suppress("BatteryLife")
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }.onFailure {
          context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      batteryUnrestricted()
    }
  }

  private fun batteryUnrestricted(): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return pm.isIgnoringBatteryOptimizations(context.packageName)
  }

  private fun wifiIp(): String? = runCatching {
    java.net.NetworkInterface.getNetworkInterfaces().toList()
      .filter { it.isUp && !it.isLoopback && (it.name.startsWith("wlan") || it.name.startsWith("ap") || it.name.startsWith("eth") || it.name.startsWith("swlan")) }
      .flatMap { it.inetAddresses.toList() }
      .firstOrNull { it is java.net.Inet4Address }?.hostAddress
  }.getOrNull()
}
