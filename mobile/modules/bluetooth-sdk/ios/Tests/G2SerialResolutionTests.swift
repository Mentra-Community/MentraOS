@testable import MentraBluetoothSDK
import XCTest

final class G2SerialResolutionTests: XCTestCase {
    func testScannedSerialAlwaysWins() {
        XCTAssertEqual(G2SerialResolution.resolve(scannedSerial: "S2ABCD12345678", requestedId: "OTHER", persistedDeviceName: "S2OLD000000000"), "S2ABCD12345678")
    }

    func testCachedReconnectReusesPersistedSerialOnlyWhenItIsTheRequestedId() {
        XCTAssertEqual(G2SerialResolution.resolve(scannedSerial: nil, requestedId: "S2ABCD12345678", persistedDeviceName: "S2ABCD12345678"), "S2ABCD12345678")
        XCTAssertNil(G2SerialResolution.resolve(scannedSerial: nil, requestedId: "12345678", persistedDeviceName: "S2ABCD12345678"))
        XCTAssertNil(G2SerialResolution.resolve(scannedSerial: nil, requestedId: "S2ABCD12345678", persistedDeviceName: ""))
        XCTAssertNil(G2SerialResolution.resolve(scannedSerial: nil, requestedId: "NOT_SET", persistedDeviceName: "NOT_SET"))
    }

    func testSwitchingPairsDoesNotLeakThePreviousSerial() {
        XCTAssertNil(G2SerialResolution.resolve(scannedSerial: nil, requestedId: "S2NEW000000001", persistedDeviceName: "S2OLD000000000"))
    }
}
