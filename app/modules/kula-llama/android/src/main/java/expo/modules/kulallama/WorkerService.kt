package expo.modules.kulallama

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import expo.modules.kulallama.audit.Auditor
import expo.modules.kulallama.audit.Ledger
import expo.modules.kulallama.audit.SoftwareKey
import expo.modules.kulallama.audit.Checks
import org.json.JSONObject
import java.io.File
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * This device as a worker ("share this phone"): the gate on the network, and behind it on
 * 127.0.0.1 ggml's RPC server (split mode) and the ApiServer (apart mode). Advertised over
 * NSD as _kula._tcp so a master nearby can find it.
 *
 * Lives in its own process (":worker"): ggml's server loop can't be stopped, so stopping
 * the worker ends the process. State goes to the app through [statusFile] (JSON).
 * After PrivateLM's ClusterWorkerService (MIT).
 */
class WorkerService : Service() {
  private var nsd: NsdManager? = null
  private var registration: NsdManager.RegistrationListener? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var gate: Gate.Server? = null
  private var api: ApiServer? = null
  private var auditor: Auditor? = null
  @Volatile private var running = false
  @Volatile private var rpcPort = 0
  private var ramMb = 0L
  private var bandwidth = 0.0
  private var connects = 0
  private var rejects = 0

  companion object {
    private const val TAG = "kula-worker"
    const val ACTION_STOP = "expo.modules.kulallama.STOP_WORKER"
    const val EXTRA_PORT = "port"
    const val EXTRA_SECRET = "secret"
    const val EXTRA_NAME = "name"
    const val SERVICE_TYPE = "_kula._tcp."
    const val PROCESS_SUFFIX = ":worker"
    private const val CHANNEL_ID = "kula-worker"
    private const val NOTIFICATION_ID = 41

    fun statusFile(context: Context) = File(context.filesDir, "kula_worker_status.json")
    /** The worker process's signing key (PKCS8 + public key, base64) and beyin's ledger. */
    fun deviceKeyFile(context: Context) = File(context.filesDir, "kula_device_key")
    fun ledgerFile(context: Context) = File(File(context.filesDir, "beyin"), "ledger.jsonl")
    fun modelsDir(context: Context) = File(context.filesDir, "models")

    /** Lasting worker id, in a file so both processes agree. */
    @Synchronized
    fun workerId(context: Context): String {
      val f = File(context.filesDir, "kula_worker_id")
      f.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
      return java.util.UUID.randomUUID().toString().also { f.writeText(it) }
    }

    fun readStatus(context: Context): JSONObject =
      statusFile(context).takeIf { it.exists() }?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }
        ?: JSONObject().put("state", "stopped")

    fun availableRamMb(context: Context): Long {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val info = ActivityManager.MemoryInfo()
      am.getMemoryInfo(info)
      return info.availMem / (1024 * 1024)
    }

