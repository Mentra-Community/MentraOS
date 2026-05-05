import SwiftUI
import UIKit

private let cameraSdkCall = """
sdk.requestPhoto(
  MentraPhotoRequest(
    requestId: requestId,
    appId: "com.mentra.examples.ios",
    size: "medium",
    webhookUrl: uploadUrl,
    compress: "medium",
    flash: false,
    sound: true
  )
)
"""

struct CameraScreen: View {
    @ObservedObject var model: BluetoothViewModel
    private var cameraStatusFailed: Bool {
        isCameraStatusFailure(model.cameraStatus)
    }
    private var setupHint: String? {
        localCameraSetupHint(webhookUrl: model.webhookUrl, status: model.cameraStatus)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                PageHeader(title: "Camera", connected: model.glassesConnected)
                if !model.glassesConnected {
                    OfflineNotice()
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }

                previewCard.padding(.horizontal, 16).padding(.top, 8)
                sdkCard.padding(.horizontal, 16).padding(.top, 12)
                uploadCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, 140)
        }
        .background(AppColor.bg)
    }

    private var previewCard: some View {
        GlassCard(padding: EdgeInsets(top: 8, leading: 8, bottom: 14, trailing: 8)) {
            ZStack(alignment: .bottomLeading) {
                LinearGradient(colors: [Color(hex: 0x1F4A33), Color(hex: 0x3A8A56), Color(hex: 0x7DD89E), Color(hex: 0x26B870), Color(hex: 0x163A26)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                if let photoPreviewUrl = model.photoPreviewUrl {
                    AsyncImage(url: photoPreviewUrl) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color.clear
                    }
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                }
                Circle().fill(Color.white.opacity(0.55)).frame(width: 80, height: 80).blur(radius: 6).offset(x: 200, y: -30)
                LinearGradient(colors: [.clear, .black.opacity(0.3)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 90).clipShape(RoundedRectangle(cornerRadius: 22)).offset(y: 70)
                HStack {
                    HStack(spacing: 6) {
                        Circle().fill(AppColor.greenSoft).frame(width: 5, height: 5)
                        Text(model.photoPreviewUrl == nil ? "JPEG · waiting" : "JPEG · uploaded")
                            .font(.system(size: 10, weight: .semibold)).foregroundColor(.white).tracking(0.5)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.black.opacity(0.35))
                    .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))
                    .clipShape(Capsule())
                    Spacer()
                    Text(model.photoPreviewUrl == nil ? "ready" : "latest").font(.system(size: 10, weight: .medium)).foregroundColor(Color.white.opacity(0.85))
                }
                .padding(.horizontal, 14).padding(.bottom, 14)
            }

            Button {
                model.captureAndUpload()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "camera").foregroundColor(.white).font(.system(size: 15, weight: .bold))
                    Text(!model.glassesConnected ? "Connect glasses first" : model.activeAction == "Capture & upload" ? "Capturing…" : "Capture & upload").foregroundColor(.white).font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: [Color(hex: 0x26473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .disabled(!model.glassesConnected)
            .opacity(model.glassesConnected ? 1 : 0.55)
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
                        UIPasteboard.general.string = cameraSdkCall
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
                Text(cameraSdkCall)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(AppColor.consoleText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 14).padding(.horizontal, 16)
            .background(AppColor.ink)

            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill((cameraStatusFailed ? AppColor.red : AppColor.greenAccent).opacity(0.16))
                        .frame(width: 22, height: 22)
                    Image(systemName: cameraStatusFailed ? "xmark" : "checkmark")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundColor(cameraStatusFailed ? AppColor.red : AppColor.greenAccent)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.cameraStatus).font(.system(size: 11, weight: .semibold)).foregroundColor(AppColor.ink)
                    Text(model.photoPreviewUrl == nil ? "Waiting for capture" : "Preview loaded from local webhook").font(.system(size: 10, weight: .medium)).foregroundColor(AppColor.muted)
                }
                Spacer()
                Text("View →").font(.system(size: 10, weight: .semibold)).foregroundColor(AppColor.muted)
            }
            .padding(.vertical, 12).padding(.horizontal, 16)
            .background(LinearGradient(colors: [Color.white.opacity(0.7), Color.white.opacity(0.5)], startPoint: .top, endPoint: .bottom))
        }
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.7), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var uploadCard: some View {
        GlassCard(corner: 22, padding: EdgeInsets(top: 16, leading: 18, bottom: 16, trailing: 18)) {
            HStack {
                Text("UPLOAD TO").font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundColor(AppColor.muted)
                Spacer()
                Button {
                    model.testWebhook()
                } label: {
                    Text("test webhook ↗").font(.system(size: 11, weight: .medium)).foregroundColor(AppColor.greenAccent)
                }
                .buttonStyle(.plain)
            }
            .padding(.bottom, 12)

            HStack(spacing: 10) {
                Text("POST").font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                TextField("http://192.168.1.42:8787/upload", text: $model.webhookUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(AppColor.ink)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 12)

            if let setupHint {
                Text(setupHint)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(AppColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(AppColor.ink.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.bottom, 12)
            }

            HStack(spacing: 8) {
                Chip(label: "size", value: "medium")
                Chip(label: "compress", value: "medium")
                Chip(label: "flash", value: "off")
                Spacer()
            }
        }
    }
}

private func isCameraStatusFailure(_ status: String) -> Bool {
    let normalized = status.lowercased()
    return normalized.contains("failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("reported") ||
        normalized.contains("connect glasses first") ||
        normalized.contains("invalid") ||
        normalized.contains("enter a webhook url like")
}

private func localCameraSetupHint(webhookUrl: String, status: String) -> String? {
    let normalized = status.lowercased()
    let needsSetup = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        normalized.contains("webhook test failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("enter a webhook url like")
    if !needsSetup {
        return nil
    }
    return "Local setup: run python3 examples/local-demo-cloud/server.py from the Partner Kit repo root, then paste the printed Photo upload URL here."
}

struct Chip: View {
    let label: String; let value: String
    var highlight: Bool = false
    var body: some View {
        HStack(spacing: 6) {
            if highlight { Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundColor(AppColor.amber) }
            Text(label.uppercased()).font(.system(size: 11, weight: .medium)).tracking(0.5).foregroundColor(AppColor.muted)
            Text(value).font(.system(size: 12, weight: .bold)).foregroundColor(highlight ? AppColor.greenAccent : AppColor.ink)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(highlight ? Color(hex: 0x7DD89E).opacity(0.16) : Color.white.opacity(0.6))
        .overlay(Capsule().stroke(highlight ? AppColor.greenAccent.opacity(0.32) : AppColor.ink.opacity(0.06), lineWidth: 1))
        .clipShape(Capsule())
    }
}
