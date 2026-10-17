import Foundation
import Darwin

/// All mutation is serialized on Main by the native fixture/SDK boundary.
/// Epoch clocks are deliberately absent: host freshness has a separate authority.
enum NimoResourceClock {
    static func now() -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let ticks = mach_continuous_time()
        let divisor = UInt64(info.denom) * 1_000_000
        return (ticks / divisor) * UInt64(info.numer) + (ticks % divisor) * UInt64(info.numer) / divisor
    }
}

/// Shared product state belongs to the current manager, independently of the
/// retained original object's cleanup and closure evidence.
enum NimoResourceManagerState {
    static func publish(owner: AnyObject, current: AnyObject?, _ update: () -> Void) {
        guard current === owner else { return }
        update()
    }
}

struct NimoResourceOriginal: Codable, Equatable {
    let instanceId: String
    let peripheralUuid: String
    let sessionGeneration: UInt64
}

struct NimoResourceProcess: Codable, Equatable {
    let pid: Int32
    let instanceId: String
}

struct NimoResourcePair: Codable, Equatable {
    let name: String
    let peripheralUuid: String
}

struct NimoResourceRequest: Codable, Equatable {
    enum Operation: String, Codable { case arm, status, release, cancel }
    let version: Int
    let operation: Operation
    let requestNonce: String
    let captureNonce: String
    let planSha256: String
    let grantSha256: String
    let expectedProcess: NimoResourceProcess
    let expectedPair: NimoResourcePair
    let original: NimoResourceOriginal?
}

struct NimoResourceProducers {
    var writerActive = 0, writerQueued = 0, encoderWorker = 0, encoderDelivery = 0
    var postedCallbacks = 0, canvasCommands = 0, pendingAcks = 0, audioWorkers = 0
    var scan = 0, timers = 0, reconnectTask = 0
    var dictionary: [String: Int] {
        ["writerActive": writerActive, "writerQueued": writerQueued, "encoderWorker": encoderWorker,
         "encoderDelivery": encoderDelivery, "postedCallbacks": postedCallbacks, "canvasCommands": canvasCommands,
         "pendingAcks": pendingAcks, "audioWorkers": audioWorkers, "scan": scan, "timers": timers, "reconnectTask": reconnectTask]
    }
    var settled: Bool { dictionary.values.allSatisfy { $0 == 0 } }
}

/// Retains the ORIGINAL object identities even after cancellation or timeout.
/// A later object, generation, peripheral or release nonce cannot be adopted.
final class NimoResourceSession {
    let captureNonce: String
    let pair: NimoResourcePair
    let armedElapsedMs: UInt64
    private(set) var admittedElapsedMs: UInt64?
    private(set) var instanceId: String?
    private(set) var original: NimoResourceOriginal?
    private(set) var cancelled = false
    private(set) var connected = false
    private(set) var startedElapsedMs: UInt64?
    private(set) var twsConnected = false
    private(set) var twsObservedElapsedMs: UInt64?
    private(set) var handshakeTwsElapsedMs: UInt64?
    private(set) var timeCommandId: String?
    private(set) var timeWriteStartedElapsedMs: UInt64?
    private(set) var timeWriteCompletedElapsedMs: UInt64?
    private(set) var timeAckElapsedMs: UInt64?
    private(set) var timeAckStatusCode: Int?
    private(set) var releaseNonce: String?
    private(set) var releaseStartedElapsedMs: UInt64?
    private(set) var micStopRequired = false
    private(set) var displayExitRequired = false
    private(set) var micStopStartedElapsedMs: UInt64?
    private(set) var micStopWrittenElapsedMs: UInt64?
    private(set) var micStopMarkerElapsedMs: UInt64?
    private(set) var exitStatusCode: Int?
    private(set) var exitAckElapsedMs: UInt64?
    private(set) var disconnectRequestedElapsedMs: UInt64?
    private(set) var disconnectCallbackElapsedMs: UInt64?
    private(set) var disconnectError: String?
    private(set) var noTransport = false
    private(set) var errors: [String] = []
    private var owner: AnyObject?
    private var peripheral: AnyObject?
    private let now: () -> UInt64

