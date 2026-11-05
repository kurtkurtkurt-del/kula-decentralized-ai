package expo.modules.kulallama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

// docs/SECURITY.md on the gate itself: a flood of half-open connections, v1 on a worker
// without a secret, a pairing code past its ttl. The Node twin is test/security.test.ts.
class GateSecurityTest {
  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }
  private fun freePort() = ServerSocket(0).use { it.localPort }
  private fun readAll(s: Socket): String = s.getInputStream().readBytes().toString(Charsets.US_ASCII)

  @Test
  fun pastMaxHandshakesTheNextConnectionIsToldOverloadedAtOnce() {
    val echo = echo()
    val port = freePort()
    val events = mutableListOf<Gate.Event>()
    val gate = Gate.Server(port, "s", { echo.localPort }) { synchronized(events) { events.add(it) } }
    gate.start()
    val idle = ArrayList<Socket>()
    try {
      repeat(Gate.MAX_HANDSHAKES) { idle.add(Socket("127.0.0.1", port)) }
      Thread.sleep(200)
      val t0 = System.currentTimeMillis()
      val answer = Socket("127.0.0.1", port).use { s -> s.soTimeout = 3000; readAll(s) }
      assertEquals("NO overloaded\n", answer)
      assertTrue("refused without waiting for a hello", System.currentTimeMillis() - t0 < 1500)
      assertTrue(synchronized(events) { events.any { it.kind == "reject" && it.why == "overloaded" } })
      // one idle connection leaves: the next real client is served
      idle.removeAt(idle.size - 1).close()
      Thread.sleep(200)
      assertNull(Gate.probe("127.0.0.1", port, "s", "rpc"))
    } finally {
      idle.forEach { runCatching { it.close() } }
      gate.stop(); echo.close()
    }
  }

  @Test
  fun aServerWithoutASecretSpeaksNoV1ButStillTls() {
    val echo = echo()
    val port = freePort()
    val worker = GateIdentity.create("worker")
    val master = GateIdentity.create("master")
    val tls = Gate.TlsServer(worker, Paired(null), Gate.newPin())
    val gate = Gate.Server(port, null, { echo.localPort }, null, tls)
    gate.start()
    try {
      val answer = Socket("127.0.0.1", port).use { s ->
        s.soTimeout = 3000
        s.getOutputStream().write("KULA1 rpc ${"ab".repeat(16)}\n".toByteArray()); s.getOutputStream().flush()
        readAll(s)
      }
      assertEquals("NO no v1\n", answer)
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "anything", "rpc"))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, worker.fp, tls.pin)))
    } finally { gate.stop(); echo.close() }
  }

  @Test
  fun aPairingCodePastItsTtlIsRefusedAndReplaced() {
    val echo = echo()
    val port = freePort()
    val worker = GateIdentity.create("worker")
    val master = GateIdentity.create("master")
    val other = GateIdentity.create("other")
    var rotated = 0
    lateinit var tls: Gate.TlsServer
    tls = Gate.TlsServer(worker, Paired(null), Gate.newPin(), { rotated++; tls.pin = Gate.newPin(); tls.pinExpiresAt = System.currentTimeMillis() + 60_000 }, System.currentTimeMillis() + 60_000)
    val gate = Gate.Server(port, null, { echo.localPort }, null, tls)
    gate.start()
    try {
      // inside the ttl the code pairs
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, worker.fp, tls.pin)))
      assertEquals(1, rotated)
      // the next code, photographed and used late
      val late = tls.pin!!
      tls.pinExpiresAt = System.currentTimeMillis() - 1
      assertEquals("gate: NO pin expired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(other, worker.fp, late)))
      assertEquals(2, rotated)
      assertNotEquals(late, tls.pin)
      // gone for good; the fresh one works; the paired master never needed one
      assertEquals("gate: NO wrong pin", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(other, worker.fp, late)))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, worker.fp)))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(other, worker.fp, tls.pin)))
    } finally { gate.stop(); echo.close() }
  }
}
