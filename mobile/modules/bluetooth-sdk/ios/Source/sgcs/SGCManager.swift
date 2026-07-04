import Foundation

/// One element of a scene frame (display.render()). Geometry is raw pixels on
/// the device's drawable canvas; `change` is the host differ's annotation
/// against the previous frame sent to this device.
struct SceneElement {
    let id: String
    let type: String // "text" | "rect" | "image"
    let x: Int32
    let y: Int32
    let w: Int32
    let h: Int32
    let text: String?
    let data: String? // base64 image pixels (SGC decodes → re-encodes to wire format)
    let border: Int32
    let radius: Int32
    let change: String // "created" | "updated" | "moved" | "unchanged"
    let contentHash: String

    func with(change: String) -> SceneElement {
        SceneElement(
            id: id, type: type, x: x, y: y, w: w, h: h, text: text, data: data,
            border: border, radius: radius, change: change, contentHash: contentHash
        )
    }
}

/// A whole scene from the host pipeline — the full frame plus per-element
/// change annotations and host-computed removes. Full-frame consumers can
/// serialize `elements` and ignore the annotations; per-element consumers walk
/// them.
struct SceneFrame {
    let appId: String
    let epoch: Int
    let replay: Bool
    let elements: [SceneElement]
    let removed: [String]

    func asReplay() -> SceneFrame {
        SceneFrame(
            appId: appId, epoch: epoch, replay: true,
            elements: elements.map { $0.with(change: "created") }, removed: removed
        )
    }
}

@MainActor
protocol SGCManager {
    // MARK: - hard coded device properties:

    var type: String { get set }
    var hasMic: Bool { get }

    // MARK: - Audio Control

    func setMicEnabled(_ enabled: Bool)
    func sortMicRanking(list: [String]) -> [String]

    // MARK: - Messaging

