import Foundation
import Network

/// One local publisher, bounded requests, and no HTTP/media work on the UI thread.
/// The consumer owns negotiation; this server never imports WebRTC or a publisher SDK.
public final class WhipIngestServer {
    public typealias Negotiator = (String, @escaping (Result<String, Error>) -> Void) -> Void
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.whip.http")
    private let negotiate: Negotiator
    private let terminate: () -> Void
    private let publisherFailed: () -> Bool
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var session: String?
    private var endpoint = ""
    private var generation = 0
    private var ready: ((Result<String, Error>) -> Void)?

    public init(negotiate: @escaping Negotiator, terminate: @escaping () -> Void, publisherFailed: @escaping () -> Bool) {
        self.negotiate = negotiate
        self.terminate = terminate
        self.publisherFailed = publisherFailed
    }

    public func start(address: String, wifiOnly: Bool = true, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            guard self.listener == nil else { completion(.failure(LocalMediaError("Listener already started"))); return }
            do {
                let parameters = NWParameters.tcp
                if wifiOnly { parameters.requiredInterfaceType = .wifi }
                parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(address), port: .any)
                let listener = try NWListener(using: parameters)
                self.generation += 1
                let gen = self.generation
                self.listener = listener
                self.ready = completion
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self, gen == self.generation else { return }
                    switch state {
                    case .ready:
                        guard let port = listener.port else { return }
                        self.endpoint = "http://\(address):\(port.rawValue)/whip"
                        self.finishReady(.success(self.endpoint))
                    case let .failed(error):
                        self.finishReady(.failure(error))
                        self.stopLocked()
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.accept(connection, generation: gen) }
                listener.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 10) { [weak self] in
                    guard let self, gen == self.generation, self.ready != nil else { return }
                    self.finishReady(.failure(LocalMediaError("Local listener startup timed out")))
                    self.stopLocked()
                }
            } catch { completion(.failure(error)) }
        }
    }

    /// Completion is a barrier: no pending offer can install a peer after this point.
    public func stop(completion: @escaping () -> Void = {}) {
        queue.async { self.stopLocked(); completion() }
    }

    private func finishReady(_ result: Result<String, Error>) {
        let callback = ready
        ready = nil
        callback?(result)
    }

    private func stopLocked() {
        generation += 1
        finishReady(.failure(LocalMediaError("Listener cancelled")))
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
        listener = nil
        session = nil
        endpoint = ""
        for id in Array(connections.keys) {
            reply(id, status: 410)
        }
        terminate()
    }

    private func accept(_ connection: NWConnection, generation gen: Int) {
        guard gen == generation, listener != nil, connections.count < 4 else { connection.cancel(); return }
        let id = UUID()
        connections[id] = connection
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 12) { [weak self] in self?.reply(id, status: 408) }
        receive(id, data: Data(), generation: gen)
    }

    private func receive(_ id: UUID, data: Data, generation gen: Int) {
        guard let connection = connections[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] bytes, _, complete, error in
            guard let self, gen == self.generation, self.connections[id] != nil else { return }
            var data = data
            if let bytes { data.append(bytes) }
            do {
                if let request = try WhipRequest.parse(data) {
                    self.handle(id, request: request, generation: gen)
                } else if complete || error != nil {
                    self.reply(id, status: 400)
                } else { self.receive(id, data: data, generation: gen) }
            } catch { self.reply(id, status: 400, body: error.localizedDescription) }
        }
    }

    private func handle(_ id: UUID, request: WhipRequest, generation gen: Int) {
        if request.path == "/whip" || request.path == "/whip/" {
            guard request.method == "POST" else { reply(id, status: 405, headers: ["Allow": "POST"]); return }
            guard request.contentType == "application/sdp" else { reply(id, status: 415); return }
            guard !request.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { reply(id, status: 400); return }
            if session != nil, publisherFailed() { session = nil; terminate() }
            guard session == nil else { reply(id, status: 409); return }
            let next = UUID().uuidString
            session = next
            negotiate(request.body) { [weak self] result in
                self?.queue.async {
                    guard let self, gen == self.generation, self.session == next else { return }
                    switch result {
                    case let .success(answer):
                        self.reply(id, status: 201, body: answer, headers: ["Content-Type": "application/sdp", "Location": "\(self.endpoint)/\(next)"])
                    case let .failure(error):
                        self.session = nil
                        self.reply(id, status: 500, body: error.localizedDescription)
                    }
                }
            }
        } else if let session, request.path == "/whip/\(session)" {
            guard request.method == "DELETE" else { reply(id, status: 405, headers: ["Allow": "DELETE"]); return }
            self.session = nil
            terminate()
            reply(id, status: 204)
        } else { reply(id, status: 404) }
    }

    private func reply(_ id: UUID, status: Int, body: String = "", headers: [String: String] = [:]) {
        guard let connection = connections.removeValue(forKey: id) else { return }
        connection.send(content: WhipRequest.response(status, body: body, headers: headers), completion: .contentProcessed { _ in connection.cancel() })
    }
}
