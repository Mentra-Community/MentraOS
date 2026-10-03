import Foundation

/// Bounded decoded audio queue. Converts PCM16 to 48kHz mono without touching phone capture.
public final class RelayPcmBuffer {
    private let lock = NSLock()
    private var samples: [Int16]
    private var head = 0
    private var count = 0
    private var phase = 0.0
    private var rate = 0
    private var channels = 0
    private var previous: Double?

    public init(capacity: Int = 9600) {
        samples = Array(repeating: 0, count: capacity)
    }

    public func push(_ data: Data, sampleRate: Int, channels channelCount: Int) {
        guard (8000 ... 192_000).contains(sampleRate), (1 ... 8).contains(channelCount) else { return }
        lock.lock(); defer { lock.unlock() }
        if rate != sampleRate || channels != channelCount {
            rate = sampleRate; channels = channelCount; phase = 0; previous = nil
        }
        let step = Double(sampleRate) / 48000
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for frame in 0 ..< data.count / (2 * channelCount) {
                var sum = 0.0
                for channel in 0 ..< channelCount {
                    let offset = (frame * channelCount + channel) * 2
                    sum += Double(Int16(bitPattern: UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8))
                }
                let value = sum / Double(channelCount)
                if let prior = previous {
                    while phase < 1 {
                        if count == samples.count { head = (head + 1) % samples.count; count -= 1 }
                        samples[(head + count) % samples.count] = Int16(prior + (value - prior) * phase)
                        count += 1
                        phase += step
                    }
                    phase -= 1
                }
                previous = value
            }
        }
    }

    /// Pads underruns with silence. Drops oldest samples on overrun to bound live latency.
    public func read(into output: UnsafeMutableBufferPointer<Int16>) {
        lock.lock(); defer { lock.unlock() }
        for i in output.indices {
            if count > 0 {
                output[i] = samples[head]; head = (head + 1) % samples.count; count -= 1
            } else { output[i] = 0 }
        }
    }
}
