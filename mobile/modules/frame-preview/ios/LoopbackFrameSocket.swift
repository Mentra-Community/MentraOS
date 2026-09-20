import Foundation
import Network

/// Loopback WebSocket that carries binary preview frames into the miniapp's WKWebView.
///
/// WKWebView gives a native host no way to hand a page an `ArrayBuffer` directly: the message
/// handler bridge is JSON, and base64 over that bridge would cost a 1.4 MB string per frame plus
/// a decode. A loopback socket is the cheapest path that the page can consume as binary, and it
/// works identically for the installed `file://` page and the `http://` dev page.
///
/// It is deliberately narrow: bound to 127.0.0.1 on an ephemeral port, one connection at a time,
/// and nothing is sent until the page proves it holds the per-document token. Failure reasons are
/// kept distinct because "it did not work" has at least four very different causes here — the
/// listener never bound, the page never connected (App Transport Security or a mixed-content
/// rule), the page connected with the wrong token, or the page went away.
public final class LoopbackFrameSocket {
  public enum Failure: String {
    case listenerFailed = "listener_failed"
    case authFailed = "auth_failed"
    case connectionClosed = "connection_closed"
    case sendFailed = "send_failed"
  }

  public var onAuthenticated: (() -> Void)?
  public var onAck: ((UInt32, UInt32) -> Void)?
  public var onFailure: ((Failure, String) -> Void)?

  private let queue = DispatchQueue(label: "com.mentra.framepreview.socket")
  private var listener: NWListener?
  private var connection: NWConnection?
  private var token: String = ""
  private var authenticated = false
  private var generation = 0
  /// One send at a time. Network framework will happily buffer, which would defeat the whole
  /// point of the one-frame credit above it.
  private var sending = false

  public private(set) var url: String?

  public init() {}

  /// Bind the listener. `completion` carries the `ws://` URL the page must connect to.
  public func start(token: String, completion: @escaping (Result<String, Error>) -> Void) {
    queue.async {
      self.token = token
      if let url = self.url, self.listener != nil {
        completion(.success(url))
        return
      }
      self.generation += 1
      let generation = self.generation
      do {
        let parameters = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        // Loopback only. Not a convenience: an all-interfaces bind would put raw camera frames
        // on whatever network the phone is attached to, which during a call is the glasses hotspot.
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = false
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)

        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
          guard let self, generation == self.generation else { return }
          switch state {
          case .ready:
            guard let port = listener.port else { return }
            let url = "ws://127.0.0.1:\(port.rawValue)/preview"
            self.url = url
            NSLog("FRAME-PREVIEW ios listener ready url=\(url)")
            completion(.success(url))
          case let .failed(error):
            NSLog("FRAME-PREVIEW ios listener failed: \(error)")
            self.onFailure?(.listenerFailed, "\(error)")
            completion(.failure(error))
            self.stopLocked()
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          self?.accept(connection, generation: generation)
        }
        listener.start(queue: self.queue)
      } catch {
        NSLog("FRAME-PREVIEW ios listener bind threw: \(error)")
        self.onFailure?(.listenerFailed, "\(error)")
        completion(.failure(error))
      }
    }
  }

  /// A new document invalidates the old page's credential. Any live connection is dropped so a
  /// stale document cannot keep receiving frames the new one is paying for.
  public func rotateToken(_ token: String) {
    queue.async {
      self.token = token
      self.authenticated = false
      self.connection?.cancel()
      self.connection = nil
    }
  }

  public func stop() {
    queue.async { self.stopLocked() }
  }

  public var isAuthenticated: Bool {
    queue.sync { authenticated }
  }

  /// Send one frame. Returns false when there is no authenticated consumer or a send is already
  /// in flight, so the caller can count the skip rather than queue.
  @discardableResult
  public func send(_ payload: Data, completion: @escaping (Bool) -> Void) -> Bool {
    var accepted = false
    queue.sync {
      guard authenticated, let connection, !sending else { return }
      sending = true
      accepted = true
      let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
      let context = NWConnection.ContentContext(identifier: "previewFrame", metadata: [metadata])
      connection.send(
        content: payload, contentContext: context, isComplete: true,
        completion: .contentProcessed { [weak self] error in
          // Hold the bytes until Network framework says it is finished with them. "send returned"
          // is not the same as "the copy completed", and reusing the buffer before this fires
          // would tear frames.
          withExtendedLifetime(payload) {}
          guard let self else { return }
          self.queue.async {
            self.sending = false
            if let error {
              self.onFailure?(.sendFailed, "\(error)")
              completion(false)
            } else {
              completion(true)
            }
          }
        }
      )
    }
    return accepted
  }

  private func stopLocked() {
    generation += 1
    authenticated = false
    sending = false
    url = nil
    connection?.cancel()
    connection = nil
    listener?.stateUpdateHandler = nil
    listener?.newConnectionHandler = nil
    listener?.cancel()
    listener = nil
  }

  private func accept(_ incoming: NWConnection, generation: Int) {
    guard generation == self.generation else { incoming.cancel(); return }
    // A page reload produces a fresh connection while the old one is still half-open; the newest
    // one wins rather than being refused.
    connection?.cancel()
    authenticated = false
    sending = false
    connection = incoming
    incoming.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      self.queue.async {
        guard self.connection === incoming else { return }
        switch state {
        case .ready:
          self.receive(on: incoming, generation: generation)
        case let .failed(error):
          self.onFailure?(.connectionClosed, "\(error)")
          self.clear(incoming)
        case .cancelled:
          self.clear(incoming)
        default:
          break
        }
      }
    }
    incoming.start(queue: queue)
  }

  private func clear(_ closed: NWConnection) {
    guard connection === closed else { return }
    connection = nil
    authenticated = false
    sending = false
  }

  private func receive(on connection: NWConnection, generation: Int) {
    connection.receiveMessage { [weak self] content, context, _, error in
      guard let self else { return }
      self.queue.async {
        guard generation == self.generation, self.connection === connection else { return }
        if let error {
          self.onFailure?(.connectionClosed, "\(error)")
          self.clear(connection)
          return
        }
        let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
        if metadata?.opcode == .close {
          self.clear(connection)
          return
        }
        if metadata?.opcode == .text, let content, let text = String(data: content, encoding: .utf8) {
          self.handle(text: text, on: connection)
        }
        self.receive(on: connection, generation: generation)
      }
    }
  }

  private func handle(text: String, on connection: NWConnection) {
    guard let data = text.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let kind = object["t"] as? String
    else { return }

    switch kind {
    case "hello":
      guard let supplied = object["token"] as? String, !token.isEmpty, supplied == token else {
        NSLog("FRAME-PREVIEW ios hello rejected: token mismatch")
        onFailure?(.authFailed, "token mismatch")
        connection.cancel()
        clear(connection)
        return
      }
      authenticated = true
      NSLog("FRAME-PREVIEW ios consumer authenticated")
      onAuthenticated?()
    case "ack":
      guard let generation = object["gen"] as? NSNumber, let sequence = object["seq"] as? NSNumber else { return }
      onAck?(generation.uint32Value, sequence.uint32Value)
    default:
      break
    }
  }
}
