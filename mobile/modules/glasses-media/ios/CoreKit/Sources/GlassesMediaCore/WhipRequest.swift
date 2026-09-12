import Foundation

public struct WhipRequest {
    public let method: String
    public let path: String
    public let body: String
    public let contentType: String

    public static let maxHeaderBytes = 8192
    public static let maxBodyBytes = 256 * 1024

    /// nil means more bytes are needed. Reject ambiguous framing before reading the body.
    public static func parse(_ data: Data) throws -> WhipRequest? {
        guard let boundary = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= maxHeaderBytes else { throw LocalMediaError("HTTP headers too large") }
            return nil
        }
        guard boundary.lowerBound <= maxHeaderBytes,
              let head = String(data: data[..<boundary.lowerBound], encoding: .utf8)
        else {
            throw LocalMediaError("Invalid HTTP headers")
        }
        let lines = head.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1", first[1].hasPrefix("/") else {
            throw LocalMediaError("Invalid HTTP request")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw LocalMediaError("Invalid HTTP header") }
            let name = line[..<colon].lowercased()
            guard headers[name] == nil else { throw LocalMediaError("Duplicate HTTP header") }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard headers["transfer-encoding"] == nil else { throw LocalMediaError("Chunked offers are unsupported") }
        let method = String(first[0])
        guard method != "POST" || headers["content-length"] != nil else { throw LocalMediaError("Content-Length required") }
        guard let length = Int(headers["content-length"] ?? "0"), length >= 0, length <= maxBodyBytes else {
            throw LocalMediaError("Invalid or oversized HTTP body")
        }
        let end = boundary.upperBound + length
        guard data.count >= end else { return nil }
        guard data.count == end, let body = String(data: data[boundary.upperBound ..< end], encoding: .utf8) else {
            throw LocalMediaError("Invalid HTTP body")
        }
        return WhipRequest(method: method, path: String(first[1].split(separator: "?", maxSplits: 1)[0]), body: body,
                           contentType: (headers["content-type"] ?? "").split(separator: ";").first.map(String.init)?.lowercased() ?? "")
    }

    public static func response(_ status: Int, body: String = "", headers: [String: String] = [:]) -> Data {
        let reasons = [201: "Created", 204: "No Content", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 415: "Unsupported Media Type", 500: "Internal Server Error", 503: "Service Unavailable"]
        var value = "HTTP/1.1 \(status) \(reasons[status] ?? "Error")\r\n"
        for (name, content) in headers {
            value += "\(name): \(content)\r\n"
        }
        value += "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        return Data(value.utf8)
    }
}
