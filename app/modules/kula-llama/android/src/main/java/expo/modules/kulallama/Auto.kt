package expo.modules.kulallama

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * "let my computers use this phone" (8.11.2026): the plain-JVM half of the mode in which the
 * phone gets ready by itself on the home wi-fi and only computers it already paired with get
 * in. No Android imports here, so audit-jvm runs it (AutoTest); Keeper.kt reads the network
 * and the plug and calls [Auto.decide], WorkerService runs the gate with [Hosts].
 *
 * The home wi-fi is remembered as what Android tells any app without a location permission:
 * the IPv4 subnet, the router's address and the DHCP domain. The network's name (SSID) is only
 * readable with the location permission (and in the background only with "allow all the
 * time"), so it is kept when it could be read and compared only when both sides have it. The
 * match decides when the worker runs, never who gets in: that is the gate's paired list.
 */
object Auto {
  /** What a wi-fi network looks like from the phone; null fields were not readable. */
  data class Net(val subnet: String, val gateway: String?, val domain: String? = null, val ssid: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("subnet", subnet).put("gateway", gateway ?: JSONObject.NULL)
      .put("domain", domain ?: JSONObject.NULL).put("ssid", ssid ?: JSONObject.NULL)

    /** Is [now] the same network as this remembered one? */
    fun matches(now: Net?): Boolean {
      if (now == null) return false
      if (subnet != now.subnet) return false
      if (gateway != null && now.gateway != null && gateway != now.gateway) return false
      if (gateway != null && now.gateway == null) return false
      if (!domain.isNullOrEmpty() && !now.domain.isNullOrEmpty() && domain != now.domain) return false
      if (ssid != null && now.ssid != null && ssid != now.ssid) return false
      return true
    }

    companion object {
      fun fromJson(o: JSONObject?): Net? {
        val subnet = o?.optString("subnet")?.takeIf { it.isNotEmpty() } ?: return null
        fun s(k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotEmpty() }
        return Net(subnet, s("gateway"), s("domain"), s("ssid"))
      }

      /** "192.168.1.23", 24 → "192.168.1.0/24"; null for anything but a dotted IPv4. */
      fun subnetOf(ip: String, prefix: Int): String? {
        val p = ip.split('.').map { it.toIntOrNull() ?: return null }
        if (p.size != 4 || p.any { it !in 0..255 } || prefix !in 0..32) return null
        val v = (p[0].toLong() shl 24) or (p[1].toLong() shl 16) or (p[2].toLong() shl 8) or p[3].toLong()
        val mask = if (prefix == 0) 0L else (0xffffffffL shl (32 - prefix)) and 0xffffffffL
        val n = v and mask
        return "${(n shr 24) and 255}.${(n shr 16) and 255}.${(n shr 8) and 255}.${n and 255}/$prefix"
      }

      /** Android reports an unreadable name as "<unknown ssid>" and a readable one in quotes. */
      fun ssidOf(raw: String?): String? {
        val s = raw?.trim()?.removeSurrounding("\"") ?: return null
        return s.takeIf { it.isNotEmpty() && it != "<unknown ssid>" && it != "0x" }
      }
    }
  }

  /** The switch and what it remembered. [paused]: stopped from the notification; until the app starts it again or the phone restarts. */
  data class Config(val on: Boolean = false, val onlyCharging: Boolean = false, val home: Net? = null, val paused: Boolean = false, val name: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("on", on).put("onlyCharging", onlyCharging)
      .put("home", home?.toJson() ?: JSONObject.NULL).put("paused", paused).put("name", name ?: JSONObject.NULL)

    companion object {
      fun fromJson(o: JSONObject): Config = Config(
        on = o.optBoolean("on"), onlyCharging = o.optBoolean("onlyCharging"),
        home = Net.fromJson(o.optJSONObject("home")), paused = o.optBoolean("paused"),
        name = if (o.isNull("name")) null else o.optString("name").takeIf { it.isNotEmpty() },
      )
    }
  }

  fun load(file: File): Config = runCatching { Config.fromJson(JSONObject(file.readText())) }.getOrDefault(Config())

  @Synchronized
  fun save(file: File, c: Config) {
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, file.name + ".tmp")
    tmp.writeText(c.toJson().toString())
    if (!tmp.renameTo(file)) { file.writeText(c.toJson().toString()); tmp.delete() }
  }

  /**
   * Should the worker run right now? "start", or why not: "off" (the switch), "nohome" (no
   * wi-fi remembered), "paused" (stopped from the notification), "away" (not on the home
   * wi-fi), "unplugged" (only while charging, and it is not).
   */
  fun decide(c: Config, now: Net?, charging: Boolean): String = when {
    !c.on -> "off"
    c.home == null -> "nohome"
    c.paused -> "paused"
    !c.home.matches(now) -> "away"
    c.onlyCharging && !charging -> "unplugged"
    else -> "start"
  }
}

/**
 * The computers this phone lets in without asking (`files/gate/hosts.json`): each one added by
 * scanning the QR its chat page shows, `{"k":"kula-host","v":1,"id","name","fp","pin","exp"}`.
 * A computer with an open [Host.pin] may pair once with that code and only with the
 * certificate [Host.fp] (the gate's `pinFor`); after that the gate's paired list knows it.
 * Codes that were used or ran out are kept as hashes, so the same QR cannot be taken twice.
 */
