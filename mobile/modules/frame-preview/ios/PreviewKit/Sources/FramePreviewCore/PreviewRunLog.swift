import Foundation

/// Append-only NDJSON record of one preview run.
///
/// The 1 Hz counters already existed, but they only ever lived on a screen for one second each,
/// which makes "is render slower than pack_only" an argument rather than a diff. One line per
/// second, tagged with a run id and the device's identity, turns the experiment into something
/// two people can compare after the fact — and into something that survives the app being killed
/// halfway through a soak.
///
/// Writes are serialized onto a utility queue and the handle is synchronized on `end`, so a
/// crashed run still leaves every line that was flushed before it. Nothing here may throw into
/// the caller: a logging failure must not stop a measurement.
public final class PreviewRunLog {
  private let queue = DispatchQueue(label: "com.mentra.framepreview.runlog", qos: .utility)
  private var handle: FileHandle?

  /// Records written before the file exists.
  ///
  /// The interesting lifecycle events — the document being prepared, the consumer
  /// authenticating — all happen while the page is connecting, which is before `start()` opens
  /// the file. Dropping them would leave every run's log beginning after the only part that
  /// explains how it got there. Bounded, because a preview that never starts must not grow.
  private var pending: [[String: Any]] = []
  private static let pendingLimit = 64

  public private(set) var path: String?
  public private(set) var runId: String = ""

  public init() {}

  /// Open a file for `runId` and write the `meta` line that every later line is interpreted
  /// against: device, OS, mode, target fps, and anything else the caller considers fixed.
  public func begin(runId: String, meta: [String: Any], directory: URL) {
    queue.async {
      self.closeLocked()
      self.runId = runId
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(runId).ndjson")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try FileHandle(forWritingTo: url)
        self.path = url.path
        NSLog("FRAME-PREVIEW ios run log \(url.path)")
        var record = meta
        record["t"] = "meta"
        record["runId"] = runId
        self.appendLocked(record)
        // Replay what happened while the page was connecting, tagged with this run so the file
        // is self-contained.
        let replay = self.pending
        self.pending = []
        for var earlier in replay {
          earlier["runId"] = runId
          earlier["beforeStart"] = true
          self.appendLocked(earlier)
        }
      } catch {
        // A run without a log file is still a valid run. Say so once and carry on.
        NSLog("FRAME-PREVIEW ios run log unavailable: \(error)")
        self.handle = nil
        self.path = nil
      }
    }
  }

  public func write(_ record: [String: Any]) {
    queue.async {
      guard self.handle != nil else {
        if self.pending.count < Self.pendingLimit { self.pending.append(record) }
        return
      }
      self.appendLocked(record)
    }
  }

  public func end(reason: String, summary: [String: Any] = [:]) {
    queue.async {
      guard self.handle != nil else { return }
      var record = summary
      record["t"] = "end"
      record["runId"] = self.runId
      record["reason"] = reason
      self.appendLocked(record)
      self.closeLocked()
      self.pending = []
    }
  }

  private func appendLocked(_ record: [String: Any]) {
    guard let handle else { return }
    guard let line = Self.encode(record) else { return }
    handle.write(line)
  }

  private func closeLocked() {
    try? handle?.synchronize()
    try? handle?.close()
    handle = nil
  }

  /// One compact JSON object plus a newline, or nil when the record cannot be represented.
  ///
  /// Non-finite doubles are the realistic hazard: a rate computed over a zero-length window is
  /// `inf`, and `JSONSerialization` refuses the whole object for one bad key. Replacing them
  /// keeps the other twenty counters in the file.
  static func encode(_ record: [String: Any]) -> Data? {
    let sanitized = sanitize(record)
    guard let data = try? JSONSerialization.data(withJSONObject: sanitized, options: []) else {
      return nil
    }
    return data + Data("\n".utf8)
  }

  private static func sanitize(_ value: Any) -> Any {
    switch value {
    case let dictionary as [String: Any]:
      return dictionary.mapValues { sanitize($0) }
    case let array as [Any]:
      return array.map { sanitize($0) }
    case let double as Double:
      return double.isFinite ? double : 0
    case let float as Float:
      return float.isFinite ? Double(float) : 0
    default:
      return value
    }
  }
}
