import Foundation
@testable import GlassesMediaCore
import XCTest

final class WhipTests: XCTestCase {
    private let offer = "v=0\r\na=candidate:1 1 udp 1 192.168.43.1 4000 typ host\r\n"

    func testBridgeAcceptsSoftApAndRequiresConcreteLocalAddress() throws {
        let config = try SourceConfig.fromBridge(["type": "softap", "bindAddress": "192.168.43.2"], legacyWhepUrl: "")
        XCTAssertEqual(config.kind, .softap)
        XCTAssertEqual(config.bindAddress, "192.168.43.2")
        XCTAssertThrowsError(try SourceConfig.fromBridge(["type": "softap"], legacyWhepUrl: "https://legacy/whep"))
        XCTAssertThrowsError(try SourceConfig.fromBridge(["type": "softap", "bindAddress": "0.0.0.0"], legacyWhepUrl: nil))
    }

    func testBridgePreservesLegacyWhepAndExplicitSource() throws {
        XCTAssertEqual(try SourceConfig.fromBridge(nil, legacyWhepUrl: "https://legacy/whep").url, "https://legacy/whep")
        XCTAssertEqual(try SourceConfig.fromBridge(["type": "whep"], legacyWhepUrl: "https://legacy/whep").url, "https://legacy/whep")
        XCTAssertEqual(try SourceConfig.fromBridge(["type": "whep", "url": "https://new/whep"], legacyWhepUrl: "https://legacy/whep").url, "https://new/whep")
    }

    func testBridgeRejectsUnsupportedOrMissingSource() {
        XCTAssertThrowsError(try SourceConfig.fromBridge(nil, legacyWhepUrl: " "))
        XCTAssertThrowsError(try SourceConfig.fromBridge(["type": "unknown"], legacyWhepUrl: "https://legacy/whep"))
    }

    func testFragmentedOfferAndCaseInsensitiveHeaders() throws {
        let request = "POST /whip HTTP/1.1\r\ncOnTeNt-LeNgTh: \(offer.utf8.count)\r\nContent-Type: application/sdp\r\n\r\n\(offer)"
        for count in 0 ..< request.utf8.count {
            XCTAssertNil(try WhipRequest.parse(Data(request.utf8.prefix(count))))
        }
        let result = try XCTUnwrap(WhipRequest.parse(Data(request.utf8)))
        XCTAssertEqual(result.body, offer)
        XCTAssertEqual(result.contentType, "application/sdp")
    }

    func testRejectsAmbiguousAndUnboundedRequests() {
        for header in ["Content-Length: -1", "Content-Length: 9999999", "Content-Length: 0\r\ncontent-length: 1", "Transfer-Encoding: chunked", "", "Content-Length: no"] {
            XCTAssertThrowsError(try WhipRequest.parse(Data("POST /whip HTTP/1.1\r\n\(header)\r\n\r\n".utf8)), header)
        }
        XCTAssertThrowsError(try WhipRequest.parse(Data(repeating: 65, count: WhipRequest.maxHeaderBytes + 1)))
    }

    func testSdpUsesRealHotspotCandidatesOnly() throws {
        let candidates = offer + "a=candidate:2 1 udp 1 10.20.30.40 4001 typ host\r\na=candidate:3 1 udp 1 192.168.43.2 4002 typ host\r\na=candidate:4 1 udp 1 1.2.3.4 4003 typ srflx\r\n"
        let answer = try LocalMediaPolicy.localSdp(candidates, address: "192.168.43.2", answer: true)
        XCTAssertTrue(answer.contains("192.168.43.2"))
        XCTAssertFalse(answer.contains("192.168.43.1"))
        XCTAssertFalse(answer.contains("10.20.30.40"))
        XCTAssertFalse(answer.contains("srflx"))
        XCTAssertThrowsError(try LocalMediaPolicy.localSdp(offer, address: "192.168.43.2", answer: true))
        XCTAssertNoThrow(try LocalMediaPolicy.localSdp(offer, address: "192.168.43.2", answer: false))
        XCTAssertThrowsError(try LocalMediaPolicy.localSdp(offer, address: "8.8.8.8", answer: false))
    }

    func testSubnetNeverAcceptsMalformedOrUnrelatedAddresses() {
        XCTAssertTrue(LocalMediaPolicy.sameSubnet("192.168.43.1", "192.168.43.55"))
        for ip in ["192.168.44.1", "192.168.43.256", "192.168..43.1", "fe80::1", "host.local"] {
            XCTAssertFalse(LocalMediaPolicy.sameSubnet("192.168.43.1", ip))
        }
    }

