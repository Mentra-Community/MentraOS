//
//  InmoGo2.swift
//  MentraOS
//
//  SGCManager implementation for INMO Go2 smart glasses.
//
//  Hardware fingerprint:
//    ro.product.manufacturer = INMO
//    ro.product.model        = Go2
//    ro.product.device       = ima02_go2
//    ro.build.version.sdk    = 28  (Android 9)
//    ro.product.cpu.abilist  = armeabi-v7a,armeabi
//
//  BLE profile (confirmed via nRF Connect scan):
//    Advertised name : "INMO GO2"
//    Service UUID    : 00004860-0000-1000-8000-00805f9b34fb
//    TX (Notify)     : 00004861-0000-1000-8000-00805f9b34fb  (glasses → phone)
//    RX (Write)      : 00004862-0000-1000-8000-00805f9b34fb  (phone → glasses)
//    MTU             : up to 247 bytes
//
//  Wire format:
//    The Go2 runs standard Android (no BES2700 chip), so the ASG client
//    sends and receives plain UTF-8 JSON — no K900 ##...$$  binary framing.
//    `sendJson` encodes the JSON dict directly to UTF-8 and writes it on the
//    TX characteristic (withResponse).
//

import CoreBluetooth
import Foundation
import UIKit

// MARK: - Main Manager Class

@MainActor
class InmoGo2: NSObject, SGCManager {

    // -----------------------------------------------------------------------
    // MARK: SGCManager identity
    // -----------------------------------------------------------------------

    var type = DeviceTypes.INMO_GO2   // "INMO Go2"
    var hasMic = true
    var connectionState: String = ConnTypes.DISCONNECTED

    // -----------------------------------------------------------------------
    // MARK: BLE UUIDs  (confirmed from nRF Connect scan of production device)
    // -----------------------------------------------------------------------

    private let SERVICE_UUID  = CBUUID(string: "00004860-0000-1000-8000-00805f9b34fb")
    /// Notify characteristic — glasses → phone
    private let TX_CHAR_UUID  = CBUUID(string: "00004861-0000-1000-8000-00805f9b34fb")
    /// Write characteristic — phone → glasses
    private let RX_CHAR_UUID  = CBUUID(string: "00004862-0000-1000-8000-00805f9b34fb")

    // -----------------------------------------------------------------------
    // MARK: Prefs key
    // -----------------------------------------------------------------------

    private let PREFS_DEVICE_NAME = "InmoGo2LastConnectedDeviceName"

    // -----------------------------------------------------------------------
    // MARK: BLE objects  (iOS acts as central / client)
    // -----------------------------------------------------------------------

    private var centralManager: CBCentralManager?
    private var connectedPeripheral: CBPeripheral?
    private var txCharacteristic: CBCharacteristic?   // Notify — data FROM glasses
    private var rxCharacteristic: CBCharacteristic?   // Write  — data TO   glasses

    // -----------------------------------------------------------------------
    // MARK: Timing constants
    // -----------------------------------------------------------------------

    private let BASE_RECONNECT_DELAY_NS: UInt64   = 1_000_000_000   // 1 s
    private let MAX_RECONNECT_DELAY_NS: UInt64    = 30_000_000_000  // 30 s
    private let MAX_RECONNECT_ATTEMPTS            = 10
    private let CONNECTION_TIMEOUT_NS: UInt64     = 100_000_000_000 // 100 s
    private let HEARTBEAT_INTERVAL: TimeInterval  = 30.0
    private let READINESS_CHECK_INTERVAL: TimeInterval = 2.5

    // -----------------------------------------------------------------------
    // MARK: State
    // -----------------------------------------------------------------------

    private var isScanning         = false
    private var isConnecting       = false
    private var isKilled           = false
    private var reconnectAttempts  = 0
    private var globalMessageId    = 0

    private var fullyBooted: Bool {
        get { GlassesStore.shared.get("glasses", "fullyBooted") as? Bool ?? false }
        set { GlassesStore.shared.apply("glasses", "fullyBooted", newValue) }
    }
    private var connected: Bool {
        get { GlassesStore.shared.get("glasses", "connected") as? Bool ?? false }
        set { GlassesStore.shared.apply("glasses", "connected", newValue) }
    }

    // Discovered peripherals cache  (name → peripheral)
    private var discoveredPeripherals = [String: CBPeripheral]()

    // -----------------------------------------------------------------------
    // MARK: Queues & queuing
    // -----------------------------------------------------------------------

    private let bluetoothQueue = DispatchQueue(label: "InmoGo2Bluetooth", qos: .userInitiated)
    private let commandQueue   = CommandQueue()
    private var lastSendTimeMs: TimeInterval = 0

    // Pending-message ACK tracking
    private var pending: PendingMessage?
    private var pendingMessageTimer: Timer?

    // -----------------------------------------------------------------------
    // MARK: Timers
    // -----------------------------------------------------------------------

    private var heartbeatTimer:         Timer?
    private var heartbeatCounter        = 0
    private var readinessCheckTimer:    Timer?
    private var readinessCheckCounter   = 0
    private var connectionTimeoutTimer: Timer?
    private var reconnectionWorkItem:   DispatchWorkItem?
    private var readinessCheckDispatchTimer: DispatchSourceTimer?

    // -----------------------------------------------------------------------
    // MARK: Supporting types  (mirrors MentraLive internal types)
    // -----------------------------------------------------------------------

    class PendingMessage {
        let data:    Data
        let id:      String
        let retries: Int
        init(data: Data, id: String, retries: Int) {
            self.data    = data
            self.id      = id
            self.retries = retries
        }
    }

