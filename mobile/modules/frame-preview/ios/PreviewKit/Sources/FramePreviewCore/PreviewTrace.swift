import Foundation

/// Native side of the `PREVIEW_TRACE` lifecycle log.
///
/// Every line is `[PREVIEW_TRACE] previewTraceId=… phase=… t=… key=value…`, the same shape the
/// host and SDK use, so one grep for a trace id reconstructs a preview across layers. Lines go to
/// the sink, which the module sends to NSLog and to JS so they land in bug-report logs.
///
/// Lifecycle only: nothing here is called per frame. Repeatable warnings go through
/// `warnLimited`, which logs the first occurrence and then one count per 10 s window.
public final class PreviewTrace {
  public enum Level: String, Sendable {
    case info
    case warn
  }

  /// Grep marker. Never build this by concatenation — a single grep must be exhaustive.
  public static let marker = "PREVIEW_TRACE"
  private static let redacted = "<redacted>"
  private static let sensitiveKeys = ["token", "secret", "password", "credential", "authorization", "meetingurl"]

  private let sink: (Level, String) -> Void
  private let clockMs: () -> Int64
  private let lock = NSLock()
  private let limiter = PreviewRateLimiter()
  private var ids: (traceId: String, docGen: Int?, tapGeneration: UInt64?) = ("", nil, nil)

  public init(
    sink: @escaping (Level, String) -> Void,
    clockMs: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }
  ) {
    self.sink = sink
    self.clockMs = clockMs
  }

  public var traceId: String {
    get { lock.lock(); defer { lock.unlock() }; return ids.traceId }
    set { lock.lock(); ids.traceId = newValue; lock.unlock() }
  }

  public var docGen: Int? {
    get { lock.lock(); defer { lock.unlock() }; return ids.docGen }
    set { lock.lock(); ids.docGen = newValue; lock.unlock() }
  }

  public var tapGeneration: UInt64? {
    get { lock.lock(); defer { lock.unlock() }; return ids.tapGeneration }
    set { lock.lock(); ids.tapGeneration = newValue; lock.unlock() }
  }

  public func info(_ phase: String, _ fields: KeyValuePairs<String, Any?> = [:]) {
    emit(.info, phase, fields.map { ($0.key, $0.value) })
  }

  public func warn(_ phase: String, _ fields: KeyValuePairs<String, Any?> = [:]) {
    emit(.warn, phase, fields.map { ($0.key, $0.value) })
  }

  /// Warn once, then at most once per window with the number of repeats suppressed.
  public func warnLimited(_ key: String, _ phase: String, _ fields: KeyValuePairs<String, Any?> = [:]) {
    guard let suppressed = limiter.check(key, nowMs: clockMs()) else { return }
    var pairs = fields.map { ($0.key, $0.value) }
    if suppressed > 0 { pairs.append(("suppressed", suppressed)) }
    emit(.warn, phase, pairs)
  }

  /// Emit pending suppressed counts whose window has closed. Called from the 1 Hz tick.
  public func flushLimited() {
    for (key, count) in limiter.flush(nowMs: clockMs()) {
      emit(.warn, "repeated_warning", [("key", key), ("suppressed", count)])
    }
  }

  private func emit(_ level: Level, _ phase: String, _ fields: [(String, Any?)]) {
    lock.lock()
    let current = ids
    lock.unlock()
    var all: [(String, Any?)] = []
    if let docGen = current.docGen { all.append(("docGen", docGen)) }
    if let generation = current.tapGeneration { all.append(("gen", generation)) }
    all.append(contentsOf: fields)
    sink(level, Self.format(traceId: current.traceId, phase: phase, tMs: clockMs(), fields: all))
  }

  public static func format(traceId: String, phase: String, tMs: Int64, fields: [(String, Any?)]) -> String {
    var line = "[\(marker)]"
    if !traceId.isEmpty { line += " previewTraceId=\(traceId)" }
    line += " phase=\(phase) t=\(tMs)"
    for (key, value) in fields {
      guard let value else { continue }
      line += " \(key)=\(render(sanitize(key: key, value: value)))"
    }
    return line
  }

  public static func sanitize(key: String, value: Any) -> Any {
    let lower = key.lowercased()
    if sensitiveKeys.contains(where: { lower.contains($0) }) { return redacted }
    if let text = value as? String { return stripUrlSecrets(text) }
    return value
  }

  /// Drop `?query`, `#fragment` and `user:pass@` from anything URL-shaped.
  public static func stripUrlSecrets(_ text: String) -> String {
    guard let scheme = text.range(of: "://") else { return text }
    var result = text
    if let query = result.firstIndex(of: "?") { result = String(result[..<query]) + "?" + redacted }
    if let fragment = result.firstIndex(of: "#") { result = String(result[..<fragment]) }
    let hostStart = result.index(scheme.lowerBound, offsetBy: 3)
    if let at = result[hostStart...].firstIndex(of: "@") {
      result = String(result[..<hostStart]) + redacted + "@" + String(result[result.index(after: at)...])
    }
    return result
  }

  private static func render(_ value: Any) -> String {
    let text: String
    if let map = value as? [String: Any] {
      text = "{" + map.keys.sorted().map { "\($0):\(map[$0].map { "\($0)" } ?? "")" }.joined(separator: ",") + "}"
    } else {
      text = "\(value)"
    }
    return text.contains(where: { $0.isWhitespace || $0 == "\"" })
      ? "\"" + text.replacingOccurrences(of: "\"", with: "'") + "\""
      : text
  }
}

/// First occurrence passes, repeats inside a 10 s window are counted and reported once.
public final class PreviewRateLimiter {
  private struct Entry {
    var windowStartMs: Int64
    var suppressed: Int
  }

  private let windowMs: Int64
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  public init(windowMs: Int64 = 10000) {
    self.windowMs = windowMs
  }

  /// Suppressed count to report with this occurrence (0 for the first), or nil to stay quiet.
  public func check(_ key: String, nowMs: Int64) -> Int? {
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[key] else {
      entries[key] = Entry(windowStartMs: nowMs, suppressed: 0)
      return 0
    }
    if nowMs - entry.windowStartMs < windowMs {
      entry.suppressed += 1
      entries[key] = entry
      return nil
    }
    let suppressed = entry.suppressed
    entries[key] = Entry(windowStartMs: nowMs, suppressed: 0)
    return suppressed
  }

  /// Counts for windows that closed with repeats nobody has reported yet.
  public func flush(nowMs: Int64) -> [(String, Int)] {
    lock.lock()
    defer { lock.unlock() }
    var due: [(String, Int)] = []
    for (key, entry) in entries where entry.suppressed > 0 && nowMs - entry.windowStartMs >= windowMs {
      due.append((key, entry.suppressed))
      entries[key] = Entry(windowStartMs: nowMs, suppressed: 0)
    }
    return due.sorted { $0.0 < $1.0 }
  }
}
