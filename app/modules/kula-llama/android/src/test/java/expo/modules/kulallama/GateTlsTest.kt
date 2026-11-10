package expo.modules.kulallama

import expo.modules.kulallama.audit.SoftwareKey
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPair
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.net.ssl.SSLSocket

// Protocol v2 (docs/GATE.md): the hand-written certificate, the pairing handshake inside TLS
// 1.3 over loopback, every refusal, and a v1 client against the same server. Node's twin
// (node/test/gate.test.ts) proves the same vectors from tools/gate-vectors.json.
class GateTlsTest {
  private val vectors = JSONObject(File("../tools/gate-vectors.json").readText())

  private fun echo(): ServerSocket {
    val echo = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    Thread { while (true) { val s = echo.accept(); Thread { runCatching { s.getInputStream().copyTo(s.getOutputStream()) }; runCatching { s.close() } }.start() } }.apply { isDaemon = true }.start()
    return echo
  }

  private fun freePort() = ServerSocket(0).use { it.localPort }
  private fun identity(cn: String) = GateIdentity.create(cn)

  @Test
  fun theCertificateParsesAndCarriesTheKey() {
    val id = identity("test-device")
    assertEquals("CN=test-device", id.cert.subjectX500Principal.name)
    assertEquals("CN=test-device", id.cert.issuerX500Principal.name)
    assertEquals(3, id.cert.version)
    assertEquals("EC", id.cert.publicKey.algorithm)
    id.cert.verify(id.keyPair.public) // the ecdsa signature over our TBS checks out
    id.cert.checkValidity()
    assertEquals(-1, id.cert.basicConstraints) // not a ca
    assertEquals(64, id.fp.length)
    assertEquals(GateCert.fingerprint(id.cert), id.fp)
  }

  @Test
  fun theTbsMatchesTheSharedVector() {
    // the same key, name, serial and dates on both sides give the same TBSCertificate bytes
    val v = vectors.getJSONObject("cert")
    val kf = KeyFactory.getInstance("EC")
    val pub = kf.generatePublic(X509EncodedKeySpec(hex(v.getString("spki"))))
    val tbs = GateCert.tbs(pub.encoded, v.getString("cn"), hex(v.getString("serial")), v.getLong("not_before_ms"), v.getLong("not_after_ms"))
    assertEquals(v.getString("tbs_sha256"), Gate.sha256Hex(tbs))
    // and a certificate signed with the matching private key parses with that name
    val priv = kf.generatePrivate(PKCS8EncodedKeySpec(hex(v.getString("pkcs8"))))
    val der = GateCert.selfSigned(KeyPair(pub, priv), v.getString("cn"), hex(v.getString("serial")), v.getLong("not_before_ms"), v.getLong("not_after_ms"))
    val cert = GateCert.parse(der)
    cert.verify(pub)
    assertEquals("CN=${v.getString("cn")}", cert.subjectX500Principal.name)
  }

  @Test
  fun thePinProofsMatchTheSharedVectors() {
    val arr = vectors.getJSONArray("v2")
    for (i in 0 until arr.length()) {
      val v = arr.getJSONObject(i)
      assertEquals(v.getString("proof_c"), Gate.pinProofClient(v.getString("pin"), v.getString("nonce_c"), v.getString("nonce_s"), v.getString("channel"), v.getString("fp_s"), v.getString("fp_c")))
      assertEquals(v.getString("proof_s"), Gate.pinProofServer(v.getString("pin"), v.getString("nonce_c"), v.getString("nonce_s"), v.getString("channel"), v.getString("fp_s"), v.getString("fp_c")))
    }
  }

  @Test
  fun identityIsKeptOnDiskAndFollowsTheDeviceKey() {
    val dir = java.nio.file.Files.createTempDirectory("kula-gate").toFile()
    val p256 = SoftwareKey.generate(preferEd25519 = false)
    val a = GateIdentity.loadOrCreate(dir, p256)
    assertEquals("CN=${p256.id}", a.cert.subjectX500Principal.name)
    assertTrue(a.keyPair.public.encoded.contentEquals(p256.publicKey)) // the device key is the tls key
    assertEquals(a.fp, GateIdentity.loadOrCreate(dir, p256).fp) // the same fingerprint after a restart
    // a different device key means a new certificate
    val other = SoftwareKey.generate(preferEd25519 = false)
    assertFalse(GateIdentity.loadOrCreate(dir, other).fp == a.fp)
    if (expo.modules.kulallama.audit.DeviceKey.ed25519Available()) {
      val ed = SoftwareKey.generate()
      val dir2 = java.nio.file.Files.createTempDirectory("kula-gate").toFile()
      val b = GateIdentity.loadOrCreate(dir2, ed)
      assertEquals("EC", b.keyPair.public.algorithm) // a separate p-256 gate key
      assertTrue(File(dir2, "gate_key").exists())
      assertEquals(b.fp, GateIdentity.loadOrCreate(dir2, ed).fp)
    }
  }

