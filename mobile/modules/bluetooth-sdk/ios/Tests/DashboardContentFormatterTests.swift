@testable import MentraBluetoothSDK
import XCTest

final class DashboardContentFormatterTests: XCTestCase {
    func testEmptyContentReturnsStatusHeaderOnly() {
        XCTAssertEqual(
            DashboardContentFormatter.template(for: ""),
            "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"
        )
    }

    func testNonEmptyContentIsAppendedExactlyOnNextLine() {
        XCTAssertEqual(
            DashboardContentFormatter.template(for: "  Next meeting\nRoom 2  "),
            "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$\n  Next meeting\nRoom 2  "
        )
    }

    func testLeadingNewlineKeepsOptionalBlankRow() {
        XCTAssertEqual(
            DashboardContentFormatter.template(for: "\nNext meeting"),
            "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$\n\nNext meeting"
        )
    }
}
