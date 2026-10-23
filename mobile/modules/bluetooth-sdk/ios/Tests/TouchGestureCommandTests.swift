@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class TouchGestureTransport: MentraLive {
    var respond: (([String: Any]) -> [[String: Any]])?
    var requestIds: [String] = []

    override func sendTouchGestureDefaultBehaviorEnabled(requestId: String, gesture: TouchGesture, enabled: Bool) throws {
        try sendTouchGestureDefaultCommand(requestId: requestId, gesture: gesture, enabled: enabled)
    }

    override func queueSend(_ data: Data, id _: String) {
        do {
            // K900: ##, type, two-byte length, JSON payload, $$.
            let payload = data.subdata(in: 5 ..< data.count - 2)
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            XCTAssertEqual(envelope["C"] as? String, "cs_tpdef")
            let body = try XCTUnwrap((envelope["B"] as? String)?.data(using: .utf8))
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            try requestIds.append(XCTUnwrap(command["request_id"] as? String))
            for response in respond?(command) ?? [] {
                try processReceivedData(JSONSerialization.data(withJSONObject: response))
            }
        } catch { XCTFail("K900 round trip failed: \(error)") }
    }
}

@MainActor
final class TouchGestureCommandTests: XCTestCase {
    func testEveryGestureRoundTripsBothStates() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = TouchGestureTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        defer { sdk.invalidate(); DeviceManager.shared.sgc = previous }
        for gesture in TouchGesture.allCases {
            for enabled in [false, true] {
                transport.respond = { command in
                    XCTAssertEqual(command["gesture"] as? String, gesture.rawValue)
                    XCTAssertEqual(command["enabled"] as? Bool, enabled)
                    let body: [String: Any] = ["type": "settings_ack", "setting": "touch_gesture_default", "status": "applied",
                                               "request_id": command["request_id"]!, "gesture": gesture.rawValue, "enabled": enabled]
                    var unrelated = body
                    unrelated["request_id"] = "another-request"
                    return [["C": "sr_tpdef", "B": unrelated], ["C": "sr_tpdef", "B": body]]
                }
                let ack = try await sdk.setTouchGestureDefaultBehaviorEnabled(gesture, enabled: enabled)
                XCTAssertEqual(ack.gesture, gesture)
                XCTAssertEqual(ack.enabled, enabled)
                XCTAssertEqual(ack.requestId, transport.requestIds.last)
            }
        }
        XCTAssertEqual(Set(transport.requestIds).count, 16)
    }

    func testFirmwareRejectionPropagatesThroughStringBody() async {
        let previous = DeviceManager.shared.sgc
        let transport = TouchGestureTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        defer { sdk.invalidate(); DeviceManager.shared.sgc = previous }
        transport.respond = { command in
            let body: [String: Any] = ["type": "settings_ack", "setting": "touch_gesture_default", "status": "error",
                                       "request_id": command["request_id"]!, "error_code": "invalid_touch_gesture_setting"]
            let encoded = try! JSONSerialization.data(withJSONObject: body)
            return [["C": "sr_tpdef", "B": String(data: encoded, encoding: .utf8)!]]
        }
        do {
            _ = try await sdk.setTouchGestureDefaultBehaviorEnabled(.doubleTap, enabled: false)
            XCTFail("Rejected firmware setting must throw")
        } catch let error as BluetoothSdkError { XCTAssertEqual(error.code, "invalid_touch_gesture_setting") }
        catch { XCTFail("Unexpected error: \(error)") }
    }

    func testUnsupportedDeviceRejects() async {
        let previous = DeviceManager.shared.sgc
        DeviceManager.shared.sgc = nil
        let sdk = MentraBluetoothSDK()
        defer { sdk.invalidate(); DeviceManager.shared.sgc = previous }
        do {
            _ = try await sdk.setTouchGestureDefaultBehaviorEnabled(.doubleTap, enabled: false)
            XCTFail("Unsupported device must throw")
        } catch let error as BluetoothSdkError { XCTAssertEqual(error.code, "unsupported_device") }
        catch { XCTFail("Unexpected error: \(error)") }
    }
}
