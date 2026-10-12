import CoreBluetooth
@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class G1PairingTests: XCTestCase {
    /// Exercise the real discovery/readiness entry points without accessing a
    /// radio. Battery requests are observed through the SDK diagnostics.
    private class RecordingG1: G1 {
        var scans = 0
        override func startScan() -> Bool {
            scans += 1
            return false // Central manager is still initializing.
        }
    }

    private func withGlasses(_ test: (RecordingG1) async throws -> Void) async rethrows {
        let store = DeviceStore.shared.store
        let saved = store.getCategory("glasses")
        let keys = ["leftGlassUUID", "rightGlassUUID", "leftGlassSearchID", "rightGlassSearchID"]
        let savedDefaults = keys.map { ($0, UserDefaults.standard.object(forKey: $0)) }
        let glasses = RecordingG1()
        defer {
            glasses.forget()
            for (key, value) in savedDefaults {
                UserDefaults.standard.set(value, forKey: key)
            }
            for key in store.getCategory("glasses").keys where saved[key] == nil {
                store.remove("glasses", key)
            }
            for (key, value) in saved {
                store.set("glasses", key, value)
            }
        }
        try await test(glasses)
    }

    func testFirstDiscoveryResumesWhenBluetoothPowersOn() async {
        await withGlasses { glasses in
            glasses.findCompatibleDevices()
            XCTAssertEqual(glasses.DEVICE_SEARCH_ID, "NOT_SET")
            XCTAssertEqual(glasses.scans, 1)
            glasses.handleBluetoothState(.poweredOn)
            XCTAssertEqual(glasses.scans, 2)
        }
    }

    func testStoppedDiscoveryDoesNotResumeOnLatePowerCallback() async {
        await withGlasses { glasses in
            glasses.findCompatibleDevices()
            glasses.stopScan()
            glasses.handleBluetoothState(.poweredOn)
            XCTAssertEqual(glasses.scans, 1)
        }
    }

    func testSelectedPairResumesButCancelledPairDoesNot() async {
        await withGlasses { glasses in
            glasses.connectById("59")
            glasses.handleBluetoothState(.poweredOn)
            XCTAssertEqual(glasses.scans, 2)
            XCTAssertEqual(glasses.DEVICE_SEARCH_ID, "_59_")
            // Finding both arms stops scanning, but should not prevent a
            // selected pair from reconnecting after Bluetooth is toggled.
            glasses.stopScan()
            glasses.handleBluetoothState(.poweredOff)
            glasses.handleBluetoothState(.poweredOn)
            XCTAssertEqual(glasses.scans, 3)
            glasses.disconnect()
            glasses.handleBluetoothState(.poweredOn)
            XCTAssertEqual(glasses.scans, 3)
        }
    }

    func testBatteryWaitsForBothArmsAndRefreshesAfterReconnect() async {
        await withGlasses { glasses in
            var batteryRequests = 0
            let sink = Bridge.addEventSink { event, body in
                if event == "log", body["message"] as? String == "G1: getBatteryStatus()" {
                    batteryRequests += 1
                }
            }
            defer { Bridge.removeEventSink(sink) }
            glasses.getBatteryStatus()
            XCTAssertEqual(batteryRequests, 0)
            glasses.setReadiness(left: true, right: nil)
            glasses.getBatteryStatus()
            XCTAssertEqual(batteryRequests, 0)
            glasses.setReadiness(left: nil, right: true)
            XCTAssertEqual(batteryRequests, 1)
            glasses.setReadiness(left: true, right: true)
            XCTAssertEqual(batteryRequests, 1, "Duplicate init ACKs must not poll again")
            glasses.setReadiness(left: false, right: false)
            glasses.getBatteryStatus()
            XCTAssertEqual(batteryRequests, 1)
            glasses.setReadiness(left: nil, right: true)
            glasses.setReadiness(left: true, right: nil)
            XCTAssertEqual(batteryRequests, 2)
        }
    }

    func testQueuedCommandWithoutTransportDoesNotReconnect() async throws {
        try await withGlasses { glasses in
            glasses.queueChunks([[Commands.BLE_REQ_BATTERY.rawValue, 0x01]])
            // The original missing-characteristic path restarted scanning after
            // five 100ms command attempts, before either arm could connect.
            try await Task.sleep(nanoseconds: 1_000_000_000)
            XCTAssertEqual(glasses.scans, 0)
        }
    }
}

final class G1ReconnectionTests: XCTestCase {
    func testSuccessfulReconnectAllowsALaterRetryLoop() async {
        let manager = ReconnectionManager()
        let connected = expectation(description: "Reconnect completes")
        await manager.start {
            connected.fulfill()
            return true
        }
        await fulfillment(of: [connected], timeout: 1)
        let running = await manager.isRunning
        XCTAssertFalse(running)

        let retry = expectation(description: "A later disconnection can reconnect")
        await manager.start {
            retry.fulfill()
            return true
        }
        await fulfillment(of: [retry], timeout: 1)
        await manager.stop()
    }

    func testRepeatedFailuresDoNotRestartTheRetryDelay() async {
        let manager = ReconnectionManager(intervalSeconds: 60)
        let firstAttempt = expectation(description: "First reconnect attempt")
        await manager.start {
            firstAttempt.fulfill()
            return false
        }
        await fulfillment(of: [firstAttempt], timeout: 1)

        let restarted = expectation(description: "No immediate retry for another failed command")
        restarted.isInverted = true
        await manager.start {
            restarted.fulfill()
            return false
        }
        await fulfillment(of: [restarted], timeout: 0.1)
        let attempts = await manager.attemptCount
        XCTAssertEqual(attempts, 1)
        await manager.stop()

        let nextAttempt = expectation(description: "A later connection can retry")
        await manager.start {
            nextAttempt.fulfill()
            return false
        }
        await fulfillment(of: [nextAttempt], timeout: 1)
        await manager.stop()
    }
}