    init(captureNonce: String, pair: NimoResourcePair, now: @escaping () -> UInt64 = NimoResourceClock.now) {
        self.captureNonce = captureNonce; self.pair = pair; self.now = now
        armedElapsedMs = now()
    }

    func isOwner(_ candidate: AnyObject) -> Bool { owner === candidate }
    var hasOwner: Bool { owner != nil }
    func recordError(_ value: String) { let bounded = String(value.prefix(160)); if errors.count < 16, !errors.contains(bounded) { errors.append(bounded) } }

    /// Called before scanning/connecting, not from a status response.
    func admit(_ candidate: AnyObject, instanceId: String, name: String?, persist: (UInt64) -> Bool = { _ in true }) -> Bool {
        guard !cancelled, releaseNonce == nil, original == nil, name == nil || name == pair.name,
              owner == nil || owner === candidate else { return false }
        if owner == nil {
            let proposed = now()
            owner = candidate; self.instanceId = instanceId
            guard persist(proposed) else { cancelled = true; recordError("admission-persist-failed"); return false }
            admittedElapsedMs = proposed
        }
        return true
    }

    func allowsEntry(_ candidate: AnyObject) -> Bool {
        owner === candidate && !cancelled && releaseNonce == nil && original == nil
    }

    /// The plan pins a CoreBluetooth UUID; it is never constructed from a MAC.
    func beginTransport(_ candidate: AnyObject, peripheral: AnyObject, uuid: String, persist: (UInt64) -> Bool = { _ in true }) -> Bool {
        guard allowsEntry(candidate), uuid.lowercased() == pair.peripheralUuid.lowercased(), let instanceId else { return false }
        let proposed = now()
        guard persist(proposed) else { cancelled = true; recordError("transport-persist-failed"); return false }
        self.peripheral = peripheral
        original = NimoResourceOriginal(instanceId: instanceId, peripheralUuid: uuid.lowercased(), sessionGeneration: 1)
        startedElapsedMs = proposed
        return true
    }

    func matches(_ candidate: AnyObject, _ peer: AnyObject) -> Bool { owner === candidate && peripheral === peer }
    func mayReceive(_ candidate: AnyObject, _ peer: AnyObject) -> Bool { matches(candidate, peer) && disconnectCallbackElapsedMs == nil }
    func transportConnected(_ candidate: AnyObject, _ peer: AnyObject) {
        guard matches(candidate, peer), !cancelled, releaseNonce == nil else { return }
        connected = true
    }
    func observeTws(_ candidate: AnyObject, connected: Bool, receivedElapsedMs: UInt64? = nil) {
        guard owner === candidate, releaseNonce == nil, self.connected else { return }
        let received = receivedElapsedMs ?? now()
        guard let startedElapsedMs, received >= startedElapsedMs else { return }
        twsConnected = connected; twsObservedElapsedMs = received
    }
    func beginTimeCommand(_ candidate: AnyObject) -> String? {
        guard owner === candidate, releaseNonce == nil, connected, twsConnected, let twsObservedElapsedMs else { return nil }
        if handshakeTwsElapsedMs == nil { handshakeTwsElapsedMs = twsObservedElapsedMs }
        let id = UUID().uuidString.lowercased(); timeCommandId = id
        timeWriteStartedElapsedMs = nil; timeWriteCompletedElapsedMs = nil; timeAckElapsedMs = nil; timeAckStatusCode = nil
        return id
    }
    func timeWriteStarted(_ candidate: AnyObject, command: String) {
        guard owner === candidate, timeCommandId == command, releaseNonce == nil, timeWriteStartedElapsedMs == nil else { return }
        timeWriteStartedElapsedMs = now()
    }
    func timeWriteCompleted(_ candidate: AnyObject, command: String) {
        guard owner === candidate, timeCommandId == command, releaseNonce == nil, timeWriteStartedElapsedMs != nil, timeWriteCompletedElapsedMs == nil else { return }
        timeWriteCompletedElapsedMs = now()
    }
    func timeAck(_ candidate: AnyObject, command: String, status: Int, receivedElapsedMs: UInt64? = nil) {
        guard owner === candidate, timeCommandId == command, releaseNonce == nil, timeWriteStartedElapsedMs != nil, timeAckElapsedMs == nil else { return }
        let received = receivedElapsedMs ?? now()
        guard let started = timeWriteStartedElapsedMs, received >= started else { return }
        timeAckElapsedMs = received; timeAckStatusCode = status
    }
    var ready: Bool {
        guard !cancelled, releaseNonce == nil, connected, twsConnected,
              let start = startedElapsedMs, let tws = handshakeTwsElapsedMs,
              let written = timeWriteStartedElapsedMs, let completed = timeWriteCompletedElapsedMs,
              let ack = timeAckElapsedMs, timeAckStatusCode == 0 else { return false }
        return start <= tws && tws <= written && written <= completed && written <= ack
    }

