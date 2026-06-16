//
//  DeviceHostImpl.swift
//  Concrete DeviceHost (iOS) — routes a driver's callbacks into the real app
//  singletons (Bridge / DeviceStore / DeviceManager), i.e. exactly the inline
//  calls RemoteHarness.swift used to make, moved behind the façade. Mirror of
//  the Android DeviceHostImpl.kt. See docs/device-driver-contract.md §6.
//

import Foundation

@MainActor
final class DeviceHostImpl: DeviceHost {
    /// The driver's type string, used as the model on touch events (matches what
    /// RemoteHarness passed before).
    private let deviceType: String

    init(deviceType: String) {
        self.deviceType = deviceType
    }

    func reset() {
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        DeviceStore.shared.apply("glasses", "micEnabled", false)
        DeviceStore.shared.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.voiceActivityDetectionEnabled
        )
    }

    func reportConnectionState(_ state: ConnectionState) {
        switch state {
        case .connected:
            DeviceStore.shared.apply("glasses", "connected", true)
            DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        case .connecting:
            DeviceStore.shared.apply("glasses", "connected", false)
            DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        case .disconnected:
            DeviceStore.shared.apply("glasses", "connected", false)
            DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
        }
    }

    func reportReady(_ ready: Bool) {
        DeviceStore.shared.apply("glasses", "fullyBooted", ready)
    }

    func reportDeviceInfo(_ info: DeviceInfo) {
        DeviceStore.shared.apply("glasses", "deviceModel", info.model)
        if let serial = info.serial { DeviceStore.shared.apply("glasses", "serialNumber", serial) }
        if let firmware = info.firmware { DeviceStore.shared.apply("glasses", "firmwareVersion", firmware) }
        if let color = info.color { DeviceStore.shared.apply("glasses", "color", color) }
        if let style = info.style { DeviceStore.shared.apply("glasses", "style", style) }
    }

    func emitBattery(level: Int, charging: Bool) {
        DeviceStore.shared.apply("glasses", "batteryLevel", level)
        DeviceStore.shared.apply("glasses", "charging", charging)
        Bridge.sendBatteryStatus(level: level, charging: charging)
    }

    func emitMicAudio(_ lc3: Data, frameSize: Int) {
        DeviceManager.shared.handleGlassesMicData(lc3, frameSize)
    }

    func reportMicEnabled(_ on: Bool) {
        DeviceStore.shared.apply("glasses", "micEnabled", on)
    }

    func emitTouchEvent(_ gesture: String) {
        Bridge.sendTouchEvent(deviceModel: deviceType, gestureName: gesture, timestamp: Int64(Date().timeIntervalSince1970 * 1000))
    }

    func emitImu(accel: [Double]) {
        let x = accel.count > 0 ? accel[0] : 0
        let y = accel.count > 1 ? accel[1] : 0
        let z = accel.count > 2 ? accel[2] : 0
        Bridge.sendAccelEvent(x: Float(x), y: Float(y), z: Float(z), timestamp: Int64(Date().timeIntervalSince1970 * 1000))
    }

    func reportCommandResult(requestId: String, ok: Bool, error: String?) {
        Bridge.sendRgbLedControlResponse(requestId: requestId, success: ok, error: error)
    }

    func reportDiscoveredDevice(id: String, name: String) {
        Bridge.sendDiscoveredDevice(id, name)
    }

    func log(_ msg: String) {
        Bridge.log(msg)
    }
}
