//
//  VADState.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation

enum VADState {
    case start              // 开始说话
    case speeching          // 说话中
    case end                // 结束说话
    case silence            // 静默中
    case error              // 出错了

    var desc: String {
        switch self {
        case .start: return "VAD Start"
        case .speeching: return "VAD Speeching"
        case .end: return "VAD End"
        case .silence: return "VAD Silence"
        case .error: return "Error"
        }
    }
}
