import CryptoKit
import Foundation
import os
import UIKit

/**
 * Resumable model download with a checksum at the end, the iOS twin of ModelDownloader.kt.
 * Writes <dest>.part, continues with a Range request after a kill or a lost network, then
 * checks size and SHA-256 and renames. A file that fails the check is deleted.
 *
 * One thread per download; the bytes come through a URLSession data task so the .part
 * file and the Range logic are ours (a background URLSession download task keeps its own
 * temp file and resume data, which cannot be checked or continued by size). The app asks
 * for background time around the transfer, so a download survives a short trip to the
 * background (~30 s on iOS); longer than that it pauses and continues on the next start
 * from the .part size. Progress goes to onProgress at most 4×/s.
 */
final class ModelDownloader: NSObject {
  typealias Progress = (_ id: String, _ got: Int64, _ total: Int64, _ state: String, _ error: String?) -> Void
  private static let log = Logger(subsystem: "app.kula.llama", category: "download")
  private let onProgress: Progress
  private var cancelled = Set<String>()
  private var active = [String: Thread]()
  private var tasks = [String: URLSessionDataTask]()
  private let lock = NSLock()

  init(onProgress: @escaping Progress) {
    self.onProgress = onProgress
  }

  func start(id: String, url: String, dest: URL, sha256: String?, expectedSize: Int64) {
    lock.lock()
    if active[id] != nil { lock.unlock(); return }
    cancelled.remove(id)
    lock.unlock()
    let t = spawn("download-\(id)") { [self] in
      var bg: UIBackgroundTaskIdentifier = .invalid
      DispatchQueue.main.sync { bg = UIApplication.shared.beginBackgroundTask(withName: "kula-download") { } }
      defer {
        lock.lock(); active[id] = nil; tasks[id] = nil; lock.unlock()
        if bg != .invalid { DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(bg) } }
      }
      do {
        try run(id: id, url: url, dest: dest, sha256: sha256?.lowercased(), expectedSize: expectedSize)
      } catch {
        ModelDownloader.log.warning("download \(id): \(error.localizedDescription)")
        let part = dest.appendingPathExtension("part")
        onProgress(id, ModelDownloader.size(of: part), expectedSize, isCancelled(id) ? "cancelled" : "error", error.localizedDescription)
      }
    }
    lock.lock(); active[id] = t; lock.unlock()
  }

  func cancel(id: String) {
    lock.lock()
    cancelled.insert(id)
    let task = tasks[id]
    lock.unlock()
    task?.cancel()
  }

  func isActive(id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return active[id] != nil
  }

  private func isCancelled(_ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return cancelled.contains(id)
  }

  private func run(id: String, url: String, dest: URL, sha256: String?, expectedSize: Int64) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
    let part = dest.appendingPathExtension("part")
    var got = ModelDownloader.size(of: part)
    var total = expectedSize
    var lastReport: Int64 = 0
    onProgress(id, got, total, "running", nil)
    guard let remote = URL(string: url) else { throw SocketError.failed("bad url") }

    var attempt = 0
    while true {
      if isCancelled(id) { onProgress(id, got, total, "cancelled", nil); return }
      var request = URLRequest(url: remote, timeoutInterval: 60)
      request.setValue("kula-decentralized-ai", forHTTPHeaderField: "User-Agent")
      if got > 0 { request.setValue("bytes=\(got)-", forHTTPHeaderField: "Range") }
      let stream = StreamSink()
      let config = URLSessionConfiguration.default
      config.timeoutIntervalForRequest = 60
      config.timeoutIntervalForResource = 24 * 3600
      config.waitsForConnectivity = false
      let session = URLSession(configuration: config, delegate: stream, delegateQueue: nil)
      let task = session.dataTask(with: request)
      lock.lock(); tasks[id] = task; lock.unlock()
      do {
        if !fm.fileExists(atPath: part.path) { fm.createFile(atPath: part.path, contents: nil) }
        let file = try FileHandle(forWritingTo: part)
        defer { try? file.close() }
        try file.seek(toOffset: UInt64(got))
        var restart = false
        stream.onResponse = { response in
          let code = response.statusCode
          if code == 416 { restart = true; return .cancel }
          if code == 200 && got > 0 { restart = true; return .cancel }  // server ignores ranges: start over
          if !(200...299).contains(code) { stream.fail("http \(code)"); return .cancel }
          if code == 206 {
            if let range = response.value(forHTTPHeaderField: "Content-Range"), let slash = range.lastIndex(of: "/"), let t = Int64(range[range.index(after: slash)...]) { total = t }
          } else if response.expectedContentLength > 0 {
            total = response.expectedContentLength
          }
          if total > 0 {
            let free = ModelDownloader.freeBytes(at: dest.deletingLastPathComponent())
            if free < total - got + 64 * 1024 * 1024 { stream.fail("not enough free space"); return .cancel }
          }
          return .allow
        }
        stream.onData = { data in
          if self.isCancelled(id) { return false }
          file.write(data)
          got += Int64(data.count)
          let now = nowMs()
          if now - lastReport > 250 { lastReport = now; self.onProgress(id, got, total, "running", nil) }
          return true
        }
        task.resume()
        let outcome = stream.wait()
        session.invalidateAndCancel()
        if restart {
          try? file.close()
          try? fm.removeItem(at: part)
          fm.createFile(atPath: part.path, contents: nil)
          got = 0
          continue
        }
        if isCancelled(id) { onProgress(id, got, total, "cancelled", nil); return }
        if let why = outcome { throw SocketError.failed(why) }
        break
      } catch {
        session.invalidateAndCancel()
        if isCancelled(id) { onProgress(id, got, total, "cancelled", nil); return }
        attempt += 1
        if attempt > 20 { throw error }
        ModelDownloader.log.warning("download \(id): \(error.localizedDescription); retry \(attempt)")
        onProgress(id, got, total, "retrying", error.localizedDescription)
        Thread.sleep(forTimeInterval: min(2.0 * Double(attempt), 30))
        got = ModelDownloader.size(of: part)
      }
    }

    let have = ModelDownloader.size(of: part)
    if total > 0 && have != total { throw SocketError.failed("size mismatch: \(have) of \(total)") }
    if let want = sha256 {
      onProgress(id, got, total, "checking", nil)
      let actual = try ModelDownloader.sha256(of: part)
      if actual != want {
        try? fm.removeItem(at: part)
        throw SocketError.failed("checksum mismatch (got \(actual.prefix(12))…)")
      }
    }
    if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: dest) }
    do { try fm.moveItem(at: part, to: dest) } catch { throw SocketError.failed("could not move the file into place") }
    ModelDownloader.excludeFromBackup(dest)
    let size = ModelDownloader.size(of: dest)
    onProgress(id, size, size, "done", nil)
  }

  // MARK: helpers

  static func size(of url: URL) -> Int64 {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
  }

  static func freeBytes(at url: URL) -> Int64 {
    let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return v?.volumeAvailableCapacityForImportantUsage ?? 0
  }

  /// Model files are big and re-downloadable: never into an iCloud backup.
  static func excludeFromBackup(_ url: URL) {
    var u = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? u.setResourceValues(values)
  }

  static func sha256(of url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hasher = SHA256()
    while true {
      let chunk = file.readData(ofLength: 1024 * 1024)
      if chunk.isEmpty { break }
      hasher.update(data: chunk)
    }
    return Gate.hex(hasher.finalize())
  }

  /// Bridges the delegate callbacks of one data task to the blocking download thread.
  private final class StreamSink: NSObject, URLSessionDataDelegate {
    var onResponse: ((HTTPURLResponse) -> URLSession.ResponseDisposition)?
    var onData: ((Data) -> Bool)?
    private let done = DispatchSemaphore(value: 0)
    private var failure: String?
    private var finished = false
    private let lock = NSLock()

    func fail(_ why: String) { lock.lock(); failure = why; lock.unlock() }

    /// Blocks until the task ends; nil when it completed, else the reason.
    func wait() -> String? {
      done.wait()
      lock.lock(); defer { lock.unlock() }
      return failure
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
      guard let http = response as? HTTPURLResponse, let onResponse = onResponse else { completionHandler(.cancel); return }
      completionHandler(onResponse(http))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      if onData?(data) == false { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      lock.lock()
      if let e = error as NSError?, failure == nil, !(e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) { failure = e.localizedDescription }
      let already = finished
      finished = true
      lock.unlock()
      if !already { done.signal() }
    }
  }
}
