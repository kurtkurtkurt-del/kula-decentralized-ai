package expo.modules.kulallama

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

/**
 * Finds workers nearby: browses _kula._tcp and resolves each service as it appears.
 * [onFound] gets a map the JS side keeps as a peer candidate; [onLost] its id/name.
 */
class Discovery(private val context: Context, private val onFound: (Map<String, Any?>) -> Unit, private val onLost: (String) -> Unit) {
  private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private var listener: NsdManager.DiscoveryListener? = null
  private val resolving = java.util.concurrent.ConcurrentLinkedQueue<NsdServiceInfo>()
  @Volatile private var busy = false

  fun start() {
    if (listener != null) return
    val l = object : NsdManager.DiscoveryListener {
      override fun onServiceFound(info: NsdServiceInfo) { if (info.serviceType.startsWith(WorkerService.SERVICE_TYPE.trimEnd('.'))) { resolving.add(info); next() } }
      override fun onServiceLost(info: NsdServiceInfo) { onLost(info.serviceName) }
      override fun onDiscoveryStarted(t: String) {}
      override fun onDiscoveryStopped(t: String) {}
      override fun onStartDiscoveryFailed(t: String, code: Int) { Log.e(TAG, "discovery failed ($code)") }
      override fun onStopDiscoveryFailed(t: String, code: Int) {}
    }
    listener = l
    nsd.discoverServices(WorkerService.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
  }

  fun stop() {
    listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
    listener = null
  }

  // older Android resolves one service at a time
  @Suppress("DEPRECATION")
  @Synchronized
  private fun next() {
    if (busy) return
    val info = resolving.poll() ?: return
    busy = true
    nsd.resolveService(info, object : NsdManager.ResolveListener {
      override fun onServiceResolved(r: NsdServiceInfo) {
        val attrs = r.attributes.mapValues { (_, v) -> v?.let { String(it) } }
        onFound(mapOf(
          "serviceName" to r.serviceName,
          "name" to (attrs["name"] ?: r.serviceName.removePrefix("kula ")),
          "host" to r.host?.hostAddress,
          "port" to r.port,
          "id" to attrs["id"],
          "ram" to attrs["ram"]?.toLongOrNull(),
          "bw" to attrs["bw"]?.toDoubleOrNull(),
          "kind" to (attrs["kind"] ?: "phone"),
          "v" to attrs["v"],
        ))
        done()
      }
      override fun onResolveFailed(f: NsdServiceInfo, code: Int) { Log.w(TAG, "resolve failed ${f.serviceName} ($code)"); done() }
      private fun done() { busy = false; next() }
    })
  }

  companion object { private const val TAG = "kula-discovery" }
}
