import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class PcmJitterGateTests: XCTestCase {
    func testDefaultsToHalfASecondAndClampsLikeAndroid() {
        XCTAssertEqual(PcmJitterGate(jitterMs: nil, sampleRate: 24000).jitterMs, 500)
        XCTAssertEqual(PcmJitterGate(jitterMs: nil, sampleRate: 24000).startFrames, 12000)
        XCTAssertEqual(PcmJitterGate(jitterMs: 120, sampleRate: 16000).startFrames, 1920)
        XCTAssertEqual(PcmJitterGate(jitterMs: 0, sampleRate: 16000).jitterMs, 80)
        XCTAssertEqual(PcmJitterGate(jitterMs: 5000, sampleRate: 16000).jitterMs, 500)
    }

    func testStartsOnceTheCushionIsQueued() {
        let gate = PcmJitterGate(jitterMs: 80, sampleRate: 48000) // 3840 frames
        XCTAssertFalse(gate.shouldStart(queuedFrames: 0, closing: false))
        XCTAssertFalse(gate.shouldStart(queuedFrames: 3839, closing: false))
        XCTAssertTrue(gate.shouldStart(queuedFrames: 3840, closing: false))
    }

    func testShortSoundStartsOnClose() {
        let gate = PcmJitterGate(jitterMs: 500, sampleRate: 16000)
        // A 100 ms chime never reaches the 500 ms cushion; closing starts it anyway.
        XCTAssertFalse(gate.shouldStart(queuedFrames: 1600, closing: false))
        XCTAssertTrue(gate.shouldStart(queuedFrames: 1600, closing: true))
        XCTAssertFalse(gate.shouldStart(queuedFrames: 0, closing: true))
    }
}

final class PcmByteCarryTests: XCTestCase {
    func testOddTrailingBytesCarryIntoTheNextChunk() {
        var carry = PcmByteCarry()
        XCTAssertEqual(carry.align(Data([1, 2, 3])), Data([1, 2]))
        XCTAssertTrue(carry.hasPendingByte)
        XCTAssertEqual(carry.align(Data([4])), Data([3, 4]))
        XCTAssertFalse(carry.hasPendingByte)
        XCTAssertEqual(carry.align(Data([5])), Data())
        XCTAssertTrue(carry.hasPendingByte)
        XCTAssertEqual(carry.align(Data([6, 7, 8])), Data([5, 6, 7, 8]))
        XCTAssertFalse(carry.hasPendingByte)
        XCTAssertEqual(carry.align(Data()), Data())
        XCTAssertFalse(carry.hasPendingByte)
    }

    func testEveryAlignedChunkIsWholeSamplesInOrder() {
        var carry = PcmByteCarry()
        let source = Data((0 ..< 101).map { UInt8($0) })
        var output = Data()
        var offset = 0
        for size in [1, 2, 3, 5, 8, 13, 21, 34, 14] {
            let chunk = carry.align(source.subdata(in: offset ..< offset + size))
            XCTAssertTrue(chunk.count.isMultiple(of: 2))
            output.append(chunk)
            offset += size
        }
        XCTAssertEqual(offset, 101)
        XCTAssertEqual(output, source.prefix(100))
        XCTAssertTrue(carry.hasPendingByte)
    }
}

/// Serves canned PCM responses to the loader's URLSession.
private final class StubPcmURLProtocol: URLProtocol {
    struct Script {
        var status = 200
        var contentType = "audio/pcm"
        var chunks: [Data] = []
        var failure: Error?
        /// Leave the response open after the chunks until the task is cancelled.
        var hang = false
    }

    private static let lock = NSLock()
    private static var scripts: [String: Script] = [:]

    static func serve(_ path: String, _ script: Script) -> URL {
        lock.lock()
        scripts[path] = script
        lock.unlock()
        return URL(string: "https://tts.test\(path)")!
    }

    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.lock.lock()
        let script = Self.scripts[request.url?.path ?? ""] ?? Script(status: 404)
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: script.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": script.contentType]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in script.chunks {
            client?.urlProtocol(self, didLoad: chunk)
        }
        if script.hang { return }
        if let failure = script.failure {
            // Like a real connection drop, the failure comes after the bytes already delivered.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { [self] in
                client?.urlProtocol(self, didFailWithError: failure)
            }
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

/// Records what the loader writes; optionally holds writes to simulate a full player.
private final class RecordingSink: PcmStreamSink, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var writeSizes: [Int] = []
    private var closes = 0
    private var aborts = 0
    private var holdWrites: DispatchSemaphore?
    var onWrite: (() -> Void)?

    init(holdWrites: DispatchSemaphore? = nil) {
        self.holdWrites = holdWrites
    }

    var written: Data {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }

    var sizes: [Int] {
        lock.lock()
        defer { lock.unlock() }
        return writeSizes
    }

    var closeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return closes
    }

    func write(data: Data) async throws -> Int64 {
        XCTAssertTrue(data.count.isMultiple(of: 2), "Writes must be whole s16le samples")
        lock.lock()
        bytes.append(data)
        writeSizes.append(data.count)
        let hold = holdWrites
        holdWrites = nil
        let callback = onWrite
        lock.unlock()
        callback?()
        if let hold {
            // Backpressure: the first write waits until the test releases it.
            await withCheckedContinuation { continuation in
                DispatchQueue.global().async {
                    hold.wait()
                    continuation.resume()
                }
            }
        }
        return 0
    }

    func close() async throws -> Int64 {
        lock.lock()
        closes += 1
        let duration = Int64(bytes.count / 2) * 1000 / 24000
        lock.unlock()
        return duration
    }

    func abort() async {
        lock.lock()
        aborts += 1
        lock.unlock()
    }
}

