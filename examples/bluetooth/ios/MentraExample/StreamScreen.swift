import SwiftUI
import UIKit
import WebKit

private let streamSdkCall = """
let streamId = "ios-..."
mentraBluetoothSdk.startStream(
  MentraStreamRequest(
    streamUrl: streamUrl,
    streamId: streamId,
    keepAlive: true,
    keepAliveIntervalSeconds: 15
  )
)
"""

struct StreamScreen: View {
    @ObservedObject var model: BluetoothViewModel
    @Environment(\.keyboardVisible) private var keyboardVisible
    @FocusState private var streamUrlFocused: Bool
    private let bars: [CGFloat] = [18, 32, 48, 24, 40, 56, 30, 44, 22, 36, 50, 28, 40]
    private let streamUrlFieldId = "stream-url-field"
    private var cloudServerEnabled: Bool {
        model.streamCloudServerEnabled
    }

    private var setupHint: String? {
        guard cloudServerEnabled else { return nil }
        return localStreamSetupHint(protocol: model.streamProtocol, streamUrl: model.streamUrl, status: model.streamStatus)
    }

    private var streamActive: Bool {
        model.streamRequested || model.streamStartedAt != nil
    }

    private var directPhoneWebRtc: Bool {
        !cloudServerEnabled
    }

    private var livePreviewUrl: URL? {
        guard cloudServerEnabled else { return nil }
        guard streamActive, model.streamPreviewReady else { return nil }
        switch model.streamProtocol {
        case .rtmp:
            return rtmpHlsPreviewUrl(model.streamUrl)
        case .webrtc:
            return webrtcPreviewUrl(model.streamUrl)
        case .srt:
            return srtHlsPreviewUrl(model.streamUrl)
        }
    }