    func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool)

    // MARK: - Camera & Media

    func requestPhoto(_ request: PhotoRequest)
    func startStream(_ message: [String: Any])
    func stopStream()
    func sendStreamKeepAlive(_ message: [String: Any])
    func startVideoRecording(requestId: String, save: Bool, sound: Bool)
    /// Start video recording with optional per-recording resolution/fps. A width,
    /// height, or fps of 0 means "use the device's saved button-video default".
    /// Defaulted in an extension to delegate to the basic recording path; devices
    /// that support custom settings (e.g. Mentra Live) override this.
    func startVideoRecording(
        requestId: String, save: Bool, sound: Bool, width: Int, height: Int, fps: Int,
        maxRecordingTimeMinutes: Int
    )
    func stopVideoRecording(requestId: String)
    /// Stop recording and upload the result to `webhookUrl` (multipart) using
    /// `authToken`. Supplied at stop time so the token is fresh when the upload
    /// runs. Defaulted in an extension to ignore the upload target and just stop;
    /// devices that support webhook upload (e.g. Mentra Live) override this. An
    /// empty/nil `webhookUrl` means "keep the video on device".
    func stopVideoRecording(requestId: String, webhookUrl: String?, authToken: String?)

    // MARK: - Button Settings

    func sendButtonPhotoSettings()
    func sendButtonVideoRecordingSettings()
    func sendButtonMaxRecordingTime()
    func sendCameraFovSetting()

    // MARK: - Display Control

    func setBrightness(_ level: Int, autoMode: Bool)
    func clearDisplay()
    func sendText(_ text: String) async
    func sendTextWall(_ text: String) async
    func sendDoubleTextWall(_ top: String, _ bottom: String) async
    /// Display a bitmap. Optional `x`/`y`/`width`/`height` position and size the target
    /// container (used by G2; other SGCs ignore positioning and render the bitmap as before).
    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool
    /// Show text in a positioned container with an optional rounded border.
    /// G2-only capability; default no-op (see protocol extension) so other glasses ignore it.
    func sendPositionedText(
        _ text: String, x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32, borderRadius: Int32
    ) async

    // MARK: - Scene display (display.render() pipeline)

    /// Retained element verbs — identity is the element id. Defaults delegate
    /// to the positioned/bitmap paths (see extension); SGCs with retained
    /// components (G2 containers, Mentra Display canvas) override for
    /// update-in-place / delete semantics.
    func drawLayoutText(
        _ text: String, x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32, borderRadius: Int32, elementId: String, layoutId: String?
    ) async
    func drawLayoutBitmap(
        base64ImageData: String, x: Int32, y: Int32, width: Int32, height: Int32,
        elementId: String, layoutId: String?
    ) async -> Bool
    func removeLayoutElement(_ elementId: String, layoutId: String?) async
    /// Apply a whole host-diffed scene frame (default: paint-then-sweep over the verbs above).
    func applySceneFrame(_ frame: SceneFrame) async
    /// A replay frame is about to repaint from scratch — reset retained bookkeeping.
    func onSceneReplay(_ appId: String) async
    /// Remove a set of scene elements (scene→legacy handoff sweep).
    func clearSceneElements(_ elementIds: [String]) async

    func showDashboard()
    func setDashboardPosition(_ height: Int, _ depth: Int)
    /// Default implementation sends both via [setDashboardPosition]; Nex overrides to one protobuf.
    func setDashboardHeightOnly(_ height: Int)
    func setDashboardDepthOnly(_ depth: Int)

    // MARK: - Dashboard Menu

    func setDashboardMenu(_ items: [[String: Any]])

    // MARK: - Notification Panel

    func showNotificationsPanel() async

    // MARK: - Calendar Events

    func sendCalendarEvents(_ events: [[String: Any]])

    // MARK: - Dashboard Display Settings

    func sendDashboardDisplaySettings()

    // MARK: - Device Control

    func setHeadUpAngle(_ angle: Int)
    /// Enable/disable raw accelerometer (IMU) reporting from the glasses.
    /// Default no-op; only G2 streams IMU data today.
    func setImuEnabled(_ enabled: Bool) async
    func getBatteryStatus()
    func setSilentMode(_ enabled: Bool)
    func exit()
    func sendShutdown()
    func sendReboot()
    func sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int,
        offDurationMs: Int, count: Int
    )

    // MARK: - Connection Management

    func disconnect()
    func forget()
    func findCompatibleDevices()
    func stopScan()
    func connectById(_ id: String)
    func getConnectedBluetoothName() -> String?
    func connectController()
    func disconnectController()
    func cleanup()
    func ping()
    func dbg1()
    func dbg2()

    // MARK: - Network Management

    func requestWifiScan()
    func sendWifiCredentials(_ ssid: String, _ password: String)
    func forgetWifiNetwork(_ ssid: String)
    func sendHotspotState(_ enabled: Bool)
    func sendOtaStart(otaVersionUrl: String?)
    func sendOtaQueryStatus()
    func sendSetSystemTime(_ timestampMs: Int64)

    // MARK: - User Context (for crash reporting)

    func sendUserEmailToGlasses(_ email: String)

    // MARK: - Incident Reporting

    func sendIncidentId(_ incidentId: String, apiBaseUrl: String?)

    // MARK: - Gallery

    func queryGalleryStatus()
    func sendGalleryMode()

    // MARK: - Voice Activity Detection

    func sendVoiceActivityDetectionSetting()

    // MARK: - Version Info

    func requestVersionInfo()
}

/// doesn't seem to work for concurrency reasons :(
/// we can make read-only getters for convienence though:
extension SGCManager {
    /// Default: no-op. Only G2 renders positioned text containers; other glasses ignore it.
    func sendPositionedText(
        _: String, x _: Int32, y _: Int32, width _: Int32, height _: Int32,
        borderWidth _: Int32, borderRadius _: Int32
    ) async {}

    // MARK: - Scene display defaults

    /// Default: ignore the ids and behave like the positioned-text path.
    func drawLayoutText(
        _ text: String, x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32, borderRadius: Int32, elementId _: String, layoutId _: String?
    ) async {
        await sendPositionedText(
            text, x: x, y: y, width: width, height: height,
            borderWidth: borderWidth, borderRadius: borderRadius
        )
    }

    /// Default: ignore the ids and behave like displayBitmap.
    func drawLayoutBitmap(
        base64ImageData: String, x: Int32, y: Int32, width: Int32, height: Int32,
        elementId _: String, layoutId _: String?
    ) async -> Bool {
        await displayBitmap(base64ImageData: base64ImageData, x: x, y: y, width: width, height: height)
    }

