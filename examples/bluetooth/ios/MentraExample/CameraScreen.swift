import Foundation
import MentraBluetoothSDK
import SwiftUI
import UIKit

private let photoSizeOptions: [PhotoSize] = [.small, .medium, .large, .full]
private let photoCompressionOptions: [PhotoCompression] = [.none, .medium, .heavy]

private func cameraSdkCall(
    size: String,
    compression: String,
    exposureManual: Bool,
    exposureTimeNs: Int,
    iso: Int,
    cameraFov: Int,
    cameraRoiPosition: Int
) -> String {
    let exposureLine = exposureManual
        ? "      exposureTimeNs: \(exposureTimeNs),"
        : "      exposureTimeNs: nil, // auto exposure"
    let isoLine = exposureManual
        ? "      iso: \(iso)"
        : "      iso: nil // auto ISO"
    return """
    try await mentraBluetoothSdk.setCameraFov(
        CameraFov(fov: \(cameraFov), roiPosition: \(cameraRoiPosition))
    )
    // Mentra Live restarts the camera for about 5s after FOV/ROI changes.
    mentraBluetoothSdk.requestPhoto(
        PhotoRequest(
          requestId: requestId,
          appId: "com.mentra.examples.ios",
          size: .\(size),
          webhookUrl: uploadUrl,
          compress: .\(compression),
          sound: true,
    \(exposureLine)
    \(isoLine)
        )
    )
    """
}

