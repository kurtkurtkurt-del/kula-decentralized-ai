package expo.modules.kulallama

import expo.modules.kulallama.audit.B64
import expo.modules.kulallama.audit.DeviceKey
import expo.modules.kulallama.audit.SoftwareKey
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

// GET /trust?challenge= (Attest.kt, Trust.kt): the request and the answer's shape. The chain
// itself comes from the keystore on a phone; here a fake attester hands back fixed bytes, and
// node/test/attest.test.ts checks real chains.
class AttestTest {
  private val key = SoftwareKey.generate(preferEd25519 = false)
  private val ch = "ab".repeat(32)
  private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
  private val leaf = byteArrayOf(0x30, 1, 2, 3)
  private val inter = byteArrayOf(0x30, 9, 9)

  private fun trust(attest: ((String) -> Map<String, Any?>)?): Trust {
    val f = File(Files.createTempDirectory("kula-attest").toFile(), "ledger.jsonl")
    return Trust(key, "keystore", null, f, { Trust.GateState(false, true, 1) }, { 1_800_000_000_000L }, attest)
  }

  @Test fun theKeyChallengeNamesTheQuestionAndTheDevice() {
    // the same formula node/src/attest.ts expects
    assertArrayEquals(sha("kula-attest-1\n$ch\n${key.id}".toByteArray()), Attest.keyChallenge(ch, key.id))
    assertFalse(Attest.keyChallenge(ch, key.id).contentEquals(Attest.keyChallenge(ch, "0".repeat(32))))
    assertEquals("kula-attest-1\n$ch\n${hex(sha(leaf))}", String(Attest.bindMessage(ch, leaf)))
  }

  @Test fun anAnswerCarriesTheChainAndTheDeviceKeysSignature() {
    var asked: ByteArray? = null
    val a = Attest.answer(ch, key) { c -> asked = c; listOf(leaf, inter) }
    assertArrayEquals(Attest.keyChallenge(ch, key.id), asked)
    assertEquals(listOf("v", "chain", "sig"), a.keys.toList())
    assertEquals(listOf(B64.encode(leaf), B64.encode(inter)), a["chain"])
    assertTrue(DeviceKey.verify(key.alg, key.publicKey, Attest.bindMessage(ch, leaf), B64.decode(a["sig"] as String)))
  }

  @Test fun noProofSaysWhy() {
    assertEquals("no keystore on this device", Attest.answer(ch, key, null)["error"])
    assertTrue((Attest.answer(ch, key) { throw IllegalStateException("boom") }["error"] as String).contains("boom"))
    assertTrue((Attest.answer(ch, key) { listOf(leaf) }["error"] as String).contains("no certificate chain"))
  }

  @Test fun trustTakesAChallengeAndPutsTheProofLast() {
    val t = trust { c -> Attest.answer(c, key) { listOf(leaf, inter) } }
    // no challenge: the answer is as before, no attest field
    assertFalse(JSONObject(t.answer(null).body).has("attest"))
    val a = t.answer("challenge=$ch")
    assertEquals(200, a.code)
    assertTrue(a.body.endsWith(",\"attest\":{\"v\":1,\"chain\":[\"${B64.encode(leaf)}\",\"${B64.encode(inter)}\"],\"sig\":\"" + JSONObject(a.body).getJSONObject("attest").getString("sig") + "\"}}"))
    // with since as well
    assertEquals(200, t.answer("since=${"0".repeat(64)}&challenge=$ch").code)
    // a challenge is 64 lowercase hex, nothing else
    for (bad in listOf("", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33), "zz".repeat(32))) {
      val r = t.answer("challenge=$bad")
      assertEquals(bad, 400, r.code)
      assertEquals("bad challenge", JSONObject(r.body).getString("error"))
    }
    // a device that makes no proof says so, in the same place
    assertEquals("no keystore on this device", JSONObject(trust(null).answer("challenge=$ch").body).getJSONObject("attest").getString("error"))
  }
}
