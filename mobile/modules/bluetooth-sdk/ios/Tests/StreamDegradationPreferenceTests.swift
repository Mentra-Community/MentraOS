@testable import MentraBluetoothSDK
import XCTest

final class StreamDegradationPreferenceTests: XCTestCase {
    func testPreferenceSurvivesRequestBridgeAndSerialization() throws {
        for preference in ["MAINTAIN_FRAMERATE", "MAINTAIN_RESOLUTION", "BALANCED", "DISABLED"] {
            let request = StreamRequest(values: [
                "streamUrl": "https://example.com/whip",
                "video": ["fps": 5, "degradationPreference": preference],
            ])
            XCTAssertEqual(request.video?.degradationPreference, preference)
            let wireVideo = try XCTUnwrap(request.values["video"] as? [String: Any])
            XCTAssertEqual(wireVideo["degradationPreference"] as? String, preference)
            XCTAssertEqual(wireVideo["frameRate"] as? Int, 5)
            XCTAssertEqual(StreamVideoConfig(degradationPreference: preference).dictionary["degradationPreference"] as? String, preference)
        }
    }

    func testOmissionPreservesGlassesDefault() throws {
        let request = StreamRequest(values: [
            "streamUrl": "https://example.com/whip",
            "video": ["fps": 5],
        ])
        XCTAssertNil(request.video?.degradationPreference)
        let wireVideo = try XCTUnwrap(request.values["video"] as? [String: Any])
        XCTAssertNil(wireVideo["degradationPreference"])
        XCTAssertNil(StreamVideoConfig().dictionary["degradationPreference"])
    }

    func testCompactKeyIsAcceptedAndFullKeyWins() throws {
        let compact = try XCTUnwrap(StreamVideoConfig(values: ["dp": "MAINTAIN_RESOLUTION"]))
        XCTAssertEqual(compact.dictionary["degradationPreference"] as? String, "MAINTAIN_RESOLUTION")
        let full = try XCTUnwrap(StreamVideoConfig(values: [
            "degradationPreference": "BALANCED", "dp": "DISABLED",
        ]))
        XCTAssertEqual(full.dictionary["degradationPreference"] as? String, "BALANCED")
    }

    func testStatusBridgePreservesAppliedPreferenceAndLegacyOmission() throws {
        for preference: String? in [nil, "MAINTAIN_RESOLUTION"] {
            var video: [String: Any] = [
                "width": 1920, "height": 1080, "bitrate": 2_500_000, "fps": 5.0,
            ]
            if let preference { video["degradationPreference"] = preference }
            let event = StreamStatusEvent(values: [
                "status": "streaming",
                "resolvedConfig": ["transport": "whip", "video": video],
            ])
            XCTAssertEqual(event.resolvedConfig?.video?.degradationPreference, preference)
            let resolved = try XCTUnwrap(event.values["resolvedConfig"] as? [String: Any])
            let wireVideo = try XCTUnwrap(resolved["video"] as? [String: Any])
            XCTAssertEqual(wireVideo as NSDictionary, video as NSDictionary)
        }
    }
}
