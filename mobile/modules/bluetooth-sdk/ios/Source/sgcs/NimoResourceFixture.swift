import Foundation

/// One process-local authority shared by the typed Expo bridge and the Mac
/// fixture socket. Neither accepts packets, connection addresses or file paths.
@MainActor
public enum NimoResourceFixtureBridge {
    public static func execute(_ json: String) async throws -> String {
        let bytes = Data(json.utf8)
        return String(decoding: try await NimoResourceFixture.shared.execute(bytes), as: UTF8.self)
    }
}

@MainActor
final class NimoResourceFixture {
    static let shared = NimoResourceFixture()
    let process = NimoResourceProcess(pid: ProcessInfo.processInfo.processIdentifier, instanceId: UUID().uuidString.lowercased())
    private(set) var session: NimoResourceSession?
    private(set) var owner: Nimo?
    private var completed: [String: (Data, Data)] = [:]
    private var pending: [String: (Data, Task<Data, Error>)] = [:]
    private var transport: NimoMacResourceTransport?
    private var startupError: Error?
    private var originalClosed = false
    var pendingManagerEntries = 0
    #if os(macOS)
    private let requested = ProcessInfo.processInfo.environment["MENTRA_NIMO_RESOURCE_BOOTSTRAP"] != nil
    #elseif os(iOS)
    private let requested = ProcessInfo.processInfo.isiOSAppOnMac && ProcessInfo.processInfo.environment["MENTRA_NIMO_RESOURCE_BOOTSTRAP"] != nil
    #else
    private let requested = false
    #endif
    var enabled: Bool { requested }

    func start() {
        guard enabled, transport == nil, startupError == nil else { return }
        do { transport = try NimoMacResourceTransport(process: process) }
        catch { startupError = error }
    }
    func allowsManager(_ wearable: String, name: String? = nil) -> Bool {
        guard enabled else { return true }
        // A different manager can clean up the captured Nimo object. Permit it
        // only after the original resource has actually completed teardown.
        guard wearable.contains("NIMO") else { return NimoResourceManagerState.allowsReplacement(fixtureEnabled: enabled, originalClosed: originalClosed && session?.errors.isEmpty == true && session?.connected == false) }
        guard let session, !session.cancelled, session.releaseNonce == nil, session.original == nil,
              name == nil || name == session.pair.name else { return false }
        return true
    }
    func admit(_ candidate: Nimo, name: String?) -> Bool {
        guard enabled else { return true }
        guard (DeviceManager.shared.sgc as AnyObject?) === candidate, let session, let transport else { return false }
        let admitted = session.admit(candidate, instanceId: candidate.resourceInstanceId, name: name) { proposed in
            self.persistAdmission(session, instanceId: candidate.resourceInstanceId, elapsed: proposed, transportStart: false, transport: transport)
        }
        if session.isOwner(candidate), owner == nil { owner = candidate }
        return admitted && owner === candidate
    }
    private func persistAdmission(_ session: NimoResourceSession, instanceId: String, elapsed: UInt64, transportStart: Bool, transport: NimoMacResourceTransport) -> Bool {
        let value: [String: Any] = ["protocol": "nimo-macos-resource-v1", "captureNonce": session.captureNonce,
            "process": ["pid": process.pid, "instanceId": process.instanceId],
            "planSha256": transport.configuration.planSha256, "grantSha256": transport.configuration.grantSha256,
            "instanceId": instanceId, "peripheralUuid": session.pair.peripheralUuid, "sessionGeneration": transportStart ? 1 : 0,
            "armedElapsedMs": session.armedElapsedMs, "admittedElapsedMs": transportStart ? nullable(session.admittedElapsedMs) : elapsed,
            "startedElapsedMs": transportStart ? elapsed : NSNull() as Any]
        do {
            let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            try transport.persist(bytes, nonce: session.captureNonce, kind: transportStart ? "transport" : "admission")
            return true
        } catch { return false }
    }
    func preserveScan(_ name: String) -> Bool {
        guard enabled, let owner, let session, session.isOwner(owner),
              session.original == nil, !session.cancelled, name == session.pair.name else { return false }
        return (DeviceManager.shared.sgc as AnyObject?) === owner
    }
    func beginTransport(_ candidate: Nimo, peripheral: AnyObject, uuid: String) -> Bool {
        guard enabled else { return true }
        guard (DeviceManager.shared.sgc as AnyObject?) === candidate, let session, let transport else { return false }
        return session.beginTransport(candidate, peripheral: peripheral, uuid: uuid) { proposed in
            self.persistAdmission(session, instanceId: candidate.resourceInstanceId, elapsed: proposed, transportStart: true, transport: transport)
        }
    }
    func allowsProducer(_ candidate: Nimo) -> Bool {
        guard enabled else { return true }
        return session?.isOwner(candidate) == true && session?.releaseNonce == nil && session?.cancelled == false && (DeviceManager.shared.sgc as AnyObject?) === candidate
    }
    func captured(_ candidate: Nimo) -> NimoResourceSession? {
        guard enabled, session?.isOwner(candidate) == true else { return nil }; return session
    }

