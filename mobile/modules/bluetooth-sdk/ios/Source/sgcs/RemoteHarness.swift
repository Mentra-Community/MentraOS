//
//  RemoteHarness.swift
//  AOS
//
//  Dev-only SGC driver that proxies to the mentra-agent harness daemon on the
//  dev Mac, which holds REAL glasses over BLE (tools/mentra-agent/ble). Lets the
//  app run in the iOS Simulator (no Bluetooth radio) while text, brightness,
//  bitmaps, and the glasses microphone flow to/from physical hardware.
//
//  Transport: a plain TCP socket (Network.framework NWConnection) speaking
//  newline-delimited JSON, identical to the Android RemoteHarness.kt wire
//  format — commands out ({cmd:"text", text:...}), events in
//  ({event:"hello"|"status"|"battery"|"gesture"|"imu"} and {event:"audio",
//  b64:<LC3>}). The iOS Simulator shares the Mac's network, so the default
//  host is 127.0.0.1 (the Android emulator needs 10.0.2.2 instead); port 8802.
//

import Foundation
import Network

/// Non-isolated TCP line socket to the harness daemon. Owns the NWConnection,
/// the receive buffer, reconnect, and a liveness watchdog. All app-state work
/// happens in the MainActor closures the owner installs.
final class RemoteHarnessSocket {
    private let host: String
    private let port: UInt16
    private let queue = DispatchQueue(label: "RemoteHarnessIO", qos: .userInitiated)
    private var connection: NWConnection?
    private var buffer = Data()
    private var alive = true
    private var lastRxAt = Date()
    private var watchdog: DispatchSourceTimer?

    /// Called on the socket queue for each received JSON line.
    var onLine: ((String) -> Void)?
    /// Called on the socket queue when the connection drops or is reset.
    var onClosed: (() -> Void)?

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
    }

    func start() {
        queue.async { [weak self] in self?.connect() }
        // Liveness watchdog: the daemon pings every 3s; if nothing arrives for
        // 12s the socket is dead/hung (e.g. the Mac slept) — force a reconnect
        // rather than trusting NWConnection to notice a half-open TCP socket.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 12, repeating: 6)
        t.setEventHandler { [weak self] in
            guard let self, self.alive else { return }
            if Date().timeIntervalSince(self.lastRxAt) > 12 {
                NSLog("REMOTE: no daemon traffic for 12s; resetting socket")
                self.reset()
            }
        }
        t.resume()
        watchdog = t
    }

    func stop() {
        alive = false
        watchdog?.cancel()
        watchdog = nil
        queue.async { [weak self] in
            self?.connection?.cancel()
            self?.connection = nil
        }
    }

    /// Enqueue a JSON line for sending. Safe to call from any thread/actor —
    /// NWConnection.send buffers internally and never blocks the caller.
    func send(_ line: String) {
        queue.async { [weak self] in
            guard let self, let conn = self.connection else { return }
            var bytes = Data(line.utf8)
            bytes.append(0x0a) // newline framing
            conn.send(content: bytes, completion: .contentProcessed { err in
                if let err { NSLog("REMOTE: send failed: \(err); resetting"); self.reset() }
            })
        }
    }

    // MARK: - internals (all on `queue`)

    private func connect() {
        guard alive else { return }
        let nwHost = NWEndpoint.Host(host)
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }
        let conn = NWConnection(host: nwHost, port: nwPort, using: .tcp)
        connection = conn
        buffer.removeAll(keepingCapacity: true)
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                NSLog("REMOTE: socket up to \(self.host):\(self.port); awaiting hello")
                self.lastRxAt = Date()
                self.receiveLoop()
            case let .failed(err):
                NSLog("REMOTE: socket failed: \(err)")
                self.reset()
            case .cancelled:
                break
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func receiveLoop() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self, self.alive else { return }
            if let data, !data.isEmpty {
                self.lastRxAt = Date()
                self.buffer.append(data)
                self.drainLines()
            }
            if let error {
                NSLog("REMOTE: receive error: \(error); resetting")
                self.reset()
                return
            }
            if isComplete {
                NSLog("REMOTE: socket closed by daemon; resetting")
                self.reset()
                return
            }
            self.receiveLoop()
        }
    }

    private func drainLines() {
        while let nl = buffer.firstIndex(of: 0x0a) {
            let lineData = buffer.subdata(in: buffer.startIndex ..< nl)
            buffer.removeSubrange(buffer.startIndex ... nl)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                onLine?(line)
            }
        }
    }

    private func reset() {
        connection?.cancel()
        connection = nil
        onClosed?()
        guard alive else { return }
        // backoff a beat, then reconnect
        queue.asyncAfter(deadline: .now() + 3) { [weak self] in self?.connect() }
    }
}

