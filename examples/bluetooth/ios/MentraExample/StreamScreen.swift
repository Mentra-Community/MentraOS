import SwiftUI
import UIKit

private let streamSdkCall = """
sdk.startStream(
  MentraStreamRequest(
    values: [
      "streamUrl": streamUrl,
      "protocol": streamProtocol.rawValue,
      "keepAlive": true,
      "keepAliveIntervalSeconds": 15
    ]
  )
)
"""

struct StreamScreen: View {
    @ObservedObject var model: BluetoothViewModel
    private let bars: [CGFloat] = [18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40]

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                StatusBarRow()
                PageHeader(title: "Stream", connected: boolValue(model.glassesValues, "connected") == true)

                previewCard.padding(.horizontal, 16).padding(.top, 8)
                sdkCard.padding(.horizontal, 16).padding(.top, 12)
                protocolCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, 140)
        }
        .background(AppColor.bg)
    }

    private var previewCard: some View {
        GlassCard(padding: EdgeInsets(top: 8, leading: 8, bottom: 14, trailing: 8)) {
            ZStack {
                LinearGradient(colors: [Color(hex: 0x163A26), Color(hex: 0x26583E), Color(hex: 0x7DD89E), Color(hex: 0x3F8F5C)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(height: 160).clipShape(RoundedRectangle(cornerRadius: 22))
                Circle().fill(Color.white.opacity(0.2)).frame(width: 220, height: 220).blur(radius: 10).offset(x: -90, y: -100)
                Circle().fill(AppColor.greenSoft.opacity(0.3)).frame(width: 240, height: 240).blur(radius: 10).offset(x: 100, y: 110)

                VStack {
                    HStack {
                        HStack(spacing: 6) {
                            Circle().fill(model.streamStartedAt == nil ? AppColor.greenSoft : AppColor.redLive).frame(width: 7, height: 7)
                            Text(model.streamStartedAt == nil ? "READY" : "LIVE").font(.system(size: 11, weight: .bold)).tracking(0.8).foregroundColor(.white)
                        }
                        .padding(.horizontal, 11).padding(.vertical, 6)
                        .background(Color.black.opacity(0.45))
                        .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))
                        .clipShape(Capsule())
                        Spacer()
                        Text(elapsedText(model.streamStartedAt)).font(.system(size: 13, weight: .semibold)).foregroundColor(.white)
                    }
                    .padding(.horizontal, 14).padding(.top, 14)

                    Spacer()

                    HStack(alignment: .bottom, spacing: 5) {
                        ForEach(0..<bars.count, id: \.self) { i in
                            RoundedRectangle(cornerRadius: 3)
                                .fill(i % 3 == 2 ? Color.white : Color.white.opacity(0.85))
                                .frame(width: 5, height: bars[i])
                        }
                    }
                    .padding(.bottom, 56)

                    HStack {
                        Text(model.streamStartedAt == nil ? "Ready · enter stream URL" : "\(model.streamProtocol.rawValue.uppercased()) · keep-alive 15s")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.85))
                        Spacer()
                    }
                    .padding(.horizontal, 14).padding(.bottom, 14)
                }
                .frame(height: 160)
            }

            Button {
                model.toggleStream()
            } label: {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.white).frame(width: 12, height: 12)
                    Text(model.streamStartedAt == nil ? "Start stream" : "End stream").foregroundColor(.white).font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: model.streamStartedAt == nil ? [Color(hex: 0x26473A), Color(hex: 0x1F3A2A)] : [Color(hex: 0xFF6B5B), AppColor.red], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .padding(.horizontal, 6).padding(.top, 14)
        }
    }

    private var sdkCard: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("SDK CALL").font(.system(size: 9, weight: .bold)).tracking(1.1).foregroundColor(AppColor.greenAccent)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = streamSdkCall
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.on.doc").font(.system(size: 9)).foregroundColor(AppColor.consoleText)
                            Text("Copy").font(.system(size: 10, weight: .semibold)).foregroundColor(AppColor.consoleText)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Color.white.opacity(0.06)).clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
                Text(streamSdkCall)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(AppColor.consoleText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 14).padding(.horizontal, 16)
            .background(AppColor.ink)

            HStack(spacing: 10) {
                ZStack {
                    Circle().fill(AppColor.red.opacity(0.16)).frame(width: 22, height: 22)
                    Circle().fill(AppColor.red).frame(width: 8, height: 8)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.streamStatus).font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.ink)
                    Text("uptime \(elapsedText(model.streamStartedAt)) · keep-alive 15s").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
                }
                Spacer()
                Text("Stats →").font(.system(size: 10, weight: .semibold)).foregroundColor(AppColor.muted)
            }
            .padding(.vertical, 12).padding(.horizontal, 16)
            .background(LinearGradient(colors: [Color.white.opacity(0.7), Color.white.opacity(0.5)], startPoint: .top, endPoint: .bottom))
        }
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.7), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var protocolCard: some View {
        GlassCard(corner: 22, padding: EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)) {
            HStack(spacing: 4) {
                ProtocolTab(title: "RTMP", active: model.streamProtocol == .rtmp) { model.selectStreamProtocol(.rtmp) }
                ProtocolTab(title: "SRT", active: model.streamProtocol == .srt) { model.selectStreamProtocol(.srt) }
                ProtocolTab(title: "WebRTC", active: model.streamProtocol == .webrtc) { model.selectStreamProtocol(.webrtc) }
            }
            .padding(4)
            .background(AppColor.ink.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .padding(.bottom, 12)

            HStack(spacing: 10) {
                Text(model.streamProtocol.inputLabel).font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                TextField(model.streamProtocol.defaultUrl, text: $model.streamUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(AppColor.ink)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "square.and.pencil").font(.system(size: 14)).foregroundColor(AppColor.muted)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct ProtocolTab: View {
    let title: String; let active: Bool
    let action: () -> Void
    var body: some View {
        Button {
            action()
        } label: {
            Text(title)
                .font(.system(size: 12, weight: active ? .bold : .medium))
                .foregroundColor(active ? AppColor.ink : AppColor.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(active ? Color.white : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}
