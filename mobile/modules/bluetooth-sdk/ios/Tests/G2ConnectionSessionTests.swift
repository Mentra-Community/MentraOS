@testable import MentraBluetoothSDK
import XCTest

final class G2ConnectionSessionTests: XCTestCase {
    func testEitherArmAloneCannotStartAuthenticationOrBecomeReady() {
        for side in G2ConnectionSession.Side.allCases {
            var session = G2ConnectionSession()
            session.initialize(side)
            XCTAssertNil(session.beginAuthentication())
            session.authenticated(side, success: true)
            session.completeSetup(generation: session.generation)
            XCTAssertFalse(session.isReady)
        }
    }

    func testReadinessWaitsForBothAuthenticationResponsesAndCompletedSetup() throws {
        for completeSetupFirst in [false, true] {
            var session = G2ConnectionSession()
            session.initialize(.right)
            session.initialize(.left)
            let generation = try XCTUnwrap(session.beginAuthentication())
            XCTAssertNil(session.beginAuthentication(), "Duplicate service callbacks must not restart setup")
            if completeSetupFirst { session.completeSetup(generation: generation) }
            session.authenticated(.left, success: true)
            session.authenticated(.right, success: false)
            XCTAssertFalse(session.isReady)
            session.authenticated(.right, success: true)
            XCTAssertEqual(session.isReady, completeSetupFirst)
            session.completeSetup(generation: generation)
            XCTAssertTrue(session.isReady)
        }
    }

    func testDisconnectRetiresAuthenticationAndSuspendedSetup() throws {
        var session = G2ConnectionSession()
        session.initialize(.left)
        session.initialize(.right)
        let oldGeneration = try XCTUnwrap(session.beginAuthentication())
        session.authenticated(.left, success: true)
        session.reset()
        session.authenticated(.right, success: true)
        session.completeSetup(generation: oldGeneration)
        XCTAssertFalse(session.isReady)

        session.initialize(.left)
        session.initialize(.right)
        let newGeneration = try XCTUnwrap(session.beginAuthentication())
        session.authenticated(.left, success: true)
        session.authenticated(.right, success: true)
        session.completeSetup(generation: oldGeneration)
        XCTAssertFalse(session.isReady, "Old setup cannot complete the replacement attempt")
        session.completeSetup(generation: newGeneration)
        XCTAssertTrue(session.isReady)
    }

    func testAttemptDeadlineCoversBothPartialPairsAndIncompleteAuthentication() throws {
        for sides: [G2ConnectionSession.Side] in [[], [.left], [.right], [.left, .right]] {
            var session = G2ConnectionSession()
            for side in sides {
                session.initialize(side)
            }
            _ = session.beginAuthentication()
            let attempt = session.generation
            XCTAssertTrue(session.needsRecovery(attempt: attempt))
            session.reset()
            XCTAssertFalse(session.needsRecovery(attempt: attempt), "A retired deadline cannot reset a new attempt")
        }
        var ready = G2ConnectionSession()
        ready.initialize(.left)
        ready.initialize(.right)
        let attempt = try XCTUnwrap(ready.beginAuthentication())
        ready.authenticated(.left, success: true)
        ready.authenticated(.right, success: true)
        ready.completeSetup(generation: attempt)
        XCTAssertFalse(ready.needsRecovery(attempt: attempt))
    }

    func testCachedArmsCanReconnectIndependentlyWithoutAdvertisements() {
        let left = UUID(), right = UUID()
        XCTAssertEqual(target(left, left: left), .left)
        XCTAssertEqual(target(right, right: right), .right)
        XCTAssertNil(target(UUID(), left: left, right: right))
        XCTAssertNil(target(right, left: right, right: right), "Ambiguous cache must not bind one arm twice")
    }

    func testOnlySelectedSerialCanFillTheMissingArm() {
        let id = UUID()
        XCTAssertEqual(target(id, name: "Even G2_32_L_123456", serial: "S211SELECTED"), .left)
        XCTAssertNil(target(id, name: "Even G2_32_L_123456", serial: "S211OTHER"))
        XCTAssertNil(target(id, name: "Even G2_32_R_123456"))
        XCTAssertNil(target(id, right: id, searchID: "NOT_SET"))
        XCTAssertNil(target(id, right: id, searchID: ""))
    }