    var body: some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                VStack(spacing: 0) {
                    PageHeader(title: "Stream", connected: model.glassesConnected)
                    if !model.glassesConnected {
                        OfflineNotice()
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                    }

                    previewCard(scrollProxy: scrollProxy).padding(.horizontal, 16).padding(.top, 8)
                    sdkCard.padding(.horizontal, 16).padding(.top, 12)
                    protocolCard.padding(.horizontal, 16).padding(.top, 12)
                }
                .padding(.bottom, LayoutMetric.scrollBottomPadding(keyboardVisible: keyboardVisible))
            }
            .background(AppColor.bg)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func previewCard(scrollProxy: ScrollViewProxy) -> some View {
        GlassCard(padding: EdgeInsets(top: 8, leading: 8, bottom: 14, trailing: 8)) {
            previewSurface

            Button {
                if cloudServerEnabled, shouldFocusStreamUrlTemplate(model.streamUrl, streamActive: streamActive) {
                    focusStreamUrlField(scrollProxy)
                }
                model.toggleStream()
            } label: {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.white).frame(width: 12, height: 12)
                    Text(!model.glassesConnected && !streamActive ? "Connect glasses first" : streamActive ? "End stream" : "Start stream").foregroundColor(.white).font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).padding(.vertical, 16)
                .background(LinearGradient(colors: streamActive ? [Color(hex: 0xDE3A30), Color(hex: 0xC43B30)] : [Color(hex: 0x26473A), Color(hex: 0x1F3A2A)], startPoint: .top, endPoint: .bottom))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .disabled(!model.glassesConnected && !streamActive)
            .opacity(!model.glassesConnected && !streamActive ? 0.55 : 1)
            .padding(.horizontal, 6).padding(.top, 14)
        }
    }

    @ViewBuilder
    private var previewSurface: some View {
        if directPhoneWebRtc, streamActive {
            ZStack {
                DirectPhoneWebRtcPreviewView(receiver: model.directWhipReceiver)
                    .frame(height: 160)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                previewChrome(
                    label: model.streamPreviewReady ? "LIVE" : "STARTING",
                    detail: model.streamPreviewReady ? "WebRTC · phone receiver · keep-alive 15s" : "Waiting for first frame"
                )
            }
        } else if let livePreviewUrl {
            ZStack {
                if model.streamProtocol == .rtmp || model.streamProtocol == .srt {
                    RetryingHlsWebPreviewView(url: livePreviewUrl)
                        .frame(height: 160)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 22))
                } else {
                    WebStreamPreviewView(url: livePreviewUrl)
                        .frame(height: 160)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 22))
                }
                previewChrome(label: "LIVE", detail: previewDetail)
            }
        } else {
            ZStack {
                LinearGradient(colors: [Color(hex: 0x163A26), Color(hex: 0x26583E), Color(hex: 0x7DD89E), Color(hex: 0x3F8F5C)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(height: 160).clipShape(RoundedRectangle(cornerRadius: 22))
                Circle().fill(Color.white.opacity(0.2)).frame(width: 220, height: 220).blur(radius: 10).offset(x: -90, y: -100)
                Circle().fill(AppColor.greenSoft.opacity(0.3)).frame(width: 240, height: 240).blur(radius: 10).offset(x: 100, y: 110)

                VStack {
                    previewChrome(label: streamActive ? "STARTING" : "READY", detail: streamActive ? "Waiting for preview" : cloudServerEnabled ? "Ready · enter stream URL" : "Ready · phone receiver starts on stream")

                    Spacer()

                    if streamActive {
                        Text("Starting stream...\nWaiting for preview")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 42)
                    } else {
                        HStack(alignment: .bottom, spacing: 5) {
                            ForEach(0 ..< bars.count, id: \.self) { i in
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(i % 3 == 2 ? Color.white : Color.white.opacity(0.85))
                                    .frame(width: 5, height: bars[i])
                            }
                        }
                        .padding(.bottom, 56)
                    }
                }
                .frame(height: 160)
            }
        }
    }

    private var previewDetail: String {
        if directPhoneWebRtc {
            return "WebRTC · phone receiver · keep-alive 15s"
        }
        if model.streamProtocol == .srt {
            return "SRT · web preview · keep-alive 15s"
        }
        return "\(model.streamProtocol.rawValue.uppercased()) · keep-alive 15s"
    }

    private func previewChrome(label: String, detail: String) -> some View {
        VStack {
            HStack {
                HStack(spacing: 6) {
                    Circle().fill(label == "READY" ? AppColor.greenSoft : AppColor.redLive).frame(width: 7, height: 7)
                    Text(label).font(.system(size: 11, weight: .bold)).tracking(0.8).foregroundColor(.white)
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
            HStack {
                Text(detail)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.85))
                Spacer()
            }
            .padding(.horizontal, 14).padding(.bottom, 14)
        }
        .frame(height: 160)
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
            }
            .padding(.vertical, 12).padding(.horizontal, 16)
            .background(LinearGradient(colors: [Color.white.opacity(0.7), Color.white.opacity(0.5)], startPoint: .top, endPoint: .bottom))
        }
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.7), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var protocolCard: some View {
        GlassCard(corner: 22, padding: EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)) {
            Toggle(isOn: Binding(
                get: { cloudServerEnabled },
                set: { enabled in
                    model.setStreamCloudServerEnabled(enabled)
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

            if cloudServerEnabled {
                HStack(spacing: 4) {
                    ProtocolTab(title: "RTMP", active: model.streamProtocol == .rtmp) { model.selectStreamProtocol(.rtmp) }
                    ProtocolTab(title: "SRT", active: model.streamProtocol == .srt) { model.selectStreamProtocol(.srt) }
                    ProtocolTab(title: "WebRTC", active: model.streamProtocol == .webrtc) { model.selectStreamProtocol(.webrtc) }
                }
                .padding(4)
                .background(AppColor.ink.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.top, 12)
                .padding(.bottom, 12)

                HStack(spacing: 10) {
                    Text(model.streamProtocol.inputLabel).font(.system(size: 11, weight: .semibold)).tracking(0.5).foregroundColor(AppColor.greenAccent)
                    Rectangle().fill(AppColor.ink.opacity(0.12)).frame(width: 1, height: 14)
                    TextField(
                        model.streamProtocol.defaultUrl,
                        text: Binding(
                            get: { model.streamUrl },
                            set: { nextUrl in
                                model.setStreamUrl(nextUrl)
                            }
                        )
                    )
                        .focused($streamUrlFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { streamUrlFocused = false }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.ink)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "square.and.pencil").font(.system(size: 14)).foregroundColor(AppColor.muted)
                }
                .id(streamUrlFieldId)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                HStack(spacing: 10) {
                    Circle()
                        .fill(model.directStreamReceiverRunning ? AppColor.greenAccent : AppColor.muted.opacity(0.5))
                        .frame(width: 8, height: 8)
                    Text(model.directStreamReceiverRunning ? "Phone receiver ready" : "Phone receiver starts on stream")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(AppColor.ink)
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(AppColor.ink.opacity(0.04)).clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.top, 12)
            }

            if cloudServerEnabled, let setupHint {
                Text(setupHint)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(AppColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(AppColor.ink.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.top, 12)
            }
        }
    }

    private func focusStreamUrlField(_ scrollProxy: ScrollViewProxy) {
        withAnimation(.easeInOut(duration: 0.2)) {
            scrollProxy.scrollTo(streamUrlFieldId, anchor: .bottom)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            streamUrlFocused = true
            withAnimation(.easeInOut(duration: 0.2)) {
                scrollProxy.scrollTo(streamUrlFieldId, anchor: .bottom)
            }
        }
    }
}

private func shouldFocusStreamUrlTemplate(_ streamUrl: String, streamActive: Bool) -> Bool {
    !streamActive && streamUrl.contains("<computer-ip>")
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

struct RetryingHlsWebPreviewView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        loadPreview(in: webView, context: context)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        loadPreview(in: webView, context: context)
    }

    private func loadPreview(in webView: WKWebView, context: Context) {
        guard context.coordinator.loadedUrl != url else { return }
        context.coordinator.loadedUrl = url
        webView.loadHTMLString(retryingHlsHtml(url: url), baseURL: url.deletingLastPathComponent())
    }

    final class Coordinator {
        var loadedUrl: URL?
    }
}

