package expo.modules.kulallama

import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * Resumable model download with a checksum at the end. Writes <dest>.part, continues with a
 * Range request after a kill or a lost network, then checks size and SHA-256 and renames.
 * A file that fails the check is deleted: PrivateLM's "Incomplete Model File" problem solved
 * at the source. One thread per download; progress goes to [onProgress] at most 4×/s.
 *
 * Limits (docs/SECURITY.md): the url and every redirect must pass [UrlPolicy] (public http(s);
 * a name that resolves to a private address is refused too), the body may not run past
 * [expectedSize] when one was given, and the disk keeps [SizePolicy.KEEP_FREE_BYTES].
 */
class ModelDownloader(private val onProgress: (id: String, got: Long, total: Long, state: String, error: String?) -> Unit) {
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val active = ConcurrentHashMap<String, Thread>()

  fun start(id: String, url: String, dest: File, sha256: String?, expectedSize: Long) {
    if (active.containsKey(id)) return
    cancelled.remove(id)
    active[id] = thread(name = "download-$id") {
      try {
        run(id, url, dest, sha256?.lowercase(), expectedSize)
      } catch (e: Exception) {
        Log.w(TAG, "download $id: ${e.message}")
        onProgress(id, dest.resolveSibling(dest.name + ".part").length(), expectedSize, if (cancelled.contains(id)) "cancelled" else "error", e.message)
      } finally {
        active.remove(id)
      }
    }
  }

  fun cancel(id: String) {
    cancelled.add(id)
    active[id]?.interrupt()
  }

  fun isActive(id: String) = active.containsKey(id)

  private fun run(id: String, url: String, dest: File, sha256: String?, expectedSize: Long) {
    dest.parentFile?.mkdirs()
    val part = dest.resolveSibling(dest.name + ".part")
    var got = part.length()
    var total = expectedSize
    var lastReport = 0L
    var sinceCheck = 0L
    onProgress(id, got, total, "running", null)

    var attempt = 0
    while (true) {
      if (cancelled.contains(id)) { onProgress(id, got, total, "cancelled", null); return }
      val conn = open(url, got)
      try {
        val code = conn.responseCode
        when {
          code == 416 -> { part.delete(); got = 0; continue }
          code == 200 && got > 0 -> { part.delete(); got = 0 }  // server ignores ranges: start over
          code !in 200..299 -> throw IllegalStateException("http $code")
        }
        if (code == 206) {
          conn.getHeaderField("Content-Range")?.substringAfter('/')?.toLongOrNull()?.let { total = it }
        } else {
          conn.contentLengthLong.takeIf { it > 0 }?.let { total = it }
        }
        if (expectedSize > 0 && total > 0 && SizePolicy.overSize(total, expectedSize)) throw IllegalStateException("size mismatch: server says $total bytes, expected $expectedSize")
        val need = (if (total > 0) total else expectedSize) - got
        if (need > 0 && (dest.parentFile ?: dest).usableSpace - need < SizePolicy.KEEP_FREE_BYTES) throw IllegalStateException("not enough free space")
        RandomAccessFile(part, "rw").use { raf ->
          raf.seek(got)
          conn.inputStream.use { inp ->
            val buf = ByteArray(256 * 1024)
            while (true) {
              if (cancelled.contains(id) || Thread.currentThread().isInterrupted) { onProgress(id, got, total, "cancelled", null); return }
              val n = inp.read(buf)
              if (n < 0) break
              raf.write(buf, 0, n)
              got += n
              if (SizePolicy.overSize(got, expectedSize) || (total > 0 && got > total)) throw IllegalStateException("download ran past ${if (expectedSize > 0) expectedSize else total} bytes")
              sinceCheck += n
              if (sinceCheck > 32L * 1024 * 1024) {
                // a body of unknown length is held by the disk itself
                sinceCheck = 0
                if ((dest.parentFile ?: dest).usableSpace < SizePolicy.KEEP_FREE_BYTES) throw IllegalStateException("not enough free space")
              }
              val now = System.currentTimeMillis()
              if (now - lastReport > 250) { lastReport = now; onProgress(id, got, total, "running", null) }
            }
          }
        }
        break
      } catch (e: java.io.IOException) {
        if (cancelled.contains(id)) { onProgress(id, got, total, "cancelled", null); return }
        if (e is PolicyException) throw IllegalStateException(e.message)
        attempt++
        if (attempt > 20) throw e
        Log.w(TAG, "download $id: ${e.message}; retry $attempt")
        onProgress(id, got, total, "retrying", e.message)
        Thread.sleep((2000L * attempt).coerceAtMost(30_000))
        got = part.length()
      } finally {
        conn.disconnect()
      }
    }

    if (total > 0 && part.length() != total) throw IllegalStateException("size mismatch: ${part.length()} of $total")
    if (sha256 != null) {
      onProgress(id, got, total, "checking", null)
      val actual = sha256Of(part)
      if (actual != sha256) {
        part.delete()
        throw IllegalStateException("checksum mismatch (got ${actual.take(12)}…)")
      }
    }
    if (!part.renameTo(dest)) throw IllegalStateException("could not move the file into place")
    onProgress(id, dest.length(), dest.length(), "done", null)
  }

  /** A url the policy refuses: not retried. */
  private class PolicyException(msg: String) : java.io.IOException(msg)

  /**
   * Opens [url] following at most [UrlPolicy.MAX_REDIRECTS] redirects by hand, so each hop
   * passes the policy and the resolved address is checked: HttpURLConnection would follow a
   * 302 into the lan on its own.
   */
  private fun open(url: String, got: Long): HttpURLConnection {
    var at = url
    for (hop in 0..UrlPolicy.MAX_REDIRECTS) {
      UrlPolicy.problem(at)?.let { throw PolicyException(it) }
      val u = URL(at)
      val resolved = runCatching { java.net.InetAddress.getAllByName(u.host) }.getOrElse { throw java.io.IOException("cannot resolve ${u.host}") }
      if (resolved.any { UrlPolicy.isPrivateAddress(it) }) throw PolicyException("${u.host} resolves to a private address")
      val conn = (u.openConnection() as HttpURLConnection).apply {
        connectTimeout = 20_000
        readTimeout = 60_000
        instanceFollowRedirects = false
        setRequestProperty("User-Agent", "kula-decentralized-ai")
        if (got > 0) setRequestProperty("Range", "bytes=$got-")
      }
      val code = conn.responseCode
      if (code !in 300..399) return conn
      val location = conn.getHeaderField("Location") ?: return conn
      conn.disconnect()
      if (hop == UrlPolicy.MAX_REDIRECTS) throw PolicyException("too many redirects")
      at = runCatching { u.toURI().resolve(location).toString() }.getOrElse { throw PolicyException("bad redirect") }
    }
    throw PolicyException("too many redirects")
  }

  companion object {
    private const val TAG = "kula-download"
    fun sha256Of(file: File): String {
      val md = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { inp ->
        val buf = ByteArray(1024 * 1024)
        while (true) { val n = inp.read(buf); if (n < 0) break; md.update(buf, 0, n) }
      }
      return md.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
