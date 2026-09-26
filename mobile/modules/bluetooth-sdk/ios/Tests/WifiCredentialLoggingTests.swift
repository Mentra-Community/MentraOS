@testable import MentraBluetoothSDK
import XCTest

/// Captures packed BLE writes instead of sending them, so the real device dispatch,
/// command serialization and transport logging run without a radio.
@MainActor
private final class CapturingMentraLive: MentraLive {
    var writes: [Data] = []

    override func queueSend(_ data: Data, id _: String, trace _: BleWriteTrace?) {
        writes.append(data)
    }
}

@MainActor
final class WifiCredentialLoggingTests: XCTestCase {
    func testWifiCredentialsReachTheBleQueueWithoutBeingLogged() {
        let ssid = "synthetic-\(UUID().uuidString)"
        let password = UUID().uuidString
        var logs: [String] = []
        let sink = Bridge.addEventSink { event, body in
            if event == "log", let message = body["message"] as? String {
                logs.append(message)
            }
        }
        defer { Bridge.removeEventSink(sink) }
        let manager = DeviceManager()
        let live = CapturingMentraLive()
        manager.sgc = live

        manager.sendWifiCredentials(ssid, password)

        XCTAssertFalse(logs.contains { $0.contains(password) }, "password logged")
        XCTAssertTrue(logs.contains("MAN: Sending wifi credentials: \(ssid)"))
        XCTAssertTrue(logs.contains("LIVE: Sending data to glasses: <set_wifi_credentials with credentials omitted>"))
        // The glasses still receive the unchanged credentials.
        let wire = live.writes.map { String(decoding: $0, as: UTF8.self) }.joined()
        XCTAssertTrue(wire.contains("set_wifi_credentials"))
        XCTAssertTrue(wire.contains(ssid))
        XCTAssertTrue(wire.contains(password))
    }
}
