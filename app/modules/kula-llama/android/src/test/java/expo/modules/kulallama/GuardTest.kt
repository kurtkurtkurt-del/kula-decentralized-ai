package expo.modules.kulallama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

// docs/SECURITY.md: the rules a paired master is held to on this phone.
class GuardTest {
  private fun bad(name: String?) = runCatching { ModelName.safe(name) }.isFailure

  @Test
  fun modelNamesStayInsideModels() {
    assertEquals("m.gguf", ModelName.safe("m.gguf"))
    assertEquals("escape", ModelName.safe("../../shared_prefs/escape"))
    assertEquals("x.gguf", ModelName.safe("/data/data/app/x.gguf"))
    assertEquals("a_b_c.gguf", ModelName.safe("a b;c.gguf"))
    assertEquals("win.gguf", ModelName.safe("..\\..\\win.gguf"))
    assertTrue(bad(""))
    assertTrue(bad(null))
    assertTrue(bad("."))
    assertTrue(bad(".."))
    assertTrue(bad("../"))
    assertTrue(bad("m.gguf.part"))
    assertTrue(bad("x".repeat(201)))
  }

  @Test
  fun urlPolicyKeepsTheWorkerOutOfTheLan() {
    assertNull(UrlPolicy.problem("https://huggingface.co/x/y/resolve/main/m.gguf"))
    assertNull(UrlPolicy.problem("http://cdn.example.com/m.gguf"))
    assertEquals("url must be http(s)", UrlPolicy.problem("file:///etc/passwd"))
    assertEquals("url must be http(s)", UrlPolicy.problem("ftp://example.com/m"))
    assertEquals("bad url", UrlPolicy.problem("not a url"))
    assertEquals("bad url", UrlPolicy.problem(""))
    assertEquals("bad url", UrlPolicy.problem(null))
    assertEquals("url must not carry credentials", UrlPolicy.problem("https://u:p@example.com/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://127.0.0.1:8080/m"))
    assertEquals("url points at a local host", UrlPolicy.problem("http://localhost/m"))
    assertEquals("url points at a local host", UrlPolicy.problem("http://router.local/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://192.168.1.1/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://10.0.0.5/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://172.20.0.1/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://169.254.169.254/latest"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://100.64.1.1/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[::1]/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[fe80::1]/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[fd00::1]/m"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[::ffff:10.0.0.1]/m"))
    assertNull(UrlPolicy.problem("http://127.0.0.1/m", allowPrivate = true))
    assertFalse(UrlPolicy.isPrivateAddress(InetAddress.getByName("8.8.8.8")))
    assertFalse(UrlPolicy.isPrivateAddress(InetAddress.getByName("2001:db8::1")))
    assertNull(UrlPolicy.sha256Problem(null))
    assertNull(UrlPolicy.sha256Problem("AB".repeat(32)))
    assertEquals("sha256 must be 64 hex characters", UrlPolicy.sha256Problem("zz"))
    assertEquals("sha256 must be 64 hex characters", UrlPolicy.sha256Problem(""))
  }

  @Test
  fun theMastersOwnAddressIsTheOneException() {
    val m = "http://192.168.1.20:8080/m.gguf"
    // the master that sent the /load may hand out the model from its own lan address
    assertNull(UrlPolicy.problem(m, "192.168.1.20"))
    assertNull(UrlPolicy.problem("https://10.0.0.5/m", "10.0.0.5"))
    assertNull(UrlPolicy.problem("http://100.64.3.4/m", "100.64.3.4"))
    // the same address in its ipv4-mapped form, either side
    assertNull(UrlPolicy.problem(m, "::ffff:192.168.1.20"))
    assertNull(UrlPolicy.problem("http://[::ffff:192.168.1.20]/m", "192.168.1.20"))
    // ipv6 literals: the same address passes, written differently too; a zone is not compared
    assertNull(UrlPolicy.problem("http://[fd00::5]/m", "fd00::5"))
    assertNull(UrlPolicy.problem("http://[fd00:0:0:0:0:0:0:5]/m", "fd00::5"))
    assertNull(UrlPolicy.problem("http://[fe80::1]/m", "fe80::1%wlan0"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[fd00::6]/m", "fd00::5"))
    // any other private address stays refused
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://192.168.1.21/m", "192.168.1.20"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://169.254.169.254/latest", "192.168.1.20"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem(m, null))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem(m, ""))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem(m, "not an address"))
    // a name is never the exception, whatever it resolves to or however it is spelled
    assertEquals("url points at a local host", UrlPolicy.problem("http://localhost/m", "127.0.0.1"))
    assertEquals("url points at a local host", UrlPolicy.problem("http://mac.local/m", "192.168.1.20"))
    assertNull(UrlPolicy.pinnedMaster("http://mac.example.com/m", "192.168.1.20"))
    // loopback, any-local and multicast never pass, even when the "master" is one (a relayed
    // stream reaches the gate from 127.0.0.1)
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://127.0.0.1/m", "127.0.0.1"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://127.0.0.2/m", "127.0.0.2"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[::1]/m", "::1"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://[::ffff:127.0.0.1]/m", "127.0.0.1"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://0.0.0.0/m", "0.0.0.0"))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.problem("http://224.0.0.1/m", "224.0.0.1"))
    // a public url is fine whoever the master is
    assertNull(UrlPolicy.problem("https://huggingface.co/m", "192.168.1.20"))
  }

  @Test
  fun everyDownloadHopStaysOnTheMastersAddress() {
    val ip = { s: String -> InetAddress.getByName(s) }
    val pinned = UrlPolicy.pinnedMaster("http://192.168.1.20/m", "192.168.1.20")
    assertEquals(ip("192.168.1.20"), pinned)
    // the first hop and a redirect on the same address pass
    assertNull(UrlPolicy.hopProblem("http://192.168.1.20/m", "192.168.1.20", pinned, listOf(ip("192.168.1.20"))))
    assertNull(UrlPolicy.hopProblem("http://192.168.1.20:9000/other", "192.168.1.20", pinned, listOf(ip("192.168.1.20"))))
    // a redirect off it is refused, public or private
    assertEquals("redirect left the master's address", UrlPolicy.hopProblem("https://cdn.example.com/m", "192.168.1.20", pinned, listOf(ip("8.8.8.8"))))
    assertEquals(UrlPolicy.NOT_PUBLIC, UrlPolicy.hopProblem("http://192.168.1.1/m", "192.168.1.20", pinned, listOf(ip("192.168.1.1"))))
    // without the exception: a public name that resolves into the lan is refused, the master's address included
    assertNull(UrlPolicy.pinnedMaster("https://cdn.example.com/m", "192.168.1.20"))
    assertEquals("${UrlPolicy.NOT_PUBLIC} (cdn.example.com resolves to a private address)", UrlPolicy.hopProblem("https://cdn.example.com/m", "192.168.1.20", null, listOf(ip("192.168.1.20"))))
    assertEquals("${UrlPolicy.NOT_PUBLIC} (evil.example resolves to a private address)", UrlPolicy.hopProblem("https://evil.example/m", null, null, listOf(ip("8.8.8.8"), ip("127.0.0.1"))))
    assertNull(UrlPolicy.hopProblem("https://cdn.example.com/m", "192.168.1.20", null, listOf(ip("8.8.8.8"))))
    // a redirect from a public start into the master's address is not the exception either
    assertEquals("${UrlPolicy.NOT_PUBLIC} (192.168.1.20 resolves to a private address)", UrlPolicy.hopProblem("http://192.168.1.20/m", "192.168.1.20", null, listOf(ip("192.168.1.20"))))
  }

  @Test
  fun apiPeersKnowsTheMasterBehindALocalPort() {
    assertTrue(ApiPeers.put(40001, "192.168.1.20"))
    assertEquals("192.168.1.20", ApiPeers.get(40001))
    assertTrue(ApiPeers.put(40002, "fd00::5"))
    assertEquals("fd00::5", ApiPeers.get(40002))
    // a relayed stream comes from 127.0.0.1: not a master's address, nothing recorded
    assertFalse(ApiPeers.put(40003, "127.0.0.1"))
    assertFalse(ApiPeers.put(40004, "::1"))
    assertFalse(ApiPeers.put(40005, "?"))
    assertFalse(ApiPeers.put(0, "192.168.1.20"))
    assertNull(ApiPeers.get(40003))
    ApiPeers.remove(40001); ApiPeers.remove(40002)
    assertNull(ApiPeers.get(40001))
    assertNull(ApiPeers.get(40002))
  }

  @Test
  fun sizesAndEndpoints() {
    assertFalse(SizePolicy.overSize(1000, 1000))
    assertTrue(SizePolicy.overSize(1000 + 1024 + 21, 1000))
    assertFalse(SizePolicy.overSize(1_000_000_000, 0))
    assertTrue(Endpoints.isLoopback("127.0.0.1:50551"))
    assertFalse(Endpoints.isLoopback("0.0.0.0:50551"))
    assertFalse(Endpoints.isLoopback("192.168.1.2:50551"))
    assertFalse(Endpoints.isLoopback("127.0.0.1:0"))
    assertFalse(Endpoints.isLoopback("127.0.0.1:70000"))
    assertFalse(Endpoints.isLoopback("localhost:1"))
    assertFalse(Endpoints.isLoopback("127.0.0.1"))
  }

  @Test
  fun theRpcSlotAdmitsOneAddressEvenWhenManyArriveAtOnce() {
    val slot = RpcSlot()
    assertTrue(slot.take("10.0.0.1"))
    assertTrue(slot.take("10.0.0.1")) // the same master again (llama opens several connections)
    assertFalse(slot.take("10.0.0.2"))
    slot.release(); slot.release()
    assertEquals(null, slot.peer)
    assertTrue(slot.take("10.0.0.2"))
    slot.release()
    // 32 different addresses at the same instant: exactly one holds it
    val pool = Executors.newFixedThreadPool(32)
    val go = CountDownLatch(1)
    val got = AtomicInteger(0)
    val done = CountDownLatch(32)
    for (i in 0 until 32) pool.execute { go.await(); if (slot.take("10.0.1.$i")) got.incrementAndGet(); done.countDown() }
    go.countDown(); done.await(); pool.shutdown()
    assertEquals(1, got.get())
    assertEquals(1, slot.openCount())
  }

  @Test
  fun httpLimitsBoundWhatOneRequestMayBe() {
    val inp = ByteArrayInputStream("GET /status HTTP/1.1\r\nHost: x\n\n".toByteArray())
    assertEquals("GET /status HTTP/1.1", HttpLimits.readLine(inp))
    assertEquals("Host: x", HttpLimits.readLine(inp))
    assertEquals("", HttpLimits.readLine(inp))
    assertNull(HttpLimits.readLine(inp))
    assertTrue(runCatching { HttpLimits.readLine(ByteArrayInputStream(ByteArray(HttpLimits.MAX_LINE + 10) { 'a'.code.toByte() })) }.isFailure)
    assertEquals(0, HttpLimits.contentLength(null))
    assertEquals(12, HttpLimits.contentLength(" 12 "))
    assertTrue(runCatching { HttpLimits.contentLength("-1") }.isFailure)
    assertTrue(runCatching { HttpLimits.contentLength("x") }.isFailure)
    assertTrue(runCatching { HttpLimits.contentLength((HttpLimits.MAX_BODY + 1L).toString()) }.isFailure)
    assertTrue(runCatching { HttpLimits.contentLength("99999999999999999999") }.isFailure)
  }
}
