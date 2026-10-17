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
    static func allowsReplacement(fixtureEnabled: Bool, originalClosed: Bool) -> Bool {
        !fixtureEnabled || originalClosed
    }
    static func publish(owner: AnyObject, current: AnyObject?, _ update: () -> Void) {
        guard current === owner else { return }
        update()
    }
}

/// Queue tickets freeze dispatch scope before DeviceManager's asynchronous work.
/// All entries fence initial arm; only original NIMO entries belong to its drain.
final class NimoResourceManagerEntries {
    final class Ticket {
        fileprivate weak var owner: NimoResourceManagerEntries?
        fileprivate let nimo: Bool
        fileprivate var ended = false
        fileprivate init(owner: NimoResourceManagerEntries, nimo: Bool) { self.owner = owner; self.nimo = nimo }
    }
    private(set) var all = 0
    private(set) var originalNimo = 0
    func begin(_ wearable: String) -> Ticket {
        let nimo = wearable.contains("NIMO")
        all += 1
        if nimo { originalNimo += 1 }
        return Ticket(owner: self, nimo: nimo)
    }
    func end(_ ticket: Ticket) {
        guard ticket.owner === self, !ticket.ended else { return }
        ticket.ended = true; all -= 1
        if ticket.nimo { originalNimo -= 1 }
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

/// Accepted selection remains immutable even after connected-service discovery.
struct NimoResourceSelection: Codable, Equatable {
    static let connectedService = "connected-service-exact-name-v1"
    let name: String
    let peripheralUuid: String?
    let peripheralSelection: String?
    init(name: String, peripheralUuid: String? = nil, peripheralSelection: String? = nil) { self.name = name; self.peripheralUuid = peripheralUuid; self.peripheralSelection = peripheralSelection }
    init(pair: NimoResourcePair) { name = pair.name; peripheralUuid = pair.peripheralUuid; peripheralSelection = nil }
    var dictionary: [String: Any] {
        if let peripheralUuid { return ["name": name, "peripheralUuid": peripheralUuid] }
        return ["name": name, "peripheralSelection": peripheralSelection ?? ""]
    }
}

/// Pure candidate ledger. Selection is committed only once, after the bounded
/// observer has stopped; a later callback cannot replace its physical identity.
final class NimoResourceDiscovery {
    static let serviceUuid = "00007033-0000-1000-8000-00805f9b34fb"
    let name: String
    let startedElapsedMs: UInt64
    private(set) var settledElapsedMs: UInt64?
    private(set) var selectedPeripheralUuid: String?
    private(set) var candidates: [String: String] = [:]
    private var currentlyConnected: Set<String> = []
    private(set) var errors: [String] = []
    private(set) var cancelled = false
    init(name: String, startedElapsedMs: UInt64) { self.name = name; self.startedElapsedMs = startedElapsedMs }
    func observe(uuid: String, name: String?) {
        guard settledElapsedMs == nil, !cancelled, name == self.name else { return }
        guard UUID(uuidString: uuid)?.uuidString.lowercased() == uuid else { recordError("invalid-discovery-uuid"); return }
        if candidates.count >= 16, candidates[uuid] == nil { recordError("discovery-candidate-budget"); return }
        candidates[uuid] = name
        currentlyConnected.insert(uuid)
        if candidates.count > 1 { recordError("ambiguous-connected-service-peer") }
    }
    func observeConnectedSnapshot(_ peers: [(String, String?)]) {
        guard settledElapsedMs == nil, !cancelled else { return }
        currentlyConnected.removeAll()
        for (uuid, name) in peers { observe(uuid: uuid, name: name) }
    }
    func recordError(_ error: String) { guard settledElapsedMs == nil else { return }; if errors.count < 16, !errors.contains(error) { errors.append(error) } }
    func cancel() { guard settledElapsedMs == nil else { return }; cancelled = true }
    func finish(at: UInt64, callbacksPending: Int) {
        guard settledElapsedMs == nil, callbacksPending == 0, at >= startedElapsedMs else { return }
        if !cancelled, errors.isEmpty, candidates.count == 1, currentlyConnected.count == 1 { selectedPeripheralUuid = candidates.keys.first }
        else if !cancelled, currentlyConnected.isEmpty { recordError("no-connected-service-peer") }
        settledElapsedMs = at
    }
    func dictionary(callbacksPending: Int) -> [String: Any] {
        ["kind": NimoResourceSelection.connectedService, "selectedPeripheralUuid": nullable(selectedPeripheralUuid),
         "candidates": candidates.keys.sorted().map { ["peripheralUuid": $0, "name": candidates[$0]!, "source": "connected-service", "serviceUuid": Self.serviceUuid] },
         "startedElapsedMs": startedElapsedMs, "settledElapsedMs": nullable(settledElapsedMs),
         "settled": settledElapsedMs != nil && callbacksPending == 0, "callbacksPending": callbacksPending, "errors": errors]
    }
}

struct NimoResourceRequest: Codable, Equatable {
    enum Operation: String, Codable { case discover, arm, status, release, cancel }
    let version: Int
    let operation: Operation
    let requestNonce: String
    let captureNonce: String
    let planSha256: String
    let grantSha256: String
    let expectedProcess: NimoResourceProcess
    let expectedPair: NimoResourceSelection
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
    private var everConnected = false
    private(set) var connectionFailedElapsedMs: UInt64?
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

    init(captureNonce: String, pair: NimoResourcePair, now: @escaping () -> UInt64 = NimoResourceClock.now, armedElapsedMs: UInt64? = nil) {
        self.captureNonce = captureNonce; self.pair = pair; self.now = now
        self.armedElapsedMs = armedElapsedMs ?? now()
    }

    func isOwner(_ candidate: AnyObject) -> Bool { owner === candidate }
    var hasOwner: Bool { owner != nil }
    func recordError(_ value: String) { let bounded = String(value.prefix(160)); if errors.count < 16, !errors.contains(bounded) { errors.append(bounded) } }

    /// Ordinary manager disposal may follow an already accepted original close.
    /// It must not rewrite that physical history or touch a replacement device.
    /// An active or contradicted capture retains the original diagnostic error.
    func shouldRunOrdinaryDisconnect(_ candidate: AnyObject, originalClosed: Bool) -> Bool {
        guard isOwner(candidate) else { return false }
        if originalClosed && settled(producers: NimoResourceProducers()) { return false }
        recordError("ordinary-disconnect-during-capture")
        if releaseNonce != nil { disconnectRequested(candidate) }
        return true
    }

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
    func mayReceive(_ candidate: AnyObject, _ peer: AnyObject) -> Bool { matches(candidate, peer) && disconnectCallbackElapsedMs == nil && connectionFailedElapsedMs == nil }
    func transportConnected(_ candidate: AnyObject, _ peer: AnyObject) {
        guard matches(candidate, peer) else { return }
        everConnected = true; connected = true
        if connectionFailedElapsedMs != nil { recordError("connect-after-failed-attempt"); return }
    }
    /// The original failed-attempt callback proves this never-connected transport ended.
    func connectionFailed(_ candidate: AnyObject, _ peer: AnyObject, receivedElapsedMs: UInt64) {
        guard matches(candidate, peer), !everConnected, let startedElapsedMs, receivedElapsedMs >= startedElapsedMs else { return }
        if connectionFailedElapsedMs == nil { connectionFailedElapsedMs = receivedElapsedMs }
        connected = false
    }
    func observeTws(_ candidate: AnyObject, connected: Bool, receivedElapsedMs: UInt64? = nil) {
        guard owner === candidate, releaseNonce == nil, self.connected else { return }
        let received = receivedElapsedMs ?? now()
        guard let startedElapsedMs, received >= startedElapsedMs else { return }
        twsConnected = connected; twsObservedElapsedMs = received
    }
    /// A setup timeout after the release fence is an abandoned handshake, not
    /// a new failure or authority to disconnect/retry the original transport.
    func recordHandshakeFailure(_ candidate: AnyObject) -> Bool {
        guard owner === candidate, releaseNonce == nil else { return false }
        recordError("handshake-failed")
        return true
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

    // Preserve the genuine release-admission boundary for delivered compiler proof.
    @inline(never)
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
        releaseNonce != nil && commandsSettled && (noTransport || connectionFailedElapsedMs != nil || disconnectCallbackElapsedMs != nil && disconnectError == nil) && producers.settled && errors.isEmpty
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
         "disconnectError": nullable(disconnectError), "connectionFailedElapsedMs": nullable(connectionFailedElapsedMs), "noTransport": noTransport, "settled": settled(producers: producers)]
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
              let pair = value["expectedPair"] as? [String: Any],
              Set(pair.keys) == Set(["name","peripheralUuid"]) || Set(pair.keys) == Set(["name","peripheralSelection"]) else { throw failure("invalid-request-schema") }
        if let original = value["original"] as? [String: Any], Set(original.keys) != Set(["instanceId","peripheralUuid","sessionGeneration"]) { throw failure("invalid-original-schema") }
        let result = try JSONDecoder().decode(NimoResourceRequest.self, from: bytes)
        let ids = [result.requestNonce, result.captureNonce, result.expectedProcess.instanceId] + (result.expectedPair.peripheralUuid.map { [$0] } ?? []) +
            (result.original.map { [$0.instanceId, $0.peripheralUuid] } ?? [])
        for id in ids {
            guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw failure("invalid-uuid") }
        }
        if result.operation == .discover {
            guard result.expectedPair.peripheralSelection == NimoResourceSelection.connectedService,
                  result.requestNonce == result.captureNonce, result.original == nil else { throw failure("invalid-discovery-identity") }
        }
        if result.operation == .arm {
            guard result.original == nil,
                  (result.expectedPair.peripheralUuid != nil ? result.requestNonce == result.captureNonce : result.requestNonce != result.captureNonce) else { throw failure("invalid-arm-identity") }
        }
        if let original = result.original {
            guard original.sessionGeneration <= 1, (result.expectedPair.peripheralUuid == nil || original.peripheralUuid == result.expectedPair.peripheralUuid) else { throw failure("invalid-original-identity") }
        }
        guard (result.expectedPair.peripheralUuid != nil && result.expectedPair.peripheralSelection == nil || result.expectedPair.peripheralUuid == nil && result.expectedPair.peripheralSelection == NimoResourceSelection.connectedService),
              result.expectedProcess.pid > 1, result.version == 1, !result.expectedPair.name.isEmpty, result.expectedPair.name.utf8.count <= 128,
              result.planSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              result.grantSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw failure("invalid-request-identity") }
        return result
    }
    private static func failure(_ code: String) -> Error { NSError(domain: "NimoResourceFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: code]) }
}
