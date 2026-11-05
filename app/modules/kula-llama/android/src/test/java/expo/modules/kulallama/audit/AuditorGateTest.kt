package expo.modules.kulallama.audit

import expo.modules.kulallama.Gate
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files

// The auditor behind a real gate over loopback: a replayed nonce and a bad clock are refused
// with the rule's name, a connect/end pair lands in the ledger in order, and the chain verifies.
class AuditorGateTest {
  private fun hello(port: Int, secret: String, nonce: String, ms: Long? = null): String =
    Socket("127.0.0.1", port).use { s ->
      s.soTimeout = 5000
      val out = s.getOutputStream()
      val inp = s.getInputStream().bufferedReader(Charsets.US_ASCII)
      out.write(("KULA1 rpc $nonce" + (if (ms != null) " $ms" else "") + "\n").toByteArray()); out.flush()
      val nonceS = inp.readLine() ?: return "closed"
      if (nonceS.startsWith("NO ")) return nonceS
      out.write((Gate.hmac(secret, nonce, nonceS, "rpc") + "\n").toByteArray()); out.flush()
      inp.readLine() ?: "closed"
    }

  // the gate writes end after the socket closes, on its own thread
  private fun waitFor(cond: () -> Boolean) {
    val deadline = System.currentTimeMillis() + 5000
    while (System.currentTimeMillis() < deadline && !cond()) Thread.sleep(20)
  }

  @Test fun replayAndClockAreRefusedAndTheLedgerRecordsTheSession() {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; s.close() }.start() } }.apply { isDaemon = true }.start()
    val dir = Files.createTempDirectory("audit").toFile()
    val key = SoftwareKey.generate()
    val now = 1_700_000_000_000L
    val auditor = Auditor(Ledger(File(dir, "ledger.jsonl"), key, now = { now }), key, now = { now })
    val secret = Gate.newSecret()
    val port = ServerSocket(0).use { it.localPort }
    val events = java.util.Collections.synchronizedList(mutableListOf<Gate.Event>())
    val server = Gate.Server(port, secret, { ch -> if (ch == "rpc") echo.localPort else null }, auditor) { events.add(it) }
    server.start()
    try {
      val nonce = "00112233445566778899aabbccddeeff"
      // first use passes, the handshake completes and the connection ends when we close
      assertTrue(hello(port, secret, nonce, now + 1000).startsWith("OK "))
      waitFor { events.count { it.kind == "end" } == 1 }
      // the same nonce again is a replay
      assertEquals("NO replay", hello(port, secret, nonce))
      // a clock two minutes and a bit off
      assertEquals("NO clock", hello(port, secret, "ffeeddccbbaa99887766554433221100", now + 130_000))
      // the plain v1 three-field hello still works (and the existing client does it)
      assertEquals(null, Gate.probe("127.0.0.1", port, secret, "rpc"))
      waitFor { events.count { it.kind == "end" } == 2 }
      val lines = auditor.summary(100)
      val kinds = lines.map { it.getString("kind") }
      assertEquals(listOf("connect", "end", "reject", "reject", "connect", "end"), kinds)
      assertEquals("replay", lines[2].getString("why"))
      assertEquals("clock", lines[3].getString("why"))
      assertEquals("rpc", lines[0].getString("channel"))
      assertEquals("127.0.0.1", lines[0].getString("peer"))
      assertTrue(lines[1].has("bytes"))
      assertEquals(-1, Ledger.verify(auditor.ledger.file, key.publicKey, key.alg))
      // the old callback still sees everything
      assertEquals(2, events.count { it.kind == "connect" })
      assertEquals(2, events.count { it.kind == "reject" })
    } finally {
      server.stop(); echo.close()
    }
  }

  // a ledger whose directory is a plain file cannot be written: the gate must still answer
  // (OK for a right secret, NO for a wrong one) and a 300 KB hello line is refused, not buffered
  @Test fun aBrokenLedgerAndAnEndlessHelloDoNotBreakTheGate() {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; s.close() }.start() } }.apply { isDaemon = true }.start()
    val dir = Files.createTempDirectory("audit").toFile()
    val key = SoftwareKey.generate()
    val ledger = Ledger(File(dir, "ledger.jsonl"), key)
    File(dir, "ledger.jsonl").writeText("")
    // a broken ledger: a file where its directory should be, from now on
    val broken = Ledger(File(File(dir, "ledger.jsonl"), "x.jsonl"), key)
    val auditor = Auditor(broken, key)
    val secret = Gate.newSecret()
    val port = ServerSocket(0).use { it.localPort }
    val server = Gate.Server(port, secret, { ch -> if (ch == "rpc") echo.localPort else null }, auditor)
    server.start()
    try {
      assertTrue(hello(port, secret, "00112233445566778899aabbccddeeff").startsWith("OK "))
      assertEquals("NO wrong secret", hello(port, "not-the-secret", "ffeeddccbbaa99887766554433221100"))
      Socket("127.0.0.1", port).use { s ->
        s.soTimeout = 5000
        // the gate stops reading at 256 bytes and answers; the rest of our write may hit a closed pipe
        runCatching { s.getOutputStream().write(ByteArray(300_000) { 'A'.code.toByte() }); s.getOutputStream().flush() }
        val reply = runCatching { s.getInputStream().bufferedReader(Charsets.US_ASCII).readLine() }.getOrNull()
        assertEquals("NO bad hello", reply)
      }
    } finally {
      server.stop(); echo.close()
    }
    assertEquals(0, ledger.tail(10).size)
  }

  @Test fun theOtherHooksWriteTheirLinesAndReturnVerdicts() {
    val dir = Files.createTempDirectory("audit").toFile()
    val key = SoftwareKey.generate()
    val a = Auditor(Ledger(File(dir, "ledger.jsonl"), key), key)
    a.onPair("abc")
    assertTrue(a.onLoad(listOf("local" to 20, "abc" to 12), "deadbeef", "deadbeef").ok)
    assertEquals("model", a.onLoad(listOf("local" to 32), "deadbeef", "cafe").reason)
    assertEquals(listOf("ram"), a.onClaim("abc", 3000, 1000, 0.0, 0.0, 0.0).warn)
    assertEquals(listOf("hot"), a.onHealth(false, 45.0, 90).warn)
    assertEquals("bounds", a.onEnd("abc", "rpc", 5, 1, ).let { Auditor(a.ledger, key, limits = Checks.Limits(1, 1)).onEnd("abc", "rpc", 5, 1) }.reason)
    val s = a.summary(10)
    assertEquals(listOf("pair", "load", "load", "claim", "health", "end", "end"), s.map { it.getString("kind") })
    assertEquals("model", s[2].getString("reject"))
    assertEquals(12, s[1].getJSONArray("split").getJSONObject(1).getInt("layers"))
    assertEquals(-1, Ledger.verify(a.ledger.file, key.publicKey, key.alg))
    JSONObject(s[0].toString())
  }
}
