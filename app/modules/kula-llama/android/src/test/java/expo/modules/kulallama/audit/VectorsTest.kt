package expo.modules.kulallama.audit

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

// tools/audit-vectors.json: a fixed Ed25519 key and two ledger lines. Writing the same
// events with that key must give the very same bytes, hashes and signatures; the TypeScript
// twin (node/) checks the same file.
class VectorsTest {
  @Test fun ledgerLinesMatchTheSharedVectors() {
    assumeTrue(DeviceKey.ed25519Available())
    val v = JSONObject(File("../tools/audit-vectors.json").readText())
    val k = v.getJSONObject("key")
    val key = SoftwareKey.from(k.getString("alg"), hex(k.getString("pkcs8")), hex(k.getString("public")))
    assertEquals(k.getString("id"), key.id)
    val f = File.createTempFile("vectors", ".jsonl").apply { delete() }
    val ledger = Ledger(f, key)
    val lines = v.getJSONArray("lines")
    for (i in 0 until lines.length()) {
      val line = lines.getJSONObject(i)
      val fields = LinkedHashMap<String, Any?>()
      val ev = line.getJSONObject("event")
      // org.json forgets key order, so the vector names the order the fields were written in
      val order = line.getJSONArray("fields")
      for (i in 0 until order.length()) fields[order.getString(i)] = ev.get(order.getString(i))
      val written = ledger.append(ev.getString("kind"), ev.optString("peer").ifEmpty { null }, fields, ev.getLong("t"))
      assertEquals("line $i", line.getString("line"), written)
      assertEquals("hash $i", line.getString("sha256"), Ledger.sha256Hex(written.toByteArray()))
    }
    assertEquals(-1, Ledger.verify(f, key.publicKey, key.alg))
    f.delete()
  }

  private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
