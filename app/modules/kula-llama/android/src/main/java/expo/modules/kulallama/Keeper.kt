package expo.modules.kulallama

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.net.Inet4Address

/**
 * Ready by itself (8.11.2026): while "let my computers use this phone" is on, the worker starts
 * without a tap when the phone boots, when it joins the home wi-fi and when it is plugged in,
 * and the worker stops itself when it leaves (WorkerService's auto mode). All native, so it
 * works with the app closed: the JS only flips the switch (KulaLlamaModule.setAuto).
 *
 * The triggers, each one calling [check]:
 *  - boot: [KeeperReceiver] on BOOT_COMPLETED (after the first unlock) and on an app update
 *  - wi-fi: a network request with a PendingIntent ([KeeperReceiver.ACTION_NET]), which Android
 *    keeps while the app process is gone; armed again at every boot and app start
 *  - plug: a JobScheduler job that needs charging ([KeeperJob]), armed when "unplugged" is the
 *    one reason the worker is not running
 *  - every 15 minutes a periodic job, in case Android killed the worker or a trigger was missed
 * Starting a foreground service from the background needs the battery exemption on Android 12+
 * (the setup screen asks for it); without it [check] posts a notification to tap instead.
 */
object Keeper {
  private const val TAG = "kula-keeper"
  private const val JOB_PERIODIC = 4101
  private const val JOB_CHARGING = 4102
  private const val TAP_ID = 42
  private const val TAP_CHANNEL = "kula-ready"

  fun configFile(context: Context) = File(context.filesDir, "kula_auto.json")
  fun hostsFile(context: Context) = File(WorkerService.gateDir(context), "hosts.json")
  fun config(context: Context): Auto.Config = Auto.load(configFile(context))
  fun save(context: Context, c: Auto.Config) = Auto.save(configFile(context), c)