  @Test
  fun pairingThenPinnedOnlyOverLoopback() {
    val echo = echo()
    val port = freePort()
    val server = identity("worker")
    val master = identity("master")
    val pairedFile = File(java.nio.file.Files.createTempDirectory("kula-gate").toFile(), "paired")
    val pin = Gate.newPin()
    var pinUsed = 0
    val tls = Gate.TlsServer(server, Paired(pairedFile), pin, { pinUsed++ })
    val events = mutableListOf<Gate.Event>()
    val gate = Gate.Server(port, "v1-secret", { ch -> if (ch == "rpc") echo.localPort else null }, null, tls) { events.add(it) }
    gate.start()
    try {
      // before pairing, a client without the code is not let in
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp)))
      // the wrong code
      assertEquals("gate: NO wrong pin", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp, "0000000000000000")))
      assertEquals(0, pinUsed)
      // the right code pairs and spends it
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp, pin)))
      assertEquals(1, pinUsed)
      assertNull(tls.pin)
      assertTrue(tls.paired.contains(master.fp))
      assertTrue(pairedFile.readText().startsWith(master.fp))
      assertTrue(events.any { it.kind == "pair" && it.fp == master.fp && it.v == 2 })
      // from now on the certificate alone is enough, with or without the (spent) code
      assertNull(Gate.probe("127.0.0.1", port, "", "api".let { "rpc" }, tls = Gate.TlsClient(master, server.fp)))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp, pin)))
      // a stranger with a different certificate is not
      assertEquals("gate: NO not paired", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(identity("stranger"), server.fp)))
      // the wrong fingerprint for the worker never gets to the hello
      assertEquals("gate: fingerprint mismatch", Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, "ab".repeat(32))))
      // a closed channel still answers inside tls
      assertEquals("gate: NO channel closed", Gate.probe("127.0.0.1", port, "", "api", tls = Gate.TlsClient(master, server.fp)))
      // bytes flow both ways through the tls pipe
      Socket("127.0.0.1", port).use { raw ->
        val s = Gate.handshake(raw, "", "rpc", Gate.TlsClient(master, server.fp))
        assertTrue(s is SSLSocket)
        assertEquals("TLSv1.3", (s as SSLSocket).session.protocol)
        val payload = ByteArray(300_000).also { java.util.Random(7).nextBytes(it) }
        Thread { s.getOutputStream().write(payload); s.getOutputStream().flush() }.start()
        val got = ByteArray(payload.size); var n = 0
        while (n < got.size) { val r = s.getInputStream().read(got, n, got.size - n); if (r < 0) break; n += r }
        assertTrue(payload.contentEquals(got))
        s.close()
      }
      // the paired list survives a restart of the gate
      assertTrue(Paired(pairedFile).contains(master.fp))
      // and v1 is off on the same port now that a master is paired, right secret or not
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "v1-secret", "rpc"))
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "wrong", "rpc"))
      assertTrue(events.any { it.kind == "connect" && it.v == 2 } && events.none { it.kind == "connect" && it.v == 1 })
      assertTrue(events.any { it.kind == "reject" && it.why == "wrong pin" })
    } finally {
      gate.stop(); echo.close()
    }
  }

  @Test
  fun v1IsOffOnceAnythingIsPaired() {
    val echo = echo()
    val port = freePort()
    val server = identity("worker")
    val master = identity("master")
    val key = SoftwareKey.generate()
    val ledgerFile = File(java.nio.file.Files.createTempDirectory("kula-ledger").toFile(), "ledger.jsonl")
    val auditor = expo.modules.kulallama.audit.Auditor(expo.modules.kulallama.audit.Ledger(ledgerFile, key), key)
    val pin = Gate.newPin()
    val tls = Gate.TlsServer(server, Paired(null), pin)
    val gate = Gate.Server(port, "v1-secret", { ch -> if (ch == "rpc") echo.localPort else null }, auditor, tls)
    gate.start()
    try {
      // before any pairing an old master with the v2 qr (the secret) still gets in
      assertTrue(gate.v1Open())
      assertNull(Gate.probe("127.0.0.1", port, "v1-secret", "rpc"))
      // one master pairs over v2
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp, pin)))
      assertEquals(1, gate.pairedCount)
      // from now on v1 is refused for everyone: it has no identity to tell masters apart
      assertFalse(gate.v1Open())
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "v1-secret", "rpc"))
      // the paired master still gets in
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp)))
      // the refusal is in the ledger (the gate writes it before it answers)
      val rejects = ledgerFile.readLines().map { JSONObject(it) }.filter { it.getString("kind") == "reject" }
      assertEquals(listOf("no v1"), rejects.map { it.getString("why") })
      assertEquals(-1, expo.modules.kulallama.audit.Ledger.verify(ledgerFile, key.publicKey, key.alg))
      // forgetting the last paired master opens v1 again
      tls.paired.forget(master.fp)
      assertTrue(gate.v1Open())
    } finally {
      gate.stop(); echo.close()
    }
  }

  @Test
  fun aServerWithoutASecretNeverHearsV1() {
    val port = freePort()
    val gate = Gate.Server(port, null, { null }, null, Gate.TlsServer(identity("w"), Paired(null), null))
    gate.start()
    try {
      assertFalse(gate.v1Open())
      assertEquals("gate: NO no v1", Gate.probe("127.0.0.1", port, "x", "rpc"))
    } finally { gate.stop() }
  }

  @Test
  fun aKeyThatCannotBeExportedStillSpeaksTls() {
    // the android keystore's keys have no encoded form: the gate's key managers must not need one
    val echo = echo()
    val port = freePort()
    fun sealed(cn: String): GateIdentity {
      val p = GateCert.newP256()
      return GateIdentity.create(cn, KeyPair(p.public, KeysTest.NoExport(p.private as java.security.interfaces.ECPrivateKey)))
    }
    val server = sealed("worker")
    val master = sealed("master")
    assertNull(server.keyPair.private.encoded)
    val pin = Gate.newPin()
    val gate = Gate.Server(port, null, { echo.localPort }, null, Gate.TlsServer(server, Paired(null), pin))
    gate.start()
    try {
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp, pin)))
      assertNull(Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(master, server.fp)))
    } finally { gate.stop(); echo.close() }
  }

  @Test
  fun replayAndOldClocksAreRefusedInsideTls() {
    val echo = echo()
    val port = freePort()
    val server = identity("worker")
    val master = identity("master")
    val tls = Gate.TlsServer(server, Paired(null).also { it.add(master.fp) }, null)
    val gate = Gate.Server(port, "s", { echo.localPort }, null, tls)
    gate.start()
    try {
      val nonce = "0123456789abcdef0123456789abcdef"
      fun hello(line: String): String {
        val raw = Socket("127.0.0.1", port)
        val ctx = javax.net.ssl.SSLContext.getInstance("TLS")
        ctx.init(master.keyManagers(), arrayOf(Gate.PinnedTrust(server.fp)), null)
        val s = ctx.socketFactory.createSocket(raw, "127.0.0.1", port, true) as SSLSocket
        s.enabledProtocols = arrayOf("TLSv1.3")
        s.startHandshake()
        s.getOutputStream().write("$line\n".toByteArray()); s.getOutputStream().flush()
        val sb = StringBuilder()
        while (true) { val b = s.getInputStream().read(); if (b < 0 || b == '\n'.code) break; sb.append(b.toChar()) }
        s.close()
        return sb.toString()
      }
      val now = System.currentTimeMillis()
      assertTrue(hello("KULA2 rpc $nonce $now").endsWith(" paired"))
      assertEquals("NO replay", hello("KULA2 rpc $nonce $now"))
      assertEquals("NO clock", hello("KULA2 rpc ${Gate.randomHex(16)} ${now - 10 * 60_000}"))
      assertEquals("NO bad hello", hello("KULA2 rpc ${Gate.randomHex(16)}")) // v2 needs the clock
      assertEquals("NO bad hello", hello("KULA1 rpc ${Gate.randomHex(16)} $now")) // v1 inside tls is not a thing
      assertEquals("NO bad channel", hello("KULA2 ftp ${Gate.randomHex(16)} $now"))
      assertEquals("NO bad nonce", hello("KULA2 rpc xyz $now"))
    } finally {
      gate.stop(); echo.close()
    }
  }

  @Test
  fun aServerWithoutTlsTellsATlsClientSo() {
    val port = freePort()
    val gate = Gate.Server(port, "s", { null })
    gate.start()
    try {
      val why = Gate.probe("127.0.0.1", port, "", "rpc", tls = Gate.TlsClient(identity("m"), "ab".repeat(32)))
      assertNotNull(why)
      assertTrue(why!!.startsWith("gate: tls"))
    } finally { gate.stop() }
  }

  private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
