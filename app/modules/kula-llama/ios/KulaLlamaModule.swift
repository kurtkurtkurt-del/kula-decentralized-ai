import ExpoModulesCore
import UIKit

/**
 * The JS face of kula-llama on iOS (src/llm/native.ts), function for function the same as
 * KulaLlamaModule.kt. The app is the master / local runner: it loads a model, generates,
 * downloads, finds peers and opens tunnels. The worker (Worker.swift) runs in this same
 * process and is only started/stopped/read from here.
 */
public class KulaLlamaModule: Module {
  private let generateQueue = DispatchQueue(label: "kula-llama", qos: .userInitiated)
  private var requestIds = 1
  private var tunnels = [String: Gate.Tunnel]()
  private var discovery: Discovery?
  private var downloader: ModelDownloader?

  public func definition() -> ModuleDefinition {
    Name("KulaLlama")
    Events("onToken", "onDone", "onDownload", "onPeerFound", "onPeerLost")

    Constants([
      "abi": "arm64",
      "gatePort": Gate.defaultPort,
    ])

    OnDestroy {
      self.tunnels.values.forEach { $0.stop() }
      self.discovery?.stop()
    }

    // --- device ---------------------------------------------------------------------
    AsyncFunction("info") { () -> [String: Any?] in
      #if targetEnvironment(simulator)
      let abi = "arm64-simulator"
      #else
      let abi = "arm64"
      #endif
      let ok = KulaLlamaBridge.initBackends()
      let models = Worker.modelsDir()
      return [
        "available": ok,
        "abi": abi,
        "fastCores": Worker.fastCoreCount(),
        "ramFreeMb": Worker.availableRamMb(),
        "modelsDir": models.path,
        "freeDiskMb": ModelDownloader.freeBytes(at: models) / (1024 * 1024),
        "workerId": Worker.workerId(),
        "wifiIp": KulaLlamaModule.wifiIp(),
      ]
    }

    AsyncFunction("memBandwidth") { (threads: Int) -> Double in
      KulaLlamaBridge.memBandwidth(threads > 0 ? threads : Worker.fastCoreCount())
    }
    AsyncFunction("ggufMeta") { (path: String) -> [String: String] in
      KulaLlamaModule.meta(path)
    }
    AsyncFunction("sha256") { (path: String) -> String in
      try ModelDownloader.sha256(of: URL(fileURLWithPath: path))
    }
    AsyncFunction("deleteFile") { (path: String) -> Bool in
      let fm = FileManager.default
      let a = (try? fm.removeItem(atPath: path)) != nil
      let b = (try? fm.removeItem(atPath: path + ".part")) != nil
      return a || b
    }
    AsyncFunction("listModels") { () -> [[String: Any]] in
      let dir = Worker.modelsDir()
      let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
      return names.map { name in
        let url = dir.appendingPathComponent(name)
        return ["name": name, "path": url.path, "size": ModelDownloader.size(of: url), "partial": name.hasSuffix(".part")]
      }
    }

    // --- download ---------------------------------------------------------------------
    AsyncFunction("download") { (id: String, url: String, name: String, sha256: String?, size: Double) in
      let dl = self.downloader ?? ModelDownloader { [weak self] did, got, total, state, error in
        self?.sendEvent("onDownload", ["id": did, "got": Double(got), "total": Double(total), "state": state, "error": error])
      }
      self.downloader = dl
      dl.start(id: id, url: url, dest: Worker.modelsDir().appendingPathComponent(name), sha256: sha256, expectedSize: Int64(size))
    }
    AsyncFunction("cancelDownload") { (id: String) in
      self.downloader?.cancel(id: id)
    }

    // --- model ------------------------------------------------------------------------
    AsyncFunction("loadModel") { (path: String, ctx: Int, threads: Int, peers: [[String: Any]], localWeight: Double) -> [String: Any?] in
      // peers: [{host, port, secret, weight}] → one tunnel each, llama connects to 127.0.0.1
      self.closeTunnels()
      var endpoints = [String]()
      var weights = [NSNumber]()
      for p in peers {
        guard let host = p["host"] as? String, let port = (p["port"] as? NSNumber)?.intValue, let secret = p["secret"] as? String else {
          throw Exception(name: "ERR_PEER", description: "peer without host/port/secret")
        }
        if let why = Gate.probe(host: host, port: port, secret: secret, channel: "rpc") {
          self.closeTunnels()
          throw Exception(name: "ERR_PEER", description: "peer \(host): \(why)")
        }
        let t = Gate.Tunnel(host: host, port: port, secret: secret, channel: "rpc")
        let local = try t.start()
        self.tunnels["\(host):\(port)"] = t
        endpoints.append("127.0.0.1:\(local)")
        weights.append(NSNumber(value: (p["weight"] as? NSNumber)?.floatValue ?? 1))
      }
      _ = KulaLlamaBridge.initBackends()
      if KulaLlamaBridge.isLoaded() { KulaLlamaBridge.freeModel() }
      let start = nowMs()
      let info: KulaLoadInfo
      do {
        info = try KulaLlamaBridge.loadModel(path, threads: threads > 0 ? threads : Worker.fastCoreCount(), ctx: ctx, endpoints: endpoints, weights: weights, localWeight: Float(localWeight))
      } catch {
        self.closeTunnels()
        throw Exception(name: "ERR_LOAD", description: error.localizedDescription)
      }
      let split: [[String: Any?]] = KulaLlamaBridge.lastLoadBuffers().split(separator: "\n").compactMap { line in
        guard let tab = line.firstIndex(of: "\t") else { return nil }
        return ["buffer": String(line[..<tab]), "mb": Double(line[line.index(after: tab)...])]
      }
      return ["loadMs": nowMs() - start, "localLayers": info.localLayers, "layers": info.layers, "ctx": info.ctx, "split": split]
    }
    AsyncFunction("unload") {
      KulaLlamaBridge.freeModel()
      self.closeTunnels()
    }
    Function("isLoaded") { KulaLlamaBridge.isLoaded() }
    Function("tokensUsed") { KulaLlamaBridge.tokensUsed() }
    Function("contextSize") { KulaLlamaBridge.contextSize() }
    AsyncFunction("clearContext") { KulaLlamaBridge.clearContext() }

    // Streams onToken {id, text} and ends with onDone {id, tokens, ms, firstMs, tps, stopped}.
    Function("generate") { (messages: [[String: String]], maxTokens: Int, temperature: Double, topP: Double, reset: Bool) -> Int in
      let id = self.requestIds
      self.requestIds += 1
      // its own thread with a deep stack: llama.cpp's graph build is recursive and the
      // 512 KB of a dispatch queue thread is not safe for it
      let t = Thread { [weak self] in
        let start = nowMs()
        var first: Int64 = 0
        do {
          if reset { KulaLlamaBridge.clearContext() }
          let prompt = try KulaLlamaBridge.applyTemplate(messages.map { $0["role"] ?? "user" }, contents: messages.map { $0["content"] ?? "" })
          let n = try KulaLlamaBridge.generate(prompt, maxTokens: maxTokens, temperature: Float(temperature), topP: Float(topP), topK: 40, minP: 0.05, repeatPenalty: 1.1, seed: -1) { piece in
            if first == 0 { first = nowMs() }
            self?.sendEvent("onToken", ["id": id, "text": piece])
          }
          let ms = nowMs() - start
          self?.sendEvent("onDone", ["id": id, "tokens": n, "ms": ms, "firstMs": first > 0 ? first - start : ms,
                                     "tps": n > 0 && ms > 0 ? Double(n) * 1000.0 / Double(ms) : 0.0, "stopped": n < 0, "error": nil])
        } catch {
          self?.sendEvent("onDone", ["id": id, "tokens": 0, "ms": nowMs() - start, "firstMs": 0, "tps": 0.0, "stopped": false, "error": error.localizedDescription])
        }
      }
      t.name = "kula-generate"
      t.stackSize = 8 << 20
      t.qualityOfService = .userInitiated
      t.start()
      return id
    }
    Function("stop") { KulaLlamaBridge.stop() }

    // --- peers --------------------------------------------------------------------------
    AsyncFunction("probePeer") { (host: String, port: Int, secret: String, channel: String) -> String? in
      Gate.probe(host: host, port: port, secret: secret, channel: channel)
    }
    /// Opens (or reuses) an `api` tunnel to a peer; JS talks HTTP to 127.0.0.1:<port>.
    AsyncFunction("apiTunnel") { (host: String, port: Int, secret: String) -> Int in
      let key = "api:\(host):\(port)"
      if let t = self.tunnels[key] { return t.localPort }
      let t = Gate.Tunnel(host: host, port: port, secret: secret, channel: "api")
      let local = try t.start()
      self.tunnels[key] = t
      return local
    }
    AsyncFunction("closeTunnels") { self.closeTunnels() }
    AsyncFunction("discover") { (on: Bool) in
      if on {
        if self.discovery == nil {
          self.discovery = Discovery(onFound: { [weak self] p in self?.sendEvent("onPeerFound", p) },
                                     onLost: { [weak self] name in self?.sendEvent("onPeerLost", ["serviceName": name]) })
        }
        self.discovery?.start()
      } else {
        self.discovery?.stop()
      }
    }

    // --- worker (this phone shared) --------------------------------------------------------
    AsyncFunction("startWorker") { (port: Int, secret: String, name: String) in
      try Worker.shared.start(port: port, secret: secret, name: name)
    }
    AsyncFunction("stopWorker") { Worker.shared.stop() }
    AsyncFunction("workerStatus") { () -> [String: Any?] in
      let s = Worker.shared.snapshot()
      let alive = Worker.shared.isRunning
      let state = !alive && s.state != "error" ? "stopped" : s.state
      return [
        "state": state, "error": s.error,
        "peer": alive ? s.peer : nil,
        "heldMb": s.heldMb, "ramMb": s.ramMb, "bandwidth": s.bandwidth,
        "throttled": alive && s.throttled, "connects": s.connects, "rejects": s.rejects,
        "id": Worker.workerId(),
        // no battery optimizer to ask on iOS: the screen stays on instead (keepScreenOn)
        "batteryUnrestricted": true,
      ]
    }
    AsyncFunction("gateLedger") { (limit: Int) -> [String] in
      Ledger.tail(Worker.ledgerFile(), limit)
    }
    AsyncFunction("keepScreenOn") { (on: Bool) in
      DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
    }
    AsyncFunction("requestBatteryUnrestricted") { () -> Bool in
      // nothing to request on iOS; the Android screen hides its link when this is true
      true
    }
  }

