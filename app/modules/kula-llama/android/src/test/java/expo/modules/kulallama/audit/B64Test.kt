package expo.modules.kulallama.audit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

// Our base64 (API 24 has no java.util.Base64) against the JDK's, every length and padding.
class B64Test {
  @Test fun matchesTheJdkOnRandomInput() {
    val rnd = Random(7)
    for (n in 0..300) {
      val bytes = ByteArray(n).also { rnd.nextBytes(it) }
      val ours = B64.encode(bytes)
      assertEquals(java.util.Base64.getEncoder().encodeToString(bytes), ours)
      assertArrayEquals(bytes, B64.decode(ours))
    }
  }

  @Test fun refusesWhatIsNotBase64() {
    for (bad in listOf("abc", "ab\$d", "ab=c", "YWJjé")) {
      assertTrue(bad, runCatching { B64.decode(bad) }.isFailure)
    }
    assertArrayEquals(ByteArray(0), B64.decode(""))
  }
}
