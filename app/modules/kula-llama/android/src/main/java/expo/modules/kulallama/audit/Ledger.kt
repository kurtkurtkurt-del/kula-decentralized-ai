package expo.modules.kulallama.audit

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64

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
 * the chain continues across files. Appends are synchronized; nothing is ever rewritten.
 */
class Ledger(
  val file: File,
  private val key: DeviceKey,
  private val maxBytes: Long = 5L * 1024 * 1024,
  private val now: () -> Long = System::currentTimeMillis,
) {
  @Volatile var lastHash: String = lastHashOf(file)
    private set

  /** Appends one event and returns the line as written (without the newline). */
  @Synchronized
  fun append(kind: String, peer: String?, fields: Map<String, Any?> = emptyMap(), t: Long = now()): String {
    val ordered = LinkedHashMap<String, Any?>()
    ordered["t"] = t
    ordered["kind"] = kind
    if (peer != null) ordered["peer"] = peer
    for ((k, v) in fields) if (k != "t" && k != "kind" && k != "peer" && k != "prev" && k != "sig") ordered[k] = v
    // the file is gone and nothing rotated it: it was cleared (settings → beyin audit), so a
    // new chain starts from the genesis zeros instead of pointing at a line nobody can read
    if (!file.exists()) lastHash = GENESIS
    ordered["prev"] = lastHash
    val unsigned = Json.obj(ordered)
    val line = sign(unsigned, key)
    rotateIfFull(t)
    file.parentFile?.mkdirs()
    FileOutputStream(file, true).use { it.write((line + "\n").toByteArray(Charsets.UTF_8)) }
    lastHash = sha256Hex(line.toByteArray(Charsets.UTF_8))
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
    private val sigTail = Regex(""","sig":"([A-Za-z0-9+/=]*)"}$""")
    private val prevField = Regex(""""prev":"([0-9a-f]{64})"""")

    fun sha256Hex(bytes: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Signs an unsigned line (a complete JSON object ending in the prev field). */
    fun sign(unsigned: String, key: DeviceKey): String {
      val body = unsigned.removeSuffix("}")
      val sig = Base64.getEncoder().encodeToString(key.sign(body.toByteArray(Charsets.UTF_8)))
      return "$body,\"sig\":\"$sig\"}"
    }

    /** The parts of a line: the signed body, the prev value and the signature; null when malformed. */
    fun split(line: String): Triple<String, String, ByteArray>? {
      val m = sigTail.find(line) ?: return null
      val body = line.substring(0, m.range.first)
      val prev = prevField.find(body)?.groupValues?.get(1) ?: return null
      val sig = runCatching { Base64.getDecoder().decode(m.groupValues[1]) }.getOrNull() ?: return null
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
      return ok
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
