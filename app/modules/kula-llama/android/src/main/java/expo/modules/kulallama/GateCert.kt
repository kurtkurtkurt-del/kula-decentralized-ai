package expo.modules.kulallama

import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.SoftwareKey
import java.io.ByteArrayInputStream
import java.io.File
import java.net.Socket
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/**
 * The gate's TLS identity (protocol v2, docs/GATE.md): an EC P-256 key and a self-signed
 * X.509 certificate written by hand in DER. There is no BouncyCastle in the app and the
 * JDK has no public certificate builder, so the ~60 lines of DER below replace a 7 MB
 * dependency. The certificate is the minimum TLS needs: v3, serial, ecdsa-with-SHA256,
 * CN=<device id> as issuer and subject, ten years, the key, basicConstraints CA:false.
 * Nothing verifies the chain; the other side pins SHA-256 of the DER (the "fp" in the qr).
 *
 * Why P-256 and not the Ed25519 device key: Android's TLS (Conscrypt) did not speak
 * Ed25519 certificates on every version we run on, P-256 works everywhere. When the
 * device key is itself P-256 it is the TLS key; an Ed25519 device key gets a separate
 * P-256 gate key next to it. The certificate names the device id either way.
 * node/src/tls.ts writes the same bytes; tools/gate-vectors.json has a TBS vector.
 */
object GateCert {
  private const val OID_CN = "2.5.4.3"
  private const val OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
  private const val OID_BASIC_CONSTRAINTS = "2.5.29.19"
  const val TEN_YEARS_MS = 10L * 365 * 24 * 3600 * 1000

  // --- a DER writer ---------------------------------------------------------------------
  object Der {
    fun tlv(tag: Int, body: ByteArray): ByteArray = byteArrayOf(tag.toByte()) + len(body.size) + body
    fun len(n: Int): ByteArray = when {
      n < 0x80 -> byteArrayOf(n.toByte())
      n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte())
      n < 0x10000 -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
      else -> byteArrayOf(0x83.toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())
    }
    fun seq(vararg parts: ByteArray) = tlv(0x30, concat(*parts))
    fun set(vararg parts: ByteArray) = tlv(0x31, concat(*parts))
    fun explicit(n: Int, body: ByteArray) = tlv(0xa0 or n, body)
    fun octets(b: ByteArray) = tlv(0x04, b)
    fun utf8(s: String) = tlv(0x0c, s.toByteArray(Charsets.UTF_8))
    /** A positive INTEGER from big-endian magnitude bytes (a leading zero is added when needed). */
    fun uint(magnitude: ByteArray): ByteArray {
      var m = magnitude.dropWhile { it == 0.toByte() }.toByteArray()
      if (m.isEmpty()) m = byteArrayOf(0)
      if (m[0] < 0) m = byteArrayOf(0) + m
      return tlv(0x02, m)
    }
    fun int(v: Long) = uint(java.math.BigInteger.valueOf(v).toByteArray())
    fun bits(b: ByteArray) = tlv(0x03, byteArrayOf(0) + b)
    fun oid(dotted: String): ByteArray {
      val p = dotted.split('.').map { it.toLong() }
      val out = java.io.ByteArrayOutputStream()
      out.write((p[0] * 40 + p[1]).toInt())
      for (i in 2 until p.size) {
        var v = p[i]
        val stack = ArrayList<Int>()
        do { stack.add((v and 0x7f).toInt()); v = v shr 7 } while (v > 0)
        for (j in stack.indices.reversed()) out.write(stack[j] or (if (j == 0) 0 else 0x80))
      }
      return tlv(0x06, out.toByteArray())
    }
    /** UTCTime, "YYMMDDHHMMSSZ"; the certificate's dates stay below 2050. */
    fun utcTime(ms: Long): ByteArray {
      val f = SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
      return tlv(0x17, f.format(Date(ms)).toByteArray(Charsets.US_ASCII))
    }
    fun concat(vararg parts: ByteArray): ByteArray {
      val out = ByteArray(parts.sumOf { it.size })
      var at = 0
      for (p in parts) { System.arraycopy(p, 0, out, at, p.size); at += p.size }
      return out
    }
  }

  private fun name(cn: String) = Der.seq(Der.set(Der.seq(Der.oid(OID_CN), Der.utf8(cn))))
  private fun sigAlg() = Der.seq(Der.oid(OID_ECDSA_SHA256))

  /** The TBSCertificate: everything but the signature. Deterministic for a given input. */
  fun tbs(spki: ByteArray, cn: String, serial: ByteArray, notBeforeMs: Long, notAfterMs: Long): ByteArray = Der.seq(
    Der.explicit(0, Der.int(2)),
    Der.uint(serial),
    sigAlg(),
    name(cn),
    Der.seq(Der.utcTime(notBeforeMs), Der.utcTime(notAfterMs)),
    name(cn),
    spki,
    Der.explicit(3, Der.seq(Der.seq(Der.oid(OID_BASIC_CONSTRAINTS), Der.octets(Der.seq())))),
  )

  /** A self-signed certificate (DER) for [pair], which must be EC P-256. */
  fun selfSigned(pair: KeyPair, cn: String, serial: ByteArray = randomSerial(), notBeforeMs: Long = System.currentTimeMillis() - 86_400_000L, notAfterMs: Long = notBeforeMs + TEN_YEARS_MS): ByteArray {
    val tbs = tbs(pair.public.encoded, cn, serial, notBeforeMs, notAfterMs)
    val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private); update(tbs) }.sign()
    return Der.seq(tbs, sigAlg(), Der.bits(sig))
  }

  fun randomSerial(): ByteArray = ByteArray(16).also { java.security.SecureRandom().nextBytes(it); it[0] = (it[0].toInt() and 0x7f).toByte() }

  fun parse(der: ByteArray): X509Certificate =
    CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

  /** The fingerprint both sides pin: lowercase hex SHA-256 of the certificate's DER. */
  fun fingerprint(der: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }
  fun fingerprint(cert: java.security.cert.Certificate): String = fingerprint(cert.encoded)

  fun newP256(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
}

