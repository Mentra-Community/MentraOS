import SwiftUI

enum Tab: String, CaseIterable {
    case device, camera, stream, system, console

    var label: String {
        switch self {
        case .device: return "Device"
        case .camera: return "Camera"
        case .stream: return "Stream"
        case .system: return "System"
        case .console: return "Console"
        }
    }
}

enum AppColor {
    static let bg = Color.white
    static let ink = Color(hex: 0x0E1A14)
    static let inkAlt = Color(hex: 0x0E0E10)
    static let muted = Color(hex: 0x6B7268)
    static let mutedSoft = Color(hex: 0x9DA29A)
    static let greenPrimary = Color(hex: 0x16A34A)
    static let greenAccent = Color(hex: 0x34C759)
    static let greenInk = Color(hex: 0x0E2C1A)
    static let greenSoft = Color(hex: 0x7DD89E)
    static let greenDeep = Color(hex: 0x248A3D)
    static let red = Color(hex: 0xFF3B30)
    static let redLive = Color(hex: 0xFF5252)
    static let amber = Color(hex: 0xFF9500)
    static let gold = Color(hex: 0xFFCC00)
    static let ble = Color(hex: 0x84B5E8)
    static let store = Color(hex: 0xE8C66B)
    static let tx = Color(hex: 0xE89C7D)
    static let consoleBg = Color(red: 0.078, green: 0.086, blue: 0.082, opacity: 0.92)
    static let consoleText = Color(hex: 0xE8E2CE)

    static let surfaceTint = Color.white.opacity(0.78)
    static let surfaceTintLow = Color.white.opacity(0.55)
    static let border = Color.white.opacity(0.75)
    static let borderSoft = Color.white.opacity(0.7)
    static let hairline = Color(hex: 0x0F2A1D).opacity(0.08)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}

struct GlassCard<Content: View>: View {
    var corner: CGFloat = 28
    var padding: EdgeInsets = EdgeInsets(top: 22, leading: 22, bottom: 22, trailing: 22)
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(padding)
            .background(
                LinearGradient(colors: [AppColor.surfaceTint, AppColor.surfaceTintLow], startPoint: .top, endPoint: .bottom)
            )
            .overlay(
                RoundedRectangle(cornerRadius: corner)
                    .stroke(AppColor.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: corner))
            .shadow(color: Color(hex: 0x0F2A1D).opacity(0.08), radius: 18, x: 0, y: 12)
    }
}

struct PageHeader: View {
    let title: String
    var connected = false

    var body: some View {
        HStack {
            Circle()
                .fill(Color.white.opacity(0.6))
                .overlay(Circle().stroke(AppColor.border, lineWidth: 1))
                .overlay(Image(systemName: "gearshape").foregroundColor(AppColor.ink).font(.system(size: 14, weight: .medium)))
                .frame(width: 38, height: 38)
                .shadow(color: Color(hex: 0x0F2A1D).opacity(0.08), radius: 14, x: 0, y: 4)
            Spacer()
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(AppColor.ink)
                .tracking(-0.17)
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(connected ? AppColor.greenAccent : AppColor.mutedSoft).frame(width: 7, height: 7)
                Text(connected ? "Live" : "Offline").font(.system(size: 13, weight: .semibold)).foregroundColor(AppColor.ink)
            }
            .padding(.horizontal, 11)
            .frame(height: 34)
            .background(Color.white.opacity(0.6))
            .overlay(Capsule().stroke(AppColor.border, lineWidth: 1))
            .clipShape(Capsule())
            .shadow(color: Color(hex: 0x0F2A1D).opacity(0.08), radius: 14, x: 0, y: 4)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
    }
}

struct OfflineNotice: View {
    var message = "Connect glasses on the Device tab to use camera, streaming, Wi-Fi, microphone, LED, and display controls."

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(AppColor.amber)
                .padding(.top, 1)
            Text(message)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(AppColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(AppColor.amber.opacity(0.12))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppColor.amber.opacity(0.28), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}
