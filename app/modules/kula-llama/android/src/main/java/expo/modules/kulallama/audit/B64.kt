package expo.modules.kulallama.audit

/**
 * Standard base64 with padding, written out so the audit package runs on Android 7 (API 24):
 * java.util.Base64 is API 26 and android.util.Base64 would tie this package to Android.
 */
object B64 {
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  private val INDEX = IntArray(128) { -1 }.also { t -> ALPHABET.forEachIndexed { i, c -> t[c.code] = i } }

  fun encode(bytes: ByteArray): String {
    val sb = StringBuilder((bytes.size + 2) / 3 * 4)
    var i = 0
    while (i < bytes.size) {
      val b0 = bytes[i].toInt() and 0xff
      val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else -1
      val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xff else -1
      sb.append(ALPHABET[b0 shr 2])
      sb.append(ALPHABET[((b0 and 3) shl 4) or (if (b1 < 0) 0 else b1 shr 4)])
      sb.append(if (b1 < 0) '=' else ALPHABET[((b1 and 15) shl 2) or (if (b2 < 0) 0 else b2 shr 6)])
      sb.append(if (b2 < 0) '=' else ALPHABET[b2 and 63])
      i += 3
    }
    return sb.toString()
  }

  /** Decodes standard base64; throws IllegalArgumentException on anything but the alphabet and padding. */
  fun decode(text: String): ByteArray {
    val s = text.trim()
    if (s.isEmpty()) return ByteArray(0)
    if (s.length % 4 != 0) throw IllegalArgumentException("base64 length")
    val pad = if (s.endsWith("==")) 2 else if (s.endsWith("=")) 1 else 0
    val out = ByteArray(s.length / 4 * 3 - pad)
    var o = 0
    var i = 0
    while (i < s.length) {
      val v = IntArray(4)
      for (k in 0 until 4) {
        val c = s[i + k]
        v[k] = if (c == '=' && i + k >= s.length - pad) 0 else {
          val x = if (c.code < 128) INDEX[c.code] else -1
          if (x < 0) throw IllegalArgumentException("base64 char")
          x
        }
      }
      val n = (v[0] shl 18) or (v[1] shl 12) or (v[2] shl 6) or v[3]
      if (o < out.size) out[o++] = (n shr 16).toByte()
      if (o < out.size) out[o++] = (n shr 8).toByte()
      if (o < out.size) out[o++] = n.toByte()
      i += 4
    }
    return out
  }
}
