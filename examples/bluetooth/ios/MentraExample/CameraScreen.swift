import AVKit
import Foundation
import MentraBluetoothSDK
import SwiftUI
import UIKit

// SDK 0.1.12 `PhotoSize` ships the small/medium/large/full tiers. The low|medium|high|max
// rename lands in 0.1.13; until the SwiftPM pin is bumped, use the published cases here.
private let photoSizeOptions: [PhotoSize] = [.small, .medium, .large, .full]
private let photoCompressionOptions: [PhotoCompression] = [.none, .medium, .heavy]

private enum CameraCaptureMode {
    case photo
    case video
}

private func cameraSdkCall(
    mode: CameraCaptureMode,
    size: String,
    compression: String,
    exposureManual: Bool,
    exposureTimeNs: Int,
    iso: Int,
    cameraFov: Int,
    cameraRoiPosition: Int,
    scanMode: Bool,
    scanAeDivisor: Int,
    scanIsoCap: Int
) -> String {
    if scanMode {
        return """
    // Scan tuning (aeExposureDivisor \(scanAeDivisor), isoCap \(scanIsoCap), mfnr/edge off)
    // ships in SDK 0.1.13's PhotoRequest. On 0.1.12 we capture at max detail:
    let photo = try await mentraBluetoothSdk.requestPhoto(
        PhotoRequest(
          requestId: requestId,
          appId: "com.mentra.bluetoothsdk.example.ios",
          size: .full,
          webhookUrl: uploadUrl,
          compress: .none,
          sound: false
        )
    )
    print("Scan photo delivered: \\(photo.requestId)")
    """
    }
    let exposureLine = exposureManual
        ? "      exposureTimeNs: \(exposureTimeNs),"
        : "      exposureTimeNs: nil, // auto exposure"
    let isoLine = exposureManual
        ? "      iso: \(iso)"
        : "      iso: nil // auto ISO"
    let prefix = """
    let cameraFovResult = try await mentraBluetoothSdk.setCameraFov(
        CameraFov(fov: \(cameraFov), roiPosition: CameraRoiPosition.from(rawValue: \(cameraRoiPosition)))
    )
    print("Camera FOV applied at \\(cameraFovResult.fov)°")
    """
    if mode == .video {
        return """
        \(prefix)
        let videoRequestId = "video-\\(Int(Date().timeIntervalSince1970 * 1000))"
        let started = try await mentraBluetoothSdk.startVideoRecording(
            VideoRecordingRequest(
              requestId: videoRequestId,
              save: true,
              sound: true,
              maxRecordingTimeMinutes: 1
            )
        )
        print("Video started: \\(started.status)")
        let stopped = try await mentraBluetoothSdk.stopVideoRecording(requestId: videoRequestId, webhookUrl: uploadUrl)
        print("Video stopped: \\(stopped.status)")
        """
    }
    return """
    \(prefix)
    let photo = try await mentraBluetoothSdk.requestPhoto(
        PhotoRequest(
          requestId: requestId,
          appId: "com.mentra.bluetoothsdk.example.ios",
          size: .\(size),
          webhookUrl: uploadUrl,
          compress: .\(compression),
          sound: true,
    \(exposureLine)
    \(isoLine)
        )
    )
    print("Photo delivered: \\(photo.requestId)")
    """
}

