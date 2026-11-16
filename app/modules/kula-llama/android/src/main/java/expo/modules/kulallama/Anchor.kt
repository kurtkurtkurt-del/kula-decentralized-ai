package expo.modules.kulallama

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * The member's side of an anchor (docs/ANCHOR.md): a reachable circle computer whose gate carries
 * bytes between two devices that cannot reach each other. It is the gate's third channel,
 * `anchor`, inside the usual KULA2 handshake: the TLS client certificate is the proof, and after
 * `OK -` comes one JSON line:
 *
 *   control  → {t:"register", name, kind}   ← {t:"registered"}
 *            ← {t:"open", sid, from}         a member wants a stream to this phone: accept it
 *            → {t:"ping"}                    ← {t:"pong"}          (every 25 s)
 *            ← {t:"error", reason:"replaced"} the same certificate registered again: step back
 *   dialer   → {t:"dial", to:<64 hex fp>}    ← {t:"ready"} | {t:"error", reason}
 *   target   → {t:"accept", sid}             ← {t:"ready"} | {t:"error", reason}
 *
 * After "ready" the bytes are raw. A dialer runs a fresh gate handshake inside (TLS 1.3 between
 * the two devices' own certificates, pinned), so the anchor only ever carries TLS records: on the
 * phone as a master that is an SSLSocket over the SSLSocket to the anchor. An accepted stream is
 * piped into this phone's own gate on 127.0.0.1, which serves it as any other connection.
 *
 * The phone is never an anchor itself: its gate answers "bad channel" to `anchor` (Gate.kt).
 * The node twin is node/src/anchor.ts (joinAnchor, dialAnchor) and node/src/join.ts (the invite,
 * the pair-back, the store of joined anchors, AnchorLinks); the message set and the timings are
 * the same. Reuses the loop shape of Relay.Worker, not its WebSocket.
 */
object Anchor {
  private const val TAG = "kula-anchor"
  const val PING_MS = 25_000L
  /** How long the target has to accept a stream (the anchor's own limit). */
  const val ACCEPT_MS = 10_000
  /** A probe along an anchor road gets at least this long: two legs, two handshakes, an accept. */
  const val ROAD_MS = 8_000
  /** A tunnel waits this long for a friend's dial bucket to refill (Gate.Tunnel). */
  const val DIAL_WAIT_MS = 60_000L
  const val TOO_MANY_DIALS = "too many dials"
  /** The first reconnect wait after a lost control connection; doubles up to [MAX_RETRY_MS]. */
  const val FIRST_RETRY_MS = 1_000L
  const val MAX_RETRY_MS = 30_000L
  /**
   * At most this many of an anchor's `open`s are set up at once (from the open to the pipe), each a
   * TLS connection and a thread; more are ignored, so a dishonest anchor cannot exhaust the phone
   * (security review D4 #14; node/src/anchor.ts ANCHOR_ACCEPTS_IN_FLIGHT).
   */
  const val ACCEPTS_IN_FLIGHT = 32
  /** The "opens ignored" log line comes at most this often. */
  const val IGNORED_LOG_MS = 10_000L
  /** An invite and its pair-back code live as long as a pairing code (node/src/join.ts INVITE_TTL_MS). */
  const val INVITE_TTL_MS = Gate.PIN_TTL_MS
  /** At most this many anchors are kept (node/src/road.ts MAX_ANCHORS). */
  const val MAX_ANCHORS = 4
  /** A fifth anchor's refusal, in plain words. */
  const val FULL_WORDS = "this phone is in $MAX_ANCHORS anchors already, the most it keeps: forget one of them first, then use the invite again"
  private val FP = Regex("[0-9a-f]{64}")
  fun isFp(s: String) = FP.matches(s)

  /** Where an anchor is: its gate's address and its certificate (pinned: another certificate there is not the anchor). */
  data class Ref(val host: String, val port: Int, val fp: String)

  /** The anchor said no, with its reason ("not here", "too many dials", "replaced", ...). */
  class Refused(val reason: String) : IOException("anchor: $reason")

  // --- lines ----------------------------------------------------------------------------

  /** One line, byte by byte, so nothing after it is swallowed (the raw pipe follows). */
  internal fun readLine(inp: InputStream, max: Int = 4096): String? {
    val sb = StringBuilder()
    while (true) {
      val b = inp.read()
      if (b < 0) return if (sb.isEmpty()) null else sb.toString()
      if (b == '\n'.code) return sb.toString()
      if (b != '\r'.code) sb.append(b.toChar())
      if (sb.length > max) throw IOException("anchor: line too long")
    }
  }

  internal fun send(s: Socket, o: JSONObject) {
    val out = s.getOutputStream()
    synchronized(out) { out.write((o.toString() + "\n").toByteArray()); out.flush() }
  }

  private fun ask(s: Socket, o: JSONObject, timeoutMs: Int): JSONObject {
    send(s, o)
    s.soTimeout = timeoutMs
    val line = readLine(s.getInputStream()) ?: throw IOException("anchor: closed")
    return runCatching { JSONObject(line) }.getOrElse { throw IOException("anchor: bad answer ${line.take(60)}") }
  }

  private fun reasonOf(o: JSONObject): String = if (o.optString("t") == "error") o.optString("reason", "refused") else "unexpected ${o.toString().take(80)}"

  /** The anchor channel's handshake at the anchor's own address (never through another anchor). */
  internal fun open(ref: Ref, identity: GateIdentity, timeoutMs: Int): Socket {
    val raw = Socket()
    try {
      raw.connect(InetSocketAddress(ref.host, ref.port), timeoutMs)
      // no idle cut on anchor legs (an rpc stream sits idle between chats): tcp keepalive finds dead ones
      raw.keepAlive = true
      return Gate.handshake(raw, "", "anchor", Gate.TlsClient(identity, ref.fp))
    } catch (e: Exception) {
      runCatching { raw.close() }
      throw e
    }
  }

  /**
   * A stream to the member [to] (its full certificate fingerprint) through the anchor, piped into
   * that member's gate: the caller runs the gate handshake on it, so the target's own gate decides
   * and pins. A refusal throws [Refused] with the anchor's reason.
   */
  fun dial(ref: Ref, identity: GateIdentity, to: String, timeoutMs: Int = Gate.HANDSHAKE_MS + ACCEPT_MS): Socket {
    val s = open(ref, identity, timeoutMs.coerceAtMost(Gate.HANDSHAKE_MS))
    try {
      val r = ask(s, JSONObject().put("t", "dial").put("to", to.lowercase()), timeoutMs)
      if (r.optString("t") != "ready") throw Refused(reasonOf(r))
      s.soTimeout = 0
      return s
    } catch (e: Exception) {
      runCatching { s.close() }
      throw e
    }
  }

  // --- one control connection --------------------------------------------------------------

  enum class State { REGISTERING, REGISTERED, LOST, REPLACED, REFUSED }

  /**
   * Registers this phone with one anchor and keeps the control connection: a ping every 25 s, a
   * reconnect with backoff (1 s doubling to 30 s) when it is lost, along the anchor's addresses
   * in turn. A second register from this certificate elsewhere replaces this one: it stops then
   * instead of fighting back. [kick] reconnects at once (the network changed). A stream the
   * anchor opens for this phone is accepted and piped into the gate at 127.0.0.1:[gatePort], at
   * most [ACCEPTS_IN_FLIGHT] being set up at once.
   */
  class Member(
    val fp: String,
    private val ways: () -> List<Ref>,
    private val identity: GateIdentity,
    private val name: String,
    private val kind: String,
    private val gatePort: Int,
    private val pingMs: Long = PING_MS,
    private val firstRetryMs: Long = FIRST_RETRY_MS,
    private val timeoutMs: Int = Gate.HANDSHAKE_MS,
    private val onState: (State, String?) -> Unit = { _, _ -> },
    private val onRegistered: (Ref) -> Unit = {},
  ) {
    @Volatile var state: State = State.REGISTERING
      private set
    @Volatile var why: String? = null
      private set
    @Volatile var at: Ref? = null
      private set
    @Volatile private var closed = false
    @Volatile private var control: Socket? = null
    private val lock = Object()
    private var delay = firstRetryMs
    private var way = 0
    private var kicked = false
    private val streams = ConcurrentHashMap.newKeySet<Socket>()
    /** `open`s being set up now (from the open to the pipe): at most [ACCEPTS_IN_FLIGHT]. */
    private val accepting = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile private var ignoredAt = 0L

    private fun set(s: State, w: String?) { state = s; why = w; runCatching { onState(s, w) } }

    fun start(): Member {
      thread(name = "anchor-member-${fp.take(8)}", isDaemon = true) { loop() }
      return this
    }

    private fun loop() {
      while (!closed) {
        val list = ways()
        if (list.isEmpty()) { set(State.REFUSED, "no address"); break }
        val ref = list[way % list.size]
        try {
          once(ref)
          if (closed) break
          set(State.LOST, "the connection to it was lost; trying again")
        } catch (e: Refused) {
          if (closed) break
          if (e.reason == "replaced") { set(State.REPLACED, "this phone registered there again from somewhere else; this connection stepped back"); break }
          set(State.REFUSED, if (e.reason == "not paired") "the anchor does not know this phone (any more): ask its owner for a new invite" else "the anchor said no: ${e.reason}")
          way++
        } catch (e: Exception) {
          if (closed) break
          val m = e.message ?: "unreachable"
          // the gate's own refusal ("gate: NO not paired") is the anchor saying no
          set(if (m.startsWith("gate: NO ")) State.REFUSED else State.LOST,
            if (m == "gate: NO not paired") "the anchor does not know this phone (any more): ask its owner for a new invite" else "it does not answer at ${hp(ref.host, ref.port)} ($m)")
          way++
        }
        synchronized(lock) {
          if (!kicked && !closed) runCatching { lock.wait(delay) }
          if (kicked) { kicked = false; delay = firstRetryMs } else delay = (delay * 2).coerceAtMost(MAX_RETRY_MS)
        }
      }
    }

    /** One registration: returns when the control connection ends, throws when it did not start. */
    private fun once(ref: Ref) {
      set(State.REGISTERING, null)
      val s = open(ref, identity, timeoutMs)
      try {
        val r = ask(s, JSONObject().put("t", "register").put("name", name.take(40)).put("kind", kind), timeoutMs)
        if (r.optString("t") != "registered") throw Refused(reasonOf(r))
        control = s
        if (closed) return
        at = ref
        synchronized(lock) { delay = firstRetryMs }
        Log.i(TAG, "registered at ${hp(ref.host, ref.port)}")
        set(State.REGISTERED, null)
        runCatching { onRegistered(ref) }
        val pinger = thread(name = "anchor-ping", isDaemon = true) {
          try { while (!s.isClosed && !closed) { Thread.sleep(pingMs); send(s, JSONObject().put("t", "ping")) } } catch (_: Exception) {}
        }
        // the anchor answers every ping: two pings without a word mean the connection is dead
        s.soTimeout = (2 * pingMs + timeoutMs).toInt()
        val inp = s.getInputStream()
        try {
          while (!closed) {
            val line = readLine(inp) ?: break
            val m = runCatching { JSONObject(line) }.getOrNull() ?: continue
            when (m.optString("t")) {
              "open" -> { val sid = m.optString("sid"); if (sid.isNotEmpty()) take(ref, sid, m.optString("from")) }
              "error" -> if (m.optString("reason") == "replaced") throw Refused("replaced")
            }
          }
        } catch (e: Refused) { throw e } catch (_: Exception) {
          // read timeout or a reset: the connection is gone
        } finally { pinger.interrupt() }
      } finally {
        if (control === s) control = null
        runCatching { s.close() }
      }
    }

    /**
     * An `open` from the anchor: counted here, before any thread or connection, and ignored when
     * [ACCEPTS_IN_FLIGHT] are being set up already (one log line per [IGNORED_LOG_MS]).
     */
    private fun take(ref: Ref, sid: String, from: String) {
      if (accepting.incrementAndGet() > ACCEPTS_IN_FLIGHT) {
        accepting.decrementAndGet()
        val t = System.currentTimeMillis()
        if (t - ignoredAt >= IGNORED_LOG_MS) { ignoredAt = t; Log.w(TAG, "$ACCEPTS_IN_FLIGHT streams being set up already; more opens from ${hp(ref.host, ref.port)} are ignored") }
        return
      }
      val settled = java.util.concurrent.atomic.AtomicBoolean(false)
      val settle = { if (settled.compareAndSet(false, true)) accepting.decrementAndGet() }
      try {
        thread(name = "anchor-stream", isDaemon = true) { try { accept(ref, sid, from, settle) } finally { settle() } }
      } catch (e: Throwable) {
        settle()
        Log.w(TAG, "stream from ${from.take(16)}…: ${e.message}")
      }
    }

    /** The anchor has a stream for this phone: open a second connection, accept it, pipe it into the gate. [settle] once it is piped. */
    private fun accept(ref: Ref, sid: String, from: String, settle: () -> Unit) {
      var s: Socket? = null
      var local: Socket? = null
      try {
        s = open(ref, identity, timeoutMs)
        streams.add(s)
        val r = ask(s, JSONObject().put("t", "accept").put("sid", sid), timeoutMs)
        if (r.optString("t") != "ready") throw Refused(reasonOf(r))
        s.soTimeout = 0
        local = Socket().also { it.connect(InetSocketAddress("127.0.0.1", gatePort), 3000) }
        // set up: from here it is a running stream, not an open in flight
        settle()
        Gate.pipe(s, s.getInputStream(), local, ByteArray(0))
      } catch (e: Exception) {
        Log.w(TAG, "stream from ${from.take(16)}…: ${e.message}")
        runCatching { s?.close() }
        runCatching { local?.close() }
      } finally {
        s?.let { streams.remove(it) }
      }
    }

    /** The network changed: drop the control connection and register again now (not after the backoff). */
    fun kick() {
      if (closed) return
      runCatching { control?.close() }
      synchronized(lock) { kicked = true; lock.notifyAll() }
    }

    fun close() {
      closed = true
      runCatching { control?.close() }
      for (s in streams) runCatching { s.close() }
      synchronized(lock) { lock.notifyAll() }
    }
  }

  // --- the store of joined anchors (gate/anchors.json, both processes) --------------------

  data class Addr(val host: String, val port: Int, val via: String)

  /** Whose computer an anchor is, as the person said when joining: [MINE] or [FRIEND]. */
  const val MINE = "mine"
  const val FRIEND = "friend"
  /** Anything but "mine" is a friend's: an entry written before the question was asked, or a bad value. */
  fun whoseOf(v: String?): String = if (v == MINE) MINE else FRIEND

  /**
   * An anchor this phone joined (node/src/join.ts JoinedAnchor). hpin: the pair-back code, until the
   * anchor used it or it ran out. [whose]: the person's answer when joining (security review D4 #10).
   */
  data class Joined(
    val fp: String, val name: String, val host: String, val port: Int, val addrs: List<Addr>, val joinedAt: Long,
    val hpin: String? = null, val hpinExp: Long? = null, val whose: String = FRIEND,
  ) {
    /** Every way to the anchor: the one that answered last first, then the invite's in order. */
    fun ways(): List<Ref> {
      val out = mutableListOf(Ref(host, port, fp))
      for (a in addrs) if (out.none { it.host == a.host && it.port == a.port }) out.add(Ref(a.host, a.port, fp))
      return out
    }
    fun toJson(): JSONObject = JSONObject().put("fp", fp).put("name", name).put("host", host).put("port", port)
      .put("addrs", JSONArray().also { arr -> addrs.forEach { arr.put(JSONObject().put("host", it.host).put("port", it.port).put("via", it.via)) } })
      .put("joined_at", joinedAt).put("hpin", hpin ?: JSONObject.NULL).put("hpinExp", hpinExp ?: JSONObject.NULL).put("whose", whose)
  }

  /**
   * The gate's friend test (Gate.Server `friend`, D4 #10): a paired certificate is a friend's device
   * when it is an anchor joined as "a friend's computer"; an anchor joined as "my computer" and every
   * other paired computer are the person's own.
   */
  fun friendOf(list: List<Joined>, fp: String): Boolean = list.firstOrNull { it.fp == fp.lowercase() }?.let { it.whose != MINE } ?: false

  private val VIAS = setOf("lan", "ipv6", "mapped")
  private val IP = Regex("^[0-9a-fA-F:.]+$")
  private fun goodHost(h: String) = h.isNotEmpty() && h.length <= 64 && IP.matches(h)

  /** What a stored line or an invite carries as addresses: ip literals and ports only, nothing looked up. */
  fun addrsOf(arr: JSONArray?): List<Addr> {
    val out = mutableListOf<Addr>()
    if (arr == null) return out
    for (i in 0 until minOf(arr.length(), 16)) {
      val o = arr.optJSONObject(i) ?: continue
      val host = o.optString("host").removePrefix("[").removeSuffix("]").lowercase()
      val port = o.optInt("port", 0)
      val via = o.optString("via").takeIf { it in VIAS } ?: continue
      if (!goodHost(host) || port !in 1..65535 || out.any { it.host == host && it.port == port }) continue
      out.add(Addr(host, port, via))
      if (out.size >= 8) break
    }
    return out
  }

  fun readJoined(file: File): List<Joined> {
    val arr = runCatching { JSONArray(file.readText()) }.getOrNull() ?: return emptyList()
    val out = mutableListOf<Joined>()
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      val fp = o.optString("fp").lowercase()
      val host = o.optString("host")
      val port = o.optInt("port", 0)
      if (!isFp(fp) || !goodHost(host) || port !in 1..65535 || out.any { it.fp == fp }) continue
      out.add(Joined(fp, o.optString("name").take(40).ifEmpty { "anchor ${fp.take(8)}" }, host, port, addrsOf(o.optJSONArray("addrs")), o.optLong("joined_at", 0L),
        o.optString("hpin").takeIf { !o.isNull("hpin") && it.matches(Regex("[0-9a-f]{8,64}")) }, if (o.isNull("hpinExp")) null else o.optLong("hpinExp").takeIf { it > 0 },
        whoseOf(o.optString("whose").takeIf { !o.isNull("whose") })))
    }
    return out
  }

  @Synchronized fun writeJoined(file: File, list: List<Joined>) {
    file.parentFile?.mkdirs()
    // both processes write it (the app joins, the worker forgets a used pair-back code): a temp
    // file of each writer's own, then a rename
    val tmp = File(file.parentFile, file.name + ".${Gate.randomHex(4)}.tmp")
    tmp.writeText(JSONArray().also { a -> list.forEach { a.put(it.toJson()) } }.toString(2))
    if (!tmp.renameTo(file)) { file.writeText(tmp.readText()); tmp.delete() }
  }

  /**
   * Read, change, write as one step. @Synchronized holds within one process only, and both the app
   * and the worker change the store: a lock on `anchors.json.lock` keeps the other process out
   * meanwhile, so a join or a cleared pair-back code is never lost (security review D4 #15).
   */
  @Synchronized fun updateJoined(file: File, f: (List<Joined>) -> List<Joined>) {
    file.parentFile?.mkdirs()
    java.io.RandomAccessFile(File(file.parentFile, file.name + ".lock"), "rw").use { raf ->
      val lock = raf.channel.lock()
      try { writeJoined(file, f(readJoined(file))) } finally { runCatching { lock.release() } }
    }
  }

  fun removeJoined(file: File, fp: String): Boolean {
    var hit = false
    updateJoined(file) { list -> list.filter { (it.fp != fp.lowercase()).also { keep -> if (!keep) hit = true } } }
    return hit
  }

  /**
   * Forgetting a joined anchor (the app's forget on its row): its pair-back gave the anchor's
   * computer lasting access to this phone, so that goes too (security review D4 #16; node/src/ui/
   * engine.ts takeAccess). Out of the paired list first ([Unpair.remove]: its next handshake hears
   * "not paired", one signed ledger line through [record]), then out of the store, so the gate's
   * seat rule cannot count it as the person's own meanwhile. The caller tells the running worker to
   * cut what it has open. Returns (left the store, access taken).
   */
  fun forget(file: File, fp: String, paired: Paired, hosts: Hosts?, seen: Seen?, record: ((Map<String, Any?>) -> Unit)?): Pair<Boolean, Boolean> {
    val f = fp.lowercase()
    val cut = Unpair.remove(f, paired, hosts, seen, record)
    return removeJoined(file, f) to cut
  }

  // --- joining (the phone pairs with an anchor's invite) ----------------------------------

  /**
   * The pair-back code of an invite: carried in it as `hpin`, derived from `pin` when the invite was
   * typed (node/src/join.ts pairBackCode: HMAC-SHA256 keyed by the pin over a fixed text).
   */
  fun pairBackCode(pin: String): String = Gate.hmac(pin.lowercase(), "kula anchor pair-back").take(16)

  /**
   * An anchor's invite as the app read it (src/llm/peers.ts parseInvite): fp "" with [fpPrefix] for a
   * typed one. [whose]: the person's answer before joining, "my computer" or "a friend's computer".
   */
  data class Invite(val fp: String, val fpPrefix: String?, val pin: String, val hpin: String?, val name: String, val ways: List<Addr>, val whose: String = FRIEND)

  data class JoinResult(val anchor: Joined, val at: Addr, val again: Boolean)

  /** A gate's refusal of an invite, in plain words (node/src/join.ts inviteWords). */
  fun inviteWords(m: String, typed: Boolean): String = when (m) {
    // used before this phone came: someone else may hold the anchor's access now (security review D4 #17)
    "gate: NO pin used" -> "this invite was used already: each invite works once. ask for a new one. if it was not you, tell the anchor's owner to remove the device that used it."
    "gate: NO pin expired" -> "this invite ran out (it works for 10 minutes). ask for a new one."
    "gate: NO wrong pin" -> "the code does not match the anchor's invite: check it, or ask for a new invite."
    "gate: NO not paired" -> "the anchor has no invite open: ask for a new one."
    "gate: ${Gate.FP_MISMATCH}" -> if (typed) "the certificate does not match what the anchor shows: not joining" else "another computer answered there, not the anchor: not joining"
    else -> if (m.startsWith("gate: NO ")) "the anchor said no: ${m.removePrefix("gate: NO ")}" else m
  }

  /**
   * Pairs with the anchor's gate using the invite's `pin`, along its addresses in order, and keeps the
   * anchor in the store [file] with the pair-back code (the worker's gate opens it for the anchor's
   * certificate only once it registers). Throws with plain words when it does not work.
   */
  fun join(inv: Invite, identity: GateIdentity, file: File, timeoutMs: Int = 6000, now: () -> Long = System::currentTimeMillis): JoinResult {
    val prefix = inv.fpPrefix?.replace(Regex("[\\s-]"), "")?.lowercase()?.takeIf { it.isNotEmpty() }
    if (prefix != null && !prefix.matches(Regex("[0-9a-f]+"))) throw IllegalArgumentException("the certificate is hex (0-9, a-f)")
    if (inv.fp.isEmpty() && (prefix?.length ?: 0) < Gate.FP_PREFIX_MIN) throw IllegalArgumentException("type the start of the anchor's certificate too (${Gate.FP_PREFIX_MIN} letters and digits or more)")
    if (inv.ways.isEmpty()) throw IllegalArgumentException("the invite has no address")
    // a fifth anchor is refused before the invite is spent: the store keeps [MAX_ANCHORS], and
    // dropping the oldest silently would leave the app listing an anchor this phone left (D4 #22).
    // An anchor joined before (by its certificate, or the typed start of it) may come again
    val known = readJoined(file)
    val invFp = inv.fp.lowercase()
    if (known.size >= MAX_ANCHORS && known.none { if (invFp.isNotEmpty()) it.fp == invFp else prefix != null && it.fp.startsWith(prefix) }) throw IllegalStateException(FULL_WORDS)
    var fp: String? = null
    var at: Addr? = null
    val missed = mutableListOf<String>()
    for (w in inv.ways) {
      val raw = Socket()
      try { raw.connect(InetSocketAddress(w.host, w.port), minOf(timeoutMs, 4000)) } catch (e: Exception) {
        runCatching { raw.close() }; missed.add("${hp(w.host, w.port)} (${e.message ?: "no answer"})"); continue
      }
      var shown: String? = null
      try {
        Gate.handshake(raw, "", "api", Gate.TlsClient(identity, inv.fp, inv.pin, prefix.takeIf { inv.fp.isEmpty() }), seen = { shown = it }).close()
        fp = shown
      } catch (e: Exception) {
        runCatching { raw.close() }
        val m = e.message ?: "failed"
        // paired, but nothing listens on its api right now: the certificate was shown at TLS and the proof passed
        if (m == "gate: NO channel closed" && shown != null) fp = shown
        else if (m == "gate: ${Gate.FP_MISMATCH}" && prefix == null) { missed.add("${hp(w.host, w.port)} (another computer)"); continue }
        else throw IllegalStateException(inviteWords(m, prefix != null))
      }
      at = w
      break
    }
    val got = fp?.lowercase() ?: throw IllegalStateException("the anchor does not answer at ${missed.joinToString(", ")}: is it on, and is its door open from where you are?")
    val where = at!!
    var again = false
    var stored: Joined? = null
    updateJoined(file) { list ->
      val before = list.firstOrNull { it.fp == got }
      again = before != null
      // full meanwhile (another join while this one was dialling): still no silent drop
      if (before == null && list.size >= MAX_ANCHORS) throw IllegalStateException(FULL_WORDS)
      val j = Joined(got, inv.name.take(40).ifEmpty { "anchor ${got.take(8)}" }, where.host, where.port, inv.ways, now(),
        // joined before: the anchor paired back then (or still may with the code kept)
        if (before != null) before.hpin else inv.hpin ?: pairBackCode(inv.pin),
        if (before != null) before.hpinExp else now() + INVITE_TTL_MS,
        // the answer just given, also when joining again: the person may have changed their mind
        whoseOf(inv.whose))
      stored = j
      list.filter { it.fp != got } + j
    }
    return JoinResult(stored!!, where, again)
  }

  // --- every joined anchor, kept registered while this phone is shared --------------------

  data class View(val fp: String, val name: String, val at: String, val state: State, val why: String?, val waitingBack: Boolean)

  /**
   * Registers this phone with every anchor in the store and keeps it registered while the worker
   * runs (WorkerService): a lost connection comes back with backoff, a network change brings it
   * back at once ([kick]). The pair-back code of each anchor is opened on the gate ([codes]) for
   * that anchor's certificate only; once used, the store forgets it. [refresh] reads the store
   * again when it changed (the app process writes it when the person joins).
   */
  class Links(
    private val file: File,
    private val identity: GateIdentity,
    private val name: String,
    private val kind: String,
    private val gatePort: Int,
    private val codes: Gate.ExtraCodes?,
    private val now: () -> Long = System::currentTimeMillis,
    private val retryMs: Long = FIRST_RETRY_MS,
    private val pingMs: Long = PING_MS,
  ) {
    private fun member(j: Joined, ways: () -> List<Ref>) = Member(j.fp, ways, identity, name, kind, gatePort, pingMs = pingMs, firstRetryMs = retryMs, onRegistered = { ref ->
      // the address that answered is tried first from now on
      if (ref.host != j.host || ref.port != j.port) updateJoined(file) { l -> l.map { if (it.fp == j.fp) it.copy(host = ref.host, port = ref.port) else it } }
    })
    private val members = ConcurrentHashMap<String, Member>()
    @Volatile private var list: List<Joined> = emptyList()
    private var stamp: Pair<Long, Long>? = null
    @Volatile private var closed = false

    @Synchronized fun refresh(force: Boolean = false) {
      if (closed) return
      val s = if (file.exists()) file.lastModified() to file.length() else 0L to -1L
      if (!force && s == stamp) return
      stamp = s
      list = readJoined(file)
      val want = list.map { it.fp }.toSet()
      for ((fp, m) in members) if (fp !in want) { members.remove(fp); m.close(); Log.i(TAG, "left ${fp.take(16)}… (no longer joined)") }
      for (j in list) {
        openCode(j)
        if (members.containsKey(j.fp)) continue
        members[j.fp] = member(j) { list.firstOrNull { it.fp == j.fp }?.ways() ?: emptyList() }.start()
      }
    }

    private fun openCode(j: Joined) {
      val c = codes ?: return
      val pin = j.hpin ?: return
      val left = (j.hpinExp ?: 0L) - now()
      if (left <= 0 || c.has(pin)) return
      c.add(pin, left, only = j.fp, name = j.name) {
        updateJoined(file) { l -> l.map { if (it.fp == j.fp) it.copy(hpin = null, hpinExp = null) else it } }
        list = list.map { if (it.fp == j.fp) it.copy(hpin = null, hpinExp = null) else it }
        Log.i(TAG, "${j.name}: paired back; it can use this phone now")
      }
    }

    fun kick() { for (m in members.values) m.kick() }

    fun view(): List<View> = list.mapNotNull { j ->
      val m = members[j.fp] ?: return@mapNotNull null
      val at = m.at ?: Ref(j.host, j.port, j.fp)
      View(j.fp, j.name, hp(at.host, at.port), m.state, m.why, j.hpin != null && (j.hpinExp ?: 0) > now())
    }

    fun close() {
      closed = true
      for (m in members.values) m.close()
      members.clear()
    }
  }

  fun hp(h: String, port: Int) = "${if (h.contains(':')) "[$h]" else h}:$port"
}
