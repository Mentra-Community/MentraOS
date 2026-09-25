@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class DeviceIdentityPairingTests: XCTestCase {
    func testReadinessPromotesCoherentIdentityAndPreservesSameDeviceReconnects() {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        defer {
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values {
                    store.set(category, key, value)
                }
            }
        }
        let cases = [
            // pending name, pending address, saved model, expected address
            ("new", "", "test", ""),
            ("new", "new-address", "test", "new-address"),
            ("old", "", "test", "old-address"),
            ("", "", "test", "old-address"),
            ("old", "", "other-model", ""),
        ]
        for (pendingName, pendingAddress, savedModel, expectedAddress) in cases {
            let manager = DeviceManager()
            let device = Simulated()
            device.type = "test"
            manager.sgc = device
            defer {
                manager.disconnect()
                manager.cleanup()
            }
            store.set("bluetooth", "default_wearable", savedModel)
            store.set("bluetooth", "device_name", "old")
            store.set("bluetooth", "device_address", "old-address")
            store.set("bluetooth", "pending_device_name", pendingName)
            store.set("bluetooth", "pending_device_address", pendingAddress)
            store.set("bluetooth", "shouldSendBootingMessage", false)
            manager.handleDeviceReady()
            XCTAssertEqual(DeviceStore.shared.get("bluetooth", "device_name") as? String, pendingName.isEmpty ? "old" : pendingName)
            XCTAssertEqual(DeviceStore.shared.get("bluetooth", "device_address") as? String, expectedAddress)
            XCTAssertEqual(DeviceStore.shared.get("bluetooth", "pending_device_name") as? String, "")
            XCTAssertEqual(DeviceStore.shared.get("bluetooth", "pending_device_address") as? String, "")
        }
    }
}
