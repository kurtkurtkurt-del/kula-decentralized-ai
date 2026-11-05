package expo.modules.kulallama

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * "Apart" mode on a worker: the worker runs the whole model itself and answers the master
 * over a small HTTP API behind the gate (127.0.0.1 only; the gate pipes the `api` channel).
 *
 *   GET  /status                       {loaded, model, sha256, tokensUsed, ctx, busy}
 *   POST /load  {url, sha256, size, name, ctx?}   downloads when missing, then loads; streams
 *                                      progress lines "data: {...}\n\n" and ends with {done:true}
 *   POST /chat  {messages:[{role,content}], maxTokens?, temperature?}   SSE: {t:"piece"} … {done, tokens, ms}
 *   POST /stop
 *   GET  /blob?mb=N                    N MB (1024²) of zeros, N capped at 64: the bench's tunnel
 *                                      speed test (app/src/bench, kula-node bench)
 *
 * The same routes are what kula-node serves on a computer (node/src/api.ts); its conformance
 * tests pin the bytes, this file follows them by hand (blobMb = bench/core.ts blobMb).
 */
class ApiServer(private val context: Context, private val modelsDir: File, private val threads: Int) {
  private var listener: ServerSocket? = null
  @Volatile private var running = false
  private val busy = AtomicBoolean(false)
  @Volatile private var loadedPath: String? = null
  @Volatile private var loadedSha: String? = null
  private val downloader = ModelDownloader { _, _, _, _, _ -> }

  val port: Int get() = listener?.localPort ?: 0

  fun start(): Int {
    listener = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
    running = true
    thread(name = "api-accept", isDaemon = true) {
      while (running) {
        val s = try { listener!!.accept() } catch (e: Exception) { break }
        thread(isDaemon = true) { runCatching { handle(s) }.onFailure { Log.w(TAG, "api: ${it.message}") }; runCatching { s.close() } }
      }
    }
    return port
  }

  fun stop() {
    running = false
    runCatching { listener?.close() }
  }

  private fun handle(s: Socket) {
    s.soTimeout = 30_000
    val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
    val out = s.getOutputStream()
    val request = reader.readLine() ?: return
    val parts = request.split(' ')
    if (parts.size < 2) return
    val method = parts[0]
    val path = parts[1]
    var length = 0
    while (true) {
      val h = reader.readLine() ?: break
      if (h.isEmpty()) break
      if (h.startsWith("Content-Length:", true)) length = h.substringAfter(':').trim().toInt()
    }
    val body = if (length > 0) { val buf = CharArray(length); var n = 0; while (n < length) { val r = reader.read(buf, n, length - n); if (r < 0) break; n += r }; String(buf, 0, n) } else ""
    val json = if (body.isNotBlank()) JSONObject(body) else JSONObject()
    s.soTimeout = 0
    when {
      method == "GET" && path == "/status" -> json(out, 200, status())
      method == "GET" && path.substringBefore('?') == "/blob" -> blob(out, path.substringAfter('?', ""))
      method == "POST" && path == "/stop" -> { Native.stop(); json(out, 200, JSONObject().put("ok", true)) }
      method == "POST" && path == "/load" -> load(out, json)
      method == "POST" && path == "/chat" -> chat(out, json)
      else -> json(out, 404, JSONObject().put("error", "no such route"))
    }
  }

  private fun status() = JSONObject()
    .put("loaded", Native.isLoaded())
    .put("model", loadedPath?.let { File(it).name })
    .put("sha256", loadedSha)
    .put("tokensUsed", Native.tokensUsed())
    .put("ctx", Native.contextSize())
    .put("busy", busy.get())
    .put("threads", threads)

