package expo.modules.kulallama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Random

// The gate's hello line under random input (a seeded generator; the TypeScript twin uses
// fast-check): every line that is not a handshake gets one "NO <reason>" and a closed
// socket, the server thread never dies, and a real client is served afterwards.
class GateFuzzTest {
  private val reasons = setOf("no hello", "bad hello", "bad channel", "bad nonce", "no proof", "wrong secret", "no tls", "channel closed", "target down", "replay", "clock")
  private val rnd = Random(20261105L)

  private fun hex32(): String = (0 until 32).joinToString("") { "0123456789abcdef"[rnd.nextInt(16)].toString() }
  private fun token(): String = when (rnd.nextInt(9)) {
    0 -> listOf("KULA1", "KULA2", "kula1", "KULA", "KULA10", "")[rnd.nextInt(6)]
    1 -> listOf("rpc", "api", "RPC", "xyz", "")[rnd.nextInt(5)]
    2 -> hex32()
    3 -> hex32().take(rnd.nextInt(33))
    4 -> hex32().uppercase()
    5 -> (0 until 1 + rnd.nextInt(20)).joinToString("") { rnd.nextInt(10).toString() }
    6 -> listOf("-1", "+5", "1e3", "NaN", "9223372036854775808")[rnd.nextInt(5)]
    7 -> String(CharArray(rnd.nextInt(12)) { (0x20 + rnd.nextInt(0x5f)).toChar() })
    else -> String(CharArray(rnd.nextInt(8)) { rnd.nextInt(0xD7FF).toChar() })
  }
  private fun shaped(): String = (0 until rnd.nextInt(7)).joinToString(" ") { token() }
  private fun garbage(): ByteArray = ByteArray(rnd.nextInt(400)) { rnd.nextInt(256).toByte() }

  private fun isValidHello(line: String): Boolean {
    val p = line.trim().split(' ')
    return (p.size == 3 || p.size == 4) && p[0] == "KULA1" && (p[1] == "rpc" || p[1] == "api") && p[2].matches(Regex("[0-9a-f]{32}")) && (p.size == 3 || p[3].matches(Regex("[0-9]{1,16}")))
  }

  /** Sends bytes, reads everything the gate answers until it closes (or 3 s pass). */
  private fun exchange(port: Int, bytes: ByteArray): Pair<String, Boolean> = Socket("127.0.0.1", port).use { s ->
    s.soTimeout = 3000
    s.getOutputStream().write(bytes); s.getOutputStream().flush()
    val out = ByteArrayOutputStream()
    val buf = ByteArray(1024)
    var closed = false
    try {
      while (true) { val n = s.getInputStream().read(buf); if (n < 0) { closed = true; break }; out.write(buf, 0, n) }
    } catch (e: java.net.SocketTimeoutException) { closed = false }
    String(out.toByteArray(), Charsets.UTF_8) to closed
  }

