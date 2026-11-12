import Foundation
import Network

/// A one-route HTTP server on 127.0.0.1 that answers every request with a 302 to `location`.
final class RedirectServer {
    let url: URL
    private let listener: NWListener
    private let queue = DispatchQueue(label: "RedirectServer")

    init(location: String) throws {
        listener = try NWListener(using: .tcp, on: .any)
        let response = "HTTP/1.1 302 Found\r\nLocation: \(location)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port?.rawValue else {
            throw URLError(.cannotConnectToHost)
        }
        url = URL(string: "http://127.0.0.1:\(port)/credentials")!
    }

    func stop() {
        listener.cancel()
    }
}
