@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class WifiAdbRecordingLive: MentraLive {
    var ready = true
    var accepts = true
    var queued: [Bool] = []
    override var wifiAdbLinkReady: Bool { ready }
    override func enqueueWifiAdbState(_ enabled: Bool) -> Bool {
        if accepts { queued.append(enabled) }
        return accepts
    }
}

@MainActor
final class WifiAdbDispatchTests: XCTestCase {
    let first = "AA:BB:CC:DD:EE:01"
    let second = "AA:BB:CC:DD:EE:02"

    func testRetargetBeforeNativeDispatchCannotQueueForTheOtherPair() throws {
        let manager = DeviceManager()
        defer { manager.sgc = nil; manager.cleanup() }
        let old = WifiAdbRecordingLive()
        old.recordWifiAdbPeerIdentity(first)
        let replacement = WifiAdbRecordingLive()
        replacement.recordWifiAdbPeerIdentity(second)
        manager.sgc = old
        // The JS request still names first after the native selection changed.
        manager.sgc = replacement
        XCTAssertThrowsError(try manager.setWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(old.queued, [])
        XCTAssertEqual(replacement.queued, [])
        try manager.setWifiAdbState(false, expectedBluetoothMac: second)
        XCTAssertEqual(replacement.queued, [false])
    }

    func testMissingSessionIdentityDisconnectedAndSuffixInputsQueueNothing() {
        let live = WifiAdbRecordingLive()
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        live.recordWifiAdbPeerIdentity(first)
        for invalid in ["EE:01", first + ":00", " " + first, second] {
            XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: invalid))
        }
        live.ready = false
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(live.queued, [])
    }

    func testRejectedQueueDoesNotResolveAsSuccessfulDispatch() {
        let live = WifiAdbRecordingLive()
        live.recordWifiAdbPeerIdentity(first)
        live.accepts = false
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(live.queued, [])
    }
}
