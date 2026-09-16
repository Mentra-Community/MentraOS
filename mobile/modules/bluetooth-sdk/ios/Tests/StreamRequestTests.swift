@testable import MentraBluetoothSDK
import XCTest

final class StreamRequestTests: XCTestCase {

    func testOmissionPreservesBuildDefaultInValues() {
        let request = StreamRequest(
            streamUrl: "https://example.com/whip",
            streamId: "s-1"
        )

        XCTAssertNil(request.telemetry)
        XCTAssertNil(request.values["telemetry"])
        XCTAssertNil(request.values["tl"])
    }

    func testInitFromValuesPreservesOmissionWhenKeyAbsent() {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "streamId": "s-1"
        ])

        XCTAssertNil(request.telemetry)
        XCTAssertNil(request.values["telemetry"])
    }

    func testForwardsExplicitTrueInValues() {
        let request = StreamRequest(
            streamUrl: "https://example.com/whip",
            streamId: "s-1",
            telemetry: true
        )

        XCTAssertEqual(request.telemetry, true)
        XCTAssertEqual(request.values["telemetry"] as? Bool, true)
    }

    func testInitFromValuesForwardsExplicitTrue() {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "streamId": "s-1",
            "telemetry": true
        ])

        XCTAssertEqual(request.telemetry, true)
        XCTAssertEqual(request.values["telemetry"] as? Bool, true)
    }

    func testForwardsExplicitFalseInValues() {
        let request = StreamRequest(
            streamUrl: "https://example.com/whip",
            streamId: "s-1",
            telemetry: false
        )

        XCTAssertEqual(request.telemetry, false)
        XCTAssertEqual(request.values["telemetry"] as? Bool, false)
    }

    func testInitFromValuesForwardsExplicitFalse() {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "streamId": "s-1",
            "telemetry": false
        ])

        XCTAssertEqual(request.telemetry, false)
        XCTAssertEqual(request.values["telemetry"] as? Bool, false)
    }

    func testInitFromValuesAcceptsCompactTlKeyWhenTelemetryAbsent() {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "tl": true
        ])

        XCTAssertEqual(request.telemetry, true)
        XCTAssertEqual(request.values["telemetry"] as? Bool, true)
    }

    func testInitFromValuesGivesTelemetryPrecedenceOverCompactTl() {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "telemetry": false,
            "tl": true
        ])

        XCTAssertEqual(request.telemetry, false)
        XCTAssertEqual(request.values["telemetry"] as? Bool, false)
    }

    func testFullStreamRequestSerializesAllFields() {
        let request = StreamRequest(
            streamUrl: "https://example.com/whip",
            streamId: "stream-123",
            sound: false,
            video: StreamVideoConfig(width: 1280, height: 720, bitrate: 2_000_000, fps: 15),
            audio: StreamAudioConfig(bitrate: 64000, sampleRate: 48000, echoCancellation: true),
            authToken: "bearer-token",
            telemetry: true
        )

        let values = request.values
        XCTAssertEqual(values["type"] as? String, "start_stream")
        XCTAssertEqual(values["streamUrl"] as? String, "https://example.com/whip")
        XCTAssertEqual(values["streamId"] as? String, "stream-123")
        XCTAssertEqual(values["sound"] as? Bool, false)
        XCTAssertEqual(values["authToken"] as? String, "bearer-token")
        XCTAssertEqual(values["telemetry"] as? Bool, true)
        XCTAssertNotNil(values["video"])
        XCTAssertNotNil(values["audio"])
    }
}