@MainActor
class RemoteHarness: SGCManager {
    var type: String = DeviceTypes.REMOTE_HARNESS
    var hasMic: Bool = true

    private var socket: RemoteHarnessSocket?
    private var remoteConnected = false
    private var remoteDevice = ""

    init() {
        let host = (DeviceStore.shared.get("bluetooth", "remote_harness_host") as? String)
            .flatMap { $0.isEmpty ? nil : $0 } ?? "127.0.0.1"
        let port = UInt16((DeviceStore.shared.get("bluetooth", "remote_harness_port") as? Int) ?? 8802)

        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        DeviceStore.shared.apply("glasses", "micEnabled", false)
        DeviceStore.shared.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.voiceActivityDetectionEnabled
        )

        let sock = RemoteHarnessSocket(host: host, port: port)
        sock.onLine = { [weak self] line in
            Task { @MainActor in self?.handleLine(line) }
        }
        sock.onClosed = { [weak self] in
            Task { @MainActor in self?.markDisconnected() }
        }
        socket = sock
        sock.start()
        Bridge.log("REMOTE: connecting to harness daemon \(host):\(port) ...")
    }

    // MARK: - inbound events

    private func handleLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch obj["event"] as? String {
        case "hello", "status":
            remoteConnected = (obj["connected"] as? Bool) ?? false
            remoteDevice = (obj["device"] as? String) ?? (obj["match"] as? String) ?? ""
            if remoteConnected {
                Bridge.log("REMOTE: daemon holds real glasses (\(remoteDevice)); marking connected")
                // Report the UNDERLYING family so capabilities resolve to the
                // real hardware (an unknown model falls back to NONE and gates
                // every miniapp).
                let model: String
                switch remoteDevice {
                case "g2": model = DeviceTypes.G2
                case "g1": model = DeviceTypes.G1
                case "live": model = DeviceTypes.LIVE
                default: model = type
                }
                DeviceStore.shared.apply("glasses", "deviceModel", model)
                DeviceStore.shared.apply("glasses", "fullyBooted", true)
                DeviceStore.shared.apply("glasses", "connected", true)
                DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            } else {
                Bridge.log("REMOTE: daemon up, no glasses held yet")
                DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
            }
        case "battery":
            let level = (obj["level"] as? Int) ?? -1
            if level >= 0 {
                let charging = (obj["charging"] as? Bool) ?? false
                DeviceStore.shared.apply("glasses", "batteryLevel", level)
                DeviceStore.shared.apply("glasses", "charging", charging)
                Bridge.sendBatteryStatus(level: level, charging: charging)
            }
        case "gesture":
            let g = (obj["gesture"] as? String) ?? "tap"
            Bridge.sendTouchEvent(deviceModel: type, gestureName: g, timestamp: Int64(Date().timeIntervalSince1970 * 1000))
        case "imu":
            // The daemon relays G2 accel as x/y/z (or an `accel` array); iOS
            // surfaces accelerometer via sendAccelEvent.
            let accel = obj["accel"] as? [Double]
            let x = accel?.first ?? (obj["x"] as? Double) ?? 0
            let y = (accel?.count ?? 0) > 1 ? accel![1] : (obj["y"] as? Double ?? 0)
            let z = (accel?.count ?? 0) > 2 ? accel![2] : (obj["z"] as? Double ?? 0)
            Bridge.sendAccelEvent(x: Float(x), y: Float(y), z: Float(z), timestamp: Int64(Date().timeIntervalSince1970 * 1000))
        case "audio":
            guard micEnabled, let b64 = obj["b64"] as? String, !b64.isEmpty,
                  let lc3 = Data(base64Encoded: b64) else { return }
            // Real glasses LC3 (40-byte frames; G2 bundles ~5 per chunk).
            DeviceManager.shared.handleGlassesMicData(lc3, 40)
        default:
            break
        }
    }

    private func markDisconnected() {
        guard remoteConnected else { return }
        remoteConnected = false
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.CONNECTING)
    }

    // MARK: - outbound

    private func send(_ cmd: String, _ fields: [String: Any] = [:]) {
        var o: [String: Any] = fields
        o["cmd"] = cmd
        guard let data = try? JSONSerialization.data(withJSONObject: o),
              let line = String(data: data, encoding: .utf8) else {
            Bridge.log("REMOTE: send '\(cmd)' failed to encode")
            return
        }
        socket?.send(line)
    }

    // MARK: - Audio

    func setMicEnabled(_ enabled: Bool) {
        DeviceStore.shared.apply("glasses", "micEnabled", enabled)
        send("mic", ["enable": enabled])
    }

    func sortMicRanking(list: [String]) -> [String] { list }

    func setImuEnabled(_ enabled: Bool) async {
        send("imuEnable", ["enable": enabled])
    }

    // MARK: - Messaging

    func sendJson(_: [String: Any], wakeUp _: Bool, requireAck _: Bool) {}

    // MARK: - Display

    func setBrightness(_ level: Int, autoMode: Bool) {
        // App levels 0-100; the daemon takes 0-255.
        send("brightness", ["level": max(0, min(100, level)) * 255 / 100, "auto": autoMode])
    }

    func clearDisplay() { send("clear") }

    func sendTextWall(_ text: String) async { send("text", ["text": text]) }

    func sendDoubleTextWall(_ top: String, _ bottom: String) async {
        send("text", ["text": "\(top)\n\n\(bottom)"])
    }

    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool {
        // The daemon decodes/scales/dithers and renders via the tiled
        // single-fragment path (G2 firmware rejects multi-fragment images).
        var f: [String: Any] = ["b64": base64ImageData]
        if let x { f["x"] = Int(x) }
        if let y { f["y"] = Int(y) }
        if let width { f["width"] = Int(width) }
        if let height { f["height"] = Int(height) }
        send("bitmap", f)
        return true
    }

    func showDashboard() {}
    func setDashboardPosition(_: Int, _: Int) {}

    // MARK: - Device control

    func setHeadUpAngle(_ angle: Int) { send("headup", ["angle": angle]) }
    func getBatteryStatus() { send("battery") }
    func setSilentMode(_: Bool) {}
    func exit() { send("clear") }
    func sendShutdown() {}
    func sendReboot() {}

    func sendRgbLedControl(requestId: String, packageName _: String?, action _: String, color _: String?, onDurationMs _: Int, offDurationMs _: Int, count _: Int) {
        Bridge.sendRgbLedControlResponse(requestId: requestId, success: false, error: "device_not_supported")
    }

    // MARK: - Camera & media (forwarded; meaningful when the daemon holds a Live)

    func requestPhoto(_ requestId: String, appId: String, size _: String?, webhookUrl: String?, authToken: String?, compress _: String?, flash _: Bool, save: Bool, sound _: Bool, exposureTimeNs _: Double?, iso _: Int?) {
        var opts: [String: Any] = [
            "requestId": requestId,
            "appId": appId,
            "transferMethod": webhookUrl != nil ? "wifi" : "ble",
            "save": save,
        ]
        if let webhookUrl { opts["webhookUrl"] = webhookUrl }
        if let authToken { opts["authToken"] = authToken }
        send("photo", ["opts": opts])
    }

    func startStream(_: [String: Any]) {}
    func stopStream() {}
    func sendStreamKeepAlive(_: [String: Any]) {}
    func startVideoRecording(requestId _: String, save _: Bool, flash _: Bool, sound _: Bool) {}
    func stopVideoRecording(requestId _: String) {}

    // MARK: - Button settings (no-ops; the harness owns the hardware)

    func sendButtonPhotoSettings() {}
    func sendButtonVideoRecordingSettings() {}
    func sendButtonMaxRecordingTime() {}
    func sendButtonCameraLedSetting() {}
    func sendCameraFovSetting() {}

    // MARK: - Connection management

    func disconnect() {
        Bridge.log("REMOTE: disconnect")
        socket?.stop()
        socket = nil
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    func forget() { disconnect() }

    func findCompatibleDevices() {
        // The daemon owns scanning; report ourselves so the pairing UI proceeds.
        Bridge.sendDiscoveredDevice(type, type)
    }

    func stopScan() {}
    func connectById(_: String) {}
    func connectController() {}
    func disconnectController() {}

    func getConnectedBluetoothName() -> String? {
        remoteConnected ? "harness:\(remoteDevice)" : nil
    }

    func cleanup() { disconnect() }
    func ping() { send("ping") }
    func dbg1() {}
    func dbg2() {}

    // MARK: - Network management (not proxied)

    func requestWifiScan() {}
    func sendWifiCredentials(_: String, _: String) {}
    func forgetWifiNetwork(_: String) {}
    func sendHotspotState(_: Bool) {}
    func sendOtaStart() {}
    func sendOtaQueryStatus() {}
    func sendUserEmailToGlasses(_: String) {}
    func sendIncidentId(_: String, apiBaseUrl _: String?) {}

    // MARK: - Gallery / version

    func queryGalleryStatus() {}
    func sendGalleryMode() {}
    func requestVersionInfo() { send("battery") }
}
