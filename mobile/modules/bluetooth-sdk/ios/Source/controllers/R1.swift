//
//  R1.swift
//  MentraOS_Manager
//
//  Even Realities R1 Smart Ring controller
//  Protocol reverse-engineered from BTSnoop captures and firmware analysis
//

import Combine
import CoreBluetooth
import Foundation

// MARK: - R1 BLE Constants

private enum R1BLE {
    /// Ring custom service
    static let SERVICE_UUID = CBUUID(string: "BAE80001-4F05-4503-8E65-3AF1F7329D1F")

    // Channel 1
    static let WRITE_CHAR_1 = CBUUID(string: "BAE80010-4F05-4503-8E65-3AF1F7329D1F")
    static let NOTIFY_CHAR_1 = CBUUID(string: "BAE80011-4F05-4503-8E65-3AF1F7329D1F")

    // Channel 2
    static let WRITE_CHAR_2 = CBUUID(string: "BAE80012-4F05-4503-8E65-3AF1F7329D1F")
    static let NOTIFY_CHAR_2 = CBUUID(string: "BAE80013-4F05-4503-8E65-3AF1F7329D1F")

    // Standard battery service (ring may expose this)
    static let BATTERY_SERVICE = CBUUID(string: "180F")
    static let BATTERY_LEVEL_CHAR = CBUUID(string: "2A19")

    /// Name filters for scanning
    static let NAME_FILTERS = ["EVEN R1", "BCL60"]

    // Init sequence config writes
    static let CONFIG_FC = Data([0xFC])
    static let CONFIG_11 = Data([0x11])

    // BleRing1 command header (cmd, module, subCmd) for advStart
    // From RE: BleRing1Cmd_system=0, BleRing1Module_system=0, BleRing1SubCmd_advStart=9
    static let CMD_SYSTEM: UInt8 = 0x00
    static let MODULE_SYSTEM: UInt8 = 0x00
    static let SUBCMD_ADV_START: UInt8 = 0x09

    /// Gesture protocol marker
    static let GESTURE_MARKER: UInt8 = 0xFF

    static let SCAN_TIMEOUT: TimeInterval = 15.0
}

// MARK: - R1 Gesture Types

private enum R1Gesture: String {
    case hold
    case singleTap = "single_tap"
    case doubleTap = "double_tap"
    case swipeUp = "swipe_up"
    case swipeDown = "swipe_down"

    /// Parse gesture from notification data: [0xFF, type, param]
    static func parse(from data: Data) -> R1Gesture? {
        guard data.count >= 3, data[0] == R1BLE.GESTURE_MARKER else { return nil }
        switch data[1] {
        case 0x03:
            return .hold
        case 0x04:
            return data[2] == 0x01 ? .singleTap : data[2] == 0x02 ? .doubleTap : nil
        case 0x05:
            return data[2] < 0x80 ? .swipeUp : .swipeDown
        default:
            return nil
        }
    }
}

// MARK: - R1 Controller

@MainActor
class R1: NSObject, ControllerManager {
    var type = ControllerTypes.R1
    let hasMic = false // R1 ring has no microphone

    // Connection state
    private var centralManager: CBCentralManager?
    private var ringPeripheral: CBPeripheral?
    private var isDisconnecting = false

    // BLE characteristics
    private var writeChar1: CBCharacteristic?
    private var notifyChar1: CBCharacteristic?
    private var writeChar2: CBCharacteristic?
    private var notifyChar2: CBCharacteristic?
    private var batteryLevelChar: CBCharacteristic?
    private var notifySubscriptionCount = 0
    private var initSequenceRun = false

    /// Device search
    var DEVICE_SEARCH_ID = "NOT_SET"

    /// persisted state for ease of reconnection / background connection:
    /// we could store these elsewhere to be like other settings / state, but in practice they will only ever be set and used here
    /// Stored UUID for background reconnection
    private var ringUUID: UUID? {
        get { UserDefaults.standard.string(forKey: "r1_ringUUID").flatMap { UUID(uuidString: $0) } }
        set {
            if let v = newValue {
                UserDefaults.standard.set(v.uuidString, forKey: "r1_ringUUID")
            } else {
                UserDefaults.standard.removeObject(forKey: "r1_ringUUID")
            }
        }
    }

