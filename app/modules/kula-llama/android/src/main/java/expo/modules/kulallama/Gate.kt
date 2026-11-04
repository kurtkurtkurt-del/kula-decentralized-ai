package expo.modules.kulallama

import android.util.Log
import expo.modules.kulallama.audit.Auditor
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/**
 * The gate: the one port a kula device opens on the network. ggml's RPC server has no
 * authentication and lets a client write memory, so it only ever listens on 127.0.0.1;
 * the gate sits in front and lets a connection through after a shared-secret handshake.
 * The secret is made at pairing time and travels only in the QR code.
 *
 * Protocol v1 (text lines, then a plain pipe):
 *   C: "KULA1 <channel> <nonce_c> [<unix_ms>]"   channel: rpc | api; nonces are 16 bytes hex;
 *                                           the optional 4th field (v1.1) is the client's clock
 *   S: "<nonce_s>"
 *   C: "<hmac_c>"                           HMAC-SHA256(secret, nonce_c|nonce_s|channel)
 *   S: "OK <hmac_s>"                        HMAC-SHA256(secret, nonce_s|nonce_c|channel), or "NO <why>"
 *
 * With an [Auditor] the server also checks the hello (a replayed nonce or a clock more than
 * two minutes off is refused) and writes connect/reject/end to the signed ledger.
 * In Part 3 (beyin/check) this becomes TLS with per-device keys; the shape stays.
 * The Node side of this is node/src/gate.ts; both are checked against tools/gate-vectors.json.
 */
object Gate {
  private const val TAG = "kula-gate"
  const val VERSION = "KULA1"
  const val DEFAULT_PORT = 50551
  private val random = SecureRandom()

  fun newSecret(): String = randomHex(32)
  fun randomHex(bytes: Int): String = ByteArray(bytes).also { random.nextBytes(it) }.toHex()

  fun hmac(secret: String, vararg parts: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(parts.joinToString("|").toByteArray(Charsets.UTF_8)).toHex()
  }

  fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
  private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
  private fun constantEquals(a: String, b: String): Boolean {
    if (a.length != b.length) return false
    var r = 0
    for (i in a.indices) r = r or (a[i].code xor b[i].code)
    return r == 0
  }

  /** What the gate knows per connection; the server's `onEvent` sees these (Part 3 ledger). */
  data class Event(val kind: String, val peer: String, val channel: String?, val why: String? = null)

  // --- server (worker side) ------------------------------------------------------------

