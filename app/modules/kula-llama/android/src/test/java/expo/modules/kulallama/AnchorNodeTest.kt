package expo.modules.kulallama

import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSocket

// The phone's side of the anchor against kula-node's own anchor (docs/ANCHOR.md), not a copy:
// tools/anchor-fixture.mjs runs node/src's gate, AnchorHub and AnchorHost on 127.0.0.1 with a far
// computer C registered there. The main risk Fable named is the one tested first: TLS inside TLS
// (an SSLSocket over the SSLSocket to the anchor) on the master's side, and on the target's side
// the inner TLS piped from the anchor's stream into the phone's gate. Then the control connection
// (register, open/accept, replaced, a network change), the rpc slot with two far masters, and
// joining with an invite (its code and its typed form) up to the anchor's pair-back.
//
// This runs on the JVM's TLS (SunJSSE). On a phone the TLS is Conscrypt: whether Conscrypt layers an
// SSLSocket over an SSLSocket the same way is what a real phone still has to show.
// Skipped when node or node's tsx is missing (node/node_modules: `cd node && npm ci`).
class AnchorNodeTest {
  companion object {
    private val repo = File("../../../..").canonicalFile
    private val tsx = File(repo, "node/node_modules/tsx/dist/cli.mjs")
    private val fixture = File(repo, "app/modules/kula-llama/tools/anchor-fixture.mjs")
    private var proc: Process? = null
    private var input: OutputStreamWriter? = null
    private val lines = LinkedBlockingQueue<JSONObject>()
    private val ids = AtomicInteger(1)
    lateinit var ready: JSONObject
    lateinit var refA: Anchor.Ref
    lateinit var fpC: String

    private fun node(): String? = listOf("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node").firstOrNull { File(it).canExecute() }
      ?: runCatching { ProcessBuilder("which", "node").start().inputStream.bufferedReader().readLine()?.trim() }.getOrNull()?.takeIf { it.isNotEmpty() }

    @BeforeClass @JvmStatic fun start() {
      val node = node()
      assumeTrue("node is not installed", node != null)
      assumeTrue("node's tsx is missing (cd node && npm ci)", tsx.exists())
      val p = ProcessBuilder(node, tsx.path, fixture.path).directory(fixture.parentFile).redirectError(ProcessBuilder.Redirect.INHERIT).start()
      proc = p
      input = OutputStreamWriter(p.outputStream)
      Thread {
        val r = BufferedReader(InputStreamReader(p.inputStream))
        while (true) { val l = r.readLine() ?: break; runCatching { lines.put(JSONObject(l)) } }
      }.apply { isDaemon = true }.start()
      ready = lines.poll(60, TimeUnit.SECONDS) ?: error("the node anchor did not start")
      assertTrue(ready.getBoolean("ready"))
      val a = ready.getJSONObject("a")
      refA = Anchor.Ref("127.0.0.1", a.getInt("port"), a.getString("fp"))
      fpC = ready.getJSONObject("c").getString("fp")
    }

    @AfterClass @JvmStatic fun stop() {
      runCatching { cmd(JSONObject().put("cmd", "bye"), 5) }
      runCatching { input?.close() }
      proc?.waitFor(5, TimeUnit.SECONDS)
      proc?.destroyForcibly()
    }

    @Synchronized fun cmd(c: JSONObject, seconds: Long = 30): JSONObject {
      val id = ids.getAndIncrement()
      input!!.write(c.put("id", id).toString() + "\n"); input!!.flush()
      while (true) {
        val o = lines.poll(seconds, TimeUnit.SECONDS) ?: error("no answer to ${c.optString("cmd")}")
        if (o.optInt("id") == id) return o
      }
    }
  }

  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = runCatching { echo.accept() }.getOrNull() ?: break; Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }
  private fun freePort() = ServerSocket(0).use { it.localPort }
  private fun roundTrip(s: Socket, n: Int): Boolean {
    val payload = ByteArray(n).also { java.util.Random(n.toLong()).nextBytes(it) }
    Thread { runCatching { s.getOutputStream().write(payload); s.getOutputStream().flush() } }.start()
    val got = ByteArray(n); var k = 0
    s.soTimeout = 15_000
    while (k < n) { val r = s.getInputStream().read(got, k, n - k); if (r < 0) break; k += r }
    return payload.contentEquals(got)
  }
  private fun until(ms: Long, what: String, f: () -> Boolean) {
    val end = System.currentTimeMillis() + ms
    while (!f()) { if (System.currentTimeMillis() > end) error("timed out waiting for $what"); Thread.sleep(25) }
  }
  private fun member(fp: String) = assertTrue(cmd(JSONObject().put("cmd", "member").put("fp", fp)).getBoolean("ok"))
  private fun registered(fp: String) = cmd(JSONObject().put("cmd", "members")).getJSONArray("members").let { a -> (0 until a.length()).any { a.getJSONObject(it).getString("fp") == fp } }

  /** A phone's gate on 127.0.0.1: rpc and api pipe into [echo]; [paired] may use it. */
  private class PhoneGate(val id: GateIdentity, echo: Int?, paired: List<String>) {
    val port = ServerSocket(0).use { it.localPort }
    val tls = Gate.TlsServer(id, Paired(null).also { p -> paired.forEach { p.add(it) } }, null)
    val events = java.util.concurrent.CopyOnWriteArrayList<Gate.Event>()
    val gate = Gate.Server(port, null, { ch -> if (ch == "rpc") echo else null }, null, tls) { events.add(it) }.also { it.start() }
  }

  @Test
  fun thePhoneDialsAComputerThroughTheAnchorTlsInsideTls() {
    val phone = GateIdentity.create("phone-master")
    member(phone.fp)
    // the outer leg: the phone's certificate to the anchor's gate, on the anchor channel
    val s = Anchor.dial(refA, phone, fpC)
    assertTrue(s is SSLSocket)
    // the inner leg: a fresh handshake with C's own gate, pinned, inside the outer TLS
    val inner = Gate.handshake(s, "", "rpc", Gate.TlsClient(phone, fpC))
    assertTrue(inner is SSLSocket)
    assertNotSame(s, inner)
    assertEquals("TLSv1.3", (inner as SSLSocket).session.protocol)
    assertEquals(fpC, Gate.peerFp(inner))
    assertTrue(roundTrip(inner, 300_000))
    inner.close()
    // the probe and the tunnel take the same road, the split's rpc channel included
    assertNull(Gate.probe("", 0, "", "rpc", tls = Gate.TlsClient(phone, fpC), anchor = refA))
    assertNull(Gate.probe("", 0, "", "api", tls = Gate.TlsClient(phone, fpC), anchor = refA))
    val t = Gate.Tunnel("", 0, "", "rpc", Gate.TlsClient(phone, fpC), anchor = refA)
    val local = t.start()
    try {
      repeat(3) { Socket("127.0.0.1", local).use { c -> assertTrue(roundTrip(c, 50_000)) } }
    } finally { t.stop() }
    // the pinned certificate decides, whatever the road: another one behind the stream is not C
    val wrong = Anchor.dial(refA, phone, fpC)
    assertEquals("gate: ${Gate.FP_MISMATCH}", runCatching { Gate.handshake(wrong, "", "rpc", Gate.TlsClient(phone, "ab".repeat(32))) }.exceptionOrNull()?.message)
    // nobody registered under that certificate
    assertEquals("anchor: not here", Gate.probe("", 0, "", "rpc", tls = Gate.TlsClient(phone, "cd".repeat(32)), anchor = refA))
    // a stranger is not let into the anchor at all
    assertEquals("gate: NO not paired", Gate.probe("", 0, "", "rpc", tls = Gate.TlsClient(GateIdentity.create("stranger"), fpC), anchor = refA))
  }

  @Test
  fun aComputerReachesThePhoneThroughTheAnchor() {
    val echo = echo()
    val phone = GateIdentity.create("phone-target")
    val fpA = refA.fp
    val g = PhoneGate(phone, echo.localPort, listOf(fpC, fpA))
    member(phone.fp)
    val states = java.util.concurrent.CopyOnWriteArrayList<Anchor.State>()
    val m = Anchor.Member(fpA, { listOf(refA) }, phone, "pixel", "phone", g.port, firstRetryMs = 100, onState = { s, _ -> states.add(s) }).start()
    try {
      until(10_000, "the phone to register") { m.state == Anchor.State.REGISTERED }
      assertTrue(registered(phone.fp))
      // C dials the phone through A: the inner TLS is piped from the anchor's stream into the phone's gate
      assertTrue(cmd(JSONObject().put("cmd", "dial").put("to", phone.fp).put("bytes", 200_000)).optBoolean("ok"))
      assertTrue(g.events.any { it.kind == "connect" && it.fp == fpC && it.peer == "127.0.0.1" })
      // two far masters, both from 127.0.0.1: C holds the rpc slot, A (through its own hub) hears busy
      assertTrue(cmd(JSONObject().put("cmd", "dial").put("to", phone.fp).put("hold", true)).optBoolean("ok"))
      assertEquals("busy", cmd(JSONObject().put("cmd", "dialSelf").put("to", phone.fp)).optString("error"))
      // C again (llama.cpp opens several connections) is let in
      assertTrue(cmd(JSONObject().put("cmd", "dial").put("to", phone.fp)).optBoolean("ok"))
      cmd(JSONObject().put("cmd", "release"))
      until(5_000, "the slot to free") { cmd(JSONObject().put("cmd", "dialSelf").put("to", phone.fp)).optBoolean("ok") }
      // a network change: the control connection goes and comes back at once
      m.kick()
      until(10_000, "the phone to register again") { states.lastOrNull() == Anchor.State.REGISTERED && states.count { it == Anchor.State.REGISTERED } >= 2 }
      assertTrue(cmd(JSONObject().put("cmd", "dial").put("to", phone.fp)).optBoolean("ok"))
      // the same certificate registers from somewhere else: this one steps back and stays back
      val twin = Anchor.Member(fpA, { listOf(refA) }, phone, "pixel (2)", "phone", g.port, firstRetryMs = 100).start()
      try {
        until(10_000, "the twin to register") { twin.state == Anchor.State.REGISTERED }
        until(5_000, "the first to step back") { m.state == Anchor.State.REPLACED }
        Thread.sleep(600)
        assertEquals(Anchor.State.REPLACED, m.state)
        assertEquals(Anchor.State.REGISTERED, twin.state)
      } finally { twin.close() }
    } finally {
      m.close(); g.gate.stop(); echo.close()
    }
  }

  private fun inviteOf(o: JSONObject): Anchor.Invite {
    val code = JSONObject(o.getString("text"))
    val ways = Anchor.addrsOf(code.optJSONArray("addrs")).ifEmpty { listOf(Anchor.Addr(code.getString("host"), code.getInt("port"), "mapped")) }
    return Anchor.Invite(code.getString("fp"), null, code.getString("pin"), code.optString("hpin").ifEmpty { null }, code.optString("name"), ways)
  }

  @Test
  fun thePhoneJoinsWithAnInviteAndTheAnchorPairsBack() {
    val dir = java.nio.file.Files.createTempDirectory("kula-join").toFile()
    val phone = GateIdentity.create("phone-joiner")
    val store = File(dir, "anchors.json")
    val o = cmd(JSONObject().put("cmd", "invite").put("whose", "mine"))
    val inv = inviteOf(o)
    val r = Anchor.join(inv, phone, store)
    assertFalse(r.again)
    assertEquals(refA.fp, r.anchor.fp)
    // the anchor knows the phone now (it is a member), and the store keeps the pair-back code
    assertTrue(cmd(JSONObject().put("cmd", "pairedA").put("fp", phone.fp)).getBoolean("paired"))
    assertEquals(inv.hpin, Anchor.readJoined(store).single().hpin)
    // an invite works once
    val again = runCatching { Anchor.join(inv, GateIdentity.create("someone-else"), File(dir, "other.json")) }.exceptionOrNull()
    assertEquals("this invite was used already: each invite works once. ask for a new one. if it was not you, tell the anchor's owner to remove the device that used it.", again?.message)
    // sharing: the phone registers, its gate opens the pair-back code for the anchor only, the anchor pairs back
    val g = PhoneGate(phone, null, emptyList())
    val links = Anchor.Links(store, phone, "pixel", "phone", g.port, g.tls.codes, retryMs = 100)
    links.refresh(force = true)
    try {
      until(15_000, "the anchor to pair back") { g.tls.paired.contains(refA.fp) }
      until(5_000, "the store to forget the pair-back code") { Anchor.readJoined(store).single().hpin == null }
      assertEquals(Anchor.State.REGISTERED, links.view().single().state)
      assertFalse(links.view().single().waitingBack)
      assertTrue(g.events.any { it.kind == "pair" && it.fp == refA.fp })
    } finally { links.close(); g.gate.stop() }
  }

  @Test
  fun aTypedInviteJoinsWithTheCertificateStartAndADerivedPairBackCode() {
    val dir = java.nio.file.Files.createTempDirectory("kula-join-typed").toFile()
    val o = cmd(JSONObject().put("cmd", "invite").put("whose", "friend"))
    val typed = o.getJSONObject("typed")
    val pin = typed.getString("code")
    // the phone derives the same pair-back code as node from the pin alone
    assertEquals(cmd(JSONObject().put("cmd", "pairBackCode").put("pin", pin)).getString("code"), Anchor.pairBackCode(pin))
    val (host, port) = typed.getString("address").split(":").let { it[0] to it[1].toInt() }
    val way = listOf(Anchor.Addr(host, port, "mapped"))
    // a wrong certificate start: refused before the code is spent
    val wrong = runCatching { Anchor.join(Anchor.Invite("", "0".repeat(16), pin, null, "", way), GateIdentity.create("p"), File(dir, "x.json")) }.exceptionOrNull()
    assertEquals("the certificate does not match what the anchor shows: not joining", wrong?.message)
    // too short a start is not asked for at all
    val short = runCatching { Anchor.join(Anchor.Invite("", "abc", pin, null, "", way), GateIdentity.create("p"), File(dir, "y.json")) }.exceptionOrNull()
    assertNotNull(short?.message)
    assertTrue(short!!.message!!.startsWith("type the start of the anchor's certificate too"))
    val phone = GateIdentity.create("phone-typed")
    val store = File(dir, "anchors.json")
    val r = Anchor.join(Anchor.Invite("", typed.getString("certificate"), pin, null, "", way), phone, store)
    assertEquals(refA.fp, r.anchor.fp)
    assertEquals(Anchor.pairBackCode(pin), r.anchor.hpin)
    val g = PhoneGate(phone, null, emptyList())
    val links = Anchor.Links(store, phone, "pixel", "phone", g.port, g.tls.codes, retryMs = 100)
    links.refresh(force = true)
    try {
      until(15_000, "the anchor to pair back with the derived code") { g.tls.paired.contains(refA.fp) }
    } finally { links.close(); g.gate.stop() }
  }
}
