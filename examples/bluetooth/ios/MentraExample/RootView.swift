import SwiftUI
import UIKit

struct RootView: View {
    @State private var tab: Tab = .device
    @StateObject private var bluetooth = BluetoothViewModel()
    @StateObject private var keyboard = KeyboardState()

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
            .environment(\.keyboardVisible, keyboard.isVisible)
            VStack {
                Spacer(minLength: 0)
                if !keyboard.isVisible {
                    TabBarView(active: $tab)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .animation(.easeOut(duration: 0.18), value: keyboard.isVisible)
    }
}

final class KeyboardState: ObservableObject {
    @Published var isVisible = false
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            self?.isVisible = true
        })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.isVisible = false
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
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
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(active == t ? .white : AppColor.muted)
                        Text(t.label)
                            .font(.system(size: 11, weight: active == t ? .semibold : .medium))
                            .foregroundColor(active == t ? .white : AppColor.muted)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 58)
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