  private func closeTunnels() {
    tunnels.values.forEach { $0.stop() }
    tunnels.removeAll()
  }

  /// Parses ggufMeta's "key\tvalue" lines.
  static func meta(_ path: String) -> [String: String] {
    guard let text = KulaLlamaBridge.ggufMeta(path) else { return [:] }
    var out = [String: String]()
    for line in text.split(separator: "\n") {
      guard let tab = line.firstIndex(of: "\t") else { continue }
      out[String(line[..<tab])] = String(line[line.index(after: tab)...])
    }
    return out
  }

  /// The IPv4 of the Wi-Fi interface (en0), or of any other non-loopback interface.
  static func wifiIp() -> String? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }
    var fallback: String?
    var p: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = p {
      defer { p = ifa.pointee.ifa_next }
      guard let sa = ifa.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { continue }
      let flags = Int32(ifa.pointee.ifa_flags)
      if flags & IFF_UP == 0 || flags & IFF_LOOPBACK != 0 { continue }
      let name = String(cString: ifa.pointee.ifa_name)
      let addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
      let ip = TCPSocket.text(addr)
      if name == "en0" { return ip }
      // bridge100 is the personal hotspot; a phone sharing its own hotspot is a fine gate too
      if fallback == nil && (name.hasPrefix("en") || name.hasPrefix("bridge")) { fallback = ip }
    }
    return fallback
  }
}
