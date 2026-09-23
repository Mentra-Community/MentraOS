import Foundation

/// Where preview frames come from. `synthetic` is a diagnostics-only test pattern.
public enum PreviewSourceKind: String, Sendable {
  case call
  case synthetic
}

/// How far down the pipeline a frame travels. Everything except `off` and `render` is diagnostics.
public enum PreviewMode: String, Sendable {
  case off
  /// Produce the source frame and stop. Separates making a picture from moving it.
  case generateOnly = "generate_only"
  /// Pack to the wire format and drop it. Isolates the copy and scale.
  case packOnly = "pack_only"
  /// Send it; the page validates and acknowledges without drawing.
  case receiveDiscard = "receive_discard"
  /// Send it; the page draws and then acknowledges.
  case render

  public var producesFrames: Bool { self != .off }
  public var packs: Bool { self == .packOnly || self == .receiveDiscard || self == .render }
  public var sends: Bool { self == .receiveDiscard || self == .render }
}

/// A configure or fault call refused with a contract error code.
public struct PreviewRejection: Error, Equatable {
  public let code: String
  public let message: String
}

/// One `configure` call, already parsed.
public struct PreviewConfig: Equatable, Sendable {
  public var source: PreviewSourceKind
  public var mode: PreviewMode
  public var targetWidth: Int
  public var targetHeight: Int
  public var maxFps: Int
  public var noiseAmplitude: Int
  public var consumerDelayMs: Int

  public init(
    source: PreviewSourceKind = .call, mode: PreviewMode = .off,
    targetWidth: Int = PreviewLimits.release.maxBox.width, targetHeight: Int = PreviewLimits.release.maxBox.height,
    maxFps: Int = PreviewLimits.release.maxFps, noiseAmplitude: Int = 0, consumerDelayMs: Int = 0
  ) {
    self.source = source
    self.mode = mode
    self.targetWidth = targetWidth
    self.targetHeight = targetHeight
    self.maxFps = maxFps
    self.noiseAmplitude = noiseAmplitude
    self.consumerDelayMs = consumerDelayMs
  }

  /// Parse the JS options. Unknown values are rejected rather than silently defaulted.
  public static func parse(_ options: [String: Any]) throws -> PreviewConfig {
    let sourceRaw = options["source"] as? String ?? "call"
    guard let source = PreviewSourceKind(rawValue: sourceRaw) else {
      throw PreviewRejection(code: "invalid_argument", message: "unknown source \(sourceRaw)")
    }
    let modeRaw = options["mode"] as? String ?? "off"
    guard let mode = PreviewMode(rawValue: modeRaw) else {
      throw PreviewRejection(code: "invalid_argument", message: "unknown mode \(modeRaw)")
    }
    let diagnostics = options["diagnostics"] as? [String: Any] ?? [:]
    return PreviewConfig(
      source: source,
      mode: mode,
      targetWidth: int(options["targetWidth"]) ?? 0,
      targetHeight: int(options["targetHeight"]) ?? 0,
      maxFps: int(options["maxFps"]) ?? PreviewLimits.release.maxFps,
      noiseAmplitude: int(diagnostics["noiseAmplitude"]) ?? 0,
      consumerDelayMs: int(diagnostics["consumerDelayMs"]) ?? 0
    )
  }

  private static func int(_ value: Any?) -> Int? {
    switch value {
    case let number as NSNumber: return number.intValue
    case let int as Int: return int
    case let double as Double: return Int(double)
    default: return nil
    }
  }
}

/// Ceilings native enforces even if the host asks for more. The host already quantizes to tiers;
/// these only stop a host bug from becoming a 1080p60 copy loop in a release build.
public struct PreviewLimits: Equatable, Sendable {
  public let maxBox: PreviewSize
  public let maxFps: Int
  public var maxPixels: Int { maxBox.width * maxBox.height }

  /// The shipping ceiling: 640x360 at 15 fps until measurements justify more.
  public static let release = PreviewLimits(maxBox: PreviewSize(width: 640, height: 360), maxFps: 15)
  /// Stress runs deliberately go past the product ceiling.
  public static let diagnostics = PreviewLimits(maxBox: PreviewSize(width: 1920, height: 1080), maxFps: 30)

  public static func of(diagnosticsEnabled: Bool) -> PreviewLimits {
    diagnosticsEnabled ? diagnostics : release
  }
}

/// What release builds refuse unless the hidden developer setting enables diagnostics.
public enum PreviewDiagnosticsPolicy {
  public static let diagnosticsDisabled = "diagnostics_disabled"

  public static func needsDiagnostics(_ config: PreviewConfig) -> Bool {
    config.source == .synthetic
      || (config.mode != .off && config.mode != .render)
      || config.noiseAmplitude != 0
      || config.consumerDelayMs != 0
  }

  /// Error code to reject with, or nil when `config` is allowed.
  public static func check(_ config: PreviewConfig, diagnosticsEnabled: Bool) -> String? {
    !diagnosticsEnabled && needsDiagnostics(config) ? diagnosticsDisabled : nil
  }
}

/// Fault kinds for the diagnostics-only injection hooks.
public enum PreviewFaultKind: String, Sendable {
  /// Hold every acknowledgement for `ms` before applying it: a slow consumer.
  case ackDelay = "ack_delay"
  /// Ignore acknowledgements until cleared: the ack-timeout path.
  case ackDrop = "ack_drop"
  /// Fail the next send as if the transport had gone away.
  case transportClose = "transport_close"
  /// Throw from the next pack on the worker.
  case packThrow = "pack_throw"
  /// Throw from the next tap sink call on the decoder thread.
  case sinkThrow = "sink_throw"
  /// Remove every armed fault.
  case clear
}

/// Thrown by the injection hooks so a test can tell a forced failure from a real one.
public struct InjectedPreviewFault: Error, Equatable {
  public let kind: PreviewFaultKind
}

/// Armed faults. One-shot faults disarm when they fire; the rest last until cleared.
/// Thread-safe: the sink fault is taken on the decoder thread.
public final class PreviewFaults {
  private let lock = NSLock()
  private var ackDelay = 0
  private var dropAcks = false
  private var transportClose = false
  private var packThrow = false
  private var sinkThrow = false

  public init() {}

  public func arm(_ kind: PreviewFaultKind, ms: Int = 0) {
    lock.lock()
    defer { lock.unlock() }
    switch kind {
    case .ackDelay: ackDelay = min(max(ms, 0), 10000)
    case .ackDrop: dropAcks = true
    case .transportClose: transportClose = true
    case .packThrow: packThrow = true
    case .sinkThrow: sinkThrow = true
    case .clear: clearLocked()
    }
  }

  public func clear() {
    lock.lock()
    clearLocked()
    lock.unlock()
  }

  private func clearLocked() {
    ackDelay = 0
    dropAcks = false
    transportClose = false
    packThrow = false
    sinkThrow = false
  }

  public var ackDelayMs: Int { locked { ackDelay } }
  public var dropsAcks: Bool { locked { dropAcks } }
  public var anyArmed: Bool { locked { ackDelay != 0 || dropAcks || transportClose || packThrow || sinkThrow } }

  public func takeTransportClose() -> Bool { take(\.transportClose) }
  public func takePackThrow() -> Bool { take(\.packThrow) }
  public func takeSinkThrow() -> Bool { take(\.sinkThrow) }

  private func take(_ flag: ReferenceWritableKeyPath<PreviewFaults, Bool>) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let armed = self[keyPath: flag]
    self[keyPath: flag] = false
    return armed
  }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
