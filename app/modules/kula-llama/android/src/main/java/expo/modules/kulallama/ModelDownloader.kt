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
    onProgress(id, got, total, "running", null)

    var attempt = 0
    while (true) {
      if (cancelled.contains(id)) { onProgress(id, got, total, "cancelled", null); return }
      val conn = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 20_000
        readTimeout = 60_000
        instanceFollowRedirects = true
        setRequestProperty("User-Agent", "kula-decentralized-ai")
        if (got > 0) setRequestProperty("Range", "bytes=$got-")
      }
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
        if (total > 0) {
          val free = (dest.parentFile ?: dest).usableSpace
          if (free < total - got + 64L * 1024 * 1024) throw IllegalStateException("not enough free space")
        }
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
              val now = System.currentTimeMillis()
              if (now - lastReport > 250) { lastReport = now; onProgress(id, got, total, "running", null) }
            }
          }
        }
        break
      } catch (e: java.io.IOException) {
        if (cancelled.contains(id)) { onProgress(id, got, total, "cancelled", null); return }
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