    actor CommandQueue {
        private var commands: [PendingMessage] = []
        func enqueue(_ cmd: PendingMessage) { commands.append(cmd) }
        func pushToFront(_ cmd: PendingMessage) { commands.insert(cmd, at: 0) }
        func dequeue() -> PendingMessage? {
            guard !commands.isEmpty else { return nil }
            return commands.removeFirst()
        }
    }

    // -----------------------------------------------------------------------
    // MARK: Init / deinit
    // -----------------------------------------------------------------------

    override init() {
        super.init()
        setupCommandQueue()
        Bridge.log("GO2: InmoGo2 SGC initialized")
    }

    deinit {
        centralManager?.delegate = nil
        connectedPeripheral?.delegate = nil
        Bridge.log("GO2: InmoGo2 deinitialized")
    }

    func cleanup() { destroy() }

    // -----------------------------------------------------------------------
    // MARK: Command queue pump
    // -----------------------------------------------------------------------

    private func setupCommandQueue() {
        Task.detached { [weak self] in
            guard let self else { return }
            while true {
                let pendingIsNil = await MainActor.run { self.pending == nil }
                if pendingIsNil {
                    if let cmd = await self.commandQueue.dequeue() {
                        await self.processSendQueue(cmd)
                    }
                }
                try? await Task.sleep(nanoseconds: 100_000_000) // 100 ms
            }
        }
    }

    private func processSendQueue(_ message: PendingMessage) async {
        guard let peripheral = connectedPeripheral,
              let rxChar = rxCharacteristic else { return }

        try? await Task.sleep(nanoseconds: 1_000_000) // 1 ms pacing
        lastSendTimeMs = Date().timeIntervalSince1970 * 1000

        peripheral.writeValue(message.data, for: rxChar, type: .withResponse)

        if message.id != "-1" {
            pending = message
            DispatchQueue.main.async { [weak self] in
                self?.pendingMessageTimer?.invalidate()
                self?.pendingMessageTimer = Timer.scheduledTimer(
                    withTimeInterval: 1, repeats: false
                ) { [weak self] _ in self?.handlePendingMessageTimeout() }
            }
        }
    }

    private func handlePendingMessageTimeout() {
        guard let pendingMessage = pending else { return }
        Bridge.log("GO2: ⚠️ Message timeout mId=\(pendingMessage.id), retry \(pendingMessage.retries + 1)/3")
        pending = nil
        if pendingMessage.retries < 3 {
            let retry = PendingMessage(data: pendingMessage.data, id: pendingMessage.id, retries: pendingMessage.retries + 1)
            Task { await commandQueue.pushToFront(retry) }
        } else {
            Bridge.log("GO2: ❌ Message failed after 3 retries mId=\(pendingMessage.id)")
        }
    }

    // -----------------------------------------------------------------------
    // MARK: SGCManager stubs (display / controller — not applicable to Go2)
    // -----------------------------------------------------------------------

    func setDashboardPosition(_: Int, _: Int) {}
    func setSilentMode(_: Bool) {}
    func exit() {}
    func showDashboard() {}
    func displayBitmap(base64ImageData _: String) async -> Bool { return true }
    func sendDoubleTextWall(_: String, _: String) {}
    func setHeadUpAngle(_: Int) {}
    func getBatteryStatus() {}
    func setBrightness(_: Int, autoMode _: Bool) {}
    func clearDisplay() {}
    func sendTextWall(_: String) {}
    func connectController() {}
    func disconnectController() {}
    func dbg1() {}
    func dbg2() {}
    func sortMicRanking(list: [String]) -> [String] { return list }

    func ping() {
        Bridge.log("GO2: ping()")
        keepAwake()
    }

    // -----------------------------------------------------------------------
    // MARK: Missing SGCManager protocol stubs
    // -----------------------------------------------------------------------

    /// Camera LED — Go2 uses torch as recording indicator; no separate LED protocol.
    func sendButtonCameraLedSetting() {
        let enabled = GlassesStore.shared.get("core", "button_camera_led") as? Bool ?? true
        sendJson(["type": "button_camera_led", "enabled": enabled], wakeUp: true)
    }

    /// Camera FOV — send to ASG client for lens configuration.
    func sendCameraFovSetting() {
        let settings = GlassesStore.shared.get("core", "camera_fov") as? [String: Any]
            ?? ["fov": 118, "roi_position": 0]
        let fov         = settings["fov"]          as? Int ?? 118
        let roiPosition = settings["roi_position"] as? Int ?? 0
        sendJson([
            "type": "camera_fov_setting",
            "params": ["fov": fov, "roi_position": roiPosition],
        ], wakeUp: true)
    }

    /// No-arg variant required by protocol — reads value from GlassesStore.
    func sendButtonMaxRecordingTime() {
        let maxTime = GlassesStore.shared.get("core", "button_max_recording_time") as? Int ?? 10
        sendButtonMaxRecordingTime(maxTime)
    }

    /// RGB LED control — Go2 has no RGB LED; no-op.
    func sendRgbLedControl(
        requestId _: String, packageName _: String?, action _: String,
        color _: String?, ontime _: Int, offtime _: Int, count _: Int
    ) {
        Bridge.log("GO2: sendRgbLedControl — no RGB LED on INMO Go2, ignoring")
    }

