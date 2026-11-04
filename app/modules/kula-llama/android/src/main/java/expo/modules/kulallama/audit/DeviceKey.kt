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

    fun ed25519Available(): Boolean = runCatching { KeyPairGenerator.getInstance("Ed25519") }.isSuccess

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
        return SoftwareKey(DeviceKey.ED25519, KeyPairGenerator.getInstance("Ed25519").generateKeyPair())
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
          val dec = java.util.Base64.getDecoder()
          return from(lines[0].trim(), dec.decode(lines[1].trim()), dec.decode(lines[2].trim()))
        }
      }
      val k = generate()
      val enc = java.util.Base64.getEncoder()
      file.parentFile?.mkdirs()
      file.writeText("${k.alg}\n${enc.encodeToString(k.pkcs8())}\n${enc.encodeToString(k.publicKey)}\n")
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
