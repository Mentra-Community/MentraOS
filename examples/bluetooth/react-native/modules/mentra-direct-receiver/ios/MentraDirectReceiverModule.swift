import Darwin
import ExpoModulesCore
import Foundation

public class MentraDirectReceiverModule: Module {
  private var photoUploadServer: LocalPhotoUploadServer?
  private var whipReceiver: GStreamerWhipReceiver?
  private var whipProxy: WhipHeaderProxy?
  private var firstFrameSeen = false

  public func definition() -> ModuleDefinition {
    Name("MentraDirectReceiver")

    Events("photoUpload", "receiverStatus", "streamFirstFrame")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startPhotoReceiver") { () -> [String: Any] in
      try startPhotoReceiver()
    }

    AsyncFunction("stopPhotoReceiver") {
      stopPhotoReceiverInternal()
    }

    AsyncFunction("startWebRtcReceiver") { () -> [String: Any] in
      try startWebRtcReceiver()
    }

    AsyncFunction("stopWebRtcReceiver") {
      stopWebRtcReceiverInternal()
    }

    OnDestroy {
      stopPhotoReceiverInternal()
      stopWebRtcReceiverInternal()
    }

    View(MentraDirectReceiverView.self) {
    }
  }

  private func startPhotoReceiver() throws -> [String: Any] {
    guard let host = bestLocalIPv4Address() else {
      throw DirectReceiverError("No Wi-Fi/LAN IPv4 address found for this phone.")
    }

    let server = photoUploadServer ?? LocalPhotoUploadServer(
      onLog: { [weak self] message in
        self?.emitStatus(kind: "photo", message: message)
      },
      onUpload: { [weak self] upload in
        self?.handlePhotoUpload(upload)
      }
    )
    photoUploadServer = server

    var lastError: Error?
    for port in photoPorts {
      do {
        let actualPort = try server.start(port: UInt16(port))
        let uploadUrl = "http://\(host):\(actualPort)/upload"
        emitStatus(kind: "photo", message: "Photo receiver ready at \(uploadUrl)")
        return [
          "uploadUrl": uploadUrl,
          "host": host,
          "port": actualPort,
        ]
      } catch {
        lastError = error
        emitStatus(kind: "photo", message: "Port \(port) unavailable: \(error.localizedDescription)")
      }
    }

    throw DirectReceiverError(
      "Could not start phone photo receiver: \(lastError?.localizedDescription ?? "all ports unavailable")"
    )
  }

  private func stopPhotoReceiverInternal() {
    photoUploadServer?.stop()
    emitStatus(kind: "photo", message: "Photo receiver stopped")
  }

  private func handlePhotoUpload(_ upload: PhotoUpload) {
    sendEvent("photoUpload", [
      "requestId": upload.requestId as Any,
      "fileUri": upload.photoFile.absoluteString,
      "byteCount": upload.byteCount,
    ])
    emitStatus(kind: "photo", message: "Photo uploaded (\(upload.byteCount) bytes)")
  }

  private func startWebRtcReceiver() throws -> [String: Any] {
    guard let host = bestLocalIPv4Address() else {
      throw DirectReceiverError("No Wi-Fi/LAN IPv4 address found for this phone.")
    }

    stopWebRtcReceiverInternal()

    var lastError: Error?
    for ports in streamPortPairs {
      do {
        let receiver = GStreamerWhipReceiver()
        receiver.onStateChanged = { [weak self] message in
          self?.handleReceiverStatus(message)
        }

        try receiver.start(withAdvertisedHost: "127.0.0.1", port: ports.backendPort)

        let proxy = WhipHeaderProxy()
        try proxy.start(listenPort: UInt16(ports.publicPort), backendPort: UInt16(ports.backendPort))

        let streamUrl = "http://\(host):\(ports.publicPort)/whip/endpoint"
        whipReceiver = receiver
        whipProxy = proxy
        firstFrameSeen = false
        DirectReceiverViewRegistry.shared.setVideoView(receiver.videoView)
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

    throw DirectReceiverError(
      "Could not start phone WebRTC receiver: \(lastError?.localizedDescription ?? "all ports unavailable")"
    )
  }

  private func stopWebRtcReceiverInternal() {
    whipProxy?.stop()
    whipProxy = nil
    whipReceiver?.stop()
    whipReceiver = nil
    firstFrameSeen = false
    DirectReceiverViewRegistry.shared.clear()
    emitStatus(kind: "stream", message: "WebRTC phone receiver stopped")
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

  private let photoPorts = [8787, 8788, 8789, 8790]
}

final class DirectReceiverError: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}