struct CameraScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @Environment(\.keyboardVisible) private var keyboardVisible
    @FocusState private var webhookUrlFocused: Bool
    @State private var photoDetailsExpanded = false
    private var cloudServerEnabled: Bool {
        model.photoDestination == .macBookServer
    }

    private var directPhone: Bool {
        !cloudServerEnabled
    }

    private var wifiRequired: Bool {
        model.glassesConnected && !model.glassesWifiConnected
    }

    private var cameraStatusFailed: Bool {
        isCameraStatusFailure(model.cameraStatus)
    }

    private var setupHint: String? {
        guard !directPhone else { return nil }
        return localCameraSetupHint(webhookUrl: model.webhookUrl, status: model.cameraStatus)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                PageHeader(title: "Camera")
                if !model.glassesConnected {
                    OfflineNotice()
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                } else if wifiRequired {
                    OfflineNotice(message: "Connect the glasses to Wi-Fi from the System tab before capturing photos. Photos are uploaded over the glasses network connection.")
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }

                previewCard.padding(.horizontal, 16).padding(.top, 8)
                sdkCard.padding(.horizontal, 16).padding(.top, 12)
                photoDetailsCard.padding(.horizontal, 16).padding(.top, 12)
                uploadCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, LayoutMetric.scrollBottomPadding(keyboardVisible: keyboardVisible))
        }
        .background(AppColor.bg)
        .scrollDismissesKeyboard(.interactively)
    }

    private var previewCard: some View {
        GlassCard(padding: EdgeInsets(top: 8, leading: 8, bottom: 14, trailing: 8)) {
            ZStack(alignment: .bottomLeading) {
                LinearGradient(colors: [Color(hex: 0x1F4A33), Color(hex: 0x3A8A56), Color(hex: 0x7DD89E), Color(hex: 0x26B870), Color(hex: 0x163A26)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                if let photoPreviewImage = model.photoPreviewImage {
                    Image(uiImage: photoPreviewImage)
                        .resizable()
                        .scaledToFill()
                        .frame(height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 22))
                } else if let photoPreviewUrl = model.photoPreviewUrl {
                    AsyncImage(url: photoPreviewUrl) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Color.clear
                    }
                    .frame(height: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                }
                if model.photoPreviewUrl == nil && model.photoPreviewImage == nil {
                    Circle().fill(Color.white.opacity(0.55)).frame(width: 80, height: 80).blur(radius: 6).offset(x: 200, y: -30)
                    LinearGradient(colors: [.clear, .black.opacity(0.3)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 90).clipShape(RoundedRectangle(cornerRadius: 22)).offset(y: 70)
                    HStack {
                        HStack(spacing: 6) {
                            Circle().fill(AppColor.greenSoft).frame(width: 5, height: 5)
                            Text("JPEG · waiting")
                                .font(.system(size: 10, weight: .semibold)).foregroundColor(.white).tracking(0.5)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color.black.opacity(0.35))
                        .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))
                        .clipShape(Capsule())
                        Spacer()
                        Text("ready").font(.system(size: 10, weight: .medium)).foregroundColor(Color.white.opacity(0.85))
                    }
                    .padding(.horizontal, 14).padding(.bottom, 14)
                }
            }

            Button {
                model.captureAndUpload()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "camera").foregroundColor(.white).font(.system(size: 15, weight: .bold))
                    Text(!model.glassesConnected ? "Connect glasses first" : !model.glassesWifiConnected ? "Connect glasses to Wi-Fi" : model.activeAction == "Capture & upload" ? "Capturing..." : "Capture photo").foregroundColor(.white).font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: [Color(hex: 0x26473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .disabled(!model.glassesConnected || !model.glassesWifiConnected)
            .opacity(model.glassesConnected && model.glassesWifiConnected ? 1 : 0.55)
            .padding(.horizontal, 6).padding(.top, 14)
        }
    }

    private var sdkCard: some View {
        let sdkCall = cameraSdkCall(
            size: model.photoSize.rawValue,
            compression: model.photoCompression.rawValue,
            exposureManual: model.photoExposureManual,
            exposureTimeNs: model.photoExposureTimeNs,
            iso: model.photoIso,
            cameraFov: model.cameraFov,
            cameraRoiPosition: model.cameraRoiPosition
        )
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("SDK CALL").font(.system(size: 9, weight: .bold)).tracking(1.1).foregroundColor(AppColor.greenAccent)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = sdkCall
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
                Text(sdkCall)
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
                    Text(model.cameraStatus).font(.system(size: 12, weight: .semibold)).foregroundColor(AppColor.ink)
                    Text(model.photoPreviewUrl == nil && model.photoPreviewImage == nil ? "Waiting for capture" : directPhone ? "Preview loaded from phone receiver" : "Preview loaded from cloud server").font(.system(size: 11, weight: .medium)).foregroundColor(AppColor.muted)
                }
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
                if cloudServerEnabled {
                    Button {
                        model.testWebhook()
                    } label: {
                        Text("test webhook").font(.system(size: 11, weight: .medium)).foregroundColor(AppColor.greenAccent)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 12)

            Toggle(isOn: Binding(
                get: { cloudServerEnabled },
                set: { enabled in
                    model.setPhotoDestination(enabled ? .macBookServer : .thisPhone)
                }
            )) {
                Text("Use cloud server")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(AppColor.ink)
            }
            .toggleStyle(SwitchToggleStyle(tint: AppColor.greenAccent))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppColor.ink.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 12)

            if cloudServerEnabled {
                HStack(spacing: 10) {
                    Text("POST").font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                    Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                    TextField("Photo upload URL", text: $model.webhookUrl)
                        .focused($webhookUrlFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { webhookUrlFocused = false }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.ink)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.bottom, 12)
            } else {
                HStack(spacing: 10) {
                    Circle()
                        .fill(model.phonePhotoServerRunning ? AppColor.greenAccent : AppColor.muted.opacity(0.5))
                        .frame(width: 8, height: 8)
                    Text(model.phonePhotoServerRunning ? "Phone receiver ready" : "Phone receiver starts on capture")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.ink)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.bottom, 12)
            }

            if let setupHint {
                Text(setupHint)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(AppColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(AppColor.ink.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.bottom, 12)
            }

            VStack(alignment: .leading, spacing: 10) {
                CameraOptionGroup(label: "size") {
                    ForEach(photoSizeOptions, id: \.rawValue) { size in
                        CameraOptionChip(value: size.rawValue, highlight: model.photoSize == size)
                            .onTapGesture { model.setPhotoSize(size) }
                    }
                }

                CameraOptionGroup(label: "compress") {
                    ForEach(photoCompressionOptions, id: \.rawValue) { compression in
                        CameraOptionChip(value: compression.rawValue, highlight: model.photoCompression == compression)
                            .onTapGesture { model.setPhotoCompression(compression) }
                    }
                }

                ExposureSettingsCard(model: model)
                CameraFovSettingsCard(model: model)
            }
        }
    }

    private var photoDetailsCard: some View {
        let rows = photoDetailsRows(model.photoPreviewDetails)
        return GlassCard(corner: 18, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
            Button {
                photoDetailsExpanded.toggle()
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("PHOTO DETAILS")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(1.2)
                            .foregroundColor(AppColor.muted)
                        Text(photoDetailsSummary(model.photoPreviewDetails))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(AppColor.ink)
                    }
                    Spacer()
                    Text(photoDetailsExpanded ? "Hide" : "Show")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppColor.greenAccent)
                }
            }
            .buttonStyle(.plain)

            if photoDetailsExpanded {
                Rectangle()
                    .fill(AppColor.ink.opacity(0.08))
                    .frame(height: 1)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
                VStack(spacing: 8) {
                    ForEach(rows, id: \.label) { row in
                        HStack(alignment: .top) {
                            Text(row.label)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(AppColor.muted)
                            Spacer()
                            Text(row.value)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(AppColor.ink)
                                .multilineTextAlignment(.trailing)
                                .lineLimit(3)
                        }
                    }
                }
            }
        }
    }
}