/**
 * What a device shows on the wire in protocol v2: its P-256 key pair and the certificate
 * over it. [fp] is what goes into the qr. The key is the device key when that is P-256,
 * else a separate gate key (Keys.gate: the Android KeyStore, or gate_key in [dir]); the
 * certificate is kept in [dir] as gate_cert.der, so the fingerprint survives restarts and
 * both of the app's processes (the app and the ":worker") present the same identity.
 * The private key may live in the Android KeyStore and not be exportable: it goes to the
 * TLS stack as a key object ([OneKey]), never as bytes.
 */
class GateIdentity(val keyPair: KeyPair, val certDer: ByteArray) {
  val cert: X509Certificate = GateCert.parse(certDer)
  val fp: String = GateCert.fingerprint(certDer)

  /** Key managers that offer this one certificate to the TLS stack, as server or as client. */
  fun keyManagers(): Array<KeyManager> = arrayOf(OneKey(keyPair.private, arrayOf(cert)))

  /**
   * One EC key and its certificate for TLS, without a KeyStore in between: a PKCS12 store
   * would have to encode the private key, which a keystore key refuses. Conscrypt (Android)
   * and the JDK both take any X509ExtendedKeyManager; Conscrypt signs with a keystore key
   * through the keystore itself.
   */
  class OneKey(private val key: PrivateKey, private val chain: Array<X509Certificate>) : X509ExtendedKeyManager() {
    private fun fits(keyType: String?): Boolean = keyType == null || keyType.equals("EC", true) || keyType.startsWith("EC_", true)
    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = if (fits(keyType)) arrayOf(ALIAS) else null
    override fun chooseClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? = if (keyTypes == null || keyTypes.any { fits(it) }) ALIAS else null
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = if (fits(keyType)) arrayOf(ALIAS) else null
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = if (fits(keyType)) ALIAS else null
    override fun chooseEngineClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String? = chooseClientAlias(keyTypes, issuers, null)
    override fun chooseEngineServerAlias(keyType: String?, issuers: Array<out Principal>?, engine: SSLEngine?): String? = chooseServerAlias(keyType, issuers, null)
    override fun getCertificateChain(alias: String?): Array<X509Certificate>? = if (alias == ALIAS) chain.clone() else null
    override fun getPrivateKey(alias: String?): PrivateKey? = if (alias == ALIAS) key else null

    companion object { const val ALIAS = "kula-gate" }
  }

  companion object {
    /** A fresh identity; [cn] is the device id (DeviceKey.id). */
    fun create(cn: String, pair: KeyPair = GateCert.newP256()): GateIdentity = GateIdentity(pair, GateCert.selfSigned(pair, cn))

    /** For a software device key (the tests, and a phone without a keystore): files only. */
    fun loadOrCreate(dir: File, deviceKey: SoftwareKey): GateIdentity = loadOrCreate(dir, deviceKey, deviceKey.keyPair, null)

    /**
     * Loads the identity under [dir] or makes one. A P-256 [deviceKey] is used as the TLS key
     * itself ([devicePair], whose private key may be a keystore key); an Ed25519 one gets a
     * separate P-256 gate key (see GateCert and Keys.gate, in [vault] when there is one). A
     * stored certificate whose key no longer matches is replaced.
     */
    fun loadOrCreate(dir: File, deviceKey: DeviceKey, devicePair: KeyPair, vault: KeyVault?, log: (String) -> Unit = {}): GateIdentity {
      dir.mkdirs()
      val certFile = File(dir, "gate_cert.der")
      val pair: KeyPair = if (deviceKey.alg == DeviceKey.P256) devicePair else Keys.gate(File(dir, "gate_key"), vault, deviceKey.id, log).first
      if (certFile.exists()) {
        val der = certFile.readBytes()
        val ok = runCatching { GateCert.parse(der).publicKey.encoded.contentEquals(pair.public.encoded) }.getOrDefault(false)
        if (ok) return GateIdentity(pair, der)
      }
      val id = create(deviceKey.id, pair)
      certFile.writeBytes(id.certDer)
      return id
    }
  }
}

/**
 * The worker's record of the clients it has paired with (two-way TOFU): one certificate
 * fingerprint per line, with the time. A client on this list connects with its certificate
 * alone; any other needs the one-time pairing code from the qr.
 */
class Paired(private val file: File?) {
  private val fps = HashSet<String>()

  init {
    file?.takeIf { it.exists() }?.readLines()?.forEach { l -> l.trim().split(' ').firstOrNull()?.takeIf { it.length == 64 }?.let { fps.add(it) } }
  }

  @Synchronized fun contains(fp: String): Boolean = fp in fps
  @Synchronized fun size(): Int = fps.size

  @Synchronized
  fun add(fp: String, name: String? = null) {
    if (!fps.add(fp)) return
    file?.let { f -> f.parentFile?.mkdirs(); f.appendText("$fp ${System.currentTimeMillis()}${name?.let { " $it" } ?: ""}\n") }
  }

  @Synchronized
  fun forget(fp: String) {
    if (!fps.remove(fp)) return
    file?.let { f -> f.writeText(fps.joinToString("") { "$it\n" }) }
  }
}
