package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.SoftwareKey
import expo.modules.kulallama.audit.VaultKey
import java.io.File
import java.io.RandomAccessFile
import java.security.KeyFactory
import java.security.KeyPair
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * Where a P-256 signing key can live outside a file: the Android KeyStore on a phone
 * (KeyStoreVault.kt), a map in the tests. A pair it returns has the vault's private key,
 * which may not be exportable: nothing may ask it for `.encoded`.
 */
interface KeyVault {
  /** The pair under [alias]; null when there is none. */
  fun get(alias: String): KeyPair?
  /** A new P-256 signing key under [alias]. */
  fun generate(alias: String): KeyPair
  /** Stores [pair] under [alias] with the certificate [certDer] as its chain; returns the stored pair. */
  fun import(alias: String, pair: KeyPair, certDer: ByteArray): KeyPair
  fun delete(alias: String)
}

/**
 * The device key and the gate key, found or made in one place, used by both processes
 * (WorkerService and KulaLlamaModule). The order, for the device key:
 *   the keystore has "kula-device" -> that key;
 *   else a P-256 key file -> imported into the keystore as is (same public key, so the same
 *     device id and, the gate certificate being kept, the same fingerprint masters pinned),
 *     one signature checked against the old public key, then the file deleted; when any of
 *     that fails the file stays and is used;
 *   else an Ed25519 key file -> kept (the keystore cannot take it; moving would change the id);
 *   else -> a new key in the keystore (in a file when there is no keystore).
 * The gate key (a P-256 key next to an Ed25519 device key) goes the same way under "kula-gate".
 * Both processes may start at once: a file lock (and a lock in the process) makes one wait
 * for the other, so a key is never made twice.
 */
object Keys {
  const val DEVICE_ALIAS = "kula-device"
  const val GATE_ALIAS = "kula-gate"
  const val KEYSTORE = "keystore"
  const val FILE = "file"

  /** A device key, its JCA pair (the private half may be a keystore key) and where it lives. */
  class Held(val key: DeviceKey, val pair: KeyPair, val store: String) {
    val alg: String get() = key.alg
  }

  private val inProcess = Any()

  /**
   * The device key for [file] (WorkerService.deviceKeyFile) and [vault] (null: files only).
   * [log] hears every move and every failure. A key file that was not a key is moved aside
   * (SoftwareKey.load) and noted next to it, so the worker can write it to the ledger
   * ([takeReplaced]) whichever process found it.
   */
  fun device(file: File, vault: KeyVault?, log: (String) -> Unit = {}): Held = locked(file) {
    val onBroken = { aside: File ->
      log("device key file was not a key: moved to ${aside.name}, a new key follows")
      noteReplaced(file, aside)
    }
    // a keystore that cannot even be read this time is not used this time: making a key in it
    // could replace one that is there, and a file key is never moved in over it either
    var usable = vault
    val stored = if (usable == null) null else try { usable.get(DEVICE_ALIAS) } catch (e: Exception) {
      log("keystore unreadable (${e.message}): the key file this time"); usable = null; null
    }
    if (stored != null) return@locked Held(VaultKey(DEVICE_ALIAS, stored), stored, KEYSTORE)
    val v = usable
    if (v == null) {
      val k = SoftwareKey.loadOrCreate(file, onBroken)
      return@locked Held(k, k.keyPair, FILE)
    }
    val soft = SoftwareKey.load(file, onBroken)
    if (soft != null) {
      if (soft.alg != DeviceKey.P256) return@locked Held(soft, soft.keyPair, FILE)
      val moved = move(v, DEVICE_ALIAS, soft.keyPair, soft.id, log)
      if (moved == null) return@locked Held(soft, soft.keyPair, FILE)
      if (!file.delete()) log("device key: in the keystore now, but the file could not be deleted")
      log("device key moved into the keystore (id ${soft.id})")
      return@locked Held(VaultKey(DEVICE_ALIAS, moved), moved, KEYSTORE)
    }
    try {
      val pair = v.generate(DEVICE_ALIAS)
      Held(VaultKey(DEVICE_ALIAS, pair), pair, KEYSTORE)
    } catch (e: Exception) {
      log("keystore could not make the device key (${e.message}): a key file instead")
      val k = SoftwareKey.loadOrCreate(file, onBroken)
      Held(k, k.keyPair, FILE)
    }
  }