    private func target(
        _ id: UUID, name: String? = nil, serial: String? = nil,
        left: UUID? = nil, right: UUID? = nil, searchID: String = "S211SELECTED"
    ) -> G2ConnectionSession.Side? {
        G2ConnectionTarget.side(identifier: id, name: name, advertisedSerial: serial,
                                searchID: searchID, leftUUID: left, rightUUID: right)
    }
}

@MainActor
final class G2PrematureReadinessTests: XCTestCase {
    func testSystemExitAndTouchBeforePairInitializationDoNotPublishReady() {
        let store = DeviceStore.shared.store
        let connected = store.get("glasses", "connected")
        let booted = store.get("glasses", "fullyBooted")
        defer {
            if let connected { store.set("glasses", "connected", connected) }
            if let booted { store.set("glasses", "fullyBooted", booted) }
        }
        store.set("glasses", "connected", false)
        store.set("glasses", "fullyBooted", false)
        let g2 = G2()
        // SendDeviceEvent.SysEvent { eventType: systemExit }, as observed on the right arm.
        g2.handleTouchEvent(Data([0x1A, 0x02, 0x08, 0x07]))
        XCTAssertEqual(store.get("glasses", "connected") as? Bool, false)
        XCTAssertEqual(store.get("glasses", "fullyBooted") as? Bool, false)
        g2.handleTouchEvent(Data([0x1A, 0x02, 0x08, 0x00]))
        XCTAssertEqual(store.get("glasses", "connected") as? Bool, false)
        XCTAssertEqual(store.get("glasses", "fullyBooted") as? Bool, false)
    }
}

final class G2PartialConnectionTests: XCTestCase {
    func testEitherPartialLinkStaysQuietForThreeSeconds() {
        for leftConnected in [false, true] {
            var progress = G2PartialConnection()
            progress.update(leftConnected: leftConnected, rightConnected: !leftConnected, now: 10)
            XCTAssertNil(progress.visibleMissingSide(now: 10))
            XCTAssertNil(progress.visibleMissingSide(now: 12.999))
            // Duplicate observations must not restart the grace period.
            progress.update(leftConnected: leftConnected, rightConnected: !leftConnected, now: 12)
            XCTAssertEqual(progress.visibleMissingSide(now: 13), leftConnected ? .right : .left)
            XCTAssertEqual(progress.timeoutError, leftConnected ? "errors:g2RightArmUnavailable" : "errors:g2LeftArmUnavailable")
        }
    }

    func testNormalSequentialPairingAndDisconnectedStateNeverShowMissingArm() {
        var progress = G2PartialConnection()
        progress.update(leftConnected: false, rightConnected: true, now: 10)
        progress.update(leftConnected: true, rightConnected: true, now: 12)
        XCTAssertNil(progress.visibleMissingSide(now: 15))
        progress.update(leftConnected: false, rightConnected: false, now: 16)
        XCTAssertNil(progress.visibleMissingSide(now: 20))
        XCTAssertEqual(progress.timeoutError, "errors:g2ConnectionTimedOut")
    }

    func testPeerArrivalClearsVisibleNoticeAndNewPartialLinkGetsOwnGracePeriod() {
        var progress = G2PartialConnection()
        progress.update(leftConnected: true, rightConnected: false, now: 10)
        XCTAssertEqual(progress.visibleMissingSide(now: 13), .right)
        progress.update(leftConnected: true, rightConnected: true, now: 14)
        XCTAssertNil(progress.visibleMissingSide(now: 14))
        progress.update(leftConnected: false, rightConnected: true, now: 15)
        XCTAssertNil(progress.visibleMissingSide(now: 17))
        XCTAssertEqual(progress.visibleMissingSide(now: 18), .left)
        progress = G2PartialConnection()
        XCTAssertNil(progress.visibleMissingSide(now: 100))
    }

    func testStatusSnapshotAndUpdateCarryNoticeAndDisconnectClearsIt() throws {
        let status = GlassesStatus(values: ["g2MissingArm": "left"])
        XCTAssertEqual(status.dictionary["g2MissingArm"] as? String, "left")
        XCTAssertEqual(GlassesStatusUpdate(values: ["g2MissingArm": "right"]).dictionary["g2MissingArm"] as? String, "right")
        let disconnected = status.disconnected().dictionary
        XCTAssertTrue(disconnected["g2MissingArm"] is NSNull)
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: disconnected))
    }
}
