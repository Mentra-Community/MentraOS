import Foundation

class STTTools {
    // MARK: - SherpaOnnxTranscriber / STT Model Management

    /// Send a transcript the loaded model produced. `text` is already formatted for that model,
    /// and `language` is the language it was loaded for.
    static func sendTranscription(_ text: String, isFinal: Bool, language: String) {
        guard !text.isEmpty else { return }
        if isFinal {
            Bridge.log("Mentra: Sending final transcription: \(text), \(language)")
        }
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let transcription: [String: Any] = [
            "type": "local_transcription",
            "text": text,
            "isFinal": isFinal,
            "startTime": now - (isFinal ? 2000 : 1000),
            "endTime": now,
            "speakerId": 0,
            "transcribeLanguage": language,
            "provider": "sherpa-onnx",
        ]

        Bridge.sendLocalTranscription(transcription: transcription)
    }

    static func setSttModelDetails(_ path: String, _ languageCode: String) {
        UserDefaults.standard.set(path, forKey: "STTModelPath")
        UserDefaults.standard.set(languageCode, forKey: "STTModelLanguageCode")
        UserDefaults.standard.synchronize()
    }

    static func getSttModelPath() -> String {
        return UserDefaults.standard.string(forKey: "STTModelPath") ?? ""
    }

    static func checkSTTModelAvailable() -> Bool {
        guard let modelPath = UserDefaults.standard.string(forKey: "STTModelPath") else {
            return false
        }

        let fileManager = FileManager.default

        // Check for tokens.txt (required for all models)
        let tokensPath = (modelPath as NSString).appendingPathComponent("tokens.txt")
        if !fileManager.fileExists(atPath: tokensPath) {
            return false
        }

        // Check for CTC model
        if firstExistingFile(in: modelPath, candidates: ["model.int8.onnx", "model.onnx"]) != nil {
            return true
        }

        // Check for transducer model
        let transducerFiles = [
            ["encoder.onnx", "encoder.int8.onnx"],
            ["decoder.onnx", "decoder.int8.onnx"],
            ["joiner.onnx", "joiner.int8.onnx"],
        ]
        for candidates in transducerFiles {
            if firstExistingFile(in: modelPath, candidates: candidates) == nil {
                return false
            }
        }

        return true
    }

    static func validateSTTModel(_ path: String) -> Bool {
        // do {
        let fileManager = FileManager.default

        // Check for tokens.txt (required for all models)
        let tokensPath = (path as NSString).appendingPathComponent("tokens.txt")
        if !fileManager.fileExists(atPath: tokensPath) {
            return false
        }

        // Check for CTC model
        if firstExistingFile(in: path, candidates: ["model.int8.onnx", "model.onnx"]) != nil {
            return true
        }

        // Check for transducer model
        let transducerFiles = [
            ["encoder.onnx", "encoder.int8.onnx"],
            ["decoder.onnx", "decoder.int8.onnx"],
            ["joiner.onnx", "joiner.int8.onnx"],
        ]
        var allTransducerFilesPresent = true

        for candidates in transducerFiles {
            if firstExistingFile(in: path, candidates: candidates) == nil {
                allTransducerFilesPresent = false
                break
            }
        }

        return allTransducerFilesPresent
        // } catch {
        // Bridge.log("STT_ERROR: \(error.localizedDescription)")
        // return false
        // }
    }

    static func extractTarBz2(sourcePath: String, destinationPath: String) -> Bool {
        do {
            let fileManager = FileManager.default

            // Create destination directory if it doesn't exist
            try fileManager.createDirectory(
                atPath: destinationPath,
                withIntermediateDirectories: true,
                attributes: nil
            )

            // Use the Swift TarBz2Extractor with SWCompression
            var extractionError: NSError?
            let success = TarBz2Extractor.extractTarBz2From(
                sourcePath,
                to: destinationPath,
                error: &extractionError
            )

            if !success || extractionError != nil {
                Bridge.log(
                    "EXTRACTION_ERROR: \(extractionError?.localizedDescription ?? "Failed to extract tar.bz2")"
                )
                return false
            }

        } catch {
            Bridge.log("EXTRACTION_ERROR: \(error.localizedDescription)")
            return false
        }
        return true
    }

    private static func firstExistingFile(in directory: String, candidates: [String]) -> String? {
        let fileManager = FileManager.default
        for candidate in candidates {
            let path = (directory as NSString).appendingPathComponent(candidate)
            if fileManager.fileExists(atPath: path) {
                return path
            }
        }
        return nil
    }
}