    /// Incident log upload — forward incidentId to ASG client for on-device log collection.
    func sendIncidentId(_ incidentId: String, apiBaseUrl: String?) {
        var base = (apiBaseUrl ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { base = "https://api.mentra.glass" }
        while base.hasSuffix("/") { base = String(base.dropLast()) }
        sendJson([
            "type":       "upload_incident_logs",
            "incidentId": incidentId,
            "apiBaseUrl": base,
        ], wakeUp: true)
    }

    /// Gallery status query — request current photo/video counts from ASG client.
    func queryGalleryStatus() {
        sendJson(["type": "query_gallery_status"], wakeUp: true)
    }

    /// Gallery mode — tell ASG client whether to save media to gallery.
    func sendGalleryMode() {
        let active = GlassesStore.shared.get("core", "gallery_mode") as? Bool ?? false
        sendJson([
            "type":      "save_in_gallery_mode",
            "active":    active,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ], wakeUp: true)
    }

    // -----------------------------------------------------------------------
    // MARK: Microphone
    // -----------------------------------------------------------------------

    func setMicEnabled(_ enabled: Bool) {
        Bridge.log("GO2: 🎤 setMicEnabled(\(enabled))")
        GlassesStore.shared.apply("glasses", "micEnabled", enabled)
        // Go2 mic is handled entirely on the Android side via ASG client;
        // we simply notify it of the desired state through the standard JSON channel.
        let json: [String: Any] = ["type": "set_mic_enabled", "enabled": enabled]
        sendJson(json, wakeUp: true)
    }

    // -----------------------------------------------------------------------
    // MARK: Scanning / connection lifecycle
    // -----------------------------------------------------------------------

    func findCompatibleDevices() {
        Bridge.log("GO2: findCompatibleDevices()")
        Task {
            if centralManager == nil {
                centralManager = CBCentralManager(
                    delegate: self, queue: bluetoothQueue,
                    options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
                )
                try? await Task.sleep(nanoseconds: 100 * 1_000_000) // 100 ms warm-up
            }
            UserDefaults.standard.set("", forKey: PREFS_DEVICE_NAME)
            startScan()
        }
    }

    func connectById(_ deviceName: String) {
        Bridge.log("GO2: connectById(\(deviceName))")
        UserDefaults.standard.set(deviceName, forKey: PREFS_DEVICE_NAME)

        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self, queue: bluetoothQueue,
                options: ["CBCentralManagerOptionShowPowerAlertKey": 0]
            )
        }

