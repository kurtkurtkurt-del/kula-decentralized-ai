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
  private var tls: Gate.TlsServer? = null
  private var api: ApiServer? = null
  private var auditor: Auditor? = null
  private var relay: Relay.Worker? = null
  @Volatile private var relayUrl: String? = null
  @Volatile private var relayCode: String? = null
  @Volatile private var relayError: String? = null
  @Volatile private var running = false
  /** "let my computers use this phone" (Keeper.kt): no v1 secret, a pairing code only for a computer that was scanned, stops itself away from home. */
  @Volatile private var auto = false
  private var hosts: Hosts? = null
  private var advertisedName: String? = null
  private var advertisedPort = 0
  private var advertisedPair: String? = null
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
    /** wss:// of a relay to register with, so a master far away can come in by code (docs/RELAY.md). */
    const val EXTRA_RELAY = "relay"
    /** [MODE_AUTO]: started by Keeper (boot, wi-fi, plug) or the setup screen; no secret needed. */
    const val EXTRA_MODE = "mode"
    const val MODE_AUTO = "auto"
    /** The app scanned a computer's QR (Hosts): open its code on the running gate. */
    const val ACTION_HOST_PIN = "expo.modules.kulallama.HOST_PIN"
    /** Auto mode, the person asked for it: one pairing code for a new device, for PIN_TTL_MS. */
    const val ACTION_OPEN_PIN = "expo.modules.kulallama.OPEN_PIN"
    /** Forget a paired certificate ([EXTRA_FP]) in the running gate too. */
    const val ACTION_FORGET = "expo.modules.kulallama.FORGET"
    const val EXTRA_FP = "fp"
    /** Away from the home wi-fi or unplugged this long before the auto worker stops: a wi-fi roam or a wobbly cable is not leaving. */
    private const val LEAVE_GRACE_MS = 20_000L
    const val SERVICE_TYPE = "_kula._tcp."
    const val PROCESS_SUFFIX = ":worker"
    private const val CHANNEL_ID = "kula-worker"
    private const val NOTIFICATION_ID = 41
    private const val CLAIM_MIN_HELD_MB = 256L

    fun statusFile(context: Context) = File(context.filesDir, "kula_worker_status.json")
    /** The worker process's signing key (PKCS8 + public key, base64) and beyin's ledger. */
    fun deviceKeyFile(context: Context) = File(context.filesDir, "kula_device_key")
    fun ledgerFile(context: Context) = File(File(context.filesDir, "beyin"), "ledger.jsonl")
    /** Protocol v2: the gate's P-256 key + certificate (shared by both processes) and the masters this worker paired with. */
    fun gateDir(context: Context) = File(context.filesDir, "gate")
    fun pairedFile(context: Context) = File(gateDir(context), "paired")
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
    when (intent?.action) {
      ACTION_STOP -> {
        // in auto mode "stop" is a pause: Keeper leaves it stopped until the app starts it again or the phone restarts
        if (auto) Keeper.config(this).let { if (it.on) Keeper.save(this, it.copy(paused = true)) }
        shutdown("stopped"); return START_NOT_STICKY
      }
      ACTION_OPEN_PIN -> {
        if (running) tls?.let { it.open(Gate.newPin(), System.currentTimeMillis() + Gate.PIN_TTL_MS, null); writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb()) }
        return if (auto) START_STICKY else START_NOT_STICKY
      }
      ACTION_FORGET -> {
        intent?.getStringExtra(EXTRA_FP)?.let { fp -> tls?.paired?.forget(fp); hosts?.reload() }
        if (running) writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb())
        return if (auto) START_STICKY else START_NOT_STICKY
      }
      ACTION_HOST_PIN -> if (running) {
        hosts?.reload()
        tls?.let { nextPin(it, fromHost = true) }
        writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb())
        return if (auto) START_STICKY else START_NOT_STICKY
      }
    }
    // a sticky restart (Android killed the process) comes with no intent: only auto mode asks for that
    val wantAuto = intent?.getStringExtra(EXTRA_MODE) == MODE_AUTO || intent?.action == ACTION_HOST_PIN || intent == null
    startForeground(NOTIFICATION_ID, buildNotification("starting…"))
    if (running) return if (auto) START_STICKY else START_NOT_STICKY
    if (wantAuto && !Keeper.config(this).on) { shutdown("off"); return START_NOT_STICKY }
    running = true
    auto = wantAuto
    val port = intent?.getIntExtra(EXTRA_PORT, Gate.DEFAULT_PORT) ?: Gate.DEFAULT_PORT
    // auto mode has no v1 secret: only certificates in the paired list get in (docs/GATE.md, "only known computers")
    val secret: String? = if (auto) null else intent?.getStringExtra(EXTRA_SECRET) ?: run { writeStatus("error", error = "no secret"); shutdown(); return START_NOT_STICKY }
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
        // protocol v2 on the same port: our certificate, the paired masters, a one-time code per qr
        // (the code is spent by the master that proves it; the status file carries the next one)
        val identity = GateIdentity.loadOrCreate(gateDir(this), key)
        hosts = Hosts(Keeper.hostsFile(this))
        // a code lives PIN_TTL_MS: spent by the master that proves it or by time, a new one follows
        // (by hand), or the next scanned computer's code, or none at all (auto mode)
        tls = Gate.TlsServer(identity, Paired(pairedFile(this)), if (auto) null else Gate.newPin(), {
          tls?.let { nextPin(it, fromHost = false) }
          writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb())
        }, if (auto) null else System.currentTimeMillis() + Gate.PIN_TTL_MS)
        // a computer scanned before the worker started: its code now
        tls?.let { t -> hosts?.pending(System.currentTimeMillis())?.let { h -> t.open(h.pin, h.exp, h.fp) } }
        gate = Gate.Server(port, secret, { ch -> if (ch == "rpc") rpcPort else api?.port }, auditor, tls) { ev ->
          when (ev.kind) { "connect" -> connects++; "reject" -> rejects++; "pair" -> ev.fp?.let { hosts?.paired(it, System.currentTimeMillis()) } }
        }.also { it.start() }
        Log.i(TAG, "worker${if (auto) " (auto)" else ""}: $threads threads, $ramMb MB free, %.1f GB/s, gate $port".format(bandwidth))
        val name = intent?.getStringExtra(EXTRA_NAME) ?: Keeper.config(this).name ?: Build.MODEL
        // far away masters: register with the relay; every relayed stream reaches the gate on
        // 127.0.0.1 and is served like any other (tls end to end, the relay sees ciphertext)
        intent?.getStringExtra(EXTRA_RELAY)?.takeIf { it.isNotBlank() }?.let { url ->
          relayUrl = url
          relay = Relay.Worker(url, workerId(this), name, identity.fp, port,
            onCode = { code, _ -> relayCode = code; relayError = null; writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb()) },
            onMaster = { state -> Log.i(TAG, "relay master $state") },
            onError = { err -> relayCode = null; relayError = err; writeStatus("running", peer = gate?.currentPeer, heldMb = residentMb()) },
          ).also { it.start() }
        }
        advertise(port, name)
        writeStatus("running")
        if (Keeper.config(this).on) Keeper.arm(this)
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
    return if (auto) START_STICKY else START_NOT_STICKY
  }

  /**
   * After a code was spent (paired, or out of time) or a computer was scanned: the newest scanned
   * computer's code if one is open, else a fresh code when started by hand, else none. The mDNS
   * record says which computer may pair ("pair" = its id), so its chat page knows this phone.
   */
  private fun nextPin(t: Gate.TlsServer, fromHost: Boolean) {
    val now = System.currentTimeMillis()
    // the gate added the certificate before it spent the code: the scanned computer is known now
    hosts?.let { h -> h.all().filter { it.pin != null && t.paired.contains(it.fp) }.forEach { h.paired(it.fp, now) } }
    val next = hosts?.pending(now)
    when {
      next != null -> t.open(next.pin, next.exp, next.fp)
      fromHost && t.pin != null && t.pinFor == null -> {} // nothing scanned after all: the open code stays
      auto -> t.open(null, null, null)
      else -> t.open(Gate.newPin(), now + Gate.PIN_TTL_MS, null)
    }
    if (advertisedPair != next?.id) readvertise()
  }

  private fun startStatusLoop() {
    thread(name = "kula-worker-status", isDaemon = true) {
      var last = ""
      var lastAudit = 0L
      var lastWarn = ""
      var leaving: Pair<String, Long>? = null
      var lastLook = 0L
      while (running) {
        // auto mode: off the home wi-fi or unplugged ("only while charging") for LEAVE_GRACE_MS, then stop
        if (auto && System.currentTimeMillis() - lastLook >= 5000) {
          lastLook = System.currentTimeMillis()
          val d = runCatching { Keeper.decision(this) }.getOrDefault("start")
          if (d == "start") leaving = null
          else if (d == "off" || d == "paused" || d == "nohome") { shutdown(d); return@thread }
          else {
            val l = leaving?.takeIf { it.first == d } ?: (d to lastLook).also { leaving = it }
            if (lastLook - l.second >= LEAVE_GRACE_MS) {
              if (d == "unplugged") Keeper.armCharging(this)
              shutdown(d); return@thread
            }
          }
        }
        // a pairing code nobody used in PIN_TTL_MS is replaced here, so the qr on screen never shows a dead one
        tls?.let { if (it.expired(System.currentTimeMillis())) it.spend() }
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
            // the claim only once a master has put a model here: before that RSS is this
            // process alone and the advertised RAM would look like a 4x lie every minute
            if (peer != null && held >= CLAIM_MIN_HELD_MB) runCatching { a.onClaim(peer, ramMb, held, bandwidth, 0.0, 0.0) }
            lastAudit = nowMs; lastWarn = warn
          }
        }
        val text = if (peer != null) "working for $peer · holding %.1f GB".format(held / 1024.0) else if (auto) "ready for your computers" else "ready · waiting for a device"
        if (text != last) { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text)); last = text }
        Thread.sleep(2000)
      }
    }
  }

  /** Samsung moves heavy background work into an "abnormal" cpuset (slow cores only). */
  private fun isThrottled(): Boolean = runCatching {
    File("/proc/self/cgroup").readLines().any { it.endsWith("/abnormal") || it.endsWith("cpu:/background") || it.endsWith("cpuset:/background") }
  }.getOrDefault(false)

  private fun writeStatus(state: String, error: String? = null, peer: String? = null, heldMb: Long = 0, why: String? = null) {
    val json = JSONObject().put("state", state).put("mode", if (auto) "auto" else "manual").put("ramMb", ramMb).put("bandwidth", bandwidth).put("heldMb", heldMb)
      .put("throttled", isThrottled()).put("connects", connects).put("rejects", rejects).put("pid", Process.myPid())
    if (error != null) json.put("error", error)
    if (peer != null) json.put("peer", peer)
    if (why != null) json.put("why", why)
    // what the v3 qr needs: this worker's certificate fingerprint and the open pairing code; a
    // code made for one scanned computer is not shown (no other device could use it)
    tls?.let { t ->
      val forHost = t.pinFor
      json.put("fp", t.identity.fp).put("pin", if (forHost == null) t.pin ?: JSONObject.NULL else JSONObject.NULL).put("paired", t.paired.size())
      if (forHost != null && t.pin != null) json.put("pairFor", hosts?.byFp(forHost)?.name ?: "computer")
    }
    // the relay code for the v3 qr (and the "share far away" screen), or why there is none yet
    val url = relayUrl
    val code = relayCode
    if (url != null && code != null) json.put("relay", JSONObject().put("url", url).put("code", code))
    relayError?.let { json.put("relayError", it) }
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
    advertisedName = name; advertisedPort = port
    val pair = tls?.takeIf { it.pin != null }?.pinFor?.let { fp -> hosts?.byFp(fp)?.id }
    advertisedPair = pair
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
      // the gate's certificate (public: it is in every qr) and, while a scanned computer's
      // code is open, that computer's id, so its chat page knows which phone to pair with
      tls?.let { setAttribute("fp", it.identity.fp) }
      if (auto) setAttribute("auto", "1")
      if (pair != null) setAttribute("pair", pair.take(64))
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

  /** NSD has no update: the record goes and comes back with the new attributes. */
  private fun readvertise() {
    val name = advertisedName ?: return
    try { registration?.let { nsd?.unregisterService(it) } } catch (_: IllegalArgumentException) {}
    registration = null
    advertise(advertisedPort, name)
  }

  private fun acquireLocks() {
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kula:worker").apply { acquire() }
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
    wifiLock = wifi.createWifiLock(mode, "kula:worker").apply { acquire() }
  }

  private fun shutdown(why: String? = null) {
    running = false
    relay?.stop()
    gate?.stop(); api?.stop()
    try { registration?.let { nsd?.unregisterService(it) } } catch (_: IllegalArgumentException) {}
    registration = null
    wifiLock?.takeIf { it.isHeld }?.release()
    wakeLock?.takeIf { it.isHeld }?.release()
    if (readStatus(this).optString("state") != "error") writeStatus("stopped", why = why)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    Process.killProcess(Process.myPid())
  }

  private fun buildNotification(text: String) = NotificationCompat.Builder(this, ensureChannel())
    .setSmallIcon(android.R.drawable.stat_notify_sync)
    .setContentTitle(if (auto) "kula" else "kula: this phone is shared")
    .setContentText(text)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .addAction(0, if (auto) "pause" else "stop", PendingIntent.getService(this, 0, Intent(this, WorkerService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE))
    .build()

  private fun ensureChannel(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "shared phone", NotificationManager.IMPORTANCE_LOW).apply { setSound(null, null) })
    }
    return CHANNEL_ID
  }
}
