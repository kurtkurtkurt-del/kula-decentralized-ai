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
 * v1 has no identity: once any master is paired over v2 the server answers every v1 hello
 * with "NO no v1" ([Server.v1Open]), until the paired list is empty again.
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
  /**
   * A handshake has this long in all, however its bytes trickle in: [HANDSHAKE_MS] is per read, so
   * without it a byte every 4 s would hold a slot for good (node/src/gate.ts HANDSHAKE_TOTAL_MS,
   * security review D4 #9). Past it the socket is closed.
   */
  const val HANDSHAKE_TOTAL_MS = 20_000L
  /** Connections allowed to sit in a handshake at once; the next is told "NO overloaded" and dropped. */
  const val MAX_HANDSHAKES = 32
  /**
   * A friend's device holding the rpc seat with no byte either way for this long gives it up to one
   * of the person's own devices that asks (security review D4 #10, the user's choice: 1 minute).
   */
  const val SEAT_IDLE_MS = 60_000L
  /** One thread for every server's handshake deadlines. */
  private val deadlines: java.util.concurrent.ScheduledThreadPoolExecutor by lazy {
    java.util.concurrent.ScheduledThreadPoolExecutor(1) { r -> Thread(r, "gate-deadline").apply { isDaemon = true } }
      .apply { removeOnCancelPolicy = true }
  }
  /** A pairing code lives this long after it was made; then "NO pin expired" and a fresh one. */
  const val PIN_TTL_MS = 10 * 60_000L
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

  /**
   * One-time codes beside the qr's own [TlsServer.pin] (node/src/join.ts OneTimeCodes): the
   * pair-back code of an anchor this phone joined (docs/ANCHOR.md "join"), open for that
   * anchor's certificate only. Each pairs one certificate and is spent; a used or run-out code
   * is remembered for 30 minutes, only to tell a late try why.
   */
  class ExtraCodes(private val now: () -> Long = System::currentTimeMillis) {
    private class Code(val exp: Long, val only: String?, val name: String?, val onUsed: (String) -> Unit)
    private val live = LinkedHashMap<String, Code>()
    private val gone = LinkedHashMap<String, Triple<String, Long, String?>>()

    /** [only]: the one certificate that may use it; [name]: kept with the pairing (the paired list's name). */
    @Synchronized fun add(pin: String, ttlMs: Long, only: String? = null, name: String? = null, onUsed: (String) -> Unit = {}) {
      val p = pin.lowercase()
      gone.remove(p)
      live[p] = Code(now() + ttlMs, only?.lowercase(), name, onUsed)
    }
    @Synchronized fun has(pin: String): Boolean { sweep(); return pin.lowercase() in live }
    @Synchronized fun drop(pin: String) { val p = pin.lowercase(); val c = live.remove(p) ?: return; gone[p] = Triple("pin expired", now() + GONE_MS, c.only) }
    private fun sweep() {
      val t = now()
      live.entries.removeAll { (p, c) -> (t > c.exp).also { if (it) gone[p] = Triple("pin expired", t + GONE_MS, c.only) } }
      gone.entries.removeAll { t > it.value.second }
    }
    /** The codes [fp] may prove now. */
    @Synchronized fun open(fp: String): List<String> { sweep(); val f = fp.lowercase(); return live.filter { it.value.only == null || it.value.only == f }.keys.toList() }
    /** The codes [fp] could have used a short while ago, and why they are gone. */
    @Synchronized fun recent(fp: String): List<Pair<String, String>> { sweep(); val f = fp.lowercase(); return gone.filter { it.value.third == null || it.value.third == f }.map { it.key to it.value.first } }
    /** A spent code: the name to pair under, and what to run once the certificate is in the paired list. */
    class Taken(val name: String?, val onUsed: (String) -> Unit)
    /** Spends [pin] for [fp]; null when it is no longer open (or not for this certificate). */
    @Synchronized fun take(pin: String, fp: String): Taken? {
      sweep()
      val p = pin.lowercase()
      val c = live[p] ?: return null
      if (c.only != null && c.only != fp.lowercase()) return null
      live.remove(p)
      gone[p] = Triple("pin used", now() + GONE_MS, c.only)
      return Taken(c.name, c.onUsed)
    }
    companion object { const val GONE_MS = 30 * 60_000L }
  }

  /** The worker's side of v2: its identity, the clients it already trusts, and the current pairing code (null: none open). */
  class TlsServer(val identity: GateIdentity, val paired: Paired, pin: String?, private val onPinUsed: () -> Unit = {}, pinExpiresAt: Long? = null) {
    /** Codes beside [pin]: an anchor's pair-back (docs/ANCHOR.md "join"). */
    val codes = ExtraCodes()
    @Volatile var pin: String? = pin
    /** When [pin] stops working (unix ms); null: no expiry (tests). The owner sets both together. */
    @Volatile var pinExpiresAt: Long? = pinExpiresAt
    /**
     * The only client certificate [pin] may pair (a computer added by scanning its QR, Hosts in
     * Auto.kt); null: any certificate that proves the pin. Any other client hears "not paired".
     */
    @Volatile var pinFor: String? = null
    /** Opens a pairing code (null closes it): all three together, so a half-set code never shows. */
    @Synchronized fun open(pin: String?, expiresAt: Long?, forFp: String?) { this.pin = null; pinFor = forFp; pinExpiresAt = expiresAt; this.pin = pin }
    internal fun spend() { pin = null; pinExpiresAt = null; pinFor = null; onPinUsed() }
    internal fun expired(now: Long): Boolean = pin != null && (pinExpiresAt?.let { now > it } ?: false)
  }

  /**
   * The master's side of v2: its identity, the worker's pinned fingerprint from the qr ("" to learn it,
   * see [PinnedTrust]) and, until paired, the pairing code. [fpPrefix]: while learning, the start
   * of the certificate the person typed (an anchor's typed invite, 16 hex or more); checked at TLS.
   */
  class TlsClient(val identity: GateIdentity, val fp: String, val pin: String? = null, val fpPrefix: String? = null)
  /** How much of a certificate a person must type to name it (node/src/gate.ts FP_PREFIX_MIN). */
  const val FP_PREFIX_MIN = 16

  /** The worker's certificate fingerprint behind a v2 socket [handshake] returned; null for v1. */
  fun peerFp(s: Socket): String? = (s as? SSLSocket)?.let { runCatching { GateCert.fingerprint(it.session.peerCertificates[0]) }.getOrNull() }

  // --- server (worker side) ------------------------------------------------------------

  class Server(
    private val port: Int,
    /** the v1 secret; null turns v1 off (a plain hello is told "NO no v1"), and so does any paired certificate */
    private val secret: String?,
    /** channel -> local port to pipe to (rpc: ggml's server, api: ApiServer). null = closed */
    private val targets: (String) -> Int?,
    private val auditor: Auditor? = null,
    private val tls: TlsServer? = null,
    /**
     * Is this paired client certificate a friend's device rather than the person's own? A friend's
     * rpc connection that passed no bytes for [SEAT_IDLE_MS] gives the seat up to an own device
     * (security review D4 #10). Default: every device is the person's own.
     */
    private val friend: (String) -> Boolean = { false },
    /** The clock for the idle seat (tests set it). */
    private val now: () -> Long = System::currentTimeMillis,
    private val onEvent: (Event) -> Unit = {},
  ) {
    @Volatile private var running = false
    private var listener: ServerSocket? = null
    private val slot = RpcSlot()
    /** An rpc connection that holds (part of) the seat, and when it last passed a byte either way. */
    private class Rpc(val key: String, val friend: Boolean, val s: Socket, @Volatile var last: Long) { @Volatile var local: Socket? = null }
    private val rpcs = java.util.concurrent.ConcurrentHashMap.newKeySet<Rpc>()

    /**
     * The seat is busy for [key]: an own device (v2, not a friend's) takes it when everything that
     * holds it is a friend's device whose connections all passed nothing for [SEAT_IDLE_MS]. The
     * friend's rpc connections are closed (its loaded model ends). Friend against friend and own
     * against own stay "busy".
     */
    private fun takeIdleSeat(key: String, peer: String, fp: String?): List<Rpc>? {
      if (fp == null || runCatching { friend(fp) }.getOrDefault(true)) return null
      synchronized(rpcs) {
        val held = rpcs.filter { it.key != key }
        val from = held.firstOrNull()?.key ?: return null
        val t = now()
        if (held.any { it.key != from || !it.friend || t - it.last < SEAT_IDLE_MS }) return null
        if (!slot.takeOver(from, key, peer)) return null
        rpcs.removeAll(held.toSet())
        return held
      }
    }
    private val inHandshake = java.util.concurrent.atomic.AtomicInteger(0)
    private val ring = ReplayRing()
    val currentPeer: String? get() = slot.peer
    /** Open pipes by the client certificate behind them (v2), so a removed device can be cut off at once. */
    private val live = java.util.concurrent.ConcurrentHashMap<Socket, Pair<String, Socket>>()

    /**
     * Closes every open connection of the client certificate [fp] (its access was just
     * removed); the pipes end, the ledger gets their `end` lines. Returns how many were closed.
     */
    fun drop(fp: String): Int {
      var n = 0
      for ((s, v) in live.entries.toList()) if (v.first == fp && live.remove(s) != null) {
        // the local leg first: the pipe's reader ends and closes the tls side itself
        runCatching { v.second.close() }; runCatching { s.close() }; n++
      }
      return n
    }

    /** Whether the server has v2 at all. */
    val tlsOn: Boolean get() = tls != null
    /** How many certificates are paired over v2. */
    val pairedCount: Int get() = tls?.paired?.size() ?: 0

    /**
     * Would a v1 hello be heard right now? Only with a secret and while nothing is paired:
     * v1 has no identity, so once one master paired over v2 the plain protocol is off for
     * everyone (docs/GATE.md). Before any pairing an old master with a v2 qr still works.
     */
    fun v1Open(): Boolean = secret != null && pairedCount == 0

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
      // a flood of half-open connections must not pin a thread and 5 s each: past the cap
      // the answer is immediate and the socket is gone
      if (inHandshake.incrementAndGet() > MAX_HANDSHAKES) {
        inHandshake.decrementAndGet()
        onEvent(Event("reject", peer, null, "overloaded"))
        runCatching { raw.getOutputStream().write("NO overloaded\n".toByteArray()); raw.getOutputStream().flush() }
        runCatching { raw.close() }
        return
      }
      val lock = Any()
      var counted = true
      // the whole handshake, not each read: past the deadline the socket is closed and the
      // handler's blocked read ends (a pipe that started has cancelled it)
      val deadline = deadlines.schedule(Runnable {
        synchronized(lock) { if (counted) { Log.w(TAG, "handshake from $peer took too long"); runCatching { raw.close() } } }
      }, HANDSHAKE_TOTAL_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
      val done = { synchronized(lock) { if (counted) { counted = false; inHandshake.decrementAndGet(); deadline.cancel(false) } } }
      try {
        handle(raw, peer, done)
      } finally { done() }
    }

    private fun handle(raw: Socket, peer: String, handshakeDone: () -> Unit) {
      try {
        raw.soTimeout = HANDSHAKE_MS
        raw.tcpNoDelay = true
        // the first byte picks the protocol: 0x16 is a TLS record (ClientHello), v1 says "KULA1"
        val first = raw.getInputStream().read()
        if (first < 0) return refuse(raw, raw.getOutputStream(), peer, null, "no hello")
        if (first == 0x16) {
          val t = tls ?: return refuse(raw, raw.getOutputStream(), peer, null, "no tls")
          return handleTls(raw, peer, t, ByteArrayInputStream(byteArrayOf(first.toByte())), handshakeDone)
        }
        handlePlain(raw, peer, SequenceInputStream(ByteArrayInputStream(byteArrayOf(first.toByte())), raw.getInputStream()), handshakeDone)
      } catch (e: Exception) {
        Log.w(TAG, "gate connection from $peer: ${e.message}")
        runCatching { raw.close() }
      }
    }

    private fun handlePlain(s: Socket, peer: String, inp: InputStream, handshakeDone: () -> Unit) {
      val out = s.getOutputStream()
      val secret = secret ?: return refuse(s, out, peer, null, "no v1")
      if (!v1Open()) return refuse(s, out, peer, null, "no v1")
      val hello = readLine(inp)
      if (hello.isEmpty()) return refuse(s, out, peer, null, "no hello")
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
      admit(s, inp, out, peer, channel, "OK ${hmac(secret, nonceS, nonceC, channel)}", 1, null, handshakeDone)
    }

    private fun handleTls(raw: Socket, peer: String, t: TlsServer, consumed: InputStream, handshakeDone: () -> Unit) {
      val ctx = SSLContext.getInstance("TLS")
      ctx.init(t.identity.keyManagers(), arrayOf(AnyClientTrust), null)
      // Android's SSLSocketFactory has no createSocket(socket, consumed, autoClose): the byte the
      // gate read to tell TLS from v1 goes back in front of the stream through a thin socket
      val ssl = ctx.socketFactory.createSocket(PrefixedSocket(raw, consumed), raw.inetAddress.hostAddress, raw.port, true) as SSLSocket
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
      // a phone is never an anchor (docs/ANCHOR.md): "anchor" is a bad channel here, as any other
      if (channel != "rpc" && channel != "api") return refuse2(channel, "bad channel")
      if (!nonceC.matches(NONCE)) return refuse2(channel, "bad nonce")
      val clientMs = p[3].toLongOrNull() ?: return refuse2(channel, "bad hello")
      val verdict: Verdict = runCatching { auditor?.onHello(peer, nonceC, clientMs) }.onFailure { Log.w(TAG, "auditor hello: ${it.message}") }.getOrNull() ?: run {
        Checks.replay(ring, nonceC, peer).takeIf { !it.ok } ?: Checks.clock(clientMs, System.currentTimeMillis())
      }
      if (!verdict.ok) return refuse2(channel, verdict.reason ?: "audit")
      if (fpC == null) return refuse2(channel, "no client cert")
      val paired = t.paired.contains(fpC)
      // the other one-time codes open for this certificate (an anchor's pair-back), and the ones
      // just used or run out, so a late try hears why (node/src/gate.ts does the same)
      val extra = if (paired) emptyList() else t.codes.open(fpC)
      val gone = if (paired) emptyList() else t.codes.recent(fpC)
      var pin = t.pin
      if (!paired && t.expired(System.currentTimeMillis())) {
        // spent by time: the next qr shows a new code
        t.spend()
        pin = null
        if (extra.isEmpty() && gone.isEmpty()) return refuse2(channel, "pin expired")
      }
      // a code made for one computer (its QR named the certificate) pairs that computer only
      val only = t.pinFor
      if (!paired && pin != null && only != null && !constantEquals(only, fpC)) pin = null
      if (!paired && pin == null && extra.isEmpty() && gone.isEmpty()) return refuse2(channel, "not paired")
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
        val proves = { c: String -> constantEquals(proof, pinProofClient(c, nonceC, nonceS, channel, fpS, fpC)) }
        val code = pin
        if (code != null && proves(code)) {
          // the first connection with the right code pairs the client and spends the code. Check and
          // spend in one step: a second handshake that waited with the same code (or a code that ran
          // out or was replaced meanwhile) is refused (security review 8C.2)
          val won = synchronized(t) {
            if (t.pin == code && !t.expired(System.currentTimeMillis())) { t.paired.add(fpC); t.spend(); true } else false
          }
          if (!won) return refuse2(channel, "pin used")
          reply = "OK ${pinProofServer(code, nonceC, nonceS, channel, fpS, fpC)}"
        } else {
          val hit = extra.firstOrNull(proves) ?: return refuse2(channel, gone.firstOrNull { proves(it.first) }?.second ?: "wrong pin")
          // single use as well: whoever took it first (it may have run out meanwhile)
          val taken = t.codes.take(hit, fpC) ?: return refuse2(channel, "pin used")
          t.paired.add(fpC, taken.name)
          runCatching { taken.onUsed(fpC) }.onFailure { Log.w(TAG, "code used: ${it.message}") }
          reply = "OK ${pinProofServer(hit, nonceC, nonceS, channel, fpS, fpC)}"
        }
        onEvent(Event("pair", peer, channel, null, fpC, 2))
        audit { it.onPair(peer, linkedMapOf("fp" to fpC, "channel" to channel)) }
      }
      admit(ssl, inp, out, peer, channel, reply, 2, fpC, handshakeDone)
    }

    /** The proof passed: find the target, say OK and pipe until either side closes. */
    private fun admit(s: Socket, inp: InputStream, out: OutputStream, peer: String, channel: String, okLine: String, v: Int, fp: String?, handshakeDone: () -> Unit) {
      val target = targets(channel) ?: return refuse(s, out, peer, channel, "channel closed", fp, v)
      // one master at a time on the rpc channel: the slot is taken under a lock before the
      // local connect, so two masters arriving together cannot both get it. It is held by the
      // client certificate (v2), not the address: every stream through an anchor or a relay
      // arrives from 127.0.0.1, and two far masters must not share it (docs/ANCHOR.md)
      val key = fp ?: peer
      var rpc: Rpc? = null
      if (channel == "rpc") {
        var taken: List<Rpc>? = null
        // registered under the same lock as the takeover's look, so a fresh connection is never taken as idle
        val seated = synchronized(rpcs) {
          val ok = slot.take(key, peer) || takeIdleSeat(key, peer, fp)?.also { taken = it } != null
          if (ok) rpc = Rpc(key, fp != null && runCatching { friend(fp) }.getOrDefault(true), s, now()).also { rpcs.add(it) }
          ok
        }
        if (!seated) return refuse(s, out, peer, channel, "busy", fp, v)
        taken?.let { held ->
          // the friend's rpc legs end: its pipes close, its loaded model with them
          for (r in held) { runCatching { r.local?.close() }; runCatching { r.s.close() } }
          Log.i(TAG, "rpc seat: ${key.take(16)}… (own) took it from ${held.first().key.take(16)}… (a friend's, idle ${SEAT_IDLE_MS / 1000} s)")
        }
      }
      val local = try { Socket("127.0.0.1", target) } catch (e: Exception) {
        if (channel == "rpc") { rpc?.let { rpcs.remove(it) }; slot.release(key) }
        return refuse(s, out, peer, channel, "target down", fp, v)
      }
      rpc?.local = local
      // the api server sees only 127.0.0.1: it learns which master sent a request from the
      // local port of this pipe (a /load may fetch from that master's own address). A relayed
      // stream arrives from 127.0.0.1 and is not recorded: its peer is the relay, not a master.
      val localPort = local.localPort
      val linked = channel == "api" && ApiPeers.put(localPort, peer)
      if (channel == "api") ApiPeers.openLeg(localPort)
      try {
        out.write("$okLine\n".toByteArray()); out.flush()
      } catch (e: Exception) {
        if (linked) ApiPeers.remove(localPort)
        if (channel == "api") ApiPeers.closeLeg(localPort)
        if (channel == "rpc") { rpc?.let { rpcs.remove(it) }; slot.release(key) }
        runCatching { local.close() }
        throw e
      }
      s.soTimeout = 0
      handshakeDone()
      onEvent(Event("connect", peer, channel, null, fp, v))
      audit { it.onConnect(peer, channel) }
      val started = System.currentTimeMillis()
      if (fp != null) {
        live[s] = fp to local
        // removed between the handshake and here: the drop() for it may already have run
        if (tls?.paired?.contains(fp) == false) drop(fp)
      }
      val seat = rpc
      // every chunk either way marks the rpc connection as in use (the idle seat, D4 #10)
      val onBytes: (() -> Unit)? = seat?.let { r -> { r.last = now() } }
      val bytes = try { pipe(s, inp, local, ByteArray(0), onBytes) } finally { if (linked) ApiPeers.remove(localPort); if (channel == "api") ApiPeers.closeLeg(localPort); live.remove(s); seat?.let { rpcs.remove(it) } }
      // a seat taken over meanwhile is the new holder's: this release does not count then
      if (channel == "rpc") slot.release(key)
      onEvent(Event("end", peer, channel, null, fp, v))
      audit { it.onEnd(peer, channel, bytes, (System.currentTimeMillis() - started) / 1000) }
    }

    private fun refuse(s: Socket, out: OutputStream, peer: String, channel: String?, why: String, fp: String? = null, v: Int = 1) {
      Log.w(TAG, "refused $peer ($channel, v$v): $why")
      onEvent(Event("reject", peer, channel, why, fp, v))
      // the record before the answer, so the ledger keeps the order the client saw; audit()
      // swallows a ledger that cannot be written, so the NO always goes out
      audit { it.onReject(peer, channel, why) }
      runCatching { out.write("NO $why\n".toByteArray()); out.flush() }
      // closing with unread input (the rest of a hello we did not read) makes TCP send a reset,
      // and the client would see "connection reset" instead of the reason: end our side first,
      // drain a little, then close
      runCatching { s.shutdownOutput() }
      runCatching {
        s.soTimeout = 200
        val inp = s.getInputStream(); val buf = ByteArray(512); var n = 0
        while (n < 4096) { val r = inp.read(buf); if (r < 0) break; n += r }
      }
      runCatching { s.close() }
    }

    /** Runs an auditor hook; a failure (disk full, directory gone) is logged and never breaks the connection. */
    private fun audit(block: (Auditor) -> Unit) {
      val a = auditor ?: return
      runCatching { block(a) }.onFailure { Log.w(TAG, "auditor: ${it.message}") }
    }
  }

  /** A connected socket with bytes already read from it put back in front of its input. */
  private class PrefixedSocket(private val raw: Socket, consumed: InputStream) : Socket() {
    private val input: InputStream = SequenceInputStream(consumed, raw.getInputStream())
    override fun getInputStream(): InputStream = input
    override fun getOutputStream(): OutputStream = raw.getOutputStream()
    override fun isConnected(): Boolean = raw.isConnected
    override fun isClosed(): Boolean = raw.isClosed
    override fun getInetAddress(): InetAddress? = raw.inetAddress
    override fun getPort(): Int = raw.port
    override fun getLocalAddress(): InetAddress = raw.localAddress
    override fun getLocalPort(): Int = raw.localPort
    override fun getRemoteSocketAddress(): java.net.SocketAddress? = raw.remoteSocketAddress
    override fun getLocalSocketAddress(): java.net.SocketAddress? = raw.localSocketAddress
    override fun setSoTimeout(timeout: Int) { raw.soTimeout = timeout }
    override fun getSoTimeout(): Int = raw.soTimeout
    override fun setTcpNoDelay(on: Boolean) { raw.tcpNoDelay = on }
    override fun getTcpNoDelay(): Boolean = raw.tcpNoDelay
    override fun shutdownInput() = raw.shutdownInput()
    override fun shutdownOutput() = raw.shutdownOutput()
    override fun isInputShutdown(): Boolean = raw.isInputShutdown
    override fun isOutputShutdown(): Boolean = raw.isOutputShutdown
    override fun close() = raw.close()
  }

  /** The server's view of client certificates: TLS accepts any, the gate decides by fingerprint afterwards. */
  private object AnyClientTrust : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  /**
   * The client's view of the server: exactly the certificate whose fingerprint the qr gave. An
   * empty [fp] means "learn it" (a peer added by a relay code alone): any certificate passes
   * here and the pin proof, which covers both fingerprints, decides afterwards; the caller
   * pins what [handshake] reports from then on.
   */
  class PinnedTrust(private val fp: String, private val prefix: String? = null) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      if (chain.isEmpty()) throw CertificateException(FP_MISMATCH)
      if (fp.isNotEmpty() && !constantEquals(GateCert.fingerprint(chain[0]), fp)) throw CertificateException(FP_MISMATCH)
      // learning with a typed certificate start (an anchor's typed invite): checked before any code is spent
      if (fp.isEmpty() && !prefix.isNullOrEmpty() && !GateCert.fingerprint(chain[0]).startsWith(prefix.lowercase())) throw CertificateException(FP_MISMATCH)
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
  fun handshake(s: Socket, secret: String, channel: String, tls: TlsClient? = null, seen: ((String) -> Unit)? = null): Socket {
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
    // the fingerprint the proofs cover: the pinned one, or the one just seen when learning
    val fpS = if (tls.fp.isNotEmpty()) tls.fp else (peerFp(ssl) ?: throw IllegalStateException("gate: $FP_MISMATCH"))
    // the certificate the gate showed, before its answer: a pairing that ends in "NO channel
    // closed" still paired, and the caller needs to know with whom (joining an anchor)
    seen?.invoke(fpS)
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
    // a learned certificate with nothing to prove it: refuse before trusting it (a typed start of
    // 16 hex or more, checked at TLS, is identity enough: node/src/gate.ts does the same)
    if (!pairing && tls.fp.isEmpty() && (tls.fpPrefix?.length ?: 0) < FP_PREFIX_MIN) throw IllegalStateException("gate: NO not paired")
    val proof = if (pairing) pinProofClient(pin!!, nonceC, nonceS, channel, fpS, fpC) else "-"
    out.write("$proof\n".toByteArray()); out.flush()
    val reply = readLine(inp)
    if (!reply.startsWith("OK ")) throw IllegalStateException("gate: ${reply.ifEmpty { "closed" }}")
    if (pairing && !constantEquals(reply.substring(3).trim(), pinProofServer(pin!!, nonceC, nonceS, channel, fpS, fpC))) throw IllegalStateException("gate: server proof wrong")
    ssl.soTimeout = 0
    return ssl
  }

  /** TLS 1.3 over [s] with our certificate, trusting only the pinned fingerprint. No hostname check: peers are IPs. */
  private fun wrapClient(s: Socket, tls: TlsClient): SSLSocket {
    val ctx = SSLContext.getInstance("TLS")
    ctx.init(tls.identity.keyManagers(), arrayOf(PinnedTrust(tls.fp, tls.fpPrefix)), null)
    val host = s.inetAddress?.hostAddress ?: "kula"
    val ssl = ctx.socketFactory.createSocket(s, host, if (s.port > 0) s.port else DEFAULT_PORT, true) as SSLSocket
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

  /**
   * A 2 s TCP + handshake probe: can this peer be used right now? null when yes, else why not.
   * With [relay] the probe goes through the relay (api channel only; split needs the lan) and
   * a learned certificate comes back as "ok <fp>" so the caller can pin it.
   */
  fun probe(host: String, port: Int, secret: String, channel: String = "rpc", timeoutMs: Int = 2000, tls: TlsClient? = null, relay: Relay.Ref? = null, anchor: Anchor.Ref? = null): String? {
    return try {
      if (anchor != null) {
        // through an anchor (docs/ANCHOR.md): a stream to the device's gate by its certificate,
        // then the same handshake inside, pinned end to end; both channels, split included
        val t = tls?.takeIf { it.fp.isNotEmpty() } ?: return "an anchor dials by certificate: this device has none pinned"
        val s = Anchor.dial(anchor, t.identity, t.fp, timeoutMs.coerceAtLeast(Anchor.ROAD_MS))
        try { handshake(s, secret, channel, t).close() } finally { runCatching { s.close() } }
        null
      } else if (relay != null) {
        if (channel != "api") return "remote: split mode needs the lan"
        val t = tls ?: return "a relayed peer needs tls"
        val m = Relay.Master.connect(relay.url, relay.code, timeoutMs.toLong().coerceAtLeast(8000))
        try {
          val s = m.open()
          val done = handshake(s, secret, channel, t)
          val fp = peerFp(done)
          done.close()
          if (t.fp.isEmpty() && fp != null) "ok $fp" else null
        } finally { m.close() }
      } else Socket().use { s ->
        s.connect(InetSocketAddress(host, port), timeoutMs)
        handshake(s, secret, channel, tls).close()
        null
      }
    } catch (e: Exception) { e.message ?: "unreachable" }
  }

  /**
   * Local tunnel: llama.cpp connects to 127.0.0.1:<returned port>; each connection is
   * handshaken to the peer's gate and piped. One tunnel per peer; stop() closes it.
   */
  class Tunnel(private val host: String, private val port: Int, private val secret: String, private val channel: String = "rpc", private var tls: TlsClient? = null, private val relay: Relay.Ref? = null, private val onFp: (String) -> Unit = {}, private val anchor: Anchor.Ref? = null) {
    private var listener: ServerSocket? = null
    @Volatile private var running = false
    private var master: Relay.Master? = null
    val localPort: Int get() = listener?.localPort ?: 0

    /**
     * The road to the gate: a tcp connection to an address (the wi-fi, or a direct internet
     * address), a stream through an anchor (by the pinned certificate), or a relayed stream.
     */
    private fun road(): Socket {
      if (anchor != null) {
        val t = tls?.takeIf { it.fp.isNotEmpty() } ?: throw IllegalStateException("an anchor dials by certificate: this device has none pinned")
        return Anchor.dial(anchor, t.identity, t.fp)
      }
      val r = relay ?: return Socket().also { it.connect(InetSocketAddress(host, port), 4000) }
      val m = master?.takeIf { !it.gone } ?: Relay.Master.connect(r.url, r.code).also { master = it }
      return m.open()
    }

    /**
     * The anchor's "too many dials" (a friend's device over its dial bucket) is a wait, not a
     * broken road: llama.cpp aborts on one refused connection, so the local leg is kept and the
     * dial tried again with backoff for up to a minute while that leg is alive (node's Tunnel
     * does the same, DECISIONS D2).
     */
    private fun roadWaiting(local: Socket): Socket {
      val until = System.currentTimeMillis() + Anchor.DIAL_WAIT_MS
      var delay = 500L
      while (true) {
        try { return road() } catch (e: Anchor.Refused) {
          if (e.reason != Anchor.TOO_MANY_DIALS || System.currentTimeMillis() + delay > until || local.isClosed || !running) throw e
          Thread.sleep(delay)
          delay = (delay * 2).coerceAtMost(8000L)
        }
      }
    }

    fun start(): Int {
      listener = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
      running = true
      thread(name = "gate-tunnel", isDaemon = true) {
        while (running) {
          val local = try { listener!!.accept() } catch (e: Exception) { break }
          thread(isDaemon = true) {
            try {
              val raw = roadWaiting(local)
              val remote = try { handshake(raw, secret, channel, tls) } catch (e: Exception) { runCatching { raw.close() }; throw e }
              // a learned certificate is pinned for every later connection, and the pin is spent
              peerFp(remote)?.let { fp -> val t = tls; if (t != null && (t.fp.isEmpty() || t.pin != null)) { tls = TlsClient(t.identity, fp, null); onFp(fp) } }
              pipe(local, local.getInputStream(), remote, ByteArray(0))
            } catch (e: Exception) {
              Log.w(TAG, "tunnel to ${anchor?.let { "${tls?.fp?.take(16)}… through anchor ${it.fp.take(16)}…" } ?: "$host:$port"}: ${e.message}")
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
      master?.close()
    }
  }

  /**
   * Bidirectional copy until either side closes; [aIn] is a's input (it may wrap bytes read
   * ahead), [aLeftover] is written to b first. A TLS socket cannot half-close, so when one
   * direction ends a TLS side is closed outright (close_notify) instead of shutdownOutput.
   * Returns bytes moved both ways. [onBytes] runs after every chunk, either way.
   */
  internal fun pipe(a: Socket, aIn: InputStream, b: Socket, aLeftover: ByteArray, onBytes: (() -> Unit)? = null): Long {
    a.tcpNoDelay = true; b.tcpNoDelay = true
    val up = java.util.concurrent.atomic.AtomicLong(aLeftover.size.toLong())
    val t1 = thread(isDaemon = true) {
      try {
        val o = b.getOutputStream()
        if (aLeftover.isNotEmpty()) { o.write(aLeftover); o.flush() }
        copy(aIn, o, up, onBytes)
      } catch (_: Exception) {}
      halfClose(b)
    }
    val down = java.util.concurrent.atomic.AtomicLong(0)
    try { copy(b.getInputStream(), a.getOutputStream(), down, onBytes) } catch (_: Exception) {}
    halfClose(a)
    t1.join()
    runCatching { a.close() }; runCatching { b.close() }
    return up.get() + down.get()
  }

  private fun halfClose(s: Socket) {
    if (s is SSLSocket) runCatching { s.close() } else runCatching { s.shutdownOutput() }
  }

  private fun copy(i: InputStream, o: OutputStream, count: java.util.concurrent.atomic.AtomicLong, onBytes: (() -> Unit)? = null) {
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = i.read(buf)
      if (n < 0) break
      o.write(buf, 0, n); o.flush()
      count.addAndGet(n.toLong())
      onBytes?.invoke()
    }
  }
}