    /// maps peripheral.name to 6-byte ring MAC address:
    private var ringMacAddressMap: [String: Data] {
        get {
            UserDefaults.standard.dictionary(forKey: "r1_ringMacAddressMap") as? [String: Data]
                ?? [:]
        }
        set { UserDefaults.standard.set(newValue, forKey: "r1_ringMacAddressMap") }
    }

    private var ringMacAddress: String? {
        get { UserDefaults.standard.string(forKey: "r1_ringMacAddress") }
        set { UserDefaults.standard.set(newValue, forKey: "r1_ringMacAddress") }
    }

    /// Reconnection
    private let reconnectionManager = R1ReconnectionManager()

    /// Battery
    @Published private var _batteryLevel: Int = -1 {
        didSet {
            if _batteryLevel != oldValue && _batteryLevel >= 0 {
                DeviceStore.shared.apply("glasses", "controllerBatteryLevel", _batteryLevel)
                // Bridge.sendBatteryStatus(level: _batteryLevel, charging: isCharging)
            }
        }
    }

    private var isCharging = false

    /// Heartbeat
    private var heartbeatTimer: Timer?

    static let _bluetoothQueue = DispatchQueue(label: "BluetoothR1", qos: .userInitiated)

    // MARK: - Init

    override init() {
        super.init()
    }

    deinit {
        centralManager?.delegate = nil
        ringPeripheral?.delegate = nil
    }

    // MARK: - BLE Scanning

    @discardableResult
    private func startScan() -> Bool {
        Bridge.log("R1: startScan()")
        if centralManager == nil {
            centralManager = CBCentralManager(
                delegate: self, queue: R1._bluetoothQueue,
                options: [CBCentralManagerOptionShowPowerAlertKey: 0]
            )
        }

        isDisconnecting = false
        guard centralManager!.state == .poweredOn else {
            Bridge.log("R1: Bluetooth not powered on")
            return false
        }

        // Try UUID-based reconnection first
        if connectByUUID() {
            return true
        }

        centralManager!.scanForPeripherals(
            withServices: nil,
            options: [
                CBCentralManagerScanOptionAllowDuplicatesKey: false,
            ]
        )
        return true
    }

    func stopScan() {
        centralManager?.stopScan()
    }

    private func connectByUUID() -> Bool {
        // don't do this if we don't have a search id set:
        if DEVICE_SEARCH_ID == "NOT_SET" || DEVICE_SEARCH_ID.isEmpty {
            Bridge.log("R1: 🔵 No DEVICE_SEARCH_ID set, skipping connect by UUID")
            return false
        }
        guard let uuid = ringUUID else { return false }
        guard let ringMac = ringMacAddress else { return false }
        guard let peripheral = centralManager?.retrievePeripherals(withIdentifiers: [uuid]).first
        else { return false }

        ringPeripheral = peripheral
        peripheral.delegate = self
        centralManager?.connect(peripheral, options: nil)
        Bridge.log("R1: Reconnecting by UUID to \(peripheral.name ?? "ring")")
        return true
    }

    private func matchesNameFilter(_ name: String?) -> Bool {
        guard let name = name else { return false }
        return R1BLE.NAME_FILTERS.contains(where: { name.contains($0) })
    }

    /// Extract a device identifier from the ring name (e.g. "EVEN R1_CEC5BA" -> "CEC5BA")
    private func extractRingId(_ name: String) -> String? {
        if let range = name.range(of: "R1_") {
            let id = String(name[range.upperBound...])
            return id.isEmpty ? nil : id
        }
        return nil
    }

    // MARK: - Init Sequence

    /// Runs after notify subscriptions are confirmed.
    /// Sends 0xFC and 0x11 config writes to initialize the ring.
    private func runInitSequence() {
        guard !initSequenceRun else { return }
        initSequenceRun = true

        Bridge.log("R1: Running init sequence")

        // Write init commands to both write characteristics
        let writeChars = [writeChar1, writeChar2].compactMap { $0 }
        guard !writeChars.isEmpty else {
            Bridge.log("R1: No write characteristics found, skipping init")
            markConnected()
            return
        }

        for wc in writeChars {
            ringPeripheral?.writeValue(R1BLE.CONFIG_FC, for: wc, type: .withoutResponse)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            for wc in writeChars {
                self.ringPeripheral?.writeValue(R1BLE.CONFIG_11, for: wc, type: .withoutResponse)
            }
            self.markConnected()
        }
    }

