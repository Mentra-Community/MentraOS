import Foundation
import Network

struct LocalPhotoUpload {
    let requestId: String?
    let fileURL: URL
    let byteCount: Int
    let fields: [String: String]
}

enum LocalPhotoUploadServerError: LocalizedError {
    case invalidPort(UInt16)
    case listenerFailed(UInt16, String)
    case startupTimedOut(UInt16)
    case uploadDirectoryUnavailable

    var errorDescription: String? {
        switch self {
        case let .invalidPort(port):
            return "Invalid photo receiver port \(port)"
        case let .listenerFailed(port, message):
            return "Photo receiver failed to listen on port \(port): \(message)"
        case let .startupTimedOut(port):
            return "Photo receiver did not become ready on port \(port)"
        case .uploadDirectoryUnavailable:
            return "Photo receiver could not create its upload directory."
        }
    }
}

final class LocalPhotoUploadServer {
    private let queue = DispatchQueue(label: "com.mentra.examples.photo-upload-server")
    private let onLog: (String) -> Void
    private let onUpload: (LocalPhotoUpload) -> Void
    private var listener: NWListener?
    private let uploadDirectory: URL

    private(set) var running = false

    init(onLog: @escaping (String) -> Void, onUpload: @escaping (LocalPhotoUpload) -> Void) {
        self.onLog = onLog
        self.onUpload = onUpload
        uploadDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("mentra-photo-uploads", isDirectory: true)
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("mentra-photo-uploads", isDirectory: true)
    }

    func start(port listenPort: UInt16) throws -> UInt16 {
        stop()

        do {
            try FileManager.default.createDirectory(at: uploadDirectory, withIntermediateDirectories: true)
        } catch {
            throw LocalPhotoUploadServerError.uploadDirectoryUnavailable
        }

        guard let port = NWEndpoint.Port(rawValue: listenPort) else {
            throw LocalPhotoUploadServerError.invalidPort(listenPort)
        }

        let startup = DispatchSemaphore(value: 0)
        var startupError: NWError?
        let listener = try NWListener(using: .tcp, on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.running = true
                self?.onLog("Listening on 0.0.0.0:\(listenPort)")
                startup.signal()
            case let .failed(error), let .waiting(error):
                startupError = error
                startup.signal()
            case .cancelled:
                self?.running = false
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener

        switch startup.wait(timeout: .now() + 1) {
        case .success:
            if let startupError {
                stop()
                throw LocalPhotoUploadServerError.listenerFailed(listenPort, startupError.localizedDescription)
            }
            return listenPort
        case .timedOut:
            stop()
            throw LocalPhotoUploadServerError.startupTimedOut(listenPort)
        }
    }

    func stop() {
        running = false
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            if case let .failed(error) = state {
                self?.onLog("connection failed: \(error.localizedDescription)")
            }
        }
        connection.start(queue: queue)
        receive(on: connection, buffer: Data(), sentContinue: false)
    }