  /** The wi-fi the phone is on now, as Auto.Net; null when it is on none. Needs no location permission (the name only comes with it). */
  @Suppress("DEPRECATION")
  fun currentNet(context: Context): Auto.Net? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val wifi: Network = cm.allNetworks.firstOrNull { n -> cm.getNetworkCapabilities(n)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true } ?: return null
    val lp: LinkProperties = cm.getLinkProperties(wifi) ?: return null
    return netOf(context, lp)
  }

  @Suppress("DEPRECATION")
  fun netOf(context: Context, lp: LinkProperties): Auto.Net? {
    val v4 = lp.linkAddresses.firstOrNull { it.address is Inet4Address } ?: return null
    val subnet = Auto.Net.subnetOf(v4.address.hostAddress ?: return null, v4.prefixLength) ?: return null
    val gateway = lp.routes.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address }?.gateway?.hostAddress
    val ssid = runCatching { Auto.Net.ssidOf((context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo?.ssid) }.getOrNull()
    return Auto.Net(subnet, gateway, lp.domains?.takeIf { it.isNotBlank() }, ssid)
  }

  fun charging(context: Context): Boolean {
    val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val plugged = sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
    return plugged != 0
  }

  fun batteryUnrestricted(context: Context): Boolean =
    (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName)

  /** Why the worker should or should not run now (Auto.decide): "start", "off", "nohome", "paused", "away", "unplugged". */
  fun decision(context: Context): String = Auto.decide(config(context), currentNet(context), charging(context))

  /**
   * The one place the triggers end up: starts the worker in auto mode when it should run and
   * is not running, arms the plug job when the plug is what is missing. Never stops a worker:
   * the worker watches its own wi-fi and plug, and a worker started by hand is left alone.
   */
  fun check(context: Context, why: String) {
    val c = config(context)
    if (!c.on) return
    val d = decision(context)
    Log.i(TAG, "check ($why): $d")
    when (d) {
      "start" -> if (!WorkerService.isRunning(context)) start(context, why)
      "unplugged" -> armCharging(context)
    }
  }

  /** Starts the worker in auto mode; when Android does not let a background app do that, a notification to tap. */
  fun start(context: Context, why: String) {
    val intent = Intent(context, WorkerService::class.java).putExtra(WorkerService.EXTRA_MODE, WorkerService.MODE_AUTO)
    try {
      ContextCompat.startForegroundService(context, intent)
      cancelTap(context)
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (Android 12+, no battery exemption): a tap on
      // a notification is a user action, which may start it
      Log.w(TAG, "start ($why) refused: ${e.message}")
      postTap(context)
    }
  }

  /** Arms every trigger; idempotent (the same PendingIntent and job ids replace the old ones). */
  fun arm(context: Context) {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
    runCatching { cm.registerNetworkCallback(req, netIntent(context)) }.onFailure { Log.w(TAG, "wi-fi trigger: ${it.message}") }
    val js = (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler)
    if (js.getPendingJob(JOB_PERIODIC) == null) {
      runCatching {
        js.schedule(JobInfo.Builder(JOB_PERIODIC, ComponentName(context, KeeperJob::class.java))
          .setPeriodic(15 * 60_000L).setPersisted(true).build())
      }.onFailure { Log.w(TAG, "periodic job: ${it.message}") }
    }
  }

  fun disarm(context: Context) {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    runCatching { cm.unregisterNetworkCallback(netIntent(context)) }
    val js = (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler)
    js.cancel(JOB_PERIODIC); js.cancel(JOB_CHARGING)
    cancelTap(context)
  }

  fun armCharging(context: Context) {
    val js = (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler)
    if (js.getPendingJob(JOB_CHARGING) != null) return
    runCatching {
      js.schedule(JobInfo.Builder(JOB_CHARGING, ComponentName(context, KeeperJob::class.java))
        .setRequiresCharging(true).setPersisted(true).build())
    }.onFailure { Log.w(TAG, "charging job: ${it.message}") }
  }

  private fun netIntent(context: Context): PendingIntent {
    val i = Intent(context, KeeperNetReceiver::class.java).setAction(KeeperReceiver.ACTION_NET)
    // mutable: Android adds the network to the intent; explicit, so that is allowed on 14+
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getBroadcast(context, 0, i, flags)
  }

  private fun postTap(context: Context) {
    val nm = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(TAP_CHANNEL, "ready for your computers", NotificationManager.IMPORTANCE_LOW))
    }
    val start = Intent(context, WorkerService::class.java).putExtra(WorkerService.EXTRA_MODE, WorkerService.MODE_AUTO)
    val pi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) PendingIntent.getForegroundService(context, 1, start, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      else PendingIntent.getService(context, 1, start, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    runCatching {
      nm.notify(TAP_ID, NotificationCompat.Builder(context, TAP_CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("kula")
        .setContentText("home wi-fi: tap to get ready for your computers")
        .setContentIntent(pi).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_LOW).build())
    }
  }

  private fun cancelTap(context: Context) { runCatching { context.getSystemService(NotificationManager::class.java).cancel(TAP_ID) } }
}

/** The wi-fi trigger, apart so the exported boot receiver never takes it from another app. */
class KeeperNetReceiver : KeeperReceiver()

/** Boot, app update and (as [KeeperNetReceiver]) the wi-fi trigger. */
open class KeeperReceiver : BroadcastReceiver() {
  companion object { const val ACTION_NET = "expo.modules.kulallama.KEEPER_NET" }

  override fun onReceive(context: Context, intent: Intent) {
    val c = Keeper.config(context)
    if (!c.on) return
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> if (this !is KeeperNetReceiver) {
        // a restart lifts a pause from the notification; the network request is gone after one
        if (c.paused) Keeper.save(context, c.copy(paused = false))
        Keeper.arm(context)
        Keeper.check(context, "boot")
      }
      ACTION_NET -> if (this is KeeperNetReceiver) {
        // the wi-fi is up, but its addresses may come a moment later: look now and once more soon
        val pending = goAsync()
        Thread {
          try {
            Keeper.check(context, "wifi")
            if (!WorkerService.isRunning(context)) { Thread.sleep(4000); Keeper.check(context, "wifi+4s") }
          } finally { pending.finish() }
        }.start()
      }
    }
  }
}

/** The plug trigger and the 15 minute safety net. */
class KeeperJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Keeper.check(this, if (params.jobId == 4102) "plug" else "periodic")
    return false
  }
  override fun onStopJob(params: JobParameters): Boolean = false
}
