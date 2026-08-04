import Foundation

/// Utilities for offline Sherpa-ONNX Supertonic 3 TTS.
///
/// Supertonic 3 is a single multilingual model bundle (31 languages) with
/// 10 preset voice styles packed into voice.bin. Speaker IDs are indexed
/// alphabetically by JSON filename, so the order is F1, F2, F3, F4, F5,
/// M1, M2, M3, M4, M5 (sids 0..9). We default to F1 (sid 0) for a female
/// voice.
class TTSTools {
    private static let kFileDurationPredictor = "duration_predictor.int8.onnx"
    private static let kFileTextEncoder = "text_encoder.int8.onnx"
    private static let kFileVectorEstimator = "vector_estimator.int8.onnx"
    private static let kFileVocoder = "vocoder.int8.onnx"
    private static let kFileTtsJson = "tts.json"
    private static let kFileUnicodeIndexer = "unicode_indexer.bin"
    private static let kFileVoiceStyle = "voice.bin"

    private static let kRequiredFiles: [String] = [
        kFileDurationPredictor,
        kFileTextEncoder,
        kFileVectorEstimator,
        kFileVocoder,
        kFileTtsJson,
        kFileUnicodeIndexer,
        kFileVoiceStyle,
    ]

    private static let kSupportedLangs: Set<String> = [
        "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et",
        "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl",
        "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
    ]

    static func setTtsModelDetails(_ path: String, _ languageCode: String) {
        UserDefaults.standard.set(path, forKey: "TTSModelPath")
        UserDefaults.standard.set(languageCode, forKey: "TTSModelLanguageCode")
        UserDefaults.standard.synchronize()
    }

    static func getTtsModelPath() -> String {
        return UserDefaults.standard.string(forKey: "TTSModelPath") ?? ""
    }

    static func getTtsModelLanguage() -> String {
        return UserDefaults.standard.string(forKey: "TTSModelLanguageCode") ?? "en-US"
    }

    static func checkTTSModelAvailable() -> Bool {
        guard let modelPath = UserDefaults.standard.string(forKey: "TTSModelPath") else {
            return false
        }
        return validateTTSModel(modelPath)
    }

    static func validateTTSModel(_ path: String) -> Bool {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        if !fileManager.fileExists(atPath: path, isDirectory: &isDirectory) || !isDirectory.boolValue {
            Bridge.log("TTS model path does not exist or is not a directory: \(path)")
            return false
        }

        for name in kRequiredFiles {
            let filePath = (path as NSString).appendingPathComponent(name)
            if !fileManager.fileExists(atPath: filePath) {
                Bridge.log("TTS model missing required file '\(name)' at: \(path)")
                return false
            }
            let size = (try? fileManager.attributesOfItem(atPath: filePath)[.size] as? UInt64) ?? 0
            if size == 0 {
                Bridge.log("TTS model file '\(name)' is empty at: \(path)")
                return false
            }
        }

        return true
    }

    static func generateTtsAudio(
        text: String,
        modelPath: String,
        outputPath: String,
        speakerId: Int,
        speed: Double
    ) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            Bridge.log("TTS_ERROR: text is empty")
            return false
        }
        guard validateTTSModel(modelPath) else {
            Bridge.log("TTS_ERROR: model is invalid: \(modelPath)")
            return false
        }

        do {
            let outputURL = URL(fileURLWithPath: outputPath)
            try FileManager.default.createDirectory(
                at: outputURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: nil
            )

            let supertonic = sherpaOnnxOfflineTtsSupertonicModelConfig(
                durationPredictor: (modelPath as NSString).appendingPathComponent(kFileDurationPredictor),
                textEncoder: (modelPath as NSString).appendingPathComponent(kFileTextEncoder),
                vectorEstimator: (modelPath as NSString).appendingPathComponent(kFileVectorEstimator),
                vocoder: (modelPath as NSString).appendingPathComponent(kFileVocoder),
                ttsJson: (modelPath as NSString).appendingPathComponent(kFileTtsJson),
                unicodeIndexer: (modelPath as NSString).appendingPathComponent(kFileUnicodeIndexer),
                voiceStyle: (modelPath as NSString).appendingPathComponent(kFileVoiceStyle)
            )
            var modelConfig = sherpaOnnxOfflineTtsModelConfig(
                numThreads: 8,
                supertonic: supertonic
            )
            var config = sherpaOnnxOfflineTtsConfig(model: modelConfig, maxNumSentences: 1)
            let tts = SherpaOnnxOfflineTtsWrapper(config: &config)

            // The new wrapper dropped numSpeakers() in v1.13.2; call the C API
            // directly. The C signature accepts the underlying OpaquePointer.
            let numSpeakers = max(1, Int(SherpaOnnxOfflineTtsNumSpeakers(tts.tts)))
            let sid = max(0, min(speakerId, numSpeakers - 1))
            let clampedSpeed = Float(min(max(speed, 0.5), 2.0))
            let lang = languageTagToSupertonicLang(getTtsModelLanguage())

            // generate(...) no longer accepts `extra`; that field moved onto
            // SherpaOnnxGenerationConfigSwift and is delivered via
            // generateWithConfig(...).
            //
            // numSteps controls the Supertonic flow-matching vocoder's
            // iteration count. The Swift wrapper defaults to 1, which produces
            // unintelligible robot audio — sherpa-onnx's actual C-side default
            // is 5. Pin it here so we don't inherit the wrapper's bug.
            let genConfig = SherpaOnnxGenerationConfigSwift(
                speed: clampedSpeed,
                sid: sid,
                numSteps: 5,
                extra: ["lang": lang]
            )
            let audio = tts.generateWithConfig(
                text: text,
                config: genConfig,
                callback: nil,
                arg: nil
            )
            let saved = audio.save(filename: outputPath) == 1
            Bridge.log(
                "TTS generated \(outputPath): saved=\(saved) sid=\(sid) lang=\(lang) " +
                    "sr=\(audio.sampleRate) samples=\(audio.n) speed=\(clampedSpeed)"
            )
            return saved
        } catch {
            Bridge.log("TTS_ERROR: \(error.localizedDescription)")
            return false
        }
    }

    /// Convert a BCP-47 tag (e.g. "en-US", "fr-FR") to a Supertonic 2-letter code.
    private static func languageTagToSupertonicLang(_ tag: String) -> String {
        let primary = tag.split(separator: "-").first.map(String.init)?.lowercased() ?? "en"
        return kSupportedLangs.contains(primary) ? primary : "en"
    }
}
