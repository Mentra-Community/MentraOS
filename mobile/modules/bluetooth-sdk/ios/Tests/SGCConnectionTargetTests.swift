@testable import MentraBluetoothSDK
import XCTest

final class SGCConnectionTargetTests: XCTestCase {
    func testG1RejectsAnotherPairsLegacyUUID() {
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: "Even G1_12_L_123456", searchID: "_47_", cachedSearchID: nil))
        XCTAssertTrue(G1ConnectionTarget.matchesCachedPeripheral(name: "Even G1_47_L_123456", searchID: "_47_", cachedSearchID: nil))
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: "Even G1_470_R_123456", searchID: "_47_", cachedSearchID: nil))
    }

    func testG1NamelessBackgroundReconnectRequiresRecordedTarget() {
        XCTAssertTrue(G1ConnectionTarget.matchesCachedPeripheral(name: nil, searchID: "_47_", cachedSearchID: "_47_"))
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: nil, searchID: "_47_", cachedSearchID: "_12_"))
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: nil, searchID: "_47_", cachedSearchID: nil))
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: "Even G1_12_L_123456", searchID: "_47_", cachedSearchID: "_47_"))
        XCTAssertFalse(G1ConnectionTarget.matchesCachedPeripheral(name: nil, searchID: "NOT_SET", cachedSearchID: "NOT_SET"))
    }

    func testNexExplicitSelectionExcludesSavedAndPreferredFallbacks() {
        XCTAssertFalse(nex(name: "Nex1-old", target: "Nex1-new"))
        XCTAssertFalse(nex(name: "Nex1-new-extra", target: "Nex1-new"))
        XCTAssertTrue(nex(name: "Nex1-new", target: "Nex1-new"))
        XCTAssertFalse(nex(name: "Nex1-old", target: ""))
    }

    func testNexDiscoveryNeverConnectsAndSavedReconnectStillWorks() {
        XCTAssertFalse(nex(name: "Nex1-old", target: nil, discovery: true))
        XCTAssertFalse(nex(name: "Nex1-new", target: "Nex1-new", discovery: true))
        XCTAssertTrue(nex(name: "Nex1-old", target: nil))
        XCTAssertTrue(nex(name: "Nex1-renamed", target: nil))
    }

    func testVuzixCurrentLinkMustMatchTheSelectedBracketedID() {
        XCTAssertTrue(VuzixConnectionTarget.matches(name: "Vuzix Z100 [abc123]", target: "abc123"))
        XCTAssertTrue(VuzixConnectionTarget.matches(name: "Vuzix Z100 [abc123]", target: "Vuzix Z100 [abc123]"))
        XCTAssertFalse(VuzixConnectionTarget.matches(name: "Vuzix Z100 [old123]", target: "abc123"))
        XCTAssertFalse(VuzixConnectionTarget.matches(name: nil, target: "abc123"))
        XCTAssertFalse(VuzixConnectionTarget.matches(name: "", target: ""))
        XCTAssertEqual(VuzixConnectionTarget.identifier("abc123"), "abc123")
    }

    private func nex(name: String, target: String?, discovery: Bool = false) -> Bool {
        NexConnectionTarget.shouldConnect(
            name: name, target: target, discoveryOnly: discovery,
            savedName: "Nex1-old", preferredID: "old", discoveredID: "old"
        )
    }
}