    /// Tells the ring to start advertising / connect to the glasses.
    /// Sends BleRing1 advStart (cmd=0, module=0, subCmd=9) with the 6-byte glasses MAC as payload
    /// to WRITE_CHAR_2 (BAE80012-…). Reverse-engineered from the Even Realities mobile app
    /// (BleRing1CmdProto::advStart -> BleRing1CmdPublicExt.sendCmd).
    private func connectToGlasses() {
        let glassesMac = (DeviceStore.shared.get("glasses", "bluetoothMacAddress") as? String)
            ?? UserDefaults.standard.string(forKey: "glasses_btMacAddress")

        guard let glassesMac else {
            Bridge.log("R1: connectToGlasses: no glasses MAC")
            return
        }

        guard let macBytes = parseMac(glassesMac) else {
            Bridge.log("R1: connectToGlasses: could not parse glasses MAC")
            return
        }

        // Cache so we can reconnect even before the glasses are scanned.
        UserDefaults.standard.set(glassesMac, forKey: "glasses_btMacAddress")

        guard let wc = writeChar2 ?? writeChar1 else {
            Bridge.log("R1: connectToGlasses: no write characteristic")
            return
        }

        var payload = Data([R1BLE.CMD_SYSTEM, R1BLE.MODULE_SYSTEM, R1BLE.SUBCMD_ADV_START])
        payload.append(macBytes)
        Bridge.log("R1: advStart sent")
        ringPeripheral?.writeValue(payload, for: wc, type: .withoutResponse)
    }