        // Check for already-connected peripherals first
        let connectedPeripherals = centralManager!.retrieveConnectedPeripherals(
            withServices: [SERVICE_UUID]
        )
        for peripheral in connectedPeripherals {
            if let name = peripheral.name, isCompatibleDeviceName(name) {
                Bridge.log("GO2: Found already-connected peripheral: \(name)")
                discoveredPeripherals[name] = peripheral
                emitDiscoveredDevice(name, identifier: peripheral.identifier.uuidString)
                if let saved = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
                   saved == name
                {
                    connectToDevice(peripheral)
                    return
                }
            }
        }
        startScan()
    }

    func getConnectedBluetoothName() -> String? {
        return connectedPeripheral?.name
    }

    func forget() {
        Bridge.log("GO2: forget()")
        if isScanning { stopScan(); emitStopScanEvent() }
        destroy()
    }

    @objc func disconnect() {
        Bridge.log("GO2: disconnect()")
        destroy()
    }

    // -----------------------------------------------------------------------
    // MARK: Scan internals
    // -----------------------------------------------------------------------

    private func startScan() {
        guard let cm = centralManager, cm.state == .poweredOn else {
            Bridge.log("GO2: Cannot scan — Bluetooth not powered on")
            return
        }
        Bridge.log("GO2: Starting BLE scan for INMO GO2")
        isScanning = true
        startReadinessCheckLoop()

        cm.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )

        // Emit already-cached peripherals
        for (_, peripheral) in discoveredPeripherals {
            Bridge.log("GO2: (already discovered) \(peripheral.name ?? "Unknown")")
            emitDiscoveredDevice(peripheral.name!)
        }
    }

    func stopScan() {
        guard isScanning else { return }
        centralManager?.stopScan()
        isScanning = false
        GlassesStore.shared.apply(ObservableStore.coreCategory, "searching", false)
        Bridge.log("GO2: BLE scan stopped")
    }

    /// Returns true if the BLE advertisement name belongs to an INMO Go2.
    /// The Go2 advertises as "INMO GO2" (confirmed). We also accept a bare
    /// "INMO_GO2" in case the ASG client overrides the name in future builds.
    private func isCompatibleDeviceName(_ name: String) -> Bool {
        let n = name.uppercased()
        return n == "INMO GO2" || n == "INMO_GO2"
    }

    // -----------------------------------------------------------------------
    // MARK: Connection internals
    // -----------------------------------------------------------------------

    private func connectToDevice(_ peripheral: CBPeripheral) {
        Bridge.log("GO2: Connecting to \(peripheral.identifier.uuidString)")
        isConnecting = true
        updateConnectionState(ConnTypes.CONNECTING)
        connectedPeripheral = peripheral
        peripheral.delegate = self
        startConnectionTimeout()
        centralManager?.connect(peripheral, options: nil)
    }

    private func handleReconnection() {
        guard !isKilled else {
            Bridge.log("GO2: Reconnection aborted — device killed")
            return
        }
        if reconnectAttempts >= MAX_RECONNECT_ATTEMPTS {
            Bridge.log("GO2: Max reconnection attempts reached")
            reconnectAttempts = 0
            updateConnectionState(ConnTypes.DISCONNECTED)
            connected = false
            fullyBooted = false
            return
        }

        let delayNs = min(
            BASE_RECONNECT_DELAY_NS * UInt64(1 << reconnectAttempts),
            MAX_RECONNECT_DELAY_NS
        )
        reconnectAttempts += 1
        updateConnectionState(ConnTypes.CONNECTING)

        Bridge.log("GO2: Reconnect attempt \(reconnectAttempts) in \(Double(delayNs) / 1e9)s")

        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.connectedPeripheral == nil, !self.isKilled else { return }
            if let lastName = UserDefaults.standard.string(forKey: self.PREFS_DEVICE_NAME),
               !lastName.isEmpty
            {
                self.startScan()
            } else {
                self.updateConnectionState(ConnTypes.DISCONNECTED)
            }
        }
        reconnectionWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .nanoseconds(Int(delayNs)), execute: workItem
        )
    }

    // -----------------------------------------------------------------------
    // MARK: sendJson  (plain UTF-8 JSON — no K900 framing)
    // -----------------------------------------------------------------------

    /// Encode `json` as UTF-8 JSON and queue it for BLE transmission to the Go2.
    ///
    /// The Go2 ASG client speaks plain JSON over the 4862 write characteristic.
    /// Unlike MentraLive (which has a BES2700 chip requiring `##...$$` framing),
    /// no binary wrapper is applied here.
    func sendJson(_ json: [String: Any], wakeUp: Bool = false, requireAck: Bool = true) {
        do {
            var payload = json
            var trackingId = "-1"

            if requireAck {
                payload["mId"] = globalMessageId
                trackingId = String(globalMessageId)
                globalMessageId += 1
            }

            let data = try JSONSerialization.data(withJSONObject: payload)
            queueSend(data, id: trackingId)

            if let dbg = String(data: data, encoding: .utf8) {
                Bridge.log("GO2: → \(dbg.prefix(200))")
            }
        } catch {
            Bridge.log("GO2: sendJson error: \(error)")
        }
    }

    func queueSend(_ data: Data, id: String) {
        Task { await commandQueue.enqueue(PendingMessage(data: data, id: id, retries: 0)) }
    }

    // -----------------------------------------------------------------------
    // MARK: Incoming data processing
    // -----------------------------------------------------------------------

    /// All data received from the Go2 is plain UTF-8 JSON starting with `{`.
    private func processReceivedData(_ data: Data) {
        guard !data.isEmpty else { return }
        let bytes = [UInt8](data)

        // JSON starts with '{'
        if bytes[0] == 0x7B,
           let jsonString = String(data: data, encoding: .utf8),
           jsonString.hasPrefix("{")
        {
            processJsonMessage(jsonString)
        } else {
            Bridge.log("GO2: ⚠️ Unexpected non-JSON data (\(data.count) bytes)")
        }
    }

    private func processJsonMessage(_ jsonString: String) {
        do {
            guard let data = jsonString.data(using: .utf8),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            processJsonObject(json)
        } catch {
            Bridge.log("GO2: JSON parse error: \(error)")
        }
    }

    private func processJsonObject(_ json: [String: Any]) {
        // Clear pending ACK if this is the acknowledgement we're waiting for
        if let type = json["type"] as? String, type == "msg_ack" {
            if let mId = json["mId"] as? Int, String(mId) == pending?.id {
                Bridge.log("GO2: ✅ ACK for mId=\(mId)")
                pending = nil
                pendingMessageTimer?.invalidate()
                pendingMessageTimer = nil
            }
            return
        }

        // Send ACK back to glasses for messages that carry a message ID
        if let mId = json["mId"] as? Int {
            sendAckToGlasses(messageId: mId)
        }

        guard let type = json["type"] as? String else {
            Bridge.log("GO2: JSON missing 'type' field — ignoring")
            return
        }

        switch type {

        case "glasses_ready":
            handleGlassesReady()

        case "battery_status":
            let level      = json["level"]    as? Int  ?? 0
            let isCharging = json["charging"] as? Bool ?? false
            updateBatteryStatus(level: level, isCharging: isCharging)

        case "wifi_status":
            let isConn = json["connected"] as? Bool   ?? false
            let ssid   = json["ssid"]      as? String ?? ""
            let ip     = json["local_ip"]  as? String ?? ""
            updateWifiStatus(connected: isConn, ssid: ssid, ip: ip)

        case "wifi_scan_result":
            if let networks = json["networks_neo"] as? [[String: Any]] {
                Bridge.updateWifiScanResults(networks)
            }

        case "button_press":
            let buttonId  = json["buttonId"]  as? String ?? "unknown"
            let pressType = json["pressType"] as? String ?? "short"
            Bridge.log("GO2: 🔘 Button press — id=\(buttonId) type=\(pressType)")
            Bridge.sendButtonPress(buttonId: buttonId, pressType: pressType)

        case "touch_event":
            let gesture   = json["gesture_name"] as? String ?? "unknown"
            let timestamp = json["timestamp"]    as? Int64  ?? Int64(Date().timeIntervalSince1970 * 1000)
            Bridge.sendTouchEvent(
                deviceModel: DeviceTypes.INMO_GO2,
                gestureName: gesture,
                timestamp: timestamp
            )

        case "version_info", "version_info_1", "version_info_2":
            handleVersionInfo(json)

        case "ota_status":
            Bridge.sendTypedMessage("ota_status", body: json)

        case "stream_status":
            Bridge.sendTypedMessage("stream_status", body: json)

        case "gallery_status":
            Bridge.sendTypedMessage("gallery_status", body: json)

        case "hotspot_status_update":
            let enabled  = json["hotspot_enabled"]    as? Bool   ?? false
            let ssid     = json["hotspot_ssid"]        as? String ?? ""
            let password = json["hotspot_password"]    as? String ?? ""
            let ip       = json["hotspot_gateway_ip"]  as? String ?? ""
            updateHotspotStatus(enabled: enabled, ssid: ssid, password: password, ip: ip)

        case "hotspot_error":
            let msg  = json["error_message"] as? String ?? "Unknown hotspot error"
            let ts   = json["timestamp"]     as? Int64  ?? Int64(Date().timeIntervalSince1970 * 1000)
            Bridge.sendTypedMessage("hotspot_error", body: ["error_message": msg, "timestamp": ts])

        default:
            Bridge.log("GO2: Unhandled message type: \(type)")
        }
    }

    // -----------------------------------------------------------------------
    // MARK: Glasses-ready handler
    // -----------------------------------------------------------------------

    private func handleGlassesReady() {
        Bridge.log("GO2: 🎉 glasses_ready received — SOC booted")

        stopReadinessCheckLoop()

        // Clear stale version fields
        GlassesStore.shared.apply("glasses", "buildNumber",  "")
        GlassesStore.shared.apply("glasses", "appVersion",   "")
        GlassesStore.shared.apply("glasses", "besFwVersion", "")
        GlassesStore.shared.apply("glasses", "mtkFwVersion", "")

        requestBatteryStatus()
        requestWifiStatus()
        requestVersionInfo()
        sendCoreTokenToAsgClient()
        sendStoredUserEmailToAsgClient()
        sendUserSettings()
        setTouchEventReporting(true)

        startHeartbeat()

        fullyBooted = true
        connected   = true
        updateConnectionState(ConnTypes.CONNECTED)
    }

    // -----------------------------------------------------------------------
    // MARK: ACK helpers
    // -----------------------------------------------------------------------

    private func sendAckToGlasses(messageId: Int) {
        let ack: [String: Any] = ["type": "msg_ack", "mId": messageId]
        sendJson(ack, requireAck: false)
    }

    // -----------------------------------------------------------------------
    // MARK: Status requests & outgoing commands
    // -----------------------------------------------------------------------

    private func requestBatteryStatus() {
        sendJson(["type": "request_battery_status"], wakeUp: true)
    }

    private func requestWifiStatus() {
        sendJson(["type": "request_wifi_status"], wakeUp: true)
    }

    func requestVersionInfo() {
        sendJson(["type": "request_version"])
    }

    func keepAwake() {
        sendJson(["type": "keep_awake", "timestamp": Int64(Date().timeIntervalSince1970 * 1000)], wakeUp: true)
    }

    func sendOtaStart() {
        sendJson(["type": "ota_start", "timestamp": Int(Date().timeIntervalSince1970 * 1000)], wakeUp: true)
    }

    func sendOtaQueryStatus() {
        sendJson(["type": "ota_query_status", "timestamp": Int(Date().timeIntervalSince1970 * 1000)], wakeUp: true)
    }

    func requestWifiScan() {
        sendJson(["type": "request_wifi_scan"], wakeUp: true)
    }

    func sendWifiCredentials(_ ssid: String, _ password: String) {
        guard !ssid.isEmpty else { return }
        sendJson(["type": "set_wifi_credentials", "ssid": ssid, "password": password], wakeUp: true)
    }

    func sendHotspotState(_ enabled: Bool) {
        sendJson(["type": "set_hotspot_state", "enabled": enabled], wakeUp: true)
    }

    func forgetWifiNetwork(_ ssid: String) {
        guard !ssid.isEmpty else { return }
        sendJson(["type": "forget_wifi", "ssid": ssid], wakeUp: true)
    }

    func sendUserEmailToGlasses(_ email: String) {
        guard !email.isEmpty else { return }
        sendJson(["type": "user_email", "email": email], wakeUp: true)
    }

    @objc func sendShutdown() {
        sendJson(["type": "shutdown"])
    }

    @objc func sendReboot() {
        sendJson(["type": "reboot"])
    }

    func requestPhoto(
        _ requestId: String, appId: String, size: String?, webhookUrl: String?,
        authToken: String?, compress: String?, flash: Bool, sound: Bool,
        exposureTimeNs: Double?
    ) {
        var json: [String: Any] = [
            "type":      "take_photo",
            "requestId": requestId,
            "appId":     appId,
            "flash":     flash,
            "sound":     sound,
        ]
        if let size, ["small", "medium", "large", "full"].contains(size) {
            json["size"] = size
        } else {
            json["size"] = "medium"
        }
        json["compress"] = compress ?? "none"
        if let wh = webhookUrl, !wh.isEmpty { json["webhookUrl"] = wh }
        if let at = authToken,  !at.isEmpty { json["authToken"]  = at }
        if let e = exposureTimeNs, e.isFinite, e > 0, e <= Double(Int64.max) {
            json["exposureTimeNs"] = Int64(e)
        }
        sendJson(json, wakeUp: true)
    }

    func startStream(_ message: [String: Any]) {
        var json = message; json.removeValue(forKey: "timestamp")
        sendJson(json, wakeUp: true)
    }

    func stopStream() {
        sendJson(["type": "stop_stream"], wakeUp: true)
    }

    func sendStreamKeepAlive(_ message: [String: Any]) {
        sendJson(message)
    }

    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool) {
        startVideoRecording(requestId: requestId, save: save, flash: flash, sound: sound, width: 0, height: 0, fps: 0)
    }

    func startVideoRecording(requestId: String, save: Bool, flash: Bool, sound: Bool, width: Int, height: Int, fps: Int) {
        var json: [String: Any] = [
            "type": "start_video_recording",
            "request_id": requestId,
            "save": save, "flash": flash, "sound": sound,
        ]
        if width > 0, height > 0 {
            json["settings"] = ["width": width, "height": height, "fps": fps > 0 ? fps : 30]
        }
        sendJson(json)
    }

    func stopVideoRecording(requestId: String) {
        sendJson(["type": "stop_video_recording", "request_id": requestId])
    }

    // Touch event reporting
    private func setTouchEventReporting(_ enabled: Bool) {
        sendJson(["type": "set_touch_event_reporting", "enabled": enabled])
    }

    // -----------------------------------------------------------------------
    // MARK: User settings
    // -----------------------------------------------------------------------

    private func sendUserSettings() {
        sendButtonVideoRecordingSettings()
        let maxTime = GlassesStore.shared.get("core", "button_max_recording_time") as? Int ?? 10
        sendButtonMaxRecordingTime(maxTime)
        sendButtonPhotoSettings()
    }

    func sendButtonVideoRecordingSettings() {
        let settings = GlassesStore.shared.get("core", "button_video_settings") as? [String: Any]
            ?? ["width": 1280, "height": 720, "fps": 30]
        let width  = (settings["width"]  as? Int ?? 1280).clampedPositive(default: 1280)
        let height = (settings["height"] as? Int ?? 720 ).clampedPositive(default: 720)
        let fps    = (settings["fps"]    as? Int ?? 30  ).clampedPositive(default: 30)
        sendJson([
            "type": "button_video_recording_setting",
            "params": ["width": width, "height": height, "fps": fps],
        ], wakeUp: true)
    }

    func sendButtonMaxRecordingTime(_ minutes: Int) {
        sendJson(["type": "button_max_recording_time", "minutes": minutes], wakeUp: true)
    }

    func sendButtonPhotoSettings() {
        let size = GlassesStore.shared.get("core", "button_photo_size") as? String ?? "medium"
        sendJson(["type": "button_photo_setting", "size": size], wakeUp: true)
    }

    // -----------------------------------------------------------------------
    // MARK: Auth / token propagation
    // -----------------------------------------------------------------------

    private func sendCoreTokenToAsgClient() {
        let token = GlassesStore.shared.get("core", "core_token") as? String ?? ""
        guard !token.isEmpty else { return }
        sendJson([
            "type":      "auth_token",
            "coreToken": token,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ])
    }

    private func sendStoredUserEmailToAsgClient() {
        let email = GlassesStore.shared.store.get("core", "auth_email") as? String ?? ""
        guard !email.isEmpty else { return }
        sendUserEmailToGlasses(email)
    }

    // -----------------------------------------------------------------------
    // MARK: Heartbeat
    // -----------------------------------------------------------------------

    private func startHeartbeat() {
        heartbeatCounter = 0
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.heartbeatTimer?.invalidate()
            self.heartbeatTimer = Timer.scheduledTimer(
                withTimeInterval: self.HEARTBEAT_INTERVAL, repeats: true
            ) { [weak self] _ in self?.sendHeartbeat() }
        }
    }

    private func stopHeartbeat() {
        DispatchQueue.main.async { [weak self] in
            self?.heartbeatTimer?.invalidate()
            self?.heartbeatTimer = nil
        }
    }

    private func sendHeartbeat() {
        heartbeatCounter += 1
        sendJson([
            "type":      "heartbeat",
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ], requireAck: false)
        if heartbeatCounter % 10 == 0 { requestBatteryStatus() }
    }

    // -----------------------------------------------------------------------
    // MARK: Readiness check loop
    // -----------------------------------------------------------------------

    private func startReadinessCheckLoop() {
        readinessCheckCounter = 0
        stopReadinessCheckLoop()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + READINESS_CHECK_INTERVAL, repeating: READINESS_CHECK_INTERVAL)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.readinessCheckCounter += 1
            if !self.fullyBooted, self.connectionState == ConnTypes.CONNECTING {
                Bridge.log("GO2: 🔄 Readiness check \(self.readinessCheckCounter) — waiting for glasses_ready")
                let json: [String: Any] = ["type": "phone_ready", "timestamp": Int64(Date().timeIntervalSince1970 * 1000)]
                self.sendJson(json, wakeUp: true)
            } else {
                self.stopReadinessCheckLoop()
            }
        }
        timer.resume()
        readinessCheckDispatchTimer = timer
    }

    private func stopReadinessCheckLoop() {
        readinessCheckDispatchTimer?.cancel()
        readinessCheckDispatchTimer = nil
    }

    // -----------------------------------------------------------------------
    // MARK: Connection timeout
    // -----------------------------------------------------------------------

    private func startConnectionTimeout() {
        connectionTimeoutTimer?.invalidate()
        connectionTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: Double(CONNECTION_TIMEOUT_NS) / 1e9, repeats: false
        ) { [weak self] _ in
            guard let self else { return }
            if self.isConnecting, self.connectionState != ConnTypes.CONNECTED {
                Bridge.log("GO2: Connection timeout")
                self.isConnecting = false
                if let p = self.connectedPeripheral { self.centralManager?.cancelPeripheralConnection(p) }
                self.handleReconnection()
            }
        }
    }

    private func stopConnectionTimeout() {
        connectionTimeoutTimer?.invalidate()
        connectionTimeoutTimer = nil
    }

    // -----------------------------------------------------------------------
    // MARK: Timers: stop-all
    // -----------------------------------------------------------------------

    private func stopAllTimers() {
        stopHeartbeat()
        stopReadinessCheckLoop()
        stopConnectionTimeout()
        pendingMessageTimer?.invalidate()
        pendingMessageTimer = nil
        reconnectionWorkItem?.cancel()
        reconnectionWorkItem = nil
    }

    // -----------------------------------------------------------------------
    // MARK: State helpers
    // -----------------------------------------------------------------------

    private func updateConnectionState(_ state: String) {
        connectionState = state
        GlassesStore.shared.apply("glasses", "connectionState", state)
        if state == ConnTypes.DISCONNECTED {
            GlassesStore.shared.apply("glasses", "signalStrength", -1)
            GlassesStore.shared.apply("glasses", "signalStrengthUpdatedAt", 0)
        }
    }

    private func updateBatteryStatus(level: Int, isCharging: Bool) {
        GlassesStore.shared.apply("glasses", "batteryLevel", level)
        GlassesStore.shared.apply("glasses", "charging", isCharging)
        if level >= 0 { Bridge.sendBatteryStatus(level: level, charging: isCharging) }
    }

    private func updateWifiStatus(connected: Bool, ssid: String, ip: String) {
        GlassesStore.shared.apply("glasses", "wifiConnected", connected)
        GlassesStore.shared.apply("glasses", "wifiSsid", ssid)
        GlassesStore.shared.apply("glasses", "wifiLocalIp", ip)
        Bridge.sendWifiStatusChange(connected: connected, ssid: ssid, localIp: ip)
    }

    private func updateHotspotStatus(enabled: Bool, ssid: String, password: String, ip: String) {
        GlassesStore.shared.apply("glasses", "hotspotEnabled", enabled)
        GlassesStore.shared.apply("glasses", "hotspotSsid", ssid)
        GlassesStore.shared.apply("glasses", "hotspotPassword", password)
        GlassesStore.shared.apply("glasses", "hotspotGatewayIp", ip)
        if let status = HotspotStatus.fromStoreFields(
            enabled: enabled, ssid: ssid, password: password, localIp: ip
        ) {
            Bridge.sendTypedMessage("hotspot_status_change", body: status.values)
        }
    }

    private func handleVersionInfo(_ json: [String: Any]) {
        let appVersion      = json["app_version"]     as? String ?? ""
        let buildNumber     = json["build_number"]    as? String ?? ""
        let deviceModel     = json["device_model"]    as? String ?? ""
        let androidVersion  = json["android_version"] as? String ?? ""
        let otaVersionUrl   = json["ota_version_url"] as? String ?? ""
        let firmwareVersion = json["firmware_version"] as? String ?? ""
        let btMacAddress    = json["bt_mac_address"]  as? String ?? ""

        GlassesStore.shared.apply("glasses", "appVersion",     appVersion)
        GlassesStore.shared.apply("glasses", "buildNumber",    buildNumber)
        GlassesStore.shared.apply("glasses", "deviceModel",    deviceModel)
        GlassesStore.shared.apply("glasses", "androidVersion", androidVersion)
        GlassesStore.shared.apply("glasses", "otaVersionUrl",  otaVersionUrl)
        GlassesStore.shared.apply("glasses", "fwVersion",      firmwareVersion)

        Bridge.log("GO2: Version — app=\(appVersion) build=\(buildNumber) device=\(deviceModel) android=\(androidVersion)")

        Bridge.sendTypedMessage("version_info", body: [
            "app_version":      appVersion,
            "build_number":     buildNumber,
            "device_model":     deviceModel,
            "android_version":  androidVersion,
            "ota_version_url":  otaVersionUrl,
            "firmware_version": firmwareVersion,
            "bt_mac_address":   btMacAddress,
        ])
    }

    // -----------------------------------------------------------------------
    // MARK: Event emission
    // -----------------------------------------------------------------------

    private func emitDiscoveredDevice(_ name: String, identifier: String = "", rssi: Int? = nil) {
        Bridge.sendDiscoveredDevice(DeviceTypes.INMO_GO2, name, deviceAddress: identifier, rssi: rssi)
    }

    private func emitStopScanEvent() {
        Bridge.sendTypedMessage("compatible_glasses_search_stop", body: [
            "compatible_glasses_search_stop": ["device_model": DeviceTypes.INMO_GO2],
        ])
    }

    // -----------------------------------------------------------------------
    // MARK: Cleanup
    // -----------------------------------------------------------------------

    private func destroy() {
        Bridge.log("GO2: Destroying InmoGo2")
        isKilled = true
        if isScanning { stopScan(); emitStopScanEvent() }
        stopAllTimers()
        if let p = connectedPeripheral { centralManager?.cancelPeripheralConnection(p) }
        GlassesStore.shared.apply("glasses", "connected",      false)
        GlassesStore.shared.apply("glasses", "fullyBooted",    false)
        GlassesStore.shared.apply("glasses", "wifiConnected",  false)
        GlassesStore.shared.apply("glasses", "wifiSsid",       "")
        GlassesStore.shared.apply("glasses", "wifiLocalIp",    "")
        GlassesStore.shared.apply("glasses", "hotspotEnabled", false)
        GlassesStore.shared.apply("glasses", "hotspotSsid",    "")
        GlassesStore.shared.apply("glasses", "hotspotPassword","")
        GlassesStore.shared.apply("glasses", "hotspotGatewayIp","")
        connectedPeripheral = nil
        centralManager?.delegate = nil
        centralManager = nil
        updateConnectionState(ConnTypes.DISCONNECTED)
    }
}