  @Test fun anyHelloThatIsNotAHandshakeGetsOneNoLineAndAClosedSocket() {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) } }.start() } }.apply { isDaemon = true }.start()
    val secret = Gate.newSecret()
    val port = ServerSocket(0).use { it.localPort }
    val events = mutableListOf<Gate.Event>()
    val server = Gate.Server(port, secret, { ch -> if (ch == "rpc") echo.localPort else null }) { synchronized(events) { events.add(it) } }
    server.start()
    try {
      var refused = 0
      for (i in 0 until 400) {
        val bytes: ByteArray = when (rnd.nextInt(6)) {
          0 -> garbage() + "\n".toByteArray()
          1 -> (shaped() + listOf("\n", "\r\n", "\n\n")[rnd.nextInt(3)]).toByteArray()
          2 -> (shaped() + "\n" + shaped() + "\n").toByteArray()
          3 -> ByteArray(300 + rnd.nextInt(2000)) { 'A'.code.toByte() } + "\n".toByteArray()  // over the 256 char line limit
          4 -> byteArrayOf(0x16) + garbage() + "\n".toByteArray()                               // looks like tls, no certificate here
          else -> (String(CharArray(rnd.nextInt(200)) { rnd.nextInt(0x10000).toChar() }) + "\n").toByteArray()
        }
        val text = String(bytes, Charsets.UTF_8)
        if (isValidHello(text.substringBefore('\n'))) continue
        val (reply, closed) = exchange(port, bytes)
        assertTrue("must hang up for ${text.take(60)}", closed)
        val line = reply.substringBefore('\n')
        assertTrue("reply was '$reply' for ${text.take(60)}", line.startsWith("NO ") && reply.endsWith("\n") && line.removePrefix("NO ") in reasons)
        assertEquals("one line only: '$reply'", 1, reply.count { it == '\n' })
        if (bytes[0] == 0x16.toByte()) assertEquals("NO no tls", line)
        refused++
      }
      assertTrue(refused > 300)
      // a valid hello followed by a wrong proof: the nonce comes first, then NO wrong secret
      for (i in 0 until 50) {
        val ch = if (rnd.nextBoolean()) "rpc" else "api"
        val ts = if (rnd.nextBoolean()) "" else " ${rnd.nextInt(Int.MAX_VALUE)}"
        val proof = (if (rnd.nextBoolean()) hex32() + hex32() else token().replace("\n", "")).ifBlank { "x" } // an empty proof is "no proof", tested above
        val (reply, closed) = exchange(port, "KULA1 $ch ${hex32()}$ts\n$proof\n".toByteArray())
        assertTrue(closed)
        val lines = reply.split('\n')
        assertTrue("expected the nonce first: '$reply'", lines[0].matches(Regex("[0-9a-f]{32}")))
        assertEquals("NO wrong secret", lines[1])
      }
      // still alive
      assertEquals(null, Gate.probe("127.0.0.1", port, secret, "rpc"))
      assertTrue(synchronized(events) { events.count { it.kind == "reject" } } > 300)
    } finally {
      server.stop(); echo.close()
    }
  }

  @Test fun everyGeneratedHandshakePassesAndPipesAnyBytes() {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) } }.start() } }.apply { isDaemon = true }.start()
    try {
      for (i in 0 until 25) {
        val secret = if (rnd.nextBoolean()) Gate.newSecret() else String(CharArray(1 + rnd.nextInt(40)) { (0x21 + rnd.nextInt(0x5e)).toChar() })
        val ch = if (rnd.nextBoolean()) "rpc" else "api"
        val port = ServerSocket(0).use { it.localPort }
        val server = Gate.Server(port, secret, { echo.localPort }) {}
        server.start()
        try {
          Socket("127.0.0.1", port).use { s ->
            Gate.handshake(s, secret, ch)
            val payload = ByteArray(1 + rnd.nextInt(3000)) { rnd.nextInt(256).toByte() }
            s.getOutputStream().write(payload); s.getOutputStream().flush()
            val got = ByteArray(payload.size); var n = 0
            s.soTimeout = 3000
            while (n < got.size) { val r = s.getInputStream().read(got, n, got.size - n); if (r < 0) break; n += r }
            assertTrue(payload.contentEquals(got))
          }
        } finally { server.stop() }
      }
    } finally { echo.close() }
  }

  @Test fun theClockFieldIsDigitsOnlyLikeTheTypescriptGate() {
    val port = ServerSocket(0).use { it.localPort }
    val server = Gate.Server(port, "s", { null }) {}
    server.start()
    try {
      for (bad in listOf("-1", "+5", "1e3", "0x10", "99999999999999999")) {
        val (reply, _) = exchange(port, "KULA1 rpc ${hex32()} $bad\n".toByteArray())
        assertEquals("for clock '$bad'", "NO bad hello\n", reply)
      }
      val (reply, _) = exchange(port, "KULA1 rpc ${hex32()} 1700000000000\n".toByteArray())
      assertTrue(reply.substringBefore('\n').matches(Regex("[0-9a-f]{32}")))
    } finally { server.stop() }
  }
}
