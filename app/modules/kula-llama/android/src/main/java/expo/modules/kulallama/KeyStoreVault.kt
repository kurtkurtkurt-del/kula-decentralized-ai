package expo.modules.kulallama

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec

/**
 * The Android KeyStore as a [KeyVault] (Keys.kt): EC P-256 signing keys that never leave
 * it (hardware-backed where the phone has it). Both of the app's processes share the app's
 * uid, so both see the same aliases. Kept this small on purpose: everything else about the
 * keys is plain Kotlin and tested on the JVM.
 *
 * Digests: SHA-256 for the ledger and the certificates (SHA256withECDSA), and NONE because
 * the TLS stack (Conscrypt) hashes the handshake itself and asks the key to sign the digest
 * (NONEwithECDSA); a key without it cannot speak TLS.
 */
class KeyStoreVault : KeyVault {
  private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  override fun get(alias: String): KeyPair? {
    val ks = store()
    val key = ks.getKey(alias, null) as? PrivateKey ?: return null
    // the certificate's public key: its encoded form is the X.509 SubjectPublicKeyInfo, so the device id is the same formula as for a file
    val cert = ks.getCertificate(alias) ?: return null
    return KeyPair(cert.publicKey, key)
  }

  override fun generate(alias: String): KeyPair {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
    return get(alias) ?: throw IllegalStateException("keystore: $alias missing after generate")
  }

  override fun import(alias: String, pair: KeyPair, certDer: ByteArray): KeyPair {
    val protection = KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
      .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
      .build()
    store().setEntry(alias, KeyStore.PrivateKeyEntry(pair.private, arrayOf(GateCert.parse(certDer))), protection)
    return get(alias) ?: throw IllegalStateException("keystore: $alias missing after import")
  }

  override fun delete(alias: String) { store().deleteEntry(alias) }

  companion object {
    private const val PROVIDER = "AndroidKeyStore"
    private const val TAG = "kula-keys"

    /**
     * The one way both processes get their keys: the device key ([Keys.device]) with the
     * keystore, and the gate identity over it. Logs every move and failure.
     */
    fun deviceKey(file: java.io.File): Keys.Held =
      Keys.device(file, runCatching { KeyStoreVault() }.getOrNull()) { android.util.Log.i(TAG, it) }

    fun gateIdentity(dir: java.io.File, held: Keys.Held): GateIdentity =
      GateIdentity.loadOrCreate(dir, held.key, held.pair, runCatching { KeyStoreVault() }.getOrNull()) { android.util.Log.i(TAG, it) }
  }
}
