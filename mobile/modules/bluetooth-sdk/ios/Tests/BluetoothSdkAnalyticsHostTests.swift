@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkAnalyticsHostTests: XCTestCase {
    func testSimulatorWinsOverEverything() {
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: true, hasEmbeddedProvisioningProfile: true, receiptFileName: "sandboxReceipt"),
            "simulator"
        )
    }

    func testEmbeddedProfileMeansAdHocOrDevelopmentEvenWithSandboxReceipt() {
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: true, receiptFileName: "sandboxReceipt"),
            "adhoc_or_dev"
        )
    }

    func testSandboxReceiptWithoutProfileIsTestFlight() {
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: false, receiptFileName: "sandboxReceipt"),
            "testflight"
        )
    }

    func testNoProfileAndProductionReceiptIsAppStore() {
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: false, receiptFileName: "receipt"),
            "app_store"
        )
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: false, receiptFileName: nil),
            "app_store"
        )
    }

    func testEnvironmentIsNormalizedAndValidated() {
        XCTAssertEqual(BluetoothSdkAnalyticsHost.normalizedEnvironment(" Prod "), "prod")
        XCTAssertEqual(BluetoothSdkAnalyticsHost.normalizedEnvironment("staging-eu_1"), "staging-eu_1")
        XCTAssertNil(BluetoothSdkAnalyticsHost.normalizedEnvironment(nil))
        XCTAssertNil(BluetoothSdkAnalyticsHost.normalizedEnvironment(""))
        XCTAssertNil(BluetoothSdkAnalyticsHost.normalizedEnvironment("-leading"))
        XCTAssertNil(BluetoothSdkAnalyticsHost.normalizedEnvironment("has space"))
        XCTAssertNil(BluetoothSdkAnalyticsHost.normalizedEnvironment(String(repeating: "a", count: 33)))
    }

    func testResolveNeverThrowsForTheTestBundle() {
        let host = BluetoothSdkAnalyticsHost.resolve(bundle: Bundle(for: BluetoothSdkAnalyticsHostTests.self))
        XCTAssertTrue(["debug", "release"].contains(host.buildType))
        XCTAssertTrue(["simulator", "adhoc_or_dev", "testflight", "app_store"].contains(host.installSource))
    }
}
