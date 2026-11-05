import CryptoKit
import Foundation

/**
 * The audit ledger (Ledger.kt): append-only JSON lines, each hash-chained to the one
 * before and signed by the device key.
 *
 *   {"t":<unix ms>,"kind":"...","peer":"...", ...fields, "prev":"<sha256 hex of the previous
 *    line's bytes, 64 zeros for the first>","sig":"<base64 signature>"}
 *
 * The signature covers the line text up to and including the prev value's closing quote,
 * that is the line without `,"sig":"..."}`. The hash in the next line's prev is SHA-256 of
 * the whole previous line (UTF-8, without the newline). When a file passes maxBytes it is
 * renamed to `<name>.<t>.jsonl` and the next line's prev still points at its last line, so
 * the chain continues across files. Appends are serialized; nothing is ever rewritten.
 */
final class Ledger {
  static let genesis = String(repeating: "0", count: 64)
  let file: URL
  private let key: DeviceKey
  private let maxBytes: Int64
  private let now: () -> Int64
  private let lock = NSLock()
  private(set) var lastHash: String

  init(file: URL, key: DeviceKey, maxBytes: Int64 = 5 * 1024 * 1024, now: @escaping () -> Int64 = nowMs) {
    self.file = file
    self.key = key
    self.maxBytes = maxBytes
    self.now = now
    self.lastHash = Ledger.lastHashOf(file)
  }

  /// Appends one event and returns the line as written (without the newline).
  @discardableResult
  func append(_ kind: String, peer: String?, fields: [(String, Any?)] = [], t: Int64? = nil) throws -> String {
    lock.lock(); defer { lock.unlock() }
    let stamp = t ?? now()
    var ordered = OrderedJSON()
    ordered["t"] = stamp
    ordered["kind"] = kind
    if let p = peer { ordered["peer"] = p }
    for (k, v) in fields where !["t", "kind", "peer", "prev", "sig"].contains(k) { ordered[k] = v }
    ordered["prev"] = lastHash
    let line = try Ledger.sign(ordered.render(), key: key)
    try rotateIfFull(stamp)
    let fm = FileManager.default
    try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil) }
    let h = try FileHandle(forWritingTo: file)
    defer { try? h.close() }
    try h.seekToEnd()
    h.write(Data((line + "\n").utf8))
    lastHash = Ledger.sha256Hex(Data(line.utf8))
    return line
  }

  /// The last `limit` lines of the current file, oldest first.
  func tail(_ limit: Int) -> [String] { Ledger.tail(file, limit) }

  private func rotateIfFull(_ t: Int64) throws {
    let fm = FileManager.default
    guard fm.fileExists(atPath: file.path), ModelDownloader.size(of: file) > maxBytes else { return }
    let dir = file.deletingLastPathComponent()
    var base = file.lastPathComponent
    if base.hasSuffix(".jsonl") { base.removeLast(6) }
    var target = dir.appendingPathComponent("\(base).\(t).jsonl")
    var n = 1
    while fm.fileExists(atPath: target.path) { target = dir.appendingPathComponent("\(base).\(t).\(n).jsonl"); n += 1 }
    try fm.moveItem(at: file, to: target)
  }

  static func sha256Hex(_ data: Data) -> String { Gate.sha256Hex(data) }

  /// Signs an unsigned line (a complete JSON object ending in the prev field).
  static func sign(_ unsigned: String, key: DeviceKey) throws -> String {
    var body = unsigned
    if body.hasSuffix("}") { body.removeLast() }
    let sig = try key.sign(Data(body.utf8)).base64EncodedString()
    return "\(body),\"sig\":\"\(sig)\"}"
  }

  /// The parts of a line: the signed body, the prev value and the signature; nil when malformed.
  static func split(_ line: String) -> (body: String, prev: String, sig: Data)? {
    guard let tail = line.range(of: #",\"sig\":\"[A-Za-z0-9+/=]*\"\}$"#, options: .regularExpression) else { return nil }
    let body = String(line[..<tail.lowerBound])
    let sigText = line[tail].dropFirst(8).dropLast(2)
    guard let prevRange = body.range(of: #""prev":"[0-9a-f]{64}""#, options: .regularExpression) else { return nil }
    let prev = String(body[prevRange].dropFirst(8).dropLast(1))
    guard let sig = Data(base64Encoded: String(sigText)) else { return nil }
    return (body, prev, sig)
  }

  /**
   * Walks the chain in file and returns the index of the first line that fails, or -1.
   * firstPrev is what the first line's prev must be: the genesis zeros for a fresh ledger,
   * or the last hash of the file rotated away before it.
   */
  static func verify(_ file: URL, publicKey: Data, alg: String, firstPrev: String = genesis) -> Int {
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return -1 }
    var expected = firstPrev
    for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() where !line.isEmpty {
      let l = String(line)
      guard let parts = split(l) else { return i }
      if parts.prev != expected { return i }
      if !DeviceKeys.verify(alg: alg, publicKey: publicKey, bytes: Data(parts.body.utf8), sig: parts.sig) { return i }
      expected = sha256Hex(Data(l.utf8))
    }
    return -1
  }

  /// SHA-256 of the last line of file, or the genesis zeros when there is none.
  static func lastHashOf(_ file: URL) -> String {
    guard let text = try? String(contentsOf: file, encoding: .utf8) else { return genesis }
    let last = text.split(separator: "\n").last { !$0.isEmpty }
    return last.map { sha256Hex(Data($0.utf8)) } ?? genesis
  }

  static func tail(_ file: URL, _ limit: Int) -> [String] {
    guard limit > 0, let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
    let lines = text.split(separator: "\n").filter { !$0.isEmpty }.map(String.init)
    return Array(lines.suffix(limit))
  }
}
