package expo.modules.kulallama

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// "let my computers use this phone" (Auto.kt): the home wi-fi match, when the worker runs, and
// the computers added by scanning their QR (expired and reused codes refused).
class AutoTest {
  private val home = Auto.Net("192.168.1.0/24", "192.168.1.1", "fritz.box", null)
  private fun dir() = java.nio.file.Files.createTempDirectory("kula-auto").toFile()
  private val macFp = "ab".repeat(32)
  private fun qr(pin: String = "0123456789abcdef", exp: Long = 2_000_000_000_000L, fp: String = macFp, id: String = "host-1", name: String = "mac studio") =
    JSONObject().put("k", "kula-host").put("v", 1).put("id", id).put("name", name).put("fp", fp).put("pin", pin).put("exp", exp).toString()

  @Test
  fun subnetsAreWorkedOutFromTheAddress() {
    assertEquals("192.168.1.0/24", Auto.Net.subnetOf("192.168.1.23", 24))
    assertEquals("10.0.0.0/8", Auto.Net.subnetOf("10.20.30.40", 8))
    assertEquals("172.16.4.0/22", Auto.Net.subnetOf("172.16.7.200", 22))
    assertNull(Auto.Net.subnetOf("fe80::1", 64))
    assertNull(Auto.Net.subnetOf("300.1.1.1", 24))
    assertEquals("home", Auto.Net.ssidOf("\"home\""))
    assertNull(Auto.Net.ssidOf("<unknown ssid>"))
    assertNull(Auto.Net.ssidOf(null))
  }

  @Test
  fun theHomeWifiMatchesOnSubnetRouterDomainAndNameWhenKnown() {
    assertTrue(home.matches(home))
    assertTrue(home.matches(home.copy(ssid = "home"))) // the name read later, not remembered: fine
    assertFalse(home.matches(null))
    assertFalse(home.matches(home.copy(subnet = "192.168.2.0/24")))
    assertFalse(home.matches(home.copy(gateway = "192.168.1.254")))
    assertFalse(home.matches(home.copy(gateway = null))) // remembered a router, now none
    assertFalse(home.matches(home.copy(domain = "lan")))
    assertTrue(home.matches(home.copy(domain = null)))
    val named = home.copy(ssid = "home")
    assertFalse(named.matches(home.copy(ssid = "neighbour")))
    assertTrue(named.matches(home)) // the name is unreadable in the background: subnet and router decide
    assertEquals(named, Auto.Net.fromJson(named.toJson()))
  }

  @Test
  fun theDecisionSaysWhyNot() {
    val on = Auto.Config(on = true, home = home)
    assertEquals("off", Auto.decide(Auto.Config(), home, true))
    assertEquals("nohome", Auto.decide(Auto.Config(on = true), home, true))
    assertEquals("start", Auto.decide(on, home, false))
    assertEquals("away", Auto.decide(on, null, true))
    assertEquals("away", Auto.decide(on, home.copy(subnet = "10.0.0.0/24"), true))
    assertEquals("paused", Auto.decide(on.copy(paused = true), home, true))
    assertEquals("unplugged", Auto.decide(on.copy(onlyCharging = true), home, false))
    assertEquals("start", Auto.decide(on.copy(onlyCharging = true), home, true))
  }

  @Test
  fun theConfigSurvivesTheFile() {
    val f = File(dir(), "kula_auto.json")
    assertEquals(Auto.Config(), Auto.load(f)) // nothing yet: off
    val c = Auto.Config(on = true, onlyCharging = true, home = home.copy(ssid = "home"), paused = false, name = "pixel")
    Auto.save(f, c)
    assertEquals(c, Auto.load(f))
    f.writeText("{not json")
    assertEquals(Auto.Config(), Auto.load(f))
  }

  @Test
  fun aScannedComputerCanPairOnceWithItsCode() {
    val f = File(dir(), "hosts.json")
    val h = Hosts(f)
    val now = 1_900_000_000_000L
    assertEquals("notHost", h.offer("""{"k":"kula-peer","v":3}""", now))
    assertEquals("notHost", h.offer("not json", now))
    assertEquals("notHost", h.offer(qr(fp = "xyz"), now))
    assertEquals("notHost", h.offer(qr(pin = "short"), now))
    assertEquals("expired", h.offer(qr(exp = now - 1), now))
    assertNull(h.offer(qr(), now))
    assertNull(h.offer(qr(), now)) // the same QR again while its code is open: nothing changes
    val p = h.pending(now)
    assertNotNull(p)
    assertEquals("mac studio", p!!.name)
    assertEquals(macFp, p.fp)
    assertEquals("0123456789abcdef", p.pin)
    // the file carries it to the worker process
    assertEquals(p, Hosts(f).pending(now))
    // the gate paired it: the code is spent and cannot be scanned again
    h.paired(macFp, now + 1000)
    assertNull(h.pending(now))
    assertNotNull(h.byFp(macFp)!!.paired)
    assertEquals("used", h.offer(qr(), now))
    assertEquals("used", Hosts(f).offer(qr(), now)) // also after a restart
    // a new code from the same computer is fine and keeps it known
    assertNull(h.offer(qr(pin = "fedcba9876543210"), now))
    assertEquals(1, h.all().size)
    assertNotNull(h.byFp(macFp)!!.paired)
  }

  @Test
  fun aCodeThatRanOutIsSpent() {
    val h = Hosts(File(dir(), "hosts.json"))
    val now = 1_900_000_000_000L
    assertNull(h.offer(qr(exp = now + 60_000), now))
    assertNotNull(h.pending(now + 59_000))
    assertNull(h.pending(now + 61_000))
    assertEquals("used", h.offer(qr(exp = now + 600_000), now + 62_000))
    // forgetting removes the computer; its old code stays refused
    assertTrue(h.forget(macFp))
    assertTrue(h.all().isEmpty())
    assertEquals("used", h.offer(qr(exp = now + 600_000), now + 63_000))
  }

  @Test
  fun aNewerComputerReplacesTheOpenCodeOfTheSameOne() {
    val h = Hosts(File(dir(), "hosts.json"))
    val now = 1_900_000_000_000L
    assertNull(h.offer(qr(pin = "aaaaaaaaaaaaaaaa"), now))
    assertNull(h.offer(qr(pin = "bbbbbbbbbbbbbbbb"), now + 10))
    assertEquals("bbbbbbbbbbbbbbbb", h.pending(now + 20)!!.pin)
    assertEquals("used", h.offer(qr(pin = "aaaaaaaaaaaaaaaa"), now + 30)) // the replaced code is gone
    // two computers: the newest open code wins, the other waits its turn
    assertNull(h.offer(qr(pin = "cccccccccccccccc", fp = "cd".repeat(32), id = "host-2", name = "laptop"), now + 40))
    assertEquals("laptop", h.pending(now + 50)!!.name)
    h.paired("cd".repeat(32), now + 60)
    assertEquals("mac studio", h.pending(now + 70)!!.name)
  }
}
