//
//  SampleRate.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation

enum SampleRate: Int, CaseIterable {
    case rate_8k = 8_000
    case rate_15K = 15600
    case rate_16k = 16_000
    case rate_32k = 32_000
    case rate_48k = 48_000

    var desc: String {
        "SAMPLE_RATE_\(self.rawValue)"
    }

    static let webrtc: [SampleRate] = [.rate_8k, .rate_16k, .rate_32k, .rate_48k]
    static let silero: [SampleRate] = [.rate_8k, .rate_16k]
    static let yamnet: [SampleRate] = [.rate_15K]

    func frameSizeOptions(type: VADType) -> [FrameSize] {
        switch type {
        case .webrtc:
            switch self {
            case .rate_8k: return FrameSize.webrtc_8k
            case .rate_16k: return FrameSize.webrtc_16k
            case .rate_32k: return FrameSize.webrtc_32k
            case .rate_48k: return FrameSize.webrtc_48k
            default: return []
            }
        case .silero:
            switch self {
            case .rate_8k: return FrameSize.silero_8k
            case .rate_16k: return FrameSize.silero_16k
            default: return []
            }
        case .yamnet:
            switch self {
            case .rate_15K: return FrameSize.yamnet_15k
            default: return []
            }
        }
    }
}