    private func receive(on connection: NWConnection, buffer: Data, sentContinue: Bool) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let error {
                self.send(status: 400, body: #"{"ok":false,"error":"\#(jsonEscape("receive failed: \(error.localizedDescription)"))"}"#, on: connection)
                return
            }

            var nextBuffer = buffer
            if let data {
                nextBuffer.append(data)
            }

            if nextBuffer.count > Self.maxHeaderBytes + Self.maxUploadBytes {
                self.send(status: 413, body: #"{"ok":false,"error":"upload_too_large"}"#, on: connection)
                return
            }

            var nextSentContinue = sentContinue
            if !sentContinue,
               let headers = HTTPRequestHeaders(data: nextBuffer),
               headers.headers["expect"]?.range(of: "100-continue", options: [.caseInsensitive]) != nil {
                self.sendContinue(on: connection)
                nextSentContinue = true
            }

            if let request = HTTPRequest(data: nextBuffer) {
                self.handle(request, on: connection)
            } else if isComplete {
                self.send(status: 400, body: #"{"ok":false,"error":"incomplete_http_request"}"#, on: connection)
            } else {
                self.receive(on: connection, buffer: nextBuffer, sentContinue: nextSentContinue)
            }
        }
    }

    private func handle(_ request: HTTPRequest, on connection: NWConnection) {
        onLog("\(request.method) \(request.path)")

        if request.method == "GET", request.path == "/" || request.path == "/health" {
            send(status: 200, body: #"{"ok":true,"service":"mentra-photo-upload-receiver"}"#, on: connection)
            return
        }

        guard request.method == "POST", request.path == "/upload" else {
            send(status: 404, body: #"{"ok":false,"error":"not_found"}"#, on: connection)
            return
        }

        guard !request.body.isEmpty else {
            send(status: 411, body: #"{"ok":false,"error":"content_length_required"}"#, on: connection)
            return
        }

        guard request.body.count <= Self.maxUploadBytes else {
            send(status: 413, body: #"{"ok":false,"error":"upload_too_large"}"#, on: connection)
            return
        }

        guard let boundary = multipartBoundary(request.headers["content-type"] ?? "") else {
            send(status: 400, body: #"{"ok":false,"error":"multipart_boundary_required"}"#, on: connection)
            return
        }

        let parsed = parseMultipart(request.body, boundary: boundary)
        guard let photoBytes = parsed.files["photo"] ?? parsed.files.values.first else {
            send(status: 400, body: #"{"ok":false,"error":"photo_field_required"}"#, on: connection)
            return
        }

        let requestId = parsed.fields["requestId"] ?? parsed.fields["request_id"]
        let fileName = "\(safeFilePart(requestId ?? "photo-\(Int(Date().timeIntervalSince1970 * 1000))")).jpg"
        let fileURL = uploadDirectory.appendingPathComponent(fileName)

        do {
            try photoBytes.write(to: fileURL, options: [.atomic])
            onLog("upload requestId=\(requestId ?? "") bytes=\(photoBytes.count) saved=\(fileURL.path)")
            onUpload(
                LocalPhotoUpload(
                    requestId: requestId,
                    fileURL: fileURL,
                    byteCount: photoBytes.count,
                    fields: parsed.fields
                )
            )
            send(status: 200, body: #"{"ok":true,"requestId":"\#(jsonEscape(requestId ?? ""))","bytes":\#(photoBytes.count)}"#, on: connection)
        } catch {
            onLog("save failed: \(error.localizedDescription)")
            send(status: 500, body: #"{"ok":false,"error":"\#(jsonEscape(error.localizedDescription))"}"#, on: connection)
        }
    }

    private func sendContinue(on connection: NWConnection) {
        connection.send(content: Data("HTTP/1.1 100 Continue\r\n\r\n".utf8), completion: .contentProcessed { [weak self] error in
            if let error {
                self?.onLog("100-continue failed: \(error.localizedDescription)")
            }
        })
    }

    private func send(status: Int, body: String, on connection: NWConnection) {
        let bodyData = Data(body.utf8)
        var response = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status).capitalized)\r\n"
        response += "Content-Type: application/json\r\n"
        response += "Content-Length: \(bodyData.count)\r\n"
        response += "Connection: close\r\n\r\n"

        var responseData = Data(response.utf8)
        responseData.append(bodyData)
        connection.send(content: responseData, completion: .contentProcessed { [weak self] error in
            if let error {
                self?.onLog("response failed: \(error.localizedDescription)")
            }
            connection.cancel()
        })
    }

    private func multipartBoundary(_ contentType: String) -> String? {
        contentType
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { $0.lowercased().hasPrefix("boundary=") }
            .map { String($0.dropFirst("boundary=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    private func parseMultipart(_ body: Data, boundary: String) -> ParsedMultipart {
        let marker = Data("--\(boundary)".utf8)
        let nextMarkerPrefix = Data("\r\n--\(boundary)".utf8)
        let crlf = Data("\r\n".utf8)
        let headerSeparator = Data("\r\n\r\n".utf8)
        var fields: [String: String] = [:]
        var files: [String: Data] = [:]
        var cursor = body.startIndex

        while let markerRange = body.range(of: marker, options: [], in: cursor..<body.endIndex) {
            var partStart = markerRange.upperBound
            if body.hasPrefix(Data("--".utf8), at: partStart) {
                break
            }
            if body.hasPrefix(crlf, at: partStart) {
                partStart += crlf.count
            }
            guard let headerEnd = body.range(of: headerSeparator, options: [], in: partStart..<body.endIndex) else {
                break
            }
            let dataStart = headerEnd.upperBound
            guard let nextMarker = body.range(of: nextMarkerPrefix, options: [], in: dataStart..<body.endIndex) else {
                break
            }

            let headerData = body.subdata(in: partStart..<headerEnd.lowerBound)
            let headerBlock = String(data: headerData, encoding: .isoLatin1) ?? ""
            let disposition = headerBlock
                .components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("content-disposition:") } ?? ""
            guard let name = quotedValue(named: "name", in: disposition) else {
                cursor = nextMarker.lowerBound
                continue
            }

            let bytes = body.subdata(in: dataStart..<nextMarker.lowerBound)
            if quotedValue(named: "filename", in: disposition) != nil {
                files[name] = bytes
            } else if let value = String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) {
                fields[name] = value
            }
            cursor = nextMarker.lowerBound + crlf.count
        }

        return ParsedMultipart(fields: fields, files: files)
    }

    private func quotedValue(named name: String, in text: String) -> String? {
        let marker = "\(name)=\""
        guard let start = text.range(of: marker) else { return nil }
        let valueStart = start.upperBound
        guard let end = text[valueStart...].firstIndex(of: "\"") else { return nil }
        return String(text[valueStart..<end])
    }

    private func safeFilePart(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        var result = ""
        for scalar in value.unicodeScalars {
            result.unicodeScalars.append(allowed.contains(scalar) ? scalar : "_")
        }
        return result.isEmpty ? "photo" : result
    }

    private struct ParsedMultipart {
        let fields: [String: String]
        let files: [String: Data]
    }

    private static let maxHeaderBytes = 64 * 1024
    private static let maxUploadBytes = 25 * 1024 * 1024
}

private struct HTTPRequestHeaders {
    let headers: [String: String]

    init?(data: Data) {
        guard let headerRange = data.range(of: Data([13, 10, 13, 10])) else {
            return nil
        }
        let headerData = data.subdata(in: data.startIndex..<headerRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .isoLatin1) else {
            return nil
        }
        headers = parseHeaders(headerText)
    }
}

private struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    init?(data: Data) {
        let separator = Data([13, 10, 13, 10])
        guard let headerRange = data.range(of: separator) else {
            return nil
        }

        let headerData = data.subdata(in: data.startIndex..<headerRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .isoLatin1) else {
            return nil
        }

        let lines = headerText.components(separatedBy: "\r\n").filter { !$0.isEmpty }
        guard let requestLine = lines.first else {
            return nil
        }
        let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else {
            return nil
        }

        method = parts[0].uppercased()
        path = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? parts[1]
        headers = parseHeaders(headerText)

        let contentLength = Int(headers["content-length"] ?? "") ?? 0
        let bodyStart = headerRange.upperBound
        guard data.count >= bodyStart + contentLength else {
            return nil
        }
        body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
    }
}

private func parseHeaders(_ headerText: String) -> [String: String] {
    var headers: [String: String] = [:]
    let lines = headerText.components(separatedBy: "\r\n").filter { !$0.isEmpty }
    for line in lines.dropFirst() {
        guard let separator = line.firstIndex(of: ":") else { continue }
        let name = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespacesAndNewlines)
        headers[name] = value
    }
    return headers
}

private extension Data {
    func hasPrefix(_ prefix: Data, at offset: Data.Index) -> Bool {
        guard offset >= startIndex,
              offset + prefix.count <= endIndex
        else {
            return false
        }

        return self[offset..<(offset + prefix.count)].elementsEqual(prefix)
    }
}

private func jsonEscape(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}
