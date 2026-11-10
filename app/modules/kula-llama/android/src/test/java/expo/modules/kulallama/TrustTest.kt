package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.Ledger
import expo.modules.kulallama.audit.SoftwareKey
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

// GET /trust (Trust.kt; kula-node's node/src/api.ts serves the same shape): field order, the
// ledger window with and without `since`, the chain check, the last day's rejects.
class TrustTest {
  private val key = SoftwareKey.generate(preferEd25519 = false)
  private val day = 24 * 3600 * 1000L
  private val now = 1_800_000_000_000L
  private fun dir(): File = Files.createTempDirectory("kula-trust").toFile()
  private fun hash(line: String) = Ledger.sha256Hex(line.toByteArray(Charsets.UTF_8))
  private fun trust(f: File, cert: ByteArray? = byteArrayOf(1, 2, 3), gate: Trust.GateState = Trust.GateState(false, true, 2)) =
    Trust(key, "file", cert, f, { gate }, { now })
  private fun ok(a: Trust.Answer): JSONObject { assertEquals(a.body, 200, a.code); return JSONObject(a.body) }
  private fun lines(o: JSONObject): List<String> = o.getJSONObject("ledger").getJSONArray("lines").let { a -> (0 until a.length()).map { a.getString(it) } }

  @Test fun theShapeAndItsOrder() {
    val f = File(dir(), "ledger.jsonl")
    val l = Ledger(f, key, now = { now - 1000 })
    l.append("connect", "10.0.0.2", mapOf("channel" to "rpc"))
    val a = trust(f).answer(null)
    assertEquals(200, a.code)
    // the field order is part of the contract: the node side writes the same bytes
    val names = Regex("\"([a-z0-9]+)\":").findAll(a.body.substringBefore("\"lines\":")).map { it.groupValues[1] }.toList()
    assertEquals(listOf("v", "id", "key", "alg", "pub", "store", "cert", "gate", "v1", "tls", "paired", "ledger", "count", "head", "self", "found", "more"), names)
    assertTrue(a.body.substringAfter("\"lines\":").endsWith("]},\"rejects\":{\"day\":{},\"last\":[]}}"))
    val o = JSONObject(a.body)
    assertEquals(1, o.getInt("v"))
    assertEquals(key.id, o.getString("id"))
    assertEquals("p256", o.getJSONObject("key").getString("alg"))
    assertEquals(B64.encode(key.publicKey), o.getJSONObject("key").getString("pub"))
    assertEquals("file", o.getJSONObject("key").getString("store"))
    assertEquals(B64.encode(byteArrayOf(1, 2, 3)), o.getString("cert"))
    assertEquals("{\"v1\":false,\"tls\":true,\"paired\":2}", a.body.substringAfter("\"gate\":").substringBefore('}') + "}")
    val led = o.getJSONObject("ledger")
    assertEquals(1, led.getInt("count"))
    assertEquals(hash(f.readLines()[0]), led.getString("head"))
    assertEquals("ok", led.getString("self"))
    assertTrue(led.isNull("found"))
    assertFalse(led.getBoolean("more"))
    // the raw line, exactly as stored
    assertEquals(f.readLines(), lines(o))
    // no certificate yet: null, not missing
    assertTrue(JSONObject(trust(f, cert = null).answer(null).body).isNull("cert"))
  }

  @Test fun anEmptyLedger() {
    val o = ok(trust(File(dir(), "ledger.jsonl")).answer(null))
    val led = o.getJSONObject("ledger")
    assertEquals(0, led.getInt("count"))
    assertEquals(Ledger.GENESIS, led.getString("head"))
    assertEquals("empty", led.getString("self"))
    assertEquals(0, led.getJSONArray("lines").length())
  }

  @Test fun theWindowWithAndWithoutSince() {
    val f = File(dir(), "ledger.jsonl")
    var t = now - 10 * day
    val l = Ledger(f, key, now = { t++ })
    for (i in 0 until 250) l.append("health", null, mapOf("i" to i))
    val all = f.readLines()
    val tr = trust(f)
    // no since: the newest 200, oldest first
    var o = ok(tr.answer(null))
    assertEquals(all.takeLast(200), lines(o))
    assertEquals(250, o.getJSONObject("ledger").getInt("count"))
    assertEquals(hash(all.last()), o.getJSONObject("ledger").getString("head"))
    // since an old line: the 200 after it, and more to come
    o = ok(tr.answer("since=${hash(all[9])}"))
    assertEquals(all.subList(10, 210), lines(o))
    assertTrue(o.getJSONObject("ledger").getBoolean("found"))
    assertTrue(o.getJSONObject("ledger").getBoolean("more"))
    // exactly 200 after it: no more
    o = ok(tr.answer("since=${hash(all[49])}"))
    assertEquals(all.subList(50, 250), lines(o))
    assertFalse(o.getJSONObject("ledger").getBoolean("more"))
    // since a recent line: the few after it
    o = ok(tr.answer("since=${hash(all[240])}"))
    assertEquals(all.subList(241, 250), lines(o))
    assertFalse(o.getJSONObject("ledger").getBoolean("more"))
    // since the head: found, nothing new
    o = ok(tr.answer("since=${hash(all.last())}"))
    assertTrue(o.getJSONObject("ledger").getBoolean("found"))
    assertEquals(emptyList<String>(), lines(o))
    // a hash the ledger never had: not found, the newest 200
    o = ok(tr.answer("x=1&since=${"ab".repeat(32)}"))
    assertFalse(o.getJSONObject("ledger").getBoolean("found"))
    assertEquals(all.takeLast(200), lines(o))
    // a bad since
    for (q in listOf("since=xyz", "since=", "since=${"AB".repeat(32)}", "since=${"ab".repeat(33)}")) {
      val a = tr.answer(q)
      assertEquals(q, 400, a.code)
      assertEquals("{\"error\":\"bad since\"}", a.body)
    }
  }

