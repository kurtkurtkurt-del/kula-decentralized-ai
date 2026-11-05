import Foundation
import UIKit
import os

/**
 * This device as a worker ("share this phone"), the iOS twin of WorkerService.kt: the gate
 * on the network, and behind it on 127.0.0.1 ggml's RPC server (split mode) and the
 * ApiServer (apart mode). Advertised over Bonjour as _kula._tcp so a master nearby can
 * find it.
 *
 * iOS differences, all of them documented in docs/IOS.md:
 *  - No second process. ggml's server loop cannot be stopped, so its thread stays until the
 *    app is killed; stop() closes the gate, the api and the advertisement, which is what
 *    the network sees. A later start() reuses the still-running RPC server on its port.
 *  - Foreground only. There is no foreground service; the app keeps the screen awake while
 *    sharing (idle timer off) and iOS suspends it a few seconds after it leaves the screen.
 *  - The worker and the app's own model share one llama.cpp state: a master that loads an
 *    apart-mode model here replaces whatever this phone had loaded for itself.
 */
final class Worker: NSObject, NetServiceDelegate {
  static let shared = Worker()
  private static let log = Logger(subsystem: "app.kula.llama", category: "worker")
  static let serviceType = Discovery.serviceType
  private static let claimMinHeldMb: Int64 = 256

  struct Status {
    var state = "stopped"
    var error: String?
    var peer: String?
    var heldMb: Int64 = 0
    var ramMb: Int64 = 0
    var bandwidth = 0.0
    var throttled = false
    var connects = 0
    var rejects = 0
  }

  private let lock = NSLock()
  private var status = Status()
  private var running = false
  private var gate: Gate.Server?
  private var api: ApiServer?
  private var auditor: Auditor?
  private var service: NetService?
  private var rpcPort = 0
  private var serveStarted = false
  private var filesDir: URL!
  private var modelsDir: URL!

  func snapshot() -> Status {
    lock.lock(); defer { lock.unlock() }
    return status
  }

