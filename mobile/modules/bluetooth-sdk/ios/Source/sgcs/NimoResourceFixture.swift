import Foundation
import CoreBluetooth

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
    private var acceptedPair: NimoResourceSelection?
    private var captureNonce: String?
    private var armedElapsedMs: UInt64?
    private var discovery: NimoResourceConnectedDiscovery?
    private var discoveryRequestNonce: String?
    private var discoveryReleaseNonce: String?
    private var discoveryReleaseStartedElapsedMs: UInt64?
    private var discoveryCancelled = false
    private var completed: [String: (Data, Data)] = [:]
    private var pending: [String: (Data, Task<Data, Error>)] = [:]
    private var transport: NimoMacResourceTransport?
    private var startupError: Error?
    private var originalClosed = false
    private let managerEntries = NimoResourceManagerEntries()
    var pendingManagerEntries: Int { managerEntries.all }
    var pendingOriginalManagerEntries: Int { managerEntries.originalNimo }
    func beginManagerEntry(_ wearable: String) -> NimoResourceManagerEntries.Ticket { managerEntries.begin(wearable) }
    func endManagerEntry(_ ticket: NimoResourceManagerEntries.Ticket) { managerEntries.end(ticket) }
    #if os(macOS)
    private let requested = ProcessInfo.processInfo.environment["MENTRA_NIMO_RESOURCE_BOOTSTRAP"] != nil
    #elseif os(iOS)
    private let requested = ProcessInfo.processInfo.isiOSAppOnMac && ProcessInfo.processInfo.environment["MENTRA_NIMO_RESOURCE_BOOTSTRAP"] != nil
    #else
    private let requested = false
    #endif
    #if SWIFT_PACKAGE
    private var packageEnabled = false
    #endif
    var enabled: Bool {
        #if SWIFT_PACKAGE
        return requested || packageEnabled
        #else
        return requested
        #endif
    }

    func start() {
        guard enabled, transport == nil, startupError == nil else { return }
        do { transport = try NimoMacResourceTransport(process: process) }
        catch { startupError = error }
    }
    func allowsManager(_ wearable: String, name: String? = nil) -> Bool {
        guard enabled else { return true }
        // A different manager can clean up the captured Nimo object. Permit it
        // only after the original resource has actually completed teardown.
        guard wearable.contains("NIMO") else { return NimoResourceManagerState.allowsReplacement(fixtureEnabled: enabled, originalClosed: originalClosed && (session == nil || session?.errors.isEmpty == true && session?.connected == false)) }
        guard let session, !session.cancelled, session.releaseNonce == nil, session.original == nil,
              name == nil || name == session.pair.name else { return false }
        return true
    }
    func hasVerifiedOriginalClosure(_ candidate: Nimo) -> Bool {
        originalClosed && owner === candidate && session?.isOwner(candidate) == true
            && session?.errors.isEmpty == true && session?.connected == false
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
        if request.operation != .arm && request.operation != .discover {
            guard captureNonce == request.captureNonce, acceptedPair == request.expectedPair else { throw failure("capture-mismatch") }
            let session = self.session
            let observed = session?.original ?? session?.instanceId.map { NimoResourceOriginal(instanceId: $0, peripheralUuid: session!.pair.peripheralUuid, sessionGeneration: 0) }
            if let expected = request.original { guard expected == observed else { throw failure("original-session-mismatch") } }
            if request.operation == .release, session?.hasOwner == true, request.original == nil { throw failure("release-requires-original") }
            if request.operation == .release, let release = session?.releaseNonce ?? discoveryReleaseNonce, release != request.requestNonce { throw failure("original-release-nonce-required") }
        }
        let recovery = request.operation == .release || request.operation == .cancel || session?.releaseNonce != nil || discoveryReleaseNonce != nil
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
        if request.operation == .discover {
            guard request.expectedPair.peripheralSelection == NimoResourceSelection.connectedService,
                  captureNonce == nil, request.original == nil, DeviceManager.shared.sgc == nil, pendingManagerEntries == 0 else { throw failure("discover-requires-unowned-manager") }
            acceptedPair = request.expectedPair; captureNonce = request.captureNonce; armedElapsedMs = NimoResourceClock.now()
            let observer = NimoResourceConnectedDiscovery(name: request.expectedPair.name, startedElapsedMs: armedElapsedMs!)
            discovery = observer; discoveryRequestNonce = request.requestNonce
            await observer.discoverConnected()
        }
        if request.operation == .arm {
            guard session == nil, request.original == nil, DeviceManager.shared.sgc == nil, pendingManagerEntries == 0 else { throw failure("arm-requires-unowned-manager") }
            let uuid: String
            if let observed = request.expectedPair.peripheralUuid {
                guard captureNonce == nil else { throw failure("capture-already-exists") }
                acceptedPair = request.expectedPair; captureNonce = request.captureNonce
                uuid = observed
            } else {
                guard captureNonce == request.captureNonce, acceptedPair == request.expectedPair,
                      !discoveryCancelled, discoveryReleaseNonce == nil,
                      let discoveryRequestNonce, completed[discoveryRequestNonce] != nil,
                      let discovery, discovery.ledger.settledElapsedMs != nil, discovery.callbacksPending == 0,
                      discovery.ledger.errors.isEmpty, let selected = discovery.ledger.selectedPeripheralUuid else { throw failure("discovery-not-admissible") }
                uuid = selected
            }
            if armedElapsedMs == nil { armedElapsedMs = NimoResourceClock.now() }
            session = NimoResourceSession(captureNonce: request.captureNonce, pair: NimoResourcePair(name: request.expectedPair.name, peripheralUuid: uuid), armedElapsedMs: armedElapsedMs!)
        }
        guard captureNonce == request.captureNonce, acceptedPair == request.expectedPair else { throw failure("capture-mismatch") }
        if session == nil {
            guard request.original == nil else { throw failure("original-session-mismatch") }
            if request.operation == .release || request.operation == .cancel {
                if let original = discoveryReleaseNonce, request.operation == .release, original != request.requestNonce { throw failure("original-release-nonce-required") }
                if discoveryReleaseNonce == nil {
                    discoveryReleaseNonce = request.requestNonce; discoveryReleaseStartedElapsedMs = NimoResourceClock.now()
                    discoveryCancelled = request.operation == .cancel
                    await discovery?.stopDiscovery(cancel: true)
                }
            }
            return discoveryOnlyReceipt(request, received: received)
        }
        guard let session, session.captureNonce == request.captureNonce, acceptedPair == request.expectedPair else { throw failure("capture-mismatch") }
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
                    while pendingOriginalManagerEntries != 0, NimoResourceClock.now() < deadline { try? await Task.sleep(nanoseconds: 10_000_000) }
                    if pendingOriginalManagerEntries != 0 { session.recordError("pending-manager-entry-not-settled") }
                    session.proveNoTransport()
                }
            } else if request.operation == .release, session.releaseNonce != request.requestNonce {
                throw failure("original-release-nonce-required")
            }
        }
        var producers = NimoResourceProducers()
        producers.postedCallbacks = pendingOriginalManagerEntries
        if let owner { producers = await owner.resourceProducers() }
        originalClosed = session.settled(producers: producers)
        let manager = DeviceManager.shared.sgc
        let managerId = (manager as? Nimo)?.resourceInstanceId
        let current: [String: Any] = ["type": nullable(manager?.type), "instanceId": nullable(managerId)]
        var result: [String: Any] = ["version": 1, "protocol": "nimo-macos-resource-v1", "operation": request.operation.rawValue,
                "requestNonce": request.requestNonce, "captureNonce": request.captureNonce,
                "planSha256": request.planSha256, "grantSha256": request.grantSha256,
                "process": ["pid": process.pid, "instanceId": process.instanceId],
                "clock": ["kind": "darwin-continuous-time-v1", "receivedElapsedMs": received, "observedElapsedMs": NimoResourceClock.now()],
                "capture": ["armedElapsedMs": session.armedElapsedMs, "admittedElapsedMs": nullable(session.admittedElapsedMs), "cancelled": session.cancelled,
                            "expectedPair": request.expectedPair.dictionary],
                "currentManager": current, "session": nullable(session.sessionDictionary()),
                "release": session.releaseDictionary(producers: producers), "producers": producers.dictionary, "errors": session.errors]
        if let discovery { result["discovery"] = discovery.ledger.dictionary(callbacksPending: discovery.callbacksPending) }
        return result
    }

    private func discoveryOnlyReceipt(_ request: NimoResourceRequest, received: UInt64) -> [String: Any] {
        let settled = discovery?.ledger.settledElapsedMs != nil && discovery?.callbacksPending == 0
        let manager = DeviceManager.shared.sgc
        let managerSafe = manager == nil || originalClosed && !(manager?.type.contains("NIMO") ?? false)
        let closed = discoveryReleaseNonce != nil && settled && pendingOriginalManagerEntries == 0 && managerSafe
        originalClosed = closed
        var producers = NimoResourceProducers()
        producers.postedCallbacks = pendingOriginalManagerEntries + (discovery?.callbacksPending ?? 0)
        producers.timers = settled ? 0 : 1
        let release: [String: Any] = ["nonce": nullable(discoveryReleaseNonce), "startedElapsedMs": nullable(discoveryReleaseStartedElapsedMs),
            "micStopRequired": false, "displayExitRequired": false, "micStopStartedElapsedMs": NSNull(), "micStopWrittenElapsedMs": NSNull(), "micStopMarkerElapsedMs": NSNull(),
            "exitStatusCode": NSNull(), "exitAckElapsedMs": NSNull(), "disconnectRequestedElapsedMs": NSNull(), "disconnectCallbackElapsedMs": NSNull(), "disconnectError": NSNull(),
            "connectionFailedElapsedMs": NSNull(), "noTransport": closed, "settled": closed]
        return ["version": 1, "protocol": "nimo-macos-resource-v1", "operation": request.operation.rawValue,
            "requestNonce": request.requestNonce, "captureNonce": request.captureNonce, "planSha256": request.planSha256, "grantSha256": request.grantSha256,
            "process": ["pid": process.pid, "instanceId": process.instanceId],
            "clock": ["kind": "darwin-continuous-time-v1", "receivedElapsedMs": received, "observedElapsedMs": NimoResourceClock.now()],
            "capture": ["armedElapsedMs": armedElapsedMs!, "admittedElapsedMs": NSNull(), "cancelled": discoveryCancelled, "expectedPair": request.expectedPair.dictionary],
            "currentManager": ["type": nullable(DeviceManager.shared.sgc?.type), "instanceId": nullable((DeviceManager.shared.sgc as? Nimo)?.resourceInstanceId)],
            "session": NSNull(), "release": release, "producers": producers.dictionary, "errors": [],
            "discovery": discovery!.ledger.dictionary(callbacksPending: discovery!.callbacksPending)]
    }

    #if SWIFT_PACKAGE
    /// Test-only original discovery seed; no CoreBluetooth object is created.
    /// Tests still execute the real perform/status/cancel/arm authority branches.
    func packageSeedDiscovery(name: String, capture: String, discoveryOperation: String, candidates: [(String, String?)], persisted: Bool) {
        packageEnabled = true
        acceptedPair = NimoResourceSelection(name: name, peripheralSelection: NimoResourceSelection.connectedService)
        captureNonce = capture; armedElapsedMs = NimoResourceClock.now()
        let observer = NimoResourceConnectedDiscovery(name: name, startedElapsedMs: armedElapsedMs!)
        discovery = observer; discoveryRequestNonce = discoveryOperation
        for (uuid, candidateName) in candidates { observer.ledger.observe(uuid: uuid, name: candidateName) }
        observer.ledger.finish(at: NimoResourceClock.now(), callbacksPending: 0)
        if persisted { completed[discoveryOperation] = (Data(), Data()) }
    }
    func packagePerform(_ bytes: Data) async throws -> [String: Any] {
        try await perform(try decode(bytes), received: NimoResourceClock.now())
    }
    #endif

    private func decode(_ bytes: Data) throws -> NimoResourceRequest { try NimoResourceRequest.decode(bytes) }
    private func failure(_ code: String) -> Error { NSError(domain: "NimoResourceFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: code]) }
}


/// Retrieval only: no scan, connection, peripheral delegate, service discovery or
/// writes. The serial state-delegate queue drains before candidate commitment.
@MainActor
final class NimoResourceConnectedDiscovery: NSObject, CBCentralManagerDelegate {
    let ledger: NimoResourceDiscovery
    private let queue = DispatchQueue(label: "com.mentra.nimo.resource.connected-discovery")
    private var central: CBCentralManager?
    private var stopped = false
    private var running = false
    private var now: () -> UInt64 = NimoResourceClock.now
    private var pause: () async throws -> Void = { try await Task.sleep(nanoseconds: 50_000_000) }
    #if SWIFT_PACKAGE
    private var packageSample: (() -> (CBManagerState, [(String, String?)]))?
    func packageConfigureObserver(now: @escaping () -> UInt64, pause: @escaping () async throws -> Void,
                                  sample: @escaping () -> (CBManagerState, [(String, String?)])) {
        precondition(!running && central == nil)
        self.now = now; self.pause = pause; packageSample = sample
    }
    #endif
    nonisolated private let callbacks = NimoResourceCallbackCounter()
    var callbacksPending: Int { callbacks.value }
    init(name: String, startedElapsedMs: UInt64) {
        ledger = NimoResourceDiscovery(name: name, startedElapsedMs: startedElapsedMs); super.init()
    }
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        callbacks.add(1)
        defer { callbacks.add(-1) }
        // No deferred work. State is sampled by the owned bounded Main loop.
    }
    @inline(never)
    private func retrieveConnected(_ central: CBCentralManager) -> [CBPeripheral] {
        central.retrieveConnectedPeripherals(withServices: [CBUUID(string: "00007033-0000-1000-8000-00805F9B34FB")])
    }
    @inline(never)
    func discoverConnected() async {
        guard !running, !stopped else { return }
        running = true
        #if SWIFT_PACKAGE
        if packageSample == nil {
            central = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        }
        #else
        central = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        #endif
        let deadline = ledger.startedElapsedMs + 5_000
        while !stopped {
            // A post-sleep final powered-on retrieval replaces earlier facts.
            let finalSample = now() >= deadline
            var state = central?.state ?? .unknown
            #if SWIFT_PACKAGE
            let simulated = packageSample?()
            if let simulated { state = simulated.0 }
            #endif
            switch state {
            case .poweredOn:
                #if SWIFT_PACKAGE
                if let simulated { ledger.observeConnectedSnapshot(simulated.1) }
                else if let central { ledger.observeConnectedSnapshot(retrieveConnected(central).map { ($0.identifier.uuidString.lowercased(), $0.name) }) }
                else { ledger.observeConnectedSnapshot([]) }
                #else
                if let central { ledger.observeConnectedSnapshot(retrieveConnected(central).map { ($0.identifier.uuidString.lowercased(), $0.name) }) }
                else { ledger.observeConnectedSnapshot([]) }
                #endif
            case .unsupported, .unauthorized:
                ledger.observeConnectedSnapshot([])
                ledger.recordError("connected-service-observer-unavailable"); finishDiscovery(); return
            default:
                // Radio loss invalidates the current snapshot, not history.
                ledger.observeConnectedSnapshot([])
            }
            if finalSample { break }
            do { try await pause() }
            catch { ledger.recordError("discovery-task-cancelled"); ledger.cancel(); finishDiscovery(); return }
        }
        finishDiscovery()
    }
    @inline(never)
    func stopDiscovery(cancel: Bool) async {
        if cancel { ledger.cancel() }
        stopped = true
        let deadline = NimoResourceClock.now() + 1_000
        while running, NimoResourceClock.now() < deadline {
            do { try await Task.sleep(nanoseconds: 1_000_000) } catch { await Task.yield() }
        }
        guard !running else { ledger.recordError("discovery-loop-not-settled"); return }
        finishDiscovery()
    }
    @inline(never)
    private func finishDiscovery() {
        stopped = true
        central?.delegate = nil
        // Callback contains no Main work; the queue barrier cannot deadlock.
        queue.sync {}
        central = nil
        ledger.finish(at: now(), callbacksPending: callbacksPending)
        running = false
    }
}
