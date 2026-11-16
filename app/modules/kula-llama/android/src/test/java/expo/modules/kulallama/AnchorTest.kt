package expo.modules.kulallama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

// The phone's gate in the anchor network (docs/ANCHOR.md), without a computer: it is never an
// anchor itself ("bad channel"), its rpc slot is held by the client certificate (every stream
// through an anchor arrives from 127.0.0.1), the pair-back code opens for the anchor's
// certificate only and once, a typed certificate start is checked at TLS, and the store of
// joined anchors keeps only what is well formed. AnchorNodeTest runs the rest against node's own anchor.
class AnchorTest {
  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = runCatching { echo.accept() }.getOrNull() ?: break; Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }
  private fun freePort() = ServerSocket(0).use { it.localPort }

  @Test
  fun aPhoneIsNeverAnAnchor() {
    val phone = GateIdentity.create("phone")
    val master = GateIdentity.create("mac")
    val port = freePort()
    val gate = Gate.Server(port, null, { null }, null, Gate.TlsServer(phone, Paired(null).also { it.add(master.fp) }, null))
    gate.start()
    try {
      // even a paired computer hears "bad channel" when it asks this phone to be its anchor
      assertEquals("gate: NO bad channel", Gate.probe("127.0.0.1", port, "", "anchor", tls = Gate.TlsClient(master, phone.fp)))
      val e = runCatching { Anchor.open(Anchor.Ref("127.0.0.1", port, phone.fp), master, 3000) }.exceptionOrNull()
      assertEquals("gate: NO bad channel", e?.message)
    } finally { gate.stop() }
  }

  @Test
  fun theRpcSlotIsHeldByCertificateNotAddress() {
    // two far masters both arrive from 127.0.0.1 (an anchor's stream is piped into the gate there)
    val echo = echo()
    val phone = GateIdentity.create("phone")
    val a = GateIdentity.create("mac-a")
    val b = GateIdentity.create("mac-b")
    val port = freePort()
    val gate = Gate.Server(port, null, { echo.localPort }, null, Gate.TlsServer(phone, Paired(null).also { it.add(a.fp); it.add(b.fp) }, null))
    gate.start()
    try {
      val held = Gate.handshake(Socket("127.0.0.1", port), "", "rpc", Gate.TlsClient(a, phone.fp))
      // the same master again (llama.cpp opens several connections): let in
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(a, phone.fp)))
      // another certificate from the same address: busy while the first holds the slot
      assertEquals("gate: NO busy", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(b, phone.fp)))
      // the api channel has no slot
      assertNull(Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(b, phone.fp)))
      held.close()
      Thread.sleep(200)
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(b, phone.fp)))
    } finally { gate.stop(); echo.close() }
  }

  @Test
  fun aPairBackCodeOpensForTheAnchorsCertificateOnlyAndOnce() {
    val phone = GateIdentity.create("phone")
    val anchor = GateIdentity.create("anchor")
    val other = GateIdentity.create("stranger")
    val port = freePort()
    val tls = Gate.TlsServer(phone, Paired(null), null)
    val used = mutableListOf<String>()
    tls.codes.add("0011223344556677", 60_000, only = anchor.fp, name = "berlin") { used.add(it) }
    val gate = Gate.Server(port, null, { null }, null, tls)
    gate.start()
    try {
      // another certificate with the right code: this code is not open for it, and no other is
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(other, phone.fp, "0011223344556677")))
      // the anchor with a wrong code
      assertEquals("gate: NO wrong pin", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(anchor, phone.fp, "ffffffffffffffff")))
      // the anchor with its code: paired (the api channel is closed here, which is after the pairing)
      assertEquals("gate: NO channel closed", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(anchor, phone.fp, "0011223344556677")))
      assertTrue(tls.paired.contains(anchor.fp))
      assertEquals("berlin", tls.paired.list().single().name)
      assertEquals(listOf(anchor.fp), used)
      assertFalse(tls.codes.has("0011223344556677"))
      // the qr's own code was never touched
      assertNull(tls.pin)
    } finally { gate.stop() }
    // once only, and a late try hears why
    val c = Gate.ExtraCodes()
    c.add("aaaaaaaaaaaaaaaa", 60_000, only = anchor.fp)
    assertNotNull(c.take("aaaaaaaaaaaaaaaa", anchor.fp))
    assertNull(c.take("aaaaaaaaaaaaaaaa", anchor.fp))
    assertEquals(listOf("aaaaaaaaaaaaaaaa" to "pin used"), c.recent(anchor.fp))
    // and one that ran out
    var now = 1_000L
    val t = Gate.ExtraCodes { now }
    t.add("bbbbbbbbbbbbbbbb", 1000, only = anchor.fp)
    now += 2000
    assertEquals(emptyList<String>(), t.open(anchor.fp))
    assertEquals(listOf("bbbbbbbbbbbbbbbb" to "pin expired"), t.recent(anchor.fp))
  }

  @Test
  fun aTypedCertificateStartIsCheckedAtTls() {
    val anchor = GateIdentity.create("anchor")
    val phone = GateIdentity.create("phone")
    val port = freePort()
    val pin = Gate.newPin()
    val tls = Gate.TlsServer(anchor, Paired(null), pin)
    val gate = Gate.Server(port, null, { null }, null, tls)
    gate.start()
    try {
      // the wrong start: refused before the code is spent
      assertEquals("gate: fingerprint mismatch", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(phone, "", pin, "0".repeat(16))))
      assertEquals(pin, tls.pin)
      // the right start pairs with the code and learns the whole certificate
      var seen: String? = null
      val e = runCatching { Gate.handshake(Socket("127.0.0.1", port), "", "api", Gate.TlsClient(phone, "", pin, anchor.fp.take(16)), seen = { seen = it }) }.exceptionOrNull()
      assertEquals("gate: NO channel closed", e?.message)
      assertEquals(anchor.fp, seen)
      assertTrue(tls.paired.contains(phone.fp))
      // paired now: a typed start of 16 hex is identity enough for "paired" without a code
      assertEquals("gate: NO channel closed", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(phone, "", null, anchor.fp.take(16))))
      // but fewer than 16 is not
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(phone, "", null, anchor.fp.take(8))))
    } finally { gate.stop() }
  }

  @Test
  fun theStoreKeepsOnlyWellFormedAnchors() {
    val dir = java.nio.file.Files.createTempDirectory("kula-anchors").toFile()
    val f = File(dir, "anchors.json")
    f.writeText("""[
      {"fp":"${"a".repeat(64)}","name":"berlin","host":"203.0.113.5","port":50551,"addrs":[{"host":"2001:db8::5","port":50551,"via":"ipv6"},{"host":"evil.example","port":1,"via":"mapped"}],"joined_at":1,"hpin":"0123456789abcdef","hpinExp":99},
      {"fp":"short","name":"x","host":"1.2.3.4","port":1},
      {"fp":"${"b".repeat(64)}","name":"x","host":"not an ip","port":1}
    ]""")
    val list = Anchor.readJoined(f)
    assertEquals(1, list.size)
    assertEquals(listOf(Anchor.Addr("2001:db8::5", 50551, "ipv6")), list[0].addrs)
    assertEquals(listOf(Anchor.Ref("203.0.113.5", 50551, "a".repeat(64)), Anchor.Ref("2001:db8::5", 50551, "a".repeat(64))), list[0].ways())
    Anchor.updateJoined(f) { l -> l.map { it.copy(hpin = null, hpinExp = null) } }
    assertNull(Anchor.readJoined(f)[0].hpin)
    assertTrue(Anchor.removeJoined(f, "A".repeat(64)))
    assertEquals(emptyList<Anchor.Joined>(), Anchor.readJoined(f))
  }

  @Test
  fun twoProcessesChangingTheStoreLoseNoUpdate() {
    // security review D4 #15: the app and the worker are two processes; @Synchronized holds in one
    val dir = java.nio.file.Files.createTempDirectory("kula-anchors").toFile()
    val f = File(dir, "anchors.json")
    Anchor.writeJoined(f, listOf(Anchor.Joined("c".repeat(64), "count", "10.0.0.1", 50551, emptyList(), 0L)))
    val go = File(dir, "go")
    val jvm = File(System.getProperty("java.home"), "bin/java").path
    val cp = System.getProperty("java.class.path")
    val procs = List(2) {
      ProcessBuilder(jvm, "-cp", cp, StoreHammer::class.java.name, f.path, "200", go.path).redirectErrorStream(true).start()
    }
    // both JVMs are up and waiting before either starts, so their updates overlap
    Thread.sleep(1500)
    go.writeText("go")
    for (p in procs) {
      assertTrue("a hammer took too long", p.waitFor(60, java.util.concurrent.TimeUnit.SECONDS))
      assertEquals(p.inputStream.readBytes().toString(Charsets.UTF_8), 0, p.exitValue())
    }
    assertEquals(400L, Anchor.readJoined(f).single().joinedAt)
  }

  @Test
  fun aFifthAnchorIsRefusedAndNoneIsDropped() {
    // security review D4 #22: the store keeps four; the fifth used to push the oldest out silently
    val phone = GateIdentity.create("phone")
    val known = GateIdentity.create("known")
    val fifth = GateIdentity.create("fifth")
    val dir = java.nio.file.Files.createTempDirectory("kula-anchors").toFile()
    val f = File(dir, "anchors.json")
    val four = listOf("1", "2", "3").map { Anchor.Joined(it.repeat(64), "anchor $it", "10.0.0.$it", 50551, emptyList(), 1L) } +
      Anchor.Joined(known.fp, "known", "127.0.0.1", 1, emptyList(), 1L)
    Anchor.writeJoined(f, four)
    val p1 = freePort(); val p2 = freePort()
    val t1 = Gate.TlsServer(known, Paired(null), Gate.newPin())
    val t2 = Gate.TlsServer(fifth, Paired(null), Gate.newPin())
    val g1 = Gate.Server(p1, null, { null }, null, t1).also { it.start() }
    val g2 = Gate.Server(p2, null, { null }, null, t2).also { it.start() }
    try {
      val pin2 = t2.pin!!
      val e = runCatching { Anchor.join(Anchor.Invite(fifth.fp, null, pin2, null, "fifth", listOf(Anchor.Addr("127.0.0.1", p2, "lan"))), phone, f) }.exceptionOrNull()
      assertEquals(Anchor.FULL_WORDS, e?.message)
      // refused before the invite was spent, and nothing was dropped
      assertEquals(pin2, t2.pin)
      assertEquals(four.map { it.fp }, Anchor.readJoined(f).map { it.fp })
      // an anchor already in the store may come again with a new invite, typed or scanned
      val r = Anchor.join(Anchor.Invite("", known.fp.take(16), t1.pin!!, null, "known", listOf(Anchor.Addr("127.0.0.1", p1, "lan"))), phone, f)
      assertTrue(r.again)
      assertEquals(4, Anchor.readJoined(f).size)
    } finally { g1.stop(); g2.stop() }
  }

  @Test
  fun theStoreKeepsWhoseComputerAnAnchorIsAndTheGateCountsFriendsByIt() {
    // security review D4 #10: the person's answer when joining decides who is a friend's device
    val dir = java.nio.file.Files.createTempDirectory("kula-anchors").toFile()
    val f = File(dir, "anchors.json")
    val (old, mine, odd) = listOf("a", "b", "c").map { it.repeat(64) }
    f.writeText("""[
      {"fp":"$old","name":"before the question","host":"10.0.0.1","port":50551,"joined_at":1},
      {"fp":"$mine","name":"home","host":"10.0.0.2","port":50551,"joined_at":1,"whose":"mine"},
      {"fp":"$odd","name":"odd","host":"10.0.0.3","port":50551,"joined_at":1,"whose":"MINE "}
    ]""")
    val list = Anchor.readJoined(f)
    // written before this change, or anything but "mine": a friend's, the safe side
    assertEquals(listOf(Anchor.FRIEND, Anchor.MINE, Anchor.FRIEND), list.map { it.whose })
    // and it survives a write
    Anchor.writeJoined(f, list)
    assertEquals(listOf(Anchor.FRIEND, Anchor.MINE, Anchor.FRIEND), Anchor.readJoined(f).map { it.whose })
    // the gate's friend test: a friend's anchor is a friend's, my anchor and every other paired computer are mine
    assertTrue(Anchor.friendOf(list, old))
    assertFalse(Anchor.friendOf(list, mine))
    assertTrue(Anchor.friendOf(list, odd.uppercase()))
    assertFalse(Anchor.friendOf(list, "d".repeat(64)))

    // joining keeps the answer given, and joining again keeps the newer answer
    val anchor = GateIdentity.create("anchor")
    val phone = GateIdentity.create("phone")
    val port = freePort()
    val tls = Gate.TlsServer(anchor, Paired(null), Gate.newPin())
    val gate = Gate.Server(port, null, { null }, null, tls).also { it.start() }
    val store = File(dir, "joined.json")
    val way = listOf(Anchor.Addr("127.0.0.1", port, "lan"))
    try {
      Anchor.join(Anchor.Invite(anchor.fp, null, tls.pin!!, null, "home mac", way, Anchor.MINE), phone, store)
      assertEquals(Anchor.MINE, Anchor.readJoined(store).single().whose)
      assertFalse(Anchor.friendOf(Anchor.readJoined(store), anchor.fp))
      tls.open(Gate.newPin(), null, null)
      Anchor.join(Anchor.Invite(anchor.fp, null, tls.pin!!, null, "home mac", way, Anchor.FRIEND), phone, store)
      assertEquals(Anchor.FRIEND, Anchor.readJoined(store).single().whose)
      assertTrue(Anchor.friendOf(Anchor.readJoined(store), anchor.fp))
    } finally { gate.stop() }
  }

  /**
   * A dishonest anchor: the gate's v2 handshake on its "anchor" channel for any certificate, then
   * `registered` and [opens] `open` lines on the control connection. Every `accept` connection is
   * counted and held without an answer, so it stays in flight.
   */
  private class DishonestAnchor(val opens: Int) {
    val identity = GateIdentity.create("anchor")
    private val server: javax.net.ssl.SSLServerSocket
    val accepts = java.util.concurrent.atomic.AtomicInteger(0)
    val held = java.util.concurrent.ConcurrentLinkedQueue<Socket>()
    @Volatile var control: Socket? = null
    val port: Int get() = server.localPort

    init {
      val ctx = javax.net.ssl.SSLContext.getInstance("TLS")
      val anyone = object : javax.net.ssl.X509TrustManager {
        override fun checkClientTrusted(c: Array<java.security.cert.X509Certificate>?, a: String?) {}
        override fun checkServerTrusted(c: Array<java.security.cert.X509Certificate>?, a: String?) {}
        override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
      }
      ctx.init(identity.keyManagers(), arrayOf(anyone), null)
      server = ctx.serverSocketFactory.createServerSocket(0, 200, InetAddress.getByName("127.0.0.1")) as javax.net.ssl.SSLServerSocket
      server.enabledProtocols = arrayOf("TLSv1.3")
      server.wantClientAuth = true
      Thread { while (true) { val s = runCatching { server.accept() }.getOrNull() ?: break; Thread { serve(s) }.apply { isDaemon = true }.start() } }.apply { isDaemon = true }.start()
    }

    private fun serve(s: Socket) {
      try {
        val inp = s.getInputStream()
        val out = s.getOutputStream()
        val hello = Anchor.readLine(inp) ?: return
        if (!hello.startsWith("${Gate.VERSION2} anchor ")) return
        out.write("${Gate.randomHex(16)} paired\n".toByteArray()); out.flush()
        if (Anchor.readLine(inp) != "-") return
        out.write("OK -\n".toByteArray()); out.flush()
        val first = org.json.JSONObject(Anchor.readLine(inp) ?: return)
        when (first.optString("t")) {
          "register" -> {
            control = s
            Anchor.send(s, org.json.JSONObject().put("t", "registered"))
            repeat(opens) { Anchor.send(s, org.json.JSONObject().put("t", "open").put("sid", "s$it").put("from", "f".repeat(64))) }
            while (Anchor.readLine(inp) != null) { /* pings */ }
          }
          // held: never answered while the test looks
          "accept" -> { held.add(s); accepts.incrementAndGet(); return }
        }
      } catch (_: Exception) {}
      runCatching { s.close() }
    }

    fun open(sid: String) { Anchor.send(control!!, org.json.JSONObject().put("t", "open").put("sid", sid).put("from", "f".repeat(64))) }
    fun close() { runCatching { server.close() }; held.forEach { runCatching { it.close() } }; runCatching { control?.close() } }
  }

  @Test
  fun aDishonestAnchorsOpensAreCappedInFlight() {
    // security review D4 #14: every open was accepted, one tls connection and one thread each
    val phone = GateIdentity.create("phone")
    val anchor = DishonestAnchor(100)
    val m = Anchor.Member(anchor.identity.fp, { listOf(Anchor.Ref("127.0.0.1", anchor.port, anchor.identity.fp)) }, phone, "phone", "phone", freePort(), timeoutMs = 20_000).start()
    try {
      val until = System.currentTimeMillis() + 15_000
      while (anchor.accepts.get() < Anchor.ACCEPTS_IN_FLIGHT && System.currentTimeMillis() < until) Thread.sleep(50)
      // the rest would have come by now
      Thread.sleep(2000)
      assertEquals(Anchor.ACCEPTS_IN_FLIGHT, anchor.accepts.get())
      // once those ended, an open is taken again
      val n = anchor.held.size
      anchor.held.forEach { runCatching { it.close() } }
      anchor.held.clear()
      Thread.sleep(1000)
      anchor.open("again")
      val until2 = System.currentTimeMillis() + 10_000
      while (anchor.accepts.get() <= n && System.currentTimeMillis() < until2) Thread.sleep(50)
      assertEquals(n + 1, anchor.accepts.get())
    } finally { m.close(); anchor.close() }
  }

  @Test
  fun forgettingAnAnchorTakesItsAccessToThisPhone() {
    // security review D4 #16: the pair-back gave the anchor's computer lasting access; leaving kept it
    val phone = GateIdentity.create("phone")
    val anchor = GateIdentity.create("anchor")
    val dir = java.nio.file.Files.createTempDirectory("kula-anchors").toFile()
    val store = File(dir, "anchors.json")
    val pairedFile = File(dir, "paired")
    Anchor.writeJoined(store, listOf(Anchor.Joined(anchor.fp, "berlin", "10.0.0.1", 50551, emptyList(), 1L, whose = Anchor.FRIEND)))
    Paired(pairedFile).add(anchor.fp, "berlin")
    val echo = echo()
    val port = freePort()
    // the running gate reads the paired file; the app's forget writes it through another object
    val gateList = Paired(pairedFile)
    val gate = Gate.Server(port, null, { echo.localPort }, null, Gate.TlsServer(phone, gateList, null), friend = { Anchor.friendOf(Anchor.readJoined(store), it) })
    gate.start()
    try {
      assertNull(Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(anchor, phone.fp)))
      val lines = mutableListOf<Map<String, Any?>>()
      assertEquals(true to true, Anchor.forget(store, anchor.fp.uppercase(), Paired(pairedFile), null, null) { lines.add(it) })
      assertEquals(emptyList<Anchor.Joined>(), Anchor.readJoined(store))
      assertFalse(Paired(pairedFile).contains(anchor.fp))
      assertEquals(listOf(Unpair.fields(anchor.fp, "berlin")), lines)
      // its next handshake hears "not paired"
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(anchor, phone.fp)))
      // forgetting again changes nothing and writes nothing
      assertEquals(false to false, Anchor.forget(store, anchor.fp, Paired(pairedFile), null, null) { lines.add(it) })
      assertEquals(1, lines.size)
    } finally { gate.stop(); echo.close() }
  }

  @Test
  fun aUsedInviteNamesTheOwnersRemedy() {
    // security review D4 #17: a stolen invite used first; the real joiner learns what to do
    val w = Anchor.inviteWords("gate: NO pin used", false)
    assertTrue(w, w.startsWith("this invite was used already"))
    assertTrue(w, w.contains("if it was not you, tell the anchor's owner to remove the device that used it"))
  }
}

/** The other process of [AnchorTest.twoProcessesChangingTheStoreLoseNoUpdate]: waits for "go", then n read-change-writes. */
object StoreHammer {
  @JvmStatic fun main(args: Array<String>) {
    val f = File(args[0])
    val n = args[1].toInt()
    val go = File(args[2])
    val until = System.currentTimeMillis() + 30_000
    while (!go.exists() && System.currentTimeMillis() < until) Thread.sleep(5)
    repeat(n) { Anchor.updateJoined(f) { l -> l.map { it.copy(joinedAt = it.joinedAt + 1) } } }
  }
}
