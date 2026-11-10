package expo.modules.kulallama

import java.io.InputStream
import java.net.InetAddress
import java.net.URI

/**
 * The small rules the worker holds a paired master to (docs/SECURITY.md). A master is
 * trusted to run a model here, not to pick file names on this phone, point it into the
 * lan, or fill its disk. Plain Kotlin, no Android: JVM-tested in GuardTest.kt; the Node
 * twin is node/src/policy.ts.
 */
object ModelName {
  private val OK = Regex("[A-Za-z0-9._-]+")

  /**
   * The file name a /load may write under models/: the last path segment with anything
   * outside [A-Za-z0-9._-] replaced, never empty, "." or "..", never a ".part" (that is
   * the downloader's own suffix). Throws IllegalArgumentException("bad name").
   */
  fun safe(name: String?): String {
    val last = (name ?: "").substringAfterLast('/').substringAfterLast('\\')
    val base = last.replace(Regex("[^A-Za-z0-9._-]"), "_")
    if (base.isEmpty() || base == "." || base == ".." || base.endsWith(".part") || base.length > 200) throw IllegalArgumentException("bad name")
    require(OK.matches(base))
    return base
  }
}

object UrlPolicy {
  const val MAX_REDIRECTS = 5
  val SHA256 = Regex("[0-9a-f]{64}")

  /** Loopback, link-local, private, carrier-grade nat and multicast: a model never lives there. */
  fun isPrivateAddress(addr: InetAddress): Boolean {
    if (addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isSiteLocalAddress || addr.isMulticastAddress || addr.isAnyLocalAddress) return true
    val b = addr.address
    if (b.size == 4) {
      val a0 = b[0].toInt() and 0xff; val a1 = b[1].toInt() and 0xff
      return a0 == 0 || (a0 == 100 && a1 in 64..127) || a0 >= 224
    }
    if (b.size == 16) {
      val a0 = b[0].toInt() and 0xff
      return (a0 and 0xfe) == 0xfc // fc00::/7 unique local
    }
    return false
  }

  /** The address in an ip literal host ("10.0.0.5", "[fd00::5]", "fe80::1%wlan0"); null for a name. */
  fun literal(host: String): InetAddress? {
    val h = host.trim().removePrefix("[").removeSuffix("]").substringBefore('%')
    val looksLiteral = h.isNotEmpty() && (h.all { it.isDigit() || it == '.' } || h.contains(':'))
    if (!looksLiteral) return null
    return runCatching { InetAddress.getByName(h) }.getOrNull()
  }

  fun isPrivateLiteral(host: String): Boolean {
    val h = host.trim().removePrefix("[").removeSuffix("]")
    val looksLiteral = h.all { it.isDigit() || it == '.' } || h.contains(':')
    if (!looksLiteral) return false
    return literal(h)?.let { isPrivateAddress(it) } ?: true
  }

  /**
   * The one exception to "public only": [host] is an ip literal equal to [master], the
   * address the gate saw for the master that sent this /load (a computer in apart mode
   * hands its workers the model from its own lan address). Never loopback, any-local or
   * multicast, even when the master is one of those (a relayed stream reaches the gate
   * from 127.0.0.1); never a name, whatever it resolves to. "::ffff:10.0.0.5" and
   * "10.0.0.5" are the same address; an ipv6 zone ("%wlan0") is not compared.
   */
  fun isMaster(host: String, master: String?): Boolean {
    if (master.isNullOrBlank()) return false
    val a = literal(host) ?: return false
    val m = literal(master) ?: return false
    if (a.isLoopbackAddress || a.isAnyLocalAddress || a.isMulticastAddress) return false
    if (m.isLoopbackAddress || m.isAnyLocalAddress || m.isMulticastAddress) return false
    return a.address.contentEquals(m.address)
  }

  /** What a private host is told; the Node twin says the same (node/src/policy.ts). */
  const val NOT_PUBLIC = "url must be public or the master's own address"

  /**
   * null when [url] may be fetched, else why not: http(s) only, no credentials, no local
   * or private host by name or literal, except the literal address of the master that sent
   * the request ([master], see [isMaster]). Names are checked again when resolved
   * (ModelDownloader): a public name for 127.0.0.1 is the usual way round the text check.
   * [allowPrivate] is for tests that serve files from 127.0.0.1.
   */
  fun problem(url: String?, master: String? = null, allowPrivate: Boolean = false): String? {
    if (url.isNullOrBlank()) return "bad url"
    val u = try { URI(url) } catch (e: Exception) { return "bad url" }
    val scheme = u.scheme?.lowercase() ?: return "bad url"
    if (scheme != "https" && scheme != "http") return "url must be http(s)"
    if (!u.rawUserInfo.isNullOrEmpty()) return "url must not carry credentials"
    val host = u.host?.lowercase() ?: return "bad url"
    if (allowPrivate) return null
    if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "url points at a local host"
    if (isPrivateLiteral(host)) return if (isMaster(host, master)) null else NOT_PUBLIC
    return null
  }

