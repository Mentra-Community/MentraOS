import Foundation

/**
 * SherpaOnnxTranscriber handles real-time audio transcription using Sherpa-ONNX.
 *
 * It works fully offline and processes PCM audio in real-time to provide partial and final ASR results.
 * This class runs on a background thread, processes short PCM chunks, and emits transcribed text using a delegate.
 */
class SherpaOnnxTranscriber {
    private static let TAG = "SherpaOnnxTranscriber"

    private static let SAMPLE_RATE = 16000 // Sherpa-ONNX model's required sample rate
    private final class Session {
        let recognizer: SherpaOnnxRecognizer
        var lastPartialResult = ""

        init(_ recognizer: SherpaOnnxRecognizer) {
            self.recognizer = recognizer
        }
    }

    private lazy var worker = DemandDrivenAudioWorker<Session>(
        makeProcessor: { Self.makeRecognizer().map(Session.init) },
        process: { [weak self] session, data, generation in
            self?.process(session, data: data, generation: generation)
        }
    )

    /// Construct the worker on the manager's actor before audio can arrive.
    init() {
        _ = worker
    }

    func setActive(_ active: Bool) {
        worker.setActive(active)
    }

    /// Dynamic model path support
    private static var customModelPath: String? {
        guard let storedPath = UserDefaults.standard.string(forKey: "STTModelPath") else {
            return nil
        }

        // Always resolve current Documents directory
        let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!

        // Extract relative subpath after "Documents/"
        // NOTE: Doing this because the application id changes between the development builds and files can't be found.
        if let range = storedPath.range(of: "/Documents/") {
            let relativePath = String(storedPath[range.upperBound...]) // e.g. "stt_models/..."
            let fixedPath = documentsURL.appendingPathComponent(relativePath).path

            Bridge.log("Reconstructed STTModelPath: \(fixedPath)")
            return fixedPath
        }

        // If nothing matched, just return as-is
        Bridge.log("STTModelPath (raw): \(storedPath)")
        return storedPath
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

    /// Runs exclusively on the worker queue, never on the main/audio delivery thread.
    private static func makeRecognizer() -> SherpaOnnxRecognizer? {
        var recognizer: SherpaOnnxRecognizer?
        do {
            var tokensPath: String
            var modelType = "unknown"
            let fileManager = FileManager.default

            // Check if we have a custom model path set
            if let customPath = SherpaOnnxTranscriber.customModelPath {
                // Detect model type based on available files
                let ctcModelPath = Self.firstExistingFile(
                    in: customPath,
                    candidates: ["model.int8.onnx", "model.onnx"]
                )
                let transducerEncoderPath = Self.firstExistingFile(
                    in: customPath,
                    candidates: ["encoder.int8.onnx", "encoder.onnx"]
                )

                tokensPath = (customPath as NSString).appendingPathComponent("tokens.txt")

                // Verify tokens file exists
                guard fileManager.fileExists(atPath: tokensPath) else {
                    throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "tokens.txt not found at path: \(customPath)",
                    ])
                }

                if let ctcModelPath {
                    // CTC model detected
                    modelType = "ctc"
                    Bridge.log("Detected CTC model at \(customPath)")

                    // Create CTC model config using Zipformer2Ctc
                    var nemoCtc = sherpaOnnxOnlineNemoCtcModelConfig(
                        model: ctcModelPath
                    )

                    // Create model config with CTC
                    var modelConfig = sherpaOnnxOnlineModelConfig(
                        tokens: tokensPath,
                        numThreads: 1,
                        nemoCtc: nemoCtc
                    )

                    // Configure recognizer
                    var featureConfig = sherpaOnnxFeatureConfig()

                    var config = sherpaOnnxOnlineRecognizerConfig(
                        featConfig: featureConfig,
                        modelConfig: modelConfig,
                        enableEndpoint: true,
                        rule1MinTrailingSilence: 1.2,
                        rule2MinTrailingSilence: 0.8,
                        rule3MinUtteranceLength: 10.0
                    )

                    // Create recognizer with the wrapper
                    recognizer = SherpaOnnxRecognizer(config: &config)

                } else if let transducerEncoderPath {
                    // Transducer model detected
                    modelType = "transducer"
                    Bridge.log("Detected transducer model at \(customPath)")

                    let decoderPath = Self.firstExistingFile(
                        in: customPath,
                        candidates: ["decoder.int8.onnx", "decoder.onnx"]
                    )
                    let joinerPath = Self.firstExistingFile(
                        in: customPath,
                        candidates: ["joiner.int8.onnx", "joiner.onnx"]
                    )

                    // Verify all transducer files exist
                    guard let decoderPath,
                          let joinerPath
                    else {
                        throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                            NSLocalizedDescriptionKey: "Transducer model files incomplete at path: \(customPath)",
                        ])
                    }

                    // Create Sherpa-ONNX transducer model config
                    var transducer = sherpaOnnxOnlineTransducerModelConfig(
                        encoder: transducerEncoderPath,
                        decoder: decoderPath,
                        joiner: joinerPath
                    )

                    // Create model config
                    var modelConfig = sherpaOnnxOnlineModelConfig(
                        tokens: tokensPath,
                        transducer: transducer,
                        numThreads: 1
                    )

                    // Configure recognizer
                    var featureConfig = sherpaOnnxFeatureConfig()

                    var config = sherpaOnnxOnlineRecognizerConfig(
                        featConfig: featureConfig,
                        modelConfig: modelConfig,
                        enableEndpoint: true,
                        rule1MinTrailingSilence: 1.2,
                        rule2MinTrailingSilence: 0.8,
                        rule3MinUtteranceLength: 10.0
                    )

                    // Create recognizer with the wrapper
                    recognizer = SherpaOnnxRecognizer(config: &config)

                } else {
                    throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "No valid model files found at path: \(customPath)",
                    ])
                }
            } else {
                Bridge.log("No Sherpa ONNX model available. Transcription will be disabled.")
                Bridge.log("Please download a model using the model downloader in settings.")
                recognizer = nil
                return nil
            }

            if recognizer == nil {
                throw NSError(domain: "SherpaOnnxTranscriber", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create recognizer"])
            }

            Bridge.log("Sherpa-ONNX ASR initialized successfully with \(modelType) model")
            return recognizer

        } catch {
            Bridge.log("Failed to initialize Sherpa-ONNX: \(error.localizedDescription)")
            return nil
        }
    }

    private func handleTranscriptionResult(text: String, isFinal: Bool, generation: UInt64) {
        DispatchQueue.main.async { [weak self] in
            // A decode or main-queue delivery may finish after stop/model replacement.
            guard let self, self.worker.isCurrent(generation) else { return }
            if isFinal {
                STTTools.didReceiveFinalTranscription(text)
            } else {
                STTTools.didReceivePartialTranscription(text)
            }
        }
    }

    func acceptAudio(pcm16le: Data) {
        worker.accept(pcm16le)
    }

    private func process(_ session: Session, data: Data, generation: UInt64) {
        guard worker.isCurrent(generation) else { return }
        let recognizer = session.recognizer
        recognizer.acceptWaveform(samples: toFloatArray(from: data), sampleRate: Self.SAMPLE_RATE)
        while recognizer.isReady() {
            guard worker.isCurrent(generation) else { return }
            recognizer.decode()
        }
        guard worker.isCurrent(generation) else { return }
        let text = recognizer.getResult().text.trimmingCharacters(in: .whitespacesAndNewlines)
        if recognizer.isEndpoint() {
            if !text.isEmpty {
                handleTranscriptionResult(text: text, isFinal: true, generation: generation)
            }
            recognizer.reset()
            session.lastPartialResult = ""
        } else if !text.isEmpty, text != session.lastPartialResult {
            handleTranscriptionResult(text: text, isFinal: false, generation: generation)
            session.lastPartialResult = text
        }
    }

    /**
     * Convert 16-bit PCM byte data (little-endian) to float array [-1.0, 1.0].
     */
    private func toFloatArray(from pcmData: Data) -> [Float] {
        let count = pcmData.count / 2
        var samples = [Float](repeating: 0, count: count)

        pcmData.withUnsafeBytes { (bufferPointer: UnsafeRawBufferPointer) in
            if let address = bufferPointer.baseAddress {
                let int16Pointer = address.bindMemory(to: Int16.self, capacity: count)

                for i in 0 ..< count {
                    // Convert from little-endian if needed
                    var sample = int16Pointer[i]
                    if CFByteOrderGetCurrent() == CFByteOrder(CFByteOrderBigEndian.rawValue) {
                        sample = Int16(littleEndian: sample)
                    }
                    samples[i] = Float(sample) / 32768.0
                }
            }
        }

        return samples
    }

    func shutdown() {
        worker.setActive(false)
    }

    func restart() {
        worker.restart()
    }
}