    /// Parse a MAC string like "AA:BB:CC:DD:EE:FF" or "AABBCCDDEEFF" into 6 raw bytes.
    private func parseMac(_ s: String) -> Data? {
        let cleaned = s.replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: "-", with: "")
        guard cleaned.count == 12 else { return nil }
        var out = Data(); out.reserveCapacity(6)
        var idx = cleaned.startIndex
        for _ in 0 ..< 6 {
            let next = cleaned.index(idx, offsetBy: 2)
            guard let byte = UInt8(cleaned[idx ..< next], radix: 16) else { return nil }
            out.append(byte)
            idx = next
        }
        return out
    }

    private func markConnected() {
        Task { await reconnectionManager.stop() }
        Bridge.log("R1: Ring connected")

        if let name = ringPeripheral?.name, let id = extractRingId(name) {
            DeviceStore.shared.apply("bluetooth", "controller_device_name", id)
        }

        guard let mac = ringMacAddress else {
            Bridge.log("R1: No ring MAC address found")
            return
        }
        DeviceStore.shared.apply("glasses", "controllerMacAddress", mac)

        DeviceStore.shared.apply("glasses", "controllerConnected", true)
        // DeviceStore.shared.apply("glasses", "controllerFullyBooted", true)

        // tell the ring to connect to the glasses if we have it's mac address:
        connectToGlasses()

        // after a second, connect the glasses to the controller if needed:
        Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await DeviceManager.shared.sgc?.connectController()
        }

        startHeartbeat()
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        heartbeatTimer?.invalidate()
        // Simple keepalive: re-read battery every 30 seconds
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) {
            [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, DeviceStore.shared.get("glasses", "controllerConnected") as? Bool ?? false else { return }
                // Read battery if we have the standard battery char
                if let char = self.batteryLevelChar {
                    self.ringPeripheral?.readValue(for: char)
                }
            }
        }
    }

    private func stopHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
    }

    // MARK: - Incoming Data Handling

    private func handleNotification(from characteristic: CBCharacteristic, data: Data) {
        let hex = data.map { String(format: "%02X", $0) }.joined(separator: " ")
        Bridge.log("R1: \(String(characteristic.uuid.uuidString.suffix(4))) -> \(hex)")

        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)

        // Gesture: [0xFF, type, param]
        if data.count >= 3, data[0] == R1BLE.GESTURE_MARKER {
            if let gesture = R1Gesture.parse(from: data) {
                Bridge.log("R1: Gesture: \(gesture.rawValue)")
                Bridge.sendTouchEvent(
                    deviceModel: ControllerTypes.R1,
                    gestureName: gesture.rawValue,
                    timestamp: timestamp
                )
            } else {
                Bridge.log(
                    "R1: Unknown gesture type=0x\(String(format: "%02X", data[1])) param=0x\(String(format: "%02X", data[2]))"
                )
            }
            return
        }

        // Battery: 2 bytes, first byte is percentage
        if data.count == 2, data[0] <= 100 {
            _batteryLevel = Int(data[0])
            Bridge.log("R1: Battery: \(data[0])%")
            return
        }

        // State: single byte (0x01=ready, 0x00=menu)
        if data.count == 1 {
            let state = data[0] == 0x01 ? "ready" : data[0] == 0x00 ? "menu" : "unknown(\(data[0]))"
            Bridge.log("R1: State: \(state)")
            return
        }

        // Longer data: check for embedded gesture marker
        if data.count > 3, let ffIndex = data.firstIndex(of: R1BLE.GESTURE_MARKER),
           ffIndex + 2 < data.count
        {
            let gestureData = Data(data[ffIndex ... ffIndex + 2])
            if let gesture = R1Gesture.parse(from: gestureData) {
                Bridge.log("R1: Embedded gesture: \(gesture.rawValue)")
                Bridge.sendTouchEvent(
                    deviceModel: ControllerTypes.R1,
                    gestureName: gesture.rawValue,
                    timestamp: timestamp
                )
                return
            }
        }
    }

    // MARK: - Connection State Reset

    private func resetConnectionState() {
        ringPeripheral = nil
        writeChar1 = nil
        notifyChar1 = nil
        writeChar2 = nil
        notifyChar2 = nil
        batteryLevelChar = nil
        notifySubscriptionCount = 0
        initSequenceRun = false
        ringMacAddress = nil
        DeviceStore.shared.apply("glasses", "controllerConnected", false)
        DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
    }

    // MARK: - Reconnection

    private func startReconnectionTimer() {
        Task {
            await reconnectionManager.start { [weak self] in
                guard let self else { return false }
                if await MainActor.run(body: { DeviceStore.shared.get("glasses", "controllerConnected") as? Bool ?? false }) {
                    return true // already connected
                }
                Bridge.log("R1: Attempting reconnection...")
                await MainActor.run { self.startScan() }
                return false // keep trying
            }
        }
    }

    // MARK: - ControllerManager Protocol

    func findCompatibleDevices() {
        Bridge.log("R1: findCompatibleDevices()")
        DEVICE_SEARCH_ID = "NOT_SET"
        startScan()
    }

    func connectById(_ id: String) {
        Bridge.log("R1: connectById(\(id))")
        DEVICE_SEARCH_ID = id
        startScan()
    }

    func disconnect() {
        Bridge.log("R1: disconnect()")
        isDisconnecting = true
        stopHeartbeat()
        Task { await reconnectionManager.stop() }

        if let peripheral = ringPeripheral {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        resetConnectionState()
    }

    func forget() {
        disconnect()
        ringUUID = nil
        ringMacAddress = nil
        DEVICE_SEARCH_ID = "NOT_SET"
        centralManager?.delegate = nil
    }

    func cleanup() {
        disconnect()
    }

    func getConnectedBluetoothName() -> String? {
        return ringPeripheral?.name
    }

    func ping() {
        if let char = batteryLevelChar {
            ringPeripheral?.readValue(for: char)
        }
    }

    func getBatteryStatus() {
        if let char = batteryLevelChar {
            ringPeripheral?.readValue(for: char)
        }
    }

    // MARK: - No-op implementations (ring has no display/camera/wifi/mic)

    func sendIncidentId(_: String, apiBaseUrl _: String?) {}
    func setMicEnabled(_: Bool) {}
    func sortMicRanking(list: [String]) -> [String] {
        return list
    }

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}
    func requestPhoto(_: PhotoRequest) {}
    func startVideoRecording(requestId _: String, save _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}
    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func setBrightness(_: Int, autoMode _: Bool) {}
    func clearDisplay() {}
    func sendTextWall(_: String) {}
    func sendDoubleTextWall(_: String, _: String) {}
    func displayBitmap(base64ImageData _: String, x _: Int32? = nil, y _: Int32? = nil, width _: Int32? = nil, height _: Int32? = nil) async -> Bool {
        return false
    }

    func showDashboard() {}
    func setDashboardPosition(_: Int, _: Int) {}
    func setHeadUpAngle(_: Int) {}
    func setSilentMode(_: Bool) {}
    func exit() {}
    func sendShutdown() {
        disconnect()
    }

    func sendReboot() {}
    func sendRgbLedControl(
        requestId _: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int,
        offDurationMs _: Int, count _: Int
    ) {}
    func requestWifiScan() {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendOtaStart(otaVersionUrl: String?) {}
    func sendOtaQueryStatus() {}
    func sendUserEmailToGlasses(_: String) {}
    func queryGalleryStatus() {}
    func sendGalleryMode() {}
    func requestVersionInfo() {}
}

