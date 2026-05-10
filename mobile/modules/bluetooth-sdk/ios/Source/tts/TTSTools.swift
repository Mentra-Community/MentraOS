import Foundation

class TTSTools {
    static func setTtsModelDetails(_ path: String, _ languageCode: String) {
        UserDefaults.standard.set(path, forKey: "TTSModelPath")
        UserDefaults.standard.set(languageCode, forKey: "TTSModelLanguageCode")
        UserDefaults.standard.synchronize()
    }

    static func getTtsModelPath() -> String {
        return UserDefaults.standard.string(forKey: "TTSModelPath") ?? ""
    }

    static func checkTTSModelAvailable() -> Bool {
        guard let modelPath = UserDefaults.standard.string(forKey: "TTSModelPath") else {
            return false
        }
        return validateTTSModel(modelPath)
    }

    static func validateTTSModel(_ path: String) -> Bool {
        guard let _ = findVitsModelFile(in: path) else {
            Bridge.log("TTS model missing VITS .onnx file at: \(path)")
            return false
        }

        let fileManager = FileManager.default
        let tokensPath = (path as NSString).appendingPathComponent("tokens.txt")
        if !fileManager.fileExists(atPath: tokensPath) {
            Bridge.log("TTS model missing tokens.txt at: \(path)")
            return false
        }

        let dataDir = (path as NSString).appendingPathComponent("espeak-ng-data")
        var isDirectory: ObjCBool = false
        if !fileManager.fileExists(atPath: dataDir, isDirectory: &isDirectory) || !isDirectory.boolValue {
            Bridge.log("TTS model missing espeak-ng-data at: \(path)")
            return false
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
        guard validateTTSModel(modelPath),
              let modelFile = findVitsModelFile(in: modelPath)
        else {
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

            var vits = sherpaOnnxOfflineTtsVitsModelConfig(
                model: modelFile,
                tokens: (modelPath as NSString).appendingPathComponent("tokens.txt"),
                dataDir: (modelPath as NSString).appendingPathComponent("espeak-ng-data")
            )
            var modelConfig = sherpaOnnxOfflineTtsModelConfig(vits: vits, numThreads: 1)
            var config = sherpaOnnxOfflineTtsConfig(model: modelConfig, maxNumSentences: 1)
            let tts = SherpaOnnxOfflineTtsWrapper(config: &config)
            let audio = tts.generate(
                text: text,
                sid: max(0, speakerId),
                speed: Float(min(max(speed, 0.5), 2.0))
            )
            let saved = audio.save(filename: outputPath) == 1
            Bridge.log("TTS generated \(outputPath): saved=\(saved)")
            return saved
        } catch {
            Bridge.log("TTS_ERROR: \(error.localizedDescription)")
            return false
        }
    }

    private static func findVitsModelFile(in directory: String) -> String? {
        let fileManager = FileManager.default
        guard let files = try? fileManager.contentsOfDirectory(atPath: directory) else {
            return nil
        }
        return files
            .filter { $0.hasSuffix(".onnx") }
            .map { (directory as NSString).appendingPathComponent($0) }
            .first { fileManager.fileExists(atPath: $0) }
    }
}