struct WebStreamPreviewView: UIViewRepresentable {
    let url: URL

    func makeUIView(context _: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context _: Context) {
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }
}

struct DirectPhoneWebRtcPreviewView: UIViewRepresentable {
    let receiver: GStreamerWhipReceiver

    func makeUIView(context _: Context) -> UIView {
        receiver.videoView
    }

    func updateUIView(_ uiView: UIView, context _: Context) {
    }
}

private func retryingHlsHtml(url: URL) -> String {
    let playlistLiteral = javascriptStringLiteral(url.absoluteString)
    return """
    <!doctype html>
    <html>
    <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
    html,body,#video{margin:0;width:100%;height:100%;background:#000;overflow:hidden}
    #video{object-fit:cover}
    #message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:white;font:600 13px -apple-system;padding:16px;text-shadow:0 1px 6px #000}
    </style>
    </head>
    <body>
    <video id="video" autoplay muted playsinline controls></video>
    <div id="message">Waiting for stream...</div>
    <script>
    const playlist = \(playlistLiteral);
    const video = document.getElementById('video');
    const message = document.getElementById('message');
    let retryTimer = null;

    function withCacheBust(url) {
      return url + (url.includes('?') ? '&' : '?') + 'preview=' + Date.now();
    }

    function scheduleRetry(reason) {
      if (retryTimer) return;
      message.textContent = reason || 'Waiting for stream...';
      retryTimer = setTimeout(() => {
        retryTimer = null;
        start();
      }, 2000);
    }

    function start() {
      fetch(withCacheBust(playlist), { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('Stream not ready');
          message.textContent = '';
          video.src = withCacheBust(playlist);
          video.load();
          return video.play();
        })
        .catch(() => scheduleRetry('Waiting for stream...'));
    }

    video.addEventListener('error', () => scheduleRetry('Preview reconnecting...'));
    video.addEventListener('stalled', () => scheduleRetry('Preview reconnecting...'));
    window.addEventListener('load', start);
    </script>
    </body>
    </html>
    """
}

private func javascriptStringLiteral(_ value: String) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let literal = String(data: data, encoding: .utf8)
    else {
        return "\"\""
    }
    return literal
}

private func localStreamSetupHint(protocol streamProtocol: ExampleStreamProtocol, streamUrl: String, status: String) -> String? {
    guard streamProtocol == .rtmp || streamProtocol == .srt || streamProtocol == .webrtc else {
        return nil
    }
    let normalized = status.lowercased()
    let url = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    let needsSetup = url.isEmpty ||
        url.contains("<computer-ip>") ||
        url.contains("YOUR_") ||
        normalized.contains("not reachable") ||
        normalized.contains("replace") ||
        normalized.contains("required")
    if !needsSetup {
        return nil
    }
    if streamProtocol == .rtmp {
        return "Local RTMP setup: run python3 examples/local-demo-cloud/server.py, paste the printed RTMP publish URL here, then start streaming. The app previews the HLS URL; the printed ffplay command is optional for debugging."
    }
    if streamProtocol == .srt {
        return "Local SRT setup: run python3 examples/local-demo-cloud/server.py, paste the printed SRT publish URL here, then start streaming. The app previews the HLS URL; the printed SRT ffplay command is optional for debugging."
    }
    return "Local WebRTC setup: run python3 examples/local-demo-cloud/server.py, paste the printed WHIP publish URL here, then start streaming. The app previews the MediaMTX WebRTC page."
}
