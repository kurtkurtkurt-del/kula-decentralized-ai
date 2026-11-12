package expo.modules.kulallama.audit

import org.json.JSONObject

/**
 * beyin/check v0 on the device: hears what the gate and worker see, runs the rules, and
 * writes every event to the ledger. It hands out no work and talks to no server. The
 * rejecting hooks return their Verdict so the gate can refuse the connection.
 */
class Auditor(
  val ledger: Ledger,
  val key: DeviceKey,
  private val now: () -> Long = System::currentTimeMillis,
  private val limits: Checks.Limits = Checks.Limits(),
) {
  private val ring = ReplayRing()

  /** A device was paired (its secret was made or scanned). */
  fun onPair(peer: String, fields: Map<String, Any?> = emptyMap()): String = ledger.append("pair", peer, fields)

  /**
   * The client's hello line: replay on its nonce, clock on its timestamp when it sent one.
   * Writes nothing by itself; the gate's reject or connect that follows is the record.
   */
  fun onHello(peer: String, nonce: String, tMs: Long?): Verdict {
    val r = Checks.replay(ring, nonce, peer)
    if (!r.ok) return r
    if (tMs != null) return Checks.clock(tMs, now())
    return Verdict.OK
  }

  fun onConnect(peer: String, channel: String): String = ledger.append("connect", peer, mapOf("channel" to channel))

  fun onReject(peer: String, channel: String?, why: String): String =
    ledger.append("reject", peer, linkedMapOf("channel" to channel, "why" to why))

  /** A model was loaded over a split: which peer holds how many layers, and the file's sha. */
  fun onLoad(split: List<Pair<String, Int>>, sha: String, expectedSha: String? = null): Verdict {
    val v = if (expectedSha != null) Checks.modelIntegrity(expectedSha, sha) else Verdict.OK
    val fields = linkedMapOf<String, Any?>("split" to split.map { linkedMapOf("peer" to it.first, "layers" to it.second) }, "sha" to sha)
    putVerdict(fields, v)
    ledger.append("load", null, fields)
    return v
  }

  fun onClaim(peer: String, ramClaimedMb: Long, heldMb: Long, bwClaimed: Double, tps: Double, modelGb: Double): Verdict {
    val v = Checks.claim(ramClaimedMb, heldMb, bwClaimed, tps, modelGb)
    val fields = linkedMapOf<String, Any?>("ramMb" to ramClaimedMb, "heldMb" to heldMb, "bw" to bwClaimed, "tps" to tps, "modelGb" to modelGb)
    putVerdict(fields, v)
    ledger.append("claim", peer, fields)
    return v
  }

  /** [charging]: a power source is plugged in (null: Android did not say); written only when known. */
  fun onHealth(throttled: Boolean, batteryC: Double, batteryPct: Int, charging: Boolean? = null): Verdict {
    val v = Checks.health(throttled, batteryC, batteryPct)
    val fields = linkedMapOf<String, Any?>("throttled" to throttled, "batteryC" to batteryC, "batteryPct" to batteryPct)
    if (charging != null) fields["charging"] = charging
    putVerdict(fields, v)
    ledger.append("health", null, fields)
    return v
  }

  fun onEnd(peer: String, channel: String, bytes: Long, seconds: Long): Verdict {
    val v = Checks.bounds(bytes, seconds, limits)
    val fields = linkedMapOf<String, Any?>("channel" to channel, "bytes" to bytes, "seconds" to seconds)
    putVerdict(fields, v)
    ledger.append("end", peer, fields)
    return v
  }

  /** The last [limit] ledger lines, parsed, oldest first. For a settings page later. */
  fun summary(limit: Int): List<JSONObject> = ledger.tail(limit).mapNotNull { runCatching { JSONObject(it) }.getOrNull() }

  private fun putVerdict(fields: MutableMap<String, Any?>, v: Verdict) {
    if (!v.ok) fields["reject"] = v.reason
    if (v.warn.isNotEmpty()) fields["warn"] = v.warn
  }
}