class Hosts(private val file: File) {
  data class Host(val id: String, val name: String, val fp: String, val pin: String?, val exp: Long?, val added: Long, val paired: Long?) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("fp", fp).put("pin", pin ?: JSONObject.NULL)
      .put("exp", exp ?: JSONObject.NULL).put("added", added).put("paired", paired ?: JSONObject.NULL)
    /** The code is still good at [now]. */
    fun open(now: Long): Boolean = pin != null && (exp == null || now <= exp)
  }

  private var hosts = ArrayList<Host>()
  private val spent = LinkedHashSet<String>()

  init { reload() }

  @Synchronized
  fun reload() {
    hosts = ArrayList(); spent.clear()
    val o = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return
    o.optJSONArray("hosts")?.let { a ->
      for (i in 0 until a.length()) {
        val h = a.optJSONObject(i) ?: continue
        val fp = h.optString("fp").lowercase()
        if (!FP.matches(fp)) continue
        hosts.add(Host(h.optString("id"), h.optString("name"), fp, if (h.isNull("pin")) null else h.optString("pin").takeIf { it.isNotEmpty() },
          if (h.isNull("exp")) null else h.optLong("exp"), h.optLong("added"), if (h.isNull("paired")) null else h.optLong("paired")))
      }
    }
    o.optJSONArray("spent")?.let { a -> for (i in 0 until a.length()) spent.add(a.optString(i)) }
  }

  @Synchronized fun all(): List<Host> = hosts.toList()
  @Synchronized fun byFp(fp: String): Host? = hosts.firstOrNull { it.fp == fp }

  /**
   * Takes a scanned host QR. Returns null when taken, else why not: "notHost" (not that QR, or a
   * field is wrong), "expired" (exp is past), "used" (this code was already taken or spent).
   */
  @Synchronized
  fun offer(qr: String, now: Long): String? {
    val o = runCatching { JSONObject(qr.trim()) }.getOrNull() ?: return "notHost"
    if (o.optString("k") != "kula-host" || o.optInt("v") != 1) return "notHost"
    val id = o.optString("id").trim()
    val name = o.optString("name").trim().take(60)
    val fp = o.optString("fp").lowercase()
    val pin = o.optString("pin")
    val exp = o.optLong("exp", -1)
    if (id.isEmpty() || id.length > 128 || !FP.matches(fp) || !PIN.matches(pin) || exp <= 0) return "notHost"
    if (now > exp) return "expired"
    if (Gate.sha256Hex(pin.toByteArray()) in spent) return "used"
    val old = hosts.indexOfFirst { it.fp == fp || it.id == id }
    // the same QR scanned twice while its code is still open: nothing changes
    if (old >= 0 && hosts[old].pin == pin && hosts[old].fp == fp) return null
    val prev = if (old >= 0) hosts.removeAt(old) else null
    // a code still open for this computer is replaced by the newer one, and cannot come back
    prev?.pin?.let { spent.add(Gate.sha256Hex(it.toByteArray())) }
    hosts.add(Host(id, name.ifEmpty { prev?.name ?: "computer" }, fp, pin, exp, prev?.added ?: now, prev?.paired?.takeIf { prev.fp == fp }))
    write()
    return null
  }

  /** The newest computer with a code still open at [now], or null. Codes past their time are spent here. */
  @Synchronized
  fun pending(now: Long): Host? {
    var changed = false
    hosts.replaceAll { h -> if (h.pin != null && !h.open(now)) { spent.add(Gate.sha256Hex(h.pin.toByteArray())); changed = true; h.copy(pin = null, exp = null) } else h }
    if (changed) write()
    return hosts.filter { it.open(now) }.maxByOrNull { it.added }
  }

  /** The gate paired [fp] (the pin proof passed): the code is spent and the computer known. */
  @Synchronized
  fun paired(fp: String, now: Long) {
    val i = hosts.indexOfFirst { it.fp == fp }
    if (i < 0) return
    val h = hosts[i]
    h.pin?.let { spent.add(Gate.sha256Hex(it.toByteArray())) }
    hosts[i] = h.copy(pin = null, exp = null, paired = now)
    write()
  }

  /** A code that ran out or was replaced without being used. */
  @Synchronized
  fun spend(fp: String) {
    val i = hosts.indexOfFirst { it.fp == fp }
    if (i < 0) return
    val h = hosts[i]
    if (h.pin == null) return
    spent.add(Gate.sha256Hex(h.pin.toByteArray()))
    hosts[i] = h.copy(pin = null, exp = null)
    write()
  }

  @Synchronized
  fun forget(fp: String): Boolean {
    val h = hosts.firstOrNull { it.fp == fp } ?: return false
    h.pin?.let { spent.add(Gate.sha256Hex(it.toByteArray())) }
    hosts.remove(h)
    write()
    return true
  }

  private fun write() {
    file.parentFile?.mkdirs()
    // the newest 200 spent codes are plenty: a code lives minutes and a QR is one per pairing
    val keep = spent.toList().takeLast(200)
    val o = JSONObject().put("hosts", JSONArray(hosts.map { it.toJson() })).put("spent", JSONArray(keep))
    val tmp = File(file.parentFile, file.name + ".tmp")
    tmp.writeText(o.toString())
    if (!tmp.renameTo(file)) { file.writeText(o.toString()); tmp.delete() }
  }

  companion object {
    val FP = Regex("[0-9a-f]{64}")
    /** The computer's one-time code: 16 letters or digits (kula-node makes 16 hex). */
    val PIN = Regex("[0-9A-Za-z]{16}")
  }
}
