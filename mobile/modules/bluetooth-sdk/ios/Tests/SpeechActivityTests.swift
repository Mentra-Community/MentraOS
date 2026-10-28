import Foundation
@testable import MentraBluetoothSDK
import XCTest

/// Stands in for Silero: speech is any frame with a loud sample, and like Silero it keeps
/// reporting speech until it has heard `minSilenceMs` of quiet.
private final class FakeSpeechClassifier: SpeechActivityClassifier {
    let minSilenceFrames: Int
    private(set) var frames: [[Float]] = []
    private var quietFrames = 0
    private var speaking = false

    init(minSilenceMs: Int) {
        minSilenceFrames = max(1, Int((Double(minSilenceMs) / 32.0).rounded(.up)))
    }

    func isSpeech(afterAccepting frame: [Float]) -> Bool {
        frames.append(frame)
        if frame.contains(where: { abs($0) > 0.1 }) {
            speaking = true
            quietFrames = 0
        } else if speaking {
            quietFrames += 1
            if quietFrames >= minSilenceFrames { speaking = false }
        }
        return speaking
    }
}

private func pcm(samples: [Int16]) -> Data {
    var data = Data(capacity: samples.count * 2)
    for sample in samples {
        let bits = UInt16(bitPattern: sample)
        data.append(UInt8(bits & 0xFF))
        data.append(UInt8(bits >> 8))
    }
    return data
}

private func loud(_ count: Int) -> Data {
    pcm(samples: (0 ..< count).map { $0.isMultiple(of: 2) ? 16000 : -16000 })
}

private func quiet(_ count: Int) -> Data {
    pcm(samples: [Int16](repeating: 0, count: count))
}

final class SpeechActivityTrackerTests: XCTestCase {
    func testChunksOfAnySizeAreFullyAnalyzedInWholeFrames() {
        let classifier = FakeSpeechClassifier(minSilenceMs: 300)
        let tracker = SpeechActivityTracker(classifier: classifier)
        let samples = (0 ..< 5000).map { Int16(truncatingIfNeeded: $0 * 7 - 9000) }
        let bytes = pcm(samples: samples)
        // Odd byte counts split samples across chunks; none of the sizes divide 512 samples.
        let chunkSizes = [1, 3, 7, 160, 333, 1023, 2, 999, 1, 640]
        var offset = 0
        var index = 0
        while offset < bytes.count {
            let size = min(chunkSizes[index % chunkSizes.count], bytes.count - offset)
            _ = tracker.accept(bytes.subdata(in: offset ..< offset + size), nowMs: 0)
            offset += size
            index += 1
        }
        let wholeFrames = samples.count / SpeechActivityTracker.frameSamples
        XCTAssertEqual(classifier.frames.count, wholeFrames)
        XCTAssertTrue(classifier.frames.allSatisfy { $0.count == SpeechActivityTracker.frameSamples })
        XCTAssertEqual(tracker.analyzedSamples, Int64(wholeFrames * SpeechActivityTracker.frameSamples))
        let analyzed = classifier.frames.flatMap { $0 }
        let expected = samples.prefix(analyzed.count).map { Float($0) / 32768 }
        XCTAssertEqual(analyzed, Array(expected))
    }

    func testReportsEachTransitionOnce() {
        let classifier = FakeSpeechClassifier(minSilenceMs: 300)
        let tracker = SpeechActivityTracker(classifier: classifier, minSilenceMs: 300)
        var transitions = tracker.accept(loud(512 * 10), nowMs: 0)
        transitions += tracker.accept(loud(512 * 10), nowMs: 320)
        XCTAssertEqual(transitions, [SpeechActivityTransition(speaking: true, silentForMs: 0)])
        transitions = tracker.accept(quiet(512 * 30), nowMs: 1300)
        XCTAssertEqual(transitions, [SpeechActivityTransition(speaking: false, silentForMs: 300)])
        XCTAssertFalse(tracker.speaking)
        XCTAssertEqual(tracker.accept(quiet(512 * 30), nowMs: 2300), [])
    }

    func testSpeechToSilenceIsReportedWithinTheConfiguredGap() {
        let minSilenceMs = 300
        let classifier = FakeSpeechClassifier(minSilenceMs: minSilenceMs)
        let tracker = SpeechActivityTracker(classifier: classifier, minSilenceMs: minSilenceMs)
        _ = tracker.accept(loud(512 * 4), nowMs: 0)
        XCTAssertTrue(tracker.speaking)
        // Feed real quiet audio one frame at a time and note when silence is reported.
        var quietMs = 0
        var reported: SpeechActivityTransition?
        for _ in 0 ..< 100 {
            let transitions = tracker.accept(quiet(512), nowMs: Int64(quietMs))
            quietMs += 32
            if let transition = transitions.first {
                reported = transition
                break
            }
        }
        XCTAssertEqual(reported, SpeechActivityTransition(speaking: false, silentForMs: minSilenceMs))
        XCTAssertGreaterThanOrEqual(quietMs, minSilenceMs)
        XCTAssertLessThanOrEqual(quietMs, minSilenceMs + 32)
    }