final class PcmUrlPlaybackTests: XCTestCase {
    private func makeLoader(highWaterBytes: Int = PcmUrlLoader.defaultHighWaterBytes) -> PcmUrlLoader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubPcmURLProtocol.self]
        return PcmUrlLoader(configuration: configuration, highWaterBytes: highWaterBytes)
    }

    func testOddSizedChunksArriveAsWholeSamplesAndResolveAfterClose() async throws {
        let body = Data((0 ..< 4800).map { UInt8(truncatingIfNeeded: $0 * 31) })
        var chunks: [Data] = []
        var offset = 0
        for size in [1, 3, 777, 1, 1024, 2, 999] where offset < body.count {
            chunks.append(body.subdata(in: offset ..< min(body.count, offset + size)))
            offset += size
        }
        chunks.append(body.subdata(in: offset ..< body.count))
        let url = StubPcmURLProtocol.serve("/odd", .init(chunks: chunks))
        let sink = RecordingSink()
        let playback = makeLoader().start(url: url, sink: sink)
        let duration = try await playback.wait()
        XCTAssertEqual(sink.written, body)
        XCTAssertTrue(sink.sizes.allSatisfy { $0.isMultiple(of: 2) })
        XCTAssertEqual(sink.closeCount, 1)
        XCTAssertEqual(duration, 100) // 2400 samples at 24 kHz
    }

    func testTrailingHalfSampleIsDropped() async throws {
        let url = StubPcmURLProtocol.serve("/trailing", .init(chunks: [Data([1, 2, 3]), Data([4, 5, 6, 7])]))
        let sink = RecordingSink()
        _ = try await makeLoader().start(url: url, sink: sink).wait()
        XCTAssertEqual(sink.written, Data([1, 2, 3, 4, 5, 6]))
    }

    func testNon2xxRejectsWithoutPlaying() async {
        let url = StubPcmURLProtocol.serve("/unavailable", .init(status: 503, chunks: [Data([1, 2, 3, 4])]))
        let sink = RecordingSink()
        do {
            _ = try await makeLoader().start(url: url, sink: sink).wait()
            XCTFail("Expected an HTTP failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("HTTP 503"), error.localizedDescription)
        }
        XCTAssertTrue(sink.written.isEmpty)
        XCTAssertEqual(sink.closeCount, 0)
    }

    func testCompressedAudioIsRejectedInsteadOfPlayedAsNoise() async {
        let url = StubPcmURLProtocol.serve("/mp3", .init(contentType: "audio/mpeg", chunks: [Data([0xFF, 0xFB, 0x90, 0x00])]))
        let sink = RecordingSink()
        do {
            _ = try await makeLoader().start(url: url, sink: sink).wait()
            XCTFail("Expected an MP3 body to be rejected")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("audio/mpeg"), error.localizedDescription)
        }
        XCTAssertTrue(sink.written.isEmpty)
    }

    func testDroppedConnectionPlaysWhatArrivedThenRejects() async {
        let failure = URLError(.networkConnectionLost)
        let url = StubPcmURLProtocol.serve("/dropped", .init(chunks: [Data([1, 2, 3, 4, 5])], failure: failure))
        let sink = RecordingSink()
        do {
            _ = try await makeLoader().start(url: url, sink: sink).wait()
            XCTFail("Expected the dropped connection to reject")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("download failed"), error.localizedDescription)
        }
        XCTAssertEqual(sink.written, Data([1, 2, 3, 4]))
        XCTAssertEqual(sink.closeCount, 1, "What arrived plays out before the error")
    }

    func testCancelRejectsWithAborted() async {
        let url = StubPcmURLProtocol.serve("/hang", .init(chunks: [Data([1, 2])], hang: true))
        let firstWrite = expectation(description: "first write")
        let sink = RecordingSink()
        sink.onWrite = { firstWrite.fulfill() }
        let playback = makeLoader().start(url: url, sink: sink)
        await fulfillment(of: [firstWrite], timeout: 5)
        playback.cancel()
        do {
            _ = try await playback.wait()
            XCTFail("Expected aborted")
        } catch {
            XCTAssertEqual(error as? PcmStreamError, .aborted)
            XCTAssertEqual(error.localizedDescription, "aborted")
        }
        XCTAssertEqual(sink.closeCount, 0)
    }

    func testSlowSinkPausesTheTransferAndKeepsOrder() async throws {
        let body = Data((0 ..< 400).map { UInt8(truncatingIfNeeded: $0) })
        let chunks = stride(from: 0, to: body.count, by: 10).map { body.subdata(in: $0 ..< min(body.count, $0 + 10)) }
        let url = StubPcmURLProtocol.serve("/slow", .init(chunks: chunks))
        let release = DispatchSemaphore(value: 0)
        let sink = RecordingSink(holdWrites: release)
        let loader = makeLoader(highWaterBytes: 32)
        let playback = loader.start(url: url, sink: sink)
        // While the first write is held, arriving audio passes the high-water mark.
        let paused = expectation(description: "transfer paused")
        func poll() {
            loader.queue.asyncAfter(deadline: .now() + 0.01) {
                if playback.suspensions > 0 { paused.fulfill() } else { poll() }
            }
        }
        poll()
        await fulfillment(of: [paused], timeout: 5)
        release.signal()
        _ = try await playback.wait()
        XCTAssertEqual(sink.written, body)
    }
}
