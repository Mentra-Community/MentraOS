import Foundation
import Network

enum WhipHeaderProxyError: LocalizedError {
    case invalidPort(UInt16)
    case listenerFailed(UInt16, String)
    case startupTimedOut(UInt16)

    var errorDescription: String? {
        switch self {
        case let .invalidPort(port):
            return "Invalid WHIP proxy port \(port)"
        case let .listenerFailed(port, message):
            return "WHIP proxy failed to listen on port \(port): \(message)"
        case let .startupTimedOut(port):
            return "WHIP proxy did not become ready on port \(port)"
        }
    }
}

final class WhipHeaderProxy {
    private let queue = DispatchQueue(label: "com.mentra.examples.whip-header-proxy")
    private var listener: NWListener?
    private var backendPort: UInt16 = 0

    func start(listenPort: UInt16, backendPort: UInt16) throws {
        stop()

        guard let port = NWEndpoint.Port(rawValue: listenPort) else {
            throw WhipHeaderProxyError.invalidPort(listenPort)
        }

        self.backendPort = backendPort
        let startup = DispatchSemaphore(value: 0)
        var startupError: NWError?

        let listener = try NWListener(using: .tcp, on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.stateUpdateHandler = { state in
            print("[WHIP-PROXY] state=\(state)")
            switch state {
            case .ready:
                startup.signal()
            case let .failed(error), let .waiting(error):
                startupError = error
                startup.signal()
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
                throw WhipHeaderProxyError.listenerFailed(listenPort, startupError.localizedDescription)
            }
        case .timedOut:
            stop()
            throw WhipHeaderProxyError.startupTimedOut(listenPort)
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.stateUpdateHandler = { state in
            if case let .failed(error) = state {
                print("[WHIP-PROXY] connection failed: \(error)")
            }
        }
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let error {
                self.send(status: 400, body: "Proxy receive failed: \(error.localizedDescription)", on: connection)
                return
            }

            var nextBuffer = buffer
            if let data {
                nextBuffer.append(data)
            }

            if let request = HTTPRequest(data: nextBuffer) {
                self.forward(request, on: connection)
            } else if isComplete {
                self.send(status: 400, body: "Incomplete HTTP request", on: connection)
            } else {
                self.receive(on: connection, buffer: nextBuffer)
            }
        }
    }

    private func forward(_ request: HTTPRequest, on connection: NWConnection) {
        guard let url = URL(string: "http://127.0.0.1:\(backendPort)\(request.target)") else {
            send(status: 400, body: "Invalid backend URL", on: connection)
            return
        }

        var backendRequest = URLRequest(url: url)
        backendRequest.httpMethod = request.method
        backendRequest.timeoutInterval = 15
        if !request.body.isEmpty {
            backendRequest.httpBody = request.body
        }

        switch request.method.uppercased() {
        case "POST":
            backendRequest.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        case "PATCH":
            backendRequest.setValue("application/trickle-ice-sdpfrag", forHTTPHeaderField: "Content-Type")
        default:
            break
        }

        print("[WHIP-PROXY] \(request.method) \(request.target) -> \(url)")

        URLSession.shared.dataTask(with: backendRequest) { [weak self] data, response, error in
            guard let self else { return }

            if let error {
                self.send(status: 502, body: "Backend WHIP request failed: \(error.localizedDescription)", on: connection)
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                self.send(status: 502, body: "Backend WHIP response was not HTTP", on: connection)
                return
            }

            self.send(
                status: httpResponse.statusCode,
                headers: httpResponse.allHeaderFields,
                bodyData: data ?? Data(),
                on: connection
            )
        }.resume()
    }

    private func send(status: Int, body: String, on connection: NWConnection) {
        send(status: status, headers: [:], bodyData: Data(body.utf8), on: connection)
    }

    private func send(status: Int, headers: [AnyHashable: Any], bodyData: Data, on connection: NWConnection) {
        var response = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status).capitalized)\r\n"

        for (key, value) in headers {
            let name = String(describing: key)
            let lowerName = name.lowercased()
            guard lowerName != "content-length",
                  lowerName != "transfer-encoding",
                  lowerName != "connection" else {
                continue
            }
            response += "\(name): \(value)\r\n"
        }

        response += "Content-Length: \(bodyData.count)\r\n"
        response += "Connection: close\r\n\r\n"

        var responseData = Data(response.utf8)
        responseData.append(bodyData)

        connection.send(content: responseData, completion: .contentProcessed { error in
            if let error {
                print("[WHIP-PROXY] send failed: \(error)")
            }
            connection.cancel()
        })
    }
}

private struct HTTPRequest {
    let method: String
    let target: String
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

        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            return nil
        }

        let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else {
            return nil
        }

        var contentLength = 0
        for line in lines.dropFirst() {
            let pieces = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard pieces.count == 2 else { continue }
            if pieces[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "content-length" {
                contentLength = Int(pieces[1].trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            }
        }

        let bodyStart = headerRange.upperBound
        guard data.count >= bodyStart + contentLength else {
            return nil
        }

        method = parts[0]
        target = parts[1]
        body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
    }
}
