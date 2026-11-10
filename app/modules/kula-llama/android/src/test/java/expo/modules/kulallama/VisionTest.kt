package expo.modules.kulallama

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

// The plain parts of Vision.kt: how big a photo gets for the projector, the RGB packing,
// file uris, and the image markers in the prompt.
class VisionTest {
  private val M = "<__media__>"

  @Test fun fitSizeKeepsTheAspectAndNeverScalesUp() {
    assertEquals(768 to 576, Vision.fitSize(1280, 960, 768))
    assertEquals(432 to 768, Vision.fitSize(720, 1280, 768))
    assertEquals(300 to 200, Vision.fitSize(300, 200, 768))
    assertEquals(384 to 1, Vision.fitSize(4000, 2, 384))
  }

  @Test fun sampleSizeStaysAtOrAboveTheTarget() {
    assertEquals(1, Vision.sampleSize(1280, 960, 768))
    assertEquals(2, Vision.sampleSize(1600, 1200, 768))
    assertEquals(4, Vision.sampleSize(4000, 3000, 768))
    assertEquals(8, Vision.sampleSize(4000, 3000, 384))
    for (s in listOf(384, 768, 1024)) assert(4032 / Vision.sampleSize(4032, 3024, s) >= s)
  }

  @Test fun argbBecomesPackedRgb() {
    val px = intArrayOf(0xff102030.toInt(), 0x80fffefd.toInt(), 0x00000000)
    assertArrayEquals(byteArrayOf(0x10, 0x20, 0x30, 0xff.toByte(), 0xfe.toByte(), 0xfd.toByte(), 0, 0, 0), Vision.argbToRgb(px))
  }

  @Test fun fileUrisBecomePaths() {
    assertEquals("/data/user/0/app/files/tasks/a b/x.jpg", Vision.pathOf("file:///data/user/0/app/files/tasks/a%20b/x.jpg"))
    assertEquals("/sdcard/x.jpg", Vision.pathOf("/sdcard/x.jpg"))
  }

  @Test fun markersGoInFrontOfTheFirstUserMessage() {
    val roles = listOf("system", "user", "assistant", "user")
    val out = Vision.withMarkers(roles, listOf("be brief", "what is this?", "a cat", "and now?"), 2, M)
    assertEquals(listOf("be brief", "$M$M\nwhat is this?", "a cat", "and now?"), out)
  }

  @Test fun markersAlreadyPlacedStay() {
    val c = listOf("sys", "look: $M and $M")
    assertEquals(c, Vision.withMarkers(listOf("system", "user"), c, 2, M))
  }

  @Test fun aWrongNumberOfMarkersIsRedone() {
    // three placed, one photo could be read: all three go, one comes back in front
    val out = Vision.withMarkers(listOf("user"), listOf("$M$M$M\nhi"), 1, M)
    assertEquals(listOf("$M\n\nhi"), out)
    // no photo readable: no marker left at all
    assertEquals(listOf("hi"), Vision.withMarkers(listOf("user"), listOf("${M}hi"), 0, M))
  }
}
