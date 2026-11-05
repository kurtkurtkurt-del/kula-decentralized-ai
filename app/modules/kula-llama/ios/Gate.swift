import CryptoKit
import Foundation
import os

/**
 * The gate: the one port a kula device opens on the network. ggml's RPC server has no
 * authentication and lets a client write memory, so it only ever listens on 127.0.0.1;
 * the gate sits in front and lets a connection through after a shared-secret handshake.
 * The secret is made at pairing time and travels only in the QR code.
 *
 * Protocol v1 (text lines, then a plain pipe), the same as Gate.kt and node/src/gate.ts:
 *   C: "KULA1 <channel> <nonce_c> [<unix_ms>]"   channel: rpc | api; nonces are 16 bytes hex;
 *                                           the optional 4th field (v1.1) is the client's clock
 *   S: "<nonce_s>"
 *   C: "<hmac_c>"                           HMAC-SHA256(secret, nonce_c|nonce_s|channel)
 *   S: "OK <hmac_s>"                        HMAC-SHA256(secret, nonce_s|nonce_c|channel), or "NO <why>"
 *
 * With an Auditor the server also checks the hello (a replayed nonce or a clock more than
 * two minutes off is refused) and writes connect/reject/end to the signed ledger.
 * All three implementations are checked against tools/gate-vectors.json.
 */
enum Gate {
  static let log = Logger(subsystem: "app.kula.llama", category: "gate")
  static let version = "KULA1"
  static let defaultPort = 50551

  static func newSecret() -> String { randomHex(32) }

