package expo.modules.kulallama

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec

/**
 * The keystore half of [Attest]: a fresh EC P-256 key under its own alias with the
 * challenge as its attestation challenge, its certificate chain read, the key deleted. One at
 * a time (both of the app's processes share the alias; a worker answers /trust in one of
 * them). In the TEE: StrongBox would be stronger still, but making a key there takes seconds
 * and what the computer asks for (hardware-backed, locked, verified boot, the app) the TEE
 * already proves.
 */
object KeyStoreAttester : Attest.Attester {
  private const val ALIAS = "kula-attest"
  private const val PROVIDER = "AndroidKeyStore"

  @Synchronized
  override fun chain(challenge: ByteArray): List<ByteArray> {
    val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
    try {
      val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge)
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
      return ks.getCertificateChain(ALIAS)?.map { it.encoded } ?: emptyList()
    } finally {
      runCatching { ks.deleteEntry(ALIAS) }
    }
  }
}
