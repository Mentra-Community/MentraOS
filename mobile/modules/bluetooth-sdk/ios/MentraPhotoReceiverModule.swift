import Darwin
import ExpoModulesCore
import Foundation

public class MentraPhotoReceiverModule: Module {
  private let receiverLock = NSLock()
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
    receiverLock.lock()
    defer { receiverLock.unlock() }

    guard let host = LocalIPv4.bestLocalIPv4Address() else {
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

    if let activePort = server.activePort {
      let uploadUrl = "http://\(host):\(activePort)/upload"
      emitStatus(message: "Photo receiver ready at \(uploadUrl)")
      return receiverResult(uploadUrl: uploadUrl, host: host, port: activePort)
    }

    var lastError: Error?
    for port in photoPorts {
      do {
        let actualPort = try server.start(port: UInt16(port))
        let uploadUrl = "http://\(host):\(actualPort)/upload"
        emitStatus(message: "Photo receiver ready at \(uploadUrl)")
        return receiverResult(uploadUrl: uploadUrl, host: host, port: actualPort)
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
    receiverLock.lock()
    defer { receiverLock.unlock() }

    photoUploadServer?.stop()
    emitStatus(message: "Photo receiver stopped")
  }

  private func handlePhotoUpload(_ upload: PhotoUpload) {
    BleTraceLogger.logMap(
      direction: "phone_to_app",
      layer: "photo_receiver_event",
      type: "photo_upload",
      payload: [
        "requestId": upload.requestId ?? "",
        "fileName": upload.photoFile.lastPathComponent,
        "byteCount": upload.byteCount,
      ]
    )
    sendEvent("photoUpload", [
      "requestId": upload.requestId as Any,
      "fileUri": upload.photoFile.absoluteString,
      "byteCount": upload.byteCount,
    ])
    emitStatus(message: "Photo uploaded (\(upload.byteCount) bytes)")
  }

  private func emitStatus(message: String) {
    NSLog("[MentraPhotoReceiver] %@", message)
    sendEvent("receiverStatus", [
      "message": message,
    ])
  }

  private func receiverResult(uploadUrl: String, host: String, port: UInt16) -> [String: Any] {
    [
      "uploadUrl": uploadUrl,
      "host": host,
      "port": port,
    ]
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
