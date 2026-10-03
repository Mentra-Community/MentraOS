@testable import MentraBluetoothSDK
import XCTest

final class PhotoCompressionTests: XCTestCase {
    func testCompressionIsPreservedAndDefaultsToNone() throws {
        for raw in ["none", "low", "medium", "high"] {
            XCTAssertEqual(try PhotoRequest.from(params: ["compress": raw]).compress.rawValue, raw)
            XCTAssertEqual(try PhotoCaptureDefaults.from(params: ["compress": raw]).compress?.rawValue, raw)
        }
        XCTAssertEqual(PhotoRequest(size: .medium, sound: true).compress, .none)
        XCTAssertEqual(try PhotoRequest.from(params: [:]).compress, .none)
        XCTAssertNil(try PhotoCaptureDefaults.from(params: [:]).compress)
    }

    func testInvalidCompressionIsRejected() {
        for invalid: Any in ["heavy", "", "HIGH", NSNull(), 1, false] {
            XCTAssertThrowsError(try PhotoRequest.from(params: ["compress": invalid]))
            XCTAssertThrowsError(try PhotoCaptureDefaults.from(params: ["compress": invalid]))
        }
    }
}
