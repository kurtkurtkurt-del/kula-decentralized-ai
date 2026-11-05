package expo.modules.kulallama.audit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

// Both key algorithms: sign/verify round trip, a changed byte fails, the id is stable across
// a save and reload, and the P-256 fallback works even where Ed25519 exists.
class DeviceKeyTest {
  private fun roundTrip(k: SoftwareKey) {
    val msg = "beyin check v0".toByteArray()
    val sig = k.sign(msg)
    assertTrue(DeviceKey.verify(k.alg, k.publicKey, msg, sig))
    assertFalse(DeviceKey.verify(k.alg, k.publicKey, "beyin check v1".toByteArray(), sig))
    sig[0] = (sig[0].toInt() xor 1).toByte()
    assertFalse(DeviceKey.verify(k.alg, k.publicKey, msg, sig))
    assertEquals(32, k.id.length)
    assertEquals(DeviceKey.idOf(k.publicKey), k.id)
  }

  @Test fun ed25519RoundTrip() {
    assumeTrue(DeviceKey.ed25519Available())
    val k = SoftwareKey.generate()
    assertEquals(DeviceKey.ED25519, k.alg)
    roundTrip(k)
  }

  @Test fun p256RoundTrip() {
    val k = SoftwareKey.generate(preferEd25519 = false)
    assertEquals(DeviceKey.P256, k.alg)
    roundTrip(k)
  }

  @Test fun idIsStableAcrossSaveAndLoad() {
    val f = File.createTempFile("kula_device_key", "").apply { delete() }
    val a = SoftwareKey.loadOrCreate(f)
    val b = SoftwareKey.loadOrCreate(f)
    assertEquals(a.id, b.id)
    assertEquals(a.alg, b.alg)
    assertArrayEquals(a.publicKey, b.publicKey)
    // the reloaded key signs for the original's public key
    val msg = byteArrayOf(1, 2, 3)
    assertTrue(DeviceKey.verify(a.alg, a.publicKey, msg, b.sign(msg)))
    val rebuilt = SoftwareKey.from(a.alg, a.pkcs8(), a.publicKey)
    assertEquals(a.id, rebuilt.id)
    f.delete()
  }
}
