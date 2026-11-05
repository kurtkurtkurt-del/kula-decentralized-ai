import Foundation

/// Plain blocking BSD sockets, the way Gate.kt uses java.net: every connection has its own
/// thread, nothing is asynchronous. Network.framework was not used on purpose: the gate
/// hands the raw byte stream on to llama.cpp's RPC client, which is itself a BSD socket.
enum SocketError: LocalizedError {
  case failed(String)
  var errorDescription: String? {
    if case .failed(let why) = self { return why }
    return nil
  }
}

final class TCPSocket {
  private(set) var fd: Int32
  private let lock = NSLock()

  init(fd: Int32) {
    self.fd = fd
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }

  deinit { close() }

  // MARK: listen / accept

  /// Listens on host:port (port 0 picks a free one). backlog as in the Kotlin code.
  static func listen(host: String, port: UInt16, backlog: Int32 = 8) throws -> TCPSocket {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { throw SocketError.failed("socket: \(errnoText())") }
    let s = TCPSocket(fd: fd)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    if inet_pton(AF_INET, host, &addr.sin_addr) != 1 { throw SocketError.failed("bad address \(host)") }
    let bound = withUnsafePointer(to: &addr) { p in
      p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if bound != 0 { throw SocketError.failed("bind \(host):\(port): \(errnoText())") }
    if Darwin.listen(fd, backlog) != 0 { throw SocketError.failed("listen: \(errnoText())") }
    return s
  }

  var localPort: UInt16 {
    var addr = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let ok = withUnsafeMutablePointer(to: &addr) { p in
      p.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    return ok == 0 ? UInt16(bigEndian: addr.sin_port) : 0
  }

  /// Blocks until a client arrives; returns it and its IPv4 text. Throws when the listener is closed.
  func accept() throws -> (TCPSocket, String) {
    var addr = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let client = withUnsafeMutablePointer(to: &addr) { p in
      p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.accept(fd, $0, &len) }
    }
    if client < 0 { throw SocketError.failed("accept: \(errnoText())") }
    return (TCPSocket(fd: client), TCPSocket.text(addr.sin_addr))
  }

  // MARK: connect

  /// TCP connect with a timeout (non-blocking connect + poll), then back to blocking I/O.
  static func connect(host: String, port: Int, timeoutMs: Int) throws -> TCPSocket {
    var hints = addrinfo()
    hints.ai_family = AF_INET
    hints.ai_socktype = SOCK_STREAM
    var info: UnsafeMutablePointer<addrinfo>?
    let rc = getaddrinfo(host, String(port), &hints, &info)
    guard rc == 0, let first = info else { throw SocketError.failed("unreachable: \(host) does not resolve") }
    defer { freeaddrinfo(info) }
    let fd = socket(first.pointee.ai_family, first.pointee.ai_socktype, first.pointee.ai_protocol)
    if fd < 0 { throw SocketError.failed("socket: \(errnoText())") }
    let s = TCPSocket(fd: fd)
    let flags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    let r = Darwin.connect(fd, first.pointee.ai_addr, first.pointee.ai_addrlen)
    if r != 0 && errno != EINPROGRESS { throw SocketError.failed("unreachable: \(errnoText())") }
    if r != 0 {
      var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      let n = poll(&pfd, 1, Int32(timeoutMs))
      if n <= 0 { throw SocketError.failed("unreachable: connect timed out") }
      var err: Int32 = 0
      var len = socklen_t(MemoryLayout<Int32>.size)
      getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
      if err != 0 { throw SocketError.failed("unreachable: \(String(cString: strerror(err)))") }
    }
    _ = fcntl(fd, F_SETFL, flags)
    return s
  }

  // MARK: options

  /// Read/write timeout; 0 means none (java's soTimeout).
  func setTimeout(ms: Int) {
    var tv = timeval(tv_sec: ms / 1000, tv_usec: Int32((ms % 1000) * 1000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  }

  func setNoDelay() {
    var one: Int32 = 1
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
  }

  // MARK: i/o

  /// One byte, or -1 at the end / on an error.
  func readByte() -> Int {
    var b: UInt8 = 0
    let n = Darwin.recv(fd, &b, 1, 0)
    return n == 1 ? Int(b) : -1
  }

  /// Reads one line byte by byte so nothing after it is swallowed (Gate.kt readLine): up
  /// to '\n' or the end, '\r' dropped, stops after 256 characters.
  func readLine() -> String {
    var bytes = [UInt8]()
    while true {
      let b = readByte()
      if b < 0 || b == 0x0A { break }
      if b != 0x0D { bytes.append(UInt8(b)) }
      if bytes.count > 256 { break }
    }
    return String(decoding: bytes, as: UTF8.self)
  }

  /// Up to buffer.count bytes; 0 at the end, -1 on an error.
  func read(into buffer: inout [UInt8]) -> Int {
    return buffer.withUnsafeMutableBytes { Darwin.recv(fd, $0.baseAddress, $0.count, 0) }
  }

  func write(_ bytes: [UInt8]) throws {
    var sent = 0
    while sent < bytes.count {
      let n = bytes.withUnsafeBytes { Darwin.send(fd, $0.baseAddress! + sent, $0.count - sent, 0) }
      if n <= 0 { throw SocketError.failed("send: \(TCPSocket.errnoText())") }
      sent += n
    }
  }

  func write(_ text: String) throws { try write(Array(text.utf8)) }
  func write(_ data: Data) throws { try write([UInt8](data)) }

  func shutdownOutput() { shutdown(fd, SHUT_WR) }

  func close() {
    lock.lock(); defer { lock.unlock() }
    if fd >= 0 { Darwin.close(fd); fd = -1 }
  }

  // MARK: helpers

  static func errnoText() -> String { String(cString: strerror(errno)) }

  static func text(_ addr: in_addr) -> String {
    var a = addr
    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    inet_ntop(AF_INET, &a, &buf, socklen_t(INET_ADDRSTRLEN))
    return String(cString: buf)
  }

  /// A port nothing listens on right now (ServerSocket(0).localPort in the Kotlin code).
  static func freePort() -> UInt16 {
    guard let s = try? listen(host: "127.0.0.1", port: 0) else { return 0 }
    let p = s.localPort
    s.close()
    return p
  }

  /// Bidirectional copy until either side closes; leftover goes to b first. Returns the
  /// bytes moved both ways. Blocks the calling thread; one more thread carries a -> b.
  static func pipe(_ a: TCPSocket, _ b: TCPSocket, leftover: [UInt8] = []) -> Int64 {
    a.setNoDelay(); b.setNoDelay()
    var up = Int64(leftover.count)
    var down: Int64 = 0
    let done = DispatchSemaphore(value: 0)
    let t = Thread {
      if !leftover.isEmpty { try? b.write(leftover) }
      up += copy(from: a, to: b)
      b.shutdownOutput()
      done.signal()
    }
    t.name = "gate-pipe"
    t.start()
    down = copy(from: b, to: a)
    a.shutdownOutput()
    done.wait()
    a.close(); b.close()
    return up + down
  }

  private static func copy(from i: TCPSocket, to o: TCPSocket) -> Int64 {
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    var count: Int64 = 0
    while true {
      let n = i.read(into: &buf)
      if n <= 0 { break }
      do { try o.write(Array(buf[0..<n])) } catch { break }
      count += Int64(n)
    }
    return count
  }
}

/// A thread with a name, started right away (kotlin.concurrent.thread).
@discardableResult
func spawn(_ name: String, _ body: @escaping () -> Void) -> Thread {
  let t = Thread(block: body)
  t.name = name
  t.stackSize = 1 << 20
  t.start()
  return t
}

/// Milliseconds since the epoch (System.currentTimeMillis).
func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