private struct ExposureSettingsCard: View {
    @ObservedObject var model: BluetoothViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("EXPOSURE")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.1)
                        .foregroundColor(AppColor.muted)
                    Text(model.photoExposureManual ? exposureLabel(model.photoExposureTimeNs) : "Auto exposure")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppColor.greenAccent)
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { model.photoExposureManual },
                    set: model.setPhotoExposureManual
                ))
                .labelsHidden()
                .toggleStyle(SwitchToggleStyle(tint: AppColor.greenAccent))
            }
            Slider(
                value: Binding(
                    get: { Double(model.photoExposureTimeNs) },
                    set: { model.setPhotoExposureTimeNs(Int($0.rounded())) }
                ),
                in: Double(photoExposureMinNs) ... Double(photoExposureMaxNs),
                step: 1
            )
            .disabled(!model.photoExposureManual)
            .opacity(model.photoExposureManual ? 1 : 0.45)
            HStack {
                Text("1/1000s")
                Spacer()
                Button("Default 1/120s") { model.setPhotoExposureTimeNs(photoExposureDefaultNs) }
                    .buttonStyle(.plain)
                    .foregroundColor(AppColor.greenAccent)
                Spacer()
                Text("1/30s")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(AppColor.muted)

            VStack(alignment: .leading, spacing: 2) {
                Text("ISO")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.1)
                    .foregroundColor(AppColor.muted)
                Text(model.photoExposureManual ? "ISO \(model.photoIso)" : "Auto ISO")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(AppColor.greenAccent)
            }
            .padding(.top, 4)
            Slider(
                value: Binding(
                    get: { Double(model.photoIso) },
                    set: { model.setPhotoIso(Int($0.rounded())) }
                ),
                in: Double(photoIsoMin) ... Double(photoIsoMax),
                step: 1
            )
            .disabled(!model.photoExposureManual)
            .opacity(model.photoExposureManual ? 1 : 0.45)
            HStack {
                Text("ISO \(photoIsoMin)")
                Spacer()
                Button("Default ISO \(photoIsoDefault)") { model.setPhotoIso(photoIsoDefault) }
                    .buttonStyle(.plain)
                    .foregroundColor(AppColor.greenAccent)
                Spacer()
                Text("ISO \(photoIsoMax)")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(AppColor.muted)
        }
        .padding(14)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct CameraFovSettingsCard: View {
    @ObservedObject var model: BluetoothViewModel

    var body: some View {
        let roiDisabled = model.cameraFov == cameraFovMax
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("FIELD OF VIEW")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.1)
                        .foregroundColor(AppColor.muted)
                    Text("\(model.cameraFov)° · \(roiDisabled ? "full sensor" : "\(roiPositionLabel(model.cameraRoiPosition)) crop")")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppColor.greenAccent)
                }
                Spacer()
                Button("Apply") { model.applyCameraSettings() }
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(AppColor.greenAccent)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(AppColor.greenAccent.opacity(0.16))
                    .overlay(Capsule().stroke(AppColor.greenAccent.opacity(0.28), lineWidth: 1))
                    .clipShape(Capsule())
                    .buttonStyle(.plain)
            }
            Slider(
                value: Binding(
                    get: { Double(model.cameraFov) },
                    set: { model.setCameraFov(Int($0.rounded())) }
                ),
                in: Double(cameraFovMin) ... Double(cameraFovMax),
                step: 1
            )
            HStack {
                Text("\(cameraFovMin)°")
                Spacer()
                Button("Default \(cameraFovDefault)°") { model.setCameraFov(cameraFovDefault) }
                    .buttonStyle(.plain)
                    .foregroundColor(AppColor.greenAccent)
                Spacer()
                Text("\(cameraFovMax)°")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(AppColor.muted)

            CameraOptionGroup(label: "crop position") {
                ForEach(cameraRoiPositions, id: \.value) { option in
                    CameraOptionChip(value: option.label, highlight: model.cameraRoiPosition == option.value)
                        .opacity(roiDisabled ? 0.45 : 1)
                        .onTapGesture {
                            if !roiDisabled {
                                model.setCameraRoiPosition(option.value)
                            }
                        }
                }
            }
            Text("\(model.cameraSettingsStatus). Applying FOV/ROI restarts the Mentra Live camera for about 5 seconds.")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(AppColor.muted)
        }
        .padding(14)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private func exposureLabel(_ ns: Int) -> String {
    let denominator = Int(round(1_000_000_000.0 / Double(ns)))
    return "\(ns.formatted()) ns · 1/\(denominator)s"
}