    func execute(_ bytes: Data) async throws -> Data {
        start()
        guard bytes.count <= 16_384, enabled, let transport, startupError == nil else { throw failure("fixture-unavailable") }
        let request = try decode(bytes)
        guard request.version == 1, request.expectedProcess == process,
              request.planSha256 == transport.configuration.planSha256,
              request.grantSha256 == transport.configuration.grantSha256 else { throw failure("fixture-authority-mismatch") }
        if let (original, receipt) = completed[request.requestNonce] {
            guard original == bytes else { throw failure("request-nonce-reused") }; return receipt
        }
        if let (original, task) = pending[request.requestNonce] {
            guard original == bytes else { throw failure("request-nonce-reused") }; return try await task.value
        }
        if request.operation != .arm {
            guard let session, session.captureNonce == request.captureNonce, session.pair == request.expectedPair else { throw failure("capture-mismatch") }
            let observed = session.original ?? session.instanceId.map { NimoResourceOriginal(instanceId: $0, peripheralUuid: session.pair.peripheralUuid, sessionGeneration: 0) }
            if let expected = request.original { guard expected == observed else { throw failure("original-session-mismatch") } }
            if request.operation == .release, session.hasOwner, request.original == nil { throw failure("release-requires-original") }
            if request.operation == .release, let release = session.releaseNonce, release != request.requestNonce { throw failure("original-release-nonce-required") }
        }
        let recovery = request.operation == .release || request.operation == .cancel || session?.releaseNonce != nil
        guard completed.count + pending.count < (recovery ? 256 : 192) else { throw failure("request-budget-exhausted") }
        // Intent is persisted before ANY capture or release mutation. No caller
        // path is used; replay compares the exact original request bytes.
        try transport.persist(bytes, nonce: request.requestNonce, kind: "intent")
        let received = NimoResourceClock.now()
        let task = Task { @MainActor in
            let result = try await self.perform(request, received: received)
            let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            guard encoded.count <= 32_768 else { throw self.failure("receipt-budget-exhausted") }
            try transport.persist(encoded, nonce: request.requestNonce, kind: "receipt")
            return encoded
        }
        pending[request.requestNonce] = (bytes, task)
        do {
            let receipt = try await task.value
            completed[request.requestNonce] = (bytes, receipt); pending.removeValue(forKey: request.requestNonce)
            return receipt
        } catch {
            // Keep the original failed intent fenced; do not reexecute effects.
            throw error
        }
    }

    private func perform(_ request: NimoResourceRequest, received: UInt64) async throws -> [String: Any] {
        if request.operation == .arm {
            guard session == nil, request.original == nil, DeviceManager.shared.sgc == nil, pendingManagerEntries == 0 else { throw failure("arm-requires-unowned-manager") }
            session = NimoResourceSession(captureNonce: request.captureNonce, pair: request.expectedPair)
        }
        guard let session, session.captureNonce == request.captureNonce, session.pair == request.expectedPair else { throw failure("capture-mismatch") }
        if let expected = request.original {
            let observed = session.original ?? session.instanceId.map { NimoResourceOriginal(instanceId: $0, peripheralUuid: session.pair.peripheralUuid, sessionGeneration: 0) }
            guard expected == observed else { throw failure("original-session-mismatch") }
        } else if request.operation == .release, session.hasOwner { throw failure("release-requires-original") }
        if request.operation == .release || request.operation == .cancel {
            if session.releaseNonce == nil {
                let mic = owner?.resourceMicStopRequired ?? false, canvas = owner?.resourceCanvasRequired ?? false
                guard session.beginRelease(nonce: request.requestNonce, cancel: request.operation == .cancel, mic: mic, canvas: canvas) else { throw failure("release-mismatch") }
                if let owner { await owner.releaseResource(session) }
                else {
                    let deadline = NimoResourceClock.now() + 1_000
                    while pendingManagerEntries != 0, NimoResourceClock.now() < deadline { try? await Task.sleep(nanoseconds: 10_000_000) }
                    if pendingManagerEntries != 0 { session.recordError("pending-manager-entry-not-settled") }
                    session.proveNoTransport()
                }
            } else if request.operation == .release, session.releaseNonce != request.requestNonce {
                throw failure("original-release-nonce-required")
            }
        }
        var producers = NimoResourceProducers()
        producers.postedCallbacks = pendingManagerEntries
        if let owner { producers = await owner.resourceProducers() }
        originalClosed = session.settled(producers: producers)
        let manager = DeviceManager.shared.sgc
        let managerId = (manager as? Nimo)?.resourceInstanceId
        let current: [String: Any] = ["type": nullable(manager?.type), "instanceId": nullable(managerId)]
        return ["version": 1, "protocol": "nimo-macos-resource-v1", "operation": request.operation.rawValue,
                "requestNonce": request.requestNonce, "captureNonce": request.captureNonce,
                "planSha256": request.planSha256, "grantSha256": request.grantSha256,
                "process": ["pid": process.pid, "instanceId": process.instanceId],
                "clock": ["kind": "darwin-continuous-time-v1", "receivedElapsedMs": received, "observedElapsedMs": NimoResourceClock.now()],
                "capture": ["armedElapsedMs": session.armedElapsedMs, "admittedElapsedMs": nullable(session.admittedElapsedMs), "cancelled": session.cancelled,
                            "expectedPair": ["name": session.pair.name, "peripheralUuid": session.pair.peripheralUuid]],
                "currentManager": current, "session": nullable(session.sessionDictionary()),
                "release": session.releaseDictionary(producers: producers), "producers": producers.dictionary, "errors": session.errors]
    }

    private func decode(_ bytes: Data) throws -> NimoResourceRequest { try NimoResourceRequest.decode(bytes) }
    private func failure(_ code: String) -> Error { NSError(domain: "NimoResourceFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: code]) }
}