  /** The master's address when [url]'s host is that very literal (the exception is in use), else null. */
  fun pinnedMaster(url: String, master: String?): InetAddress? {
    val host = runCatching { URI(url).host }.getOrNull() ?: return null
    if (!isMaster(host, master)) return null
    return literal(host)
  }

  /**
   * One download hop, once its host was resolved: null when it may be fetched. [pinned] is
   * the master's address when the first url used the exception ([pinnedMaster]): then every
   * hop, redirects included, must stay on that very address. Otherwise no resolved address
   * may be private, so a public name for a lan address is refused too.
   */
  fun hopProblem(url: String, master: String?, pinned: InetAddress?, resolved: List<InetAddress>): String? {
    problem(url, master)?.let { return it }
    val host = runCatching { URI(url).host }.getOrNull() ?: return "bad url"
    if (pinned != null) {
      val a = literal(host)
      return if (a != null && a.address.contentEquals(pinned.address)) null else "redirect left the master's address"
    }
    if (resolved.any { isPrivateAddress(it) }) return "$NOT_PUBLIC ($host resolves to a private address)"
    return null
  }

  /** An optional sha256 must be one: 64 hex (case does not matter). null when absent. */
  fun sha256Problem(sha: String?): String? = if (sha == null || SHA256.matches(sha.lowercase())) null else "sha256 must be 64 hex characters"
}

object SizePolicy {
  /** How far past the size the master gave a body may run before it is cut. */
  const val SLACK = 0.02
  /** What stays free on the disk after a download, at least. */
  const val KEEP_FREE_BYTES = 512L * 1024 * 1024

  fun overSize(got: Long, size: Long): Boolean = size > 0 && got > size * (1 + SLACK) + 1024
}

/**
 * The one-master rule on the rpc channel, decided and recorded under one lock: a second
 * address is refused while the first has a connection open. The check and the claim used
 * to be two steps; two peers arriving together could both pass the check.
 */
class RpcSlot {
  @Volatile var peer: String? = null
    private set
  private var open = 0

  /** Takes a slot for [p]; false when another address holds the channel. */
  @Synchronized
  fun take(p: String): Boolean {
    if (peer != null && peer != p && open > 0) return false
    peer = p; open++
    return true
  }

  @Synchronized
  fun release() {
    if (open > 0) open--
    if (open == 0) peer = null
  }

  @Synchronized fun openCount() = open
}

/**
 * Which master is behind an api connection. ApiServer listens on 127.0.0.1 and the gate pipes
 * the `api` channel to it, so all it sees is 127.0.0.1:<port>. When the gate admits a
 * connection it records the local port of its own socket to ApiServer (the remote port
 * ApiServer accepts) with the peer address it saw, and removes it when the pipe ends.
 * Loopback peers are never recorded: a relayed stream comes in from 127.0.0.1.
 */
object ApiPeers {
  private val byPort = java.util.concurrent.ConcurrentHashMap<Int, String>()

  /** Records [peer] for [localPort]; false (nothing recorded) for a loopback or unknown peer. */
  fun put(localPort: Int, peer: String): Boolean {
    if (localPort <= 0) return false
    val a = UrlPolicy.literal(peer) ?: return false
    if (a.isLoopbackAddress || a.isAnyLocalAddress) return false
    byPort[localPort] = peer
    return true
  }

  fun remove(localPort: Int) { byPort.remove(localPort) }

  /** The master's address for the api connection that came from 127.0.0.1:[remotePort]; null when none. */
  fun get(remotePort: Int): String? = byPort[remotePort]
}

object Endpoints {
  /** "127.0.0.1:<port>" and nothing else: ggml's rpc server is never bound or dialled elsewhere. */
  fun isLoopback(endpoint: String): Boolean {
    val m = Regex("^127\\.0\\.0\\.1:(\\d{1,5})$").find(endpoint) ?: return false
    val port = m.groupValues[1].toInt()
    return port in 1..65535
  }
}

/** HTTP on the api channel (ApiServer): what one request may be. */
object HttpLimits {
  const val MAX_LINE = 8 * 1024
  const val MAX_HEADERS = 64
  const val MAX_BODY = 1 shl 20

  /** One "\r\n"- or "\n"-ended line of at most [max] bytes (ISO-8859-1); throws when longer. null at end of stream. */
  fun readLine(inp: InputStream, max: Int = MAX_LINE): String? {
    val sb = StringBuilder()
    var any = false
    while (true) {
      val b = inp.read()
      if (b < 0) return if (any) sb.toString() else null
      any = true
      if (b == '\n'.code) break
      if (b != '\r'.code) sb.append(b.toChar())
      if (sb.length > max) throw IllegalStateException("header line too long")
    }
    return sb.toString()
  }

  /** The Content-Length a request may claim; throws for a bad or oversized one. */
  fun contentLength(value: String?): Int {
    if (value == null) return 0
    val n = value.trim().toLongOrNull() ?: throw IllegalStateException("bad content-length")
    if (n < 0 || n > MAX_BODY) throw IllegalStateException("body too large")
    return n.toInt()
  }
}
