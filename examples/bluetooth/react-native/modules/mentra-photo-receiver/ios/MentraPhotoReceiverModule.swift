import Darwin
import ExpoModulesCore
import Foundation

public class MentraPhotoReceiverModule: Module {
  private var photoUploadServer: LocalPhotoUploadServer?

  public func definition() -> ModuleDefinition {
    Name("MentraPhotoReceiver")

    Events("photoUpload", "receiverStatus")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startPhotoReceiver") { () -> [String: Any] in
      try startPhotoReceiver()
    }

    AsyncFunction("stopPhotoReceiver") {
      stopPhotoReceiverInternal()
    }

    OnDestroy {
      stopPhotoReceiverInternal()
    }
  }

  private func startPhotoReceiver() throws -> [String: Any] {
    guard let host = bestLocalIPv4Address() else {
      throw PhotoReceiverError("No Wi-Fi/LAN IPv4 address found for this phone.")
    }

    let server = photoUploadServer ?? LocalPhotoUploadServer(
      onLog: { [weak self] message in
        self?.emitStatus(message: message)
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
        emitStatus(message: "Photo receiver ready at \(uploadUrl)")
        return [
          "uploadUrl": uploadUrl,
          "host": host,
          "port": actualPort,
        ]
      } catch {
        lastError = error
        emitStatus(message: "Port \(port) unavailable: \(error.localizedDescription)")
      }
    }

    throw PhotoReceiverError(
      "Could not start phone photo receiver: \(lastError?.localizedDescription ?? "all ports unavailable")"
    )
  }

  private func stopPhotoReceiverInternal() {
    photoUploadServer?.stop()
    emitStatus(message: "Photo receiver stopped")
  }

  private func handlePhotoUpload(_ upload: PhotoUpload) {
    sendEvent("photoUpload", [
      "requestId": upload.requestId as Any,
      "fileUri": upload.photoFile.absoluteString,
      "byteCount": upload.byteCount,
    ])
    emitStatus(message: "Photo uploaded (\(upload.byteCount) bytes)")
  }

  private func emitStatus(message: String) {
    sendEvent("receiverStatus", [
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

  private let photoPorts = [8787, 8788, 8789, 8790]
}

final class PhotoReceiverError: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}