private struct PhotoDetailsRow {
    let label: String
    let value: String
}

private func photoDetailsSummary(_ details: PhotoPreviewDetails?) -> String {
    guard let details else { return "Waiting for first photo preview" }
    if details.state == "error" {
        return "Error · \(details.error ?? "Photo failed")"
    }
    return [
        details.source,
        details.byteCount.map(formatBytes),
        dimensionsLabel(width: details.width, height: details.height),
        details.state == "acknowledged" ? "acknowledged" : "preview ready",
    ].compactMap { $0 }.joined(separator: " · ")
}

private func photoDetailsRows(_ details: PhotoPreviewDetails?) -> [PhotoDetailsRow] {
    guard let details else {
        return [PhotoDetailsRow(label: "Status", value: "No photo metadata received yet")]
    }
    var rows = [
        PhotoDetailsRow(label: "Source", value: details.source),
        PhotoDetailsRow(label: "State", value: details.state),
    ]
    if let requestId = details.requestId { rows.append(PhotoDetailsRow(label: "Request ID", value: requestId)) }
    if let byteCount = details.byteCount { rows.append(PhotoDetailsRow(label: "Size", value: formatBytes(byteCount))) }
    if let dimensions = dimensionsLabel(width: details.width, height: details.height) { rows.append(PhotoDetailsRow(label: "Dimensions", value: dimensions)) }
    if let contentType = details.contentType { rows.append(PhotoDetailsRow(label: "Content type", value: contentType)) }
    if let uploadUrl = details.uploadUrl { rows.append(PhotoDetailsRow(label: "Upload URL", value: uploadUrl)) }
    if let previewUrl = details.previewUrl { rows.append(PhotoDetailsRow(label: "Preview URL", value: previewUrl)) }
    if let timestamp = details.timestamp { rows.append(PhotoDetailsRow(label: "SDK timestamp", value: timeLabel(timestamp))) }
    if let uploadedAt = details.uploadedAt { rows.append(PhotoDetailsRow(label: "Uploaded at", value: uploadedAt)) }
    if let error = details.error { rows.append(PhotoDetailsRow(label: "Error", value: error)) }
    return rows
}

private func dimensionsLabel(width: Int?, height: Int?) -> String? {
    guard let width, let height else { return nil }
    return "\(width) x \(height)"
}

private func formatBytes(_ bytes: Int) -> String {
    if bytes >= 1024 * 1024 {
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }
    return "\(max(1, (bytes + 1023) / 1024)) KB"
}

private func timeLabel(_ timestamp: Int) -> String {
    let date = Date(timeIntervalSince1970: Double(timestamp) / 1000)
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter.string(from: date)
}

private func isCameraStatusFailure(_ status: String) -> Bool {
    let normalized = status.lowercased()
    return normalized.contains("failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("reported") ||
        normalized.contains("connect glasses first") ||
        normalized.contains("connect the glasses to wi-fi") ||
        normalized.contains("invalid") ||
        normalized.contains("replace <computer-ip>") ||
        normalized.contains("valid http") ||
        normalized.contains("enter a webhook url like") ||
        normalized.contains("no phone lan ip") ||
        normalized.contains("phone receiver failed")
}

private func localCameraSetupHint(webhookUrl: String, status: String) -> String? {
    let normalized = status.lowercased()
    let needsSetup = webhookUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        webhookUrl.contains("<computer-ip>") ||
        normalized.contains("webhook test failed") ||
        normalized.contains("returned http") ||
        normalized.contains("timed out") ||
        normalized.contains("valid http") ||
        normalized.contains("enter a webhook url like")
    if !needsSetup {
        return nil
    }
    return "Cloud server setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Photo upload URL here. It looks like http://<computer-ip>:8787/upload."
}

struct CameraOptionGroup<Content: View>: View {
    let label: String
    let content: Content

    init(label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.1)
                .foregroundColor(AppColor.muted)
                .lineLimit(1)

            HStack(spacing: 8) {
                content
            }
        }
    }
}

struct CameraOptionChip: View {
    let value: String
    var highlight: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            if highlight { Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundColor(AppColor.amber) }
            Text(value)
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(highlight ? AppColor.greenAccent : AppColor.ink)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(highlight ? Color(hex: 0x7DD89E).opacity(0.16) : Color.white.opacity(0.6))
        .overlay(Capsule().stroke(highlight ? AppColor.greenAccent.opacity(0.32) : AppColor.ink.opacity(0.06), lineWidth: 1))
        .clipShape(Capsule())
    }
}
