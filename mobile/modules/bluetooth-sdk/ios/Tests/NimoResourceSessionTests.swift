import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class NimoResourceSessionTests: XCTestCase {
    func testConnectedDiscoverySelectionRequiresExactUniquePeerAndCannotChangeAfterSettlement() {
        let model = NimoResourceDiscovery(name: "NIMO exact", startedElapsedMs: 10)
        model.observe(uuid: uuid, name: "NIMO exact_BLE")
        XCTAssertTrue(model.candidates.isEmpty)
        model.observe(uuid: uuid, name: "NIMO exact")
        model.observe(uuid: uuid, name: "NIMO exact")
        model.finish(at: 20, callbacksPending: 1)
        XCTAssertNil(model.settledElapsedMs)
        XCTAssertNil(model.selectedPeripheralUuid)
        model.finish(at: 21, callbacksPending: 0)
        XCTAssertEqual(model.selectedPeripheralUuid, uuid)
        model.observe(uuid: "00000000-0000-4000-8000-000000000002", name: "NIMO exact")
        model.cancel(); model.finish(at: 30, callbacksPending: 0)
        XCTAssertEqual(model.selectedPeripheralUuid, uuid)
        XCTAssertEqual(model.settledElapsedMs, 21)
        XCTAssertEqual(model.candidates.count, 1)
    }
    func testConnectedDiscoveryAmbiguityCancellationAndMissingPeerNeverSelect() {
        for scenario in 0..<3 {
            let model = NimoResourceDiscovery(name: "NIMO exact", startedElapsedMs: 10)
            if scenario != 2 { model.observe(uuid: uuid, name: "NIMO exact") }
            if scenario == 0 { model.observe(uuid: "00000000-0000-4000-8000-000000000002", name: "NIMO exact") }
            if scenario == 1 { model.cancel() }
            model.finish(at: 20, callbacksPending: 0)
            XCTAssertNil(model.selectedPeripheralUuid)
            XCTAssertEqual(model.settledElapsedMs, 20)
            if scenario != 1 { XCTAssertFalse(model.errors.isEmpty) }
        }
    }
    func testConnectedDiscoveryDoesNotSelectPeerThatDisappearedBeforeFinalObservation() {
        let model = NimoResourceDiscovery(name: "NIMO exact", startedElapsedMs: 10)
        model.observeConnectedSnapshot([(uuid, "NIMO exact")])
        model.observeConnectedSnapshot([])
        model.finish(at: 20, callbacksPending: 0)
        XCTAssertNil(model.selectedPeripheralUuid)
        XCTAssertEqual(model.candidates.count, 1)
        XCTAssertFalse(model.errors.isEmpty)
    }
    private func discoveryRequest(operation: String, capture: String, nonce: String, extraPair: [String: Any] = [:]) throws -> Data {
        var pair: [String: Any] = ["name": "NIMO exact", "peripheralSelection": "connected-service-exact-name-v1"]
        for (key, value) in extraPair { pair[key] = value }
        return try JSONSerialization.data(withJSONObject: ["version": 1, "operation": operation, "requestNonce": nonce, "captureNonce": capture,
            "planSha256": String(repeating: "a", count: 64), "grantSha256": String(repeating: "b", count: 64),
            "expectedProcess": ["pid": 123, "instanceId": uuid], "expectedPair": pair, "original": NSNull()])
    }
    func testDiscoveryWireRejectsMixedOrUnknownSelectionRatherThanPlaceholderUuid() throws {
        let data = try discoveryRequest(operation: "discover", capture: uuid, nonce: uuid)
        XCTAssertEqual(try NimoResourceRequest.decode(data).expectedPair.peripheralSelection, NimoResourceSelection.connectedService)
        XCTAssertThrowsError(try NimoResourceRequest.decode(discoveryRequest(operation: "discover", capture: uuid, nonce: uuid, extraPair: ["peripheralUuid": uuid])))
        XCTAssertThrowsError(try NimoResourceRequest.decode(discoveryRequest(operation: "discover", capture: uuid, nonce: uuid, extraPair: ["peripheralSelection": "name-only"])))
        XCTAssertThrowsError(try NimoResourceRequest.decode(discoveryRequest(operation: "discover", capture: uuid, nonce: uuid, extraPair: ["peripheralSelection": NSNull()])))
    }
    @MainActor
    func testActualFixtureDiscoveryCannotAdmitManagerUntilSeparateArmAndPersistedDiscoveryReceipt() async throws {
        let discoveryId = "00000000-0000-4000-8000-000000000002"
        for persisted in [false, true] {
            let fixture = NimoResourceFixture()
            fixture.packageSeedDiscovery(name: "NIMO exact", capture: uuid, discoveryOperation: discoveryId, candidates: [(uuid, "NIMO exact")], persisted: persisted)
            XCTAssertNil(fixture.session)
            XCTAssertFalse(fixture.allowsManager("NIMO", name: "NIMO exact"))
            let status = try await fixture.packagePerform(discoveryRequest(operation: "status", capture: uuid, nonce: discoveryId))
            XCTAssertTrue(status["session"] is NSNull)
            let anchor = (status["capture"] as! [String: Any])["armedElapsedMs"] as! UInt64
            do {
                let armed = try await fixture.packagePerform(discoveryRequest(operation: "arm", capture: uuid, nonce: "00000000-0000-4000-8000-000000000003"))
                XCTAssertTrue(persisted)
                XCTAssertEqual(fixture.session?.pair.peripheralUuid, uuid)
                XCTAssertEqual((armed["capture"] as! [String: Any])["armedElapsedMs"] as? UInt64, anchor)
                XCTAssertTrue(fixture.allowsManager("NIMO", name: "NIMO exact"))
            } catch { XCTAssertFalse(persisted) }
        }
    }
    @MainActor
    func testActualFixtureDiscoveryOnlyCancelClosesObserverWithoutSessionOrFakeDisconnectAndForbidsLaterArm() async throws {
        let fixture = NimoResourceFixture(), discoveryId = "00000000-0000-4000-8000-000000000002"
        fixture.packageSeedDiscovery(name: "NIMO exact", capture: uuid, discoveryOperation: discoveryId, candidates: [(uuid, "NIMO exact")], persisted: true)
        let result = try await fixture.packagePerform(discoveryRequest(operation: "cancel", capture: uuid, nonce: discoveryId))
        XCTAssertNil(fixture.session)
        let release = result["release"] as! [String: Any]
        XCTAssertEqual(release["noTransport"] as? Bool, true)
        XCTAssertEqual(release["settled"] as? Bool, true)
        XCTAssertTrue(release["disconnectCallbackElapsedMs"] is NSNull)
        XCTAssertTrue(fixture.allowsManager("G2", name: "G2"))
        do { _ = try await fixture.packagePerform(discoveryRequest(operation: "arm", capture: uuid, nonce: "00000000-0000-4000-8000-000000000003")); XCTFail("cancelled discovery admitted arm") }
        catch { XCTAssertNil(fixture.session) }
    }
    private let uuid = "00000000-0000-4000-8000-000000000001"
    private final class Clock { var value: UInt64 = 100; func next() -> UInt64 { value += 1; return value } }
    private func fixture() -> (NimoResourceSession, NSObject, NSObject, Clock) {
        let clock = Clock(), owner = NSObject(), peer = NSObject()
        let model = NimoResourceSession(captureNonce: uuid, pair: NimoResourcePair(name: "NIMO test", peripheralUuid: uuid), now: clock.next)
        XCTAssertTrue(model.admit(owner, instanceId: uuid, name: "NIMO test"))
        return (model, owner, peer, clock)
    }
    @MainActor
    func testActualNimoReleaseRetiresPendingTimeAckWithoutRadioOrFalseHandshakeFailure() async {
        for cancel in [false, true] {
            for timeoutBeforeEntry in [false, true] {
                let result = await Nimo().packageExercisePendingTimeAck(cancel: cancel, timeoutBeforeEntry: timeoutBeforeEntry)
                XCTAssertTrue(result.errors.isEmpty)
                XCTAssertEqual(result.pendingAcks, 0)
                XCTAssertTrue(result.idle)
                XCTAssertFalse(result.ready)
                XCTAssertTrue(result.sameWriteEvidence)
                XCTAssertTrue(result.ackStillAbsent)
                XCTAssertTrue(result.noRadio)
                XCTAssertFalse(result.physicalClosure)
            }
        }
    }
    @MainActor
    func testActualNimoActiveTimeAckTimeoutRemainsFailure() async {
        let result = await Nimo().packageExercisePendingTimeAck(cancel: true, timeoutBeforeEntry: false, activeTimeout: true)
        XCTAssertTrue(result.errors.contains("handshake-failed"))
        XCTAssertFalse(result.ready)
        XCTAssertTrue(result.noRadio)
    }
    func testReleaseFenceDoesNotTurnHandshakeAbandonmentIntoCommandOrWriterProof() {
        let (model, owner, peer, _) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        model.transportConnected(owner, peer); model.observeTws(owner, connected: true)
        let command = model.beginTimeCommand(owner)!
        model.timeWriteStarted(owner, command: command)
        let started = model.timeWriteStartedElapsedMs
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: true, canvas: true))
        XCTAssertFalse(model.recordHandshakeFailure(owner))
        model.timeWriteCompleted(owner, command: command); model.timeAck(owner, command: command, status: 0)
        XCTAssertEqual(model.timeWriteStartedElapsedMs, started)
        XCTAssertNil(model.timeWriteCompletedElapsedMs)
        XCTAssertNil(model.timeAckElapsedMs)
        XCTAssertFalse(model.ready)
        XCTAssertFalse(model.commandsSettled)
        var producers = NimoResourceProducers(); producers.writerQueued = 1
        XCTAssertFalse(model.settled(producers: producers))
        XCTAssertTrue(model.errors.isEmpty)
    }
    func testForeignManagerCannotReplaceCaptureUntilOriginalClosure() {
        XCTAssertTrue(NimoResourceManagerState.allowsReplacement(fixtureEnabled: false, originalClosed: false))
        XCTAssertFalse(NimoResourceManagerState.allowsReplacement(fixtureEnabled: true, originalClosed: false))
        XCTAssertTrue(NimoResourceManagerState.allowsReplacement(fixtureEnabled: true, originalClosed: true))
    }
    func testFailedOriginalConnectionCanReleaseWithoutInventingDisconnect() {
        let (model, owner, peer, clock) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        model.connectionFailed(owner, NSObject(), receivedElapsedMs: clock.next())
        model.connectionFailed(owner, peer, receivedElapsedMs: model.startedElapsedMs! - 1)
        XCTAssertNil(model.connectionFailedElapsedMs)
        model.connectionFailed(owner, peer, receivedElapsedMs: clock.next())
        XCTAssertNotNil(model.connectionFailedElapsedMs)
        XCTAssertFalse(model.ready)
        XCTAssertFalse(model.settled(producers: NimoResourceProducers()))
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        XCTAssertTrue(model.settled(producers: NimoResourceProducers()))
        XCTAssertNil(model.disconnectCallbackElapsedMs)
        XCTAssertFalse(model.noTransport)
        XCTAssertNotNil(model.original)
        var producers = NimoResourceProducers(); producers.postedCallbacks = 1
        XCTAssertFalse(model.settled(producers: producers))
        model.transportConnected(owner, peer) // A contradictory late callback cannot preserve closure.
        XCTAssertFalse(model.settled(producers: NimoResourceProducers()))
        XCTAssertTrue(model.errors.contains("connect-after-failed-attempt"))
        let (connected, other, otherPeer, otherClock) = fixture()
        XCTAssertTrue(connected.beginTransport(other, peripheral: otherPeer, uuid: uuid))
        connected.transportConnected(other, otherPeer)
        connected.connectionFailed(other, otherPeer, receivedElapsedMs: otherClock.next())
        XCTAssertNil(connected.connectionFailedElapsedMs)
        XCTAssertTrue(connected.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        XCTAssertFalse(connected.settled(producers: NimoResourceProducers()))
        let (fenced, fencedOwner, fencedPeer, fencedClock) = fixture()
        XCTAssertTrue(fenced.beginTransport(fencedOwner, peripheral: fencedPeer, uuid: uuid))
        XCTAssertTrue(fenced.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        fenced.transportConnected(fencedOwner, fencedPeer)
        XCTAssertTrue(fenced.connected)
        fenced.connectionFailed(fencedOwner, fencedPeer, receivedElapsedMs: fencedClock.next())
        XCTAssertNil(fenced.connectionFailedElapsedMs)
        XCTAssertFalse(fenced.settled(producers: NimoResourceProducers()))
    }
    func testOrdinaryManagerCleanupPreservesVerifiedOriginalClosureButNotActiveCapture() {
        let (model, owner, _, _) = fixture()
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        model.proveNoTransport()
        let accepted = model.settled(producers: NimoResourceProducers())
        XCTAssertTrue(accepted)
        XCTAssertFalse(model.shouldRunOrdinaryDisconnect(owner, originalClosed: accepted))
        XCTAssertFalse(model.shouldRunOrdinaryDisconnect(owner, originalClosed: accepted))
        XCTAssertTrue(model.errors.isEmpty)
        XCTAssertTrue(model.settled(producers: NimoResourceProducers())) // Fresh status, not old bytes.
        XCTAssertTrue(NimoResourceManagerState.allowsReplacement(fixtureEnabled: true, originalClosed: model.settled(producers: NimoResourceProducers())))
        let (active, other, _, _) = fixture()
        XCTAssertTrue(active.shouldRunOrdinaryDisconnect(other, originalClosed: false))
        XCTAssertTrue(active.errors.contains("ordinary-disconnect-during-capture"))
        XCTAssertFalse(active.settled(producers: NimoResourceProducers()))
        let (failed, third, peer, clock) = fixture()
        XCTAssertTrue(failed.beginTransport(third, peripheral: peer, uuid: uuid))
        failed.connectionFailed(third, peer, receivedElapsedMs: clock.next())
        XCTAssertTrue(failed.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        XCTAssertTrue(failed.settled(producers: NimoResourceProducers()))
        failed.transportConnected(third, peer) // A late contradictory callback still invalidates closure.
        XCTAssertTrue(failed.shouldRunOrdinaryDisconnect(third, originalClosed: true))
        XCTAssertFalse(failed.settled(producers: NimoResourceProducers()))
    }
    func testManagerEntryRosterScopesOriginalNimoWithoutIgnoringItsCallbacks() {
        let entries = NimoResourceManagerEntries(), foreign = NimoResourceManagerEntries()
        let (model, owner, _, _) = fixture()
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false)); model.proveNoTransport()
        let nimo = entries.begin("NIMO")
        var producers = NimoResourceProducers(); producers.postedCallbacks = entries.originalNimo
        XCTAssertFalse(model.settled(producers: producers))
        let g2 = entries.begin("G2")
        XCTAssertEqual(entries.all, 2); XCTAssertEqual(entries.originalNimo, 1)
        foreign.end(nimo); XCTAssertEqual(entries.originalNimo, 1)
        entries.end(nimo); entries.end(nimo) // Exact one-shot ticket, never an early/duplicate decrement.
        producers.postedCallbacks = entries.originalNimo
        XCTAssertEqual(entries.all, 1); XCTAssertTrue(model.settled(producers: producers))
        XCTAssertFalse(model.shouldRunOrdinaryDisconnect(owner, originalClosed: true))
        entries.end(g2); XCTAssertEqual(entries.all, 0)
        producers.postedCallbacks = 1 // A late actual original callback still holds closure.
        XCTAssertFalse(model.settled(producers: producers))
    }
    func testOriginalClosureCannotClearReplacementManagerSharedState() {
        let (model, owner, _, _) = fixture()
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: false, mic: false, canvas: false))
        model.proveNoTransport()
        XCTAssertTrue(model.settled(producers: NimoResourceProducers()))
        let g2 = NSObject()
        var connected = true
        NimoResourceManagerState.publish(owner: owner, current: g2) { connected = false }
        XCTAssertTrue(connected)
        NimoResourceManagerState.publish(owner: owner, current: nil) { connected = false }
        XCTAssertTrue(connected)
        NimoResourceManagerState.publish(owner: owner, current: owner) { connected = false }
        XCTAssertFalse(connected)
    }
    func testQueuedOldNotificationsKeepReceiveTimeAndCannotSatisfyNewCommands() {
        let (model, owner, peer, clock) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        model.transportConnected(owner, peer)
        model.observeTws(owner, connected: true)
        let command = model.beginTimeCommand(owner)!
        let staleAck = clock.value
        model.timeWriteStarted(owner, command: command)
        model.timeAck(owner, command: command, status: 0, receivedElapsedMs: staleAck)
        XCTAssertNil(model.timeAckElapsedMs)
        let actualAck = clock.next()
        model.timeAck(owner, command: command, status: 0, receivedElapsedMs: actualAck)
        XCTAssertFalse(model.ready) // Real ACK may precede didWrite callback.
        model.timeWriteCompleted(owner, command: command)
        XCTAssertTrue(model.ready)
        XCTAssertEqual(model.timeAckElapsedMs, actualAck)
        let staleStop = clock.value
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: false, mic: true, canvas: true))
        model.micStopStarted(owner)
        model.micStopMarker(owner, receivedElapsedMs: staleStop)
        model.exitAcknowledged(owner, status: 0, receivedElapsedMs: staleStop)
        XCTAssertNil(model.micStopMarkerElapsedMs)
        XCTAssertNil(model.exitAckElapsedMs)
        let actualStop = clock.next()
        model.micStopMarker(owner, receivedElapsedMs: actualStop)
        model.micStopWritten(owner)
        XCTAssertEqual(model.micStopMarkerElapsedMs, actualStop)
    }
    func testArmAdmissionPinsOneObjectAndRejectsReplacementWrongNameAndWrongPeripheral() {
        let (model, owner, peer, _) = fixture()
        let admitted = model.admittedElapsedMs
        XCTAssertFalse(model.admit(NSObject(), instanceId: uuid, name: "NIMO test"))
        XCTAssertFalse(model.admit(owner, instanceId: uuid, name: "other"))
        XCTAssertEqual(model.admittedElapsedMs, admitted)
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: UUID().uuidString))
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        XCTAssertFalse(model.beginTransport(owner, peripheral: NSObject(), uuid: uuid))
    }
    func testReadinessRequiresOriginalConnectedTwsWrittenCommandAndStatusZeroAck() {
        let (model, owner, peer, _) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        XCTAssertNil(model.beginTimeCommand(owner))
        model.transportConnected(owner, peer)
        model.observeTws(NSObject(), connected: true)
        XCTAssertNil(model.beginTimeCommand(owner))
        model.observeTws(owner, connected: true)
        let command = model.beginTimeCommand(owner)!
        model.timeAck(owner, command: command, status: 0) // Before actual write start.
        XCTAssertNil(model.timeAckElapsedMs)
        model.timeWriteStarted(owner, command: command)
        model.timeAck(owner, command: command, status: 0) // Early ACK buffers until actual callback.
        XCTAssertFalse(model.ready)
        model.timeWriteCompleted(owner, command: "wrong")
        XCTAssertFalse(model.ready)
        model.timeWriteCompleted(owner, command: command)
        XCTAssertTrue(model.ready)
        let handshake = model.handshakeTwsElapsedMs
        model.observeTws(owner, connected: true)
        XCTAssertEqual(model.handshakeTwsElapsedMs, handshake)
        XCTAssertGreaterThan(model.twsObservedElapsedMs!, model.timeAckElapsedMs!)
        model.observeTws(owner, connected: false)
        XCTAssertFalse(model.ready)
    }
    func testNegativeAckAndReplacementCallbacksNeverEstablishReadiness() {
        let (model, owner, peer, _) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        model.transportConnected(owner, NSObject())
        XCTAssertFalse(model.connected)
        model.transportConnected(owner, peer); model.observeTws(owner, connected: true)
        let command = model.beginTimeCommand(owner)!
        model.timeWriteStarted(owner, command: command); model.timeWriteCompleted(owner, command: command)
        model.timeAck(owner, command: command, status: 2)
        XCTAssertFalse(model.ready)
    }
    func testReleaseRequiresRealOriginalCallbackEveryObligationAndActualProducerSettlement() {
        let (model, owner, peer, _) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid)); model.transportConnected(owner, peer)
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: false, mic: true, canvas: true))
        let start = model.releaseStartedElapsedMs
        XCTAssertFalse(model.beginRelease(nonce: UUID().uuidString, cancel: false, mic: false, canvas: false))
        XCTAssertEqual(model.releaseStartedElapsedMs, start)
        XCTAssertFalse(model.allowsEntry(owner)); XCTAssertNil(model.beginTimeCommand(owner))
        model.proveNoTransport(); XCTAssertFalse(model.noTransport)
        model.micStopMarker(owner) // Before actual stop write: ignored.
        XCTAssertNil(model.micStopMarkerElapsedMs)
        model.micStopStarted(owner); model.micStopMarker(owner); model.micStopWritten(owner)
        model.exitAcknowledged(owner, status: 7)
        XCTAssertFalse(model.commandsSettled)
        model.exitAcknowledged(owner, status: 0)
        XCTAssertTrue(model.commandsSettled)
        model.disconnectRequested(owner)
        XCTAssertFalse(model.settled(producers: NimoResourceProducers())) // cancel return/nil app ref is not closure.
        model.disconnected(owner, NSObject(), error: nil)
        XCTAssertNil(model.disconnectCallbackElapsedMs)
        model.disconnected(owner, peer, error: nil)
        var producers = NimoResourceProducers(); producers.encoderDelivery = 1
        XCTAssertFalse(model.settled(producers: producers))
        producers.encoderDelivery = 0; producers.writerActive = 1
        XCTAssertFalse(model.settled(producers: producers))
        producers.writerActive = 0; producers.reconnectTask = 1
        XCTAssertFalse(model.settled(producers: producers))
        XCTAssertTrue(model.settled(producers: NimoResourceProducers()))
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: false, mic: false, canvas: false))
        XCTAssertEqual(model.releaseStartedElapsedMs, start)
        XCTAssertTrue(model.micStopRequired); XCTAssertTrue(model.displayExitRequired)
    }
    func testGenZeroCancellationFencesAdmissionAndProducesExplicitNoTransport() {
        let (model, owner, _, _) = fixture()
        XCTAssertEqual(model.sessionDictionary()?["sessionGeneration"] as? UInt64, 0)
        XCTAssertTrue(model.sessionDictionary()?["startedElapsedMs"] is NSNull)
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        model.proveNoTransport()
        XCTAssertTrue(model.settled(producers: NimoResourceProducers()))
        XCTAssertFalse(model.admit(owner, instanceId: uuid, name: "NIMO test"))
        XCTAssertFalse(model.admit(NSObject(), instanceId: uuid, name: "NIMO test"))
    }
    func testDisconnectErrorOrUnrequestedDisconnectNeverProvesIdle() {
        for requested in [true, false] {
            let (model, owner, peer, _) = fixture()
            XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid))
            model.transportConnected(owner, peer)
            XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: false, mic: false, canvas: false))
            if requested { model.disconnectRequested(owner) }
            model.disconnected(owner, peer, error: "radio error")
            XCTAssertFalse(model.settled(producers: NimoResourceProducers()))
        }
    }
    func testReleaseDoesNotAdoptLateGenerationOrRewriteReadinessAndClockAnchors() {
        let (model, owner, peer, _) = fixture()
        XCTAssertTrue(model.beginTransport(owner, peripheral: peer, uuid: uuid)); model.transportConnected(owner, peer)
        model.observeTws(owner, connected: true); let command = model.beginTimeCommand(owner)!
        model.timeWriteStarted(owner, command: command); model.timeWriteCompleted(owner, command: command); model.timeAck(owner, command: command, status: 0)
        let observed = model.twsObservedElapsedMs, ack = model.timeAckElapsedMs
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        model.observeTws(owner, connected: false); model.timeAck(owner, command: command, status: 7)
        XCTAssertEqual(model.twsObservedElapsedMs, observed); XCTAssertEqual(model.timeAckElapsedMs, ack)
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        XCTAssertFalse(model.ready)
    }

    func testStrictTypedRequestRejectsPacketPathsUnknownFieldsAndMalformedOriginals() throws {
        let pair: [String: Any] = ["name": "NIMO test", "peripheralUuid": uuid]
        let process: [String: Any] = ["pid": 123, "instanceId": uuid]
        let original: [String: Any] = ["instanceId": uuid, "peripheralUuid": uuid, "sessionGeneration": 1]
        let valid: [String: Any] = ["version": 1, "operation": "arm", "requestNonce": uuid, "captureNonce": uuid,
            "planSha256": String(repeating: "a", count: 64), "grantSha256": String(repeating: "b", count: 64),
            "expectedProcess": process, "expectedPair": pair, "original": NSNull()]
        func encoded(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
        XCTAssertEqual(try NimoResourceRequest.decode(encoded(valid)).operation, .arm)
        for replacement: [String: Any] in [
            ["packet": "52010000"], ["path": "/tmp/other.json"], ["operation": "connect"],
            ["requestNonce": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"], ["version": 2], ["grantSha256": "unknown"],
            ["expectedPair": pair.merging(["bluetoothAddress": "00:11:22:33:44:55"]) { _, new in new }],
            ["expectedProcess": process.merging(["pid": true]) { _, new in new }],
            ["expectedPair": pair.merging(["name": String(repeating: "x", count: 129)]) { _, new in new }],
            ["original": original.merging(["sessionGeneration": 2]) { _, new in new }],
            ["original": original.merging(["command": "reset"]) { _, new in new }],
            ["original": original.merging(["instanceId": "replacement"]) { _, new in new }],
        ] {
            XCTAssertThrowsError(try NimoResourceRequest.decode(encoded(valid.merging(replacement) { _, new in new })))
        }
        XCTAssertThrowsError(try NimoResourceRequest.decode(Data(repeating: 32, count: 16_385)))
    }


    func testAdmissionPersistenceFailureRetainsOnlyCancelledOriginalAndNoTransportAuthority() {
        let clock = Clock(), owner = NSObject(), peer = NSObject()
        let model = NimoResourceSession(captureNonce: uuid, pair: NimoResourcePair(name: "NIMO test", peripheralUuid: uuid), now: clock.next)
        XCTAssertFalse(model.admit(owner, instanceId: uuid, name: "NIMO test", persist: { _ in
            XCTAssertNil(model.admittedElapsedMs)
            return false
        }))
        XCTAssertTrue(model.isOwner(owner)); XCTAssertTrue(model.cancelled)
        XCTAssertNil(model.admittedElapsedMs)
        XCTAssertFalse(model.allowsEntry(owner))
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: uuid))
        XCTAssertFalse(model.admit(NSObject(), instanceId: uuid, name: "NIMO test"))
        XCTAssertTrue(model.beginRelease(nonce: uuid, cancel: true, mic: false, canvas: false))
        model.proveNoTransport()
        XCTAssertFalse(model.settled(producers: NimoResourceProducers())) // Failed durable authority is not fabricated idle.
    }

    func testTransportPersistencePrecedesEffectAuthorityAndFailureCannotBeRetried() {
        let (model, owner, peer, _) = fixture()
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: uuid, persist: { proposed in
            XCTAssertNil(model.original); XCTAssertNil(model.startedElapsedMs)
            XCTAssertGreaterThan(proposed, model.admittedElapsedMs!)
            return false
        }))
        XCTAssertNil(model.original); XCTAssertNil(model.startedElapsedMs)
        XCTAssertTrue(model.cancelled)
        XCTAssertFalse(model.beginTransport(owner, peripheral: peer, uuid: uuid))
    }

}
