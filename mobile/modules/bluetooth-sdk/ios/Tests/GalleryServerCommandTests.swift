@testable import MentraBluetoothSDK
import XCTest

/// Replace only the radio handoff; exercise the public SDK, device dispatch,
/// command serialization, receive parser, event bridge, and pending request resolver.
@MainActor
private final class GalleryCommandTransport: MentraLive {
    var respond: (([String: Any]) -> [[String: Any]])?
    var requestIds: [String] = []

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        XCTAssertEqual(jsonOriginal["type"] as? String, "set_gallery_server_enabled")
        XCTAssertTrue(wakeUp)
        XCTAssertTrue(requireAck)
        do {
            let bytes = try JSONSerialization.data(withJSONObject: jsonOriginal)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            try requestIds.append(XCTUnwrap(command["request_id"] as? String))
            for response in respond?(command) ?? [] {
                try processReceivedData(JSONSerialization.data(withJSONObject: response))
            }
        } catch {
            XCTFail("Could not replay gallery command: \(error)")
        }
    }
}

@MainActor
final class GalleryServerCommandTests: XCTestCase {
    func testEnableOfflineEnableAndDisableRoundTripThroughNativeBridge() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = GalleryCommandTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        defer {
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }

        for (enabled, listening) in [(true, true), (true, false), (false, false)] {
            transport.respond = { command in
                XCTAssertEqual(command["enabled"] as? Bool, enabled)
                var response: [String: Any] = [
                    "type": "settings_ack", "setting": "gallery_server", "status": "applied",
                    "request_id": command["request_id"]!, "timestamp": 123,
                    "enabled": enabled, "listening": listening,
                ]
                if listening { response["url"] = "http://10.1.2.3:8089" }
                // A response to another request must not resolve this call.
                var unrelated = response
                unrelated["request_id"] = "unrelated-request"
                unrelated["enabled"] = !enabled
                return [unrelated, response]
            }
            let ack = try await sdk.setGalleryServerEnabled(enabled)
            XCTAssertEqual(ack.enabled, enabled)
            XCTAssertEqual(ack.listening, listening)
            XCTAssertEqual(ack.url, listening ? "http://10.1.2.3:8089" : nil)
            XCTAssertEqual(ack.requestId, transport.requestIds.last)
        }
        XCTAssertEqual(Set(transport.requestIds).count, 3)
    }

    func testStorageErrorRejectsThePublicSdkRequest() async {
        let previous = DeviceManager.shared.sgc
        let transport = GalleryCommandTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        defer {
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }
        transport.respond = { command in
            [["type": "settings_ack", "setting": "gallery_server", "status": "error",
              "request_id": command["request_id"]!, "error_code": "settings_unavailable",
              "error_message": "Could not persist the gallery server setting."]]
        }
        do {
            _ = try await sdk.setGalleryServerEnabled(true)
            XCTFail("A failed save must reject the SDK request")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "settings_unavailable")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
}
