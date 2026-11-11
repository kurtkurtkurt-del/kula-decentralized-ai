package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import java.security.MessageDigest

/**
 * "This phone's owner cannot see the work" (11.11.2026, docs/AUDIT.md "owner-blind"): the
 * answer to GET /trust?challenge=<64 hex>. The phone makes a fresh key in its keystore with
 * an attestation challenge, and hands over that key's certificate chain: the keystore's own
 * statement, signed up to Google's attestation root, of where the key lives (TEE, StrongBox),
 * whether the bootloader is locked and verified boot green, and which app (package and
 * signing certificate) asked for the key. The computer checks it (node/src/attest.ts); the
 * phone only produces it.
 *
 * Why a fresh key: the challenge goes into a key's attestation when the key is made, so the
 * device key (made once, long ago) cannot answer a new question. The fresh key signs nothing;
 * it is deleted once its chain is read. Two things tie it to this device:
 *  - its attestation challenge is sha256("kula-attest-1\n" + challenge + "\n" + device id), so
 *    another phone running kula cannot lend its proof (its kula would put its own id in);
 *  - the device key signs "kula-attest-1\n" + challenge + "\n" + sha256(leaf certificate).
 *
 *   {"v":1,"chain":["<base64 der>", … leaf first, root last],"sig":"<base64>"}
 *   {"v":1,"error":"<why there is no proof>"}
 *
 * Plain Kotlin: JVM-tested in AttestTest.kt. The keystore half is KeyStoreAttester.kt.
 */
object Attest {
  const val PREFIX = "kula-attest-1"
  private val CHALLENGE = Regex("[0-9a-f]{64}")

  /** Makes a fresh attested key with [challenge] as its attestation challenge and returns its chain (DER, leaf first). */
  fun interface Attester {
    fun chain(challenge: ByteArray): List<ByteArray>
  }

  fun challengeOk(hex: String?): Boolean = hex != null && CHALLENGE.matches(hex)

  /** What the fresh key's attestation challenge is: the computer's question and this device's id. */
  fun keyChallenge(challengeHex: String, deviceId: String): ByteArray = sha256("$PREFIX\n$challengeHex\n$deviceId".toByteArray(Charsets.UTF_8))

  /** What the device key signs: the question and the leaf certificate it answered with. */
  fun bindMessage(challengeHex: String, leafDer: ByteArray): ByteArray = "$PREFIX\n$challengeHex\n${hex(sha256(leafDer))}".toByteArray(Charsets.UTF_8)

  /** The `attest` field of GET /trust for [challengeHex] (checked by the caller). Never throws. */
  fun answer(challengeHex: String, key: DeviceKey, attester: Attester?): Map<String, Any?> {
    if (attester == null) return error("no keystore on this device")
    val chain = try { attester.chain(keyChallenge(challengeHex, key.id)) } catch (e: Exception) {
      return error("the keystore made no proof: ${e.message ?: e.javaClass.simpleName}".take(200))
    }
    if (chain.size < 2) return error("the keystore gave no certificate chain (no key attestation on this phone)")
    val sig = try { key.sign(bindMessage(challengeHex, chain[0])) } catch (e: Exception) {
      return error("the device key could not sign: ${e.message ?: e.javaClass.simpleName}".take(200))
    }
    return linkedMapOf("v" to 1, "chain" to chain.map { B64.encode(it) }, "sig" to B64.encode(sig))
  }

  private fun error(why: String): Map<String, Any?> = linkedMapOf("v" to 1, "error" to why)

  private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}