  @Test fun acrossRotatedFilesAndWhileTheLedgerGrows() {
    val d = dir()
    val f = File(d, "ledger.jsonl")
    var t = now - 2 * day
    val l = Ledger(f, key, maxBytes = 2000, now = { t++ })
    for (i in 0 until 60) l.append("health", null, mapOf("i" to i))
    val files = Ledger.chainFiles(f)
    assertTrue(files.size > 3)
    val all = files.flatMap { it.readLines() }
    assertEquals(60, all.size)
    val tr = trust(f)
    var o = ok(tr.answer(null))
    assertEquals(60, o.getJSONObject("ledger").getInt("count"))
    assertEquals("ok", o.getJSONObject("ledger").getString("self"))
    assertEquals(all, lines(o))
    // since a line in the first file: what follows, across the files
    o = ok(tr.answer("since=${hash(all[2])}"))
    assertEquals(all.drop(3), lines(o))
    // more lines (and another rotation): the cached check goes on from where it was
    for (i in 60 until 90) l.append("health", null, mapOf("i" to i))
    o = ok(tr.answer(null))
    assertEquals(90, o.getJSONObject("ledger").getInt("count"))
    assertEquals("ok", o.getJSONObject("ledger").getString("self"))
    // a line still being written is not a line yet
    f.appendText("{\"t\":1,\"kind\":\"he")
    o = ok(tr.answer(null))
    assertEquals(90, o.getJSONObject("ledger").getInt("count"))
    assertEquals(Ledger.chainFiles(f).flatMap { it.readLines() }.filter { it.endsWith("}") }, lines(o))
  }

  @Test fun aTamperedLedgerIsBroken() {
    val f = File(dir(), "ledger.jsonl")
    val l = Ledger(f, key, now = { now })
    for (i in 0 until 5) l.append("connect", "10.0.0.$i", mapOf("channel" to "rpc"))
    val tr = trust(f)
    assertEquals("ok", ok(tr.answer(null)).getJSONObject("ledger").getString("self"))
    val bytes = f.readBytes()
    val at = f.readText().indexOf("10.0.0.3")
    bytes[at] = 'X'.code.toByte()
    f.writeBytes(bytes)
    f.setLastModified(f.lastModified() + 5000)
    assertEquals("broken", ok(tr.answer(null)).getJSONObject("ledger").getString("self"))
    // another key's ledger does not pass as this device's
    val g = File(dir(), "ledger.jsonl")
    val other = SoftwareKey.generate(preferEd25519 = false)
    Ledger(g, other).append("health", null)
    assertEquals("broken", ok(trust(g).answer(null)).getJSONObject("ledger").getString("self"))
  }

  @Test fun theLastDaysRejects() {
    val f = File(dir(), "ledger.jsonl")
    var t = now - 2 * day
    val l = Ledger(f, key, now = { t })
    l.append("reject", "10.0.0.9", linkedMapOf("channel" to "rpc", "why" to "old"))
    t = now - day + 60_000
    val whys = listOf("wrong secret", "replay", "wrong secret", "no v1", "clock", "wrong secret", "no v1")
    for ((i, why) in whys.withIndex()) {
      l.append("reject", "10.0.0.$i", linkedMapOf("channel" to null, "why" to why))
      l.append("connect", "10.0.0.$i", mapOf("channel" to "rpc"))
      t += 1000
    }
    val o = ok(trust(f).answer(null))
    val rejects = o.getJSONObject("rejects")
    // counts by why, in the order first seen, nothing older than a day
    val body = trust(f).answer(null).body
    assertTrue(body.endsWith("\"rejects\":{\"day\":{\"wrong secret\":3,\"replay\":1,\"no v1\":2,\"clock\":1},\"last\":[" +
      (2 until 7).joinToString(",") { i -> "{\"t\":${now - day + 60_000 + i * 1000},\"why\":\"${whys[i]}\",\"peer\":\"10.0.0.$i\"}" } + "]}}"))
    assertEquals(5, rejects.getJSONArray("last").length())
  }

  @Test fun theQueryParameter() {
    assertEquals("x", Trust.param("since=x", "since"))
    assertEquals("x", Trust.param("a=1&since=x", "since"))
    assertEquals("", Trust.param("since", "since"))
    assertEquals(null, Trust.param("sinc=x", "since"))
    assertEquals(null, Trust.param(null, "since"))
  }

  @Test fun linesAreReadWholeBothWays() {
    val f = File(dir(), "x.jsonl")
    // lines longer than one read, and a last line without its newline
    val long = "y".repeat(150_000)
    f.writeText("a\n$long\nb\nc\npartial")
    val back = ArrayList<String>()
    Trust.reverseLines(f) { back.add(it); true }
    assertEquals(listOf("c", "b", long, "a"), back)
    val fwd = ArrayList<Pair<String, Long>>()
    Trust.forLines(f, 0) { s, end -> fwd.add(s to end) }
    assertEquals(listOf("a", long, "b", "c"), fwd.map { it.first })
    assertEquals((2 + long.length + 1 + 2 + 2).toLong(), fwd.last().second)
    // from an offset
    val rest = ArrayList<String>()
    Trust.forLines(f, fwd[1].second) { s, _ -> rest.add(s) }
    assertEquals(listOf("b", "c"), rest)
    // a file with no newline at all has no complete line
    f.writeText("nothing yet")
    var n = 0
    Trust.reverseLines(f) { n++; true }
    Trust.forLines(f, 0) { _, _ -> n++ }
    assertEquals(0, n)
  }
}
