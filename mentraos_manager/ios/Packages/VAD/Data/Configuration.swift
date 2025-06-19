//
//  VADConfiguration.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation

// MARK: - Sample Rate Config

struct SampleRateConfiguration: Hashable {
    var selectedOption: SampleRate
    var options: [SampleRate]

    static let webrtc = SampleRateConfiguration(selectedOption: SampleRate.webrtc[0], options: SampleRate.webrtc)

    static let silero = SampleRateConfiguration(selectedOption: SampleRate.silero[0], options: SampleRate.silero)

    static let yamnet = SampleRateConfiguration(selectedOption: SampleRate.yamnet[0], options: SampleRate.yamnet)

    func frameSizeConfiguration(type: VADType) -> FrameSizeConfiguration {
        let options = selectedOption.frameSizeOptions(type: type)
        return FrameSizeConfiguration(selectedOption: options[0], options: options)
    }
}

// MARK: - Frame Size Config

struct FrameSizeConfiguration: Hashable {
    var selectedOption: FrameSize
    var options: [FrameSize]
}

// MARK: - Mode Config

struct QualityConfiguration: Hashable {
    var selectedOption: VADQuality
    var options: [VADQuality]

    static let webrtc = QualityConfiguration(
        selectedOption: .very_aggressive,
        options: [
            .normal,
            .low_bitrate,
            .aggressive,
            .very_aggressive
        ]
    )

    static let silero = QualityConfiguration(
        selectedOption: .normal,
        options: [
            .normal,
            .aggressive,
            .very_aggressive
        ]
    )

    static let yamnet = QualityConfiguration(
        selectedOption: .normal,
        options: [
            .normal,
            .aggressive,
            .very_aggressive
        ]
    )
}
