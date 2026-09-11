import Foundation
import Network

struct PhotoUpload {
  let requestId: String?
  let photoFile: URL
  let byteCount: Int
  let fields: [String: String]
}

final class LocalPhotoUploadServer {
  private let queue = DispatchQueue(label: "com.mentra.examples.photo-upload")
  private let uploadDirectory: URL
  private let onLog: (String) -> Void
  private let onUpload: (PhotoUpload) -> Void
  private var listener: NWListener?
  private var listenerGeneration = 0
  private(set) var activePort: UInt16?

  init(onLog: @escaping (String) -> Void, onUpload: @escaping (PhotoUpload) -> Void) {
    self.onLog = onLog
    self.onUpload = onUpload
    uploadDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("mentra-photo-uploads", isDirectory: true)
  }

  func start(port: UInt16) throws -> UInt16 {
    if listener != nil, activePort == port {
      onLog("Already listening on 0.0.0.0:\(port)")
      return port
    }
    stop()
    try FileManager.default.createDirectory(
      at: uploadDirectory,
      withIntermediateDirectories: true
    )

    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
      throw PhotoUploadServerError("Invalid port \(port)")
    }

    let listener = try NWListener(using: parameters, on: endpointPort)
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
        self.onLog("Listening on 0.0.0.0:\(port)")
        started.signal()
      case .failed(let error):
        startError = error
        self.activePort = nil
        self.listener = nil
        self.onLog("Photo receiver failed on \(port): \(error)")
        started.signal()
      case .cancelled:
        self.activePort = nil
        if !isReady {
          startError = PhotoUploadServerError("Listener cancelled")
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
      throw PhotoUploadServerError("Timed out starting listener")
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

  private func handle(_ connection: NWConnection) {
    traceWifiInput("photo_receiver_connection", connection: connection, state: nil)
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
        state.multipartParser?.cleanup()
        self.onLog("request failed: \(error.localizedDescription)")
        connection.cancel()
        return
      }
      if let data, !data.isEmpty {
        state.buffer.append(data)
      }

      do {
        if try self.handleIfComplete(connection, state: state) {
          return
        }
      } catch {
        state.multipartParser?.cleanup()
        self.onLog("request failed: \(error.localizedDescription)")
        if let uploadError = error as? PhotoUploadServerError {
          self.writeJson(
            connection,
            status: 400,
            body: #"{"ok":false,"error":\#(self.jsonString(uploadError.localizedDescription))}"#
          )
        } else {
          self.writeJson(connection, status: 500, body: #"{"ok":false,"error":"server_error"}"#)
        }
        return
      }

      if isComplete {
        state.multipartParser?.cleanup()
        self.writeJson(connection, status: 400, body: #"{"ok":false,"error":"incomplete_request"}"#)
        return
      }
      self.receive(connection, state: state)
    }
  }

  private func handleIfComplete(_ connection: NWConnection, state: RequestReadState) throws -> Bool {
    if state.request == nil {
      guard let headerRange = state.buffer.range(of: Data([13, 10, 13, 10])) else {
        if state.buffer.count > Self.maxHeaderBytes {
          writeJson(connection, status: 413, body: #"{"ok":false,"error":"headers_too_large"}"#)
          return true
        }
        return false
      }

      let headerData = state.buffer[state.buffer.startIndex..<headerRange.lowerBound]
      guard let headerText = String(data: headerData, encoding: .isoLatin1) else {
        writeJson(connection, status: 400, body: #"{"ok":false,"error":"invalid_headers"}"#)
        return true
      }
      let request = HttpRequest.parse(headerText)
      state.request = request
      onLog("\(request.method) \(request.path)")
      var requestTraceValues: [String: Any] = [
        "method": request.method,
        "path": request.path,
      ]
      if let contentLength = request.headers["content-length"].flatMap(Int.init) {
        requestTraceValues["contentLength"] = contentLength
      }
      traceWifiInput("photo_receiver_request", connection: connection, state: state, values: requestTraceValues)

      if request.method == "GET", request.path == "/" || request.path == "/health" {
        writeJson(connection, status: 200, body: #"{"ok":true,"service":"mentra-photo-upload-receiver"}"#)
        return true
      }

      guard request.method == "POST", request.path == "/upload" else {
        writeJson(connection, status: 404, body: #"{"ok":false,"error":"not_found"}"#)
        return true
      }

      guard let contentLength = request.headers["content-length"].flatMap(Int.init), contentLength > 0 else {
        writeJson(connection, status: 411, body: #"{"ok":false,"error":"content_length_required"}"#)
        return true
      }
      guard contentLength <= Self.maxUploadBytes else {
        writeJson(connection, status: 413, body: #"{"ok":false,"error":"upload_too_large"}"#)
        return true
      }

      state.contentLength = contentLength
      guard let boundary = multipartBoundary(request.headers["content-type"] ?? "") else {
        writeJson(connection, status: 400, body: #"{"ok":false,"error":"multipart_boundary_required"}"#)
        return true
      }
      state.multipartParser = MultipartStreamParser(
        boundary: boundary,
        uploadDirectory: uploadDirectory
      )
      if request.headers["expect"]?.localizedCaseInsensitiveContains("100-continue") == true {
        write(connection, text: "HTTP/1.1 100 Continue\r\n\r\n", closeAfterSend: false)
      }

      let bodyFragment = Data(state.buffer[headerRange.upperBound..<state.buffer.endIndex])
      state.buffer.removeAll(keepingCapacity: true)
      try appendBodyFragment(bodyFragment, to: state)
    }

    guard let request = state.request else {
      return false
    }
    if !state.buffer.isEmpty {
      let bodyFragment = state.buffer
      state.buffer.removeAll(keepingCapacity: true)
      try appendBodyFragment(bodyFragment, to: state)
    }

    guard state.multipartParser?.isComplete == true else {
      if state.bodyBytesReceived >= state.contentLength {
        state.multipartParser?.cleanup()
        writeJson(connection, status: 400, body: #"{"ok":false,"error":"multipart_boundary_missing"}"#)
        return true
      }
      return false
    }

    let contentType = request.headers["content-type"] ?? ""
    onLog("headers contentType=\(contentType) contentLength=\(state.contentLength)")

    guard let parsed = state.multipartParser?.parsedMultipart() else {
      state.multipartParser?.cleanup()
      writeJson(connection, status: 400, body: #"{"ok":false,"error":"incomplete_request"}"#)
      return true
    }
    guard let photoPart = parsed.files["photo"] ?? parsed.files.values.first else {
      parsed.deleteFiles()
      writeJson(connection, status: 400, body: #"{"ok":false,"error":"photo_field_required"}"#)
      return true
    }

    let requestId = parsed.fields["requestId"] ?? parsed.fields["request_id"]
    let filename = safeFilePart(requestId ?? "photo-\(Int(Date().timeIntervalSince1970 * 1000))")
    let photoFile = uploadDirectory.appendingPathComponent("\(filename).jpg")
    var didMovePhoto = false
    defer {
      if didMovePhoto {
        parsed.deleteFiles(except: photoFile)
      } else {
        parsed.deleteFiles()
        try? FileManager.default.removeItem(at: photoFile)
      }
    }
    try moveFile(photoPart.file, to: photoFile)
    didMovePhoto = true
    let upload = PhotoUpload(
      requestId: requestId,
      photoFile: photoFile,
      byteCount: photoPart.byteCount,
      fields: parsed.fields
    )

    onLog("upload fields=\(parsed.fields.keys.joined(separator: ",")) requestId=\(requestId ?? "") bytes=\(photoPart.byteCount) saved=\(photoFile.path)")
    var uploadReceivedTraceValues: [String: Any] = [
      "durationMs": Int(Date().timeIntervalSince1970 * 1000 - state.startMs),
      "photoBytes": photoPart.byteCount,
      "contentLength": state.contentLength,
      "method": request.method,
      "path": request.path,
    ]
    if let requestId {
      uploadReceivedTraceValues["requestId"] = requestId
    }
    traceWifiInput("photo_receiver_upload_received", connection: connection, state: state, values: uploadReceivedTraceValues)
    var uploadResponseTraceValues: [String: Any] = [
      "statusCode": 200,
      "success": true,
      "durationMs": Int(Date().timeIntervalSince1970 * 1000 - state.startMs),
      "contentLength": state.contentLength,
      "method": request.method,
      "path": request.path,
    ]
    if let requestId {
      uploadResponseTraceValues["requestId"] = requestId
    }
    traceWifiOutput("photo_receiver_response", connection: connection, state: state, values: uploadResponseTraceValues)
    writeJson(
      connection,
      status: 200,
      body: #"{"ok":true,"requestId":\#(jsonString(requestId ?? "")),"bytes":\#(photoPart.byteCount)}"#
    )
    queue.async { [onUpload] in
      onUpload(upload)
    }
    return true
  }

  private func appendBodyFragment(_ data: Data, to state: RequestReadState) throws {
    guard !data.isEmpty else {
      return
    }
    let remaining = state.contentLength - state.bodyBytesReceived
    guard remaining > 0 else {
      return
    }
    let acceptedCount = min(data.count, remaining)
    let accepted = Data(data[data.startIndex..<data.startIndex + acceptedCount])
    state.bodyBytesReceived += acceptedCount
    try state.multipartParser?.append(accepted)
  }

  private func writeJson(_ connection: NWConnection, status: Int, body: String) {
    let reason: String
    switch status {
    case 200:
      reason = "OK"
    case 400:
      reason = "Bad Request"
    case 404:
      reason = "Not Found"
    case 411:
      reason = "Length Required"
    case 413:
      reason = "Payload Too Large"
    default:
      reason = "Internal Server Error"
    }

    let bodyData = Data(body.utf8)
    let header =
      "HTTP/1.1 \(status) \(reason)\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: \(bodyData.count)\r\n" +
      "Connection: close\r\n" +
      "\r\n"
    var response = Data(header.utf8)
    response.append(bodyData)
    connection.send(content: response, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }

  private func write(
    _ connection: NWConnection,
    text: String,
    closeAfterSend: Bool
  ) {
    connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in
      if closeAfterSend {
        connection.cancel()
      }
    })
  }

  private func multipartBoundary(_ contentType: String) -> String? {
    contentType
      .split(separator: ";")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { $0.caseInsensitiveHasPrefix("boundary=") }?
      .split(separator: "=", maxSplits: 1)
      .last
      .map(String.init)?
      .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
  }

  private func safeFilePart(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    let sanitized = String(value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    return sanitized.isEmpty ? "photo" : sanitized
  }

  private func jsonString(_ value: String) -> String {
    guard
      let data = try? JSONSerialization.data(withJSONObject: [value]),
      let json = String(data: data, encoding: .utf8)
    else {
      return #""""#
    }
    return String(json.dropFirst().dropLast())
  }

  private func moveFile(_ source: URL, to destination: URL) throws {
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    do {
      try FileManager.default.moveItem(at: source, to: destination)
    } catch {
      try FileManager.default.copyItem(at: source, to: destination)
      try? FileManager.default.removeItem(at: source)
    }
  }

  private func traceWifiInput(
    _ type: String,
    connection: NWConnection,
    state: RequestReadState?,
    values: [String: Any] = [:]
  ) {
    traceWifi(direction: "wifi_to_phone", layer: "wifi_http_input", type: type, connection: connection, state: state, values: values)
  }

  private func traceWifiOutput(
    _ type: String,
    connection: NWConnection,
    state: RequestReadState?,
    values: [String: Any] = [:]
  ) {
    traceWifi(direction: "phone_to_wifi", layer: "wifi_http_output", type: type, connection: connection, state: state, values: values)
  }

  private func traceWifi(
    direction: String,
    layer: String,
    type: String,
    connection: NWConnection,
    state: RequestReadState?,
    values: [String: Any]
  ) {
    var payload = endpointPayload(type: type, connection: connection)
    if let state {
      payload["startMs"] = state.startMs
    }
    for (key, value) in values {
      payload[key] = value
    }
    BleTraceLogger.logMap(direction: direction, layer: layer, type: type, payload: payload)
  }

  private func endpointPayload(type: String, connection: NWConnection) -> [String: Any] {
    var payload: [String: Any] = ["type": type]
    if case let .hostPort(host, port) = connection.endpoint {
      payload["remoteHost"] = String(describing: host)
      payload["remotePort"] = Int(port.rawValue)
    }
    return payload
  }

  private struct HttpRequest {
    let method: String
    let path: String
    let headers: [String: String]

    static func parse(_ headerText: String) -> HttpRequest {
      let lines = headerText.components(separatedBy: "\r\n").filter { !$0.isEmpty }
      let requestParts = lines.first?.split(separator: " ").map(String.init) ?? []
      let method = requestParts.first?.uppercased() ?? ""
      let path = requestParts.dropFirst().first?.split(separator: "?").first.map(String.init) ?? ""
      var headers: [String: String] = [:]
      for line in lines.dropFirst() {
        guard let separator = line.firstIndex(of: ":") else {
          continue
        }
        let key = String(line[..<separator].lowercased())
        let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
        headers[key] = value
      }
      return HttpRequest(method: method, path: path, headers: headers)
    }
  }

  private final class MultipartStreamParser {
    private enum Stage {
      case initialBoundary
      case partHeaders
      case partBody
      case boundarySuffix
      case complete
    }

    private let marker: String
    private let delimiter: Data
    private let crlf = Data([13, 10])
    private let headerDelimiter = Data([13, 10, 13, 10])
    private let uploadDirectory: URL
    private var stage: Stage = .initialBoundary
    private var buffer = Data()
    private var currentPart: PartWriter?
    private var fields: [String: String] = [:]
    private var files: [String: StreamedFile] = [:]

    var isComplete: Bool {
      stage == .complete
    }

    init(boundary: String, uploadDirectory: URL) {
      marker = "--\(boundary)"
      delimiter = Data("\r\n--\(boundary)".utf8)
      self.uploadDirectory = uploadDirectory
    }

    func append(_ data: Data) throws {
      guard !isComplete else {
        return
      }
      buffer.append(data)
      try processBuffer()
    }

    func parsedMultipart() -> ParsedMultipart? {
      guard isComplete else {
        return nil
      }
      return ParsedMultipart(fields: fields, files: files)
    }

    func cleanup() {
      currentPart?.cleanup()
      files.values.forEach { try? FileManager.default.removeItem(at: $0.file) }
    }

    private func processBuffer() throws {
      while true {
        switch stage {
        case .initialBoundary:
          guard let line = try popLine() else {
            return
          }
          if line == "\(marker)--" {
            stage = .complete
            return
          }
          guard line == marker else {
            throw PhotoUploadServerError("multipart_boundary_missing")
          }
          stage = .partHeaders

        case .partHeaders:
          guard let headerBlock = try popHeaders() else {
            return
          }
          currentPart = try PartWriter(headerBlock: headerBlock, uploadDirectory: uploadDirectory)
          stage = .partBody

        case .partBody:
          guard let currentPart else {
            throw PhotoUploadServerError("multipart_part_missing")
          }
          if let delimiterRange = buffer.range(of: delimiter) {
            let content = Data(buffer[buffer.startIndex..<delimiterRange.lowerBound])
            try currentPart.write(content)
            buffer.removeSubrange(buffer.startIndex..<delimiterRange.upperBound)
            try currentPart.finish(fields: &fields, files: &files)
            self.currentPart = nil
            stage = .boundarySuffix
            continue
          }

          let keepBytes = max(delimiter.count - 1, 0)
          if buffer.count > keepBytes {
            let writeCount = buffer.count - keepBytes
            let content = Data(buffer[buffer.startIndex..<buffer.startIndex + writeCount])
            try currentPart.write(content)
            buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + writeCount)
          }
          return

        case .boundarySuffix:
          guard buffer.count >= 2 else {
            return
          }
          if buffer.starts(with: Data("--".utf8), at: buffer.startIndex) {
            buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + 2)
            stage = .complete
            return
          }
          if buffer.starts(with: crlf, at: buffer.startIndex) {
            buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + crlf.count)
            stage = .partHeaders
            continue
          }
          throw PhotoUploadServerError("invalid multipart boundary suffix")

        case .complete:
          return
        }
      }
    }

    private func popLine() throws -> String? {
      guard let lineRange = buffer.range(of: crlf) else {
        if buffer.count > LocalPhotoUploadServer.maxPartHeaderBytes {
          throw PhotoUploadServerError("multipart line too large")
        }
        return nil
      }
      let lineData = Data(buffer[buffer.startIndex..<lineRange.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<lineRange.upperBound)
      return String(data: lineData, encoding: .isoLatin1)
    }

    private func popHeaders() throws -> String? {
      guard let headerRange = buffer.range(of: headerDelimiter) else {
        if buffer.count > LocalPhotoUploadServer.maxPartHeaderBytes {
          throw PhotoUploadServerError("multipart headers too large")
        }
        return nil
      }
      let headerData = Data(buffer[buffer.startIndex..<headerRange.lowerBound])
      buffer.removeSubrange(buffer.startIndex..<headerRange.upperBound)
      return String(data: headerData, encoding: .isoLatin1)
    }

    private static func firstCapture(_ pattern: String, in text: String) -> String? {
      guard
        let regex = try? NSRegularExpression(pattern: pattern),
        let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
        match.numberOfRanges > 1,
        let range = Range(match.range(at: 1), in: text)
      else {
        return nil
      }
      return String(text[range])
    }

    private final class PartWriter {
      private let name: String?
      private let file: URL?
      private var fileHandle: FileHandle?
      private var fieldData = Data()
      private var byteCount = 0

      init(headerBlock: String, uploadDirectory: URL) throws {
        let disposition = headerBlock
          .components(separatedBy: "\r\n")
          .first { $0.caseInsensitiveHasPrefix("Content-Disposition:") } ?? ""
        name = MultipartStreamParser.firstCapture(#"name="([^"]+)""#, in: disposition)
        if MultipartStreamParser.firstCapture(#"filename="([^"]*)""#, in: disposition) != nil {
          let tempFile = uploadDirectory
            .appendingPathComponent("upload-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).tmp")
          FileManager.default.createFile(atPath: tempFile.path, contents: nil)
          file = tempFile
          fileHandle = try FileHandle(forWritingTo: tempFile)
        } else {
          file = nil
        }
      }

      func write(_ data: Data) throws {
        guard !data.isEmpty else {
          return
        }
        byteCount += data.count
        if let fileHandle {
          fileHandle.write(data)
        } else {
          guard fieldData.count + data.count <= LocalPhotoUploadServer.maxFieldBytes else {
            throw PhotoUploadServerError("multipart field too large")
          }
          fieldData.append(data)
        }
      }

      func finish(fields: inout [String: String], files: inout [String: StreamedFile]) throws {
        fileHandle?.closeFile()
        fileHandle = nil
        guard let name else {
          cleanup()
          return
        }
        if let file {
          if let previous = files.updateValue(StreamedFile(file: file, byteCount: byteCount), forKey: name) {
            try? FileManager.default.removeItem(at: previous.file)
          }
        } else {
          fields[name] = String(data: fieldData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        }
      }

      func cleanup() {
        fileHandle?.closeFile()
        fileHandle = nil
        if let file {
          try? FileManager.default.removeItem(at: file)
        }
      }
    }
  }

  private final class RequestReadState {
    let startMs = Date().timeIntervalSince1970 * 1000
    var buffer = Data()
    var request: HttpRequest?
    var contentLength = 0
    var bodyBytesReceived = 0
    var multipartParser: MultipartStreamParser?
  }

  private struct ParsedMultipart {
    let fields: [String: String]
    let files: [String: StreamedFile]

    func deleteFiles() {
      files.values.forEach { try? FileManager.default.removeItem(at: $0.file) }
    }

    func deleteFiles(except keptFile: URL) {
      files.values.forEach { part in
        if part.file.path != keptFile.path {
          try? FileManager.default.removeItem(at: part.file)
        }
      }
    }
  }

  private struct StreamedFile {
    let file: URL
    let byteCount: Int
  }

  private struct PhotoUploadServerError: LocalizedError {
    let message: String

    init(_ message: String) {
      self.message = message
    }

    var errorDescription: String? {
      message
    }
  }

  private static let maxHeaderBytes = 64 * 1024
  private static let maxPartHeaderBytes = 64 * 1024
  private static let maxFieldBytes = 64 * 1024
  private static let maxUploadBytes = 25 * 1024 * 1024
}

private extension Data {
  func starts(with prefix: Data, at index: Data.Index) -> Bool {
    guard index >= startIndex, index + prefix.count <= endIndex else {
      return false
    }
    return self[index..<index + prefix.count].elementsEqual(prefix)
  }
}

private extension String {
  func caseInsensitiveHasPrefix(_ prefix: String) -> Bool {
    range(of: prefix, options: [.anchored, .caseInsensitive]) != nil
  }
}
