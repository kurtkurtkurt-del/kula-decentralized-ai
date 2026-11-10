package expo.modules.kulallama.audit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

// The chain: a fresh ledger verifies, one flipped byte breaks at that line, and rotation
// starts a new file whose first prev is the old file's last hash.
class LedgerTest {
  private val key = SoftwareKey.generate()
  private fun dir(): File = Files.createTempDirectory("ledger").toFile()

  @Test fun chainVerifiesAndTamperBreaksAtTheRightIndex() {
    val f = File(dir(), "ledger.jsonl")
    val l = Ledger(f, key, now = { 1_700_000_000_000L })
    for (i in 0 until 5) l.append("connect", "10.0.0.$i", mapOf("channel" to "rpc"))
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
    val lines = f.readLines()
    assertEquals(5, lines.size)
    assertTrue(lines[0].contains("\"prev\":\"${Ledger.GENESIS}\""))
    assertEquals(Ledger.sha256Hex(lines[1].toByteArray()), Regex("\"prev\":\"([0-9a-f]+)\"").find(lines[2])!!.groupValues[1])
    // flip one byte inside line 3's peer field
    val bytes = f.readBytes()
    val off = f.readText().indexOf("10.0.0.3")
    bytes[off] = 'X'.code.toByte()
    f.writeBytes(bytes)
    assertEquals(3, Ledger.verify(f, key.publicKey, key.alg))
    // a reopened ledger continues the chain from the last line on disk
    val more = Ledger(f, key)
    assertEquals(Ledger.sha256Hex(lines[4].toByteArray()), more.lastHash)
    // a wrong key fails at the first line
    val other = SoftwareKey.generate(preferEd25519 = false)
    assertEquals(0, Ledger.verify(f, other.publicKey, other.alg))
  }

  @Test fun clearRemovesEveryFileAndRestartsTheChain() {
    val d = dir()
    val f = File(d, "ledger.jsonl")
    var t = 1_700_000_000_000L
    val l = Ledger(f, key, maxBytes = 600, now = { t++ })
    for (i in 0 until 12) l.append("health", null, mapOf("throttled" to false, "batteryC" to 30, "batteryPct" to 80))
    File(d, "other.jsonl").writeText("stays\n")
    assertTrue(d.list()!!.size > 2)
    assertTrue(l.clear())
    assertEquals(listOf("other.jsonl"), d.list()!!.toList())
    assertEquals(Ledger.GENESIS, l.lastHash)
    // a ledger cleared behind a live instance (the worker process keeps one) also restarts
    val live = Ledger(File(d, "live.jsonl"), key)
    live.append("connect", "10.0.0.1", mapOf("channel" to "rpc"))
    Ledger.clear(live.file)
    val line = live.append("connect", "10.0.0.2", mapOf("channel" to "rpc"))
    assertTrue(line.contains("\"prev\":\"${Ledger.GENESIS}\""))
    assertEquals(-1, Ledger.verify(live.file, key.publicKey, key.alg))
  }

  @Test fun rotationLinksFiles() {
    val d = dir()
    val f = File(d, "ledger.jsonl")
    var t = 1_700_000_000_000L
    val l = Ledger(f, key, maxBytes = 600, now = { t++ })
    for (i in 0 until 12) l.append("health", null, mapOf("throttled" to false, "batteryC" to 30, "batteryPct" to 80))
    val rotated = d.listFiles()!!.filter { it.name != "ledger.jsonl" && it.name.endsWith(".jsonl") }.sortedBy { it.name }
    assertTrue("expected rotated files, got ${d.list()!!.toList()}", rotated.isNotEmpty())
    // every file verifies on its own given its predecessor's last hash
    var prev = Ledger.GENESIS
    for (file in rotated + f) {
      assertEquals(file.name, -1, Ledger.verify(file, key.publicKey, key.alg, prev))
      prev = Ledger.lastHashOf(file)
    }
    assertEquals(12, (rotated + f).sumOf { it.readLines().size })
    assertEquals(l.tail(3).size, 3.coerceAtMost(f.readLines().size))
  }