// MARK: - CBCentralManagerDelegate

extension InmoGo2: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            Bridge.log("GO2: Bluetooth powered on")
            if let saved = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME),
               !saved.isEmpty
            {
                startScan()
            }
        case .poweredOff:
            Bridge.log("GO2: Bluetooth powered off")
            updateConnectionState(ConnTypes.DISCONNECTED)
        case .unauthorized:
            Bridge.log("GO2: Bluetooth unauthorized")
            updateConnectionState(ConnTypes.DISCONNECTED)
        case .unsupported:
            Bridge.log("GO2: Bluetooth unsupported")
            updateConnectionState(ConnTypes.DISCONNECTED)
        default:
            Bridge.log("GO2: Bluetooth state: \(central.state.rawValue)")
        }
    }

    func centralManager(
        _: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData _: [String: Any], rssi: NSNumber
    ) {
        guard let name = peripheral.name, isCompatibleDeviceName(name) else { return }

        Bridge.log("GO2: 🔍 Found INMO GO2: \(name) (\(peripheral.identifier.uuidString)) RSSI=\(rssi)")
        discoveredPeripherals[name] = peripheral
        emitDiscoveredDevice(name, identifier: peripheral.identifier.uuidString, rssi: rssi.intValue)

        if let saved = UserDefaults.standard.string(forKey: PREFS_DEVICE_NAME), saved == name {
            Bridge.log("GO2: Found remembered device, connecting: \(name)")
            centralManager?.stopScan()
            isScanning = false
            connectToDevice(peripheral)
        }
    }

    func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Bridge.log("GO2: ✅ GATT connected — discovering services…")
        stopConnectionTimeout()
        isConnecting = false
        connectedPeripheral = peripheral
        if let name = peripheral.name {
            UserDefaults.standard.set(name, forKey: PREFS_DEVICE_NAME)
            GlassesStore.shared.apply("glasses", "bluetoothName", name)
        }
        GlassesStore.shared.apply("core", "device_address", peripheral.identifier.uuidString)
        peripheral.discoverServices([SERVICE_UUID])
        reconnectAttempts = 0
    }

    func centralManager(_: CBCentralManager, didDisconnectPeripheral _: CBPeripheral, error _: Error?) {
        Bridge.log("GO2: Disconnected from GATT server")
        isConnecting   = false
        connectedPeripheral = nil
        fullyBooted    = false
        connected      = false
        updateConnectionState(ConnTypes.DISCONNECTED)
        stopAllTimers()
        txCharacteristic = nil
        rxCharacteristic = nil
        if !isKilled { handleReconnection() }
    }

    func centralManager(_: CBCentralManager, didFailToConnect _: CBPeripheral, error: Error?) {
        Bridge.log("GO2: Failed to connect: \(error?.localizedDescription ?? "unknown")")
        stopConnectionTimeout()
        isConnecting   = false
        connectedPeripheral = nil
        updateConnectionState(ConnTypes.DISCONNECTED)
        if !isKilled { handleReconnection() }
    }
}