  private fun load(out: OutputStream, req: JSONObject) {
    if (!busy.compareAndSet(false, true)) return json(out, 409, JSONObject().put("error", "busy"))
    try {
      sseHead(out)
      val url = req.optString("url")
      val sha = req.optString("sha256").ifEmpty { null }
      val size = req.optLong("size", 0)
      val name = req.optString("name").ifEmpty { url.substringAfterLast('/') }
      val ctx = req.optInt("ctx", 2048)
      val dest = File(modelsDir, name)
      if (!dest.exists()) {
        if (url.isEmpty()) return sse(out, JSONObject().put("error", "model missing and no url"))
        var failed: String? = null
        val done = java.util.concurrent.CountDownLatch(1)
        val dl = ModelDownloader { _, got, total, state, error ->
          sse(out, JSONObject().put("state", state).put("got", got).put("total", total).putOpt("error", error))
          if (state == "done") done.countDown()
          if (state == "error" || state == "cancelled") { failed = error ?: state; done.countDown() }
        }
        dl.start("load", url, dest, sha, size)
        done.await()
        if (failed != null) return sse(out, JSONObject().put("error", failed))
      } else if (sha != null && loadedSha != sha) {
        sse(out, JSONObject().put("state", "checking"))
        val actual = ModelDownloader.sha256Of(dest)
        if (actual != sha) { dest.delete(); return sse(out, JSONObject().put("error", "checksum mismatch; file deleted, load again")) }
      }
      if (loadedPath != dest.absolutePath) {
        if (Native.isLoaded()) Native.freeModel()
        sse(out, JSONObject().put("state", "loading"))
        val info = Native.loadModel(dest.absolutePath, threads, ctx, emptyArray(), FloatArray(0), 1f).split('\t')
        loadedPath = dest.absolutePath
        loadedSha = sha ?: ModelDownloader.sha256Of(dest)
        sse(out, JSONObject().put("done", true).put("layers", info[1].toInt()).put("ctx", info[2].toInt()).put("sha256", loadedSha))
      } else {
        sse(out, JSONObject().put("done", true).put("ctx", Native.contextSize()).put("sha256", loadedSha))
      }
    } catch (e: Exception) {
      runCatching { sse(out, JSONObject().put("error", e.message ?: "load failed")) }
    } finally {
      busy.set(false)
    }
  }

  private fun chat(out: OutputStream, req: JSONObject) {
    if (!Native.isLoaded()) return json(out, 409, JSONObject().put("error", "no model loaded"))
    if (!busy.compareAndSet(false, true)) return json(out, 409, JSONObject().put("error", "busy"))
    try {
      sseHead(out)
      val msgs: JSONArray = req.optJSONArray("messages") ?: JSONArray()
      val roles = Array(msgs.length()) { msgs.getJSONObject(it).optString("role", "user") }
      val contents = Array(msgs.length()) { msgs.getJSONObject(it).optString("content") }
      if (req.optBoolean("reset", false)) Native.clearContext()
      val prompt = Native.applyTemplate(roles, contents)
      val start = System.currentTimeMillis()
      var first = 0L
      var count = 0
      val n = Native.generate(
        prompt, req.optInt("maxTokens", 512), req.optDouble("temperature", 0.7).toFloat(),
        req.optDouble("topP", 0.95).toFloat(), req.optInt("topK", 40), req.optDouble("minP", 0.05).toFloat(),
        req.optDouble("repeatPenalty", 1.1).toFloat(), -1,
      ) { piece ->
        if (first == 0L) first = System.currentTimeMillis()
        count++
        sse(out, JSONObject().put("t", piece))
      }
      val ms = System.currentTimeMillis() - start
      sse(out, JSONObject().put("done", true).put("tokens", n).put("ms", ms).put("firstMs", if (first > 0) first - start else ms)
        .put("tps", if (n > 0 && ms > 0) n * 1000.0 / ms else 0.0))
    } catch (e: Exception) {
      runCatching { sse(out, JSONObject().put("error", e.message ?: "chat failed")) }
    } finally {
      busy.set(false)
    }
  }

  /** N MB of zeros, fixed length, no compression; does not take `busy` (no model involved). */
  private fun blob(out: OutputStream, query: String) {
    val q = query.split('&').firstOrNull { it.startsWith("mb=") }?.substringAfter('=')
    val mb = blobMb(q) ?: return json(out, 400, JSONObject().put("error", "need mb"))
    val total = mb.toLong() * 1024 * 1024
    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: $total\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
    val chunk = ByteArray(64 * 1024)
    var sent = 0L
    while (sent < total) {
      val n = minOf(chunk.size.toLong(), total - sent).toInt()
      out.write(chunk, 0, n)
      sent += n
    }
    out.flush()
  }

  private fun sseHead(out: OutputStream) {
    out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".toByteArray()); out.flush()
  }

  private fun sse(out: OutputStream, o: JSONObject) {
    out.write("data: $o\n\n".toByteArray(Charsets.UTF_8)); out.flush()
  }

  private fun json(out: OutputStream, code: Int, o: JSONObject) {
    val b = o.toString().toByteArray(Charsets.UTF_8)
    out.write("HTTP/1.1 $code ${if (code == 200) "OK" else "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray())
    out.write(b); out.flush()
  }

  companion object {
    private const val TAG = "kula-api"
    const val BLOB_MAX_MB = 64

    /** ?mb=… as the blob size: null unless digits only and ≥ 1; capped at BLOB_MAX_MB. */
    fun blobMb(q: String?): Int? {
      if (q.isNullOrEmpty() || !q.all { it in '0'..'9' }) return null
      val digits = q.trimStart('0')
      if (digits.isEmpty()) return null
      if (digits.length > 6) return BLOB_MAX_MB
      return minOf(digits.toInt(), BLOB_MAX_MB)
    }
  }
}