  @Test fun concurrentAppendsStayChained() {
    val f = File(dir(), "ledger.jsonl")
    val l = Ledger(f, key)
    val threads = (0 until 4).map { n -> Thread { repeat(25) { l.append("health", "t$n", mapOf("i" to it)) } } }
    threads.forEach { it.start() }; threads.forEach { it.join() }
    assertEquals(100, f.readLines().size)
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
  }

  @Test fun aTornLastLineIsCutAndTheCutIsRecorded() {
    val f = File(dir(), "ledger.jsonl")
    var t = 1_700_000_000_000L
    val l = Ledger(f, key, now = { t++ })
    for (i in 0 until 3) l.append("connect", "10.0.0.$i", mapOf("channel" to "rpc"))
    val whole = f.readText()
    val good = f.readLines()
    // the process died half way through a fourth line
    f.appendText("{\"t\":1700000000099,\"kind\":\"conn")
    val reopened = Ledger(f, key, now = { t++ })
    // cut back to the last whole line, and the cut is the next line, chained to it and signed
    val lines = f.readLines()
    assertEquals(4, lines.size)
    assertEquals(good, lines.take(3))
    assertTrue(lines[3].contains("\"kind\":\"health\""))
    assertTrue(lines[3].contains("\"torn\":${"{\"t\":1700000000099,\"kind\":\"conn".length}"))
    assertTrue(lines[3].contains("\"prev\":\"${Ledger.sha256Hex(good[2].toByteArray())}\""))
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
    assertEquals(Ledger.sha256Hex(lines[3].toByteArray()), reopened.lastHash)
    // a torn line under a live ledger (a write that failed half way) is cut before the next append
    f.appendText("{\"t\":17")
    reopened.append("end", "10.0.0.1", mapOf("channel" to "rpc"))
    val after = f.readLines()
    assertEquals(6, after.size)
    assertTrue(after[4].contains("\"torn\":7"))
    assertTrue(after[5].contains("\"kind\":\"end\""))
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
    // a whole file is left alone: nothing cut, nothing added
    val g = File(dir(), "ledger.jsonl")
    g.writeText(whole)
    Ledger(g, key)
    assertEquals(whole, g.readText())
    assertEquals(0L, Ledger.cutTorn(g))
  }

  @Test fun aFileThatIsAllTornStartsFromTheRotatedFileBeforeIt() {
    val d = dir()
    val f = File(d, "ledger.jsonl")
    var t = 1_700_000_000_000L
    val l = Ledger(f, key, maxBytes = 600, now = { t++ })
    for (i in 0 until 12) l.append("health", null, mapOf("throttled" to false, "batteryC" to 30, "batteryPct" to 80))
    val files = Ledger.chainFiles(f)
    assertTrue(files.size > 1)
    assertEquals(f, files.last())
    // the current file holds only a line that never finished
    f.writeText("{\"t\":1")
    val prevLast = Ledger.lastHashOf(files[files.size - 2])
    Ledger(f, key, maxBytes = 600, now = { t++ })
    val line = f.readLines().single()
    assertTrue(line.contains("\"torn\":6"))
    assertTrue(line.contains("\"prev\":\"$prevLast\""))
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg, prevLast))
  }

  @Test fun chainFilesAreInTimeOrder() {
    val d = dir()
    val f = File(d, "ledger.jsonl")
    for (n in listOf("ledger.1700000000005.jsonl", "ledger.1700000000005.1.jsonl", "ledger.1700000000005.2.jsonl", "ledger.1600000000000.jsonl", "ledger.jsonl", "other.jsonl", "ledger.x.jsonl")) File(d, n).writeText("")
    assertEquals(listOf("ledger.1600000000000.jsonl", "ledger.1700000000005.jsonl", "ledger.1700000000005.1.jsonl", "ledger.1700000000005.2.jsonl", "ledger.jsonl"), Ledger.chainFiles(f).map { it.name })
  }
}
