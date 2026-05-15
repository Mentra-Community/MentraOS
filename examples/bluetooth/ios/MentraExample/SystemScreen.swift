import MentraBluetoothSDK
import SwiftUI

private struct WifiNetworkSelection: Identifiable {
    let ssid: String
    let requiresPassword: Bool

    var id: String { ssid }
}

private let ledColorOptions = ["red", "green", "blue", "orange", "white"]

private struct InputChipModel: Identifiable {
    let id: String
    let age: String
    let label: String
}

private func recentInputChips(from events: [ExampleEvent]) -> [InputChipModel] {
    let labels = Array(events.compactMap { inputLabel(from: $0.text) }.prefix(3))
    if labels.isEmpty {
        return [InputChipModel(id: "waiting", age: "--", label: "waiting")]
    }
    return labels.enumerated().map { index, label in
        InputChipModel(id: "\(index)-\(label)", age: "\(index + 1)s", label: label)
    }
}

private func inputLabel(from text: String) -> String? {
    let normalized = normalizeInputText(text)
    let pieces = normalized.split(separator: " ", maxSplits: 1).map(String.init)
    guard let prefix = pieces.first, inputEventPrefixes.contains(prefix) else {
        return nil
    }
    let payload = pieces.count > 1 ? pieces[1] : ""
    let label = beautifyInputPayload(payload)
    return label.isEmpty ? prefix : label
}

private let inputEventPrefixes: Set<String> = ["button", "touch", "swipe"]

private let inputLabelReplacements: [(String, String)] = [
    ("forward swipe", "swipe →"),
    ("right swipe", "swipe →"),
    ("backward swipe", "swipe ←"),
    ("backwards swipe", "swipe ←"),
    ("left swipe", "swipe ←"),
    ("up swipe", "swipe ↑"),
    ("down swipe", "swipe ↓"),
    ("single tap", "tap"),
    ("long press", "long"),
]

private func normalizeInputText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "->", with: " forward swipe ")
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: ":", with: " ")
        .split(separator: " ")
        .joined(separator: " ")
}

private func beautifyInputPayload(_ payload: String) -> String {
    inputLabelReplacements.reduce(payload) { label, replacement in
        label.replacingOccurrences(of: replacement.0, with: replacement.1)
    }
}

