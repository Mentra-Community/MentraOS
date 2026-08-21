import ExpoModulesCore
import Foundation

/// Expo surface for the hotspot-served OTA file server (OS-1676).
///
/// JS hands over the rewritten manifest body and a map of sha256 -> local file path, and gets
/// back the base URL the glasses should be pointed at via ota_start. The optional host
/// argument lets the caller pass an authoritative address; otherwise interface scanning is
/// used (under a glasses-hotspot session en0 holds the hotspot client address).
public class MentraOtaServerModule: Module {
  private let serverLock = NSLock()
  private var otaServer: LocalOtaServer?
  private var healthTimer: DispatchSourceTimer?
  private lazy var artifactDownloader = BackgroundOtaArtifactDownloader { [weak self] destination, written, total in
    self?.sendEvent("artifactDownloadProgress", [
      "destination": destination,
      "bytesWritten": written,
      "contentLength": total,
    ])
  }

  public func definition() -> ModuleDefinition {
    Name("MentraOtaServer")

    Events("serverStatus", "artifactDownloadProgress")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startOtaServer") { (manifestJson: String, artifactPaths: [String: String], host: String?) -> [String: Any] in
      try self.startOtaServer(manifestJson: manifestJson, artifactPaths: artifactPaths, hostOverride: host)
    }

    AsyncFunction("stopOtaServer") {
      self.stopOtaServerInternal()
    }

    AsyncFunction("startHealthKeepalive") { (url: String, intervalMs: Int) in
      try self.startHealthKeepalive(url: url, intervalMs: intervalMs)
    }

    AsyncFunction("stopHealthKeepalive") {
      self.stopHealthKeepaliveInternal()
    }

    AsyncFunction("downloadArtifact") { (source: String, destination: String) in
      try await self.artifactDownloader.download(from: source, to: destination)
    }

    OnDestroy {
      self.stopHealthKeepaliveInternal()
      self.stopOtaServerInternal()
    }
  }

  private func startOtaServer(
    manifestJson: String,
    artifactPaths: [String: String],
    hostOverride: String?
  ) throws -> [String: Any] {
    serverLock.lock()
    defer { serverLock.unlock() }

    var artifacts: [String: URL] = [:]
    for (key, path) in artifactPaths {
      let url = path.hasPrefix("file://")
        ? (URL(string: path) ?? URL(fileURLWithPath: String(path.dropFirst("file://".count))))
        : URL(fileURLWithPath: path)
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw OtaServerModuleError("Artifact \(key) not found at \(url.path)")
      }
      artifacts[key] = url
    }

    guard let host = hostOverride?.isEmpty == false ? hostOverride : LocalIPv4.bestLocalIPv4Address() else {
      throw OtaServerModuleError("No Wi-Fi/LAN IPv4 address found for this phone.")
    }

    let server = otaServer ?? LocalOtaServer(
      onLog: { [weak self] message in
        self?.emitStatus(message: message)
      }
    )
    otaServer = server
    server.configure(manifestJson: manifestJson, artifacts: artifacts)

    if let activePort = server.activePort {
      emitStatus(message: "OTA server ready at http://\(host):\(activePort)/version.json")
      return serverResult(host: host, port: activePort)
    }

    var lastError: Error?
    for port in otaPorts {
      do {
        let actualPort = try server.start(host: host, port: UInt16(port))
        emitStatus(message: "OTA server ready at http://\(host):\(actualPort)/version.json")
        return serverResult(host: host, port: actualPort)
      } catch {
        lastError = error
        emitStatus(message: "Port \(port) unavailable: \(error.localizedDescription)")
      }
    }

    throw OtaServerModuleError(
      "Could not start OTA server: \(lastError?.localizedDescription ?? "all ports unavailable")"
    )
  }

  private func stopOtaServerInternal() {
    serverLock.lock()
    defer { serverLock.unlock() }

    otaServer?.stop()
    emitStatus(message: "OTA server stopped")
  }

  private func startHealthKeepalive(url: String, intervalMs: Int) throws {
    guard let healthUrl = URL(string: url),
          healthUrl.scheme == "http" || healthUrl.scheme == "https"
    else {
      throw OtaServerModuleError("Invalid health URL")
    }
    stopHealthKeepaliveInternal()
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    let cadence = max(intervalMs, 5_000)
    timer.schedule(deadline: .now(), repeating: .milliseconds(cadence))
    timer.setEventHandler { [weak self] in
      var request = URLRequest(url: healthUrl)
      request.httpMethod = "HEAD"
      request.timeoutInterval = 5
      URLSession.shared.dataTask(with: request) { _, response, error in
        if let error {
          self?.emitStatus(message: "Glasses health keepalive failed: \(error.localizedDescription)")
        } else {
          let status = (response as? HTTPURLResponse)?.statusCode ?? 0
          self?.emitStatus(message: "Glasses health keepalive HTTP \(status)")
        }
      }.resume()
    }
    healthTimer = timer
    timer.resume()
  }

  private func stopHealthKeepaliveInternal() {
    healthTimer?.cancel()
    healthTimer = nil
  }

  private func emitStatus(message: String) {
    NSLog("[MentraOtaServer] %@", message)
    sendEvent("serverStatus", [
      "message": message,
    ])
  }

  private func serverResult(host: String, port: UInt16) -> [String: Any] {
    [
      "baseUrl": "http://\(host):\(port)",
      "manifestUrl": "http://\(host):\(port)/version.json",
      "host": host,
      "port": port,
    ]
  }

  private let otaPorts = [8791, 8792, 8793, 8794]
}

final class OtaServerModuleError: Exception, @unchecked Sendable {
  private let message: String

  init(_ message: String) {
    self.message = message
    super.init()
  }

  override var reason: String {
    message
  }
}
