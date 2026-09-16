import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class AudioRouteObservationTests: XCTestCase {
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