struct CameraScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @Environment(\.keyboardVisible) private var keyboardVisible
    @FocusState private var webhookUrlFocused: Bool
    @State private var captureMode: CameraCaptureMode = .photo
    @State private var photoDetailsExpanded = false
    @State private var videoDetailsExpanded = false
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

    private var videoActionBusy: Bool {
        model.activeAction == "Start video recording" || model.activeAction == "Stop & upload video"
    }

    private var videoControlsEnabled: Bool {
        model.glassesConnected && model.glassesWifiConnected && !videoActionBusy
    }

    private var setupHint: String? {
        guard captureMode == .video || !directPhone else { return nil }
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
                    OfflineNotice(message: "Connect the glasses to Wi-Fi from the System tab before capturing camera media. Cloud uploads use the glasses network connection.")
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }

                CameraModeSelector(activeMode: captureMode) { captureMode = $0 }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)

                if captureMode == .photo {
                    previewCard.padding(.horizontal, 16).padding(.top, 8)
                } else {
                    videoCard.padding(.horizontal, 16).padding(.top, 8)
                }

                sdkCard.padding(.horizontal, 16).padding(.top, 12)
                uploadCard.padding(.horizontal, 16).padding(.top, 12)
            }
            .padding(.bottom, LayoutMetric.scrollBottomPadding(keyboardVisible: keyboardVisible))
        }
        .background(AppColor.bg)
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: model.activeAction) { action in
            if action == "Capture & upload" {
                captureMode = .photo
            } else if action == "Start video recording" || action == "Stop & upload video" {
                captureMode = .video
            }
        }
        .onChange(of: model.videoRecording) { recording in
            if recording {
                captureMode = .video
            }
        }
    }

    private var previewCard: some View {
        GlassCard(padding: EdgeInsets(top: 8, leading: 8, bottom: 14, trailing: 8)) {
            HStack {
                Text("PHOTO")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundColor(AppColor.muted)
                Spacer()
                Text(photoStateLabel.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(AppColor.greenAccent)
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
            .padding(.bottom, 10)

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
                    Text(!model.glassesConnected ? "Connect glasses first" : !model.glassesWifiConnected ? "Connect glasses to Wi-Fi" : model.activeAction == "Capture & upload" ? "Capturing..." : model.scanMode ? "Capture scan photo" : "Capture photo").foregroundColor(.white).font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: [Color(hex: 0x26473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .disabled(!model.glassesConnected || !model.glassesWifiConnected)
            .opacity(model.glassesConnected && model.glassesWifiConnected ? 1 : 0.55)
            .padding(.horizontal, 6).padding(.top, 14)

            ScanModeSettingsCard(model: model)
            photoDetailsCard(embedded: true)
                .padding(.horizontal, 6)
                .padding(.top, 12)
        }
    }

    private var videoCard: some View {
        GlassCard(corner: 22, padding: EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)) {
            HStack {
                Text("VIDEO RECORDING")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundColor(AppColor.muted)
                Spacer()
                Text(videoStateLabel.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(AppColor.greenAccent)
            }
            .padding(.bottom, 12)

            ZStack(alignment: .bottomLeading) {
                LinearGradient(colors: [Color(hex: 0x101820), Color(hex: 0x21383B), Color(hex: 0x357064)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                if let videoPreviewUrl = model.videoPreviewUrl {
                    VideoPreviewPlayer(url: videoPreviewUrl)
                        .frame(height: 170)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                } else {
                    HStack {
                        HStack(spacing: 6) {
                            Circle().fill(AppColor.greenSoft).frame(width: 5, height: 5)
                            Text("MP4 · waiting")
                                .font(.system(size: 10, weight: .semibold)).foregroundColor(.white).tracking(0.5)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color.black.opacity(0.35))
                        .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1))
                        .clipShape(Capsule())
                        Spacer()
                        Text(model.videoRecording ? "recording" : "ready")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.85))
                    }
                    .padding(.horizontal, 14).padding(.bottom, 14)
                }
            }

            Button {
                model.toggleVideoRecording()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "video").foregroundColor(.white).font(.system(size: 15, weight: .bold))
                    Text(videoButtonLabel)
                        .foregroundColor(.white)
                        .font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: [Color(hex: 0x223F4D), Color(hex: 0x182C38)], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .disabled(!videoControlsEnabled)
            .opacity(videoControlsEnabled ? 1 : 0.55)
            .padding(.horizontal, 6).padding(.top, 14)

            videoDetailsPanel
                .padding(.top, 12)
        }
    }

    private var videoStateLabel: String {
        if model.videoRecording { return "recording" }
        if model.videoPreviewUrl != nil { return "preview ready" }
        return model.videoPreviewDetails?.state ?? "ready"
    }

    private var videoButtonLabel: String {
        if !model.glassesConnected { return "Connect glasses first" }
        if !model.glassesWifiConnected { return "Connect glasses to Wi-Fi" }
        if model.activeAction == "Start video recording" { return "Starting video..." }
        if model.activeAction == "Stop & upload video" { return "Uploading video..." }
        return model.videoRecording ? "Stop & upload video" : "Start video"
    }

    private var videoDetailsPanel: some View {
        let rows = videoDetailsRows(model.videoPreviewDetails)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                videoDetailsExpanded.toggle()
            } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("VIDEO DETAILS")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(1.2)
                            .foregroundColor(AppColor.muted)
                        Text(videoDetailsSummary(model.videoPreviewDetails))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(AppColor.ink)
                    }
                    Spacer()
                    Text(videoDetailsExpanded ? "Hide" : "Show")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppColor.greenAccent)
                }
            }
            .buttonStyle(.plain)

            if videoDetailsExpanded {
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
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(AppColor.ink.opacity(0.04))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppColor.ink.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var sdkCard: some View {
        let sdkCall = cameraSdkCall(
            mode: captureMode,
            size: model.photoSize.rawValue,
            compression: model.photoCompression.rawValue,
            exposureManual: model.photoExposureManual,
            exposureTimeNs: model.photoExposureTimeNs,
            iso: model.photoIso,
            cameraFov: model.cameraFov,
            cameraRoiPosition: model.cameraRoiPosition,
            scanMode: model.scanMode,
            scanAeDivisor: model.scanAeDivisor,
            scanIsoCap: model.scanIsoCap
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
                    Text(sdkStatusDetail).font(.system(size: 11, weight: .medium)).foregroundColor(AppColor.muted)
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
                if captureMode == .video || cloudServerEnabled {
                    Button {
                        model.testWebhook()
                    } label: {
                        Text("test webhook").font(.system(size: 11, weight: .medium)).foregroundColor(AppColor.greenAccent)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 12)

            if captureMode == .video {
                FixedMediaServerRow()
                    .padding(.bottom, 12)
                Text("Cloud server receives MP4 uploads.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(AppColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 12)
                HStack(spacing: 10) {
                    Text("POST").font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                    Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                    TextField("Media upload URL", text: $model.webhookUrl)
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
                Toggle(isOn: Binding(
                    get: { cloudServerEnabled },
                    set: { enabled in
                        model.setPhotoDestination(enabled ? .macBookServer : .thisPhone)
                    }
                )) {
                    Text("Use media cloud server")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.ink)
                }
                .toggleStyle(SwitchToggleStyle(tint: AppColor.greenAccent))
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.bottom, 12)

                if cloudServerEnabled {
                    Text("Cloud server receives photo uploads.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(AppColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 12)
                    HStack(spacing: 10) {
                        Text("POST").font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                        Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                        TextField("Media upload URL", text: $model.webhookUrl)
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
                if captureMode == .photo {
                    CameraOptionGroup(label: "photo size") {
                        ForEach(photoSizeOptions, id: \.rawValue) { size in
                            CameraOptionChip(
                                value: size.rawValue,
                                highlight: !model.scanMode && model.photoSize == size
                            )
                            .opacity(model.scanMode ? 0.45 : 1)
                            .onTapGesture {
                                guard !model.scanMode else { return }
                                model.setPhotoSize(size)
                        }
                    }

                    CameraOptionGroup(label: "photo compress") {
                        ForEach(photoCompressionOptions, id: \.rawValue) { compression in
                            CameraOptionChip(value: compression.rawValue, highlight: model.photoCompression == compression)
                                .onTapGesture { model.setPhotoCompression(compression) }
                        }
                    }

                    ExposureSettingsCard(model: model)
                }
                CameraFovSettingsCard(model: model)
            }
        }
    }

    private func photoDetailsCard(embedded: Bool = false) -> some View {
        let rows = photoDetailsRows(model.photoPreviewDetails)
        return Group {
            if embedded {
                photoDetailsContent(rows: rows)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                    .background(AppColor.ink.opacity(0.04))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppColor.ink.opacity(0.08), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            } else {
                GlassCard(corner: 18, padding: EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14)) {
                    photoDetailsContent(rows: rows)
                }
            }
        }
    }

    private func photoDetailsContent(rows: [PhotoDetailsRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
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

    private var photoStateLabel: String {
        if model.photoPreviewUrl != nil || model.photoPreviewImage != nil { return "preview ready" }
        if model.photoPreviewDetails?.state == "error" { return "error" }
        if model.photoPreviewDetails?.state == "acknowledged" { return "acknowledged" }
        return "ready"
    }

    private var sdkStatusDetail: String {
        if captureMode == .video {
            if model.videoRecording {
                return "Recording MP4 on glasses"
            }
            if model.activeAction == "Stop & upload video" {
                return "Uploading video to media server"
            }
            if model.videoPreviewUrl != nil {
                return "Video preview loaded from media server"
            }
            return "MP4 uploads to the media server after recording stops"
        }
        if model.photoPreviewUrl != nil || model.photoPreviewImage != nil {
            return directPhone ? "Photo preview loaded from phone receiver" : "Photo preview loaded from cloud server"
        }
        return "Waiting for camera capture"
    }
}

private struct ScanModeSettingsCard: View {
    @ObservedObject var model: BluetoothViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("SCAN MODE")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.1)
                        .foregroundColor(AppColor.muted)
                    Text(model.scanMode ? "Document / barcode capture preset" : "Standard photo capture")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(AppColor.greenAccent)
                }
                Spacer()
                Toggle("", isOn: Binding(get: { model.scanMode }, set: model.setScanMode))
                    .labelsHidden()
                    .toggleStyle(SwitchToggleStyle(tint: AppColor.greenAccent))
            }
            if model.scanMode {
                Text("Pushes size, MFNR, NR, edge, and ISP gain presets to glasses (HAL may warn not_implemented). AE÷\(model.scanAeDivisor) and ISO cap \(model.scanIsoCap) still ship on capture.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(AppColor.muted)
                HStack(spacing: 8) {
                    CameraOptionChip(value: "AE ÷3", highlight: model.scanAeDivisor == 3)
                        .onTapGesture { model.setScanAeDivisor(3) }
                    CameraOptionChip(value: "AE ÷5", highlight: model.scanAeDivisor == 5)
                        .onTapGesture { model.setScanAeDivisor(5) }
                }
                HStack(spacing: 8) {
                    CameraOptionChip(value: "ISO 800", highlight: model.scanIsoCap == 800)
                        .onTapGesture { model.setScanIsoCap(800) }
                    CameraOptionChip(value: "ISO 400", highlight: model.scanIsoCap == 400)
                        .onTapGesture { model.setScanIsoCap(400) }
                }
            }
        }
        .padding(14)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
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
            HStack(spacing: 10) {
                CameraSliderNudgeButton(label: "-", disabled: !model.photoExposureManual || model.photoExposureTimeNs <= photoExposureMinNs) {
                    model.setPhotoExposureTimeNs(model.photoExposureTimeNs - 500_000)
                }
                Slider(
                    value: Binding(
                        get: { Double(model.photoExposureTimeNs) },
                        set: { model.setPhotoExposureTimeNs(Int(($0 / 500_000).rounded()) * 500_000) }
                    ),
                    in: Double(photoExposureMinNs) ... Double(photoExposureMaxNs),
                    step: 500_000
                )
                .tint(AppColor.greenAccent)
                .disabled(!model.photoExposureManual)
                CameraSliderNudgeButton(label: "+", disabled: !model.photoExposureManual || model.photoExposureTimeNs >= photoExposureMaxNs) {
                    model.setPhotoExposureTimeNs(model.photoExposureTimeNs + 500_000)
                }
            }
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
            HStack(spacing: 10) {
                CameraSliderNudgeButton(label: "-", disabled: !model.photoExposureManual || model.photoIso <= photoIsoMin) {
                    model.setPhotoIso(model.photoIso - 50)
                }
                Slider(
                    value: Binding(
                        get: { Double(model.photoIso) },
                        set: { model.setPhotoIso(Int(($0 / 50).rounded()) * 50) }
                    ),
                    in: Double(photoIsoMin) ... Double(photoIsoMax),
                    step: 50
                )
                .tint(AppColor.greenAccent)
                .disabled(!model.photoExposureManual)
                CameraSliderNudgeButton(label: "+", disabled: !model.photoExposureManual || model.photoIso >= photoIsoMax) {
                    model.setPhotoIso(model.photoIso + 50)
                }
            }
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
        let controlsDisabled = model.cameraSettingsApplying
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
                Button(model.cameraSettingsApplying ? "Applying..." : "Apply") { model.applyCameraSettings() }
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(controlsDisabled ? AppColor.muted : AppColor.greenAccent)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(AppColor.greenAccent.opacity(0.16))
                    .overlay(Capsule().stroke(AppColor.greenAccent.opacity(0.28), lineWidth: 1))
                    .clipShape(Capsule())
                    .buttonStyle(.plain)
                    .disabled(controlsDisabled)
            }
            HStack(spacing: 10) {
                CameraSliderNudgeButton(label: "-", disabled: controlsDisabled || model.cameraFov <= cameraFovMin) {
                    model.setCameraFov(model.cameraFov - 1)
                }
                Slider(
                    value: Binding(
                        get: { Double(model.cameraFov) },
                        set: { model.setCameraFov(Int($0.rounded())) }
                    ),
                    in: Double(cameraFovMin) ... Double(cameraFovMax),
                    step: 1
                )
                .tint(AppColor.greenAccent)
                .disabled(controlsDisabled)
                CameraSliderNudgeButton(label: "+", disabled: controlsDisabled || model.cameraFov >= cameraFovMax) {
                    model.setCameraFov(model.cameraFov + 1)
                }
            }
            HStack {
                Text("\(cameraFovMin)°")
                Spacer()
                Button("Default \(cameraFovDefault)°") { model.setCameraFov(cameraFovDefault) }
                    .buttonStyle(.plain)
                    .foregroundColor(controlsDisabled ? AppColor.muted : AppColor.greenAccent)
                    .disabled(controlsDisabled)
                Spacer()
                Text("\(cameraFovMax)°")
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(AppColor.muted)

            CameraOptionGroup(label: "crop position") {
                ForEach(cameraRoiPositions, id: \.value) { option in
                    CameraOptionChip(value: option.label, highlight: model.cameraRoiPosition == option.value)
                        .opacity((roiDisabled || controlsDisabled) ? 0.45 : 1)
                        .onTapGesture {
                            if !roiDisabled && !controlsDisabled {
                                model.setCameraRoiPosition(option.value)
                            }
                        }
                }
            }
            Text(model.cameraSettingsStatus)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(AppColor.muted)
        }
        .padding(14)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct CameraSliderNudgeButton: View {
    let label: String
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 22, weight: .heavy))
                .foregroundColor(disabled ? AppColor.muted : AppColor.ink)
                .frame(width: 34, height: 34)
                .background(Color.white.opacity(0.78))
                .overlay(Capsule().stroke(AppColor.ink.opacity(0.08), lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

private struct CameraModeSelector: View {
    let activeMode: CameraCaptureMode
    let onChange: (CameraCaptureMode) -> Void

    var body: some View {
        HStack(spacing: 6) {
            CameraModeButton(title: "Photo", systemImage: "camera", active: activeMode == .photo) {
                onChange(.photo)
            }
            CameraModeButton(title: "Video", systemImage: "video", active: activeMode == .video) {
                onChange(.video)
            }
        }
        .padding(4)
        .background(AppColor.ink.opacity(0.05))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppColor.ink.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

private struct CameraModeButton: View {
    let title: String
    let systemImage: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .bold))
                Text(title)
                    .font(.system(size: 13, weight: .bold))
            }
            .foregroundColor(active ? AppColor.ink : AppColor.muted)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 42)
            .background(active ? Color.white : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(active ? AppColor.ink.opacity(0.08) : Color.clear, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

private struct VideoPreviewPlayer: View {
    let url: URL

    @State private var player = AVPlayer()
    @State private var position = 0.0
    @State private var duration = 0.0
    @State private var isPlaying = true
    @State private var isSeeking = false
    @State private var timeObserver: Any?

    var body: some View {
        ZStack(alignment: .bottom) {
            AVPlayerSurface(player: player)
            HStack(spacing: 8) {
                Button {
                    togglePlayback()
                } label: {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.18))
                        .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)

                Text(formatPlaybackSeconds(position))
                    .font(.system(size: 10, weight: .bold))
                    .monospacedDigit()
                    .foregroundColor(.white)
                    .frame(width: 38)

                Slider(
                    value: Binding(
                        get: { min(position, max(duration, 1)) },
                        set: { position = $0 }
                    ),
                    in: 0...max(duration, 1),
                    onEditingChanged: { editing in
                        isSeeking = editing
                        if !editing {
                            seek(to: position)
                        }
                    }
                )
                .tint(AppColor.greenSoft)
                .disabled(duration <= 0)

                Text(duration > 0 ? formatPlaybackSeconds(duration) : "--:--")
                    .font(.system(size: 10, weight: .bold))
                    .monospacedDigit()
                    .foregroundColor(.white)
                    .frame(width: 38)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(Color(hex: 0x061014).opacity(0.72))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
        .background(Color(hex: 0x101820))
        .onAppear(perform: configurePlayer)
        .onChange(of: url) { _ in configurePlayer() }
        .onDisappear(perform: teardown)
    }

    private func configurePlayer() {
        removeTimeObserver()
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        player.isMuted = true
        player.actionAtItemEnd = .pause
        position = 0
        duration = 0
        isPlaying = true
        player.play()
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { time in
            if !isSeeking {
                position = sanitizedPlaybackSeconds(time.seconds)
            }
            let itemDuration = player.currentItem?.duration.seconds ?? 0
            if itemDuration.isFinite && itemDuration > 0 {
                duration = itemDuration
            }
            isPlaying = player.timeControlStatus == .playing
        }
    }

    private func togglePlayback() {
        if player.timeControlStatus == .playing {
            player.pause()
            isPlaying = false
            return
        }
        if duration > 0 && position >= duration - 0.2 {
            seek(to: 0)
        }
        player.play()
        isPlaying = true
    }

    private func seek(to seconds: Double) {
        let upperBound = duration > 0 ? duration : seconds
        let nextPosition = min(max(seconds, 0), upperBound)
        position = nextPosition
        player.seek(to: CMTime(seconds: nextPosition, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func teardown() {
        player.pause()
        removeTimeObserver()
    }

    private func removeTimeObserver() {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
    }
}

private struct AVPlayerSurface: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.showsPlaybackControls = false
        controller.videoGravity = .resizeAspectFill
        controller.player = player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player {
            controller.player = player
        }
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

private func videoDetailsSummary(_ details: VideoPreviewDetails?) -> String {
    guard let details else { return "Waiting for first video preview" }
    if details.state == "error" {
        return "Error · \(details.error ?? "Video failed")"
    }
    return [
        details.source,
        details.byteCount.map(formatBytes),
        details.durationMs.map(formatDurationMs),
        details.state == "preview" ? "preview ready" : details.state,
    ].compactMap { $0 }.joined(separator: " · ")
}

private func videoDetailsRows(_ details: VideoPreviewDetails?) -> [PhotoDetailsRow] {
    guard let details else {
        return [PhotoDetailsRow(label: "Status", value: "No video metadata received yet")]
    }
    var rows = [
        PhotoDetailsRow(label: "Source", value: details.source),
        PhotoDetailsRow(label: "State", value: details.state),
    ]
    if let requestId = details.requestId { rows.append(PhotoDetailsRow(label: "Request ID", value: requestId)) }
    if let status = details.status { rows.append(PhotoDetailsRow(label: "SDK status", value: status)) }
    if let durationMs = details.durationMs { rows.append(PhotoDetailsRow(label: "Duration", value: formatDurationMs(durationMs))) }
    if let byteCount = details.byteCount { rows.append(PhotoDetailsRow(label: "Size", value: formatBytes(byteCount))) }
    if let contentType = details.contentType { rows.append(PhotoDetailsRow(label: "Content type", value: contentType)) }
    if let uploadUrl = details.uploadUrl { rows.append(PhotoDetailsRow(label: "Upload URL", value: uploadUrl)) }
    if let mediaUrl = details.mediaUrl { rows.append(PhotoDetailsRow(label: "Media URL", value: mediaUrl)) }
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

private func formatDurationMs(_ durationMs: Int) -> String {
    if durationMs >= 1000 {
        return String(format: "%.1f s", Double(durationMs) / 1000)
    }
    return "\(durationMs) ms"
}

private func sanitizedPlaybackSeconds(_ seconds: Double) -> Double {
    seconds.isFinite && seconds > 0 ? seconds : 0
}

private func formatPlaybackSeconds(_ seconds: Double) -> String {
    let totalSeconds = max(0, Int(seconds.rounded(.down)))
    let minutes = totalSeconds / 60
    let remainder = totalSeconds % 60
    return String(format: "%d:%02d", minutes, remainder)
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
    return "Cloud server setup: run python3 examples/local-demo-cloud/server.py from the Starter Kit repo root, then paste the printed Media upload URL here. It looks like http://<computer-ip>:8787/upload."
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

private struct FixedMediaServerRow: View {
    var body: some View {
        HStack {
            Text("Media cloud server")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(AppColor.ink)
            Spacer()
            Text("MP4")
                .font(.system(size: 11, weight: .heavy))
                .foregroundColor(AppColor.greenAccent)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(AppColor.greenAccent.opacity(0.14))
                .clipShape(Capsule())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppColor.ink.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
