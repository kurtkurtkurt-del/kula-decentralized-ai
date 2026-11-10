package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.Json
import expo.modules.kulallama.audit.Ledger
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * GET /trust on the worker api (ApiServer.kt): what this device says about itself, so the
 * master (and the god's eye) can check it. kula-node's node/src/api.ts serves the same bytes;
 * fields keep the order below. Nothing secret goes out: no v1 secret, no pairing code, no
 * private key, no prompts. Plain Kotlin: JVM-tested in TrustTest.kt.
 *
 *   {"v":1,"id":"<device id>","key":{"alg","pub","store"},"cert":"<base64 der>"|null,
 *    "gate":{"v1","tls","paired"},
 *    "ledger":{"count","head","self","found","more","lines":[...]},
 *    "rejects":{"day":{"<why>":n},"last":[{"t","why","peer"}]}}
 *
 * The ledger is read as it is on disk (it can be 5 MB a file, and files are rotated away):
 * lines are only ever complete ones (a line being written has no newline yet), the chain
 * check is cached per file by size and mtime and goes on from where it stopped while a file
 * only grows, and the tail, the search for `since` and the rejects read from the end.
 */
class Trust(
  private val key: DeviceKey,
  /** where the key lives: "keystore" or "file" */
  private val store: String,
  private val certDer: ByteArray?,
  private val ledgerFile: File,
  private val gate: () -> GateState,
  private val now: () -> Long = System::currentTimeMillis,
) {
  data class GateState(val v1: Boolean, val tls: Boolean, val paired: Int)

  /** One answer: the status code and the json body. */
  data class Answer(val code: Int, val body: String)

  /** The chain check of one file, kept between requests. */
  private class Checked(val firstPrev: String) {
    var size = 0L
    var mtime = 0L
    /** bytes checked: up to and including the last complete line seen */
    var end = 0L
    var count = 0
    /** sha256 of the last line checked, or [firstPrev] while there is none */
    var last: String = firstPrev
    var bad = false
  }

  private val checked = HashMap<String, Checked>()

  /** The answer to GET /trust with [query] (the part after '?', or null). */
  @Synchronized
  fun answer(query: String?): Answer {
    val since = param(query, "since")
    if (since != null && !SINCE.matches(since)) return Answer(400, Json.obj(linkedMapOf("error" to "bad since")))
    val files = Ledger.chainFiles(ledgerFile)
    val chain = check(files)
    val head = chain.head
    var found: Boolean? = null
    var more = false
    val lines: List<String>
    if (since == null) {
      lines = newest(files, PAGE)
    } else if (since == head && chain.count > 0) {
      found = true; lines = emptyList()
    } else {
      val after = after(files, since)
      if (after == null) { found = false; lines = newest(files, PAGE) } else { found = true; lines = after.first; more = after.second }
    }
    val g = gate()
    val body = linkedMapOf<String, Any?>(
      "v" to 1,
      "id" to key.id,
      "key" to linkedMapOf("alg" to key.alg, "pub" to B64.encode(key.publicKey), "store" to store),
      "cert" to certDer?.let { B64.encode(it) },
      "gate" to linkedMapOf("v1" to g.v1, "tls" to g.tls, "paired" to g.paired),
      "ledger" to linkedMapOf(
        "count" to chain.count, "head" to head,
        "self" to when { chain.count == 0 -> "empty"; chain.bad -> "broken"; else -> "ok" },
        "found" to found, "more" to more, "lines" to lines,
      ),
      "rejects" to rejects(files),
    )
    return Answer(200, Json.obj(body))
  }

  /** Fills the chain cache ahead of the first request (a long ledger takes a while to check). */
  fun warm() { synchronized(this) { check(Ledger.chainFiles(ledgerFile)) } }

  private class Chain(val count: Int, val head: String, val bad: Boolean)

  /** Walks the chain over [files], oldest first, reusing what was checked before. */
  private fun check(files: List<File>): Chain {
    var prev = Ledger.GENESIS
    var count = 0
    var bad = false
    var head = Ledger.GENESIS
    val seen = HashSet<String>()
    for (f in files) {
      val path = f.absolutePath
      seen.add(path)
      val size = f.length()
      val mtime = f.lastModified()
      val old = checked[path]
      // a different predecessor, a file that shrank (cut or replaced) or changed without
      // growing: checked again from its first byte
      val c = if (old == null || old.firstPrev != prev || size < old.end || (size == old.size && mtime != old.mtime)) Checked(prev).also { checked[path] = it } else old
      if (size != c.size || mtime != c.mtime) {
        val start = c.end
        forLines(f, start) { line, end ->
          c.count++
          if (!c.bad) {
            val parts = Ledger.split(line)
            if (parts == null || parts.second != c.last || !DeviceKey.verify(key.alg, key.publicKey, parts.first.toByteArray(Charsets.UTF_8), parts.third)) c.bad = true
          }
          c.last = Ledger.sha256Hex(line.toByteArray(Charsets.UTF_8))
          c.end = end
        }
        c.size = size; c.mtime = mtime
      }
      count += c.count
      if (c.bad) bad = true
      if (c.count > 0) head = c.last
      prev = c.last
    }
    checked.keys.retainAll(seen)
    return Chain(count, head, bad)
  }

  /** The newest [n] lines across [files], oldest first. */
  private fun newest(files: List<File>, n: Int): List<String> {
    val out = ArrayDeque<String>()
    for (f in files.asReversed()) {
      if (out.size >= n) break
      reverseLines(f) { line -> out.addFirst(line); out.size < n }
    }
    return out.toList()
  }

  /**
   * The lines after the one whose sha256 is [since], at most [PAGE], oldest first, and whether
   * more follow; null when no line has that hash. Searched from the newest line back, so a
   * master that asks for what is new since its last look reads only the end of the ledger.
   */
  private fun after(files: List<File>, since: String): Pair<List<String>, Boolean>? {
    // lines newer than the one we look for, newest dropped first: what is left at the match is the oldest PAGE + 1
    val later = ArrayDeque<String>()
    var hit = false
    for (f in files.asReversed()) {
      reverseLines(f) { line ->
        if (Ledger.sha256Hex(line.toByteArray(Charsets.UTF_8)) == since) { hit = true; false }
        else { later.addFirst(line); if (later.size > PAGE + 1) later.removeLast(); true }
      }
      if (hit) break
    }
    if (!hit) return null
    val more = later.size > PAGE
    return later.take(PAGE) to more
  }

  /** The `reject` lines of the last 24 hours: counts by why (in the order first seen) and the last five, oldest first. */
  private fun rejects(files: List<File>): Map<String, Any?> {
    val from = now() - DAY_MS
    val found = ArrayList<JSONObject>()
    var done = false
    for (f in files.asReversed()) {
      reverseLines(f) { line ->
        val m = HEAD.find(line)
        val t = m?.groupValues?.get(1)?.toLongOrNull()
        if (t != null && t < from) { done = true; return@reverseLines false }
        if (m != null && m.groupValues[2] == "reject") runCatching { JSONObject(line) }.getOrNull()?.let { found.add(it) }
        true
      }
      if (done) break
    }
    found.reverse()
    val day = LinkedHashMap<String, Int>()
    for (o in found) { val why = o.optString("why", "?"); day[why] = (day[why] ?: 0) + 1 }
    val last = found.takeLast(5).map { o ->
      linkedMapOf<String, Any?>("t" to o.optLong("t"), "why" to o.optString("why", "?"), "peer" to (if (o.has("peer") && !o.isNull("peer")) o.optString("peer") else null))
    }
    return linkedMapOf("day" to day, "last" to last)
  }

  companion object {
    /** Lines in one answer, at most. */
    const val PAGE = 200
    const val DAY_MS = 24 * 3600 * 1000L
    private val SINCE = Regex("[0-9a-f]{64}")
    // every ledger line starts with its time and kind (Ledger.append writes them first)
    private val HEAD = Regex("""^\{"t":(-?[0-9]+),"kind":"([^"]*)"""")

    /** The value of [name] in a query string ("a=1&since=…"); null when absent. */
    fun param(query: String?, name: String): String? {
      if (query.isNullOrEmpty()) return null
      for (p in query.split('&')) {
        val k = p.substringBefore('=')
        if (k == name) return p.substringAfter('=', "")
      }
      return null
    }

    /**
     * Calls [block] for each complete line of [f] from byte [from] on, with the byte offset just
     * past its newline. A last line without a newline (still being written) is left out.
     */
    fun forLines(f: File, from: Long, block: (String, Long) -> Unit) {
      if (!f.exists()) return
      RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        if (from >= len) return
        raf.seek(from)
        val buf = ByteArray(64 * 1024)
        val line = java.io.ByteArrayOutputStream()
        var pos = from
        while (pos < len) {
          val n = raf.read(buf, 0, minOf(buf.size.toLong(), len - pos).toInt())
          if (n <= 0) break
          var start = 0
          for (i in 0 until n) {
            if (buf[i] == '\n'.code.toByte()) {
              line.write(buf, start, i - start)
              val s = line.toString("UTF-8")
              line.reset()
              if (s.isNotEmpty()) block(s, pos + i + 1)
              start = i + 1
            }
          }
          line.write(buf, start, n - start)
          pos += n
        }
      }
    }

    /**
     * Calls [block] for each complete line of [f], newest first, until it returns false. A last
     * line without a newline (still being written) is left out.
     */
    fun reverseLines(f: File, block: (String) -> Boolean) {
      if (!f.exists()) return
      RandomAccessFile(f, "r").use { raf ->
        var pos = raf.length()
        val buf = ByteArray(64 * 1024)
        // bytes of the line being put together, which starts further back than what was read
        var pending = ByteArray(0)
        var tail = true // until the last newline is found, bytes are an unfinished line
        while (pos > 0) {
          val from = maxOf(0L, pos - buf.size)
          val n = (pos - from).toInt()
          raf.seek(from)
          raf.readFully(buf, 0, n)
          var lineEnd = n
          for (i in n - 1 downTo 0) {
            if (buf[i] != '\n'.code.toByte()) continue
            if (tail) { tail = false; pending = ByteArray(0); lineEnd = i; continue }
            val bytes = buf.copyOfRange(i + 1, lineEnd) + pending
            pending = ByteArray(0)
            lineEnd = i
            if (bytes.isNotEmpty() && !block(String(bytes, Charsets.UTF_8))) return
          }
          pending = if (tail) ByteArray(0) else buf.copyOfRange(0, lineEnd) + pending
          pos = from
        }
        if (!tail && pending.isNotEmpty()) block(String(pending, Charsets.UTF_8))
      }
    }
  }
}
