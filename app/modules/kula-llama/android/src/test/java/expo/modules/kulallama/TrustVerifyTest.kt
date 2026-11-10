package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.Ledger
import expo.modules.kulallama.audit.SoftwareKey
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.security.Signature

// The phone as master checks a worker's GET /trust (TrustVerify.kt): real keys, a real gate
// certificate and real signed ledger lines; nothing is believed without checking. The twin on
// the computer is node/test/godseye-trust.test.ts.
class TrustVerifyTest {
  private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  private fun hash(line: String) = Ledger.sha256Hex(line.toByteArray(Charsets.UTF_8))

  /** A worker: its ledger key, its gate certificate (CN = its id), and [n] signed lines. */
  private class Worker(val key: SoftwareKey, n: Int) {
    val cert: GateIdentity = GateIdentity.create(key.id)
    val lines: List<String>
    init {
      val f = File(Files.createTempDirectory("kula-tv").toFile(), "ledger.jsonl")
      val l = Ledger(f, key, now = { 1_800_000_000_000L })
      repeat(n) { i -> l.append(if (i == 1) "reject" else "connect", "10.0.0.$i", mapOf("channel" to "api", "why" to "not paired")) }
      lines = f.readLines()
    }
    val pub: String get() = B64.encode(key.publicKey)
    val certB64: String get() = B64.encode(cert.certDer)
    fun check(lines: List<String> = this.lines, prev: String? = null, pin: String? = cert.fp, id: String? = key.id, certB64: String? = this.certB64, pub: String? = this.pub) =
      TrustVerify.check(pin, certB64, id, key.alg, pub, lines, prev)
  }

  private fun keys(): List<SoftwareKey> = listOfNotNull(
    SoftwareKey.generate(preferEd25519 = false),
    if (DeviceKey.ed25519Available()) SoftwareKey.generate(preferEd25519 = true) else null,
  )

  @Test fun everythingRightBothKeyKinds() {
    for (k in keys()) {
      val w = Worker(k, 4)
      val r = w.check()
      assertEquals(k.alg, true, r.certPinned)
      assertEquals(true, r.cnMatches)
      assertEquals(true, r.keyIdMatches)
      assertEquals(k.id, r.keyId)
      assertEquals(4, r.verified)
      assertEquals(hash(w.lines[3]), r.lastHash)
      assertNull(r.problem)
      // joined to the last line verified at an earlier look
      val later = w.check(w.lines.drop(2), prev = hash(w.lines[1]))
      assertEquals(2, later.verified)
      assertNull(later.problem)
      // the first line of a fresh ledger points at the genesis zeros
      assertNull(w.check(prev = Ledger.GENESIS).problem)
    }
  }

  @Test fun identityCaughtThreeWays() {
    val w = Worker(SoftwareKey.generate(preferEd25519 = false), 1)
    // another certificate than the one pinned from its qr
    assertEquals(false, w.check(pin = "ab".repeat(32)).certPinned)
    // the pin is compared without regard to case
    assertEquals(true, w.check(pin = w.cert.fp.uppercase()).certPinned)
    // a key that is not the id it claims
    assertEquals(false, w.check(id = "a".repeat(32)).keyIdMatches)
    // a certificate naming another device
    val other = GateIdentity.create("b".repeat(32))
    val r = w.check(certB64 = B64.encode(other.certDer), pin = other.fp)
    assertEquals(true, r.certPinned)
    assertEquals(false, r.cnMatches)
    // nothing to compare with: null, never true
    assertNull(w.check(pin = null).certPinned)
    assertNull(w.check(certB64 = null).certPinned)
    assertNull(w.check(certB64 = null).cnMatches)
    assertNull(w.check(id = null).keyIdMatches)
    // a certificate that is not one
    assertEquals(false, w.check(certB64 = B64.encode(byteArrayOf(1, 2, 3)), pin = null).cnMatches)
  }

