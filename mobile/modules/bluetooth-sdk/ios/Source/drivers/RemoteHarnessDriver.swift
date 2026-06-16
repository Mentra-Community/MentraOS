//
//  RemoteHarnessDriver.swift
//  Dev-only GlassesDriver (iOS) — the harness driver ported onto the public
//  contract. Behavior identical to the legacy sgcs/RemoteHarness; talks through
//  DeviceHost instead of Bridge/DeviceStore/DeviceManager. Reuses the existing
//  RemoteHarnessSocket (defined in sgcs/RemoteHarness.swift). Mirror of the
//  Android RemoteHarnessDriver.kt.
//
//  Transport: NWConnection TCP, newline-JSON ("MDBP" dev/sim wire format).
//  Default daemon host 127.0.0.1 (the sim shares the Mac's network), port 8802.
//

import Foundation

@MainActor
class RemoteHarnessDriver: GlassesDriver {
    let deviceType: String = DeviceTypes.REMOTE_HARNESS

    // Permissive caps: the daemon may hold any family. Only hasMic is consumed
    // by the adapter today; the rest become real gating in a later migration step.
    let capabilities = DeviceCapabilities(hasDisplay: true, hasMic: true, hasCamera: true, hasImu: true)

    private var host: DeviceHost?
    private var socket: RemoteHarnessSocket?
    private var remoteConnected = false
    private var remoteDevice = ""
    private var micEnabled = false

    func start(_ host: DeviceHost) {
        self.host = host
        let daemonHost = (DeviceStore.shared.get("bluetooth", "remote_harness_host") as? String)
            .flatMap { $0.isEmpty ? nil : $0 } ?? "127.0.0.1"
        let daemonPort = UInt16((DeviceStore.shared.get("bluetooth", "remote_harness_port") as? Int) ?? 8802)

        let sock = RemoteHarnessSocket(host: daemonHost, port: daemonPort)
        sock.onLine = { [weak self] line in
            Task { @MainActor in self?.handleLine(line) }
        }
        sock.onClosed = { [weak self] in
            Task { @MainActor in self?.markDisconnected() }
        }
        socket = sock
        sock.start()
        host.log("REMOTE: connecting to harness daemon \(daemonHost):\(daemonPort) ...")
    }

    // MARK: - inbound events

    private func handleLine(_ line: String) {
        guard let host else { return }
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch obj["event"] as? String {
        case "hello", "status":
            remoteConnected = (obj["connected"] as? Bool) ?? false
            remoteDevice = (obj["device"] as? String) ?? (obj["match"] as? String) ?? ""
            if remoteConnected {
                host.log("REMOTE: daemon holds real glasses (\(remoteDevice)); marking connected")
                let model: String
                switch remoteDevice {
                case "g2": model = DeviceTypes.G2
                case "g1": model = DeviceTypes.G1
                case "live": model = DeviceTypes.LIVE
                default: model = deviceType
                }
                host.reportDeviceInfo(DeviceInfo(model: model))
                host.reportReady(true)
                host.reportConnectionState(.connected)
            } else {
                host.log("REMOTE: daemon up, no glasses held yet")
                host.reportConnectionState(.connecting)
            }
        case "battery":
            let level = (obj["level"] as? Int) ?? -1
            if level >= 0 { host.emitBattery(level: level, charging: (obj["charging"] as? Bool) ?? false) }
        case "gesture":
            host.emitTouchEvent((obj["gesture"] as? String) ?? "tap")
        case "imu":
            if let accel = obj["accel"] as? [Double] {
                host.emitImu(accel: accel)
            } else {
                host.emitImu(accel: [
                    (obj["x"] as? Double) ?? 0,
                    (obj["y"] as? Double) ?? 0,
                    (obj["z"] as? Double) ?? 0,
                ])
            }
        case "audio":
            guard micEnabled, let b64 = obj["b64"] as? String, !b64.isEmpty,
                  let lc3 = Data(base64Encoded: b64) else { return }
            host.emitMicAudio(lc3, frameSize: 40)
        default:
            break
        }
    }

    private func markDisconnected() {
        guard remoteConnected else { return }
        remoteConnected = false
        host?.reportConnectionState(.connecting)
        host?.reportReady(false)
    }

    // MARK: - outbound

    private func send(_ cmd: String, _ fields: [String: Any] = [:]) {
        var o: [String: Any] = fields
        o["cmd"] = cmd
        guard let data = try? JSONSerialization.data(withJSONObject: o),
              let line = String(data: data, encoding: .utf8) else {
            host?.log("REMOTE: send '\(cmd)' failed to encode")
            return
        }
        socket?.send(line)
    }

    // MARK: - audio
    func setMicEnabled(_ enabled: Bool) {
        micEnabled = enabled
        host?.reportMicEnabled(enabled)
        send("mic", ["enable": enabled])
    }

    func setImuEnabled(_ enabled: Bool) async { send("imuEnable", ["enable": enabled]) }

    // MARK: - display
    func setBrightness(_ level: Int, autoMode: Bool) {
        send("brightness", ["level": max(0, min(100, level)) * 255 / 100, "auto": autoMode])
    }
    func clearDisplay() { send("clear") }
    func sendTextWall(_ text: String) async { send("text", ["text": text]) }
    func sendDoubleTextWall(_ top: String, _ bottom: String) async { send("text", ["text": "\(top)\n\n\(bottom)"]) }
    func displayBitmap(base64ImageData: String, x: Int32?, y: Int32?, width: Int32?, height: Int32?) async -> Bool {
        host?.log("REMOTE: displayBitmap not supported in v1")
        return false
    }

    // MARK: - device control
    func setHeadUpAngle(_ angle: Int) { send("headup", ["angle": angle]) }
    func getBatteryStatus() { send("battery") }
    func sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        host?.reportCommandResult(requestId: requestId, ok: false, error: "device_not_supported")
    }

    // MARK: - connection management
    func disconnect() {
        host?.log("REMOTE: disconnect")
        socket?.stop()
        socket = nil
        host?.reportConnectionState(.disconnected)
        host?.reportReady(false)
    }
    func cleanup() { disconnect() }
    func ping() { send("ping") }
    func getConnectedName() -> String? { remoteConnected ? "harness:\(remoteDevice)" : nil }
    func findCompatibleDevices() { host?.reportDiscoveredDevice(id: deviceType, name: deviceType) }
    func requestVersionInfo() { send("battery") }
}
