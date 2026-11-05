package expo.modules.kulallama.audit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Each rule on both sides of its threshold.
class ChecksTest {
  @Test fun replay() {
    val ring = ReplayRing(3)
    assertTrue(Checks.replay(ring, "a", "p1").ok)
    assertEquals("replay", Checks.replay(ring, "a", "p1").reason)
    // another peer may use the same nonce; the ring is per peer
    assertTrue(Checks.replay(ring, "a", "p2").ok)
    // the ring forgets after its size
    for (n in listOf("b", "c", "d")) assertTrue(Checks.replay(ring, n, "p1").ok)
    assertTrue(Checks.replay(ring, "a", "p1").ok)
    assertFalse(Checks.replay(ring, "d", "p1").ok)
  }

  @Test fun clock() {
    val now = 1_700_000_000_000L
    assertTrue(Checks.clock(now + 120_000, now).ok)
    assertTrue(Checks.clock(now - 120_000, now).ok)
    assertEquals("clock", Checks.clock(now + 120_001, now).reason)
    assertEquals("clock", Checks.clock(now - 120_001, now).reason)
  }

  @Test fun claim() {
    // ram: 2x exactly is fine, just over warns, just over 4x rejects, either direction
    assertEquals(Verdict.OK, Checks.claim(2000, 1000, 0.0, 0.0, 0.0))
    assertEquals(listOf("ram"), Checks.claim(2001, 1000, 0.0, 0.0, 0.0).warn)
    assertEquals(listOf("ram"), Checks.claim(1000, 2001, 0.0, 0.0, 0.0).warn)
    assertTrue(Checks.claim(4000, 1000, 0.0, 0.0, 0.0).ok)
    assertEquals("claim", Checks.claim(4001, 1000, 0.0, 0.0, 0.0).reason)
    assertEquals("claim", Checks.claim(1000, 4001, 0.0, 0.0, 0.0).reason)
    // bandwidth: measured = tps * modelGb; 10 tok/s on a 2 GB model is 20 GB/s
    assertEquals(Verdict.OK, Checks.claim(0, 0, 40.0, 10.0, 2.0))
    assertEquals(listOf("bandwidth"), Checks.claim(0, 0, 41.0, 10.0, 2.0).warn)
    assertEquals("claim", Checks.claim(0, 0, 81.0, 10.0, 2.0).reason)
    // nothing measured yet: nothing to say
    assertEquals(Verdict.OK, Checks.claim(8000, 0, 50.0, 0.0, 2.0))
    // both warn
    assertEquals(listOf("ram", "bandwidth"), Checks.claim(3000, 1000, 50.0, 10.0, 2.0).warn)
  }

  @Test fun modelIntegrity() {
    assertTrue(Checks.modelIntegrity("ABCD", "abcd").ok)
    assertEquals("model", Checks.modelIntegrity("abcd", "abce").reason)
  }

  @Test fun bounds() {
    val lim = Checks.Limits(maxBytes = 1000, maxSeconds = 60)
    assertTrue(Checks.bounds(1000, 60, lim).ok)
    assertEquals("bounds", Checks.bounds(1001, 60, lim).reason)
    assertEquals("bounds", Checks.bounds(1000, 61, lim).reason)
  }

  @Test fun health() {
    assertEquals(Verdict.OK, Checks.health(false, 42.0, 15))
    assertEquals(listOf("hot"), Checks.health(false, 42.1, 15).warn)
    assertEquals(listOf("battery"), Checks.health(false, 42.0, 14).warn)
    assertEquals(listOf("throttled", "hot", "battery"), Checks.health(true, 50.0, 5).warn)
    // unknown battery (-1) is not low
    assertEquals(Verdict.OK, Checks.health(false, 30.0, -1))
    assertTrue(Checks.health(true, 50.0, 5).ok)
  }
}
