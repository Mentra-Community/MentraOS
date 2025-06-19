//
//  VADStrategy.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/9.
//

import Foundation

protocol VADStrategy {

    /// vad setup method
    /// - Parameters:
    ///   - sampleRate: sample rate
    ///   - frameSize: frame size
    ///   - quality: vad quality level
    ///   - silenceTriggerDurationMs: the minimum duration required to switch from speech to silence. Unit: millisecond.
    ///   - speechTriggerDurationMs: the minimum duration required to switch from silence to speech. Unit: millisecond.
    func setup(sampleRate: SampleRate, frameSize: FrameSize, quality: VADQuality, silenceTriggerDurationMs: Int64, speechTriggerDurationMs: Int64)

    /// vad check result callback
    /// - Parameters:
    ///   - pcm: pcm Data
    ///   - handler: callback.
    func checkVAD(pcm: [Int16], handler: @escaping (VADState) -> Void)

    /// current vad state
    /// - Returns: vad state
    func currentState() -> VADState

}
