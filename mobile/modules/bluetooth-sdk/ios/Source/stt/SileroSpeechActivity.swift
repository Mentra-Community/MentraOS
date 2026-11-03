import Foundation

/// Silero voice activity detection through sherpa-onnx, one 512-sample frame at a time.
final class SileroSpeechActivityClassifier: SpeechActivityClassifier {
    /// Resource bundle declared in MentraBluetoothSDK.podspec.
    private static let bundleName = "MentraSileroVad"
    /// Long enough that real speech is never split. sherpa-onnx raises its threshold past this
    /// to force a split, which bounds the speech it buffers during continuous noise.
    private static let maxSpeechSeconds: Float = 30
    private static let minSpeechSeconds: Float = 0.25
    private static let threshold: Float = 0.5

    private let vad: SherpaOnnxVoiceActivityDetectorWrapper

    init?(modelPath: String, minSilenceMs: Int) {
        guard FileManager.default.fileExists(atPath: modelPath) else {
            Bridge.log("SPEECH_ACTIVITY: Silero model missing at \(modelPath)")
            return nil
        }
        let silero = sherpaOnnxSileroVadModelConfig(
            model: modelPath,
            threshold: Self.threshold,
            minSilenceDuration: Float(minSilenceMs) / 1000,
            minSpeechDuration: Self.minSpeechSeconds,
            windowSize: SpeechActivityTracker.frameSamples,
            maxSpeechDuration: Self.maxSpeechSeconds
        )
        var config = sherpaOnnxVadModelConfig(
            sileroVad: silero,
            sampleRate: Int32(SpeechActivityTracker.sampleRate),
            numThreads: 1
        )
        guard let vad = SherpaOnnxVoiceActivityDetectorWrapper(
            config: &config,
            buffer_size_in_seconds: Self.maxSpeechSeconds + 2
        ) else {
            Bridge.log("SPEECH_ACTIVITY: sherpa-onnx rejected the Silero model")
            return nil
        }
        self.vad = vad
    }

    func isSpeech(afterAccepting frame: [Float]) -> Bool {
        vad.acceptWaveform(samples: frame)
        // Only the live state matters; drop finished segments so they don't accumulate.
        while !vad.isEmpty() {
            vad.pop()
        }
        return vad.isSpeechDetected()
    }

    static var bundledModelPath: String? {
        let candidates = [Bundle(for: SileroSpeechActivityClassifier.self), Bundle.main]
        for bundle in candidates {
            if let url = bundle.url(forResource: bundleName, withExtension: "bundle"),
               let resources = Bundle(url: url),
               let path = resources.path(forResource: "silero_vad", ofType: "onnx")
            {
                return path
            }
            if let path = bundle.path(forResource: "silero_vad", ofType: "onnx") {
                return path
            }
        }
        return nil
    }
}

extension SpeechActivityMonitor {
    /// Phone-side speech activity on the microphone PCM the wake word and STT also see.
    static let shared = SpeechActivityMonitor(
        makeClassifier: { minSilenceMs in
            guard let path = SileroSpeechActivityClassifier.bundledModelPath else {
                Bridge.log("SPEECH_ACTIVITY: silero_vad.onnx is not bundled")
                return nil
            }
            return SileroSpeechActivityClassifier(modelPath: path, minSilenceMs: minSilenceMs)
        },
        emit: { event in
            Bridge.sendTypedMessage("speech_activity", body: [
                "speaking": event.speaking,
                "silentForMs": event.silentForMs,
                "timestamp": event.timestamp,
            ])
        }
    )
}
