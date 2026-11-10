package expo.modules.kulallama

import expo.modules.kulallama.audit.Ledger
import expo.modules.kulallama.audit.SoftwareKey
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

// "remove a device's access" (docs/GATE.md): a master paired once is trusted until its line
// leaves gate/paired. The app removes it in its own process while the ":worker" process runs
// the gate with its own Paired over the same file: the gate must refuse it at the next
// handshake, cut what it has open, and the ledger must say so in one signed line.
class UnpairTest {
  private fun dir() = java.nio.file.Files.createTempDirectory("kula-unpair").toFile()
  private fun freePort() = ServerSocket(0).use { it.localPort }
  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = runCatching { echo.accept() }.getOrNull() ?: break; Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }
  private val a = "a".repeat(64)
  private val b = "b".repeat(64)
  private val c = "c".repeat(64)

  @Test fun removeKeepsTheOtherLinesTimesAndNames() {
    val f = File(dir(), "paired")
    val p = Paired(f)
    p.add(a, "mac studio")
    p.add(b)
    p.add(c, "pc")
    val before = p.list().associateBy { it.fp }
    assertTrue(p.remove(b))
    assertFalse(p.remove(b))
    assertFalse(p.contains(b))
    val again = Paired(f).list()
    assertEquals(listOf(a, c), again.map { it.fp })
    assertEquals("mac studio", again[0].name)
    assertEquals(before[a]!!.at, again[0].at)
    assertEquals("pc", again[1].name)
    assertEquals(listOf(c), p.find("CC").map { it.fp })
  }

  @Test fun aSecondInstanceSeesTheRemovalAtOnce() {
    val f = File(dir(), "paired")
    val worker = Paired(f).apply { add(a); add(b) }
    val app = Paired(f)
    assertTrue(app.remove(a))
    // no reload call, no restart: the worker's object reads the file again on its own
    assertFalse(worker.contains(a))
    assertTrue(worker.contains(b))
    assertEquals(1, worker.size())
    // and the other way: the worker pairs a new master, the app's list shows it
    worker.add(c, "new")
    assertEquals(listOf(b, c), app.list().map { it.fp })
  }

  @Test fun theGateRefusesARemovedCertificateAndClosesItsOpenPipe() {
    val echo = echo()
    val port = freePort()
    val d = dir()
    val pairedFile = File(d, "paired")
    val workerId = GateIdentity.create("worker")
    val mac = GateIdentity.create("mac")
    val pc = GateIdentity.create("pc")
    // the worker process's view
    val tls = Gate.TlsServer(workerId, Paired(pairedFile).apply { add(mac.fp, "mac"); add(pc.fp) }, null)
    // both channels lead to the echo: the open pipe holds rpc, the probes use api
    val gate = Gate.Server(port, null, { echo.localPort }, null, tls)
    gate.start()
    try {
      assertNull(Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(mac, workerId.fp)))
      // an open pipe from the mac: it echoes
      val raw = Socket().apply { connect(InetSocketAddress("127.0.0.1", port), 2000) }
      val s = Gate.handshake(raw, "", "rpc", Gate.TlsClient(mac, workerId.fp))
      s.getOutputStream().write("hi\n".toByteArray()); s.getOutputStream().flush()
      assertEquals('h'.code, s.getInputStream().read())
      // the app process removes the mac
      val key = SoftwareKey.generate()
      val ledgerFile = File(d, "ledger.jsonl")
      var recorded: Map<String, Any?>? = null
      assertTrue(Unpair.remove(mac.fp, Paired(pairedFile), null, null) { recorded = it; Unpair.record(Ledger(ledgerFile, key), it) })
      // new connections: refused at once, before the worker is told anything
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(mac, workerId.fp)))
      // the other paired computer still gets in
      assertNull(Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(pc, workerId.fp)))
      // the worker's drop (on the intent or its two-second look) ends the open pipe
      assertEquals(1, gate.drop(mac.fp))
      s.soTimeout = 3000
      val rest = runCatching { val inp = s.getInputStream(); var n = 0; while (inp.read() >= 0) n++; n }
      assertTrue("the pipe should end", rest.isSuccess || rest.exceptionOrNull() !is java.net.SocketTimeoutException)
      assertEquals(0, gate.drop(mac.fp))
      // one signed line: health, unpaired = the fingerprint's first 16, the name
      assertEquals(mac.fp.take(16), recorded!!["unpaired"])
      val lines = ledgerFile.readLines()
      assertEquals(1, lines.size)
      val o = JSONObject(lines[0])
      assertEquals("health", o.getString("kind"))
      assertEquals(mac.fp.take(16), o.getString("unpaired"))
      assertEquals("mac", o.getString("name"))
      assertEquals(-1, Ledger.verify(ledgerFile, key.publicKey, key.alg))
    } finally { gate.stop() }
  }

  @Test fun removingWhatIsNotPairedWritesNothing() {
    val d = dir()
    val p = Paired(File(d, "paired")).apply { add(a) }
    var wrote = false
    assertFalse(Unpair.remove(b, p, null, null) { wrote = true })
    assertFalse(wrote)
    assertTrue(p.contains(a))
  }

  @Test fun removingAScannedComputerForgetsItToo() {
    val d = dir()
    val hosts = Hosts(File(d, "hosts.json"))
    val now = System.currentTimeMillis()
    assertNull(hosts.offer(JSONObject().put("k", "kula-host").put("v", 1).put("id", "h1").put("name", "studio").put("fp", a).put("pin", "0123456789abcdef").put("exp", now + 60_000).toString(), now))
    hosts.paired(a, now)
    val p = Paired(File(d, "paired")).apply { add(a) }
    val seen = Seen(File(d, "seen")).apply { saw(a, "192.168.1.20", now) }
    var fields: Map<String, Any?>? = null
    assertTrue(Unpair.remove(a, p, hosts, seen) { fields = it })
    assertNull(hosts.byFp(a))
    assertNull(Seen(File(d, "seen")).get(a))
    assertEquals("studio", fields!!["name"])
  }

  @Test fun theListNamesWhatItCanAndSaysWhenItWasLastHere() {
    val d = dir()
    val now = System.currentTimeMillis()
    val hosts = Hosts(File(d, "hosts.json"))
    hosts.offer(JSONObject().put("k", "kula-host").put("v", 1).put("id", "h1").put("name", "studio").put("fp", a).put("pin", "0123456789abcdef").put("exp", now + 60_000).toString(), now)
    val p = Paired(File(d, "paired")).apply { add(a); add(b); add(c, "named in the line") }
    val seen = Seen(File(d, "seen")).apply { saw(b, "192.168.1.30", now + 5) }
    // the ledger's pair line gives c an address
    val key = SoftwareKey.generate()
    val ledgerFile = File(d, "ledger.jsonl")
    Ledger(ledgerFile, key).append("pair", "192.168.1.40", linkedMapOf("fp" to c, "channel" to "rpc"))
    val list = Unpair.list(p, hosts, seen, ledgerFile)
    assertEquals(3, list.size)
    // last seen first
    assertEquals(b, list[0].fp)
    assertEquals("192.168.1.30", list[0].address)
    assertEquals(now + 5, list[0].lastSeen)
    val byFp = list.associateBy { it.fp }
    assertEquals("studio", byFp[a]!!.name)
    assertTrue(byFp[a]!!.host)
    assertEquals("named in the line", byFp[c]!!.name)
    assertEquals("192.168.1.40", byFp[c]!!.address)
    assertNull(byFp[c]!!.lastSeen)
    assertFalse(byFp[c]!!.host)
  }

  @Test fun seenWritesAtMostOnceAMinuteUnlessTheAddressChanged() {
    val f = File(dir(), "seen")
    val s = Seen(f)
    assertTrue(s.saw(a, "10.0.0.1", 1_000))
    assertFalse(s.saw(a, "10.0.0.1", 30_000))
    assertTrue(s.saw(a, "10.0.0.2", 31_000))
    assertTrue(s.saw(a, "10.0.0.2", 100_000))
    assertEquals(100_000L to "10.0.0.2", Seen(f).get(a))
  }

  @Test fun twoLedgerObjectsOnOneFileKeepOneChain() {
    // the worker keeps its Ledger open; the app writes the removal through a second one
    val f = File(dir(), "ledger.jsonl")
    val key = SoftwareKey.generate()
    val worker = Ledger(f, key)
    worker.append("connect", "10.0.0.1", mapOf("channel" to "rpc"))
    Ledger(f, key).append("health", null, Unpair.fields(a, "mac"))
    worker.append("end", "10.0.0.1", mapOf("channel" to "rpc", "bytes" to 10, "seconds" to 1))
    assertEquals(3, f.readLines().size)
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
  }
}
