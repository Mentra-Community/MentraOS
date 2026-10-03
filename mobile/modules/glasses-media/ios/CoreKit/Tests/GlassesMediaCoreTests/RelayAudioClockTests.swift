import Foundation
@testable import GlassesMediaCore
import XCTest

final class RelayAudioClockTests: XCTestCase {
    func testStopWaitsForInFlightRenderAndResourceRelease() {
        let clock = RelayAudioClock()
        let rendering = DispatchSemaphore(value: 0)
        let releaseRender = DispatchSemaphore(value: 0)
        let cleaned = DispatchSemaphore(value: 0)
        let stopped = DispatchSemaphore(value: 0)
        clock.start(render: { _ in rendering.signal(); releaseRender.wait() }, finish: { cleaned.signal() })
        clock.setEnabled(true)
        XCTAssertEqual(rendering.wait(timeout: .now() + 1), .success)
        DispatchQueue.global().async { clock.stop(); stopped.signal() }
        XCTAssertEqual(stopped.wait(timeout: .now() + 0.03), .timedOut)
        releaseRender.signal()
        XCTAssertEqual(stopped.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(cleaned.wait(timeout: .now()), .success)
        clock.stop() // Repeated native and owner shutdown is safe.
    }

    func testStopBeforeRecordingStillReleasesWorkerResources() {
        let clock = RelayAudioClock()
        let cleaned = DispatchSemaphore(value: 0)
        clock.start(render: { _ in XCTFail("Inactive audio must not render") }, finish: { cleaned.signal() })
        clock.stop()
        XCTAssertEqual(cleaned.wait(timeout: .now()), .success)
        clock.start(render: { _ in XCTFail("Reinitialized audio must start inactive") })
        clock.stop()
    }
}
