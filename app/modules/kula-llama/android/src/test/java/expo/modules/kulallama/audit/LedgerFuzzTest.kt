package expo.modules.kulallama.audit

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Random

// The ledger under random entries (seeded; the TypeScript twin is node/test/fuzz-ledger):
// any sequence verifies, one changed byte anywhere fails at that line or the next, and the
// JSON writer is stable and parses back to the same values.
class LedgerFuzzTest {
  private val key = SoftwareKey.generate()
  private val rnd = Random(5112026L)
  private val kinds = listOf("pair", "connect", "reject", "load", "claim", "health", "end")

  private fun text(max: Int = 20): String = String(CharArray(rnd.nextInt(max)) {
    when (rnd.nextInt(6)) { 0 -> '"'; 1 -> '\\'; 2 -> listOf('\n', '\r', '\t', '\u0001', '\u001f')[rnd.nextInt(5)]; 3 -> rnd.nextInt(0xD7FF).toChar(); else -> (0x20 + rnd.nextInt(0x5f)).toChar() }
  })
  private fun value(depth: Int = 0): Any? = when (rnd.nextInt(if (depth == 0) 9 else 7)) {
    0 -> null
    1 -> rnd.nextBoolean()
    2 -> rnd.nextInt()
    3 -> rnd.nextLong()
    4 -> if (rnd.nextBoolean()) rnd.nextDouble() * 1e6 else rnd.nextInt(1000).toDouble()
    5 -> text()
    6 -> text(5)
    7 -> (0 until rnd.nextInt(4)).map { value(depth + 1) }
    else -> LinkedHashMap<String, Any?>().also { m -> repeat(rnd.nextInt(3)) { m[text(6)] = value(depth + 1) } }
  }
  private fun fields(): Map<String, Any?> = LinkedHashMap<String, Any?>().also { m ->
    repeat(rnd.nextInt(5)) { m[listOf("channel", "why", "bytes", "fp", "t", "kind", "peer", "prev", "sig", text(8))[rnd.nextInt(10)]] = value() }
  }
  private fun dir(): File = Files.createTempDirectory("ledger-fuzz").toFile()

  @Test fun anySequenceOfEntriesVerifiesAndKeepsTheLayout() {
    repeat(40) {
      val f = File(dir(), "ledger.jsonl")
      val l = Ledger(f, key, now = { 1_700_000_000_000L + rnd.nextInt(1_000_000) })
      val n = rnd.nextInt(8)
      val written = (0 until n).map { l.append(kinds[rnd.nextInt(kinds.size)], if (rnd.nextInt(5) == 0) null else "10.0.0.${rnd.nextInt(256)}", fields()) }
      assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
      assertEquals(written, if (f.exists()) f.readLines().filter { it.isNotEmpty() } else emptyList())
      for (line in written) {
        // org.json forgets the order, so the layout is read off the text: t and kind first,
        // prev and sig last, whatever the fields in between were called
        assertTrue(line, Regex("""^\{"t":\d+,"kind":"[a-z]+",""").containsMatchIn(line))
        assertTrue(line, Regex(""","prev":"[0-9a-f]{64}","sig":"[A-Za-z0-9+/=]*"\}$""").containsMatchIn(line))
        val o = JSONObject(line)
        assertTrue(o.getString("prev").matches(Regex("[0-9a-f]{64}")))
        assertTrue(Ledger.split(line) != null)
      }
    }
  }

  @Test fun oneChangedByteAnywhereFailsAtThatLineOrTheNext() {
    var checked = 0
    while (checked < 150) {
      val f = File(dir(), "ledger.jsonl")
      val l = Ledger(f, key)
      val n = 1 + rnd.nextInt(6)
      repeat(n) { l.append(kinds[rnd.nextInt(kinds.size)], "10.0.0.${rnd.nextInt(256)}", fields()) }
      val lines = f.readLines()
      val i = rnd.nextInt(n)
      val line = lines[i]
      val j = rnd.nextInt(line.length)
      val c = (0x21 + rnd.nextInt(0x5e)).toChar()
      if (c == line[j]) continue
      // a change of a padding bit inside the base64 signature is not a change of the record
      val mutated = line.substring(0, j) + c + line.substring(j + 1)
      val a = Ledger.split(line); val b = Ledger.split(mutated)
      if (a != null && b != null && a.first == b.first && a.third.contentEquals(b.third)) continue
      val out = lines.toMutableList(); out[i] = mutated
      f.writeText(out.joinToString("\n") + "\n")
      val at = Ledger.verify(f, key.publicKey, key.alg)
      assertNotEquals("line $i pos $j: '$line' -> '$mutated'", -1, at)
      assertTrue("failed at $at, changed $i", at == i || at == i + 1)
      checked++
    }
  }

  @Test fun droppedOrSwappedLinesFail() {
    repeat(40) {
      val f = File(dir(), "ledger.jsonl")
      val l = Ledger(f, key)
      val n = 2 + rnd.nextInt(5)
      repeat(n) { l.append(kinds[rnd.nextInt(kinds.size)], "p", fields()) }
      val lines = f.readLines()
      val i = rnd.nextInt(n - 1)
      f.writeText(lines.filterIndexed { k, _ -> k != i }.joinToString("\n") + "\n")
      assertNotEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
      val swapped = lines.toMutableList(); swapped[i] = lines[i + 1]; swapped[i + 1] = lines[i]
      f.writeText(swapped.joinToString("\n") + "\n")
      assertNotEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
    }
  }

  @Test fun theJsonWriterIsStableAndParsesBackToTheSameValues() {
    repeat(300) {
      val m = LinkedHashMap<String, Any?>().also { mm -> repeat(rnd.nextInt(6)) { mm[text(8)] = value() } }
      val a = Json.obj(m)
      assertEquals(a, Json.obj(m))
      val parsed = JSONObject(a)
      assertEquals(m.keys, parsed.keys().asSequence().toSet())
      for ((k, v) in m) same(v, parsed.opt(k))
      // no raw control characters ever reach the line: the ledger is one line per record
      assertTrue(a.none { it < ' ' })
    }
  }

  private fun same(v: Any?, got: Any?) {
    when (v) {
      null -> assertEquals(JSONObject.NULL, got)
      is String -> assertEquals(v, got)
      is Boolean -> assertEquals(v, got)
      is Int -> assertEquals(v.toLong(), (got as Number).toLong())
      is Long -> assertEquals(v, (got as Number).toLong())
      is Double -> if (v.isNaN() || v.isInfinite()) assertEquals(JSONObject.NULL, got) else assertEquals(v, (got as Number).toDouble(), Math.abs(v) * 1e-12)
      is List<*> -> { val arr = got as JSONArray; assertEquals(v.size, arr.length()); v.forEachIndexed { i, e -> same(e, arr.opt(i)) } }
      is Map<*, *> -> { val o = got as JSONObject; assertEquals(v.size, o.length()); for ((k, e) in v) same(e, o.opt(k.toString())) }
      else -> assertEquals(v.toString(), got.toString())
    }
  }
}