    func testAudioThatStopsMidSessionIsFilledWithSilenceInRealTime() throws {
        let minSilenceMs = 300
        let classifier = FakeSpeechClassifier(minSilenceMs: minSilenceMs)
        let tracker = SpeechActivityTracker(classifier: classifier, minSilenceMs: minSilenceMs)
        // 0.5 s of speech plus a partial frame, then the loudness gate stops sending audio.
        XCTAssertEqual(tracker.accept(loud(8000 + 100), nowMs: 1000), [SpeechActivityTransition(speaking: true, silentForMs: 0)])
        XCTAssertTrue(tracker.needsGapFill)
        XCTAssertEqual(tracker.nextGapFillDueMs(nowMs: 1000), 1100)

        // Under the 100 ms gap threshold: nothing is filled.
        XCTAssertEqual(tracker.fillGap(nowMs: 1099), [])
        XCTAssertEqual(tracker.filledSamples, 0)

        // From then on silence is fed for the elapsed time, never ahead of the clock.
        var now: Int64 = 1100
        var silentAt: Int64?
        while now < 3000, silentAt == nil {
            let transitions = tracker.fillGap(nowMs: now)
            XCTAssertLessThanOrEqual(tracker.filledSamples, (now - 1000) * 16)
            if transitions == [SpeechActivityTransition(speaking: false, silentForMs: minSilenceMs)] {
                silentAt = now
            } else {
                XCTAssertEqual(transitions, [])
            }
            now += 32
        }
        let reportedAt = try XCTUnwrap(silentAt)
        // Silence is reported once `minSilenceMs` of gap has been fed, give or take a frame.
        XCTAssertGreaterThanOrEqual(reportedAt - 1000, Int64(minSilenceMs))
        XCTAssertLessThanOrEqual(reportedAt - 1000, Int64(minSilenceMs + 64))
        XCTAssertTrue(classifier.frames.allSatisfy { $0.count == SpeechActivityTracker.frameSamples })

        // Once silent, a silent detector needs no more filling.
        XCTAssertFalse(tracker.needsGapFill)
        XCTAssertNil(tracker.nextGapFillDueMs(nowMs: now))
        let filled = tracker.filledSamples
        XCTAssertEqual(tracker.fillGap(nowMs: now + 5000), [])
        XCTAssertEqual(tracker.filledSamples, filled)

        // Audio resuming is analyzed normally again.
        XCTAssertEqual(tracker.accept(loud(1024), nowMs: now + 6000), [SpeechActivityTransition(speaking: true, silentForMs: 0)])
    }

    func testNoAudioYetMeansNoGapFill() {
        let tracker = SpeechActivityTracker(classifier: FakeSpeechClassifier(minSilenceMs: 300))
        XCTAssertFalse(tracker.needsGapFill)
        XCTAssertEqual(tracker.fillGap(nowMs: 10000), [])
        XCTAssertEqual(tracker.analyzedSamples, 0)
    }
}

final class SpeechActivityMonitorTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [SpeechActivityMonitor.Event] = []
        var events: [SpeechActivityMonitor.Event] {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }

        func append(_ event: SpeechActivityMonitor.Event) {
            lock.lock()
            stored.append(event)
            lock.unlock()
        }
    }

    func testEnablingLoadsTheModelAndDisablingReleasesIt() async throws {
        weak var created: FakeSpeechClassifier?
        var requestedSilence: [Int] = []
        let recorder = Recorder()
        let monitor = SpeechActivityMonitor(makeClassifier: { minSilenceMs in
            requestedSilence.append(minSilenceMs)
            let classifier = FakeSpeechClassifier(minSilenceMs: minSilenceMs)
            created = classifier
            return classifier
        }, emit: recorder.append)

        XCTAssertFalse(monitor.hasClassifier())
        try await monitor.setEnabled(true, minSilenceMs: nil)
        XCTAssertEqual(requestedSilence, [SpeechActivityTracker.defaultMinSilenceMs])
        XCTAssertTrue(monitor.hasClassifier())
        XCTAssertNotNil(created)

        try await monitor.setEnabled(true, minSilenceMs: 1250)
        XCTAssertEqual(requestedSilence, [300, 1250])

        try await monitor.setEnabled(false, minSilenceMs: nil)
        XCTAssertFalse(monitor.isEnabled)
        XCTAssertFalse(monitor.hasClassifier())
        XCTAssertNil(created, "Disabling must release the model")

        monitor.accept(loud(4096))
        XCTAssertFalse(monitor.hasClassifier())
        XCTAssertTrue(recorder.events.isEmpty)
    }

    func testEnablingFailsWhenTheModelIsUnavailable() async {
        let monitor = SpeechActivityMonitor(makeClassifier: { _ in nil }, emit: { _ in })
        do {
            try await monitor.setEnabled(true, minSilenceMs: 300)
            XCTFail("Expected the missing model to fail enabling")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Could not load the speech activity model")
        }
        XCTAssertFalse(monitor.isEnabled)
        XCTAssertFalse(monitor.hasClassifier())
    }

    func testAudioThatStopsProducesASilentEventInRealTime() async throws {
        let recorder = Recorder()
        let silent = expectation(description: "silent event")
        let monitor = SpeechActivityMonitor(makeClassifier: { FakeSpeechClassifier(minSilenceMs: $0) }, emit: { event in
            recorder.append(event)
            if !event.speaking { silent.fulfill() }
        })
        try await monitor.setEnabled(true, minSilenceMs: 150)
        let started = Date()
        monitor.accept(loud(1600))
        // No more audio arrives, as when the glasses' loudness gate closes.
        await fulfillment(of: [silent], timeout: 3)
        let elapsedMs = Date().timeIntervalSince(started) * 1000
        XCTAssertEqual(recorder.events.map(\.speaking), [true, false])
        XCTAssertEqual(recorder.events.last?.silentForMs, 150)
        // Gap threshold (100 ms) plus the configured silence, filled at the pace of the clock.
        XCTAssertGreaterThanOrEqual(elapsedMs, 140)
        XCTAssertLessThan(elapsedMs, 2000)
        XCTAssertGreaterThan(recorder.events.last?.timestamp ?? 0, 1_600_000_000_000)
        try await monitor.setEnabled(false, minSilenceMs: nil)
    }
}
