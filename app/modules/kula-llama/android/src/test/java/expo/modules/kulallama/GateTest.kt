package expo.modules.kulallama

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.Socket

// The gate against the shared vectors (tools/gate-vectors.json, also node/test/) and a real
// handshake over loopback: right secret passes and pipes, wrong secret is refused.
class GateTest {
  private val vectors = JSONObject(File("../tools/gate-vectors.json").readText()).getJSONArray("vectors")

  @Test
  fun hmacMatchesTheSharedVectors() {
    for (i in 0 until vectors.length()) {
      val v = vectors.getJSONObject(i)
      assertEquals(v.getString("hmac_c"), Gate.hmac(v.getString("secret"), v.getString("nonce_c"), v.getString("nonce_s"), v.getString("channel")))
      assertEquals(v.getString("hmac_s"), Gate.hmac(v.getString("secret"), v.getString("nonce_s"), v.getString("nonce_c"), v.getString("channel")))
    }
  }

  @Test
  fun handshakeOverLoopback() {
    // an echo target behind the gate
    val echo = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { s.getInputStream().copyTo(s.getOutputStream()) }.start() } }.apply { isDaemon = true }.start()
    val secret = Gate.newSecret()
    val port = java.net.ServerSocket(0).use { it.localPort }
    val events = mutableListOf<Gate.Event>()
    val server = Gate.Server(port, secret, { ch -> if (ch == "rpc") echo.localPort else null }) { events.add(it) }
    server.start()
    try {
      assertEquals(null, Gate.probe("127.0.0.1", port, secret, "rpc"))
      assertTrue(Gate.probe("127.0.0.1", port, "wrong", "rpc")!!.contains("wrong secret"))
      assertTrue(Gate.probe("127.0.0.1", port, secret, "api")!!.contains("channel closed"))
      // bytes after the handshake reach the target and come back
      Socket("127.0.0.1", port).use { s ->
        Gate.handshake(s, secret, "rpc")
        s.getOutputStream().write("ping".toByteArray()); s.getOutputStream().flush()
        val buf = ByteArray(4); var n = 0
        while (n < 4) n += s.getInputStream().read(buf, n, 4 - n)
        assertEquals("ping", String(buf))
      }
      assertTrue(events.any { it.kind == "reject" && it.why == "wrong secret" })
      assertTrue(events.any { it.kind == "connect" && it.channel == "rpc" })
    } finally {
      server.stop(); echo.close()
    }
  }

  @Test
  fun theApiServerLearnsWhichMasterIsBehindAPipe() {
    // a stand-in for ApiServer: it asks ApiPeers who is behind each accepted connection
    val seen = java.util.concurrent.LinkedBlockingQueue<String>()
    val api = java.net.ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
    Thread {
      while (true) {
        val s = runCatching { api.accept() }.getOrNull() ?: break
        Thread { seen.add(ApiPeers.get(s.port) ?: "none"); runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start()
      }
    }.apply { isDaemon = true }.start()
    val secret = Gate.newSecret()
    val port = java.net.ServerSocket(0).use { it.localPort }
    val server = Gate.Server(port, secret, { ch -> if (ch == "api") api.localPort else null })
    server.start()
    try {
      // over loopback (the way a relayed stream arrives): no master address
      Socket("127.0.0.1", port).use { s -> Gate.handshake(s, secret, "api"); assertEquals("none", seen.poll(5, java.util.concurrent.TimeUnit.SECONDS)) }
      // from a lan address of this machine, when it has one: that address, and gone after the pipe
      val lan = java.net.NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }.firstOrNull { it is java.net.Inet4Address && !it.isLoopbackAddress }
      org.junit.Assume.assumeTrue("no lan address on this machine", lan != null)
      Socket(lan, port).use { s ->
        Gate.handshake(s, secret, "api")
        assertEquals(lan!!.hostAddress, seen.poll(5, java.util.concurrent.TimeUnit.SECONDS))
      }
      val deadline = System.currentTimeMillis() + 5000
      // the gate's own port to the api is not known here; every entry must be gone once the pipe closed
      while (System.currentTimeMillis() < deadline && (1..65535).any { ApiPeers.get(it) == lan!!.hostAddress }) Thread.sleep(50)
      assertTrue((1..65535).none { ApiPeers.get(it) == lan!!.hostAddress })
    } finally {
      server.stop(); api.close()
    }
  }
}
