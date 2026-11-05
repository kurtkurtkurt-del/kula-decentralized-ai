package expo.modules.kulallama

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Both ends of a relayed connection (node/relay/ is the server between them; docs/RELAY.md).
 * The worker connects out to the relay and registers; for every stream the relay announces
 * it opens a second WebSocket and pipes it into the local gate on 127.0.0.1, so the gate
 * serves a far away master exactly as it serves one on the wi-fi: the TLS handshake of
 * protocol v2 runs inside the relayed bytes, end to end. The master connects out with the
 * six digit code and opens one relayed stream per gate connection; [RelaySocket] makes such
 * a stream look like a [Socket] so [Gate.handshake] and [Gate.pipe] need not know.
 *
 * Transport is OkHttp's WebSocket (React Native ships OkHttp). Messages, one JSON text
 * frame first, then binary only: see node/relay/src/server.ts.
 *
 * NOT TRIED ON A DEVICE YET (5.11.2026, written in the cloud without an emulator): the Node
 * twin node/src/relay.ts is tested end to end against the same server.
 */
object Relay {
  private const val TAG = "kula-relay"
  private const val HELLO_MS = 10_000L

  /** The relay to go through and the worker's code there. */
  data class Ref(val url: String, val code: String)

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  }

  /** "https://relay.example" pasted for a relay becomes "wss://relay.example". OkHttp wants http(s) for the request url. */
  fun httpUrl(url: String): String = url.trim().replace(Regex("^ws(s?)://", RegexOption.IGNORE_CASE), "http$1://")

  /** One WebSocket whose frames arrive on a queue: text frames as [String], binary as [ByteArray], the end as null. */
  internal class Ws(url: String) {
    val frames = LinkedBlockingQueue<Any?>()
    @Volatile var open = false
    @Volatile var closeReason: String? = null
    private val opened = CountDownLatch(1)
    val socket: WebSocket = client.newWebSocket(Request.Builder().url(httpUrl(url)).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) { open = true; opened.countDown() }
      override fun onMessage(webSocket: WebSocket, text: String) { frames.offer(text) }
      override fun onMessage(webSocket: WebSocket, bytes: ByteString) { frames.offer(bytes.toByteArray()) }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { closeReason = reason.ifEmpty { "closed $code" }; webSocket.close(1000, null) }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { open = false; closeReason = closeReason ?: reason.ifEmpty { "closed $code" }; frames.offer(END) }
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { open = false; closeReason = closeReason ?: (t.message ?: "failed"); opened.countDown(); frames.offer(END) }
    })

    fun awaitOpen(ms: Long) {
      if (!opened.await(ms, TimeUnit.MILLISECONDS) || !open) { socket.cancel(); throw IOException("relay: ${closeReason ?: "timeout"}") }
    }

    /** Sends one JSON frame and waits for the next text frame. */
    fun ask(msg: JSONObject, ms: Long): JSONObject {
      socket.send(msg.toString())
      val f = frames.poll(ms, TimeUnit.MILLISECONDS) ?: throw IOException("relay: no answer")
      if (f === END) throw IOException("relay: ${closeReason ?: "closed"}")
      if (f !is String) throw IOException("relay: binary before ready")
      return JSONObject(f)
    }

    fun close(reason: String = "bye") { runCatching { socket.close(1000, reason) } }
  }
  private val END = Any()

  private fun refusal(o: JSONObject): String = if (o.optString("t") == "error") o.optString("reason", "refused") else "unexpected $o"

  // --- worker side ----------------------------------------------------------------------

  /**
   * Registers with the relay and keeps registering after a drop (the phone's network
   * changes). [onCode] hears every code the relay issues (a new one every ten minutes).
   */
  class Worker(
    private val url: String,
    private val id: String,
    private val name: String,
    private val fp: String?,
    private val gatePort: Int,
    private val onCode: (String, Int) -> Unit = { _, _ -> },
    private val onMaster: (String) -> Unit = {},
    private val onError: (String) -> Unit = {},
  ) {
    @Volatile var code: String? = null
      private set
    private var token = ""
    private val closed = AtomicBoolean(false)
    private var control: Ws? = null

    fun start() {
      thread(name = "relay-worker", isDaemon = true) {
        var delay = 1000L
        while (!closed.get()) {
          try {
            run()
            delay = 1000L
          } catch (e: Exception) {
            Log.w(TAG, "worker: ${e.message}")
            onError(e.message ?: "relay failed")
          }
          code = null
          if (closed.get()) break
          Thread.sleep(delay)
          delay = (delay * 2).coerceAtMost(30_000L)
        }
      }
    }

    /** One registration: blocks until the control connection ends. */
    private fun run() {
      val ws = Ws(url)
      control = ws
      ws.awaitOpen(HELLO_MS)
      val hello = JSONObject().put("t", "register").put("id", id).put("name", name)
      if (fp != null) hello.put("fp", fp)
      val r = ws.ask(hello, HELLO_MS)
      if (r.optString("t") != "registered") { ws.close(); throw IOException("relay: ${refusal(r)}") }
      token = r.optString("token")
      code = r.optString("code")
      Log.i(TAG, "registered at $url, code $code")
      onCode(code!!, r.optInt("ttl_s", 600))
      while (true) {
        val f = ws.frames.take()
        if (f === END) throw IOException("relay: ${ws.closeReason ?: "connection lost"}")
        if (f !is String) continue
        val m = runCatching { JSONObject(f) }.getOrNull() ?: continue
        when (m.optString("t")) {
          "open" -> { val sid = m.optInt("sid"); thread(name = "relay-stream-$sid", isDaemon = true) { accept(sid) } }
          "code" -> { code = m.optString("code"); Log.i(TAG, "new code $code"); onCode(code!!, m.optInt("ttl_s", 600)) }
          "master" -> onMaster(m.optString("state"))
        }
      }
    }

    /** A master wants a stream: open it, say which one, pipe it into the local gate. */
    private fun accept(sid: Int) {
      var ws: Ws? = null
      var local: Socket? = null
      try {
        ws = Ws(url)
        ws.awaitOpen(HELLO_MS)
        val r = ws.ask(JSONObject().put("t", "accept").put("sid", sid).put("token", token), HELLO_MS)
        if (r.optString("t") != "ready") throw IOException("relay: ${refusal(r)}")
        local = Socket("127.0.0.1", gatePort)
        pipe(ws, local)
      } catch (e: Exception) {
        Log.w(TAG, "stream $sid: ${e.message}")
        ws?.close("error")
        runCatching { local?.close() }
      }
    }

    fun stop() {
      closed.set(true)
      control?.close()
    }
  }

  /** ws frames → socket, socket bytes → ws frames, until either side ends. */
  private fun pipe(ws: Ws, s: Socket) {
    s.tcpNoDelay = true
    val up = thread(isDaemon = true) {
      try {
        val buf = ByteArray(16 * 1024)
        val inp = s.getInputStream()
        while (true) {
          val n = inp.read(buf)
          if (n < 0) break
          ws.socket.send(buf.copyOf(n).toByteString())
          // backpressure: a slow far side must not swallow the phone's memory
          while (ws.socket.queueSize() > 4L * 1024 * 1024 && ws.open) Thread.sleep(10)
        }
      } catch (_: Exception) {}
      ws.close()
    }
    try {
      val out = s.getOutputStream()
      while (true) {
        val f = ws.frames.take()
        if (f === END) break
        if (f is ByteArray) { out.write(f); out.flush() }
      }
    } catch (_: Exception) {}
    runCatching { s.shutdownOutput() }
    up.join(2000)
    runCatching { s.close() }
  }

  // --- master side ----------------------------------------------------------------------

  /** One master session with a far away worker: the control connection that holds the code, and a stream per gate connection. */
  class Master private constructor(private val url: String, private val control: Ws, val session: String, val workerId: String, val workerName: String, val workerFp: String?) {
    val gone: Boolean get() = !control.open

    companion object {
      fun connect(url: String, code: String, ms: Long = HELLO_MS): Master {
        require(Regex("\\d{6}").matches(code)) { "a relay code is six digits" }
        val ws = Ws(url)
        ws.awaitOpen(ms)
        val r = try { ws.ask(JSONObject().put("t", "connect").put("code", code), ms) } catch (e: Exception) { ws.close(); throw e }
        if (r.optString("t") != "connected") { ws.close(); throw IllegalStateException("gate: NO ${refusal(r)}") }
        val w = r.optJSONObject("worker") ?: JSONObject()
        return Master(url, ws, r.optString("session"), w.optString("id"), w.optString("name"), w.optString("fp").ifEmpty { null })
      }
    }

    /** A relayed byte stream to the worker's gate, as a Socket, ready for [Gate.handshake]. */
    fun open(ms: Long = HELLO_MS): Socket {
      if (gone) throw IOException("relay: session ended")
      val ws = Ws(url)
      ws.awaitOpen(ms)
      val r = try { ws.ask(JSONObject().put("t", "stream").put("session", session), ms) } catch (e: Exception) { ws.close(); throw e }
      if (r.optString("t") != "ready") { ws.close(); throw IOException("relay: ${refusal(r)}") }
      return RelaySocket(ws)
    }

    fun close() = control.close()
  }

  /**
   * A [Socket] over a relayed WebSocket stream: what is written goes out as binary frames,
   * what arrives is read as a stream. TLS layers over it through SSLSocketFactory.createSocket
   * (socket, host, port, autoClose), which only uses the two streams and close().
   */
  internal class RelaySocket(private val ws: Ws) : Socket() {
    private val incoming = PipedInputStream(256 * 1024)
    private val feeder = PipedOutputStream(incoming)
    private val closed = AtomicBoolean(false)
    init {
      thread(name = "relay-socket-in", isDaemon = true) {
        try {
          while (true) {
            val f = ws.frames.take()
            if (f === END) break
            if (f is ByteArray) { feeder.write(f); feeder.flush() }
          }
        } catch (_: Exception) {}
        runCatching { feeder.close() }
      }
    }
    private val outgoing = object : OutputStream() {
      override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
      override fun write(b: ByteArray, off: Int, len: Int) {
        if (closed.get() || !ws.open) throw IOException("relay stream closed")
        ws.socket.send(b.toByteString(off, len))
        while (ws.socket.queueSize() > 4L * 1024 * 1024 && ws.open) Thread.sleep(10)
      }
    }
    override fun getInputStream(): InputStream = incoming
    override fun getOutputStream(): OutputStream = outgoing
    override fun isConnected() = true
    override fun isClosed() = closed.get()
    override fun getInetAddress(): java.net.InetAddress? = null
    override fun getPort() = 0
    override fun setTcpNoDelay(on: Boolean) {}
    override fun setSoTimeout(timeout: Int) {}
    override fun shutdownOutput() { ws.close("done") }
    override fun shutdownInput() {}
    override fun close() {
      if (!closed.compareAndSet(false, true)) return
      ws.close()
      runCatching { feeder.close() }
      runCatching { incoming.close() }
    }
  }
}