    fun isRunning(context: Context): Boolean {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val name = context.packageName + PROCESS_SUFFIX
      return am.runningAppProcesses?.any { it.processName == name } == true
    }
  }

  /** Bound by the app only to share its priority (BIND_IMPORTANT). */
  override fun onBind(intent: Intent?): IBinder = android.os.Binder()

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) { shutdown(); return START_NOT_STICKY }
    startForeground(NOTIFICATION_ID, buildNotification("starting…"))
    if (running) return START_NOT_STICKY
    running = true
    val port = intent?.getIntExtra(EXTRA_PORT, Gate.DEFAULT_PORT) ?: Gate.DEFAULT_PORT
    val secret = intent?.getStringExtra(EXTRA_SECRET) ?: run { writeStatus("error", error = "no secret"); shutdown(); return START_NOT_STICKY }
    val threads = Native.fastCoreCount()
    acquireLocks()
    writeStatus("starting")
    val cacheDir = File(filesDir, "rpc_cache").apply { mkdirs() }
    thread(name = "kula-worker") {
      try {
        ramMb = availableRamMb(this)
        bandwidth = Native.memBandwidth(threads)
        Native.initBackends(applicationInfo.nativeLibraryDir)
        rpcPort = ServerSocket(0).use { it.localPort }
        api = ApiServer(this, modelsDir(this).apply { mkdirs() }, threads).also { it.start() }
        // beyin/check v0: every gate event goes to the signed ledger; replays and bad clocks are refused
        val key = SoftwareKey.loadOrCreate(deviceKeyFile(this))
        auditor = Auditor(Ledger(ledgerFile(this), key), key)
        gate = Gate.Server(port, secret, { ch -> if (ch == "rpc") rpcPort else api?.port }, auditor) { ev ->
          when (ev.kind) { "connect" -> connects++; "reject" -> rejects++ }
        }.also { it.start() }
        Log.i(TAG, "worker: $threads threads, $ramMb MB free, %.1f GB/s, gate $port".format(bandwidth))
        advertise(port, intent?.getStringExtra(EXTRA_NAME) ?: Build.MODEL)
        writeStatus("running")
        startStatusLoop()
        // blocks for the life of the process
        val error = Native.serve(applicationInfo.nativeLibraryDir, "127.0.0.1:$rpcPort", cacheDir.absolutePath, threads)
        Log.e(TAG, "rpc server exited: $error")
        writeStatus("error", error = error)
      } catch (e: Exception) {
        Log.e(TAG, "worker failed: ${e.message}")
        writeStatus("error", error = e.message ?: "worker failed")
      }
      shutdown()
    }
    return START_NOT_STICKY
  }

  private fun startStatusLoop() {
    thread(name = "kula-worker-status", isDaemon = true) {
      var last = ""
      var lastAudit = 0L
      var lastWarn = ""
      while (running) {
        val peer = gate?.currentPeer ?: Native.workerPeer()
        val held = residentMb()
        writeStatus("running", peer = peer, heldMb = held)
        // health every minute or when its warnings change; the claim (advertised vs held) while a master is connected
        auditor?.let { a ->
          val throttled = isThrottled()
          val warn = Checks.health(throttled, batteryC(), batteryPct()).warn.joinToString(",")
          val nowMs = System.currentTimeMillis()
          if (nowMs - lastAudit >= 60_000 || warn != lastWarn) {
            runCatching { a.onHealth(throttled, batteryC(), batteryPct()) }
            if (peer != null) runCatching { a.onClaim(peer, ramMb, held, bandwidth, 0.0, 0.0) }
            lastAudit = nowMs; lastWarn = warn
          }
        }
        val text = if (peer != null) "working for $peer · holding %.1f GB".format(held / 1024.0) else "ready · waiting for a device"
        if (text != last) { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text)); last = text }
        Thread.sleep(2000)
      }
    }
  }

  /** Samsung moves heavy background work into an "abnormal" cpuset (slow cores only). */
  private fun isThrottled(): Boolean = runCatching {
    File("/proc/self/cgroup").readLines().any { it.endsWith("/abnormal") || it.endsWith("cpu:/background") || it.endsWith("cpuset:/background") }
  }.getOrDefault(false)

  private fun writeStatus(state: String, error: String? = null, peer: String? = null, heldMb: Long = 0) {
    val json = JSONObject().put("state", state).put("ramMb", ramMb).put("bandwidth", bandwidth).put("heldMb", heldMb)
      .put("throttled", isThrottled()).put("connects", connects).put("rejects", rejects).put("pid", Process.myPid())
    if (error != null) json.put("error", error)
    if (peer != null) json.put("peer", peer)
    statusFile(this).writeText(json.toString())
  }

  // battery through Android, kept here so the audit core stays plain JVM
  private fun batteryPct(): Int = runCatching {
    (getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
  }.getOrDefault(-1)

  private fun batteryC(): Double = runCatching {
    val sticky = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val tenths = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
    if (tenths == Int.MIN_VALUE) 0.0 else tenths / 10.0
  }.getOrDefault(0.0)

  private fun residentMb(): Long = File("/proc/self/status").readLines().firstOrNull { it.startsWith("VmRSS:") }
    ?.filter { it.isDigit() }?.toLongOrNull()?.div(1024) ?: 0L

  private fun advertise(port: Int, name: String) {
    val info = NsdServiceInfo().apply {
      serviceName = "kula $name"
      serviceType = SERVICE_TYPE
      setPort(port)
      setAttribute("id", workerId(this@WorkerService))
      setAttribute("ram", ramMb.toString())
      setAttribute("bw", "%.1f".format(java.util.Locale.US, bandwidth))
      setAttribute("name", name.take(40))
      setAttribute("kind", "phone")
      setAttribute("v", "rpc7")
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(i: NsdServiceInfo) { Log.i(TAG, "advertised as ${i.serviceName}") }
      override fun onRegistrationFailed(i: NsdServiceInfo, code: Int) { Log.e(TAG, "nsd registration failed ($code); pair by qr") }
      override fun onServiceUnregistered(i: NsdServiceInfo) {}
      override fun onUnregistrationFailed(i: NsdServiceInfo, code: Int) {}
    }
    nsd = getSystemService(Context.NSD_SERVICE) as NsdManager
    nsd?.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    registration = listener
  }

  private fun acquireLocks() {
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kula:worker").apply { acquire() }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
    wifiLock = wifi.createWifiLock(mode, "kula:worker").apply { acquire() }
  }

  private fun shutdown() {
    running = false
    gate?.stop(); api?.stop()
    try { registration?.let { nsd?.unregisterService(it) } } catch (_: IllegalArgumentException) {}
    registration = null
    wifiLock?.takeIf { it.isHeld }?.release()
    wakeLock?.takeIf { it.isHeld }?.release()
    if (readStatus(this).optString("state") != "error") writeStatus("stopped")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    Process.killProcess(Process.myPid())
  }

  private fun buildNotification(text: String) = NotificationCompat.Builder(this, ensureChannel())
    .setSmallIcon(android.R.drawable.stat_notify_sync)
    .setContentTitle("kula: this phone is shared")
    .setContentText(text)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .addAction(0, "stop", PendingIntent.getService(this, 0, Intent(this, WorkerService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE))
    .build()

  private fun ensureChannel(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "shared phone", NotificationManager.IMPORTANCE_LOW).apply { setSound(null, null) })
    }
    return CHANNEL_ID
  }
}