  /**
   * The P-256 gate key that stands next to an Ed25519 device key ([file]: files/gate/gate_key),
   * the same order as [device] under [GATE_ALIAS]; [cn] names the certificate the import needs.
   */
  fun gate(file: File, vault: KeyVault?, cn: String, log: (String) -> Unit = {}): Pair<KeyPair, String> = locked(file) {
    // as for the device key: a keystore that cannot be read is left alone this time
    var usable = vault
    val stored = if (usable == null) null else try { usable.get(GATE_ALIAS) } catch (e: Exception) {
      log("keystore unreadable (${e.message}): the gate key file this time"); usable = null; null
    }
    if (stored != null) return@locked stored to KEYSTORE
    val v = usable
    val soft = readP256(file)
    if (soft != null) {
      if (v == null) return@locked soft to FILE
      val moved = move(v, GATE_ALIAS, soft, cn, log) ?: return@locked soft to FILE
      if (!file.delete()) log("gate key: in the keystore now, but the file could not be deleted")
      log("gate key moved into the keystore")
      return@locked moved to KEYSTORE
    }
    if (v != null) {
      try { return@locked v.generate(GATE_ALIAS) to KEYSTORE } catch (e: Exception) { log("keystore could not make the gate key (${e.message}): a key file instead") }
    }
    // no keystore: a software key in the file, which is exportable by nature
    val pair = GateCert.newP256()
    file.parentFile?.mkdirs()
    file.writeText("${DeviceKey.P256}\n${B64.encode(pair.private.encoded)}\n${B64.encode(pair.public.encoded)}\n")
    pair to FILE
  }

  /**
   * Puts [pair] (a software key) under [alias] and checks it: the same public key comes back
   * and a signature by the stored key verifies against the old public key. null (and the
   * alias removed again) when anything fails.
   */
  private fun move(vault: KeyVault, alias: String, pair: KeyPair, cn: String, log: (String) -> Unit): KeyPair? = try {
    val stored = vault.import(alias, pair, GateCert.selfSigned(pair, cn))
    if (!stored.public.encoded.contentEquals(pair.public.encoded)) throw IllegalStateException("the keystore gave back another public key")
    val msg = "kula key move ${System.currentTimeMillis()}".toByteArray()
    val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(stored.private); update(msg) }.sign()
    val ok = Signature.getInstance("SHA256withECDSA").apply { initVerify(pair.public); update(msg) }.verify(sig)
    if (!ok) throw IllegalStateException("a signature by the stored key did not verify")
    stored
  } catch (e: Exception) {
    log("$alias: could not move the key into the keystore (${e.message}); the file stays in use")
    runCatching { vault.delete(alias) }
    null
  }

  /** The gate key file's pair (alg, PKCS8, public key in base64 lines); null when absent or not a P-256 key. */
  private fun readP256(file: File): KeyPair? {
    if (!file.exists()) return null
    return runCatching {
      val lines = file.readLines()
      if (lines.size < 3 || lines[0].trim() != DeviceKey.P256) return null
      val kf = KeyFactory.getInstance("EC")
      KeyPair(kf.generatePublic(X509EncodedKeySpec(B64.decode(lines[2]))), kf.generatePrivate(PKCS8EncodedKeySpec(B64.decode(lines[1]))))
    }.getOrNull()
  }

  // --- a replaced key, noted for the ledger ---------------------------------------------

  private fun noteFile(file: File) = File(file.parentFile, file.name + ".replaced")

  private fun noteReplaced(file: File, aside: File) {
    runCatching { noteFile(file).appendText("${aside.name}\n") }
  }

  /**
   * The key files moved aside since the last call (their names), and the note cleared: the
   * worker writes each to its ledger as a `health` line with `key: "replaced"`.
   */
  fun takeReplaced(file: File): List<String> = locked(file) {
    val note = noteFile(file)
    if (!note.exists()) return@locked emptyList()
    val names = runCatching { note.readLines().map { it.trim() }.filter { it.isNotEmpty() } }.getOrDefault(emptyList())
    note.delete()
    names
  }

  /** [block] under the process lock and a file lock next to [file], so the app and the worker process take turns. */
  private fun <T> locked(file: File, block: () -> T): T = synchronized(inProcess) {
    file.parentFile?.mkdirs()
    val lockFile = File(file.parentFile, file.name + ".lock")
    val raf = runCatching { RandomAccessFile(lockFile, "rw") }.getOrNull() ?: return@synchronized block()
    raf.use { r ->
      val lock = runCatching { r.channel.lock() }.getOrNull()
      try { block() } finally { runCatching { lock?.release() } }
    }
  }
}
