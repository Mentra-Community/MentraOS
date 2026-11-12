import Darwin
import ExpoModulesCore
import Foundation

public class MentraVideoStreamReceiverModule: Module {
  private var whipReceiver: GStreamerWhipReceiver?
  private var whipProxy: WhipHeaderProxy?
  private var firstFrameSeen = false
  private var lastFrameEventAtMs = 0

  public func definition() -> ModuleDefinition {
    Name("MentraVideoStreamReceiver")

    Events("receiverStatus", "streamFirstFrame", "streamFrame")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startWebRtcReceiver") { () -> [String: Any] in
      try startWebRtcReceiver()
    }

    AsyncFunction("stopWebRtcReceiver") {
      stopWebRtcReceiverInternal()
    }

    OnDestroy {
      stopWebRtcReceiverInternal()
    }

    View(MentraVideoStreamReceiverView.self) {
    }
  }

  private func startWebRtcReceiver() throws -> [String: Any] {
    guard let host = bestLocalIPv4Address() else {
      throw VideoStreamReceiverError("No Wi-Fi/LAN IPv4 address found for this phone.")
    }

    stopWebRtcReceiverInternal()

    var lastError: Error?
    for ports in streamPortPairs {
      do {
        let receiver = GStreamerWhipReceiver()
        receiver.onStateChanged = { [weak self] message in
          self?.handleReceiverStatus(message)
        }
        receiver.onFrameRendered = { [weak self] in
          self?.handleFrameRendered()
        }

        try receiver.start(withAdvertisedHost: "127.0.0.1", port: ports.backendPort)

        let proxy = WhipHeaderProxy()
        try proxy.start(listenPort: UInt16(ports.publicPort), backendPort: UInt16(ports.backendPort))

        let streamUrl = "http://\(host):\(ports.publicPort)/whip/endpoint"
        whipReceiver = receiver
        whipProxy = proxy
        firstFrameSeen = false
        VideoStreamReceiverViewRegistry.shared.setVideoView(receiver.videoView)
        emitStatus(kind: "stream", message: "WebRTC phone receiver ready at \(streamUrl)")

        return [
          "streamUrl": streamUrl,
          "host": host,
          "publicPort": ports.publicPort,
          "backendPort": ports.backendPort,
        ]
      } catch {
        lastError = error
        stopWebRtcReceiverInternal()
        emitStatus(
          kind: "stream",
          message: "Ports \(ports.publicPort)/\(ports.backendPort) unavailable: \(error.localizedDescription)"
        )
      }
    }

    throw VideoStreamReceiverError(
      "Could not start phone WebRTC receiver: \(lastError?.localizedDescription ?? "all ports unavailable")"
    )
  }

  private func stopWebRtcReceiverInternal() {
    whipProxy?.stop()
    whipProxy = nil
    whipReceiver?.stop()
    whipReceiver = nil
    firstFrameSeen = false
    lastFrameEventAtMs = 0
    VideoStreamReceiverViewRegistry.shared.clear()
    emitStatus(kind: "stream", message: "WebRTC phone receiver stopped")
  }

  private func handleFrameRendered() {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    if now - lastFrameEventAtMs >= 1000 {
      lastFrameEventAtMs = now
      sendEvent("streamFrame", [
        "timestamp": now,
      ])
    }
  }

  private func handleReceiverStatus(_ message: String) {
    emitStatus(kind: "stream", message: message)
    guard message.hasPrefix("Rendered ") else {
      return
    }

    if !firstFrameSeen {
      firstFrameSeen = true
      sendEvent("streamFirstFrame", [
        "timestamp": Int(Date().timeIntervalSince1970 * 1000),
      ])
    }
  }

  private func emitStatus(kind: String, message: String) {
    sendEvent("receiverStatus", [
      "kind": kind,
      "message": message,
    ])
  }

  private func bestLocalIPv4Address() -> String? {
    var interfaces: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&interfaces) == 0, let first = interfaces else {
      return nil
    }
    defer { freeifaddrs(interfaces) }

    var fallback: String?
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let current = cursor {
      defer { cursor = current.pointee.ifa_next }
      let interface = current.pointee
      guard let addressPointer = interface.ifa_addr,
            addressPointer.pointee.sa_family == UInt8(AF_INET) else {
        continue
      }

      let name = String(cString: interface.ifa_name)
      var address = addressPointer.pointee
      var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(
        &address,
        socklen_t(address.sa_len),
        &hostname,
        socklen_t(hostname.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      guard result == 0 else {
        continue
      }

      let ip = String(cString: hostname)
      guard ip != "127.0.0.1" else {
        continue
      }
      if name == "en0" {
        return ip
      }
      fallback = fallback ?? ip
    }

    return fallback
  }

  private let streamPortPairs = [
    (publicPort: 8190, backendPort: 8191),
    (publicPort: 8192, backendPort: 8193),
    (publicPort: 8194, backendPort: 8195),
  ]

}

final class VideoStreamReceiverError: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}
