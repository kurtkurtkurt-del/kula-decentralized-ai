import CryptoKit
import Foundation

/**
 * The device's identity for the audit ledger: a signing key and the id derived from it
 * (DeviceKey.kt). Ed25519 through CryptoKit. The public key is its X.509
 * SubjectPublicKeyInfo bytes, so the id is the same no matter which library made the key.
 *
 * CryptoKit's Ed25519 signatures are randomized, so the bytes differ from the Kotlin and
 * Node signatures over the same line; they verify everywhere all the same. A vectors test
 * on iOS verifies, it does not compare signature bytes.
 */
protocol DeviceKey {
  /// "ed25519"
  var alg: String { get }
  /// X.509 (SubjectPublicKeyInfo) encoded public key
  var publicKey: Data { get }
  func sign(_ bytes: Data) throws -> Data
}

extension DeviceKey {
  /// first 16 bytes of SHA-256(publicKey), lowercase hex
  var id: String { DeviceKeys.idOf(publicKey) }
}

enum DeviceKeys {
  static let ed25519 = "ed25519"
  /// DER prefixes: PKCS#8 for an Ed25519 private key (seed follows), SPKI for the public key.
  static let pkcs8Prefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
  static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

  static func idOf(_ publicKey: Data) -> String {
    Gate.hex(SHA256.hash(data: publicKey).prefix(16))
  }

  /// True when sig is a valid signature by publicKey (SPKI) over bytes; false on any error.
  static func verify(alg: String, publicKey: Data, bytes: Data, sig: Data) -> Bool {
    guard alg == ed25519, publicKey.count == spkiPrefix.count + 32, publicKey.prefix(spkiPrefix.count) == spkiPrefix else { return false }
    guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey.suffix(32)) else { return false }
    return key.isValidSignature(sig, for: bytes)
  }
}

/// A key in memory, persisted as a small text file: the algorithm name, a newline, then
/// base64 of the PKCS#8 private key and base64 of the public key, like SoftwareKey.kt.
final class SoftwareKey: DeviceKey {
  let alg = DeviceKeys.ed25519
  private let key: Curve25519.Signing.PrivateKey

  init(key: Curve25519.Signing.PrivateKey) { self.key = key }

  var publicKey: Data { DeviceKeys.spkiPrefix + key.publicKey.rawRepresentation }

  func sign(_ bytes: Data) throws -> Data { try key.signature(for: bytes) }

  /// PKCS#8 bytes of the private key, for saving.
  func pkcs8() -> Data { DeviceKeys.pkcs8Prefix + key.rawRepresentation }

  static func generate() -> SoftwareKey { SoftwareKey(key: Curve25519.Signing.PrivateKey()) }

  /// Rebuilds a key from its PKCS#8 private part; the public part is checked when given.
  static func from(alg: String, pkcs8: Data, publicKey: Data?) throws -> SoftwareKey {
    guard alg == DeviceKeys.ed25519, pkcs8.count == DeviceKeys.pkcs8Prefix.count + 32 else { throw SocketError.failed("unknown key algorithm \(alg)") }
    let k = SoftwareKey(key: try Curve25519.Signing.PrivateKey(rawRepresentation: pkcs8.suffix(32)))
    if let pub = publicKey, pub != k.publicKey { throw SocketError.failed("key file: public part does not match") }
    return k
  }

  /// Loads the key at file or makes one and saves it there.
  static func loadOrCreate(_ file: URL) throws -> SoftwareKey {
    if let text = try? String(contentsOf: file, encoding: .utf8) {
      let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      if lines.count >= 3, let priv = Data(base64Encoded: lines[1]), let pub = Data(base64Encoded: lines[2]) {
        return try from(alg: lines[0], pkcs8: priv, publicKey: pub)
      }
    }
    let k = generate()
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "\(k.alg)\n\(k.pkcs8().base64EncodedString())\n\(k.publicKey.base64EncodedString())\n".write(to: file, atomically: true, encoding: .utf8)
    var u = file
    var v = URLResourceValues()
    v.isExcludedFromBackup = true
    try? u.setResourceValues(v)
    return k
  }
}
