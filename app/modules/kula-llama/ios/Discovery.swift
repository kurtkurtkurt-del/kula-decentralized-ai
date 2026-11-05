import Foundation
import os

/**
 * Finds workers nearby: browses _kula._tcp over Bonjour and resolves each service as it
 * appears, one at a time like Discovery.kt. onFound gets the map the JS side keeps as a
 * peer candidate; onLost its service name. Needs NSBonjourServices and
 * NSLocalNetworkUsageDescription in Info.plist (app.json sets them); iOS asks the user
 * for local network access the first time.
 */
final class Discovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  static let serviceType = "_kula._tcp."
  private static let log = Logger(subsystem: "app.kula.llama", category: "discovery")
  private let onFound: ([String: Any?]) -> Void
  private let onLost: (String) -> Void
  private var browser: NetServiceBrowser?
  private var queue = [NetService]()
  private var resolving: NetService?

  init(onFound: @escaping ([String: Any?]) -> Void, onLost: @escaping (String) -> Void) {
    self.onFound = onFound
    self.onLost = onLost
  }

  func start() {
    DispatchQueue.main.async {
      if self.browser != nil { return }
      let b = NetServiceBrowser()
      b.delegate = self
      b.schedule(in: .main, forMode: .common)
      b.searchForServices(ofType: Discovery.serviceType, inDomain: "local.")
      self.browser = b
    }
  }

  func stop() {
    DispatchQueue.main.async {
      self.browser?.stop()
      self.browser = nil
      self.resolving?.stop()
      self.resolving = nil
      self.queue.removeAll()
    }
  }

  // MARK: NetServiceBrowserDelegate

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    queue.append(service)
    next()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    onLost(service.name)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    Discovery.log.error("discovery failed (\(errorDict.description))")
  }

  private func next() {
    if resolving != nil || queue.isEmpty { return }
    let s = queue.removeFirst()
    resolving = s
    s.delegate = self
    s.schedule(in: .main, forMode: .common)
    s.resolve(withTimeout: 5)
  }

  private func done() {
    resolving = nil
    next()
  }

  // MARK: NetServiceDelegate

  func netServiceDidResolveAddress(_ sender: NetService) {
    var attrs = [String: String]()
    if let txt = sender.txtRecordData() {
      for (k, v) in NetService.dictionary(fromTXTRecord: txt) { attrs[k] = String(data: v, encoding: .utf8) }
    }
    let host = Discovery.ipv4(sender.addresses ?? [])
    let name = attrs["name"] ?? sender.name.replacingOccurrences(of: "kula ", with: "", options: .anchored)
    onFound([
      "serviceName": sender.name,
      "name": name,
      "host": host,
      "port": sender.port,
      "id": attrs["id"],
      "ram": attrs["ram"].flatMap { Int64($0) },
      "bw": attrs["bw"].flatMap { Double($0) },
      "kind": attrs["kind"] ?? "phone",
      "v": attrs["v"],
    ])
    done()
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    Discovery.log.warning("resolve failed \(sender.name) (\(errorDict.description))")
    done()
  }

  /// The first IPv4 address among a service's sockaddr blobs.
  static func ipv4(_ addresses: [Data]) -> String? {
    for data in addresses {
      let family = data.withUnsafeBytes { $0.load(fromByteOffset: 1, as: UInt8.self) }
      if Int32(family) != AF_INET || data.count < MemoryLayout<sockaddr_in>.size { continue }
      let addr: in_addr = data.withUnsafeBytes { $0.load(fromByteOffset: 4, as: in_addr.self) }
      return TCPSocket.text(addr)
    }
    return nil
  }
}
