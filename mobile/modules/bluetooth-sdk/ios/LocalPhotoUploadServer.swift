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

  init(onLog: @escaping (String) -> Void, onUpload: @escaping (PhotoUpload) -> Void) {
    self.onLog = onLog
    self.onUpload = onUpload
    uploadDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("mentra-photo-uploads", isDirectory: true)
  }

  func start(port: UInt16) throws -> UInt16 {
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
    let started = DispatchSemaphore(value: 0)
    var startError: Error?
    var isReady = false

    listener.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        isReady = true
        self?.onLog("Listening on 0.0.0.0:\(port)")
        started.signal()
      case .failed(let error):
        startError = error
        self?.onLog("Photo receiver failed on \(port): \(error)")
        started.signal()
      case .cancelled:
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
    listener?.cancel()
    listener = nil
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

      do {
        if try self.handleIfComplete(connection, state: state) {
          return
        }
      } catch {
        self.onLog("request failed: \(error.localizedDescription)")
        self.writeJson(connection, status: 500, body: #"{"ok":false,"error":"server_error"}"#)
        return
      }

      if isComplete {
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
      state.bodyStartIndex = headerRange.upperBound
      onLog("\(request.method) \(request.path)")

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
      if request.headers["expect"]?.localizedCaseInsensitiveContains("100-continue") == true {
        write(connection, text: "HTTP/1.1 100 Continue\r\n\r\n", closeAfterSend: false)
      }
    }

    guard let request = state.request, let bodyStartIndex = state.bodyStartIndex else {
      return false
    }
    guard state.buffer.count >= bodyStartIndex + state.contentLength else {
      return false
    }

    let bodyEndIndex = bodyStartIndex + state.contentLength
    let body = Data(state.buffer[bodyStartIndex..<bodyEndIndex])
    let contentType = request.headers["content-type"] ?? ""
    onLog("headers contentType=\(contentType) contentLength=\(state.contentLength)")

    guard let boundary = multipartBoundary(contentType) else {
      writeJson(connection, status: 400, body: #"{"ok":false,"error":"multipart_boundary_required"}"#)
      return true
    }

    let parsed = parseMultipart(body, boundary: boundary)
    guard let photoBytes = parsed.files["photo"] ?? parsed.files.values.first else {
      writeJson(connection, status: 400, body: #"{"ok":false,"error":"photo_field_required"}"#)
      return true
    }

    let requestId = parsed.fields["requestId"] ?? parsed.fields["request_id"]
    let filename = safeFilePart(requestId ?? "photo-\(Int(Date().timeIntervalSince1970 * 1000))")
    let photoFile = uploadDirectory.appendingPathComponent("\(filename).jpg")
    try photoBytes.write(to: photoFile, options: .atomic)

    onLog("upload fields=\(parsed.fields.keys.joined(separator: ",")) requestId=\(requestId ?? "") bytes=\(photoBytes.count) saved=\(photoFile.path)")
    onUpload(PhotoUpload(
      requestId: requestId,
      photoFile: photoFile,
      byteCount: photoBytes.count,
      fields: parsed.fields
    ))
    writeJson(
      connection,
      status: 200,
      body: #"{"ok":true,"requestId":"\#(jsonEscape(requestId ?? ""))","bytes":\#(photoBytes.count)}"#
    )
    return true
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
    let header = """
      HTTP/1.1 \(status) \(reason)\r
      Content-Type: application/json\r
      Content-Length: \(bodyData.count)\r
      Connection: close\r
      \r
      """
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

  private func parseMultipart(_ body: Data, boundary: String) -> ParsedMultipart {
    let marker = Data("--\(boundary)".utf8)
    let nextMarkerPrefix = Data("\r\n--\(boundary)".utf8)
    let headerDelimiter = Data([13, 10, 13, 10])
    let crlf = Data([13, 10])
    let closing = Data([45, 45])
    var fields: [String: String] = [:]
    var files: [String: Data] = [:]
    var cursor = body.startIndex

    while let markerRange = body.range(of: marker, options: [], in: cursor..<body.endIndex) {
      var partStart = markerRange.upperBound
      if body.starts(with: closing, at: partStart) {
        break
      }
      if body.starts(with: crlf, at: partStart) {
        partStart += crlf.count
      }
      guard
        let headerRange = body.range(of: headerDelimiter, options: [], in: partStart..<body.endIndex)
      else {
        break
      }

      let dataStart = headerRange.upperBound
      guard
        let nextMarkerRange = body.range(
          of: nextMarkerPrefix,
          options: [],
          in: dataStart..<body.endIndex
        )
      else {
        break
      }

      let headerData = body[partStart..<headerRange.lowerBound]
      let headerBlock = String(data: headerData, encoding: .isoLatin1) ?? ""
      let disposition = headerBlock
        .components(separatedBy: "\r\n")
        .first { $0.caseInsensitiveHasPrefix("Content-Disposition:") } ?? ""
      if let name = firstCapture(#"name="([^"]+)""#, in: disposition) {
        let bytes = Data(body[dataStart..<nextMarkerRange.lowerBound])
        if firstCapture(#"filename="([^"]*)""#, in: disposition) != nil {
          files[name] = bytes
        } else {
          fields[name] = String(data: bytes, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        }
      }
      cursor = nextMarkerRange.lowerBound + crlf.count
    }

    return ParsedMultipart(fields: fields, files: files)
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

  private func firstCapture(_ pattern: String, in text: String) -> String? {
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

  private func safeFilePart(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
    let sanitized = String(value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    return sanitized.isEmpty ? "photo" : sanitized
  }

  private func jsonEscape(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
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
      let headers: [String: String] = Dictionary(uniqueKeysWithValues: lines.dropFirst().compactMap { line in
        guard let separator = line.firstIndex(of: ":") else {
          return nil
        }
        let key = line[..<separator].lowercased()
        let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
        return (String(key), value)
      })
      return HttpRequest(method: method, path: path, headers: headers)
    }
  }

  private final class RequestReadState {
    var buffer = Data()
    var request: HttpRequest?
    var bodyStartIndex: Data.Index?
    var contentLength = 0
  }

  private struct ParsedMultipart {
    let fields: [String: String]
    let files: [String: Data]
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
