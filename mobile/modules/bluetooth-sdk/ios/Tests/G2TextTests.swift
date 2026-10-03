@testable import MentraBluetoothSDK
import XCTest

final class G2TextTests: XCTestCase {
    func testBlankRowsAreEncodedOnlyAtTheDeviceBoundary() {
        XCTAssertEqual(G2Text.containerContent("hello\n\nworld\n"), "hello\n\u{200B}\nworld\n\u{200B}")
        XCTAssertEqual(G2Text.containerContent(""), " ")
        XCTAssertEqual(G2Text.containerContent("hello\nworld"), "hello\nworld")
    }
}
