import Foundation

/// What a rule decided: ok or not, why not, and any warnings that do not refuse (Checks.kt).
struct Verdict {
  let ok: Bool
  let reason: String?
  let warn: [String]

  init(_ ok: Bool, reason: String? = nil, warn: [String] = []) {
    self.ok = ok
    self.reason = reason
    self.warn = warn
  }

  static let OK = Verdict(true)
  static func reject(_ reason: String) -> Verdict { Verdict(false, reason: reason) }
  static func warn(_ w: String...) -> Verdict { Verdict(true, reason: nil, warn: w) }
}

/**
 * Per-peer memory of the last `size` nonces, the only state the checks keep. At most
 * `maxPeers` addresses are remembered, least recently seen first out: hellos arrive before
 * the secret is checked, so any host on the lan could otherwise pin a ring per address.
 */
final class ReplayRing {
  private final class Peer {
    var ring = [String]()
    var seen = Set<String>()
  }
  private let size: Int
  private let maxPeers: Int
  private var peers = [String: Peer]()
  private var order = [String]()  // least recently seen first
  private let lock = NSLock()

  init(size: Int = 1000, maxPeers: Int = 64) {
    self.size = size
    self.maxPeers = maxPeers
  }

  /// True when `nonce` was already used by `peer`; remembers it otherwise.
  func seenBefore(_ nonce: String, peer: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    let p: Peer
    if let have = peers[peer] {
      p = have
      order.removeAll { $0 == peer }
    } else {
      p = Peer()
      peers[peer] = p
    }
    order.append(peer)
    while order.count > maxPeers {
      peers[order.removeFirst()] = nil
    }
    if p.seen.contains(nonce) { return true }
    p.seen.insert(nonce)
    p.ring.append(nonce)
    if p.ring.count > size { p.seen.remove(p.ring.removeFirst()) }
    return false
  }

  /// How many addresses are remembered right now.
  func peerCount() -> Int {
    lock.lock(); defer { lock.unlock() }
    return peers.count
  }
}

/**
 * The rules of beyin/check v0. Pure functions over what the gate and worker observe; none
 * of them touches the system, the network or the ledger. Twin of Checks.kt.
 */
enum Checks {
  static let clockSkewMs: Int64 = 120_000
  static let claimWarn = 2.0
  static let claimReject = 4.0
  static let hotC = 42.0
  static let lowBatteryPct = 15

  /// Rule 1a: a nonce a peer already used is a replay.
  static func replay(_ ring: ReplayRing, nonce: String, peer: String) -> Verdict {
    ring.seenBefore(nonce, peer: peer) ? .reject("replay") : .OK
  }

  /// Rule 1b: a hello whose clock is more than two minutes from ours.
  static func clock(_ ms: Int64, now: Int64) -> Verdict {
    abs(ms - now) > clockSkewMs ? .reject("clock") : .OK
  }

  /**
   * Rule 2: what a device claims against what we measure. Measured RAM is heldMb; measured
   * bandwidth is tps × modelGb (GB/s). A measurement of zero means "not yet measured" and
   * that side is skipped. Off by more than 2× warns, more than 4× rejects.
   */
  static func claim(ramClaimedMb: Int64, heldMb: Int64, bwClaimed: Double, tps: Double, modelGb: Double) -> Verdict {
    var warns = [String]()
    var reject = false
    func judge(_ name: String, _ claimed: Double, _ measured: Double) {
      if claimed <= 0 || measured <= 0 { return }
      let ratio = max(claimed / measured, measured / claimed)
      if ratio > claimReject { reject = true } else if ratio > claimWarn { warns.append(name) }
    }
    judge("ram", Double(ramClaimedMb), Double(heldMb))
    judge("bandwidth", bwClaimed, tps * modelGb)
    return reject ? .reject("claim") : Verdict(true, reason: nil, warn: warns)
  }

  /// Rule 3: the model a device reports loading must be the one that was asked for.
  static func modelIntegrity(expectedSha: String, reportedSha: String) -> Verdict {
    expectedSha.lowercased() == reportedSha.lowercased() ? .OK : .reject("model")
  }

  /// Per-connection limits for rule 4.
  struct Limits {
    var maxBytes: Int64 = 64 * 1024 * 1024 * 1024
    var maxSeconds: Int64 = 12 * 3600
  }

  /// Rule 4: a connection that moved more bytes or lasted longer than the limits allow.
  static func bounds(bytes: Int64, seconds: Int64, limits: Limits) -> Verdict {
    bytes > limits.maxBytes || seconds > limits.maxSeconds ? .reject("bounds") : .OK
  }

  /// Rule 5: never refuses; warns when throttled, hotter than 42 °C or under 15 % battery.
  static func health(throttled: Bool, batteryC: Double, batteryPct: Int) -> Verdict {
    var w = [String]()
    if throttled { w.append("throttled") }
    if batteryC > hotC { w.append("hot") }
    if batteryPct >= 0 && batteryPct < lowBatteryPct { w.append("battery") }
    return Verdict(true, reason: nil, warn: w)
  }
}
