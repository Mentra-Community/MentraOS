import SwiftUI

private struct WifiNetworkSelection: Identifiable {
    let ssid: String
    let requiresPassword: Bool

    var id: String { ssid }
}

private let ledColorOptions = ["red", "green", "blue", "orange", "white"]

struct SystemScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @State private var pendingWifiNetwork: WifiNetworkSelection?
    @State private var pendingWifiPassword = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                PageHeader(title: "System", connected: model.glassesConnected)
                if !model.glassesConnected {
                    OfflineNotice()
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }

                wifiCard.padding(.horizontal, 16).padding(.top, 8)
                tilesRow.padding(.horizontal, 16).padding(.top, 12)
                inputsCard.padding(.horizontal, 16).padding(.top, 12)
                ledCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, 140)
        }
        .background(AppColor.bg)
        .sheet(item: $pendingWifiNetwork, onDismiss: { pendingWifiPassword = "" }) { network in
            wifiConnectionSheet(network)
                .presentationDetents([.height(300)])
        }
        .onAppear {
            scanWifiIfConnected()
        }
        .onChange(of: model.glassesConnected) { connected in
            if connected {
                scanWifiIfConnected()
            }
        }
    }

    private var wifiCard: some View {
        GlassCard(padding: EdgeInsets(top: 18, leading: 18, bottom: 6, trailing: 18)) {
            HStack {
                HStack(spacing: 10) {
                    iconTile
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Wi-Fi").font(.system(size: 17, weight: .bold)).tracking(-0.17).foregroundColor(AppColor.ink)
                        Text("\(visibleWifiScanResults.count) networks nearby").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
                    }
                }
                Spacer()
                Button {
                    model.requestWifiScan()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .heavy)).foregroundColor(AppColor.ink)
                        Text("Scan").font(.system(size: 12, weight: .semibold)).foregroundColor(AppColor.ink)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(AppColor.ink.opacity(0.05)).clipShape(Capsule())
                }
                .disabled(!model.glassesConnected)
                .opacity(model.glassesConnected ? 1 : 0.5)
            }
            .padding(.bottom, 4)

            currentWifiRow
            let rows = visibleWifiScanResults
            ForEach(Array(rows.enumerated()), id: \.offset) { index, network in
                let ssid = stringValue(network, "ssid") ?? "Unknown"
                let requiresPassword = boolValue(network, "requiresPassword") ?? false
                NetworkRowV(
                    name: ssid,
                    sub: "\(requiresPassword ? "secured" : "open") · \(intValue(network, "signalStrength") ?? 0)",
                    subColor: AppColor.muted,
                    faint: true,
                    locked: requiresPassword,
                    last: index == rows.count - 1,
                    trailingTitle: "Join",
                    trailingColor: AppColor.greenDeep,
                    action: model.glassesConnected ? { handleWifiNetworkTap(ssid: ssid, requiresPassword: requiresPassword) } : nil
                )
            }
        }
    }

    private func scanWifiIfConnected() {
        if model.glassesConnected {
            model.requestWifiScan()
        }
    }

    private func handleWifiNetworkTap(ssid: String, requiresPassword: Bool) {
        if requiresPassword {
            pendingWifiPassword = ""
            pendingWifiNetwork = WifiNetworkSelection(ssid: ssid, requiresPassword: requiresPassword)
            return
        }
        model.sendWifiCredentials(ssid: ssid, password: "", requiresPassword: false)
    }

    private func wifiConnectionSheet(_ network: WifiNetworkSelection) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Capsule()
                .fill(AppColor.ink.opacity(0.12))
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.top, 8)

            VStack(alignment: .leading, spacing: 4) {
                Text("Join Wi-Fi")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(AppColor.ink)
                Text(network.ssid)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(AppColor.muted)
            }

            SecureField("Password", text: $pendingWifiPassword)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(AppColor.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
                .background(AppColor.ink.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 14))

            HStack(spacing: 10) {
                Button {
                    pendingWifiNetwork = nil
                } label: {
                    Text("Cancel")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(AppColor.ink)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppColor.ink.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                Button {
                    model.sendWifiCredentials(ssid: network.ssid, password: pendingWifiPassword, requiresPassword: network.requiresPassword)
                    pendingWifiNetwork = nil
                } label: {
                    Text("Connect")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(Color.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(AppColor.greenPrimary)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                .disabled(network.requiresPassword && pendingWifiPassword.isEmpty)
                .opacity(network.requiresPassword && pendingWifiPassword.isEmpty ? 0.45 : 1)
            }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 18)
        .background(AppColor.bg)
    }

    private var currentWifiRow: some View {
        let isWifiConnected = boolValue(model.glassesValues, "wifiConnected") == true
        return NetworkRowV(
            name: wifiLabel(model.glassesValues),
            sub: stringValue(model.glassesValues, "wifiLocalIp") ?? "not connected",
            subColor: isWifiConnected ? AppColor.greenAccent : AppColor.muted,
            check: isWifiConnected,
            trailingTitle: isWifiConnected ? "Forget" : nil,
            trailingColor: AppColor.red,
            action: isWifiConnected ? { model.forgetCurrentWifiNetwork() } : nil
        )
    }

    private var iconTile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12).fill(AppColor.greenSoft.opacity(0.18))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppColor.greenAccent.opacity(0.22), lineWidth: 1))
                .frame(width: 36, height: 36)
            Image(systemName: "wifi").foregroundColor(AppColor.greenInk).font(.system(size: 16, weight: .semibold))
        }
    }

    private var tilesRow: some View {
        HStack(spacing: 10) {
            Button(action: model.toggleHotspot) {
            GlassCard(corner: 22, padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
                HStack {
                    iconTileSm(systemName: "personalhotspot")
                    Spacer()
                    ZStack(alignment: .trailing) {
                        Capsule().fill(Color.white).frame(width: 38, height: 22)
                        Circle().fill(model.hotspotEnabled ? AppColor.greenAccent : AppColor.mutedSoft).frame(width: 18, height: 18).padding(.trailing, 2)
                    }
                }
                .padding(.bottom, 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hotspot").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.ink)
                    Text(hotspotLabel(model.glassesValues, fallbackEnabled: model.hotspotEnabled))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(model.hotspotEnabled ? AppColor.greenAccent : AppColor.muted)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
            }
            }
            .disabled(!model.glassesConnected)
            .opacity(model.glassesConnected ? 1 : 0.55)
            GlassCard(corner: 22, padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
                HStack {
                    iconTileSm(systemName: "mic")
                    Spacer()
                    HStack(spacing: 6) {
                        micControlButton(
                            systemName: model.micRecording ? "stop.fill" : "record.circle.fill",
                            enabled: model.glassesConnected,
                            active: model.micRecording,
                            action: model.toggleMic
                        )
                        micControlButton(
                            systemName: model.micPlaying ? "stop.fill" : "play.fill",
                            enabled: model.hasMicRecording && !model.micRecording,
                            active: model.micPlaying,
                            action: model.playMicRecording
                        )
                    }
                }
                .padding(.bottom, 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Microphone").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.ink)
                    Text(microphoneStatusText)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(model.micRecording || model.micPlaying ? AppColor.greenAccent : AppColor.muted)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Button(action: model.openBluetoothSettings) {
                        Text("Bluetooth settings")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(AppColor.greenDeep)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(AppColor.greenAccent.opacity(0.14))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                    if let hint = model.micPlaybackHint {
                        Text(hint)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(AppColor.red)
                            .lineLimit(3)
                            .minimumScaleFactor(0.8)
                            .padding(.top, 3)
                    }
                }
            }
            .opacity(model.glassesConnected ? 1 : 0.55)
        }
    }

    private var visibleWifiScanResults: [[String: Any]] {
        let connectedSsid = stringValue(model.glassesValues, "wifiSsid")
        return wifiScanResults(model.bluetoothValues).filter { network in
            guard let connectedSsid, boolValue(model.glassesValues, "wifiConnected") == true else { return true }
            return stringValue(network, "ssid") != connectedSsid
        }
    }

    private var microphoneStatusText: String {
        if model.micRecording {
            return "recording \(durationLabel(model.micElapsedSeconds)) · \(model.pcmFrames) PCM frames"
        }
        if model.micPlaying {
            return "playing last recording"
        }
        if let duration = model.lastMicDurationSeconds, model.lastMicBytes > 0 {
            return "last \(durationLabel(duration)) · \(model.lastMicBytes) PCM bytes"
        }
        return model.glassesConnected ? "record PCM from glasses" : "connect glasses to record"
    }

    private func micControlButton(systemName: String, enabled: Bool, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(active ? AppColor.greenInk : Color.white)
                    .frame(width: 28, height: 28)
                    .shadow(color: Color.black.opacity(0.05), radius: 8, x: 0, y: 4)
                Image(systemName: systemName)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(active ? .white : AppColor.greenInk)
            }
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.42)
    }

    private func iconTileSm(systemName: String) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10).fill(AppColor.greenSoft.opacity(0.18))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppColor.greenAccent.opacity(0.22), lineWidth: 1))
                .frame(width: 32, height: 32)
            Image(systemName: systemName).foregroundColor(AppColor.greenInk).font(.system(size: 14, weight: .semibold))
        }
    }

    private var inputsCard: some View {
        GlassCard(corner: 22, padding: EdgeInsets(top: 16, leading: 18, bottom: 16, trailing: 18)) {
            HStack {
                HStack(spacing: 10) {
                    iconTileSm(systemName: "circle.dotted")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Inputs").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.ink)
                        Text("button · touch · swipe").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
                    }
                }
                Spacer()
                HStack(spacing: 5) {
                    Circle().fill(model.glassesConnected ? AppColor.greenAccent : AppColor.mutedSoft).frame(width: 5, height: 5)
                    Text(model.glassesConnected ? "LIVE" : "OFF").font(.system(size: 10, weight: .bold)).tracking(0.5).foregroundColor(AppColor.greenDeep)
                }
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(AppColor.greenAccent.opacity(0.16))
                .overlay(Capsule().stroke(AppColor.greenAccent.opacity(0.3), lineWidth: 1))
                .clipShape(Capsule())
            }
            .padding(.bottom, 10)

            HStack(spacing: 6) {
                ForEach(Array((model.events.filter { $0.text.contains("button") || $0.text.contains("touch") || $0.text.contains("swipe") }.prefix(3).map(\.text).ifEmpty(["waiting for input"])).enumerated()), id: \.offset) { index, text in
                    InputChip(prefix: "\(index + 1)s", label: text)
                }
                Spacer()
            }
            .padding(.bottom, 12)

            VStack(alignment: .leading, spacing: 6) {
                Text("Save in gallery mode").font(.system(size: 14, weight: .bold)).foregroundColor(AppColor.ink)
                Text(model.galleryModeAuto ? "On: the glasses button saves photos/videos locally." : "Off: button and touch events are reported to the phone.")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(AppColor.muted)
                    .lineSpacing(2)
                HStack(spacing: 8) {
                    GalleryModeChip(title: "Save media", active: model.galleryModeAuto, enabled: model.glassesConnected) {
                        model.setGalleryModeAuto(true)
                    }
                    GalleryModeChip(title: "Report events", active: !model.galleryModeAuto, enabled: model.glassesConnected) {
                        model.setGalleryModeAuto(false)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private var ledCard: some View {
        GlassCard(corner: 24, padding: EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18)) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("RGB LED").font(.system(size: 18, weight: .bold)).tracking(-0.18).foregroundColor(AppColor.ink)
                    Text("color & pattern").font(.system(size: 11)).foregroundColor(AppColor.muted)
                }
                Spacer()
                HStack(spacing: 6) {
                    if model.ledMode != "Off" {
                        Circle().fill(ledSwatchColor(model.ledColor)).frame(width: 8, height: 8)
                    }
                    Text(model.ledMode == "Off" ? "off" : "on").font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.ink)
                }
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(AppColor.ink.opacity(0.06)).clipShape(Capsule())
            }
            .padding(.bottom, 14)

            HStack(spacing: 4) {
                LedTab(systemImage: "circle.slash", label: "Off", active: model.ledMode == "Off", enabled: model.glassesConnected) { model.selectLedMode("Off") }
                LedTab(systemImage: "circle.fill", label: "Solid", active: model.ledMode == "Solid", enabled: model.glassesConnected) { model.selectLedMode("Solid") }
                LedTab(systemImage: "circle.dotted", label: "Pulse", active: model.ledMode == "Pulse", enabled: model.glassesConnected) { model.selectLedMode("Pulse") }
                LedTab(systemImage: "circle.dashed", label: "Blink", active: model.ledMode == "Blink", enabled: model.glassesConnected) { model.selectLedMode("Blink") }
            }
            .padding(4)
            .background(AppColor.ink.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .padding(.bottom, 12)

            HStack(spacing: 6) {
                ForEach(ledColorOptions, id: \.self) { color in
                    LedColorChip(colorName: color, active: model.ledColor == color, enabled: model.glassesConnected) {
                        model.selectLedColor(color)
                    }
                }
            }
            .padding(.bottom, 14)

            Text("Mentra Live RGB controls demonstrate LED color and timing patterns.")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(AppColor.muted)
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct NetworkRowV: View {
    let name: String; let sub: String; let subColor: Color
    var rssi: String? = nil
    var check: Bool = false
    var faint: Bool = false
    var locked: Bool = false
    var last: Bool = false
    var trailingTitle: String? = nil
    var trailingColor: Color = AppColor.ink
    var action: (() -> Void)? = nil

    var body: some View {
        Button(action: { action?() }) {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "wifi")
                    .foregroundColor(faint ? AppColor.mutedSoft : AppColor.greenInk)
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 15, weight: .bold)).foregroundColor(AppColor.ink)
                    Text(sub).font(.system(size: 11, weight: .medium)).foregroundColor(subColor)
                }
                Spacer()
                if let rssi = rssi {
                    HStack(spacing: 4) {
                        Text(rssi).font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.ink)
                        if check { Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundColor(AppColor.ink) }
                    }
                }
                if rssi == nil, check {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundColor(AppColor.ink)
                }
                if let trailingTitle {
                    Text(trailingTitle)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(trailingColor)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(trailingColor.opacity(0.10))
                        .clipShape(Capsule())
                }
                if locked { Image(systemName: "lock.fill").font(.system(size: 11)).foregroundColor(AppColor.ink) }
            }
            .padding(.vertical, 14)
            if !last { Rectangle().fill(AppColor.ink.opacity(0.04)).frame(height: 1) }
        }
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

