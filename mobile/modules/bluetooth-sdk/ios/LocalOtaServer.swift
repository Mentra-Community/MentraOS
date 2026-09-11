import Foundation
import Network

struct OtaServerError: LocalizedError {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}

/// Static HTTP server for hotspot-served glasses OTA (OS-1676).
///
/// Serves the rewritten OTA manifest at /version.json and pre-downloaded artifacts at
/// /artifacts/<sha256> to the glasses over the glasses-hotspot link. Mirrors
/// LocalPhotoUploadServer's NWListener structure.
final class LocalOtaServer {
  private let queue = DispatchQueue(label: "com.mentra.ota-server")
  private let onLog: (String) -> Void
  private var listener: NWListener?
  private var listenerGeneration = 0
  private(set) var activePort: UInt16?

  private var manifestJson = "{}"
  private var artifacts: [String: URL] = [:]

  private static let maxHeaderBytes = 64 * 1024
  private static let streamChunkBytes = 256 * 1024

  init(onLog: @escaping (String) -> Void) {
    self.onLog = onLog
  }

  /// Swap the served manifest and artifact set. Safe while the server is running.
  func configure(manifestJson: String, artifacts: [String: URL]) {
    queue.sync {
      self.manifestJson = manifestJson
      self.artifacts = artifacts
    }
  }

  func start(host: String, port: UInt16) throws -> UInt16 {
    if listener != nil, activePort == port {
      onLog("Already listening on \(host):\(port)")
      return port
    }
    stop()

    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
      throw OtaServerError("Invalid port \(port)")
    }

    parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: endpointPort)
    let listener = try NWListener(using: parameters)
    listenerGeneration += 1
    let generation = listenerGeneration
    let started = DispatchSemaphore(value: 0)
    var startError: Error?
    var isReady = false

    listener.stateUpdateHandler = { [weak self] state in
      guard let self, self.listenerGeneration == generation else {
        return
      }
      switch state {
      case .ready:
        isReady = true
        self.activePort = port
        self.onLog("OTA server listening on \(host):\(port)")
        started.signal()
      case .failed(let error):
        startError = error
        self.activePort = nil
        self.listener = nil
        self.onLog("OTA server failed on \(port): \(error)")
        started.signal()
      case .cancelled:
        self.activePort = nil
        if !isReady {
          startError = OtaServerError("Listener cancelled")
          started.signal()
        }
      default:
        break
      }
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection)
    }

    self.listener = listener
    listener.start(queue: queue)

    if started.wait(timeout: .now() + 2) == .timedOut {
      self.listener = nil
      listener.cancel()
      throw OtaServerError("Timed out starting listener")
    }
    if let startError {
      self.listener = nil
      listener.cancel()
      throw startError
    }

    return port
  }

  func stop() {
    listenerGeneration += 1
    listener?.cancel()
    listener = nil
    activePort = nil
  }

  private final class RequestReadState {
    var buffer = Data()
  }

  private func handle(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(connection, state: RequestReadState())
  }

  private func receive(_ connection: NWConnection, state: RequestReadState) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else {
        connection.cancel()
        return
      }
      if let error {
        self.onLog("request failed: \(error.localizedDescription)")
        connection.cancel()
        return
      }
      if let data, !data.isEmpty {
        state.buffer.append(data)
      }

      if let headerRange = state.buffer.range(of: Data([13, 10, 13, 10])) {
        let headerData = state.buffer.subdata(in: state.buffer.startIndex..<headerRange.lowerBound)
        let headerText = String(data: headerData, encoding: .isoLatin1) ?? ""
        self.route(connection, headerText: headerText)
        return
      }
      if state.buffer.count > Self.maxHeaderBytes {
        self.writeJson(connection, status: 400, body: #"{"ok":false,"error":"headers_too_large"}"#)
        return
      }
      if isComplete {
        connection.cancel()
        return
      }
      self.receive(connection, state: state)
    }
  }

  private func route(_ connection: NWConnection, headerText: String) {
    let lines = headerText.components(separatedBy: "\r\n").filter { !$0.isEmpty }
    let requestParts = lines.first?.components(separatedBy: " ") ?? []
    let method = requestParts.count > 0 ? requestParts[0].uppercased() : ""
    let rawPath = requestParts.count > 1 ? requestParts[1] : ""
    let path = rawPath.components(separatedBy: "?")[0]
    onLog("\(method) \(path)")

    guard method == "GET" else {
      writeJson(connection, status: 405, body: #"{"ok":false,"error":"method_not_allowed"}"#)
      return
    }

    if path == "/version.json" {
      writeBody(
        connection,
        status: 200,
        contentType: "application/json",
        body: Data(manifestJson.utf8)
      )
      return
    }

    if path.hasPrefix("/artifacts/") {
      let key = String(path.dropFirst("/artifacts/".count))
      guard let fileUrl = artifacts[key],
            let fileSize = try? fileUrl.resourceValues(forKeys: [.fileSizeKey]).fileSize
      else {
        writeJson(connection, status: 404, body: #"{"ok":false,"error":"artifact_not_found"}"#)
        return
      }
      sendFile(connection, fileUrl: fileUrl, fileLength: Int64(fileSize))
      return
    }

    writeJson(connection, status: 404, body: #"{"ok":false,"error":"not_found"}"#)
  }

  private func sendFile(
    _ connection: NWConnection,
    fileUrl: URL,
    fileLength: Int64
  ) {
    let header =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: application/octet-stream\r\n" +
      "Content-Length: \(fileLength)\r\n" +
      "Connection: close\r\n\r\n"

    guard let fileHandle = try? FileHandle(forReadingFrom: fileUrl) else {
      writeJson(connection, status: 500, body: #"{"ok":false,"error":"artifact_unreadable"}"#)
      return
    }

    connection.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] error in
      guard let self, error == nil else {
        try? fileHandle.close()
        connection.cancel()
        return
      }
      self.streamChunks(connection, fileHandle: fileHandle, remaining: fileLength)
    })
  }

  private func streamChunks(_ connection: NWConnection, fileHandle: FileHandle, remaining: Int64) {
    if remaining <= 0 {
      try? fileHandle.close()
      connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
        connection.cancel()
      })
      return
    }
    let chunkSize = Int(min(Int64(Self.streamChunkBytes), remaining))
    let chunk: Data
    do {
      guard let data = try fileHandle.read(upToCount: chunkSize), !data.isEmpty else {
        throw OtaServerError("artifact truncated while streaming")
      }
      chunk = data
    } catch {
      onLog("stream failed: \(error.localizedDescription)")
      try? fileHandle.close()
      connection.cancel()
      return
    }
    connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
      guard let self else {
        try? fileHandle.close()
        connection.cancel()
        return
      }
      if let error {
        self.onLog("stream failed: \(error.localizedDescription)")
        try? fileHandle.close()
        connection.cancel()
        return
      }
      self.streamChunks(connection, fileHandle: fileHandle, remaining: remaining - Int64(chunk.count))
    })
  }

  private func writeJson(
    _ connection: NWConnection,
    status: Int,
    body: String
  ) {
    writeBody(
      connection,
      status: status,
      contentType: "application/json",
      body: Data(body.utf8)
    )
  }

  private func writeBody(
    _ connection: NWConnection,
    status: Int,
    contentType: String,
    body: Data
  ) {
    let reason: String
    switch status {
    case 200:
      reason = "OK"
    case 400:
      reason = "Bad Request"
    case 404:
      reason = "Not Found"
    case 405:
      reason = "Method Not Allowed"
    default:
      reason = "Internal Server Error"
    }

    let header =
      "HTTP/1.1 \(status) \(reason)\r\n" +
      "Content-Type: \(contentType)\r\n" +
      "Content-Length: \(body.count)\r\n" +
      "Connection: close\r\n" +
      "\r\n"
    var response = Data(header.utf8)
    response.append(body)
    connection.send(content: response, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }
}
