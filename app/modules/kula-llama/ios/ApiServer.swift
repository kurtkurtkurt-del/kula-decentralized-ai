import Foundation
import os

/**
 * "Apart" mode on a worker (ApiServer.kt): the worker runs the whole model itself and
 * answers the master over a small HTTP API behind the gate (127.0.0.1 only; the gate pipes
 * the `api` channel). The same four routes and the same SSE shapes as the Kotlin and node
 * servers, byte for byte in the data lines:
 *
 *   GET  /status                       {loaded, model, sha256, tokensUsed, ctx, busy, threads}
 *   POST /load  {url, sha256, size, name, ctx?}   downloads when missing, then loads; streams
 *                                      progress lines "data: {...}\n\n" and ends with {done:true}
 *   POST /chat  {messages:[{role,content}], maxTokens?, temperature?}   SSE: {t:"piece"} … {done, tokens, ms}
 *   POST /stop
 *
 * Replies are close-delimited (Connection: close, no chunked framing), as the app reads them.
 */
final class ApiServer {
  private static let log = Logger(subsystem: "app.kula.llama", category: "api")
  private let modelsDir: URL
  private let threads: Int
  private var listener: TCPSocket?
  private var running = false
  private var busy = false
  private let lock = NSLock()
  private var loadedPath: String?
  private var loadedSha: String?

  var port: Int { Int(listener?.localPort ?? 0) }

  init(modelsDir: URL, threads: Int) {
    self.modelsDir = modelsDir
    self.threads = threads
  }

  @discardableResult
  func start() throws -> Int {
    let l = try TCPSocket.listen(host: "127.0.0.1", port: 0, backlog: 4)
    listener = l
    running = true
    spawn("api-accept") { [weak self] in
      while let self = self, self.running {
        guard let accepted = try? l.accept() else { break }
        let s = accepted.0
        spawn("api-conn") {
          self.handle(s)
          s.close()
        }
      }
    }
    return port
  }

  func stop() {
    running = false
    listener?.close()
    listener = nil
  }

