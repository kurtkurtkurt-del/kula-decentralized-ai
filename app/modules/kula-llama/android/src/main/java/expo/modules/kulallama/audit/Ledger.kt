package expo.modules.kulallama.audit

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * The audit ledger: append-only JSON lines, each hash-chained to the one before and signed
 * by the device key.
 *
 *   {"t":<unix ms>,"kind":"...","peer":"...", ...fields, "prev":"<sha256 hex of the previous
 *    line's bytes, 64 zeros for the first>","sig":"<base64 signature>"}
 *
 * The signature covers the line text up to and including the prev value's closing quote,
 * that is the line without `,"sig":"..."}`. The hash in the next line's prev is SHA-256 of the
 * whole previous line (UTF-8, without the newline). When a file passes [maxBytes] it is
 * renamed to `<name>.<t>.jsonl` and the next line's prev still points at its last line, so
 * the chain continues across files. Appends are synchronized, across the app's two processes
 * too (a lock file, and each append chains on from the file as it really is); nothing is ever rewritten,
 * with one exception: a last line the process died in the middle of (no newline at the end)
 * is cut off before the next line is written, and a `health` line with `torn` = the bytes
 * dropped records the cut in the chain itself.
 */
class Ledger(
  val file: File,
  private val key: DeviceKey,
  private val maxBytes: Long = 5L * 1024 * 1024,
  private val now: () -> Long = System::currentTimeMillis,
) {
  @Volatile var lastHash: String = GENESIS
    private set
  /** Bytes cut off a torn last line and not yet recorded (the record failed, say a key that cannot sign). */
  private var torn = 0L
  /** The live file's length as this object last left it (-1: no file). */
  private var knownLength: Long = lengthNow()
  private fun lengthNow(): Long = if (file.exists()) file.length() else -1L

  init {
    torn = cutTorn(file)
    lastHash = lastHashOfChain(file)
    // the cut goes into the chain at once; when that fails the next append tries again
    if (torn > 0) runCatching { synchronized(this) { crossProcess { recordTorn(now()) } } }
  }

  /** Appends one event and returns the line as written (without the newline). */
  @Synchronized
  fun append(kind: String, peer: String?, fields: Map<String, Any?> = emptyMap(), t: Long = now()): String = crossProcess {
    // a write that failed half way (disk full) leaves a torn line too: cut it before chaining on
    val cut = cutTorn(file)
    if (cut > 0) { torn += cut; lastHash = lastHashOfChain(file) }
    if (torn > 0) recordTorn(t)
    write(kind, peer, fields, t)
  }

  /**
   * Both of the app's processes write this ledger (the worker its gate events, the app a removed
   * device): one append at a time across them, through a lock file next to the ledger. Inside
   * one JVM a monitor per path comes first (a second FileLock on the same file from the same
   * JVM would throw instead of wait). A lock that cannot be taken (odd filesystem) does not
   * stop the append.
   */
  private fun <T> crossProcess(block: () -> T): T = synchronized(LOCKS.computeIfAbsent(file.absolutePath) { Any() }) {
    val raf = runCatching { file.parentFile?.mkdirs(); RandomAccessFile(File(file.parentFile, file.name + ".lock"), "rw") }.getOrNull()
      ?: return@synchronized block()
    raf.use { r ->
      val lock = runCatching { r.channel.lock() }.getOrNull()
      try { block() } finally { runCatching { lock?.release() } }
    }
  }

  private fun recordTorn(t: Long) {
    write("health", null, mapOf("torn" to torn), t)
    torn = 0
  }

  private fun write(kind: String, peer: String?, fields: Map<String, Any?>, t: Long): String {
    val ordered = LinkedHashMap<String, Any?>()
    ordered["t"] = t
    ordered["kind"] = kind
    if (peer != null) ordered["peer"] = peer
    for ((k, v) in fields) if (k != "t" && k != "kind" && k != "peer" && k != "prev" && k != "sig") ordered[k] = v
    // the file is not as this object left it: the other process of the app wrote a line (the
    // app records a removed device while the worker runs), rotated it, or cleared it
    // (settings → beyin audit). The chain goes on from what is really there: the last line,
    // the last rotated file's, or the genesis zeros when nothing is left.
    if (lengthNow() != knownLength) lastHash = lastHashOfChain(file)
    ordered["prev"] = lastHash
    val unsigned = Json.obj(ordered)
    val line = sign(unsigned, key)
    rotateIfFull(t)
    file.parentFile?.mkdirs()
    FileOutputStream(file, true).use { it.write((line + "\n").toByteArray(Charsets.UTF_8)) }
    lastHash = sha256Hex(line.toByteArray(Charsets.UTF_8))
    knownLength = lengthNow()
    return line
  }


  /** The last [limit] lines of the current file, oldest first. */
  fun tail(limit: Int): List<String> = tail(file, limit)

  /** Deletes this ledger and its rotated files; the next append starts a new chain. */
  @Synchronized
  fun clear(): Boolean = clear(file).also { lastHash = GENESIS }

  private fun rotateIfFull(t: Long) {
    if (!file.exists() || file.length() <= maxBytes) return
    val base = file.name.removeSuffix(".jsonl")
    var target = File(file.parentFile, "$base.$t.jsonl")
    var n = 1
    while (target.exists()) target = File(file.parentFile, "$base.$t.${n++}.jsonl")
    file.renameTo(target)
  }

  companion object {
    const val GENESIS = "0000000000000000000000000000000000000000000000000000000000000000"
    private val LOCKS = java.util.concurrent.ConcurrentHashMap<String, Any>()
    // the closing brace escaped: java's regex takes a bare "}" as a literal, android's ICU
    // engine refuses it (the worker process died at class load, 5.11.2026)
    private val sigTail = Regex(""","sig":"([A-Za-z0-9+/=]*)"\}$""")
    private val prevField = Regex(""""prev":"([0-9a-f]{64})"""")

    fun sha256Hex(bytes: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Signs an unsigned line (a complete JSON object ending in the prev field). */
    fun sign(unsigned: String, key: DeviceKey): String {
      val body = unsigned.removeSuffix("}")
      val sig = B64.encode(key.sign(body.toByteArray(Charsets.UTF_8)))
      return "$body,\"sig\":\"$sig\"}"
    }

    /** The parts of a line: the signed body, the prev value and the signature; null when malformed. */
    fun split(line: String): Triple<String, String, ByteArray>? {
      val m = sigTail.find(line) ?: return null
      val body = line.substring(0, m.range.first)
      val prev = prevField.find(body)?.groupValues?.get(1) ?: return null
      val sig = runCatching { B64.decode(m.groupValues[1]) }.getOrNull() ?: return null
      return Triple(body, prev, sig)
    }

    /**
     * Walks the chain in [file] and returns the index of the first line that fails, or -1.
     * [firstPrev] is what the first line's prev must be: the genesis zeros for a fresh
     * ledger, or the last hash of the file rotated away before it.
     */
    fun verify(file: File, publicKey: ByteArray, alg: String, firstPrev: String = GENESIS): Int {
      if (!file.exists()) return -1
      var expected = firstPrev
      file.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.forEachIndexed { i, line ->
          val (body, prev, sig) = split(line) ?: return i
          if (prev != expected) return i
          if (!DeviceKey.verify(alg, publicKey, body.toByteArray(Charsets.UTF_8), sig)) return i
          expected = sha256Hex(line.toByteArray(Charsets.UTF_8))
        }
      }
      return -1
    }

    /**
     * Deletes [file] and the files rotated away from it (`<name>.<t>.jsonl`, `<name>.<t>.<n>.jsonl`).
     * The only thing that ever removes ledger lines; the user asks for it, with a confirmation.
     */
    fun clear(file: File): Boolean {
      val base = file.name.removeSuffix(".jsonl")
      val rotated = Regex("^" + Regex.escape(base) + "\\.[0-9]+(\\.[0-9]+)?\\.jsonl$")
      var ok = true
      file.parentFile?.listFiles()?.filter { rotated.matches(it.name) }?.forEach { ok = it.delete() && ok }
      if (file.exists()) ok = file.delete() && ok
      File(file.parentFile, file.name + ".lock").delete()
      return ok
    }

    /**
     * Cuts a torn last line: when [file] does not end in a newline, everything after its last
     * newline goes (the whole file when it has none). Returns the bytes dropped, 0 when the
     * file was whole.
     */
    fun cutTorn(file: File): Long {
      if (!file.exists()) return 0
      RandomAccessFile(file, "rw").use { raf ->
        val len = raf.length()
        if (len == 0L) return 0
        raf.seek(len - 1)
        if (raf.read() == '\n'.code) return 0
        var keep = 0L
        val buf = ByteArray(8192)
        var end = len - 1
        search@ while (end > 0) {
          val from = maxOf(0L, end - buf.size)
          val n = (end - from).toInt()
          raf.seek(from)
          raf.readFully(buf, 0, n)
          for (i in n - 1 downTo 0) if (buf[i] == '\n'.code.toByte()) { keep = from + i + 1; break@search }
          end = from
        }
        raf.setLength(keep)
        return len - keep
      }
    }

    /**
     * The ledger's files oldest first: the files rotated away from [file] by time (and the
     * ".<n>" a same-millisecond rotation adds), then [file] itself when it exists.
     */
    fun chainFiles(file: File): List<File> {
      val base = file.name.removeSuffix(".jsonl")
      val rotated = Regex("^" + Regex.escape(base) + "\\.([0-9]+)(?:\\.([0-9]+))?\\.jsonl$")
      val old = file.parentFile?.listFiles()?.mapNotNull { f ->
        val m = rotated.matchEntire(f.name) ?: return@mapNotNull null
        Triple(f, m.groupValues[1].toBigInteger(), m.groupValues[2].ifEmpty { "0" }.toBigInteger())
      }?.sortedWith(compareBy({ it.second }, { it.third }))?.map { it.first } ?: emptyList()
      return if (file.exists()) old + file else old
    }

    /** SHA-256 of the newest line in the chain: [file]'s last line, else the last rotated file's, else the genesis zeros. */
    fun lastHashOfChain(file: File): String {
      for (f in chainFiles(file).asReversed()) {
        val h = lastHashOf(f)
        if (h != GENESIS) return h
      }
      return GENESIS
    }

    /** SHA-256 of the last line of [file], or the genesis zeros when there is none. */
    fun lastHashOf(file: File): String {
      if (!file.exists()) return GENESIS
      var last: String? = null
      file.bufferedReader(Charsets.UTF_8).useLines { lines -> for (l in lines) if (l.isNotEmpty()) last = l }
      return last?.let { sha256Hex(it.toByteArray(Charsets.UTF_8)) } ?: GENESIS
    }

    fun tail(file: File, limit: Int): List<String> {
      if (!file.exists() || limit <= 0) return emptyList()
      val ring = ArrayDeque<String>(limit)
      file.bufferedReader(Charsets.UTF_8).useLines { lines ->
        for (l in lines) { if (l.isEmpty()) continue; if (ring.size == limit) ring.removeFirst(); ring.addLast(l) }
      }
      return ring.toList()
    }
  }
}
