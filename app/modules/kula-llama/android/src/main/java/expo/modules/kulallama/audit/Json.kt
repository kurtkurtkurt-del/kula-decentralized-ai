package expo.modules.kulallama.audit

/**
 * A tiny JSON writer that keeps field order. The ledger line has to be byte-identical
 * between this code and its TypeScript twin, and org.json reorders keys, so the ledger
 * writes its own. Values: String, Boolean, Int, Long, Double, null, List and Map (string keys).
 */
object Json {
  fun obj(fields: Map<String, Any?>): String {
    val sb = StringBuilder("{")
    var first = true
    for ((k, v) in fields) {
      if (!first) sb.append(',')
      first = false
      str(sb, k); sb.append(':'); value(sb, v)
    }
    return sb.append('}').toString()
  }

  private fun value(sb: StringBuilder, v: Any?) {
    when (v) {
      null -> sb.append("null")
      is String -> str(sb, v)
      is Boolean -> sb.append(v)
      is Int, is Long, is Short, is Byte -> sb.append(v)
      is Double -> number(sb, v)
      is Float -> number(sb, v.toDouble())
      is Map<*, *> -> sb.append(obj(v.entries.associate { it.key.toString() to it.value }))
      is Iterable<*> -> {
        sb.append('[')
        var first = true
        for (e in v) { if (!first) sb.append(','); first = false; value(sb, e) }
        sb.append(']')
      }
      is Pair<*, *> -> value(sb, listOf(v.first, v.second))
      else -> str(sb, v.toString())
    }
  }

  // whole doubles print as integers (42.0 -> 42) so JavaScript's JSON.stringify agrees
  private fun number(sb: StringBuilder, d: Double) {
    if (d.isNaN() || d.isInfinite()) sb.append("null")
    else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append(d.toLong())
    else sb.append(d.toString())
  }

  private fun str(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
      }
    }
    sb.append('"')
  }
}