// MARK: - CBPeripheralDelegate

extension InmoGo2: CBPeripheralDelegate {

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error {
            Bridge.log("GO2: Service discovery error: \(error.localizedDescription)")
            centralManager?.cancelPeripheralConnection(peripheral)
            return
        }
        guard let services = peripheral.services else { return }
        for service in services where service.uuid == SERVICE_UUID {
            Bridge.log("GO2: Found MentraOS service — discovering characteristics…")
            peripheral.discoverCharacteristics([TX_CHAR_UUID, RX_CHAR_UUID], for: service)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error {
            Bridge.log("GO2: Characteristic discovery error: \(error.localizedDescription)")
            centralManager?.cancelPeripheralConnection(peripheral)
            return
        }
        guard let characteristics = service.characteristics else { return }

        for ch in characteristics {
            let props = ch.properties
            let desc  = [
                props.contains(.notify)               ? "NOTIFY"    : nil,
                props.contains(.indicate)             ? "INDICATE"  : nil,
                props.contains(.write)                ? "WRITE"     : nil,
                props.contains(.writeWithoutResponse) ? "WRITE_NR"  : nil,
            ].compactMap { $0 }.joined(separator: " ")
            Bridge.log("GO2: 📋 Characteristic \(ch.uuid): [\(desc)]")

            if ch.uuid == TX_CHAR_UUID {
                txCharacteristic = ch
                Bridge.log("GO2: ✅ TX (Notify) characteristic found")
            } else if ch.uuid == RX_CHAR_UUID {
                rxCharacteristic = ch
                Bridge.log("GO2: ✅ RX (Write) characteristic found")
            }
        }

        if let tx = txCharacteristic, rxCharacteristic != nil {
            Bridge.log("GO2: ✅ Both characteristics found — enabling notifications")
            updateConnectionState(ConnTypes.CONNECTING)
            peripheral.setNotifyValue(true, for: tx)
            startReadinessCheckLoop()
        } else {
            Bridge.log("GO2: ❌ Required characteristics not found — disconnecting")
            if txCharacteristic == nil { Bridge.log("GO2:   Missing TX (4861)") }
            if rxCharacteristic == nil { Bridge.log("GO2:   Missing RX (4862)") }
            centralManager?.cancelPeripheralConnection(peripheral)
        }
    }

