package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.Ledger
import org.json.JSONObject
import java.math.BigInteger
import java.security.MessageDigest

/**
 * The phone as master checks a worker's GET /trust (10.11.2026, docs/AUDIT.md "the security
 * report"): the same checks god's eye's trust branch does on the computer
 * (node/src/godseye/branches/trust.ts), the cryptographic half of them. Hermes has no Ed25519
 * or P-256 in JS, so the app hands the answer here (KulaLlamaModule.verifyTrust) and keeps the
 * verdict and its notes in JS (src/llm/trust.ts). Plain Kotlin: JVM-tested in TrustVerifyTest.kt.
 *
 *  - identity: the certificate the worker shows hashes to the fingerprint pinned from its qr,
 *    its key id is sha256(key)[:16] and is the id it claims, its CN names that same id
 *  - ledger: every line parses, its `prev` is the line before (the first one: [expectPrev], the
 *    last line verified at an earlier look; null when nothing was verified yet) and its
 *    signature holds under the worker's key. Stops at the first line that fails.
 */
object TrustVerify {
  /** Why a line does not hold; the JS side words them (src/llm/trust.ts). */
  const val JSON = "json"     // not a ledger line
  const val CHAIN = "chain"   // its prev is not the line before: a line changed, dropped or put in
  const val NOSIG = "nosig"   // no signature
  const val SIG = "sig"       // the signature does not match the device key
  const val KEY = "key"       // the device's key could not be read

  data class Result(
    /** the shown certificate is the pinned one; null with nothing to compare (no pin, no certificate) */
    val certPinned: Boolean?,
    /** the certificate's CN is the key's id; null without a certificate or key */
    val cnMatches: Boolean?,
    /** sha256(key)[:16] is the id the device claims; null without a key or id */
    val keyIdMatches: Boolean?,
    val keyId: String?,
    /** lines that held, from the first one on */
    val verified: Int,
    /** sha256 of the last line that held; null when none did */
    val lastHash: String?,
    val problem: String?,
    /** sha256 of the line that failed */
    val problemLine: String?,
  ) {
    fun toMap(): Map<String, Any?> = mapOf(
      "certPinned" to certPinned, "cnMatches" to cnMatches, "keyIdMatches" to keyIdMatches, "keyId" to keyId,
      "verified" to verified, "lastHash" to lastHash, "problem" to problem, "problemLine" to problemLine,
    )
  }

  private val CN = Regex("""CN=([0-9a-fA-F]{32})(?:,|$)""")

  fun check(pinnedFp: String?, certB64: String?, id: String?, alg: String?, pubB64: String?, lines: List<String>, expectPrev: String?): Result {
    val der = certB64?.let { runCatching { B64.decode(it) }.getOrNull() }
    val pub = pubB64?.let { runCatching { B64.decode(it) }.getOrNull() }
    val certPinned = if (der == null || pinnedFp.isNullOrEmpty()) null else GateCert.fingerprint(der) == pinnedFp.lowercase()
    val keyId = pub?.let { DeviceKey.idOf(it) }
    val keyIdMatches = if (keyId == null || id.isNullOrEmpty()) null else keyId == id.lowercase()
    val cnMatches = if (der == null || keyId == null) null else {
      val cn = runCatching { CN.find(GateCert.parse(der).subjectX500Principal.name)?.groupValues?.get(1)?.lowercase() }.getOrNull()
      cn == keyId
    }

    var verified = 0
    var last: String? = null
    var problem: String? = null
    var problemLine: String? = null
    val usable = pub != null && alg != null && keyUsable(alg, pub)
    for ((i, line) in lines.withIndex()) {
      val hash = Ledger.sha256Hex(line.toByteArray(Charsets.UTF_8))
      val why = if (!usable) KEY else lineProblem(line, alg!!, pub!!, if (i == 0) expectPrev else last)
      if (why != null) { problem = why; problemLine = hash; break }
      verified++
      last = hash
    }
    return Result(certPinned, cnMatches, keyIdMatches, keyId, verified, last, problem, problemLine)
  }

  /** Why [line] does not hold, or null: it parses, its prev is [expectPrev] (when one is expected) and its signature holds. */
  fun lineProblem(line: String, alg: String, pub: ByteArray, expectPrev: String?): String? {
    val obj = runCatching { JSONObject(line) }.getOrNull() ?: return JSON
    if (expectPrev != null && obj.optString("prev", "") != expectPrev) return CHAIN
    val (body, _, sig) = Ledger.split(line) ?: return NOSIG
    return if (verify(alg, pub, body.toByteArray(Charsets.UTF_8), sig)) null else SIG
  }

  /** The key decodes as [alg]: through the JCA, or for Ed25519 the bytes here. */
  fun keyUsable(alg: String, pub: ByteArray): Boolean = when (alg) {
    DeviceKey.ED25519 -> Ed25519.rawPublic(pub)?.let { Ed25519.isPoint(it) } == true
    DeviceKey.P256 -> runCatching { DeviceKey.decodePublic(alg, pub) }.isSuccess
    else -> false
  }