  class Server(
    private val port: Int,
    private val secret: String,
    /** channel -> local port to pipe to (rpc: ggml's server, api: ApiServer). null = closed */
    private val targets: (String) -> Int?,
    private val auditor: Auditor? = null,
    private val onEvent: (Event) -> Unit = {},
  ) {
    @Volatile private var running = false
    private var listener: ServerSocket? = null
    private val connected = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile var currentPeer: String? = null
      private set

    fun start() {
      if (running) return
      running = true
      listener = ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress("0.0.0.0", port)) }
      thread(name = "gate-accept", isDaemon = true) {
        while (running) {
          val s = try { listener!!.accept() } catch (e: Exception) { break }
          thread(name = "gate-conn", isDaemon = true) { handle(s) }
        }
      }
      Log.i(TAG, "gate listening on $port")
    }

    fun stop() {
      running = false
      runCatching { listener?.close() }
    }

    private fun handle(s: Socket) {
      val peer = (s.inetAddress?.hostAddress ?: "?")
      try {
        s.soTimeout = 5000
        s.tcpNoDelay = true
        val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.US_ASCII))
        val out = s.getOutputStream()
        val hello = reader.readLine() ?: return refuse(s, out, peer, null, "no hello")
        val p = hello.trim().split(' ')
        if ((p.size != 3 && p.size != 4) || p[0] != VERSION) return refuse(s, out, peer, null, "bad hello")
        val channel = p[1]
        val nonceC = p[2]
        if (channel != "rpc" && channel != "api") return refuse(s, out, peer, channel, "bad channel")
        if (!nonceC.matches(Regex("[0-9a-f]{32}"))) return refuse(s, out, peer, channel, "bad nonce")
        val clientMs = if (p.size == 4) (p[3].toLongOrNull() ?: return refuse(s, out, peer, channel, "bad hello")) else null
        auditor?.onHello(peer, nonceC, clientMs)?.takeIf { !it.ok }?.let { return refuse(s, out, peer, channel, it.reason ?: "audit") }
        val nonceS = randomHex(16)
        out.write("$nonceS\n".toByteArray()); out.flush()
        val proof = reader.readLine()?.trim() ?: return refuse(s, out, peer, channel, "no proof")
        if (!constantEquals(proof, hmac(secret, nonceC, nonceS, channel))) return refuse(s, out, peer, channel, "wrong secret")
        val target = targets(channel) ?: return refuse(s, out, peer, channel, "channel closed")
        // one master at a time on the rpc channel
        if (channel == "rpc" && currentPeer != null && currentPeer != peer) return refuse(s, out, peer, channel, "busy")
        val local = try { Socket("127.0.0.1", target) } catch (e: Exception) { return refuse(s, out, peer, channel, "target down") }
        out.write("OK ${hmac(secret, nonceS, nonceC, channel)}\n".toByteArray()); out.flush()
        s.soTimeout = 0
        onEvent(Event("connect", peer, channel))
        auditor?.onConnect(peer, channel)
        val started = System.currentTimeMillis()
        if (channel == "rpc") { currentPeer = peer; connected.incrementAndGet() }
        // the reader may have buffered bytes after the proof line: hand them on first
        val bytes = pipe(s, local, readerLeftover(reader))
        if (channel == "rpc" && connected.decrementAndGet() == 0) currentPeer = null
        onEvent(Event("end", peer, channel))
        auditor?.onEnd(peer, channel, bytes, (System.currentTimeMillis() - started) / 1000)
      } catch (e: Exception) {
        Log.w(TAG, "gate connection from $peer: ${e.message}")
        runCatching { s.close() }
      }
    }

    private fun refuse(s: Socket, out: OutputStream, peer: String, channel: String?, why: String) {
      Log.w(TAG, "refused $peer ($channel): $why")
      onEvent(Event("reject", peer, channel, why))
      auditor?.onReject(peer, channel, why)
      runCatching { out.write("NO $why\n".toByteArray()); out.flush() }
      runCatching { s.close() }
    }

    private fun readerLeftover(reader: BufferedReader): ByteArray {
      // BufferedReader may have read past the proof line; drain what it holds (ready()).
      val sb = StringBuilder()
      while (reader.ready()) sb.append(reader.read().toChar())
      return sb.toString().toByteArray(Charsets.ISO_8859_1)
    }
  }

  // --- client (master side) --------------------------------------------------------------

  /** Performs the handshake on an open socket; throws with the gate's reason when refused. */
  fun handshake(s: Socket, secret: String, channel: String) {
    s.soTimeout = 5000
    s.tcpNoDelay = true
    val out = s.getOutputStream()
    val inp = s.getInputStream()
    val nonceC = randomHex(16)
    out.write("$VERSION $channel $nonceC\n".toByteArray()); out.flush()
    val nonceS = readLine(inp)
    if (!nonceS.matches(Regex("[0-9a-f]{32}"))) throw IllegalStateException("gate: bad nonce (${nonceS.take(40)})")
    out.write("${hmac(secret, nonceC, nonceS, channel)}\n".toByteArray()); out.flush()
    val reply = readLine(inp)
    if (!reply.startsWith("OK ")) throw IllegalStateException("gate: ${reply.ifEmpty { "closed" }}")
    if (!constantEquals(reply.substring(3).trim(), hmac(secret, nonceS, nonceC, channel))) throw IllegalStateException("gate: server proof wrong")
    s.soTimeout = 0
  }

  /** Reads one line byte by byte so nothing after it is swallowed. */
  private fun readLine(inp: InputStream): String {
    val sb = StringBuilder()
    while (true) {
      val b = inp.read()
      if (b < 0 || b == '\n'.code) break
      if (b != '\r'.code) sb.append(b.toChar())
      if (sb.length > 256) break
    }
    return sb.toString()
  }

  /** A 2 s TCP + handshake probe: can this peer be used right now? */
  fun probe(host: String, port: Int, secret: String, channel: String = "rpc", timeoutMs: Int = 2000): String? =
    try {
      Socket().use { s ->
        s.connect(InetSocketAddress(host, port), timeoutMs)
        handshake(s, secret, channel)
        null
      }
    } catch (e: Exception) { e.message ?: "unreachable" }

  /**
   * Local tunnel: llama.cpp connects to 127.0.0.1:<returned port>; each connection is
   * handshaken to the peer's gate and piped. One tunnel per peer; stop() closes it.
   */
  class Tunnel(private val host: String, private val port: Int, private val secret: String, private val channel: String = "rpc") {
    private var listener: ServerSocket? = null
    @Volatile private var running = false
    val localPort: Int get() = listener?.localPort ?: 0

    fun start(): Int {
      listener = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
      running = true
      thread(name = "gate-tunnel", isDaemon = true) {
        while (running) {
          val local = try { listener!!.accept() } catch (e: Exception) { break }
          thread(isDaemon = true) {
            try {
              val remote = Socket()
              remote.connect(InetSocketAddress(host, port), 4000)
              handshake(remote, secret, channel)
              pipe(local, remote, ByteArray(0))
            } catch (e: Exception) {
              Log.w(TAG, "tunnel to $host:$port: ${e.message}")
              runCatching { local.close() }
            }
          }
        }
      }
      return localPort
    }

    fun stop() {
      running = false
      runCatching { listener?.close() }
    }
  }

  /** Bidirectional copy until either side closes. [aLeftover] is written to b first. Returns bytes moved both ways. */
  private fun pipe(a: Socket, b: Socket, aLeftover: ByteArray): Long {
    a.tcpNoDelay = true; b.tcpNoDelay = true
    val up = java.util.concurrent.atomic.AtomicLong(aLeftover.size.toLong())
    val t1 = thread(isDaemon = true) {
      try {
        val o = b.getOutputStream()
        if (aLeftover.isNotEmpty()) { o.write(aLeftover); o.flush() }
        copy(a.getInputStream(), o, up)
      } catch (_: Exception) {}
      runCatching { b.shutdownOutput() }
    }
    val down = java.util.concurrent.atomic.AtomicLong(0)
    try { copy(b.getInputStream(), a.getOutputStream(), down) } catch (_: Exception) {}
    runCatching { a.shutdownOutput() }
    t1.join()
    runCatching { a.close() }; runCatching { b.close() }
    return up.get() + down.get()
  }

  private fun copy(i: InputStream, o: OutputStream, count: java.util.concurrent.atomic.AtomicLong) {
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = i.read(buf)
      if (n < 0) break
      o.write(buf, 0, n); o.flush()
      count.addAndGet(n.toLong())
    }
  }
}