struct InputChip: View {
    let prefix: String; let label: String
    var body: some View {
        HStack(spacing: 5) {
            Text(prefix).font(.system(size: 10, weight: .semibold)).foregroundColor(AppColor.muted)
            Text(label).font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.ink)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct GalleryModeChip: View {
    let title: String
    let active: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: active ? .bold : .medium))
                .foregroundColor(active ? AppColor.greenInk : AppColor.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(active ? AppColor.greenAccent.opacity(0.16) : AppColor.ink.opacity(0.04))
                .overlay(Capsule().stroke(active ? AppColor.greenAccent.opacity(0.32) : AppColor.ink.opacity(0.05), lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

struct LedTab: View {
    let systemImage: String; let label: String; let active: Bool
    var enabled: Bool = true
    let action: () -> Void
    var body: some View {
        Button {
            action()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage).font(.system(size: 16, weight: active ? .bold : .medium)).foregroundColor(active ? AppColor.ink : AppColor.muted)
                Text(label).font(.system(size: 12, weight: active ? .semibold : .medium)).foregroundColor(active ? AppColor.ink : AppColor.muted)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 10)
            .background(active ? Color.white : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

struct LedColorChip: View {
    let colorName: String
    let active: Bool
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Circle()
                    .fill(ledSwatchColor(colorName))
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(AppColor.ink.opacity(colorName == "white" ? 0.16 : 0), lineWidth: 1))
                Text(colorName.capitalized)
                    .font(.system(size: 10, weight: active ? .semibold : .medium))
                    .foregroundColor(active ? AppColor.ink : AppColor.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(active ? Color.white : AppColor.ink.opacity(0.04))
            .overlay(Capsule().stroke(ledChipBorderColor(colorName, active: active), lineWidth: 1))
            .clipShape(Capsule())
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

private func ledChipBorderColor(_ colorName: String, active: Bool) -> Color {
    if !active {
        return AppColor.ink.opacity(0.05)
    }
    if colorName == "white" {
        return AppColor.ink.opacity(0.16)
    }
    return ledSwatchColor(colorName).opacity(0.42)
}

private func ledSwatchColor(_ colorName: String) -> Color {
    switch colorName {
    case "red":
        return AppColor.red
    case "blue":
        return AppColor.ble
    case "orange":
        return AppColor.amber
    case "white":
        return .white
    default:
        return AppColor.greenAccent
    }
}