    func testHotspotAddressWaitsForDhcpAfterSsidAssociation() {
        // The reported incident associated the glasses SSID while en0 still had the home-router IP.
        let addresses = ["192.168.1.10", "169.254.1.10", "192.168.43.142"]
        XCTAssertEqual(addresses.filter { LocalMediaPolicy.isHotspotClientAddress($0, gateway: "192.168.43.1") }, ["192.168.43.142"])
        XCTAssertTrue(LocalMediaPolicy.isHotspotClientAddress("10.5.6.8", gateway: "10.5.6.1"))
        for address in ["192.168.43.1", "192.168.43.0", "192.168.43.255", "192.168.43.256", "host.local"] {
            XCTAssertFalse(LocalMediaPolicy.isHotspotClientAddress(address, gateway: "192.168.43.1"), address)
        }
        XCTAssertFalse(LocalMediaPolicy.isHotspotClientAddress("8.8.8.2", gateway: "8.8.8.1"))
    }

    func testListenerLifecycleAndSinglePublisher() async throws {
        let server = WhipIngestServer(negotiate: { _, reply in reply(.success("answer")) }, terminate: {}, publisherFailed: { false })
        let url = try await start(server)
        let first = try await request(url, method: "POST", body: offer)
        XCTAssertEqual(first.1.statusCode, 201)
        XCTAssertEqual(String(data: first.0, encoding: .utf8), "answer")
        let location = try XCTUnwrap(first.1.value(forHTTPHeaderField: "Location"))
        let conflict = try await request(url, method: "POST", body: offer)
        XCTAssertEqual(conflict.1.statusCode, 409)
        let wrongDelete = try await request(url + "/old-session", method: "DELETE")
        XCTAssertEqual(wrongDelete.1.statusCode, 404)
        let deleted = try await request(location, method: "DELETE")
        XCTAssertEqual(deleted.1.statusCode, 204)
        let next = try await request(url, method: "POST", body: offer)
        XCTAssertEqual(next.1.statusCode, 201)
        await stop(server)
        do { _ = try await request(url, method: "POST", body: offer); XCTFail("Stopped listener still accepted a publisher") } catch {}
    }

    func testStopDuringNegotiationCannotReturnSuccess() async throws {
        let received = expectation(description: "offer")
        let pending = LockedReply()
        let server = WhipIngestServer(negotiate: { _, reply in pending.set(reply); received.fulfill() }, terminate: {}, publisherFailed: { false })
        let url = try await start(server)
        let response = Task { try await self.request(url, method: "POST", body: self.offer) }
        await fulfillment(of: [received], timeout: 3)
        await stop(server)
        pending.finish(.success("stale answer"))
        let result = try await response.value
        XCTAssertEqual(result.1.statusCode, 410)
    }

    func testNegotiationFailureFreesPublisherSlot() async throws {
        let server = WhipIngestServer(negotiate: { _, reply in reply(.failure(LocalMediaError("bad ICE"))) }, terminate: {}, publisherFailed: { false })
        let url = try await start(server)
        for _ in 0 ..< 2 {
            let response = try await request(url, method: "POST", body: offer)
            XCTAssertEqual(response.1.statusCode, 500)
        }
        await stop(server)
    }

    func testPendingListenerStartupIsCancelled() async {
        let server = WhipIngestServer(negotiate: { _, _ in }, terminate: {}, publisherFailed: { false })
        let finished = expectation(description: "start settled")
        server.start(address: "192.0.2.1", wifiOnly: false) { _ in finished.fulfill() }
        await stop(server)
        await fulfillment(of: [finished], timeout: 3)
    }

    private func start(_ server: WhipIngestServer) async throws -> String {
        try await withCheckedThrowingContinuation { reply in server.start(address: "127.0.0.1", wifiOnly: false) { reply.resume(with: $0) } }
    }

    private func stop(_ server: WhipIngestServer) async {
        await withCheckedContinuation { reply in server.stop { reply.resume() } }
    }

    private func request(_ url: String, method: String, body: String = "") async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        if method == "POST" { request.httpBody = Data(body.utf8) }
        let (data, response) = try await URLSession.shared.data(for: request)
        return try (data, XCTUnwrap(response as? HTTPURLResponse))
    }
}

private final class LockedReply {
    private let lock = NSLock()
    private var reply: ((Result<String, Error>) -> Void)?
    func set(_ callback: @escaping (Result<String, Error>) -> Void) {
        lock.lock(); reply = callback; lock.unlock()
    }

    func finish(_ result: Result<String, Error>) {
        lock.lock(); let callback = reply; lock.unlock(); callback?(result)
    }
}
