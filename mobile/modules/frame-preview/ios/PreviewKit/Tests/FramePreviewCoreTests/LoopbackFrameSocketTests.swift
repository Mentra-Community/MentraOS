#if canImport(Network)
  @testable import FramePreviewCore
  import Foundation
  import XCTest

  /// A real `LoopbackFrameSocket` and a real `URLSessionWebSocketTask` client: token auth, a
  /// rejected wrong token, a binary frame and its ack, and a listener reachable on 127.0.0.1 only.
  final class LoopbackFrameSocketTests: XCTestCase {
    private var socket: LoopbackFrameSocket!
    private let session = URLSession(configuration: .ephemeral)

    override func setUp() {
      super.setUp()
      socket = LoopbackFrameSocket()
    }

    override func tearDown() {
      socket.stop()
      session.invalidateAndCancel()
      super.tearDown()
    }

    private func listen(token: String) throws -> URL {
      let ready = expectation(description: "listener ready")
      var url: String?
      socket.start(token: token) { result in
        url = try? result.get()
        ready.fulfill()
      }
      wait(for: [ready], timeout: 5)
      return try XCTUnwrap(url.flatMap(URL.init(string:)))
    }

    private func sendText(_ task: URLSessionWebSocketTask, _ object: [String: Any]) throws {
      let data = try JSONSerialization.data(withJSONObject: object)
      task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    func testTheListenerIsBoundToLoopbackOnly() throws {
      let url = try listen(token: "t")
      XCTAssertEqual(url.host, LoopbackFrameSocket.loopbackHost)
      XCTAssertEqual(url.scheme, "ws")
      XCTAssertEqual(socket.requiredLocalHost, LoopbackFrameSocket.loopbackHost)

      // Reaching the same port through a non-loopback address of this machine must fail.
      guard let port = url.port, let lanAddress = Self.firstNonLoopbackIPv4() else { return }
      let task = session.webSocketTask(with: URL(string: "ws://\(lanAddress):\(port)/preview")!)
      let failed = expectation(description: "non-loopback connection fails")
      task.resume()
      task.receive { result in
        if case .failure = result { failed.fulfill() }
      }
      wait(for: [failed], timeout: 10)
      task.cancel()
    }

    func testTheDocumentTokenAuthenticatesAndFramesAndAcksRoundTrip() throws {
      let url = try listen(token: "document-token")
      let authenticated = expectation(description: "authenticated")
      let acked = expectation(description: "acked")
      var ack: (UInt32, UInt32)?
      socket.onAuthenticated = { authenticated.fulfill() }
      socket.onAck = { gen, seq in
        ack = (gen, seq)
        acked.fulfill()
      }
      let task = session.webSocketTask(with: url)
      task.resume()
      try sendText(task, ["t": "hello", "token": "document-token"])
      wait(for: [authenticated], timeout: 5)

      let frame = Data([0x4D, 0x46, 0x50, 0x56, 1, 2, 3])
      let received = expectation(description: "binary frame received")
      task.receive { result in
        if case let .success(.data(data)) = result, data == frame { received.fulfill() }
      }
      XCTAssertTrue(socket.send(frame) { _ in })
      wait(for: [received], timeout: 5)

      try sendText(task, ["t": "ack", "gen": 5, "seq": 9])
      wait(for: [acked], timeout: 5)
      XCTAssertEqual(ack?.0, 5)
      XCTAssertEqual(ack?.1, 9)
      task.cancel()
    }

    func testAWrongTokenIsRejectedAndReceivesNothing() throws {
      let url = try listen(token: "document-token")
      let rejected = expectation(description: "rejected")
      var detail = ""
      socket.onAuthenticated = { XCTFail("wrong token authenticated") }
      socket.onFailure = { failure, reason in
        if failure == .authFailed {
          detail = reason
          rejected.fulfill()
        }
      }
      let task = session.webSocketTask(with: url)
      task.resume()
      try sendText(task, ["t": "hello", "token": "stale-token"])
      wait(for: [rejected], timeout: 5)
      XCTAssertEqual(detail, "token_mismatch")
      XCTAssertFalse(detail.contains("stale-token"))
      XCTAssertFalse(socket.isAuthenticated)
      XCTAssertFalse(socket.send(Data([1, 2, 3])) { _ in })

      let closed = expectation(description: "server closed the connection")
      task.receive { result in
        if case .failure = result { closed.fulfill() }
      }
      wait(for: [closed], timeout: 5)
    }

    func testRotatingTheTokenDropsTheOldConsumer() throws {
      let url = try listen(token: "first")
      let authenticated = expectation(description: "authenticated")
      socket.onAuthenticated = { authenticated.fulfill() }
      let task = session.webSocketTask(with: url)
      task.resume()
      try sendText(task, ["t": "hello", "token": "first"])
      wait(for: [authenticated], timeout: 5)
      socket.rotateToken("second")
      XCTAssertFalse(socket.isAuthenticated)
      XCTAssertFalse(socket.send(Data([1])) { _ in })
      task.cancel()
    }

    private static func firstNonLoopbackIPv4() -> String? {
      var addresses: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&addresses) == 0, let first = addresses else { return nil }
      defer { freeifaddrs(addresses) }
      var cursor: UnsafeMutablePointer<ifaddrs>? = first
      while let entry = cursor {
        defer { cursor = entry.pointee.ifa_next }
        guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
        let text = String(cString: host)
        if !text.hasPrefix("127.") { return text }
      }
      return nil
    }
  }
#endif
