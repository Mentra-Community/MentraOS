import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class AudioRouteObservationTests: XCTestCase {
    @MainActor
    func testInputsBecomingAvailableAfterNotificationAreReconciled() async {
        let center = NotificationCenter()
        let route = Notification.Name("test.audio.route")
        var inputAvailable = false
        var ready = false
        let initialRead = expectation(description: "Initial unavailable input observed")
        let changed = expectation(description: "Delayed input becomes ready without another event")
        var firstRead = true
        let observer = AudioRouteObservation(center: center, names: [route]) {
            if firstRead {
                firstRead = false
                initialRead.fulfill()
            }
            if inputAvailable, !ready { changed.fulfill() }
            ready = inputAvailable
        }

        center.post(name: route, object: nil)
        await fulfillment(of: [initialRead], timeout: 2)
        XCTAssertFalse(ready)
        inputAvailable = true
        await fulfillment(of: [changed], timeout: 1)
        XCTAssertTrue(ready)
        withExtendedLifetime(observer) {}
    }

    @MainActor
    func testInitiallyReadyInputCanDisappearDuringSettling() async {
        var inputAvailable = true
        var ready = false
        let disappeared = expectation(description: "Input removal observed during settling")
        let observer = AudioRouteObservation(names: [], settlingDelays: [0.05, 0.05]) {
            if ready, !inputAvailable { disappeared.fulfill() }
            ready = inputAvailable
        }
        observer.refresh()
        XCTAssertTrue(ready)
        inputAvailable = false
        await fulfillment(of: [disappeared], timeout: 2)
        XCTAssertFalse(ready)
        withExtendedLifetime(observer) {}
    }

    @MainActor
    func testDeviceChangeReplacesPendingChecksAndReadsOnlyCurrentTarget() async {
        var target = "first"
        var availableInputs = Set<String>()
        var observations: [(String, Bool)] = []
        var secondChecks = 0
        let settled = expectation(description: "Replacement window completed")
        let observer = AudioRouteObservation(names: [], settlingDelays: [0.05, 0.05, 0.1]) {
            observations.append((target, availableInputs.contains(target)))
            if target == "second" {
                secondChecks += 1
                if secondChecks == 2 {
                    // The old target is available, but its readiness must not leak.
                    XCTAssertFalse(observations.contains { $0.1 })
                    availableInputs.insert("second")
                }
                if secondChecks == 4 { settled.fulfill() }
            }
        }
        observer.refresh()
        target = "second"
        observer.refresh() // Same entry point used by DeviceStore's device_name change.
        availableInputs.insert("first")
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertEqual(observations.filter { $0.0 == "first" }.count, 1)
        XCTAssertEqual(observations.filter { $0.0 == "second" }.count, 4)
        XCTAssertEqual(observations.last?.0, "second")
        XCTAssertEqual(observations.last?.1, true)
        withExtendedLifetime(observer) {}
    }

    @MainActor
    func testUnavailableInputStopsRecheckingAfterBoundedWindow() async {
        var checks = 0
        let settled = expectation(description: "Immediate read and two scheduled rechecks completed")
        let extraCheck = expectation(description: "No rechecks beyond the configured window")
        extraCheck.isInverted = true
        let observer = AudioRouteObservation(names: [], settlingDelays: [0.02, 0.02]) {
            checks += 1
            if checks == 3 { settled.fulfill() }
            if checks > 3 { extraCheck.fulfill() }
        }
        observer.refresh()
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertEqual(checks, 3)
        await fulfillment(of: [extraCheck], timeout: 0.1)
        XCTAssertEqual(checks, 3)
        withExtendedLifetime(observer) {}
    }

    @MainActor
    func testReleasingObserverCancelsPendingRechecks() async throws {
        var checks = 0
        var observer: AudioRouteObservation? = AudioRouteObservation(names: [], settlingDelays: [0.02]) {
            checks += 1
        }
        observer?.refresh()
        XCTAssertEqual(checks, 1)
        observer = nil
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(checks, 1)
    }

    func testObservesRouteAndForegroundWithoutStartingAMicrophone() async {
        let center = NotificationCenter()
        let route = Notification.Name("test.audio.route")
        let foreground = Notification.Name("test.audio.foreground")
        let changed = expectation(description: "Both readiness events delivered")
        changed.expectedFulfillmentCount = 2
        let observer = AudioRouteObservation(center: center, names: [route, foreground]) {
            XCTAssertTrue(Thread.isMainThread)
            changed.fulfill()
        }
        center.post(name: route, object: nil)
        center.post(name: foreground, object: nil)
        await fulfillment(of: [changed], timeout: 1)
        withExtendedLifetime(observer) {}
    }

    func testReleasingObserverStopsReadinessCallbacks() async {
        let center = NotificationCenter()
        let route = Notification.Name("test.audio.route")
        let changed = expectation(description: "Released observer is silent")
        changed.isInverted = true
        var observer: AudioRouteObservation? = AudioRouteObservation(center: center, names: [route]) {
            changed.fulfill()
        }
        XCTAssertNotNil(observer)
        observer = nil
        center.post(name: route, object: nil)
        await fulfillment(of: [changed], timeout: 0.1)
    }
}