  var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }

  private func update(_ f: (inout Status) -> Void) {
    lock.lock(); f(&status); lock.unlock()
  }

  // MARK: paths shared with the module

  static func filesDir() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("kula-llama")
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
  }
  static func modelsDir() -> URL {
    let dir = filesDir().appendingPathComponent("models")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    ModelDownloader.excludeFromBackup(dir)
    return dir
  }
  static func deviceKeyFile() -> URL { filesDir().appendingPathComponent("kula_device_key") }
  static func ledgerFile() -> URL { filesDir().appendingPathComponent("beyin").appendingPathComponent("ledger.jsonl") }

  /// Lasting worker id, in a file so it survives reinstalls of the JS bundle.
  static func workerId() -> String {
    let f = filesDir().appendingPathComponent("kula_worker_id")
    if let s = try? String(contentsOf: f, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
    let id = UUID().uuidString.lowercased()
    try? id.write(to: f, atomically: true, encoding: .utf8)
    return id
  }

  static func availableRamMb() -> Int64 { Int64(os_proc_available_memory()) / (1024 * 1024) }

  /// Resident memory of this process in MB (VmRSS on Android).
  static func residentMb() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let rc = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return rc == KERN_SUCCESS ? Int64(info.phys_footprint) / (1024 * 1024) : 0
  }

  /// iOS tells us about thermal pressure rather than cpusets; serious or critical counts as throttled.
  static func isThrottled() -> Bool {
    let t = ProcessInfo.processInfo.thermalState
    return t == .serious || t == .critical
  }

  /**
   * Fast cores this process may run on. Apple silicon reports its performance cluster as
   * perflevel0; one ggml thread per performance core, never more (PrivateLM's finding: the
   * threads wait for each other every step). Clamped to 2…6 like Native.kt.
   */
  static func fastCoreCount() -> Int {
    var n: Int32 = 0
    var size = MemoryLayout<Int32>.size
    if sysctlbyname("hw.perflevel0.logicalcpu", &n, &size, nil, 0) != 0 || n <= 0 {
      n = Int32(ProcessInfo.processInfo.activeProcessorCount / 2)
    }
    return min(max(Int(n), 2), 6)
  }

  // MARK: lifecycle

  func start(port: Int, secret: String, name: String) throws {
    lock.lock()
    if running { lock.unlock(); return }
    running = true
    status = Status(state: "starting")
    lock.unlock()
    filesDir = Worker.filesDir()
    modelsDir = Worker.modelsDir()
    let threads = Worker.fastCoreCount()
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
    spawn("kula-worker") { [self] in
      do {
        let ram = Worker.availableRamMb()
        let bw = KulaLlamaBridge.memBandwidth(threads)
        update { $0.ramMb = ram; $0.bandwidth = bw }
        _ = KulaLlamaBridge.initBackends()
        if !serveStarted { rpcPort = Int(TCPSocket.freePort()) }
        let api = ApiServer(modelsDir: modelsDir, threads: threads)
        try api.start()
        self.api = api
        // beyin/check v0: every gate event goes to the signed ledger; replays and bad clocks are refused
        let key = try SoftwareKey.loadOrCreate(Worker.deviceKeyFile())
        let auditor = Auditor(ledger: Ledger(file: Worker.ledgerFile(), key: key), key: key)
        self.auditor = auditor
        let gate = Gate.Server(port: port, secret: secret, targets: { [weak self] ch in
          guard let self = self else { return nil }
          return ch == "rpc" ? self.rpcPort : self.api?.port
        }, auditor: auditor) { [weak self] ev in
          self?.update { if ev.kind == "connect" { $0.connects += 1 } else if ev.kind == "reject" { $0.rejects += 1 } }
        }
        try gate.start()
        self.gate = gate
        Worker.log.info("worker: \(threads) threads, \(ram) MB free, \(bw, format: .fixed(precision: 1)) GB/s, gate \(port)")
        advertise(port: port, name: name)
        update { $0.state = "running" }
        statusLoop()
        if !serveStarted {
          serveStarted = true
          let cache = filesDir.appendingPathComponent("rpc_cache")
          try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
          // blocks for the life of the process
          let error = KulaLlamaBridge.serve("127.0.0.1:\(rpcPort)", cacheDir: cache.path, threads: threads)
          Worker.log.error("rpc server exited: \(error)")
          serveStarted = false
          update { $0.state = "error"; $0.error = error }
          stop()
        }
      } catch {
        Worker.log.error("worker failed: \(error.localizedDescription)")
        update { $0.state = "error"; $0.error = error.localizedDescription }
        stop()
      }
    }
  }

  func stop() {
    lock.lock()
    let wasRunning = running
    running = false
    if status.state != "error" { status.state = "stopped"; status.peer = nil }
    lock.unlock()
    if !wasRunning { return }
    gate?.stop(); gate = nil
    api?.stop(); api = nil
    DispatchQueue.main.async {
      self.service?.stop()
      self.service = nil
      UIApplication.shared.isIdleTimerDisabled = false
    }
  }

  private func statusLoop() {
    spawn("kula-worker-status") { [self] in
      var lastAudit: Int64 = 0
      var lastWarn = ""
      while isRunning {
        let peer = gate?.currentPeer ?? KulaLlamaBridge.workerPeer()
        let held = Worker.residentMb()
        let throttled = Worker.isThrottled()
        update { $0.peer = peer; $0.heldMb = held; $0.throttled = throttled }
        // health every minute or when its warnings change; the claim (advertised vs held) while a master is connected
        if let a = auditor {
          let pct = Worker.batteryPct()
          let warn = Checks.health(throttled: throttled, batteryC: 0, batteryPct: pct).warn.joined(separator: ",")
          let now = nowMs()
          if now - lastAudit >= 60_000 || warn != lastWarn {
            try? a.onHealth(throttled: throttled, batteryC: 0, batteryPct: pct)
            // the claim only once a master has put a model here: before that the footprint is
            // this process alone and the advertised RAM would look like a 4x lie every minute
            let s = snapshot()
            if let p = peer, held >= Worker.claimMinHeldMb { try? a.onClaim(peer: p, ramClaimedMb: s.ramMb, heldMb: held, bwClaimed: s.bandwidth, tps: 0, modelGb: 0) }
            lastAudit = now; lastWarn = warn
          }
        }
        Thread.sleep(forTimeInterval: 2)
      }
    }
  }

  /// iOS has no battery temperature; the level comes from UIDevice when monitoring is on.
  static func batteryPct() -> Int {
    var pct = -1
    DispatchQueue.main.sync {
      UIDevice.current.isBatteryMonitoringEnabled = true
      let level = UIDevice.current.batteryLevel
      pct = level < 0 ? -1 : Int(level * 100)
    }
    return pct
  }

  private func advertise(port: Int, name: String) {
    let s = snapshot()
    let txt: [String: Data] = [
      "id": Data(Worker.workerId().utf8),
      "ram": Data(String(s.ramMb).utf8),
      "bw": Data(String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), s.bandwidth).utf8),
      "name": Data(String(name.prefix(40)).utf8),
      "kind": Data("phone".utf8),
      "v": Data("rpc7".utf8),
    ]
    DispatchQueue.main.async {
      let service = NetService(domain: "local.", type: Worker.serviceType, name: "kula \(name)", port: Int32(port))
      service.delegate = self
      service.setTXTRecord(NetService.data(fromTXTRecord: txt))
      service.schedule(in: .main, forMode: .common)
      service.publish()
      self.service = service
    }
  }

  func netServiceDidPublish(_ sender: NetService) { Worker.log.info("advertised as \(sender.name)") }
  func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
    Worker.log.error("bonjour registration failed (\(errorDict.description)); pair by qr")
  }
}
