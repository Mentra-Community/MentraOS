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
    }

    func testMissingOrUnrecognizedReceiptIsUnknownNotAppStore() {
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: false, receiptFileName: nil),
            "unknown"
        )
        XCTAssertEqual(
            BluetoothSdkAnalyticsHost.installSource(isSimulator: false, hasEmbeddedProvisioningProfile: false, receiptFileName: "something-else"),
            "unknown"
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

    func testResolveReadsTheBundleItIsGiven() {
        let bundle = Bundle(for: BluetoothSdkAnalyticsHostTests.self)
        let host = BluetoothSdkAnalyticsHost.resolve(bundle: bundle)
        // The test bundle declares no lane and no analytics keys of its own.
        XCTAssertNil(host.environment)
        XCTAssertEqual(host.appVersion, bundle.infoDictionary?["CFBundleShortVersionString"] as? String)
        XCTAssertEqual(host.appBuild, bundle.infoDictionary?["CFBundleVersion"] as? String)
        XCTAssertEqual(host.properties["app_install_source"] as? String, host.installSource)
    }
}
