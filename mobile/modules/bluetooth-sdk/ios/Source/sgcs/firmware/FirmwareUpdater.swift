import Foundation

@MainActor
enum FirmwareConnectionGeneration {
    private static var value = 0
    static func next() -> Int {
        value += 1; return value
    }
}

/// Device-bound primitive shared by native clients and the React Native bridge.
/// A provider chooses the prepared request; the transport does not resolve release policy.
public struct FirmwareStartRequest: Codable {
    public let deviceId: String
    public let connectionGeneration: Int
    public let offerId: String
    /// Device-defined preparation kind, currently "file" or "manifest".
    public let kind: String
    public let artifact: FirmwareArtifact?
    public let manifestUrl: String?
    public let metadata: [String: String]

    public init(deviceId: String, connectionGeneration: Int, offerId: String, kind: String,
                artifact: FirmwareArtifact? = nil, manifestUrl: String? = nil, metadata: [String: String] = [:])
    {
        self.deviceId = deviceId; self.connectionGeneration = connectionGeneration; self.offerId = offerId
        self.kind = kind; self.artifact = artifact; self.manifestUrl = manifestUrl; self.metadata = metadata
    }
}

/// Provider-verified completion is accepted only for the current native transaction and revision.
public struct FirmwareCompletionEvidence: Codable {
    public let deviceId: String
    public let updaterId: String
    public let sessionId: String
    public let connectionGeneration: Int
    public let revision: Int
    public let kind: String

    public init(deviceId: String, updaterId: String, sessionId: String, connectionGeneration: Int, revision: Int, kind: String) {
        self.deviceId = deviceId; self.updaterId = updaterId; self.sessionId = sessionId
        self.connectionGeneration = connectionGeneration; self.revision = revision; self.kind = kind
    }
}

public struct FirmwareArtifact: Codable {
    public let path: String
    public let targetVersion: String
    public let size: Int?
    public let sha256: String?
    public let md5: String?

    public init(path: String, targetVersion: String, size: Int? = nil, sha256: String? = nil, md5: String? = nil) {
        self.path = path; self.targetVersion = targetVersion; self.size = size; self.sha256 = sha256; self.md5 = md5
    }
}

/// Revisions belong to the retained updater instance, including its idle and terminal snapshots.
public struct FirmwareUpdateSnapshot: Codable {
    public var schemaVersion = 1
    public var updaterId = UUID().uuidString
    public var integrationId: String
    public var deviceId: String
    public var connectionGeneration: Int
    public var revision = 0
    public var sessionId: String?
    public var offerId: String?
    public var phase = "idle"
    public var safeToRelease = true
    public var canCancel = false
    public var canReconcile = false
    /// Fraction from 0 to 1, independent of legacy device-specific event units.
    public var progress: Double?
    public var observedFirmware: String?
    public var targetFirmware: String?
    public var inventory: [String: String] = [:]
    public var error: String?

    public init(integrationId: String, deviceId: String, connectionGeneration: Int) {
        self.integrationId = integrationId; self.deviceId = deviceId; self.connectionGeneration = connectionGeneration
    }

    func dictionary() -> [String: Any] {
        // All members are JSON primitives; encoding failure indicates an internal invalid progress value.
        guard let data = try? JSONEncoder().encode(self), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}

public struct FirmwareUpdaterError: Error, LocalizedError {
    public let code: String
    public let message: String
    public var errorDescription: String? {
        message
    }

    public init(_ code: String, _ message: String) {
        self.code = code; self.message = message
    }
}

@MainActor
public protocol FirmwareUpdater: AnyObject {
    var snapshot: FirmwareUpdateSnapshot { get }
    /// Initial replay and later transitions share one serial executor. Unsubscribe never cancels work.
    func observe(_ listener: @escaping (FirmwareUpdateSnapshot) -> Void) -> () -> Void
    func start(_ request: FirmwareStartRequest) throws -> FirmwareUpdateSnapshot
    /// Query/adopt work. A provider must never implement this as a blind fresh start.
    func reconcile() throws -> FirmwareUpdateSnapshot
    func reconcileCompletion(_ evidence: FirmwareCompletionEvidence) throws -> FirmwareUpdateSnapshot
    func cancel() throws -> FirmwareUpdateSnapshot
    func acknowledge() throws -> FirmwareUpdateSnapshot
    /// Device-defined host policy, validated by the integration. Never an implicit Start or recovery command.
    func configure(_ metadata: [String: String]) throws -> FirmwareUpdateSnapshot
}

public extension FirmwareUpdater {
    func reconcileCompletion(_: FirmwareCompletionEvidence) throws -> FirmwareUpdateSnapshot {
        throw FirmwareUpdaterError("unsupported", "This updater requires native completion verification")
    }

    func configure(_: [String: String]) throws -> FirmwareUpdateSnapshot {
        throw FirmwareUpdaterError("unsupported", "This updater does not accept host configuration")
    }
}

@MainActor
final class FirmwareSessionState {
    private(set) var snapshot: FirmwareUpdateSnapshot
    private var listeners: [UUID: (FirmwareUpdateSnapshot) -> Void] = [:]
    private var queue: [FirmwareUpdateSnapshot] = []
    private var delivering = false
    private let publishEvent: (FirmwareUpdateSnapshot) -> Void

    init(_ initial: FirmwareUpdateSnapshot, publish: @escaping (FirmwareUpdateSnapshot) -> Void = {
        Bridge.sendTypedMessage("firmware_update", body: $0.dictionary())
    }) {
        snapshot = initial; publishEvent = publish
    }

    func observe(_ listener: @escaping (FirmwareUpdateSnapshot) -> Void) -> () -> Void {
        let id = UUID()
        var lastRevision = -1
        let ordered: (FirmwareUpdateSnapshot) -> Void = { state in
            guard state.revision > lastRevision else { return }
            lastRevision = state.revision
            listener(state)
        }
        listeners[id] = ordered
        ordered(snapshot)
        return { [weak self] in self?.listeners.removeValue(forKey: id) }
    }

    func update(_ mutate: (inout FirmwareUpdateSnapshot) -> Void) {
        mutate(&snapshot); snapshot.revision += 1
        queue.append(snapshot)
        guard !delivering else { return }
        delivering = true
        while !queue.isEmpty {
            let next = queue.removeFirst()
            publishEvent(next)
            for listener in Array(listeners.values) {
                listener(next)
            }
        }
        delivering = false
    }
}