// MARK: - CBCentralManagerDelegate

extension R1: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state = central.state
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("R1: Bluetooth state: \(state.rawValue)")
            if state == .poweredOn {
                _ = self.startScan()
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let mfgData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.matchesNameFilter(name) else { return }

            Bridge.log(
                "R1: Discovered: \(name ?? "?") (RSSI: \(RSSI)) mfgData: \(mfgData?.map { String(format: "%02X", $0) }.joined(separator: " ") ?? "none")"
            )

            // Extract ring MAC from manufacturer data if available and store to a map name:mac
            if let mfgData = mfgData {
                Bridge.log(
                    "R1: mfgData: \(mfgData.map { String(format: "%02X", $0) }.joined(separator: " "))"
                )
                if mfgData.count >= 6 {
                    self.ringMacAddressMap[name ?? ""] = Data(mfgData.suffix(6))
                }
            }

            // Emit discovered device
            if let name = name, let id = self.extractRingId(name) {
                Bridge.sendDiscoveredDevice(ControllerTypes.R1, id)
            }

            // If scan-only mode, don't auto-connect
            guard self.DEVICE_SEARCH_ID != "NOT_SET" else { return }

            // If search ID is specific, check it matches the ring name/id
            if let name = name, let id = self.extractRingId(name),
               self.DEVICE_SEARCH_ID != id && !name.contains(self.DEVICE_SEARCH_ID)
            {
                return
            }

            if self.ringPeripheral == nil {
                self.ringPeripheral = peripheral
                peripheral.delegate = self
                central.connect(peripheral, options: nil)
                self.stopScan()
                Bridge.log("R1: Connecting to \(name ?? "ring")")
            }
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didConnect peripheral: CBPeripheral
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("R1: Connected to \(peripheral.name ?? "ring")")

            self.ringUUID = peripheral.identifier

            guard let name = peripheral.name, let mac = self.ringMacAddressMap[name] else {
                Bridge.log("R1: No MAC stored in map found for \(peripheral.name ?? "ring")")
                // stop the scan, disconnect, remove the uuid, and try again as we need the mac address to connect:
                self.disconnect()
                self.ringUUID = nil
                // we are still searching!:
                DeviceStore.shared.apply("glasses", "controllerConnected", false)
                DeviceStore.shared.apply("glasses", "controllerFullyBooted", false)
                DeviceStore.shared.apply("glasses", "controllerSearching", true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    self.startScan()
                }
                return
            }

            self.ringMacAddress = mac.map { String(format: "%02X", $0) }.joined(separator: ":")

            // Discover all services
            peripheral.discoverServices(nil)
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didFailToConnect _: CBPeripheral, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("R1: Failed to connect: \(error?.localizedDescription ?? "unknown")")
            self.resetConnectionState()
        }
    }

    nonisolated func centralManager(
        _: CBCentralManager, didDisconnectPeripheral _: CBPeripheral, error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            Bridge.log("R1: Disconnected: \(error?.localizedDescription ?? "clean")")

            self.stopHeartbeat()

            if self.isDisconnecting { return }

            self.resetConnectionState()
            // self.startReconnectionTimer()
        }
    }
}

