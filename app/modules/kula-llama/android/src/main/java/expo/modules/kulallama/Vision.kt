package expo.modules.kulallama

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.net.URLDecoder

/**
 * Photos for a vision model (10.11.2026, night projects with photos): a project's photo file →
 * a small RGB image for mtmd (kula_llama.cpp generateImages), and the prompt's image markers.
 *
 * The size matters more than anything else here: SmolVLM-style projectors cut an image into
 * 384 px tiles plus one overview, ~81 tokens each, so a 1280 px photo is ~17 tiles (1 400
 * tokens) and six of them do not fit a phone's context. The app asks for a long side
 * (maxSide): the pure parts below are JVM-tested (VisionTest); [decode] needs Android.
 */
object Vision {
  /** The size an image of [w]×[h] is scaled to so its long side is at most [maxSide] (never up). */
  fun fitSize(w: Int, h: Int, maxSide: Int): Pair<Int, Int> {
    require(w > 0 && h > 0 && maxSide > 0) { "bad size" }
    val long = maxOf(w, h)
    if (long <= maxSide) return w to h
    val scale = maxSide.toDouble() / long
    return maxOf(1, Math.round(w * scale).toInt()) to maxOf(1, Math.round(h * scale).toInt())
  }

  /** BitmapFactory's inSampleSize: the largest power of two that keeps the long side ≥ [maxSide]. */
  fun sampleSize(w: Int, h: Int, maxSide: Int): Int {
    var s = 1
    while (maxOf(w, h) / (s * 2) >= maxSide) s *= 2
    return s
  }

  /** ARGB_8888 pixels (Bitmap.getPixels) → packed RGB bytes, alpha dropped. */
  fun argbToRgb(pixels: IntArray): ByteArray {
    val out = ByteArray(pixels.size * 3)
    var o = 0
    for (p in pixels) {
      out[o++] = (p shr 16 and 0xff).toByte()
      out[o++] = (p shr 8 and 0xff).toByte()
      out[o++] = (p and 0xff).toByte()
    }
    return out
  }

  /** A file:// uri (what expo-file-system hands JS) or a plain path → a path. */
  fun pathOf(uri: String): String =
    if (uri.startsWith("file://")) URLDecoder.decode(uri.removePrefix("file://"), "UTF-8") else uri

  /**
   * The contents with exactly [n] markers: when the messages already carry n (the caller
   * placed them), unchanged; otherwise every marker is taken out and n are put in front of
   * the first user message (the images come before the question, as SmolVLM was trained).
   */
  fun withMarkers(roles: List<String>, contents: List<String>, n: Int, marker: String): List<String> {
    val have = contents.sumOf { it.windowed(marker.length, 1).count { w -> w == marker } }
    if (have == n) return contents
    val clean = contents.map { it.replace(marker, "") }
    val first = roles.indexOfFirst { it == "user" }.takeIf { it >= 0 } ?: return clean
    return clean.mapIndexed { i, c -> if (i == first && n > 0) marker.repeat(n) + "\n" + c else c }
  }

  class Image(val rgb: ByteArray, val width: Int, val height: Int)

  /** Reads an image file scaled to [maxSide]; null when it is gone or not an image. */
  fun decode(uri: String, maxSide: Int): Image? {
    val path = pathOf(uri)
    if (!File(path).isFile) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxSide)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val raw = BitmapFactory.decodeFile(path, opts) ?: return null
    val (w, h) = fitSize(raw.width, raw.height, maxSide)
    val bmp = if (w != raw.width || h != raw.height) Bitmap.createScaledBitmap(raw, w, h, true) else raw
    val pixels = IntArray(w * h)
    bmp.getPixels(pixels, 0, w, 0, 0, w, h)
    if (bmp !== raw) bmp.recycle()
    raw.recycle()
    return Image(argbToRgb(pixels), w, h)
  }
}
