package expo.modules.kulallama.audit

import java.io.File
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * The device's identity for the audit ledger: a signing key and the id derived from it.
 * Ed25519 where the JVM has it (JDK 15 and up, every Android that runs us), EC P-256 as the
 * fallback. The public key is always its X.509 SubjectPublicKeyInfo bytes, so the id is the
 * same no matter which library made the key.
 */
interface DeviceKey {
  /** "ed25519" or "p256" */
  val alg: String
  /** X.509 (SubjectPublicKeyInfo) encoded public key */
  val publicKey: ByteArray
  /** first 16 bytes of SHA-256(publicKey), lowercase hex */
  val id: String get() = idOf(publicKey)
  fun sign(bytes: ByteArray): ByteArray

  companion object {
    const val ED25519 = "ed25519"
    const val P256 = "p256"

    fun idOf(publicKey: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(publicKey).copyOf(16).joinToString("") { "%02x".format(it) }

    /** The JCA names behind our short algorithm names: (Signature algorithm, KeyFactory algorithm). */
    fun jcaNames(alg: String): Pair<String, String> = when (alg) {
      ED25519 -> "Ed25519" to "Ed25519"
      P256 -> "SHA256withECDSA" to "EC"
      else -> throw IllegalArgumentException("unknown key algorithm $alg")
    }

    /**
     * Ed25519 that really works here: a key made, a line signed and checked. 8.11.2026: on
     * Android 15 the only Ed25519 KeyPairGenerator in an app process is AndroidKeyStore's, which
     * throws "Not initialized" without a keystore spec, and no provider signs with a software
     * Ed25519 key; asking getInstance() alone said yes, so a fresh install could not make its
     * device key and share this phone failed. Asked once per process.
     */
    fun ed25519Available(): Boolean = ed25519Works

    private val ed25519Works: Boolean by lazy {
      runCatching {
        val kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val msg = "kula".toByteArray()
        val sig = java.security.Signature.getInstance("Ed25519").apply { initSign(kp.private); update(msg) }.sign()
        java.security.Signature.getInstance("Ed25519").apply { initVerify(kp.public); update(msg) }.verify(sig)
      }.getOrDefault(false)
    }

    fun decodePublic(alg: String, publicKey: ByteArray): PublicKey =
      KeyFactory.getInstance(jcaNames(alg).second).generatePublic(X509EncodedKeySpec(publicKey))

    /** True when [sig] is a valid signature by [publicKey] over [bytes]; false on any error. */
    fun verify(alg: String, publicKey: ByteArray, bytes: ByteArray, sig: ByteArray): Boolean = runCatching {
      Signature.getInstance(jcaNames(alg).first).apply { initVerify(decodePublic(alg, publicKey)); update(bytes) }.verify(sig)
    }.getOrDefault(false)
  }
}

/**
 * A key that lives in memory, optionally persisted as a PKCS8 file. Used by tests and by the
 * worker's own process, which has no reason to share a key store with the app.
 */
class SoftwareKey private constructor(override val alg: String, private val pair: KeyPair) : DeviceKey {
  override val publicKey: ByteArray get() = pair.public.encoded
  /** The JCA pair itself: the gate's TLS identity (GateIdentity) uses a P-256 device key directly. */
  val keyPair: KeyPair get() = pair

  override fun sign(bytes: ByteArray): ByteArray =
    Signature.getInstance(DeviceKey.jcaNames(alg).first).apply { initSign(pair.private); update(bytes) }.sign()

  /** PKCS8 bytes of the private key, for saving. */
  fun pkcs8(): ByteArray = pair.private.encoded

  fun save(file: File) {
    file.parentFile?.mkdirs()
    file.writeBytes(pkcs8())
  }

  companion object {
    /** A fresh key: Ed25519 when the JVM has it, else P-256. */
    fun generate(preferEd25519: Boolean = true): SoftwareKey {
      if (preferEd25519 && DeviceKey.ed25519Available()) {
        runCatching { KeyPairGenerator.getInstance("Ed25519").generateKeyPair() }.getOrNull()
          ?.let { return SoftwareKey(DeviceKey.ED25519, it) }
      }
      val g = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
      return SoftwareKey(DeviceKey.P256, g.generateKeyPair())
    }

    /**
     * Rebuilds a key from its PKCS8 private part and its X.509 public part. The JCA cannot
     * derive an Ed25519 public key from a seed on every JDK, so both halves are given.
     */
    fun from(alg: String, pkcs8: ByteArray, publicKey: ByteArray): SoftwareKey {
      val kf = KeyFactory.getInstance(DeviceKey.jcaNames(alg).second)
      val priv: PrivateKey = kf.generatePrivate(PKCS8EncodedKeySpec(pkcs8))
      return SoftwareKey(alg, KeyPair(DeviceKey.decodePublic(alg, publicKey), priv))
    }

    /**
     * Loads the key at [file] or makes one and saves it there. The file holds the algorithm
     * name, a newline, then base64 of the PKCS8 private key and base64 of the public key.
     */
    fun loadOrCreate(file: File): SoftwareKey {
      if (file.exists()) {
        val lines = file.readLines()
        if (lines.size >= 3) {
          return from(lines[0].trim(), B64.decode(lines[1]), B64.decode(lines[2]))
        }
      }
      val k = generate()
      file.parentFile?.mkdirs()
      file.writeText("${k.alg}\n${B64.encode(k.pkcs8())}\n${B64.encode(k.publicKey)}\n")
      return k
    }
  }
}

/**
 * A key kept in the Android KeyStore (hardware-backed where the phone has it). The Android
 * side implements this later; nothing in this package depends on it.
 * TODO(beyin): implement in kula-llama's Android code with KeyGenParameterSpec, alias "kula-device".
 */
interface KeyStoreKey : DeviceKey {
  /** the key store alias this key lives under */
  val alias: String
}
