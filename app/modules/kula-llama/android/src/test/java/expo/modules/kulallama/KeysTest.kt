package expo.modules.kulallama

import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.SoftwareKey
import expo.modules.kulallama.audit.VaultKey
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.math.BigInteger
import java.nio.file.Files
import java.security.KeyPair
import java.security.interfaces.ECPrivateKey
import java.security.spec.ECParameterSpec

// Keys.kt: the order in which the device key and the gate key are found, moved into the
// keystore or made, with a vault in a map standing in for the Android KeyStore (its keys
// cannot be exported, like the real one's). The keystore itself is only on a phone.
class KeysTest {
  /** An EC private key without an encoded form, the way an Android KeyStore key is. */
  class NoExport(private val k: ECPrivateKey) : ECPrivateKey {
    override fun getS(): BigInteger = k.s
    override fun getParams(): ECParameterSpec = k.params
    override fun getAlgorithm(): String = "EC"
    override fun getFormat(): String? = null
    override fun getEncoded(): ByteArray? = null
  }

  class MapVault(var failImport: Boolean = false, var failGenerate: Boolean = false, var lie: Boolean = false, var failGet: Boolean = false) : KeyVault {
    val keys = HashMap<String, KeyPair>()
    val certs = HashMap<String, ByteArray>()
    var generated = 0
    var imported = 0
    override fun get(alias: String): KeyPair? = if (failGet) throw IllegalStateException("keystore busy") else keys[alias]?.let { KeyPair(it.public, NoExport(it.private as ECPrivateKey)) }
    override fun generate(alias: String): KeyPair {
      if (failGenerate) throw IllegalStateException("no keystore")
      keys[alias] = GateCert.newP256(); generated++
      return get(alias)!!
    }
    override fun import(alias: String, pair: KeyPair, certDer: ByteArray): KeyPair {
      if (failImport) throw IllegalStateException("import refused")
      // the chain must be a certificate over the same key, as the keystore wants
      assertArrayEquals(pair.public.encoded, GateCert.parse(certDer).publicKey.encoded)
      keys[alias] = if (lie) GateCert.newP256() else KeyPair(pair.public, pair.private)
      certs[alias] = certDer; imported++
      return get(alias)!!
    }
    override fun delete(alias: String) { keys.remove(alias); certs.remove(alias) }
  }

  private fun dir(): File = Files.createTempDirectory("kula-keys").toFile()
  private fun signs(h: Keys.Held) {
    val msg = "beyin".toByteArray()
    assertTrue(DeviceKey.verify(h.alg, h.key.publicKey, msg, h.key.sign(msg)))
  }

  @Test fun aFreshPhoneMakesItsKeyInTheKeystore() {
    val f = File(dir(), "kula_device_key")
    val v = MapVault()
    val a = Keys.device(f, v)
    assertEquals(Keys.KEYSTORE, a.store)
    assertTrue(a.key is VaultKey)
    assertEquals(DeviceKey.P256, a.alg)
    assertFalse(f.exists())
    signs(a)
    // the next start (either process) finds the same key
    val b = Keys.device(f, v)
    assertEquals(a.key.id, b.key.id)
    assertEquals(1, v.generated)
  }

  @Test fun aP256KeyFileMovesIntoTheKeystoreWithTheSameIdAndFingerprint() {
    val d = dir()
    val f = File(d, "kula_device_key")
    val soft = SoftwareKey.generate(preferEd25519 = false)
    SoftwareKey.write(f, soft)
    // the gate certificate a master pinned before the move
    val before = GateIdentity.loadOrCreate(File(d, "gate"), soft)
    val v = MapVault()
    val log = ArrayList<String>()
    val h = Keys.device(f, v) { log.add(it) }
    assertEquals(Keys.KEYSTORE, h.store)
    assertEquals(soft.id, h.key.id)
    assertArrayEquals(soft.publicKey, h.key.publicKey)
    assertFalse("the file goes once the key is in the keystore", f.exists())
    assertEquals(1, v.imported)
    signs(h)
    // the stored key signs for the old public key
    val msg = byteArrayOf(7, 7)
    assertTrue(DeviceKey.verify(DeviceKey.P256, soft.publicKey, msg, h.key.sign(msg)))
    // same certificate, same fingerprint, now over a key that cannot be exported
    val after = GateIdentity.loadOrCreate(File(d, "gate"), h.key, h.pair, v)
    assertEquals(before.fp, after.fp)
    assertNull(after.keyPair.private.encoded)
    assertTrue(log.any { it.contains("moved into the keystore") })
  }

  @Test fun aMoveThatFailsKeepsTheFile() {
    for (v in listOf(MapVault(failImport = true), MapVault(lie = true))) {
      val f = File(dir(), "kula_device_key")
      val soft = SoftwareKey.generate(preferEd25519 = false)
      SoftwareKey.write(f, soft)
      val log = ArrayList<String>()
      val h = Keys.device(f, v) { log.add(it) }
      assertEquals(Keys.FILE, h.store)
      assertEquals(soft.id, h.key.id)
      assertTrue(f.exists())
      assertTrue("the half-made alias is removed again", v.keys.isEmpty())
      assertTrue(log.any { it.contains("the file stays in use") })
    }
  }

