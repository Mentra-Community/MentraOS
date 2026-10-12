@testable import MentraBluetoothSDK
import XCTest

/// Replace the radio handoff while retaining public SDK dispatch and response handling.
@MainActor
private final class VideoRecordingCommandTransport: MentraLive {
    var commands: [[String: Any]] = []

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: jsonOriginal)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let type = try XCTUnwrap(command["type"] as? String)
            let requestId = try XCTUnwrap(command["requestId"] as? String)
            commands.append(command)
            XCTAssertTrue(wakeUp, "\(type) must wake the glasses before ASG can handle it")
            XCTAssertTrue(requireAck)

            let statuses = [
                "start_video_recording": "recording_started",
                "get_video_recording_status": "recording_status",
                "stop_video_recording": "recording_stopped",
            ]
            let status = try XCTUnwrap(statuses[type])
            let response: [String: Any] = [
                "type": "video_recording_status", "requestId": requestId,
                "status": status, "success": true,
            ]
            try processReceivedData(JSONSerialization.data(withJSONObject: response))
        } catch {
            XCTFail("Could not replay video recording command: \(error)")
        }
    }
}

@MainActor
final class VideoRecordingCommandTests: XCTestCase {
    func testStartStatusAndStopWakeGlassesThroughPublicSDK() async throws {
        let previous = DeviceManager.shared.sgc
        let store = DeviceStore.shared.store
        let savedConnected = store.getCategory("glasses")["connected"]
        let transport = VideoRecordingCommandTransport()
        transport.connectionState = ConnTypes.CONNECTED
        DeviceManager.shared.sgc = transport
        DeviceStore.shared.apply("glasses", "connected", true)
        let sdk = MentraBluetoothSDK()
        defer {
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
            if let savedConnected {
                store.set("glasses", "connected", savedConnected)
            } else {
                store.remove("glasses", "connected")
            }
        }

        let requestId = "idle-recording"
        let started = try await sdk.startVideoRecording(VideoRecordingRequest(
            requestId: requestId, save: true, sound: false,
            width: 1280, height: 720, fps: 30, maxRecordingTimeMinutes: 2
        ))
        XCTAssertEqual(started.status, "recording_started")
        XCTAssertEqual(started.requestId, requestId)
        let start = try XCTUnwrap(transport.commands.last)
        XCTAssertEqual(start["save"] as? Bool, true)
        XCTAssertEqual(start["sound"] as? Bool, false)
        XCTAssertEqual(start["settings"] as? [String: Int], ["width": 1280, "height": 720, "fps": 30])
        XCTAssertEqual(start["maxRecordingTimeMinutes"] as? Int, 2)

        let status = try await sdk.queryVideoRecordingStatus(requestId: requestId)
        XCTAssertEqual(status.status, "recording_status")
        XCTAssertEqual(status.requestId, requestId)

        let stopped = try await sdk.stopVideoRecording(requestId: requestId)
        XCTAssertEqual(stopped.status, "recording_stopped")
        XCTAssertEqual(stopped.requestId, requestId)
        XCTAssertEqual(transport.commands.compactMap { $0["type"] as? String }, [
            "start_video_recording", "get_video_recording_status", "stop_video_recording",
        ])
    }
}
