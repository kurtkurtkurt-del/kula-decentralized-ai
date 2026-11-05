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
    assertEquals("url points at a private address", UrlPolicy.problem("http://127.0.0.1:8080/m"))
    assertEquals("url points at a local host", UrlPolicy.problem("http://localhost/m"))
    assertEquals("url points at a local host", UrlPolicy.problem("http://router.local/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://192.168.1.1/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://10.0.0.5/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://172.20.0.1/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://169.254.169.254/latest"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://100.64.1.1/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://[::1]/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://[fe80::1]/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://[fd00::1]/m"))
    assertEquals("url points at a private address", UrlPolicy.problem("http://[::ffff:10.0.0.1]/m"))
    assertNull(UrlPolicy.problem("http://127.0.0.1/m", allowPrivate = true))
    assertFalse(UrlPolicy.isPrivateAddress(InetAddress.getByName("8.8.8.8")))
    assertFalse(UrlPolicy.isPrivateAddress(InetAddress.getByName("2001:db8::1")))
    assertNull(UrlPolicy.sha256Problem(null))
    assertNull(UrlPolicy.sha256Problem("AB".repeat(32)))
    assertEquals("sha256 must be 64 hex characters", UrlPolicy.sha256Problem("zz"))
    assertEquals("sha256 must be 64 hex characters", UrlPolicy.sha256Problem(""))
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