    /// Default: no-op (SGC has no retained elements).
    func removeLayoutElement(_: String, layoutId _: String?) async {}

    /// Default: no retained bookkeeping to reset.
    func onSceneReplay(_: String) async {}

    /// Default sweep: remove each element individually.
    func clearSceneElements(_ elementIds: [String]) async {
        for id in elementIds {
            await removeLayoutElement(id, layoutId: nil)
        }
    }

    /// Apply a whole scene frame from the host pipeline (display.render()).
    ///
    /// The host has already diffed the scene, so each element arrives annotated
    /// and `removed` lists what disappeared. PAINT-THEN-SWEEP: creates/updates/
    /// moves land first, removes go LAST — a scene transition never shows a
    /// blank interval. "unchanged" elements are skipped entirely (this is also
    /// what prevents image re-uploads over BLE). Replay frames arrive
    /// all-"created" and reset retained bookkeeping first, because firmware
    /// silently drops updates to dead component ids. Rects compile to empty
    /// bordered text boxes (no shape primitive on current targets) and always
    /// get a visible border.
    func applySceneFrame(_ frame: SceneFrame) async {
        if frame.replay {
            await onSceneReplay(frame.appId)
        }
        // An id in `removed` that ALSO appears in `elements` is a type change
        // (the differ keys matches by type:id). Its removal must run BEFORE the
        // paint — registries key by id, so a post-paint sweep would delete the
        // just-painted replacement.
        let paintedIds = Set(frame.elements.map { $0.id })
        for id in frame.removed where paintedIds.contains(id) {
            await removeLayoutElement(id, layoutId: frame.appId)
        }
        for el in frame.elements {
            if !frame.replay, el.change == "unchanged" { continue }
            switch el.type {
            case "text":
                await drawLayoutText(
                    el.text ?? "", x: el.x, y: el.y, width: el.w, height: el.h,
                    borderWidth: el.border, borderRadius: el.radius,
                    elementId: el.id, layoutId: frame.appId
                )
            case "rect":
                await drawLayoutText(
                    "", x: el.x, y: el.y, width: el.w, height: el.h,
                    borderWidth: max(1, el.border), borderRadius: el.radius,
                    elementId: el.id, layoutId: frame.appId
                )
            case "image":
                if let data = el.data {
                    _ = await drawLayoutBitmap(
                        base64ImageData: data, x: el.x, y: el.y, width: el.w, height: el.h,
                        elementId: el.id, layoutId: frame.appId
                    )
                }
            default:
                Bridge.log("SGC: applySceneFrame: unknown element type \(el.type)")
            }
        }
        for id in frame.removed where !paintedIds.contains(id) {
            await removeLayoutElement(id, layoutId: frame.appId)
        }
    }

    // MARK: - Video recording (default: ignore custom settings, use saved defaults)

    func startVideoRecording(
        requestId: String, save: Bool, sound: Bool, width _: Int, height _: Int,
        fps _: Int, maxRecordingTimeMinutes _: Int
    ) {
        startVideoRecording(requestId: requestId, save: save, sound: sound)
    }

    func stopVideoRecording(requestId: String, webhookUrl _: String?, authToken _: String?) {
        stopVideoRecording(requestId: requestId)
    }

    // MARK: - Dashboard (default: combined wire format; Nex implements single-field)

    func setDashboardHeightOnly(_ height: Int) {
        let d = DeviceStore.shared.get("bluetooth", "dashboard_depth") as? Int ?? 2
        setDashboardPosition(height, d)
    }

    func setDashboardDepthOnly(_ depth: Int) {
        let h = DeviceStore.shared.get("bluetooth", "dashboard_height") as? Int ?? 4
        setDashboardPosition(h, depth)
    }

    // MARK: - Dashboard Menu (default no-op — only G2 supports this)

    func setDashboardMenu(_: [[String: Any]]) {}

    // MARK: - Notification Panel (default no-op — only G2 supports this)

    func showNotificationsPanel() async {}

    // MARK: - IMU (default no-op — only G2 streams accelerometer data)

    func setImuEnabled(_: Bool) async {
        Bridge.log("SGC: setImuEnabled not supported")
    }