  /**
   * A signature check that works on every phone. P-256 is in every Android's JCA. Ed25519 is
   * not (8.11.2026: Android 15 offers it only inside the keystore), and kula-node's ledger keys
   * are Ed25519, so when the JCA cannot, [Ed25519] below checks it by the RFC.
   */
  fun verify(alg: String, pub: ByteArray, bytes: ByteArray, sig: ByteArray): Boolean {
    if (alg != DeviceKey.ED25519) return DeviceKey.verify(alg, pub, bytes, sig)
    val jca = runCatching {
      java.security.Signature.getInstance("Ed25519").apply { initVerify(DeviceKey.decodePublic(alg, pub)); update(bytes) }.verify(sig)
    }
    if (jca.isSuccess) return jca.getOrDefault(false)
    val raw = Ed25519.rawPublic(pub) ?: return false
    return Ed25519.verify(raw, bytes, sig)
  }

  /**
   * Ed25519 verification, RFC 8032 section 5.1.7, after its reference code: extended
   * coordinates, BigInteger arithmetic. Slow next to native code (some milliseconds a line),
   * which is fine for a ledger checked a page at a time off the main thread. Verify only:
   * nothing secret goes through it.
   */
  object Ed25519 {
    private val TWO: BigInteger = BigInteger.valueOf(2)
    private val P: BigInteger = TWO.pow(255) - BigInteger.valueOf(19)
    private val L: BigInteger = TWO.pow(252) + BigInteger("27742317777372353535851937790883648493")
    private val D: BigInteger = BigInteger.valueOf(-121665).mod(P) * BigInteger.valueOf(121666).modInverse(P) % P
    private val SQRT_M1: BigInteger = TWO.modPow((P - BigInteger.ONE).shiftRight(2), P)
    private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    private class Pt(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger)

    private val ZERO = Pt(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
    private val G: Pt = run {
      val y = BigInteger.valueOf(4) * BigInteger.valueOf(5).modInverse(P) % P
      val x = recoverX(y, 0)!!
      Pt(x, y, BigInteger.ONE, x * y % P)
    }

    /** The 32 key bytes out of an X.509 SubjectPublicKeyInfo (what /trust sends), or of 32 raw bytes. */
    fun rawPublic(pub: ByteArray): ByteArray? = when {
      pub.size == 32 -> pub
      pub.size == 44 && pub.copyOfRange(0, 12).contentEquals(SPKI_PREFIX) -> pub.copyOfRange(12, 44)
      else -> null
    }

    fun verify(key: ByteArray, msg: ByteArray, sig: ByteArray): Boolean {
      if (key.size != 32 || sig.size != 64) return false
      val a = decompress(key) ?: return false
      val rs = sig.copyOfRange(0, 32)
      val r = decompress(rs) ?: return false
      val s = le(sig.copyOfRange(32, 64))
      if (s >= L) return false
      val h = le(MessageDigest.getInstance("SHA-512").digest(rs + key + msg)) % L
      return equal(mul(s, G), add(r, mul(h, a)))
    }

    /** The 32 bytes are a point on the curve (a usable public key). */
    fun isPoint(b: ByteArray): Boolean = decompress(b) != null

    private fun decompress(b: ByteArray): Pt? {
      if (b.size != 32) return null
      val n = le(b)
      val sign = n.testBit(255).let { if (it) 1 else 0 }
      val y = n.clearBit(255)
      val x = recoverX(y, sign) ?: return null
      return Pt(x, y, BigInteger.ONE, x * y % P)
    }

    private fun recoverX(y: BigInteger, sign: Int): BigInteger? {
      if (y >= P) return null
      val x2 = ((y * y - BigInteger.ONE) * (D * y * y + BigInteger.ONE).modInverse(P)).mod(P)
      if (x2.signum() == 0) return if (sign == 1) null else BigInteger.ZERO
      var x = x2.modPow((P + BigInteger.valueOf(3)).shiftRight(3), P)
      if ((x * x - x2).mod(P).signum() != 0) x = x * SQRT_M1 % P
      if ((x * x - x2).mod(P).signum() != 0) return null
      if ((if (x.testBit(0)) 1 else 0) != sign) x = P - x
      return x
    }

    private fun add(p: Pt, q: Pt): Pt {
      val a = (p.y - p.x) * (q.y - q.x) % P
      val b = (p.y + p.x) * (q.y + q.x) % P
      val c = TWO * p.t * q.t * D % P
      val d = TWO * p.z * q.z % P
      val e = b - a
      val f = d - c
      val g = d + c
      val h = b + a
      return Pt((e * f).mod(P), (g * h).mod(P), (f * g).mod(P), (e * h).mod(P))
    }

    private fun mul(s: BigInteger, p: Pt): Pt {
      var q = ZERO
      var base = p
      for (i in 0 until s.bitLength()) {
        if (s.testBit(i)) q = add(q, base)
        base = add(base, base)
      }
      return q
    }

    private fun equal(p: Pt, q: Pt): Boolean =
      (p.x * q.z - q.x * p.z).mod(P).signum() == 0 && (p.y * q.z - q.y * p.z).mod(P).signum() == 0

    /** Little-endian bytes as an unsigned number. */
    private fun le(b: ByteArray): BigInteger = BigInteger(1, b.reversedArray())
  }
}
