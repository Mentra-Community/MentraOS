import SwiftUI

struct ConsoleScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @Environment(\.keyboardVisible) private var keyboardVisible
    @State private var filter = "ALL"

    private var filteredEvents: [ExampleEvent] {
        filter == "ALL" ? model.events : model.events.filter { $0.tag == filter }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                PageHeader(title: "Console", connected: model.glassesConnected)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button { filter = "ALL" } label: {
                            HStack(spacing: 6) {
                                Text("ALL").font(.system(size: 11, weight: .bold)).tracking(0.5).foregroundColor(.white)
                                Text("\(model.events.count)").font(.system(size: 10, weight: .medium)).foregroundColor(Color.white.opacity(0.5))
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(LinearGradient(colors: [Color(hex: 0x28473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom))
                            .clipShape(Capsule())
                        }
                        FilterChip(color: Color(hex: 0x00C7BE), labelColor: Color(hex: 0x00807B), label: "LIVE", count: "\(model.events.filter { $0.tag == "LIVE" }.count)", active: filter == "LIVE") { filter = "LIVE" }
                        FilterChip(color: Color(hex: 0x84B5E8), labelColor: Color(hex: 0x3478B8), label: "BLE", count: "\(model.events.filter { $0.tag == "BLE" }.count)", active: filter == "BLE") { filter = "BLE" }
                        FilterChip(color: AppColor.amber, labelColor: Color(hex: 0xB86A00), label: "TX", count: "\(model.events.filter { $0.tag == "TX" }.count)", active: filter == "TX") { filter = "TX" }
                        FilterChip(color: AppColor.gold, labelColor: Color(hex: 0x8C7400), label: "STORE", count: "\(model.events.filter { $0.tag == "STORE" }.count)", active: filter == "STORE") { filter = "STORE" }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.top, 8)

                consoleCard.padding(.horizontal, 16).padding(.top, 12)
                jsonCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, LayoutMetric.scrollBottomPadding(keyboardVisible: keyboardVisible))
        }
        .background(AppColor.bg)
        .scrollDismissesKeyboard(.interactively)
    }

    private var consoleCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                HStack(spacing: 8) {
                    HStack(spacing: 4) {
                        Circle().fill(Color(hex: 0xFF5F57)).frame(width: 8, height: 8)
                        Circle().fill(Color(hex: 0xFEBC2E)).frame(width: 8, height: 8)
                        Circle().fill(Color(hex: 0x27C93F)).frame(width: 8, height: 8)
                    }
                    Text("mentra-sdk · live").font(.system(size: 11, weight: .medium)).foregroundColor(Color.white.opacity(0.5))
                }
                Spacer()
                HStack(spacing: 5) {
                    Circle().fill(AppColor.greenSoft).frame(width: 5, height: 5)
                    Text("REC").font(.system(size: 9, weight: .bold)).tracking(0.7).foregroundColor(AppColor.greenSoft)
                }
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(AppColor.greenSoft.opacity(0.14))
                .overlay(Capsule().stroke(AppColor.greenSoft.opacity(0.3), lineWidth: 1))
                .clipShape(Capsule())
            }
            .padding(.bottom, 6)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1) }

            VStack(spacing: 10) {
                ForEach(filteredEvents) { e in
                    HStack(alignment: .top, spacing: 10) {
                        Text(e.time)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(Color.white.opacity(0.4))
                            .frame(width: 50, alignment: .leading)
                            .padding(.top, 2)
                        Text(e.tag)
                            .font(.system(size: 9, weight: .bold)).tracking(0.5)
                            .foregroundColor(tagColor(e.tag))
                            .frame(width: 50)
                            .padding(.vertical, 3)
                            .background(tagColor(e.tag).opacity(0.16))
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        Text(e.text)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(AppColor.consoleText)
                        Spacer()
                    }
                }
            }
        }
        .padding(18)
        .background(AppColor.consoleBg)
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color.white.opacity(0.06), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .shadow(color: Color(hex: 0x0F2A1D).opacity(0.18), radius: 40, x: 0, y: 12)
    }

    private var jsonCard: some View {
        VStack(spacing: 10) {
            Button {
                model.rawJsonExpanded.toggle()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 12, weight: .semibold)).foregroundColor(AppColor.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Typed SDK status").font(.system(size: 13, weight: .semibold)).foregroundColor(AppColor.ink)
                        Text("glassesStatus, bluetoothStatus").font(.system(size: 10)).foregroundColor(AppColor.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .heavy)).foregroundColor(AppColor.ink)
                }
                .padding(.vertical, 14).padding(.horizontal, 16)
                .background(LinearGradient(colors: [Color.white.opacity(0.7), Color.white.opacity(0.5)], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.7), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            if model.rawJsonExpanded {
                Text("glassesStatus=\(String(describing: model.glassesValues))\nbluetoothStatus=\(String(describing: model.bluetoothValues))")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(AppColor.consoleText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(AppColor.consoleBg)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
    }
}

private func tagColor(_ tag: String) -> Color {
    switch tag {
    case "BLE": Color(hex: 0x84B5E8)
    case "STORE": Color(hex: 0xE8C66B)
    case "TX": Color(hex: 0xE89C7D)
    default: Color(hex: 0x7DD89E)
    }
}

struct FilterChip: View {
    let color: Color; let labelColor: Color; let label: String; let count: String
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(label).font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(labelColor)
                Text(count).font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? color.opacity(0.14) : Color.white.opacity(0.6))
            .overlay(Capsule().stroke(active ? color.opacity(0.35) : Color.white.opacity(0.75), lineWidth: 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
