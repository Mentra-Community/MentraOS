import SwiftUI

struct DeviceScreen: View {
    @ObservedObject var model: BluetoothViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                StatusBarRow()
                PageHeader(title: "Device", connected: boolValue(model.glassesValues, "connected") == true)

                heroCard
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                statRow
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                quickActions
                    .padding(.horizontal, 16)
                    .padding(.top, 16)

                liveStatus
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
            }
            .padding(.bottom, 140)
        }
        .background(AppColor.bg)
    }

    private var heroCard: some View {
        GlassCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(connectionLabel(model.glassesValues))
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(1.2)
                        .foregroundColor(AppColor.greenAccent)
                    Text(modelLabel(model.glassesValues))
                        .font(.system(size: 28, weight: .heavy))
                        .tracking(-0.7)
                        .foregroundColor(AppColor.ink)
                    Text(deviceLabel(model.glassesValues))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(AppColor.muted)
                }
                Spacer()
                Image(glassesAssetName(model.glassesValues))
                    .resizable()
                    .scaledToFit()
                    .frame(width: 145, height: 52)
            }
            Divider().background(AppColor.hairline).padding(.top, 14).padding(.bottom, 12)
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("BATTERY")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(1.2)
                        .foregroundColor(AppColor.muted)
                    HStack(alignment: .lastTextBaseline, spacing: 6) {
                        Text(batteryLevel(model.glassesValues).map(String.init) ?? "--")
                            .font(.system(size: 56, weight: .heavy))
                            .tracking(-2.2)
                            .foregroundColor(AppColor.ink)
                        Text("%")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(AppColor.muted)
                    }
                    HStack(spacing: 6) {
                        Image(systemName: "bolt.fill").foregroundColor(AppColor.greenAccent).font(.system(size: 11))
                        Text(boolValue(model.glassesValues, "charging") == true ? "Charging" : "Waiting").font(.system(size: 12, weight: .semibold)).foregroundColor(AppColor.greenAccent)
                    }
                }
                Spacer()
                HStack(alignment: .bottom, spacing: 4) {
                    ForEach(0..<7, id: \.self) { i in
                        let heights: [CGFloat] = [14, 22, 30, 38, 46, 54, 62]
                        RoundedRectangle(cornerRadius: 3)
                            .fill((batteryLevel(model.glassesValues) ?? 0) > Int(Double(i) / 7.0 * 100.0) ? AppColor.greenAccent : Color.black.opacity(0.06))
                            .frame(width: 6, height: heights[i])
                    }
                }
                .padding(.bottom, 6)
            }
        }
    }

    private var statRow: some View {
        HStack(spacing: 10) {
            StatTile(label: "FIRMWARE", value: firmwareLabel(model.glassesValues), sub: "reported", subColor: AppColor.greenAccent)
            StatTile(label: "WI-FI", value: wifiLabel(model.glassesValues), sub: stringValue(model.glassesValues, "wifiLocalIp") ?? "unknown", subColor: AppColor.muted, bold: true)
            StatTile(label: "RSSI", value: rssiLabel(model.glassesValues), sub: "signal", subColor: AppColor.greenAccent, bold: true)
        }
    }

    private var quickActions: some View {
        let connected = model.glassesConnected
        return GlassCard {
            HStack {
                Text("Quick actions")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(AppColor.inkAlt)
                Spacer()
                Text("SDK")
                    .font(.system(size: 10, weight: .semibold).monospaced())
                    .tracking(1.6)
                    .foregroundColor(AppColor.inkAlt.opacity(0.4))
            }
            .padding(.bottom, 16)

            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    DarkActionButton(icon: "magnifyingglass", title: "Scan", bg: Color(hex: 0x0E2C1A), action: model.startScan)
                    DarkActionButton(icon: "link", title: "Connect", bg: AppColor.greenPrimary, action: model.connect)
                }
                HStack(spacing: 8) {
                    LightActionButton(icon: "display", title: "Display Hello", enabled: connected, action: model.displayHello)
                    LightActionButton(icon: "display.slash", title: "Clear Display", enabled: connected, action: model.clearDisplay)
                }
                HStack(spacing: 8) {
                    LightActionButton(icon: "checkmark", title: "Apply Settings", enabled: connected, action: model.applySettings)
                    Button {
                        model.disconnect()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "wifi.slash").foregroundColor(.white).font(.system(size: 14, weight: .bold))
                            Text("Disconnect").foregroundColor(.white).font(.system(size: 13, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(LinearGradient(colors: [Color(hex: 0xFF6B5B), AppColor.red], startPoint: .top, endPoint: .bottom))
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                    }
                    .disabled(!connected)
                    .opacity(connected ? 1 : 0.45)
                }
            }
        }
    }

    private var liveStatus: some View {
        GlassCard(padding: EdgeInsets(top: 22, leading: 0, bottom: 22, trailing: 0)) {
            HStack {
                HStack(spacing: 8) {
                    Circle().fill(AppColor.greenPrimary).frame(width: 7, height: 7)
                    Text("Live status").font(.system(size: 16, weight: .bold)).foregroundColor(AppColor.inkAlt)
                }
                Spacer()
                Text("REC")
                    .font(.system(size: 10, weight: .semibold).monospaced())
                    .tracking(1.6)
                    .foregroundColor(AppColor.greenInk)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(AppColor.greenInk.opacity(0.06))
                    .clipShape(Capsule())
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 16)

            VStack(spacing: 0) {
                StatusKVRow(label: "LAST ACTION", value: model.lastAction, first: true)
                StatusKVRow(label: "CONNECTION", custom: AnyView(
                    HStack(spacing: 6) { Circle().fill(AppColor.greenPrimary).frame(width: 6, height: 6); Text(connectionLabel(model.glassesValues)).font(.system(size: 13, weight: .semibold)).foregroundColor(AppColor.greenInk) }
                ))
                StatusKVRow(label: "DEVICE", value: deviceLabel(model.glassesValues), mono: true)
                StatusKVRow(label: "BATTERY", custom: AnyView(
                    HStack(spacing: 8) {
                        Text(batteryLabel(model.glassesValues)).font(.system(size: 13, weight: .semibold)).foregroundColor(AppColor.inkAlt)
                        HStack(spacing: 4) {
                            Image(systemName: "bolt.fill").foregroundColor(AppColor.greenPrimary).font(.system(size: 8))
                            Text("charging").font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.greenPrimary)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(AppColor.greenPrimary.opacity(0.08)).clipShape(Capsule())
                    }
                ))
                StatusKVRow(label: "BLUETOOTH", value: bluetoothSearchLabel(model.bluetoothValues))
                StatusKVRow(label: "DISCOVERED", value: model.discoveredDevices.map(\.name).joined(separator: ", ").isEmpty ? "None yet" : model.discoveredDevices.map(\.name).joined(separator: ", "), mono: true)
                StatusKVRow(label: "PERMISSIONS", value: "iOS prompts as needed")
                StatusKVRow(label: "CAMERA", value: model.cameraStatus)
                StatusKVRow(label: "LATEST EVENT", custom: AnyView(
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            HStack(spacing: 4) {
                                Circle().fill(AppColor.greenPrimary).frame(width: 5, height: 5)
                                Text(model.events.first?.tag ?? "NONE").font(.system(size: 10, weight: .semibold).monospaced()).foregroundColor(AppColor.greenPrimary)
                            }
                            .padding(.horizontal, 7).padding(.vertical, 2).background(AppColor.greenPrimary.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 5))
                            Text(model.events.first?.time ?? "--:--:--").font(.system(size: 11, design: .monospaced)).foregroundColor(AppColor.inkAlt.opacity(0.65))
                        }
                        Text(model.events.first?.text ?? "No events yet").font(.system(size: 13, weight: .medium)).foregroundColor(AppColor.inkAlt)
                    }
                ))
            }
            .padding(.horizontal, 18)
        }
    }
}

