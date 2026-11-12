@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class WifiAdbRecordingLive: MentraLive {
    var ready = true
    var accepts = true
    var beforeEnqueue: (() -> Void)?
    override var wifiAdbLinkReady: Bool { ready }
    override func enqueueWifiAdbState(_ enabled: Bool) -> Bool {
        guard accepts else { return false }
        beforeEnqueue?()
        return super.enqueueWifiAdbState(enabled)
    }
}

@MainActor
final class WifiAdbDispatchTests: XCTestCase {
    let first = "AA:BB:CC:DD:EE:01"
    let second = "AA:BB:CC:DD:EE:02"

    func frame(_ mac: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": "version_info", "bt_mac_address": mac, "build_number": "0"])
    }
    @discardableResult func receive(_ live: MentraLive, source: NSObject, mac: String) throws -> MentraLiveNotificationIngress.Token {
        let token = try XCTUnwrap(live.beginBleNotificationSession(source: source))
        live.receiveBleNotification(try frame(mac), token: token)
        return token
    }

    func testRetargetBeforeNativeDispatchCannotQueueForTheOtherPair() throws {
        let manager = DeviceManager()
        let old = WifiAdbRecordingLive(), replacement = WifiAdbRecordingLive()
        defer { manager.sgc = nil; manager.cleanup(); old.cleanup(); replacement.cleanup() }
        try receive(old, source: NSObject(), mac: first)
        try receive(replacement, source: NSObject(), mac: second)
        manager.sgc = old
        manager.sgc = replacement
        XCTAssertThrowsError(try manager.setWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(old.pendingBleCommandCount, 0)
        XCTAssertEqual(replacement.pendingBleCommandCount, 0)
        try manager.setWifiAdbState(false, expectedBluetoothMac: second)
        XCTAssertEqual(replacement.pendingBleCommandCount, 1)
    }

    func testDelayedOldNotificationCannotRestoreIdentityAfterReconnectIncludingSamePeripheral() throws {
        for samePeripheral in [false, true] {
            let live = WifiAdbRecordingLive(), oldSource = NSObject()
            defer { live.cleanup() }
            let oldToken = try receive(live, source: oldSource, mac: first)
            live.endBleNotificationSession()
            let newSource = samePeripheral ? oldSource : NSObject()
            let newToken = try XCTUnwrap(live.beginBleNotificationSession(source: newSource))
            live.receiveBleNotification(try frame(first), token: oldToken)
            XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
            live.receiveBleNotification(try frame(second), token: newToken)
            live.receiveBleNotification(try frame(first), token: oldToken)
            XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
            try live.sendWifiAdbState(false, expectedBluetoothMac: second)
            XCTAssertEqual(live.pendingBleCommandCount, 1)
        }
    }

    func testIngressCapturesSourceAndEpochBeforeTheActorHop() throws {
        let ingress = MentraLiveNotificationIngress(), first = NSObject(), second = NSObject()
        let old = try XCTUnwrap(ingress.begin(first))
        XCTAssertEqual(ingress.capture(first), old)
        _ = ingress.begin(second)
        XCTAssertNil(ingress.capture(first))
        XCTAssertFalse(ingress.current(old))
    }

    func testNativeOnlyLoggingAndActualQueueRejectSynchronousDelegateReset() throws {
        let live = WifiAdbRecordingLive(), source = NSObject()
        defer { live.cleanup() }
        try receive(live, source: source, mac: first)
        var logs = 0
        let sink = Bridge.addEventSink { event, _ in
            guard event == "log" else { return }
            MainActor.assumeIsolated {
                logs += 1
                live.ready = false
                live.endBleNotificationSession()
            }
        }
        defer { Bridge.removeEventSink(sink) }
        try live.sendWifiAdbState(true, expectedBluetoothMac: first)
        XCTAssertEqual(logs, 0) // real framing/queue insertion never invokes the public log sink
        XCTAssertEqual(live.pendingBleCommandCount, 1)
        // Simulate reentry at the former public-log boundary, retaining real framing and enqueue.
        live.beforeEnqueue = { Bridge.log("test synchronous reset") }
        XCTAssertThrowsError(try live.sendWifiAdbState(false, expectedBluetoothMac: first))
        XCTAssertEqual(logs, 1)
        XCTAssertEqual(live.pendingBleCommandCount, 0) // no newly stamped command entered the reset epoch
    }

    func testMissingSessionIdentityDisconnectedAndSuffixInputsQueueNothing() throws {
        let live = WifiAdbRecordingLive()
        defer { live.cleanup() }
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        try receive(live, source: NSObject(), mac: first)
        for invalid in ["EE:01", first + ":00", " " + first, second] {
            XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: invalid))
        }
        live.ready = false
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(live.pendingBleCommandCount, 0)
    }

    func testRejectedQueueDoesNotResolveAsSuccessfulDispatch() throws {
        let live = WifiAdbRecordingLive()
        defer { live.cleanup() }
        try receive(live, source: NSObject(), mac: first)
        live.accepts = false
        XCTAssertThrowsError(try live.sendWifiAdbState(true, expectedBluetoothMac: first))
        XCTAssertEqual(live.pendingBleCommandCount, 0)
    }
}
