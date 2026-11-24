@testable import MentraBluetoothSDK
import XCTest

final class PhotoRequestRoutingTests: XCTestCase {
    private let everyField: [String: Any] = [
        "requestId": "photo-1",
        "size": "high",
        "mode": "text",
        "transferMethod": "direct",
        "webhookUrl": "https://example.com/upload",
        "authToken": "token",
        "compress": "medium",
        "save": true,
        "sound": false,
        "exposureTimeNs": 8_000_000.0,
        "iso": 400,
        "aeExposureDivisor": 4,
        "isoCap": 800,
        "noiseReduction": true,
        "edgeEnhancement": false,
        "mfnr": true,
        "zsl": false,
        "ispDigitalGain": 2,
        "ispAnalogGain": "4x",
        "presend_thumbnail": true,
        "localFile": true,
        "deliver": "thumbnail",
    ]

    private func assertSameCapture(_ routed: PhotoRequest, _ request: PhotoRequest, line: UInt = #line) {
        XCTAssertEqual(routed.size, request.size, line: line)
        XCTAssertEqual(routed.mode, request.mode, line: line)
        XCTAssertEqual(routed.transferMethod, request.transferMethod, line: line)
        XCTAssertEqual(routed.webhookUrl, request.webhookUrl, line: line)
        XCTAssertEqual(routed.authToken, request.authToken, line: line)
        XCTAssertEqual(routed.compress, request.compress, line: line)
        XCTAssertEqual(routed.save, request.save, line: line)
        XCTAssertEqual(routed.sound, request.sound, line: line)
        XCTAssertEqual(routed.aeExposureDivisor, request.aeExposureDivisor, line: line)
        XCTAssertEqual(routed.isoCap, request.isoCap, line: line)
        XCTAssertEqual(routed.noiseReduction, request.noiseReduction, line: line)
        XCTAssertEqual(routed.edgeEnhancement, request.edgeEnhancement, line: line)
        XCTAssertEqual(routed.mfnr, request.mfnr, line: line)
        XCTAssertEqual(routed.zsl, request.zsl, line: line)
        XCTAssertEqual(routed.ispDigitalGain, request.ispDigitalGain, line: line)
        XCTAssertEqual(routed.ispAnalogGain, request.ispAnalogGain, line: line)
        XCTAssertEqual(routed.presendThumbnail, request.presendThumbnail, line: line)
        XCTAssertEqual(routed.localFile, request.localFile, line: line)
        XCTAssertEqual(routed.deliver, request.deliver, line: line)
    }

    /// The glasses were never asked for a thumbnail on iOS: routing rebuilt the request without the flag.
    func testThumbnailFlagReachesTheGlasses() throws {
        let request = try PhotoRequest.from(params: ["size": "medium", "presend_thumbnail": true])
        XCTAssertTrue(request.presendThumbnail)
        XCTAssertTrue(request.routedForCapture().presendThumbnail)
        XCTAssertFalse(try PhotoRequest.from(params: ["size": "medium"]).routedForCapture().presendThumbnail)
    }

    func testRoutingKeepsEveryField() throws {
        let request = try PhotoRequest.from(params: everyField)
        XCTAssertTrue(request.presendThumbnail)
        XCTAssertTrue(request.localFile)
        XCTAssertEqual(request.aeExposureDivisor, 4)

        let routed = request.routedForCapture()
        XCTAssertEqual(routed.requestId, "photo-1")
        XCTAssertEqual(routed.exposureTimeNs, 8_000_000.0)
        XCTAssertEqual(routed.iso, 400)
        assertSameCapture(routed, request)

        let renamed = request.withRequestId("photo-2")
        XCTAssertEqual(renamed.requestId, "photo-2")
        XCTAssertEqual(renamed.exposureTimeNs, request.exposureTimeNs)
        XCTAssertEqual(renamed.iso, request.iso)
        assertSameCapture(renamed, request)
    }

    func testRoutingDropsAnIsoWithoutAManualExposure() {
        let auto = PhotoRequest(size: .medium, sound: true, exposureTimeNs: nil, iso: 400).routedForCapture()
        XCTAssertNil(auto.exposureTimeNs)
        XCTAssertNil(auto.iso)

        let invalid = PhotoRequest(size: .medium, sound: true, exposureTimeNs: -1, iso: 400).routedForCapture()
        XCTAssertNil(invalid.exposureTimeNs)
        XCTAssertNil(invalid.iso)

        let manual = PhotoRequest(size: .medium, sound: true, exposureTimeNs: 8_000_000, iso: 0).routedForCapture()
        XCTAssertEqual(manual.exposureTimeNs, 8_000_000)
        XCTAssertNil(manual.iso)
    }

    func testHeldPhotoOptionsAreParsedAndOnlyKnownValuesKept() throws {
        let held = try PhotoRequest.from(params: ["deliver": "thumbnail"])
        XCTAssertTrue(held.holdsPhoto)

        let whole = try PhotoRequest.from(params: ["deliver": "full"])
        XCTAssertNil(whole.deliver)
        XCTAssertFalse(whole.holdsPhoto)
    }

    func testHeldPhotoResponseKeepsItsMetadata() {
        let event = PhotoResponseEvent(values: [
            "requestId": "photo-1",
            "success": true,
            "held": true,
            "thumbnailUrl": "data:image/jpeg;base64,AA==",
            "capturedAt": 1_700_000_000_000,
            "bytes": 1234,
        ])
        XCTAssertEqual(event.values["held"] as? Bool, true)
        XCTAssertEqual(event.values["thumbnailUrl"] as? String, "data:image/jpeg;base64,AA==")
        XCTAssertEqual(event.values["capturedAt"] as? Int, 1_700_000_000_000)
        XCTAssertEqual(event.values["fileSizeBytes"] as? Int, 1234)

        let whole = PhotoResponseEvent(values: ["requestId": "photo-2", "success": true])
        XCTAssertNil(whole.values["held"])
        XCTAssertNil(whole.values["thumbnailUrl"])
        XCTAssertNil(whole.values["capturedAt"])
    }
}
