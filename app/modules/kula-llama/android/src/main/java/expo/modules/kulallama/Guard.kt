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

  fun isPrivateLiteral(host: String): Boolean {
    val h = host.trim().removePrefix("[").removeSuffix("]")
    val looksLiteral = h.all { it.isDigit() || it == '.' } || h.contains(':')
    if (!looksLiteral) return false
    return runCatching { isPrivateAddress(InetAddress.getByName(h)) }.getOrDefault(true)
  }

  /**
   * null when [url] may be fetched, else why not: http(s) only, no credentials, no local
   * or private host by name or literal. Names are checked again when resolved
   * (ModelDownloader): a public name for 127.0.0.1 is the usual way round the text check.
   * [allowPrivate] is for tests that serve files from 127.0.0.1.
   */
  fun problem(url: String?, allowPrivate: Boolean = false): String? {
    if (url.isNullOrBlank()) return "bad url"
    val u = try { URI(url) } catch (e: Exception) { return "bad url" }
    val scheme = u.scheme?.lowercase() ?: return "bad url"
    if (scheme != "https" && scheme != "http") return "url must be http(s)"
    if (!u.rawUserInfo.isNullOrEmpty()) return "url must not carry credentials"
    val host = u.host?.lowercase() ?: return "bad url"
    if (allowPrivate) return null
    if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return "url points at a local host"
    if (isPrivateLiteral(host)) return "url points at a private address"
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