private func glassesAssetName(_ values: [String: Any]) -> String {
    let model = [
        stringValue(values, "deviceModel"),
        stringValue(values, "bluetoothName"),
        stringValue(values, "defaultWearable"),
    ]
    .compactMap { $0 }
    .joined(separator: " ")
    .lowercased()

    if model.contains("even"), model.contains("g2") {
        return "even_realities_g2"
    }
    if model.contains("even") || model.contains("g1") {
        return "even_realities_g1"
    }
    if model.contains("display") {
        return "mentra_display"
    }
    if model.contains("vuzix") || model.contains("z100") {
        return "vuzix_z100"
    }
    if model.contains("unknown") {
        return "unknown_wearable"
    }
    return "mentra_live"
}

struct StatTile: View {
    let label: String
    let value: String
    let sub: String
    let subColor: Color
    var bold: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 9, weight: .semibold)).tracking(1.1).foregroundColor(AppColor.muted)
            Text(value).font(.system(size: 14, weight: bold ? .bold : .semibold)).foregroundColor(AppColor.ink)
            Text(sub).font(.system(size: 11, weight: .medium)).foregroundColor(subColor)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(Color.white)
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.7), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .shadow(color: Color(hex: 0x0F2A1D).opacity(0.07), radius: 22, x: 0, y: 8)
    }
}

struct DarkActionButton: View {
    let icon: String; let title: String; let bg: Color
    let action: () -> Void
    var body: some View {
        Button {
            action()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundColor(.white).font(.system(size: 14, weight: .bold))
                Text(title).foregroundColor(.white).font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .background(bg).clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }
}

struct LightActionButton: View {
    let icon: String; let title: String
    var enabled: Bool = true
    let action: () -> Void
    var body: some View {
        Button {
            action()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon).foregroundColor(AppColor.inkAlt).font(.system(size: 14, weight: .bold))
                Text(title).foregroundColor(AppColor.inkAlt).font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .background(Color.white)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(hex: 0xDBDBDB), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

struct StatusKVRow: View {
    let label: String
    var value: String? = nil
    var custom: AnyView? = nil
    var mono: Bool = false
    var first: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(label)
                .font(.system(size: 10, weight: .semibold).monospaced())
                .tracking(1.4)
                .foregroundColor(AppColor.inkAlt.opacity(0.5))
                .frame(width: 90, alignment: .leading)
            Group {
                if let custom = custom { custom }
                else if let value = value {
                    Text(value)
                        .font(mono ? .system(size: 12, design: .monospaced) : .system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.inkAlt)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 11)
        .overlay(alignment: .top) {
            if !first { Rectangle().fill(Color(hex: 0xF2EDE0)).frame(height: 1) }
        }
    }
}