struct SystemScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @Environment(\.keyboardVisible) private var keyboardVisible
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
                hotspotCard.padding(.horizontal, 16).padding(.top, 12)
                microphoneCard.padding(.horizontal, 16).padding(.top, 8)
                inputsCard.padding(.horizontal, 16).padding(.top, 12)
                ledCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, LayoutMetric.scrollBottomPadding(keyboardVisible: keyboardVisible))
        }
        .background(AppColor.bg)
        .scrollDismissesKeyboard(.interactively)
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
                VStack(alignment: .leading, spacing: 2) {
                    Text("Wi-Fi").font(.system(size: 17, weight: .bold)).tracking(-0.17).foregroundColor(AppColor.ink)
                    Text("\(visibleWifiScanResults.count) networks nearby").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
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
                let ssid = network.ssid.isEmpty ? "Unknown" : network.ssid
                let requiresPassword = network.requiresPassword
                NetworkRowV(
                    name: ssid,
                    sub: "\(requiresPassword ? "secured" : "open") · \(network.signalStrength)",
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

    @ViewBuilder
    private var currentWifiRow: some View {
        if let currentWifi = connectedWifiStatus(model.glassesValues) {
            NetworkRowV(
                name: currentWifi.ssid,
                sub: currentWifi.localIp ?? "connected",
                subColor: AppColor.greenAccent,
                check: true,
                trailingTitle: "Forget",
                trailingColor: AppColor.red,
                action: { model.forgetCurrentWifiNetwork() }
            )
        }
    }

    private var hotspotCard: some View {
        let galleryUrl = galleryServerUrl(model.glassesValues, fallbackEnabled: model.hotspotEnabled)
        let galleryHotspotPassword = galleryUrl == nil ? nil : galleryHotspotPasswordLabel(model.glassesValues)

        return GlassCard(corner: 22, padding: EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16)) {
            HStack {
                HStack(spacing: 10) {
                    iconTileSm(systemName: "personalhotspot")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Hotspot").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.ink)
                        Text(model.glassesConnected ? hotspotLabel(model.glassesValues, fallbackEnabled: model.hotspotEnabled) : "connect glasses to toggle")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(model.hotspotEnabled ? AppColor.greenAccent : AppColor.muted)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                    }
                }
                Spacer()
                Button(action: model.toggleHotspot) {
                    ZStack(alignment: model.hotspotEnabled ? .trailing : .leading) {
                        Capsule().fill(Color.white).frame(width: 38, height: 22)
                        Circle().fill(model.hotspotEnabled ? AppColor.greenAccent : AppColor.mutedSoft).frame(width: 18, height: 18).padding(2)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!model.glassesConnected)
                .opacity(model.glassesConnected ? 1 : 0.45)
            }

            Rectangle().fill(AppColor.ink.opacity(0.05)).frame(height: 1).padding(.vertical, 10)

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Gallery server").font(.system(size: 13, weight: .bold)).foregroundColor(AppColor.ink)
                    Text(galleryUrl ?? "Enable hotspot to expose local gallery access")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(galleryUrl == nil ? AppColor.muted : AppColor.greenAccent)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    if let galleryHotspotPassword {
                        Text("Join \(galleryHotspotSsidLabel(model.glassesValues)) · password \(galleryHotspotPassword)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(AppColor.muted)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                            .padding(.top, 1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 6) {
                        HotspotActionChip(title: "Open", enabled: galleryUrl != nil, action: model.openGalleryServer)
                        HotspotActionChip(title: "Join help", enabled: galleryUrl != nil, action: model.openWifiSettings)
                    }
                    HStack(spacing: 6) {
                        HotspotActionChip(title: "Copy URL", enabled: galleryUrl != nil, action: model.copyGalleryServerUrl)
                        HotspotActionChip(title: "Copy pwd", enabled: galleryHotspotPassword != nil, action: model.copyGalleryHotspotPassword)
                    }
                }
            }

            Text(model.galleryServerStatus)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(model.galleryServerReachable == true ? AppColor.greenAccent : model.galleryServerReachable == false ? AppColor.red : AppColor.muted)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .padding(.top, 8)
        }
    }

    private var microphoneCard: some View {
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

    private var visibleWifiScanResults: [WifiScanResult] {
        let connectedSsid = connectedWifiStatus(model.glassesValues)?.ssid
        return wifiScanResults(model.bluetoothValues).filter { network in
            guard let connectedSsid else { return true }
            return network.ssid != connectedSsid
        }
    }

    private var microphoneStatusText: String {
        if model.micRecording {
            return recordingMicrophoneStatusText
        }
        if model.micPlaying {
            return "playing last recording"
        }
        if let duration = model.lastMicDurationSeconds, model.lastMicBytes > 0 {
            return "last \(durationLabel(duration)) · \(formatPcmBytes(model.lastMicBytes))"
        }
        return model.glassesConnected ? "record PCM from glasses" : "connect glasses to record"
    }

    private var recordingMicrophoneStatusText: String {
        guard model.pcmBytes > 0 else {
            return "recording · listening for speech"
        }
        return "recording · \(formatPcmBytes(model.pcmBytes)) captured"
    }

    private func formatPcmBytes(_ bytes: Int) -> String {
        if bytes < 1024 {
            return "\(bytes) B PCM"
        }
        let kib = Double(bytes) / 1024
        if kib < 1024 {
            return "\(String(format: kib >= 10 ? "%.0f" : "%.1f", kib)) KB PCM"
        }
        let mib = kib / 1024
        return "\(String(format: mib >= 10 ? "%.0f" : "%.1f", mib)) MB PCM"
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

            HStack(spacing: 8) {
                ForEach(recentInputChips(from: model.events)) { chip in
                    InputChip(prefix: chip.age, label: chip.label)
                }
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
        HStack(spacing: 6) {
            Text(prefix).font(.system(size: 10, weight: .semibold)).foregroundColor(AppColor.muted)
            Text(label)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(AppColor.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.86)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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

struct HotspotActionChip: View {
    let title: String
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(enabled ? AppColor.greenDeep : AppColor.muted)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(enabled ? AppColor.greenAccent.opacity(0.14) : AppColor.ink.opacity(0.04))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
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
