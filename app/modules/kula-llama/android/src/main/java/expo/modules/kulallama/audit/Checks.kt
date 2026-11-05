package expo.modules.kulallama.audit

/** What a rule decided: ok or not, why not, and any warnings that do not refuse. */
data class Verdict(val ok: Boolean, val reason: String? = null, val warn: List<String> = emptyList()) {
  companion object {
    val OK = Verdict(true)
    fun reject(reason: String) = Verdict(false, reason)
    fun warn(vararg w: String) = Verdict(true, null, w.toList())
  }
}

/** Per-peer memory of the last [size] nonces, the only state the checks keep. */
class ReplayRing(private val size: Int = 1000) {
  private val rings = HashMap<String, ArrayDeque<String>>()
  private val seen = HashMap<String, HashSet<String>>()

  /** True when [nonce] was already used by [peer]; remembers it otherwise. */
  @Synchronized
  fun seenBefore(nonce: String, peer: String): Boolean {
    val set = seen.getOrPut(peer) { HashSet() }
    if (!set.add(nonce)) return true
    val ring = rings.getOrPut(peer) { ArrayDeque() }
    ring.addLast(nonce)
    if (ring.size > size) set.remove(ring.removeFirst())
    return false
  }
}

/**
 * The rules of beyin/check v0. Pure functions over what the gate and worker observe; none
 * of them touches Android, the network or the ledger.
 */
object Checks {
  const val CLOCK_SKEW_MS = 120_000L
  const val CLAIM_WARN = 2.0
  const val CLAIM_REJECT = 4.0
  const val HOT_C = 42.0
  const val LOW_BATTERY_PCT = 15

  /** Rule 1a: a nonce a peer already used is a replay. */
  fun replay(ring: ReplayRing, nonce: String, peer: String): Verdict =
    if (ring.seenBefore(nonce, peer)) Verdict.reject("replay") else Verdict.OK

  /** Rule 1b: a hello whose clock is more than two minutes from ours. */
  fun clock(ms: Long, now: Long): Verdict =
    if (Math.abs(ms - now) > CLOCK_SKEW_MS) Verdict.reject("clock") else Verdict.OK

  /**
   * Rule 2: what a device claims against what we measure. Measured RAM is [heldMb];
   * measured bandwidth is [tps] × [modelGb] (GB/s). A measurement of zero means "not yet
   * measured" and that side is skipped. Off by more than 2× warns, more than 4× rejects.
   */
  fun claim(ramClaimedMb: Long, heldMb: Long, bwClaimed: Double, tps: Double, modelGb: Double): Verdict {
    val warns = ArrayList<String>()
    var reject = false
    fun judge(name: String, claimed: Double, measured: Double) {
      if (claimed <= 0 || measured <= 0) return
      val ratio = Math.max(claimed / measured, measured / claimed)
      if (ratio > CLAIM_REJECT) reject = true
      else if (ratio > CLAIM_WARN) warns.add(name)
    }
    judge("ram", ramClaimedMb.toDouble(), heldMb.toDouble())
    judge("bandwidth", bwClaimed, tps * modelGb)
    return if (reject) Verdict.reject("claim") else Verdict(true, null, warns)
  }

  /** Rule 3: the model a device reports loading must be the one that was asked for. */
  fun modelIntegrity(expectedSha: String, reportedSha: String): Verdict =
    if (expectedSha.equals(reportedSha, ignoreCase = true)) Verdict.OK else Verdict.reject("model")

  /** Per-connection limits for rule 4. */
  data class Limits(val maxBytes: Long = 64L * 1024 * 1024 * 1024, val maxSeconds: Long = 12 * 3600)

  /** Rule 4: a connection that moved more bytes or lasted longer than the limits allow. */
  fun bounds(bytes: Long, seconds: Long, limits: Limits): Verdict =
    if (bytes > limits.maxBytes || seconds > limits.maxSeconds) Verdict.reject("bounds") else Verdict.OK

  /** Rule 5: never refuses; warns when throttled, hotter than 42 °C or under 15 % battery. */
  fun health(throttled: Boolean, batteryC: Double, batteryPct: Int): Verdict {
    val w = ArrayList<String>()
    if (throttled) w.add("throttled")
    if (batteryC > HOT_C) w.add("hot")
    if (batteryPct in 0 until LOW_BATTERY_PCT) w.add("battery")
    return Verdict(true, null, w)
  }
}
