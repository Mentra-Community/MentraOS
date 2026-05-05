import SwiftUI

struct RootView: View {
    @State private var tab: Tab = .device
    @StateObject private var bluetooth = BluetoothViewModel()

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()
            Group {
                switch tab {
                case .device: DeviceScreen(model: bluetooth)
                case .camera: CameraScreen(model: bluetooth)
                case .stream: StreamScreen(model: bluetooth)
                case .system: SystemScreen(model: bluetooth)
                case .console: ConsoleScreen(model: bluetooth)
                }
            }
            VStack {
                Spacer(minLength: 0)
                TabBarView(active: $tab)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(.container, edges: .bottom)
            .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}

struct TabBarView: View {
    @Binding var active: Tab

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button {
                    active = t
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: iconName(t))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(active == t ? .white : AppColor.muted)
                        Text(t.label)
                            .font(.system(size: 10, weight: active == t ? .semibold : .medium))
                            .foregroundColor(active == t ? .white : AppColor.muted)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity)
                    .background(
                        Group {
                            if active == t {
                                LinearGradient(colors: [Color(hex: 0x28473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom)
                            } else {
                                Color.clear
                            }
                        }
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                }
            }
        }
        .padding(8)
        .background(Color.white.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: 30)
                .stroke(Color.white.opacity(0.8), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 30))
        .shadow(color: Color(hex: 0x0F2A1D).opacity(0.16), radius: 44, x: 0, y: 14)
    }

    private func iconName(_ t: Tab) -> String {
        switch t {
        case .device: return "bolt.fill"
        case .camera: return "camera"
        case .stream: return "dot.radiowaves.left.and.right"
        case .system: return "square.grid.2x2"
        case .console: return "chevron.left.forwardslash.chevron.right"
        }
    }
}