    // MARK: - Calendar Events (default no-op — only G2 supports this)

    func sendCalendarEvents(_: [[String: Any]]) {}

    // MARK: - Dashboard Display Settings (default no-op — only G2 supports this)

    func sendDashboardDisplaySettings() {}

    // MARK: - Voice Activity Detection (default no-op — Mentra Live supports this)

    func sendVoiceActivityDetectionSetting() {}

    /// Default no-op; Mentra Live overrides when phone detects clock skew during gallery sync.
    func sendSetSystemTime(_: Int64) {
        Bridge.log("SGC: sendSetSystemTime not supported")
    }

    // MARK: - Default DeviceStore-backed property implementations

    var fullyBooted: Bool {
        DeviceStore.shared.get("glasses", "fullyBooted") as? Bool ?? false
    }

    var connected: Bool {
        DeviceStore.shared.get("glasses", "connected") as? Bool ?? false
    }

    var appVersion: String {
        DeviceStore.shared.get("glasses", "appVersion") as? String ?? ""
    }

    var buildNumber: String {
        DeviceStore.shared.get("glasses", "buildNumber") as? String ?? ""
    }

    var deviceModel: String {
        DeviceStore.shared.get("glasses", "deviceModel") as? String ?? ""
    }

    var androidVersion: String {
        DeviceStore.shared.get("glasses", "androidVersion") as? String ?? ""
    }

    var otaVersionUrl: String {
        DeviceStore.shared.get("glasses", "otaVersionUrl") as? String ?? ""
    }

    var firmwareVersion: String {
        DeviceStore.shared.get("glasses", "firmwareVersion") as? String ?? ""
    }

    var bluetoothMacAddress: String {
        DeviceStore.shared.get("glasses", "bluetoothMacAddress") as? String ?? ""
    }

    var serialNumber: String {
        DeviceStore.shared.get("glasses", "serialNumber") as? String ?? ""
    }

    var style: String {
        DeviceStore.shared.get("glasses", "style") as? String ?? ""
    }

    var color: String {
        DeviceStore.shared.get("glasses", "color") as? String ?? ""
    }

    var micEnabled: Bool {
        DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
    }

    var voiceActivityDetectionEnabled: Bool {
        DeviceStore.shared.get("glasses", "voiceActivityDetectionEnabled") as? Bool
            ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
    }

    var batteryLevel: Int {
        DeviceStore.shared.get("glasses", "batteryLevel") as? Int ?? -1
    }

    var headUp: Bool {
        DeviceStore.shared.get("glasses", "headUp") as? Bool ?? false
    }

    var charging: Bool {
        DeviceStore.shared.get("glasses", "charging") as? Bool ?? false
    }

    var caseOpen: Bool {
        DeviceStore.shared.get("glasses", "caseOpen") as? Bool ?? true
    }

    var caseRemoved: Bool {
        DeviceStore.shared.get("glasses", "caseRemoved") as? Bool ?? true
    }

    var caseCharging: Bool {
        DeviceStore.shared.get("glasses", "caseCharging") as? Bool ?? false
    }

    var caseBatteryLevel: Int {
        DeviceStore.shared.get("glasses", "caseBatteryLevel") as? Int ?? -1
    }

    var wifiSsid: String {
        DeviceStore.shared.get("glasses", "wifiSsid") as? String ?? ""
    }

    var wifiConnected: Bool {
        DeviceStore.shared.get("glasses", "wifiConnected") as? Bool ?? false
    }

    var wifiLocalIp: String {
        DeviceStore.shared.get("glasses", "wifiLocalIp") as? String ?? ""
    }

    var hotspotEnabled: Bool {
        DeviceStore.shared.get("glasses", "hotspotEnabled") as? Bool ?? false
    }

    var hotspotSsid: String {
        DeviceStore.shared.get("glasses", "hotspotSsid") as? String ?? ""
    }

    var hotspotPassword: String {
        DeviceStore.shared.get("glasses", "hotspotPassword") as? String ?? ""
    }

    var hotspotGatewayIp: String {
        DeviceStore.shared.get("glasses", "hotspotGatewayIp") as? String ?? ""
    }
}