    func beginRelease(nonce: String, cancel: Bool, mic: Bool, canvas: Bool) -> Bool {
        if let releaseNonce { return releaseNonce == nonce }
        releaseNonce = nonce; releaseStartedElapsedMs = now(); cancelled = true
        micStopRequired = mic; displayExitRequired = canvas
        if cancel { cancelled = true }
        return true
    }
    func micStopStarted(_ candidate: AnyObject) {
        guard owner === candidate, releaseNonce != nil, micStopRequired else { return }; micStopStartedElapsedMs = now()
    }
    func micStopWritten(_ candidate: AnyObject) {
        guard owner === candidate, micStopStartedElapsedMs != nil, micStopWrittenElapsedMs == nil else { return }; micStopWrittenElapsedMs = now()
    }
    func micStopMarker(_ candidate: AnyObject, receivedElapsedMs: UInt64? = nil) {
        guard owner === candidate, let started = micStopStartedElapsedMs, micStopMarkerElapsedMs == nil else { return }
        let received = receivedElapsedMs ?? now()
        guard received >= started else { return }; micStopMarkerElapsedMs = received
    }
    func exitAcknowledged(_ candidate: AnyObject, status: Int, receivedElapsedMs: UInt64? = nil) {
        guard owner === candidate, releaseNonce != nil, displayExitRequired else { return }
        let received = receivedElapsedMs ?? now()
        guard let started = releaseStartedElapsedMs, received >= started else { return }
        exitStatusCode = status; exitAckElapsedMs = received
    }
    var commandsSettled: Bool {
        (!micStopRequired || micStopStartedElapsedMs != nil && micStopWrittenElapsedMs != nil && micStopMarkerElapsedMs != nil) &&
            (!displayExitRequired || exitStatusCode == 0 && exitAckElapsedMs != nil)
    }
    func disconnectRequested(_ candidate: AnyObject) {
        guard owner === candidate, releaseNonce != nil, disconnectRequestedElapsedMs == nil else { return }
        disconnectRequestedElapsedMs = now()
    }
    /// A nil app reference or cancelPeripheralConnection return is NOT closure.
    func disconnected(_ candidate: AnyObject, _ peer: AnyObject, error: String?, receivedElapsedMs: UInt64? = nil) {
        guard matches(candidate, peer) else { return }
        connected = false
        guard disconnectRequestedElapsedMs != nil else { recordError("unexpected-disconnect"); return }
        let received = receivedElapsedMs ?? now()
        guard let requested = disconnectRequestedElapsedMs, received >= requested else { recordError("pre-request-disconnect"); return }
        if disconnectCallbackElapsedMs == nil { disconnectCallbackElapsedMs = received; disconnectError = error }
    }
    func proveNoTransport() {
        guard releaseNonce != nil, original == nil, peripheral == nil else { return }; noTransport = true
    }
    func settled(producers: NimoResourceProducers) -> Bool {
        releaseNonce != nil && commandsSettled && (noTransport || disconnectCallbackElapsedMs != nil && disconnectError == nil) && producers.settled && errors.isEmpty
    }