  private func take() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if busy { return false }
    busy = true
    return true
  }

  private func release() { lock.lock(); busy = false; lock.unlock() }

  private func handle(_ s: TCPSocket) {
    s.setTimeout(ms: 30_000)
    let request = s.readLine()
    let parts = request.split(separator: " ").map(String.init)
    if parts.count < 2 { return }
    let method = parts[0]
    let path = parts[1]
    var length = 0
    while true {
      let h = s.readLine()
      if h.isEmpty { break }
      if h.lowercased().hasPrefix("content-length:") { length = Int(h.dropFirst(15).trimmingCharacters(in: .whitespaces)) ?? 0 }
    }
    var body = [UInt8]()
    if length > 0 {
      var buf = [UInt8](repeating: 0, count: min(length, 1 << 20))
      while body.count < length {
        let n = s.read(into: &buf)
        if n <= 0 { break }
        body.append(contentsOf: buf[0..<min(n, length - body.count)])
      }
    }
    let json = (try? JSONSerialization.jsonObject(with: Data(body))) as? [String: Any] ?? [:]
    s.setTimeout(ms: 0)
    switch (method, path) {
    case ("GET", "/status"): reply(s, 200, status())
    case ("POST", "/stop"): KulaLlamaBridge.stop(); reply(s, 200, ["ok": true])
    case ("POST", "/load"): load(s, json)
    case ("POST", "/chat"): chat(s, json)
    default: reply(s, 404, ["error": "no such route"])
    }
  }

  private func status() -> [String: Any?] {
    lock.lock(); let b = busy; lock.unlock()
    return [
      "loaded": KulaLlamaBridge.isLoaded(),
      "model": loadedPath.map { URL(fileURLWithPath: $0).lastPathComponent },
      "sha256": loadedSha,
      "tokensUsed": KulaLlamaBridge.tokensUsed(),
      "ctx": KulaLlamaBridge.contextSize(),
      "busy": b,
      "threads": threads,
    ]
  }

  private func load(_ s: TCPSocket, _ req: [String: Any]) {
    if !take() { return reply(s, 409, ["error": "busy"]) }
    defer { release() }
    sseHead(s)
    let url = req["url"] as? String ?? ""
    let sha = (req["sha256"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let size = (req["size"] as? NSNumber)?.int64Value ?? 0
    let name = (req["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? String(url.split(separator: "/").last ?? "model.gguf")
    let ctx = (req["ctx"] as? NSNumber)?.intValue ?? 2048
    let dest = modelsDir.appendingPathComponent(name)
    let fm = FileManager.default
    do {
      if !fm.fileExists(atPath: dest.path) {
        if url.isEmpty { return sse(s, ["error": "model missing and no url"]) }
        var failed: String?
        let done = DispatchSemaphore(value: 0)
        let dl = ModelDownloader { _, got, total, state, error in
          var o: [String: Any?] = ["state": state, "got": got, "total": total]
          if let e = error { o["error"] = e }
          self.sse(s, o)
          if state == "done" { done.signal() }
          if state == "error" || state == "cancelled" { failed = error ?? state; done.signal() }
        }
        dl.start(id: "load", url: url, dest: dest, sha256: sha, expectedSize: size)
        done.wait()
        if let f = failed { return sse(s, ["error": f]) }
      } else if let want = sha, loadedSha != want {
        sse(s, ["state": "checking"])
        let actual = try ModelDownloader.sha256(of: dest)
        if actual != want {
          try? fm.removeItem(at: dest)
          return sse(s, ["error": "checksum mismatch; file deleted, load again"])
        }
      }
      if loadedPath != dest.path {
        if KulaLlamaBridge.isLoaded() { KulaLlamaBridge.freeModel() }
        sse(s, ["state": "loading"])
        let info = try KulaLlamaBridge.loadModel(dest.path, threads: threads, ctx: ctx, endpoints: [], weights: [], localWeight: 1)
        loadedPath = dest.path
        loadedSha = try sha ?? ModelDownloader.sha256(of: dest)
        sse(s, ["done": true, "layers": info.layers, "ctx": info.ctx, "sha256": loadedSha])
      } else {
        sse(s, ["done": true, "ctx": KulaLlamaBridge.contextSize(), "sha256": loadedSha])
      }
    } catch {
      sse(s, ["error": error.localizedDescription])
    }
  }

  private func chat(_ s: TCPSocket, _ req: [String: Any]) {
    if !KulaLlamaBridge.isLoaded() { return reply(s, 409, ["error": "no model loaded"]) }
    if !take() { return reply(s, 409, ["error": "busy"]) }
    defer { release() }
    sseHead(s)
    do {
      let msgs = req["messages"] as? [[String: Any]] ?? []
      let roles = msgs.map { $0["role"] as? String ?? "user" }
      let contents = msgs.map { $0["content"] as? String ?? "" }
      if req["reset"] as? Bool == true { KulaLlamaBridge.clearContext() }
      let prompt = try KulaLlamaBridge.applyTemplate(roles, contents: contents)
      let start = nowMs()
      var first: Int64 = 0
      let n = try KulaLlamaBridge.generate(
        prompt, maxTokens: (req["maxTokens"] as? NSNumber)?.intValue ?? 512, temperature: (req["temperature"] as? NSNumber)?.floatValue ?? 0.7,
        topP: (req["topP"] as? NSNumber)?.floatValue ?? 0.95, topK: (req["topK"] as? NSNumber)?.intValue ?? 40,
        minP: (req["minP"] as? NSNumber)?.floatValue ?? 0.05, repeatPenalty: (req["repeatPenalty"] as? NSNumber)?.floatValue ?? 1.1, seed: -1
      ) { piece in
        if first == 0 { first = nowMs() }
        self.sse(s, ["t": piece])
      }
      let ms = nowMs() - start
      sse(s, ["done": true, "tokens": n, "ms": ms, "firstMs": first > 0 ? first - start : ms, "tps": n > 0 && ms > 0 ? Double(n) * 1000.0 / Double(ms) : 0.0])
    } catch {
      sse(s, ["error": error.localizedDescription])
    }
  }

  private func sseHead(_ s: TCPSocket) {
    try? s.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
  }

  private func sse(_ s: TCPSocket, _ o: [String: Any?]) {
    try? s.write("data: \(ApiServer.json(o))\n\n")
  }

  private func reply(_ s: TCPSocket, _ code: Int, _ o: [String: Any?]) {
    let b = Array(ApiServer.json(o).utf8)
    try? s.write("HTTP/1.1 \(code) \(code == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(b.count)\r\nConnection: close\r\n\r\n")
    try? s.write(b)
  }

  /// JSON without escaped slashes and with nulls kept, as org.json writes it.
  static func json(_ o: [String: Any?]) -> String {
    let clean = o.mapValues { $0 ?? NSNull() }
    guard let data = try? JSONSerialization.data(withJSONObject: clean, options: [.withoutEscapingSlashes]) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }
}
