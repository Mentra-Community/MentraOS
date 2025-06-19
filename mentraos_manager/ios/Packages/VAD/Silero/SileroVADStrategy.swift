//
//  SileroVADStrategy.swift
//  ios-vad
//
//  Created by baochuquan on 2024/11/10.
//

import Foundation


// MARK: - SileroVADStrategy

class SileroVADStrategy: VADStrategy {

    private var sileroVAD: SileroVAD?
    private var state: VADState = .silence
    private var handler: ((VADState) -> Void)?

    func setup(sampleRate: SampleRate, frameSize: FrameSize, quality: VADQuality, silenceTriggerDurationMs: Int64, speechTriggerDurationMs: Int64) {
        sileroVAD = SileroVAD(
            sampleRate: Int64(sampleRate.rawValue),
            sliceSize: Int64(frameSize.rawValue),
            threshold: quality.threshold,
            silenceTriggerDurationMs: silenceTriggerDurationMs,
            speechTriggerDurationMs: speechTriggerDurationMs
        )
        sileroVAD?.delegate = self
    }

    func checkVAD(pcm: [Int16], handler: @escaping (VADState) -> Void) {
        self.handler = handler
        let data: [Float] = pcm.map { Float($0) / 32768.0 } // normalize

        do {
            try sileroVAD?.predict(data: data)
        } catch _ {
            fatalError()
        }
    }

    func currentState() -> VADState {
        return state
    }
}

extension SileroVADStrategy: SileroVADDelegate {
    func sileroVADDidDetectSpeechStart() {
        state = .start
        handler?(.start)
    }

    func sileroVADDidDetectSpeechEnd() {
        state = .end
        handler?(.end)
    }

    func sileroVADDidDetectSilence() {
        state = .silence
        handler?(.silence)
    }

    func sileroVADDidDetectSpeeching() {
        state = .speeching
        handler?(.speeching)
    }
}