// MARK: - CBPeripheralDelegate

extension R1: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices _: Error?) {
        guard let services = peripheral.services else { return }
        for service in services {
            // Discover ALL characteristics on every service
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error _: Error?
    ) {
        guard let characteristics = service.characteristics else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            for char in characteristics {
                Bridge.log("R1: char discovered: \(char.uuid)")
                let props = char.properties
                var propStr: [String] = []
                if props.contains(.read) { propStr.append("read") }
                if props.contains(.write) { propStr.append("write") }
                if props.contains(.writeWithoutResponse) { propStr.append("writeNoResp") }
                if props.contains(.notify) { propStr.append("notify") }
                if props.contains(.indicate) { propStr.append("indicate") }
                Bridge.log("R1: char \(char.uuid) props=[\(propStr.joined(separator: ","))]")

                // Store known characteristics
                switch char.uuid {
                case R1BLE.WRITE_CHAR_1:
                    self.writeChar1 = char
                case R1BLE.NOTIFY_CHAR_1:
                    self.notifyChar1 = char
                case R1BLE.WRITE_CHAR_2:
                    self.writeChar2 = char
                case R1BLE.NOTIFY_CHAR_2:
                    self.notifyChar2 = char
                case R1BLE.BATTERY_LEVEL_CHAR:
                    self.batteryLevelChar = char
                default:
                    break
                }

                // Subscribe to any notify/indicate characteristic
                if props.contains(.notify) || props.contains(.indicate) {
                    peripheral.setNotifyValue(true, for: char)
                }

                // Read any readable characteristic (triggers pairing if encrypted)
                if props.contains(.read) {
                    peripheral.readValue(for: char)
                }
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Bridge.log("R1: didUpdateNotificationStateFor: \(characteristic.uuid)")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            if let error = error {
                Bridge.log(
                    "R1: Notify error on \(characteristic.uuid): \(error.localizedDescription)"
                )
                return
            }
            Bridge.log("R1: Notify enabled on \(characteristic.uuid)")

            self.notifySubscriptionCount += 1

            // Run init after subscribing to at least 2 notify characteristics
            if self.notifySubscriptionCount >= 2 && !self.initSequenceRun {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    self?.runInitSequence()
                }
            }
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Bridge.log("R1: didUpdateValueFor1: \(characteristic.uuid)")
        guard let data = characteristic.value, !data.isEmpty, error == nil else { return }
        Bridge.log("R1: didUpdateValueFor: \(characteristic.uuid) data: \(data.hexEncodedString())")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Standard battery service
            if characteristic.uuid == R1BLE.BATTERY_LEVEL_CHAR {
                self._batteryLevel = Int(data[0])
                Bridge.log("R1: Battery (std): \(data[0])%")
                return
            }

            self.handleNotification(from: characteristic, data: data)
        }
    }

    nonisolated func peripheral(
        _: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?
    ) {
        Bridge.log("R1: didWriteValueFor: \(characteristic.uuid)")
        if let error = error {
            DispatchQueue.main.async {
                Bridge.log(
                    "R1: Write error on \(characteristic.uuid): \(error.localizedDescription)"
                )
            }
        }
    }
}

// MARK: - R1 Reconnection Manager

actor R1ReconnectionManager {
    private var task: Task<Void, Never>?
    private let intervalSeconds: TimeInterval
    private var attempts = 0
    private let maxAttempts: Int

    init(intervalSeconds: TimeInterval = 30, maxAttempts: Int = -1) {
        self.intervalSeconds = intervalSeconds
        self.maxAttempts = maxAttempts
    }

    func start(onAttempt: @escaping @Sendable () async -> Bool) {
        stop()
        attempts = 0
        task = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds * 1_000_000_000))
                if Task.isCancelled { break }
                attempts += 1
                if maxAttempts > 0, attempts > maxAttempts { break }
                let done = await onAttempt()
                if done { break }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        attempts = 0
    }
}