    func sessionDictionary() -> [String: Any]? {
        guard let instanceId, admittedElapsedMs != nil else { return nil }
        let original = original ?? NimoResourceOriginal(instanceId: instanceId, peripheralUuid: pair.peripheralUuid.lowercased(), sessionGeneration: 0)
        return ["instanceId": original.instanceId, "peripheralUuid": original.peripheralUuid,
                "sessionGeneration": original.sessionGeneration, "startedElapsedMs": nullable(startedElapsedMs),
                "connected": connected, "initializationPending": !ready && releaseNonce == nil,
                "twsConnected": twsConnected, "twsObservedElapsedMs": nullable(twsObservedElapsedMs),
                "handshakeTwsElapsedMs": nullable(handshakeTwsElapsedMs), "timeCommandId": nullable(timeCommandId),
                "timeWriteStartedElapsedMs": nullable(timeWriteStartedElapsedMs), "timeWriteCompletedElapsedMs": nullable(timeWriteCompletedElapsedMs),
                "timeAckElapsedMs": nullable(timeAckElapsedMs), "timeAckStatusCode": nullable(timeAckStatusCode)]
    }
    func releaseDictionary(producers: NimoResourceProducers) -> [String: Any] {
        ["nonce": nullable(releaseNonce), "startedElapsedMs": nullable(releaseStartedElapsedMs),
         "micStopRequired": micStopRequired, "displayExitRequired": displayExitRequired,
         "micStopStartedElapsedMs": nullable(micStopStartedElapsedMs), "micStopWrittenElapsedMs": nullable(micStopWrittenElapsedMs),
         "micStopMarkerElapsedMs": nullable(micStopMarkerElapsedMs), "exitStatusCode": nullable(exitStatusCode), "exitAckElapsedMs": nullable(exitAckElapsedMs),
         "disconnectRequestedElapsedMs": nullable(disconnectRequestedElapsedMs), "disconnectCallbackElapsedMs": nullable(disconnectCallbackElapsedMs),
         "disconnectError": nullable(disconnectError), "noTransport": noTransport, "settled": settled(producers: producers)]
    }
}

func nullable<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }

/// Cross-queue roster; queued Main callbacks cannot disappear on logical reset.
final class NimoResourceCallbackCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func add(_ amount: Int) { lock.lock(); count += amount; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

extension NimoResourceRequest {
    static func decode(_ bytes: Data) throws -> NimoResourceRequest {
        // JSONDecoder ignores unknown keys; reject them before typed decoding.
        guard bytes.count <= 16_384, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == Set(["version","operation","requestNonce","captureNonce","planSha256","grantSha256","expectedProcess","expectedPair","original"]),
              let process = value["expectedProcess"] as? [String: Any], Set(process.keys) == Set(["pid","instanceId"]),
              let pair = value["expectedPair"] as? [String: Any], Set(pair.keys) == Set(["name","peripheralUuid"]) else { throw failure("invalid-request-schema") }
        if let original = value["original"] as? [String: Any], Set(original.keys) != Set(["instanceId","peripheralUuid","sessionGeneration"]) { throw failure("invalid-original-schema") }
        let result = try JSONDecoder().decode(NimoResourceRequest.self, from: bytes)
        let ids = [result.requestNonce, result.captureNonce, result.expectedProcess.instanceId, result.expectedPair.peripheralUuid] +
            (result.original.map { [$0.instanceId, $0.peripheralUuid] } ?? [])
        for id in ids {
            guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw failure("invalid-uuid") }
        }
        if let original = result.original {
            guard original.sessionGeneration <= 1, original.peripheralUuid == result.expectedPair.peripheralUuid else { throw failure("invalid-original-identity") }
        }
        guard result.expectedProcess.pid > 1, result.version == 1, !result.expectedPair.name.isEmpty, result.expectedPair.name.utf8.count <= 128,
              result.planSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              result.grantSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw failure("invalid-request-identity") }
        return result
    }
    private static func failure(_ code: String) -> Error { NSError(domain: "NimoResourceFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: code]) }
}
