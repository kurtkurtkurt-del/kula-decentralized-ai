import Foundation

/**
 * beyin/check v0 on the device (Auditor.kt): hears what the gate and worker see, runs the
 * rules, and writes every event to the ledger. It hands out no work and talks to no server.
 * The rejecting hooks return their Verdict so the gate can refuse the connection.
 */
final class Auditor {
  let ledger: Ledger
  let key: DeviceKey
  private let now: () -> Int64
  private let limits: Checks.Limits
  private let ring = ReplayRing()

  init(ledger: Ledger, key: DeviceKey, now: @escaping () -> Int64 = nowMs, limits: Checks.Limits = Checks.Limits()) {
    self.ledger = ledger
    self.key = key
    self.now = now
    self.limits = limits
  }

  /// A device was paired (its secret was made or scanned).
  @discardableResult
  func onPair(peer: String, fields: [(String, Any?)] = []) throws -> String { try ledger.append("pair", peer: peer, fields: fields) }

  /**
   * The client's hello line: replay on its nonce, clock on its timestamp when it sent one.
   * Writes nothing by itself; the gate's reject or connect that follows is the record.
   */
  func onHello(peer: String, nonce: String, tMs: Int64?) -> Verdict {
    let r = Checks.replay(ring, nonce: nonce, peer: peer)
    if !r.ok { return r }
    if let t = tMs { return Checks.clock(t, now: now()) }
    return .OK
  }

  @discardableResult
  func onConnect(peer: String, channel: String) throws -> String { try ledger.append("connect", peer: peer, fields: [("channel", channel)]) }

  @discardableResult
  func onReject(peer: String, channel: String?, why: String) throws -> String {
    try ledger.append("reject", peer: peer, fields: [("channel", channel), ("why", why)])
  }

  /// A model was loaded over a split: which peer holds how many layers, and the file's sha.
  @discardableResult
  func onLoad(split: [(String, Int)], sha: String, expectedSha: String? = nil) throws -> Verdict {
    let v = expectedSha.map { Checks.modelIntegrity(expectedSha: $0, reportedSha: sha) } ?? .OK
    var fields: [(String, Any?)] = [("split", split.map { OrderedJSON([("peer", $0.0), ("layers", $0.1)]) }), ("sha", sha)]
    putVerdict(&fields, v)
    try ledger.append("load", peer: nil, fields: fields)
    return v
  }

  @discardableResult
  func onClaim(peer: String, ramClaimedMb: Int64, heldMb: Int64, bwClaimed: Double, tps: Double, modelGb: Double) throws -> Verdict {
    let v = Checks.claim(ramClaimedMb: ramClaimedMb, heldMb: heldMb, bwClaimed: bwClaimed, tps: tps, modelGb: modelGb)
    var fields: [(String, Any?)] = [("ramMb", ramClaimedMb), ("heldMb", heldMb), ("bw", bwClaimed), ("tps", tps), ("modelGb", modelGb)]
    putVerdict(&fields, v)
    try ledger.append("claim", peer: peer, fields: fields)
    return v
  }

  @discardableResult
  func onHealth(throttled: Bool, batteryC: Double, batteryPct: Int) throws -> Verdict {
    let v = Checks.health(throttled: throttled, batteryC: batteryC, batteryPct: batteryPct)
    var fields: [(String, Any?)] = [("throttled", throttled), ("batteryC", batteryC), ("batteryPct", batteryPct)]
    putVerdict(&fields, v)
    try ledger.append("health", peer: nil, fields: fields)
    return v
  }

  @discardableResult
  func onEnd(peer: String, channel: String, bytes: Int64, seconds: Int64) throws -> Verdict {
    let v = Checks.bounds(bytes: bytes, seconds: seconds, limits: limits)
    var fields: [(String, Any?)] = [("channel", channel), ("bytes", bytes), ("seconds", seconds)]
    putVerdict(&fields, v)
    try ledger.append("end", peer: peer, fields: fields)
    return v
  }

  private func putVerdict(_ fields: inout [(String, Any?)], _ v: Verdict) {
    if !v.ok { fields.append(("reject", v.reason)) }
    if !v.warn.isEmpty { fields.append(("warn", v.warn)) }
  }
}
