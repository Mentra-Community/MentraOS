import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class Ar99OtaOwnershipTests: XCTestCase {
    @MainActor private final class Transport: Ar99OtaGattTransport {
        var notificationAllowed = true
        var requestedMtu = 0
        var onWrite: ((Data) -> Void)?
        var onMtu: (() -> Void)?
        func enableOtaNotification() -> Bool {
            notificationAllowed
        }

        func sendOtaData(_ data: Data) {
            onWrite?(data)
        }

        func requestMtu(_: Int) {
            requestedMtu += 1; onMtu?()
        }

        func isBleConnected() -> Bool {
            true
        }
    }

    func testNotificationPreparationAlreadyOwnsTransferAndCanPauseForReconnect() async {
        await MainActor.run {
            let manager = Ar99OtaManager(), transport = Transport()
            manager.setTransport(transport)
            XCTAssertTrue(manager.startOTA(data: Data([1, 2, 3])))
            manager.handleOTAResponse(Data([0x09, 0x06, 0x80, 1, 0, 1])) // Late prior validation before this request was sent.
            XCTAssertTrue(manager.isOTAInProgress())
            XCTAssertFalse(manager.startOTA(data: Data([9])))
            manager.onBleDisconnected()
            XCTAssertTrue(manager.isPausedWaitingReconnect())
            manager.cancelOTA()
            XCTAssertFalse(manager.isOTAInProgress())
            transport.notificationAllowed = false
            XCTAssertFalse(manager.startOTA(data: Data([1])))
            XCTAssertFalse(manager.isOTAInProgress())
        }
    }

    func testOriginalVendorRequestBytesAndPreparationDelaysArePreserved() async {
        let sent = expectation(description: "Existing AR99 request frame")
        let (manager, transport) = await MainActor.run {
            let manager = Ar99OtaManager(), transport = Transport()
            transport.onMtu = { _ = manager.handleMtuNegotiatedForOta(success: true) }
            transport.onWrite = { data in
                XCTAssertEqual(data.map { String(format: "%02x", $0) }.joined(), "0901800b00090100010a040300000000")
                sent.fulfill()
            }
            manager.setTransport(transport)
            XCTAssertTrue(manager.startOTA(data: Data([1, 2, 3])))
            manager.onOtaNotifyEnabled()
            XCTAssertEqual(transport.requestedMtu, 0)
            return (manager, transport)
        }
        await fulfillment(of: [sent], timeout: 4)
        await MainActor.run { manager.cancelOTA(); transport.onMtu = nil; transport.onWrite = nil }
    }
}