    func peripheral(
        _: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            Bridge.log("GO2: Characteristic update error: \(error.localizedDescription)")
            return
        }
        guard let data = characteristic.value else { return }
        // All incoming data arrives on TX (4861 Notify)
        processReceivedData(data)
    }

    func peripheral(_: CBPeripheral, didWriteValueFor _: CBCharacteristic, error: Error?) {
        if let error {
            Bridge.log("GO2: Write error: \(error.localizedDescription)")
        }
        // ACK write success — queue pump will clear pending if needed after glasses ACK
    }

    func peripheral(
        _: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error {
            Bridge.log("GO2: Notification state error: \(error.localizedDescription)")
        } else {
            Bridge.log("GO2: Notifications \(characteristic.isNotifying ? "ON" : "OFF") for \(characteristic.uuid)")
        }
    }

    func peripheral(_: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard error == nil else { return }
        let rssi = Int(truncating: RSSI)
        GlassesStore.shared.apply("glasses", "signalStrength", rssi)
        GlassesStore.shared.apply("glasses", "signalStrengthUpdatedAt", Int64(Date().timeIntervalSince1970 * 1000))
    }
}

// MARK: - Private Int helper

private extension Int {
    func clampedPositive(default fallback: Int) -> Int {
        return self > 0 ? self : fallback
    }
}
