import Foundation

public enum SourceKind: String, Sendable {
    case whep
    case direct
    case softap
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
    public var bindAddress: String?

    public init(url: String, kind: SourceKind = .whep, bindAddress: String? = nil) {
        self.url = url
        self.kind = kind
        self.bindAddress = bindAddress
    }
}

public protocol GlassesMediaSource: AnyObject {
    var state: SourceState { get }
    var ingestUrl: String? { get }
    func forceRestart()
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

    public var state: SourceState {
        source?.state ?? .idle
    }

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

public extension GlassesMediaSource {
    var ingestUrl: String? {
        nil
    }

    func forceRestart() {}
}

public extension SourceConfig {
    /// Validate the host bridge before creating a peer or claiming resources. Preserve the
    /// legacy WHEP field while requiring an explicit bound address for local reception.
    static func fromBridge(_ source: [String: Any]?, legacyWhepUrl: String?) throws -> SourceConfig {
        func nonempty(_ value: Any?) -> String? {
            guard let value = value as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        guard let source else {
            guard let url = nonempty(legacyWhepUrl) else { throw LocalMediaError("whepUrl is required") }
            return SourceConfig(url: url)
        }
        switch nonempty(source["type"])?.lowercased() {
        case "whep":
            guard let url = nonempty(source["url"]) ?? nonempty(legacyWhepUrl) else { throw LocalMediaError("videoSource.url is required") }
            return SourceConfig(url: url)
        case "softap":
            guard let address = nonempty(source["bindAddress"]), LocalMediaPolicy.isPrivate(address) else {
                throw LocalMediaError("videoSource.bindAddress must be the phone's hotspot IPv4 address")
            }
            return SourceConfig(url: "", kind: .softap, bindAddress: address)
        default: throw LocalMediaError("Unsupported videoSource.type")
        }
    }
}
