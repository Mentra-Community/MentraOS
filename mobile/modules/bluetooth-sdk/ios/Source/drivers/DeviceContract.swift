//
//  DeviceContract.swift
//  Public device-driver contract (iOS) — mirror of the Android
//  drivers/DeviceContract.kt. See docs/device-driver-contract.md.
//
//  A driver author implements `GlassesDriver`; the app injects a `DeviceHost`
//  the driver calls back through (instead of touching Bridge/DeviceStore/
//  DeviceManager directly). `GlassesDriverSgcAdapter` bridges a GlassesDriver
//  onto the existing internal SGCManager so the rest of the app is unchanged.
//
//  First, pragmatic cut: inbound command signatures mirror SGCManager's so the
//  adapter is a 1:1 forward. NOTE: not built/tested yet (no Xcode-26 toolchain
//  on this machine — Expo SDK 55 needs Swift 6.2). Scripted to mirror Android.
//

import Foundation

enum ConnectionState { case connecting, connected, disconnected }

enum DisplayKind { case none, monochrome, grayscale, color }

struct DisplayGeometry {
    let widthPx: Int
    let heightPx: Int
}

/// What a device can do. Gates which GlassesDriver methods are called and the
/// app's miniapp feature-gating. Replaces the bare `hasMic` + hardcoded map.
struct DeviceCapabilities {
    var hasDisplay: Bool = false
    var displayKind: DisplayKind = .none
    var displayGeometry: DisplayGeometry? = nil
    var hasMic: Bool = false
    var hasCamera: Bool = false
    var hasSpeaker: Bool = false
    var hasImu: Bool = false
    var hasWifi: Bool = false
    var buttons: [String] = []
    var hasTouchpad: Bool = false
}

/// Identity the driver reports once it knows what it's connected to.
struct DeviceInfo {
    let model: String
    var serial: String? = nil
    var firmware: String? = nil
    var color: String? = nil
    var style: String? = nil
}

/// The narrow façade the driver calls back through. Every method maps to a real
/// call RemoteHarness made into Bridge/DeviceStore/DeviceManager (mapping table
/// in docs/device-driver-contract.md §6). Implemented by `DeviceHostImpl`.
@MainActor
protocol DeviceHost {
    /// Reset glasses state to a fresh "connecting" device (called once on start).
    func reset()

    func reportConnectionState(_ state: ConnectionState)
    func reportReady(_ ready: Bool)
    func reportDeviceInfo(_ info: DeviceInfo)

    func emitBattery(level: Int, charging: Bool)

    func emitMicAudio(_ lc3: Data, frameSize: Int)
    func reportMicEnabled(_ on: Bool)

    func emitTouchEvent(_ gesture: String)
    /// iOS surfaces accelerometer only (Bridge.sendAccelEvent); pass [x, y, z].
    func emitImu(accel: [Double])

    func reportCommandResult(requestId: String, ok: Bool, error: String?)
    func reportDiscoveredDevice(id: String, name: String)

    func log(_ msg: String)
}

/// The public interface a driver implements. Inbound commands only; events go
/// out through `DeviceHost`. Optional groups have default no-ops so a driver
/// implements only what its capabilities advertise.
@MainActor
protocol GlassesDriver {
    /// Stable type string for this driver (e.g. DeviceTypes.REMOTE_HARNESS).
    var deviceType: String { get }
    var capabilities: DeviceCapabilities { get }

    /// Called once after construction: keep the host, do initial setup, begin connecting.
    func start(_ host: DeviceHost)

    // lifecycle
    func connectById(_ id: String)
    func disconnect()
    func cleanup()
    func ping()
    func getConnectedName() -> String?
    func findCompatibleDevices()
    func stopScan()
    func requestVersionInfo()

    // display (only if capabilities.hasDisplay)
    func setBrightness(_ level: Int, autoMode: Bool)
    func clearDisplay()
    func sendTextWall(_ text: String) async
    func sendDoubleTextWall(_ top: String, _ bottom: String) async
    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool
    func showDashboard()
    func setDashboardPosition(_ height: Int, _ depth: Int)

    // audio (only if capabilities.hasMic)
    func setMicEnabled(_ enabled: Bool)
    func sortMicRanking(list: [String]) -> [String]

    // camera / media (only if capabilities.hasCamera)
    func requestPhoto(_ requestId: String, appId: String, size: String?, webhookUrl: String?, authToken: String?, compress: String?, flash: Bool, save: Bool, sound: Bool, exposureTimeNs: Double?, iso: Int?)
    func startStream(_ message: [String: Any])
    func stopStream()
    func sendStreamKeepAlive(_ message: [String: Any])
    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool)
    func stopVideoRecording(requestId: String)

    // sensors / control
    func setImuEnabled(_ enabled: Bool) async
    func setHeadUpAngle(_ angle: Int)
    func getBatteryStatus()
    func setSilentMode(_ enabled: Bool)
    func sendShutdown()
    func sendReboot()
    func sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int)

    // network (only if capabilities.hasWifi)
    func requestWifiScan()
    func sendWifiCredentials(_ ssid: String, _ password: String)
    func forgetWifiNetwork(_ ssid: String)
    func sendHotspotState(_ enabled: Bool)
}

/// Default no-ops so drivers implement only what they support.
extension GlassesDriver {
    func connectById(_: String) {}
    func ping() {}
    func getConnectedName() -> String? { nil }
    func findCompatibleDevices() {}
    func stopScan() {}
    func requestVersionInfo() {}

    func setBrightness(_: Int, autoMode _: Bool) {}
    func clearDisplay() {}
    func sendTextWall(_: String) async {}
    func sendDoubleTextWall(_: String, _: String) async {}
    func displayBitmap(base64ImageData _: String, x _: Int32?, y _: Int32?, width _: Int32?, height _: Int32?) async -> Bool { false }
    func showDashboard() {}
    func setDashboardPosition(_: Int, _: Int) {}

    func setMicEnabled(_: Bool) {}
    func sortMicRanking(list: [String]) -> [String] { list }

    func requestPhoto(_: String, appId _: String, size _: String?, webhookUrl _: String?, authToken _: String?, compress _: String?, flash _: Bool, save _: Bool, sound _: Bool, exposureTimeNs _: Double?, iso _: Int?) {}
    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func startVideoRecording(requestId _: String, save _: Bool, flash _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}

    func setImuEnabled(_: Bool) async {}
    func setHeadUpAngle(_: Int) {}
    func getBatteryStatus() {}
    func setSilentMode(_: Bool) {}
    func sendShutdown() {}
    func sendReboot() {}
    func sendRgbLedControl(requestId _: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int, offDurationMs _: Int, count _: Int) {}

    func requestWifiScan() {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
}