  static func randomHex(_ bytes: Int) -> String {
    var buf = [UInt8](repeating: 0, count: bytes)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &buf)
    return hex(buf)
  }

  static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
  }

  static func hmac(_ secret: String, _ parts: String...) -> String {
    let key = SymmetricKey(data: Data(secret.utf8))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(parts.joined(separator: "|").utf8), using: key)
    return hex(mac)
  }

  static func sha256Hex(_ data: Data) -> String { hex(SHA256.hash(data: data)) }

  static func constantEquals(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    if x.count != y.count { return false }
    var r: UInt8 = 0
    for i in 0..<x.count { r |= x[i] ^ y[i] }
    return r == 0
  }

  static func isHex32(_ s: String) -> Bool {
    s.count == 32 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  /** What the gate knows per connection; the server's onEvent sees these. */
  struct Event {
    let kind: String
    let peer: String
    let channel: String?
    let why: String?
  }

  // MARK: - server (worker side)

  final class Server {
    private let port: UInt16
    private let secret: String
    /// channel -> local port to pipe to (rpc: ggml's server, api: ApiServer). nil = closed
    private let targets: (String) -> Int?
    private let auditor: Auditor?
    private let onEvent: (Event) -> Void
    private var running = false
    private var listener: TCPSocket?
    private let lock = NSLock()
    private var connected = 0
    private(set) var currentPeer: String?

    init(port: Int, secret: String, targets: @escaping (String) -> Int?, auditor: Auditor? = nil, onEvent: @escaping (Event) -> Void = { _ in }) {
      self.port = UInt16(port)
      self.secret = secret
      self.targets = targets
      self.auditor = auditor
      self.onEvent = onEvent
    }

    func start() throws {
      if running { return }
      running = true
      let l = try TCPSocket.listen(host: "0.0.0.0", port: port, backlog: 16)
      listener = l
      spawn("gate-accept") { [weak self] in
        while let self = self, self.running {
          guard let accepted = try? l.accept() else { break }
          let (s, peer) = accepted
          spawn("gate-conn") { self.handle(s, peer: peer) }
        }
      }
      Gate.log.info("gate listening on \(self.port)")
    }

    func stop() {
      running = false
      listener?.close()
      listener = nil
    }

    private func handle(_ s: TCPSocket, peer: String) {
      s.setTimeout(ms: 5000)
      s.setNoDelay()
      // the bounded byte-wise readLine, as on the client side: nothing before the proof is
      // trusted, so no unbounded buffering of a line that never ends, and no over-read to
      // hand on afterwards
      let hello = s.readLine()
      if hello.isEmpty { return refuse(s, peer, nil, "no hello") }
      let p = hello.trimmingCharacters(in: .whitespaces).split(separator: " ", omittingEmptySubsequences: false).map(String.init)
      if (p.count != 3 && p.count != 4) || p[0] != Gate.version { return refuse(s, peer, nil, "bad hello") }
      let channel = p[1]
      let nonceC = p[2]
      if channel != "rpc" && channel != "api" { return refuse(s, peer, channel, "bad channel") }
      if !Gate.isHex32(nonceC) { return refuse(s, peer, channel, "bad nonce") }
      var clientMs: Int64?
      if p.count == 4 {
        guard let ms = Int64(p[3]) else { return refuse(s, peer, channel, "bad hello") }
        clientMs = ms
      }
      // an auditor that throws must not take the gate down; its verdicts do refuse
      if let a = auditor {
        let verdict = a.onHello(peer: peer, nonce: nonceC, tMs: clientMs)
        if !verdict.ok { return refuse(s, peer, channel, verdict.reason ?? "audit") }
      }
      let nonceS = Gate.randomHex(16)
      do { try s.write("\(nonceS)\n") } catch { return refuse(s, peer, channel, "closed") }
      let proof = s.readLine().trimmingCharacters(in: .whitespaces)
      if proof.isEmpty { return refuse(s, peer, channel, "no proof") }
      if !Gate.constantEquals(proof, Gate.hmac(secret, nonceC, nonceS, channel)) { return refuse(s, peer, channel, "wrong secret") }
      guard let target = targets(channel) else { return refuse(s, peer, channel, "channel closed") }
      // one master at a time on the rpc channel
      lock.lock()
      let busy = channel == "rpc" && currentPeer != nil && currentPeer != peer
      lock.unlock()
      if busy { return refuse(s, peer, channel, "busy") }
      guard let local = try? TCPSocket.connect(host: "127.0.0.1", port: target, timeoutMs: 2000) else { return refuse(s, peer, channel, "target down") }
      do { try s.write("OK \(Gate.hmac(secret, nonceS, nonceC, channel))\n") } catch { local.close(); return refuse(s, peer, channel, "closed") }
      s.setTimeout(ms: 0)
      onEvent(Event(kind: "connect", peer: peer, channel: channel, why: nil))
      audit { $0.onConnect(peer: peer, channel: channel) }
      let started = nowMs()
      if channel == "rpc" { lock.lock(); currentPeer = peer; connected += 1; lock.unlock() }
      let bytes = TCPSocket.pipe(s, local)
      if channel == "rpc" { lock.lock(); connected -= 1; if connected == 0 { currentPeer = nil }; lock.unlock() }
      onEvent(Event(kind: "end", peer: peer, channel: channel, why: nil))
      audit { $0.onEnd(peer: peer, channel: channel, bytes: bytes, seconds: (nowMs() - started) / 1000) }
    }

    private func refuse(_ s: TCPSocket, _ peer: String, _ channel: String?, _ why: String) {
      Gate.log.warning("refused \(peer) (\(channel ?? "-")): \(why)")
      onEvent(Event(kind: "reject", peer: peer, channel: channel, why: why))
      // the answer first, then the record: a ledger that cannot be written must not leave
      // the client hanging without its NO
      try? s.write("NO \(why)\n")
      s.close()
      audit { $0.onReject(peer: peer, channel: channel, why: why) }
    }

    /// Runs an auditor hook; a failure (disk full, directory gone) is logged and never breaks the connection.
    private func audit(_ block: (Auditor) throws -> Void) {
      guard let a = auditor else { return }
      do { try block(a) } catch { Gate.log.warning("auditor: \(error.localizedDescription)") }
    }
  }

  // MARK: - client (master side)

  /// Performs the handshake on an open socket; throws with the gate's reason when refused.
  static func handshake(_ s: TCPSocket, secret: String, channel: String) throws {
    s.setTimeout(ms: 5000)
    s.setNoDelay()
    let nonceC = randomHex(16)
    try s.write("\(version) \(channel) \(nonceC)\n")
    let nonceS = s.readLine()
    if !isHex32(nonceS) { throw SocketError.failed("gate: bad nonce (\(nonceS.prefix(40)))") }
    try s.write("\(hmac(secret, nonceC, nonceS, channel))\n")
    let reply = s.readLine()
    if !reply.hasPrefix("OK ") { throw SocketError.failed("gate: \(reply.isEmpty ? "closed" : reply)") }
    let proof = String(reply.dropFirst(3)).trimmingCharacters(in: .whitespaces)
    if !constantEquals(proof, hmac(secret, nonceS, nonceC, channel)) { throw SocketError.failed("gate: server proof wrong") }
    s.setTimeout(ms: 0)
  }

  /// A 2 s TCP + handshake probe: can this peer be used right now? nil when yes, else the reason.
  static func probe(host: String, port: Int, secret: String, channel: String = "rpc", timeoutMs: Int = 2000) -> String? {
    do {
      let s = try TCPSocket.connect(host: host, port: port, timeoutMs: timeoutMs)
      defer { s.close() }
      try handshake(s, secret: secret, channel: channel)
      return nil
    } catch {
      return error.localizedDescription.isEmpty ? "unreachable" : error.localizedDescription
    }
  }

  /**
   * Local tunnel: llama.cpp connects to 127.0.0.1:<returned port>; each connection is
   * handshaken to the peer's gate and piped. One tunnel per peer; stop() closes it.
   */
  final class Tunnel {
    private let host: String
    private let port: Int
    private let secret: String
    private let channel: String
    private var listener: TCPSocket?
    private var running = false
    var localPort: Int { Int(listener?.localPort ?? 0) }

    init(host: String, port: Int, secret: String, channel: String = "rpc") {
      self.host = host
      self.port = port
      self.secret = secret
      self.channel = channel
    }

    func start() throws -> Int {
      let l = try TCPSocket.listen(host: "127.0.0.1", port: 0, backlog: 8)
      listener = l
      running = true
      spawn("gate-tunnel") { [weak self] in
        while let self = self, self.running {
          guard let accepted = try? l.accept() else { break }
          let local = accepted.0
          spawn("gate-tunnel-conn") {
            do {
              let remote = try TCPSocket.connect(host: self.host, port: self.port, timeoutMs: 4000)
              try Gate.handshake(remote, secret: self.secret, channel: self.channel)
              _ = TCPSocket.pipe(local, remote)
            } catch {
              Gate.log.warning("tunnel to \(self.host):\(self.port): \(error.localizedDescription)")
              local.close()
            }
          }
        }
      }
      return Int(l.localPort)
    }

    func stop() {
      running = false
      listener?.close()
      listener = nil
    }
  }
}
