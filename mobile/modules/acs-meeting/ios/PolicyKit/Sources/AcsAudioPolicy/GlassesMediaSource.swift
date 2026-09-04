import Foundation

public enum SourceKind: String, Sendable {
  case whep
  case direct
}

public enum SourceState: String, Sendable {
  case idle
  case connecting
  case live
  case failed
}

public struct SourceConfig: Equatable, Sendable {
  public var url: String
  public var kind: SourceKind

  public init(url: String, kind: SourceKind = .whep) {
    self.url = url
    self.kind = kind
  }
}

public protocol GlassesMediaSource: AnyObject {
  var state: SourceState { get }
  func start(config: SourceConfig)
  func restart(config: SourceConfig)
  func stop()
  func setPcmDeliveryEnabled(_ enabled: Bool)
}

public final class GlassesMediaController {
  private let factory: () -> GlassesMediaSource
  private var source: GlassesMediaSource?

  public init(factory: @escaping () -> GlassesMediaSource) {
    self.factory = factory
  }

  public var state: SourceState { source?.state ?? .idle }

  public func attach(config: SourceConfig) {
    source?.stop()
    let next = factory()
    source = next
    next.start(config: config)
  }

  public func restart(config: SourceConfig) {
    source?.restart(config: config)
  }

  public func stop() {
    source?.stop()
    source = nil
  }

  public func setPcmDeliveryEnabled(_ enabled: Bool) {
    source?.setPcmDeliveryEnabled(enabled)
  }
}

public enum CapturePolicy {
  public static func captureGlassesMic(_ source: AudioSourceKind) -> Bool {
    source == .glasses
  }
}
