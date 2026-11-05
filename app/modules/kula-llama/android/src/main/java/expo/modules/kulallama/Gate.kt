package expo.modules.kulallama

import android.util.Log
import expo.modules.kulallama.audit.Auditor
import expo.modules.kulallama.audit.Checks
import expo.modules.kulallama.audit.ReplayRing
import expo.modules.kulallama.audit.Verdict
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.SequenceInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * The gate: the one port a kula device opens on the network. ggml's RPC server has no
 * authentication and lets a client write memory, so it only ever listens on 127.0.0.1;
 * the gate sits in front and lets a connection through after a handshake. Two protocols
 * live on the same port; the server tells them apart by the first byte (a TLS ClientHello
 * starts with 0x16, a v1 hello with 'K'). docs/GATE.md is the full description.
 *
 * Protocol v1 (plain text lines, then a plain pipe; the secret travels in the v2 qr):
 *   C: "KULA1 <channel> <nonce_c> [<unix_ms>]"   channel: rpc | api; nonces are 16 bytes hex
 *   S: "<nonce_s>"
 *   C: "<hmac_c>"                           HMAC-SHA256(secret, nonce_c|nonce_s|channel)
 *   S: "OK <hmac_s>"                        HMAC-SHA256(secret, nonce_s|nonce_c|channel), or "NO <why>"
 *
 * Protocol v2 (TLS 1.3 with both sides' self-signed certificates, then the lines inside it;
 * the v3 qr carries the worker's certificate fingerprint "fp" and a one-time pairing code "pin"):
 *   C: "KULA2 <channel> <nonce_c> <unix_ms>"
 *   S: "<nonce_s> paired" | "<nonce_s> pin" | "NO <why>"
 *   C: "<proof_c>"                          pin: HMAC-SHA256(pin, nonce_c|nonce_s|channel|fp_s|fp_c); paired: "-"
 *   S: "OK <proof_s>"                       pin: HMAC-SHA256(pin, nonce_s|nonce_c|channel|fp_s|fp_c); paired: "OK -"
 * The client pins fp_s from the qr; the server pins fp_c once the pin proof passed (two-way
 * TOFU) and the pin is spent. After that only the certificates speak; there is no secret.
 *
 * With an [Auditor] the server also checks the hello (a replayed nonce or a clock more than
 * two minutes off is refused) and writes connect/reject/pair/end to the signed ledger. v2
 * makes both checks even without an auditor. The Node side is node/src/gate.ts; both are
 * checked against tools/gate-vectors.json.
 */
object Gate {
  private const val TAG = "kula-gate"
  const val VERSION = "KULA1"
  const val VERSION2 = "KULA2"
  const val DEFAULT_PORT = 50551
  const val HANDSHAKE_MS = 5000
  private val random = SecureRandom()
  private val NONCE = Regex("[0-9a-f]{32}")

  fun newSecret(): String = randomHex(32)
  /** The one-time pairing code shown in the v3 qr: 16 hex characters. */
  fun newPin(): String = randomHex(8)
  fun randomHex(bytes: Int): String = ByteArray(bytes).also { random.nextBytes(it) }.toHex()

  fun hmac(secret: String, vararg parts: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(parts.joinToString("|").toByteArray(Charsets.UTF_8)).toHex()
  }

  /** v2 pairing proofs, both ways; fp_s is the worker's fingerprint, fp_c the client's. */
  fun pinProofClient(pin: String, nonceC: String, nonceS: String, channel: String, fpS: String, fpC: String) = hmac(pin, nonceC, nonceS, channel, fpS, fpC)
  fun pinProofServer(pin: String, nonceC: String, nonceS: String, channel: String, fpS: String, fpC: String) = hmac(pin, nonceS, nonceC, channel, fpS, fpC)

  fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
  private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
  private fun constantEquals(a: String, b: String): Boolean {
    if (a.length != b.length) return false
    var r = 0
    for (i in a.indices) r = r or (a[i].code xor b[i].code)
    return r == 0
  }

  /** What the gate knows per connection; the server's `onEvent` sees these (the ledger). [fp] is the client's certificate in v2. */
  data class Event(val kind: String, val peer: String, val channel: String?, val why: String? = null, val fp: String? = null, val v: Int = 1)

  /** The worker's side of v2: its identity, the clients it already trusts, and the current pairing code (null: none open). */
  class TlsServer(val identity: GateIdentity, val paired: Paired, pin: String?, private val onPinUsed: () -> Unit = {}) {
    @Volatile var pin: String? = pin
    internal fun spend() { pin = null; onPinUsed() }
  }

  /** The master's side of v2: its identity, the worker's pinned fingerprint from the qr and, until paired, the pairing code. */
  class TlsClient(val identity: GateIdentity, val fp: String, val pin: String? = null)

  // --- server (worker side) ------------------------------------------------------------

  class Server(
    private val port: Int,
    private val secret: String,
    /** channel -> local port to pipe to (rpc: ggml's server, api: ApiServer). null = closed */
    private val targets: (String) -> Int?,
    private val auditor: Auditor? = null,
    private val tls: TlsServer? = null,
    private val onEvent: (Event) -> Unit = {},
  ) {
    @Volatile private var running = false
    private var listener: ServerSocket? = null
    private val connected = java.util.concurrent.atomic.AtomicInteger(0)
    private val ring = ReplayRing()
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
      Log.i(TAG, "gate listening on $port" + (tls?.let { " (v1 + v2 tls, fp ${it.identity.fp.take(16)})" } ?: " (v1)"))
    }

    fun stop() {
      running = false
      runCatching { listener?.close() }
    }

    private fun handle(raw: Socket) {
      val peer = (raw.inetAddress?.hostAddress ?: "?")
      try {
        raw.soTimeout = HANDSHAKE_MS
        raw.tcpNoDelay = true
        // the first byte picks the protocol: 0x16 is a TLS record (ClientHello), v1 says "KULA1"
        val first = raw.getInputStream().read()
        if (first < 0) return refuse(raw, raw.getOutputStream(), peer, null, "no hello")
        if (first == 0x16) {
          val t = tls ?: return refuse(raw, raw.getOutputStream(), peer, null, "no tls")
          return handleTls(raw, peer, t, ByteArrayInputStream(byteArrayOf(first.toByte())))
        }
        handlePlain(raw, peer, SequenceInputStream(ByteArrayInputStream(byteArrayOf(first.toByte())), raw.getInputStream()))
      } catch (e: Exception) {
        Log.w(TAG, "gate connection from $peer: ${e.message}")
        runCatching { raw.close() }
      }
    }

    private fun handlePlain(s: Socket, peer: String, inp: InputStream) {
      val out = s.getOutputStream()
      val hello = readLine(inp)
      val p = hello.trim().split(' ')
      if ((p.size != 3 && p.size != 4) || p[0] != VERSION) return refuse(s, out, peer, null, "bad hello")
      val channel = p[1]
      val nonceC = p[2]
      if (channel != "rpc" && channel != "api") return refuse(s, out, peer, channel, "bad channel")
      if (!nonceC.matches(NONCE)) return refuse(s, out, peer, channel, "bad nonce")
      val clientMs = if (p.size == 4) (p[3].toLongOrNull() ?: return refuse(s, out, peer, channel, "bad hello")) else null
      // an auditor that throws must not take the gate down; its verdicts do refuse
      val verdict = runCatching { auditor?.onHello(peer, nonceC, clientMs) }.onFailure { Log.w(TAG, "auditor hello: ${it.message}") }.getOrNull()
      if (verdict != null && !verdict.ok) return refuse(s, out, peer, channel, verdict.reason ?: "audit")
      val nonceS = randomHex(16)
      out.write("$nonceS\n".toByteArray()); out.flush()
      val proof = readLine(inp).trim()
      if (proof.isEmpty()) return refuse(s, out, peer, channel, "no proof")
      if (!constantEquals(proof, hmac(secret, nonceC, nonceS, channel))) return refuse(s, out, peer, channel, "wrong secret")
      admit(s, inp, out, peer, channel, "OK ${hmac(secret, nonceS, nonceC, channel)}", 1, null)
    }

    private fun handleTls(raw: Socket, peer: String, t: TlsServer, consumed: InputStream) {
      val ctx = SSLContext.getInstance("TLS")
      ctx.init(t.identity.keyManagers(), arrayOf(AnyClientTrust), null)
      val ssl = ctx.socketFactory.createSocket(raw, consumed, true) as SSLSocket
      ssl.useClientMode = false
      ssl.enabledProtocols = arrayOf("TLSv1.3")
      ssl.wantClientAuth = true
      try { ssl.startHandshake() } catch (e: Exception) {
        Log.w(TAG, "tls from $peer: ${e.message}")
        onEvent(Event("reject", peer, null, "tls", null, 2)); audit { it.onReject(peer, null, "tls") }
        runCatching { ssl.close() }
        return
      }
      val fpC = runCatching { GateCert.fingerprint(ssl.session.peerCertificates[0]) }.getOrNull()
      val inp = ssl.getInputStream()
      val out = ssl.getOutputStream()
      val refuse2 = { channel: String?, why: String -> refuse(ssl, out, peer, channel, why, fpC, 2) }
      val hello = readLine(inp)
      val p = hello.trim().split(' ')
      if (p.size != 4 || p[0] != VERSION2) return refuse2(null, "bad hello")
      val channel = p[1]
      val nonceC = p[2]
      if (channel != "rpc" && channel != "api") return refuse2(channel, "bad channel")
      if (!nonceC.matches(NONCE)) return refuse2(channel, "bad nonce")
      val clientMs = p[3].toLongOrNull() ?: return refuse2(channel, "bad hello")
      val verdict: Verdict = runCatching { auditor?.onHello(peer, nonceC, clientMs) }.onFailure { Log.w(TAG, "auditor hello: ${it.message}") }.getOrNull() ?: run {
        Checks.replay(ring, nonceC, peer).takeIf { !it.ok } ?: Checks.clock(clientMs, System.currentTimeMillis())
      }
      if (!verdict.ok) return refuse2(channel, verdict.reason ?: "audit")
      if (fpC == null) return refuse2(channel, "no client cert")
      val paired = t.paired.contains(fpC)
      val pin = t.pin
      if (!paired && pin == null) return refuse2(channel, "not paired")
      val nonceS = randomHex(16)
      out.write("$nonceS ${if (paired) "paired" else "pin"}\n".toByteArray()); out.flush()
      val proof = readLine(inp).trim()
      if (proof.isEmpty()) return refuse2(channel, "no proof")
      val fpS = t.identity.fp
      val reply: String
      if (paired) {
        if (proof != "-") return refuse2(channel, "bad proof")
        reply = "OK -"
      } else {
        val code = pin!!
        if (!constantEquals(proof, pinProofClient(code, nonceC, nonceS, channel, fpS, fpC))) return refuse2(channel, "wrong pin")
        // the first connection with the right code pairs the client and spends the code
        t.paired.add(fpC)
        t.spend()
        onEvent(Event("pair", peer, channel, null, fpC, 2))
        audit { it.onPair(peer, linkedMapOf("fp" to fpC, "channel" to channel)) }
        reply = "OK ${pinProofServer(code, nonceC, nonceS, channel, fpS, fpC)}"
      }
      admit(ssl, inp, out, peer, channel, reply, 2, fpC)
    }

    /** The proof passed: find the target, say OK and pipe until either side closes. */
    private fun admit(s: Socket, inp: InputStream, out: OutputStream, peer: String, channel: String, okLine: String, v: Int, fp: String?) {
      val target = targets(channel) ?: return refuse(s, out, peer, channel, "channel closed", fp, v)
      // one master at a time on the rpc channel
      if (channel == "rpc" && currentPeer != null && currentPeer != peer) return refuse(s, out, peer, channel, "busy", fp, v)
      val local = try { Socket("127.0.0.1", target) } catch (e: Exception) { return refuse(s, out, peer, channel, "target down", fp, v) }
      out.write("$okLine\n".toByteArray()); out.flush()
      s.soTimeout = 0
      onEvent(Event("connect", peer, channel, null, fp, v))
      audit { it.onConnect(peer, channel) }
      val started = System.currentTimeMillis()
      if (channel == "rpc") { currentPeer = peer; connected.incrementAndGet() }
      val bytes = pipe(s, inp, local, ByteArray(0))
      if (channel == "rpc" && connected.decrementAndGet() == 0) currentPeer = null
      onEvent(Event("end", peer, channel, null, fp, v))
      audit { it.onEnd(peer, channel, bytes, (System.currentTimeMillis() - started) / 1000) }
    }

    private fun refuse(s: Socket, out: OutputStream, peer: String, channel: String?, why: String, fp: String? = null, v: Int = 1) {
      Log.w(TAG, "refused $peer ($channel, v$v): $why")
      onEvent(Event("reject", peer, channel, why, fp, v))
      // the answer first, then the record: a ledger that cannot be written must not leave
      // the client hanging without its NO
      runCatching { out.write("NO $why\n".toByteArray()); out.flush() }
      runCatching { s.close() }
      audit { it.onReject(peer, channel, why) }
    }

    /** Runs an auditor hook; a failure (disk full, directory gone) is logged and never breaks the connection. */
    private fun audit(block: (Auditor) -> Unit) {
      val a = auditor ?: return
      runCatching { block(a) }.onFailure { Log.w(TAG, "auditor: ${it.message}") }
    }
  }

  /** The server's view of client certificates: TLS accepts any, the gate decides by fingerprint afterwards. */
  private object AnyClientTrust : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  /** The client's view of the server: exactly the certificate whose fingerprint the qr gave. */
  class PinnedTrust(private val fp: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      if (chain.isEmpty() || !constantEquals(GateCert.fingerprint(chain[0]), fp)) throw CertificateException(FP_MISMATCH)
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }
  const val FP_MISMATCH = "fingerprint mismatch"

  // --- client (master side) --------------------------------------------------------------

  /**
   * Performs the handshake on an open socket and returns the socket to use from then on:
   * [s] itself for v1, the TLS socket over it for v2 ([tls] given). Throws with the gate's
   * reason when refused ("gate: NO wrong pin"), "gate: fingerprint mismatch" when the
   * worker's certificate is not the pinned one.
   */
  fun handshake(s: Socket, secret: String, channel: String, tls: TlsClient? = null): Socket {
    s.soTimeout = HANDSHAKE_MS
    s.tcpNoDelay = true
    if (tls == null) {
      val out = s.getOutputStream()
      val inp = s.getInputStream()
      val nonceC = randomHex(16)
      out.write("$VERSION $channel $nonceC\n".toByteArray()); out.flush()
      val nonceS = readLine(inp)
      if (nonceS.startsWith("NO ")) throw IllegalStateException("gate: $nonceS")
      if (!nonceS.matches(NONCE)) throw IllegalStateException("gate: bad nonce (${nonceS.take(40)})")
      out.write("${hmac(secret, nonceC, nonceS, channel)}\n".toByteArray()); out.flush()
      val reply = readLine(inp)
      if (!reply.startsWith("OK ")) throw IllegalStateException("gate: ${reply.ifEmpty { "closed" }}")
      if (!constantEquals(reply.substring(3).trim(), hmac(secret, nonceS, nonceC, channel))) throw IllegalStateException("gate: server proof wrong")
      s.soTimeout = 0
      return s
    }
    val ssl = wrapClient(s, tls)
    val out = ssl.getOutputStream()
    val inp = ssl.getInputStream()
    val nonceC = randomHex(16)
    out.write("$VERSION2 $channel $nonceC ${System.currentTimeMillis()}\n".toByteArray()); out.flush()
    val first = readLine(inp)
    if (first.startsWith("NO ")) throw IllegalStateException("gate: $first")
    val f = first.trim().split(' ')
    if (f.size != 2 || !f[0].matches(NONCE) || (f[1] != "paired" && f[1] != "pin")) throw IllegalStateException("gate: bad nonce (${first.take(40)})")
    val nonceS = f[0]
    val fpC = tls.identity.fp
    val pairing = f[1] == "pin"
    val pin = tls.pin
    if (pairing && pin == null) throw IllegalStateException("gate: NO not paired")
    val proof = if (pairing) pinProofClient(pin!!, nonceC, nonceS, channel, tls.fp, fpC) else "-"
    out.write("$proof\n".toByteArray()); out.flush()
    val reply = readLine(inp)
    if (!reply.startsWith("OK ")) throw IllegalStateException("gate: ${reply.ifEmpty { "closed" }}")
    if (pairing && !constantEquals(reply.substring(3).trim(), pinProofServer(pin!!, nonceC, nonceS, channel, tls.fp, fpC))) throw IllegalStateException("gate: server proof wrong")
    ssl.soTimeout = 0
    return ssl
  }

  /** TLS 1.3 over [s] with our certificate, trusting only the pinned fingerprint. No hostname check: peers are IPs. */
  private fun wrapClient(s: Socket, tls: TlsClient): SSLSocket {
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(tls.identity.keyManagers(), arrayOf(PinnedTrust(tls.fp)), null)
    val host = s.inetAddress?.hostAddress ?: "kula"
    val ssl = ctx.socketFactory.createSocket(s, host, s.port, true) as SSLSocket
    ssl.useClientMode = true
    ssl.enabledProtocols = arrayOf("TLSv1.3")
    try { ssl.startHandshake() } catch (e: Exception) {
      var c: Throwable? = e
      while (c != null) { if (c.message == FP_MISMATCH) throw IllegalStateException("gate: $FP_MISMATCH"); c = c.cause }
      throw IllegalStateException("gate: tls ${e.message}")
    }
    return ssl
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

  /** A 2 s TCP + handshake probe: can this peer be used right now? null when yes, else why not. */
  fun probe(host: String, port: Int, secret: String, channel: String = "rpc", timeoutMs: Int = 2000, tls: TlsClient? = null): String? =
    try {
      Socket().use { s ->
        s.connect(InetSocketAddress(host, port), timeoutMs)
        handshake(s, secret, channel, tls).close()
        null
      }
    } catch (e: Exception) { e.message ?: "unreachable" }

  /**
   * Local tunnel: llama.cpp connects to 127.0.0.1:<returned port>; each connection is
   * handshaken to the peer's gate and piped. One tunnel per peer; stop() closes it.
   */
  class Tunnel(private val host: String, private val port: Int, private val secret: String, private val channel: String = "rpc", private val tls: TlsClient? = null) {
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
              val raw = Socket()
              raw.connect(InetSocketAddress(host, port), 4000)
              val remote = handshake(raw, secret, channel, tls)
              pipe(local, local.getInputStream(), remote, ByteArray(0))
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

  /**
   * Bidirectional copy until either side closes; [aIn] is a's input (it may wrap bytes read
   * ahead), [aLeftover] is written to b first. A TLS socket cannot half-close, so when one
   * direction ends a TLS side is closed outright (close_notify) instead of shutdownOutput.
   * Returns bytes moved both ways.
   */
  private fun pipe(a: Socket, aIn: InputStream, b: Socket, aLeftover: ByteArray): Long {
    a.tcpNoDelay = true; b.tcpNoDelay = true
    val up = java.util.concurrent.atomic.AtomicLong(aLeftover.size.toLong())
    val t1 = thread(isDaemon = true) {
      try {
        val o = b.getOutputStream()
        if (aLeftover.isNotEmpty()) { o.write(aLeftover); o.flush() }
        copy(aIn, o, up)
      } catch (_: Exception) {}
      halfClose(b)
    }
    val down = java.util.concurrent.atomic.AtomicLong(0)
    try { copy(b.getInputStream(), a.getOutputStream(), down) } catch (_: Exception) {}
    halfClose(a)
    t1.join()
    runCatching { a.close() }; runCatching { b.close() }
    return up.get() + down.get()
  }

  private fun halfClose(s: Socket) {
    if (s is SSLSocket) runCatching { s.close() } else runCatching { s.shutdownOutput() }
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
