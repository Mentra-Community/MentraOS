import SwiftUI

struct SystemScreen: View {
    @ObservedObject var model: BluetoothViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                StatusBarRow()
                PageHeader(title: "System", connected: boolValue(model.glassesValues, "connected") == true)
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
    }

    private var wifiCard: some View {
        GlassCard(padding: EdgeInsets(top: 18, leading: 18, bottom: 6, trailing: 18)) {
            HStack {
                HStack(spacing: 10) {
                    iconTile
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Wi-Fi").font(.system(size: 17, weight: .bold)).tracking(-0.17).foregroundColor(AppColor.ink)
                        Text("\(wifiScanResults(model.bluetoothValues).count) networks nearby").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
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

            NetworkRowV(name: wifiLabel(model.glassesValues), sub: stringValue(model.glassesValues, "wifiLocalIp") ?? "not connected", subColor: AppColor.greenAccent, check: true)
            let rows = wifiScanResults(model.bluetoothValues)
            ForEach(Array((rows.isEmpty ? [["ssid": "Scan for nearby networks", "requiresPassword": false, "signalStrength": 0]] : rows).enumerated()), id: \.offset) { index, network in
                let ssid = stringValue(network, "ssid") ?? "Unknown"
                let requiresPassword = boolValue(network, "requiresPassword") ?? false
                NetworkRowV(
                    name: ssid,
                    sub: "\(requiresPassword ? "secured" : "open") · \(intValue(network, "signalStrength") ?? 0)",
                    subColor: AppColor.muted,
                    faint: true,
                    locked: requiresPassword,
                    last: index == (rows.isEmpty ? 0 : rows.count - 1),
                    action: ssid == "Scan for nearby networks" || !model.glassesConnected ? nil : { model.sendWifiCredentials(ssid: ssid) }
                )
            }
        }
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
                    Text(model.hotspotEnabled ? "enabled" : "disabled").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
                }
            }
            }
            .disabled(!model.glassesConnected)
            .opacity(model.glassesConnected ? 1 : 0.55)
            Button(action: model.toggleMic) {
            GlassCard(corner: 22, padding: EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)) {
                HStack {
                    iconTileSm(systemName: "mic")
                    Spacer()
                    HStack(alignment: .bottom, spacing: 2) {
                        ForEach([6, 14, 8, 16, 10], id: \.self) { h in
                            RoundedRectangle(cornerRadius: 1.5).fill(AppColor.greenAccent).frame(width: 3, height: CGFloat(h))
                        }
                    }
                }
                .padding(.bottom, 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Microphone").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.ink)
                    Text(model.micRecording ? "\(model.pcmFrames) PCM frames · \(model.pcmBytes) bytes" : "tap to start PCM").font(.system(size: 10, weight: .medium)).foregroundColor(model.micRecording ? AppColor.greenAccent : AppColor.muted)
                }
            }
            }
            .disabled(!model.glassesConnected)
            .opacity(model.glassesConnected ? 1 : 0.55)
        }
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
                    Circle().fill(boolValue(model.glassesValues, "connected") == true ? AppColor.greenAccent : AppColor.mutedSoft).frame(width: 5, height: 5)
                    Text(boolValue(model.glassesValues, "connected") == true ? "LIVE" : "OFF").font(.system(size: 10, weight: .bold)).tracking(0.5).foregroundColor(AppColor.greenDeep)
                }
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(AppColor.greenAccent.opacity(0.16))
                .overlay(Capsule().stroke(AppColor.greenAccent.opacity(0.3), lineWidth: 1))
                .clipShape(Capsule())
            }
            .padding(.bottom, 10)

            HStack(spacing: 6) {
                ForEach(Array((model.events.filter { $0.text.contains("button") || $0.text.contains("touch") }.prefix(3).map(\.text).ifEmpty(["waiting for input"])).enumerated()), id: \.offset) { index, text in
                    InputChip(prefix: "\(index + 1)s", label: text)
                }
                Spacer()
            }
        }
    }

    private var ledCard: some View {
        GlassCard(corner: 24, padding: EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18)) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("RGB LED").font(.system(size: 18, weight: .bold)).tracking(-0.18).foregroundColor(AppColor.ink)
                    Text("intensity & pattern").font(.system(size: 11)).foregroundColor(AppColor.muted)
                }
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(AppColor.greenAccent).frame(width: 8, height: 8)
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
            .padding(.bottom, 14)

            HStack {
                Text("BRIGHTNESS").font(.system(size: 10, weight: .semibold)).tracking(1.6).foregroundColor(AppColor.muted)
                Spacer()
                Text("72%").font(.system(size: 12, weight: .semibold)).foregroundColor(AppColor.ink)
            }
            .padding(.bottom, 8)

            ZStack(alignment: .leading) {
                Capsule().fill(AppColor.ink.opacity(0.08)).frame(height: 8)
                GeometryReader { geo in
                    ZStack(alignment: .trailing) {
                        Capsule()
                            .fill(LinearGradient(colors: [Color(hex: 0x3FB76A), AppColor.greenSoft], startPoint: .leading, endPoint: .trailing))
                            .frame(width: geo.size.width * 0.72, height: 8)
                    }
                    .frame(height: 8)
                }
                .frame(height: 8)
                GeometryReader { geo in
                    Circle().fill(Color.white)
                        .frame(width: 20, height: 20)
                        .position(x: geo.size.width * 0.72 - 10, y: 4)
                        .shadow(color: Color(hex: 0x0F2A1D).opacity(0.18), radius: 6, x: 0, y: 2)
                }
                .frame(height: 8)
            }
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
                if locked { Image(systemName: "lock.fill").font(.system(size: 11)).foregroundColor(AppColor.ink) }
            }
            .padding(.vertical, 14)
            if !last { Rectangle().fill(AppColor.ink.opacity(0.04)).frame(height: 1) }
        }
        }
        .buttonStyle(.plain)
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
