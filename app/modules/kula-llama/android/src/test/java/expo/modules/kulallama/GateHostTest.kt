package expo.modules.kulallama

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket

// "only known computers" (8.11.2026, docs/GATE.md): the auto worker runs the gate with v1 off
// and no open code, so only paired certificates get in; a computer added by scanning its QR
// gets a code that pairs that one certificate and no other.
class GateHostTest {
  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }
  private fun freePort() = ServerSocket(0).use { it.localPort }
  private fun pairedFile() = File(java.nio.file.Files.createTempDirectory("kula-gate").toFile(), "paired")

  @Test
  fun knownOnlyLetsInPairedCertificatesAndNothingElse() {
    val echo = echo()
    val port = freePort()
    val worker = GateIdentity.create("worker")
    val mac = GateIdentity.create("mac")
    val paired = Paired(pairedFile()).apply { add(mac.fp, "mac") }
    // auto mode: no v1 secret, no pairing code
    val tls = Gate.TlsServer(worker, paired, null)
    val gate = Gate.Server(port, null, { ch -> if (ch == "rpc") echo.localPort else null }, null, tls)
    gate.start()
    try {
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(mac, worker.fp)))
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(GateIdentity.create("stranger"), worker.fp, "0123456789abcdef")))
      // the old shared-secret protocol is closed
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "any-secret", "rpc"))
    } finally { gate.stop() }
  }

  @Test
  fun aScannedComputersCodePairsOnlyThatComputer() {
    val echo = echo()
    val port = freePort()
    val worker = GateIdentity.create("worker")
    val mac = GateIdentity.create("mac")
    val thief = GateIdentity.create("thief")
    var used = 0
    val tls = Gate.TlsServer(worker, Paired(pairedFile()), null, { used++ })
    val pin = "0123456789abcdef"
    tls.open(pin, System.currentTimeMillis() + 60_000, mac.fp)
    val gate = Gate.Server(port, null, { ch -> if (ch == "rpc") echo.localPort else null }, null, tls)
    gate.start()
    try {
      // someone who photographed the QR has the code but not the computer's certificate
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(thief, "", pin)))
      assertEquals(0, used)
      assertEquals(pin, tls.pin) // still open for the computer
      // the computer learns the phone's certificate ("" = learn) and pairs with the code
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(mac, "", pin)))
      assertEquals(1, used)
      assertNull(tls.pin)
      assertNull(tls.pinFor)
      assertTrue(tls.paired.contains(mac.fp))
      assertFalse(tls.paired.contains(thief.fp))
      // spent: the same code does nothing for anyone else, the computer needs none any more
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(thief, "", pin)))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(mac, worker.fp)))
    } finally { gate.stop() }
  }

  @Test
  fun aScannedComputersCodeRunsOut() {
    val echo = echo()
    val port = freePort()
    val worker = GateIdentity.create("worker")
    val mac = GateIdentity.create("mac")
    val tls = Gate.TlsServer(worker, Paired(pairedFile()), null)
    tls.open("0123456789abcdef", System.currentTimeMillis() - 1, mac.fp)
    val gate = Gate.Server(port, null, { ch -> if (ch == "rpc") echo.localPort else null }, null, tls)
    gate.start()
    try {
      assertEquals("gate: NO pin expired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(mac, "", "0123456789abcdef")))
      assertNull(tls.pin)
      assertFalse(tls.paired.contains(mac.fp))
    } finally { gate.stop() }
  }
}
