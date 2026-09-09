@testable import MentraBluetoothSDK
import XCTest

final class ReleaseChangelogTests: XCTestCase {
    func testIncludesTargetNotesForTransitionWithinOneReleaseTrain() throws {
        let changelogs = try ReleaseChangelogCatalog.select(
            fromVersion: "3.1.0-dev.2",
            toVersion: "3.1.0-beta.8"
        )

        XCTAssertEqual(changelogs.map(\.version), ["3.1.0"])
    }
}