  @Test fun anEd25519KeyFileStaysAFile() {
    assumeTrue(DeviceKey.ed25519Available())
    val f = File(dir(), "kula_device_key")
    val soft = SoftwareKey.generate()
    SoftwareKey.write(f, soft)
    val v = MapVault()
    val h = Keys.device(f, v)
    assertEquals(Keys.FILE, h.store)
    assertEquals(DeviceKey.ED25519, h.alg)
    assertEquals(soft.id, h.key.id)
    assertTrue(f.exists())
    assertTrue(v.keys.isEmpty())
    // its separate gate key moves into the keystore as "kula-gate", keeping the fingerprint
    val gateDir = File(f.parentFile, "gate")
    val before = GateIdentity.loadOrCreate(gateDir, soft)
    assertTrue(File(gateDir, "gate_key").exists())
    val after = GateIdentity.loadOrCreate(gateDir, h.key, h.pair, v)
    assertEquals(before.fp, after.fp)
    assertFalse(File(gateDir, "gate_key").exists())
    assertTrue(v.keys.containsKey(Keys.GATE_ALIAS))
    assertEquals(after.fp, GateIdentity.loadOrCreate(gateDir, h.key, h.pair, v).fp)
  }

  @Test fun aGateKeyIsMadeInTheKeystoreWhenThereIsNone() {
    val d = dir()
    val v = MapVault()
    val (pair, store) = Keys.gate(File(d, "gate_key"), v, "id")
    assertEquals(Keys.KEYSTORE, store)
    assertNull(pair.private.encoded)
    assertFalse(File(d, "gate_key").exists())
    // no keystore: a file, as before
    val (p2, s2) = Keys.gate(File(d, "gate_key2"), null, "id")
    assertEquals(Keys.FILE, s2)
    assertTrue(File(d, "gate_key2").exists())
    assertArrayEquals(p2.public.encoded, Keys.gate(File(d, "gate_key2"), null, "id").first.public.encoded)
  }

  @Test fun noKeystoreMeansAKeyFile() {
    val f = File(dir(), "kula_device_key")
    val a = Keys.device(f, null)
    assertEquals(Keys.FILE, a.store)
    assertTrue(f.exists())
    assertEquals(a.key.id, Keys.device(f, null).key.id)
    // a keystore that cannot make keys falls back to the file too
    val g = File(dir(), "kula_device_key")
    val b = Keys.device(g, MapVault(failGenerate = true))
    assertEquals(Keys.FILE, b.store)
    assertTrue(g.exists())
  }

  @Test fun aBrokenKeyFileIsMovedAsideAndNotedForTheLedger() {
    val f = File(dir(), "kula_device_key")
    f.writeText("p256\nAAAA") // cut mid-write
    val v = MapVault()
    val h = Keys.device(f, v)
    assertEquals(Keys.KEYSTORE, h.store)
    val aside = f.parentFile.listFiles()!!.filter { it.name.startsWith("kula_device_key.broken.") }
    assertEquals(1, aside.size)
    assertEquals("p256\nAAAA", aside[0].readText())
    assertEquals(listOf(aside[0].name), Keys.takeReplaced(f))
    // read once: the worker writes it to the ledger and it is gone
    assertEquals(emptyList<String>(), Keys.takeReplaced(f))
  }

  @Test fun aKeystoreThatCannotBeReadIsLeftAlone() {
    // a key is in the keystore, but this start cannot read it: nothing is made or moved over it
    val f = File(dir(), "kula_device_key")
    val v = MapVault()
    val first = Keys.device(f, v)
    v.failGet = true
    val log = ArrayList<String>()
    val h = Keys.device(f, v) { log.add(it) }
    assertEquals(Keys.FILE, h.store)
    assertEquals(1, v.generated)
    assertEquals(0, v.imported)
    assertTrue(log.any { it.contains("keystore unreadable") })
    // the next start that can read it is the same device again; the stray file is not moved in
    v.failGet = false
    assertEquals(first.key.id, Keys.device(f, v).key.id)
    assertEquals(0, v.imported)
    // the gate key the same way
    val g = File(f.parentFile, "gate_key")
    v.failGet = true
    assertEquals(Keys.FILE, Keys.gate(g, v, "id").second)
    assertFalse(v.keys.containsKey(Keys.GATE_ALIAS))
  }

  @Test fun twoStartsAtOnceMakeOneKey() {
    val f = File(dir(), "kula_device_key")
    val v = MapVault()
    val ids = java.util.Collections.synchronizedList(ArrayList<String>())
    val threads = (0 until 8).map { Thread { ids.add(Keys.device(f, v).key.id) } }
    threads.forEach { it.start() }; threads.forEach { it.join() }
    assertEquals(1, ids.toSet().size)
    assertEquals(1, v.generated)
  }
}
