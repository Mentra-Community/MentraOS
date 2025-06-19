//
//  FrameSize.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation

enum FrameSize: Int, CaseIterable {
    case size_80 = 80
    case size_160 = 160
    case size_240 = 240
    case size_320 = 320
    case size_256 = 256
    case size_480 = 480
    case size_512 = 512
    case size_640 = 640
    case size_768 = 768
    case size_960 = 960
    case size_1024 = 1024
    case size_1440 = 1440
    case size_1536 = 1536
    case size_15600 = 15600

    var desc: String {
        "FRAME_SIZE_\(self.rawValue)" 
    }

    static let webrtc_8k: [FrameSize] = [.size_80, .size_160, .size_240]
    static let webrtc_16k: [FrameSize] = [.size_160, .size_320, .size_480]
    static let webrtc_32k: [FrameSize] = [.size_320, .size_640, .size_960]
    static let webrtc_48k: [FrameSize] = [.size_480, .size_960, .size_1440]

    static let silero_8k: [FrameSize] = [.size_256, .size_512, .size_768]
    static let silero_16k: [FrameSize] = [.size_512, .size_1024, .size_1536]

    static let yamnet_15k: [FrameSize] = [.size_15600]
}