  @Test fun aChangedLineAForgedSignatureADroppedLine() {
    for (k in keys()) {
      val w = Worker(k, 4)
      // a changed line: its signature no longer holds
      val changed = w.lines.toMutableList().also { it[2] = it[2].replace("\"connect\"", "\"reject\"") }
      w.check(changed).let {
        assertEquals(TrustVerify.SIG, it.problem)
        assertEquals(2, it.verified)
        assertEquals(hash(w.lines[1]), it.lastHash)
        assertEquals(hash(changed[2]), it.problemLine)
      }
      // a dropped line: the chain is broken
      w.check(listOf(w.lines[0], w.lines[2], w.lines[3])).let {
        assertEquals(TrustVerify.CHAIN, it.problem)
        assertEquals(1, it.verified)
      }
      // a line signed by someone else, put in the chain where it fits
      val stranger = Ledger.sign(w.lines[1].substringBefore(",\"sig\":") + "}", SoftwareKey.generate(preferEd25519 = false))
      assertEquals(TrustVerify.SIG, w.check(listOf(w.lines[0], stranger)).problem)
      // the next look does not join the last line verified
      assertEquals(TrustVerify.CHAIN, w.check(w.lines.drop(2), prev = hash(w.lines[0])).problem)
      // not a ledger line, a line without a signature
      assertEquals(TrustVerify.JSON, w.check(listOf("{\"t\":1,")).problem)
      assertEquals(TrustVerify.NOSIG, w.check(listOf(w.lines[0].substringBefore(",\"sig\":") + "}")).problem)
      // a key that is not a key: nothing verifies
      w.check(pub = B64.encode(byteArrayOf(9, 9, 9))).let {
        assertEquals(TrustVerify.KEY, it.problem)
        assertEquals(0, it.verified)
        assertNull(it.lastHash)
      }
      // no lines: nothing to say
      w.check(emptyList()).let { assertEquals(0, it.verified); assertNull(it.problem); assertNull(it.lastHash) }
    }
  }

  @Test fun theSharedVectorsVerify() {
    val v = JSONObject(File("../tools/audit-vectors.json").readText())
    val k = v.getJSONObject("key")
    val arr = v.getJSONArray("lines")
    val lines = (0 until arr.length()).map { arr.getJSONObject(it).getString("line") }
    val r = TrustVerify.check(null, null, k.getString("id"), k.getString("alg"), B64.encode(hex(k.getString("public"))), lines, Ledger.GENESIS)
    assertNull(r.problem)
    assertEquals(2, r.verified)
    assertEquals(true, r.keyIdMatches)
    assertEquals(arr.getJSONObject(1).getString("sha256"), r.lastHash)
    // and by the RFC code alone, as on a phone whose JCA has no Ed25519
    val raw = TrustVerify.Ed25519.rawPublic(hex(k.getString("public")))!!
    for (line in lines) {
      val (body, _, sig) = Ledger.split(line)!!
      assertTrue(TrustVerify.Ed25519.verify(raw, body.toByteArray(Charsets.UTF_8), sig))
      assertFalse(TrustVerify.Ed25519.verify(raw, (body + " ").toByteArray(Charsets.UTF_8), sig))
    }
  }

  @Test fun ed25519ByTheRfcAgreesWithTheJca() {
    // RFC 8032 section 7.1, test 1 (the empty message) and test 2 (one byte)
    assertTrue(TrustVerify.Ed25519.verify(
      hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"), ByteArray(0),
      hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ))
    assertTrue(TrustVerify.Ed25519.verify(
      hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"), hex("72"),
      hex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ))
    if (!DeviceKey.ed25519Available()) return
    val g = KeyPairGenerator.getInstance("Ed25519")
    repeat(5) { i ->
      val kp = g.generateKeyPair()
      val raw = TrustVerify.Ed25519.rawPublic(kp.public.encoded)!!
      val msg = "line $i".repeat(i * 7 + 1).toByteArray()
      val sig = Signature.getInstance("Ed25519").apply { initSign(kp.private); update(msg) }.sign()
      assertTrue(TrustVerify.Ed25519.verify(raw, msg, sig))
      val bent = sig.clone().also { it[i * 9] = (it[i * 9].toInt() xor 1).toByte() }
      assertFalse(TrustVerify.Ed25519.verify(raw, msg, bent))
      assertFalse(TrustVerify.Ed25519.verify(raw, msg + byteArrayOf(1), sig))
      // s >= L is refused (a malleated signature)
      val big = sig.clone().also { for (j in 32 until 64) it[j] = 0xff.toByte() }
      assertFalse(TrustVerify.Ed25519.verify(raw, msg, big))
    }
    // not a point, wrong sizes
    assertFalse(TrustVerify.Ed25519.isPoint(ByteArray(32) { 0xff.toByte() }.also { it[31] = 0x7f }))
    assertNull(TrustVerify.Ed25519.rawPublic(ByteArray(40)))
  }
}
