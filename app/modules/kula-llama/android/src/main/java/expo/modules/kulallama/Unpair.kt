package expo.modules.kulallama

import expo.modules.kulallama.audit.Ledger
import org.json.JSONObject
import java.io.File

/**
 * "Remove this device's access" (docs/GATE.md): the masters that may use this phone without a
 * code, as the app lists them, and taking one away. Plain JVM (no Android), so the JVM tests
 * run it; KulaLlamaModule and WorkerService call it.
 *
 * Where a paired master's facts come from:
 *   - its fingerprint and when it paired: `gate/paired` ([Paired])
 *   - a name: the computer's QR when it was added by scanning (`gate/hosts.json`, [Hosts]), else
 *     the name the pairing line carries, else none (the app shows the fingerprint)
 *   - its address and when it was last here: `gate/seen` ([Seen], the worker writes it on
 *     connect), else the ledger's `pair` line for that fingerprint (address and time)
 */
object Unpair {
  /** One master that can use this phone. Times are unix ms; null when not known. */
  data class Device(val fp: String, val name: String?, val pairedAt: Long?, val lastSeen: Long?, val address: String?, val host: Boolean)

  fun list(paired: Paired, hosts: Hosts?, seen: Seen?, ledger: File?): List<Device> {
    val all = paired.list()
    if (all.isEmpty()) return emptyList()
    val fromLedger = if (ledger != null) pairLines(ledger, all.map { it.fp }.toSet()) else emptyMap()
    return all.map { e ->
      val h = hosts?.byFp(e.fp)
      val s = seen?.get(e.fp)
      val l = fromLedger[e.fp]
      Device(e.fp, h?.name?.takeIf { it.isNotBlank() } ?: e.name, e.at ?: h?.paired ?: l?.second, s?.first, s?.second ?: l?.first, h != null)
    }.sortedByDescending { it.lastSeen ?: it.pairedAt ?: 0L }
  }

  /**
   * The newest `pair` line per fingerprint in [wanted]: (address, time). Reads the live ledger
   * file only (a pairing older than the last rotation shows no address; the paired file has its time).
   */
  fun pairLines(ledger: File, wanted: Set<String>): Map<String, Pair<String?, Long?>> {
    if (!ledger.exists()) return emptyMap()
    val out = HashMap<String, Pair<String?, Long?>>()
    runCatching {
      ledger.bufferedReader(Charsets.UTF_8).useLines { lines ->
        for (l in lines) {
          if (!l.contains("\"pair\"")) continue
          val o = runCatching { JSONObject(l) }.getOrNull() ?: continue
          if (o.optString("kind") != "pair") continue
          val fp = o.optString("fp").lowercase()
          if (fp !in wanted) continue
          out[fp] = (o.optString("peer").ifEmpty { null }) to (if (o.has("t")) o.optLong("t") else null)
        }
      }
    }
    return out
  }

  /**
   * Takes [fp]'s access away: out of the paired list (new connections hear "not paired" at
   * once, the running gate re-reads the file), out of the scanned computers, and one signed
   * ledger line, `health` with `unpaired` = the first 16 hex of the fingerprint (a kind every
   * verifier already knows: a new kind would turn older kula-nodes' checks red). Closing the
   * master's open connections is the gate's part ([Gate.Server.drop]). Returns false when [fp]
   * was not paired (nothing is written then).
   */
  fun remove(fp: String, paired: Paired, hosts: Hosts?, seen: Seen?, record: ((Map<String, Any?>) -> Unit)?): Boolean {
    val f = fp.lowercase()
    val name = hosts?.byFp(f)?.name ?: paired.list().firstOrNull { it.fp == f }?.name
    val was = paired.remove(f)
    hosts?.forget(f)
    seen?.forget(f)
    if (!was) return false
    record?.invoke(fields(f, name))
    return true
  }

  /** The ledger line's fields for a removed device. */
  fun fields(fp: String, name: String?): Map<String, Any?> {
    val m = linkedMapOf<String, Any?>("unpaired" to fp.take(16))
    if (!name.isNullOrBlank()) m["name"] = name.take(60)
    return m
  }

  /** Writes the line to the ledger at [file] (a fresh Ledger: it chains on from whatever the file holds). */
  fun record(ledger: Ledger, fields: Map<String, Any?>) { ledger.append("health", null, fields) }
}

/**
 * When each paired master was last here and from which address: `gate/seen`, one JSON object
 * `{fp: {"t": ms, "peer": "addr"}}`. The worker writes it on connect, at most once a minute
 * per master (a split run opens many pipes) unless the address changed.
 */
class Seen(private val file: File) {
  private var map = LinkedHashMap<String, Pair<Long, String?>>()

  init { reload() }

  @Synchronized
  fun reload() {
    map = LinkedHashMap()
    val o = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return
    for (k in o.keys()) {
      val v = o.optJSONObject(k) ?: continue
      map[k] = v.optLong("t") to v.optString("peer").ifEmpty { null }
    }
  }

  @Synchronized fun get(fp: String): Pair<Long, String?>? = map[fp]

  /** A connection from [fp] at [peer]. True when the file was written. */
  @Synchronized
  fun saw(fp: String, peer: String?, now: Long): Boolean {
    val old = map[fp]
    if (old != null && old.second == peer && now - old.first < MIN_GAP_MS) return false
    map[fp] = now to peer
    write()
    return true
  }

  @Synchronized
  fun forget(fp: String) {
    reload()
    if (map.remove(fp) != null) write()
  }

  private fun write() {
    val o = JSONObject()
    for ((k, v) in map) o.put(k, JSONObject().put("t", v.first).put("peer", v.second ?: JSONObject.NULL))
    runCatching {
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, file.name + ".tmp")
      tmp.writeText(o.toString())
      if (!tmp.renameTo(file)) { file.writeText(o.toString()); tmp.delete() }
    }
  }

  companion object { const val MIN_GAP_MS = 60_000L }
}
