import Foundation
@testable import GlassesMediaCore
import XCTest

final class RelayPcmBufferTests: XCTestCase {
    func pcm(_ values: [Int16]) -> Data {
        values.withUnsafeBytes { Data($0) }
    }

    func read(_ buffer: RelayPcmBuffer, _ count: Int) -> [Int16] {
        var result = [Int16](repeating: -1, count: count)
        result.withUnsafeMutableBufferPointer { buffer.read(into: $0) }
        return result
    }

    func testStereoDownmixAndSilentUnderrun() {
        let buffer = RelayPcmBuffer()
        buffer.push(pcm([1000, 3000, -1000, 1000, 2000, 2000]), sampleRate: 48000, channels: 2)
        XCTAssertEqual(read(buffer, 4), [2000, 0, 0, 0])
    }

    func testResamplingContinuesAcrossPackets() {
        let single = RelayPcmBuffer(), split = RelayPcmBuffer()
        single.push(pcm([0, 300, 600, 900]), sampleRate: 16000, channels: 1)
        split.push(pcm([0, 300]), sampleRate: 16000, channels: 1)
        split.push(pcm([600, 900]), sampleRate: 16000, channels: 1)
        XCTAssertEqual(read(single, 12), read(split, 12))
    }

    func testOverflowDropsOldestAudio() {
        let buffer = RelayPcmBuffer(capacity: 3)
        buffer.push(pcm([1, 2, 3, 4, 5, 6]), sampleRate: 48000, channels: 1)
        XCTAssertEqual(read(buffer, 4), [3, 4, 5, 0])
    }
}
