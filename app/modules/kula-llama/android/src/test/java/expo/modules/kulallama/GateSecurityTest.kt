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
  fun aHandshakeTricklingOneByteEvery4sIsClosedBy20s() {
    // security review D4 #9: every read is under HANDSHAKE_MS, so only a total deadline ends it
    val echo = echo()
    val port = freePort()
    val gate = Gate.Server(port, "s", { echo.localPort })
    gate.start()
    val s = Socket("127.0.0.1", port)
    try {
      s.soTimeout = 30_000
      val hello = "KULA1 rpc ${"ab".repeat(16)}" // never the newline
      val t0 = System.currentTimeMillis()
      val writer = Thread {
        try { var i = 0; while (true) { s.getOutputStream().write(hello[i % hello.length].code); s.getOutputStream().flush(); i++; Thread.sleep(4000) } } catch (_: Exception) {}
      }.apply { isDaemon = true; start() }
      // -1 (or a reset) once the gate closes it; a read timeout at 30 s when nothing does
      val r = runCatching { s.getInputStream().read() }
      val took = System.currentTimeMillis() - t0
      writer.interrupt()
      assertTrue("closed after $took ms (${r.exceptionOrNull()?.javaClass?.simpleName ?: r.getOrNull()})", r.exceptionOrNull() !is java.net.SocketTimeoutException && took in 18_000..22_500)
      // the slot came back: a real client is served
      assertNull(Gate.probe("127.0.0.1", port, "s", "rpc"))
    } finally { runCatching { s.close() }; gate.stop(); echo.close() }
  }

  @Test
  fun anOwnDeviceTakesTheRpcSeatFromAFriendsAfterAMinuteIdle() {
    // security review D4 #10 (the user's choice): a friend's device holding the seat with nothing
    // passed for 60 s gives it to the person's own device; friend against friend, own against own stay busy
    val echo = echo()
    val port = freePort()
    val phone = GateIdentity.create("phone")
    val friendA = GateIdentity.create("friend-a")
    val friendB = GateIdentity.create("friend-b")
    val ownA = GateIdentity.create("own-a")
    val ownB = GateIdentity.create("own-b")
    val paired = Paired(null).also { p -> listOf(friendA, friendB, ownA, ownB).forEach { p.add(it.fp) } }
    val friends = setOf(friendA.fp, friendB.fp)
    // the gate's threads read it: an atomic, not a captured var
    val clock = java.util.concurrent.atomic.AtomicLong(1_000_000L)
    val gate = Gate.Server(port, null, { echo.localPort }, null, Gate.TlsServer(phone, paired, null), friend = { it in friends }, now = { clock.get() })
    gate.start()
    val rpc = { id: GateIdentity -> Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(id, phone.fp)) }
    val hold = { id: GateIdentity -> Gate.handshake(Socket("127.0.0.1", port), "", "rpc", Gate.TlsClient(id, phone.fp)) }
    try {
      // a friend's device loads a model and then sits idle
      var held = hold(friendA)
      clock.addAndGet(59_000)
      assertEquals("gate: NO busy", rpc(ownA))
      // another friend never takes it, however long it sat
      clock.addAndGet(2_000)
      assertEquals("gate: NO busy", rpc(friendB))
      // 61 s: the own device takes it, and the friend's connection is closed
      assertNull(rpc(ownA))
      held.soTimeout = 3000
      assertEquals(-1, runCatching { held.getInputStream().read() }.getOrDefault(-1))
      held.close()
      Thread.sleep(200)
      // bytes keep a friend's seat: an echo every so often is use, not idle
      held = hold(friendA)
      val out = held.getOutputStream(); val inp = held.getInputStream()
      clock.addAndGet(50_000)
      out.write(1); out.flush(); assertEquals(1, inp.read())
      clock.addAndGet(30_000)
      assertEquals("gate: NO busy", rpc(ownA))
      held.close()
      Thread.sleep(200)
      // own against own: busy, idle or not
      held = hold(ownA)
      clock.addAndGet(10 * 60_000L)
      assertEquals("gate: NO busy", rpc(ownB))
      held.close()
    } finally { gate.stop(); echo.close() }
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
