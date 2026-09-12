import AVFoundation
import Foundation

enum DecodedPcm {
    static func pcm16(_ buffer: AVAudioPCMBuffer) -> Data? {
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        guard frames > 0, channels > 0 else { return nil }
        let interleaved = buffer.format.isInterleaved
        var data = Data(count: frames * channels * 2)
        if let source = buffer.int16ChannelData {
            data.withUnsafeMutableBytes { raw in
                let output = raw.bindMemory(to: Int16.self)
                for frame in 0 ..< frames {
                    for channel in 0 ..< channels {
                        output[frame * channels + channel] = interleaved ? source[0][frame * channels + channel] : source[channel][frame]
                    }
                }
            }
        } else if let source = buffer.floatChannelData {
            data.withUnsafeMutableBytes { raw in
                let output = raw.bindMemory(to: Int16.self)
                for frame in 0 ..< frames {
                    for channel in 0 ..< channels {
                        let sample = interleaved ? source[0][frame * channels + channel] : source[channel][frame]
                        output[frame * channels + channel] = Int16(max(-1, min(1, sample.isFinite ? sample : 0)) * Float(Int16.max))
                    }
                }
            }
        } else { return nil }
        return data
    }
}
