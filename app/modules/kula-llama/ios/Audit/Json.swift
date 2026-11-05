import Foundation

/// A JSON object whose fields keep their order (Json.kt). The ledger line has to be
/// byte-identical between the phone, the node and this code, and JSONSerialization
/// reorders keys, so the ledger writes its own.
struct OrderedJSON {
  var fields: [(String, Any?)] = []

  init(_ fields: [(String, Any?)] = []) { self.fields = fields }

  subscript(key: String) -> Any? {
    get { fields.first { $0.0 == key }?.1 ?? nil }
    set {
      if let i = fields.firstIndex(where: { $0.0 == key }) { fields[i] = (key, newValue) } else { fields.append((key, newValue)) }
    }
  }

  func contains(_ key: String) -> Bool { fields.contains { $0.0 == key } }

  func render() -> String {
    var out = "{"
    var first = true
    for (k, v) in fields {
      if !first { out += "," }
      first = false
      OrderedJSON.str(&out, k)
      out += ":"
      OrderedJSON.value(&out, v)
    }
    return out + "}"
  }

  static func value(_ out: inout String, _ v: Any?) {
    switch v {
    case nil: out += "null"
    case let s as String: str(&out, s)
    case let b as Bool: out += b ? "true" : "false"
    case let i as Int: out += String(i)
    case let i as Int64: out += String(i)
    case let i as Int32: out += String(i)
    case let d as Double: number(&out, d)
    case let f as Float: number(&out, Double(f))
    case let o as OrderedJSON: out += o.render()
    case let dict as [String: Any?]:
      // an unordered dictionary: sorted keys so two writers agree
      out += OrderedJSON(dict.keys.sorted().map { ($0, dict[$0] ?? nil) }).render()
    case let list as [String]:
      value(&out, list.map { $0 as Any? })
    case let list as [OrderedJSON]:
      value(&out, list.map { $0 as Any? })
    case let list as [Any?]:
      out += "["
      var first = true
      for e in list { if !first { out += "," }; first = false; value(&out, e) }
      out += "]"
    case let list as [Any]:
      value(&out, list.map { $0 as Any? })
    default: str(&out, String(describing: v!))
    }
  }

  // whole doubles print as integers (42.0 -> 42) so JavaScript's JSON.stringify agrees
  static func number(_ out: inout String, _ d: Double) {
    if d.isNaN || d.isInfinite { out += "null" } else if d == d.rounded() && abs(d) < 1e15 { out += String(Int64(d)) } else { out += String(d) }
  }

  static func str(_ out: inout String, _ s: String) {
    out += "\""
    for c in s.unicodeScalars {
      switch c {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
      }
    }
    out += "\""
  }
}
