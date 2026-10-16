@testable import GlassesMediaCore
import ObjectiveC
import XCTest

final class MacWifiInvocationTests: XCTestCase {
    private final class Wifi: NSObject {
        var succeeds = false
        let network = NSObject()

        /// Swift's Objective-C thunk uses the same autoreleasing NSError** ABI
        /// as CoreWLAN. No network framework or device is loaded by this fixture.
        @objc(scanForNetworksWithSSID:error:)
        dynamic func scan(_: NSData, error: NSErrorPointer) -> NSSet? {
            if succeeds { return NSSet(object: network) }
            error?.pointee = NSError(domain: "MacWifiInvocationFixture", code: 7, userInfo: nil)
            return nil
        }

        @objc(associateToNetwork:password:error:)
        dynamic func associate(_: NSObject, password _: NSString, error: NSErrorPointer) -> Bool {
            if succeeds { return true }
            error?.pointee = NSError(domain: "MacWifiInvocationFixture", code: 8, userInfo: nil)
            return false
        }
    }

    func testScanErrorWritebackSurvivesRepeatedAutoreleasePools() {
        let wifi = Wifi(), selector = NSSelectorFromString("scanForNetworksWithSSID:error:")
        let invoke = unsafeBitCast(wifi.method(for: selector), to: MacWifiInvocation.Scan.self)
        for _ in 0 ..< 100 {
            var retainedError: NSError?
            autoreleasepool {
                var error: NSError?
                XCTAssertNil(invoke(wifi, selector, NSData(data: Data("fixture".utf8)), &error))
                retainedError = error
            }
            XCTAssertEqual(retainedError?.domain, "MacWifiInvocationFixture")
            XCTAssertEqual(retainedError?.code, 7)
        }
    }

    func testAssociationErrorWritebackSurvivesRepeatedAutoreleasePools() {
        let wifi = Wifi(), selector = NSSelectorFromString("associateToNetwork:password:error:")
        let invoke = unsafeBitCast(wifi.method(for: selector), to: MacWifiInvocation.Associate.self)
        for _ in 0 ..< 100 {
            var retainedError: NSError?
            autoreleasepool {
                var error: NSError?
                XCTAssertFalse(invoke(wifi, selector, wifi.network, "fixture" as NSString, &error))
                retainedError = error
            }
            XCTAssertEqual(retainedError?.domain, "MacWifiInvocationFixture")
            XCTAssertEqual(retainedError?.code, 8)
        }
    }

    func testSuccessfulCallsPreserveObjectAndBooleanReturnsWithoutAnError() {
        let wifi = Wifi(); wifi.succeeds = true
        let scanSelector = NSSelectorFromString("scanForNetworksWithSSID:error:")
        let associateSelector = NSSelectorFromString("associateToNetwork:password:error:")
        let scan = unsafeBitCast(wifi.method(for: scanSelector), to: MacWifiInvocation.Scan.self)
        let associate = unsafeBitCast(wifi.method(for: associateSelector), to: MacWifiInvocation.Associate.self)
        for _ in 0 ..< 100 {
            var retainedNetworks: NSSet?
            autoreleasepool {
                var error: NSError?
                retainedNetworks = scan(wifi, scanSelector, NSData(data: Data("fixture".utf8)), &error)?.takeUnretainedValue()
                XCTAssertNil(error)
                XCTAssertTrue(associate(wifi, associateSelector, wifi.network, "fixture" as NSString, &error))
                XCTAssertNil(error)
            }
            XCTAssertEqual(retainedNetworks?.count, 1)
            XCTAssertTrue(retainedNetworks?.anyObject() as? NSObject === wifi.network)
        }
    }
}
