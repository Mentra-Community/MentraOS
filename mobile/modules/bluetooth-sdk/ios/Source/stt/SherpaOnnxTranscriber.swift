import Foundation

/**
 * SherpaOnnxTranscriber handles real-time audio transcription using Sherpa-ONNX.
 *
 * It works fully offline and processes PCM audio in real-time to provide partial and final ASR results.
 * The recognizer exists only while on-device transcription is in demand: the demand-driven worker
 * loads the model Speech settings selected when demand starts and releases it when demand ends.
 */
class SherpaOnnxTranscriber {
    private static let TAG = "SherpaOnnxTranscriber"

    private static let SAMPLE_RATE = 16000 // Sherpa-ONNX model's required sample rate
    /// Bounded wait for `finishUtterance`, matching Android.
    private static let FINISH_TIMEOUT_SECONDS: TimeInterval = 3

    private final class Session {
        let recognizer: SherpaOnnxRecognizer
        let modelPath: String
        let language: String
        let traits: SttModelTraits
        var lastPartialResult = ""

        init(_ recognizer: SherpaOnnxRecognizer, modelPath: String, language: String, traits: SttModelTraits) {
            self.recognizer = recognizer
            self.modelPath = modelPath
            self.language = language
            self.traits = traits
        }
    }

    // Path of the most recent successful load. Combined with the worker's `initialized` flag it
    // answers `isModelLoaded` without waiting on the worker queue, which may be mid-load.
    private let loadedLock = NSLock()
    private var loadedModelPath: String?

    private lazy var worker = DemandDrivenAudioWorker<Session>(
        makeProcessor: { [weak self] in self?.makeSession() },
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

    /// The application container changes between development builds, so a stored absolute path
    /// is re-rooted under the current Documents directory.
    private static func resolveModelPath(_ storedPath: String) -> String {
        guard let range = storedPath.range(of: "/Documents/"),
              let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else {
            return storedPath
        }
        let relativePath = String(storedPath[range.upperBound...]) // e.g. "stt_models/..."
        return documentsURL.appendingPathComponent(relativePath).path
    }

    /// Model selected in Speech settings, if any.
    private static var selectedModelPath: String? {
        guard let storedPath = UserDefaults.standard.string(forKey: "STTModelPath"), !storedPath.isEmpty else {
            return nil
        }
        return resolveModelPath(storedPath)
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
    private static func makeRecognizer(modelPath customPath: String) -> (SherpaOnnxRecognizer, SttModelTraits)? {
        do {
            let fileManager = FileManager.default
            // Detect model type based on available files
            let ctcModelPath = Self.firstExistingFile(
                in: customPath,
                candidates: ["model.int8.onnx", "model.onnx"]
            )
            let transducerEncoderPath = Self.firstExistingFile(
                in: customPath,
                candidates: ["encoder.int8.onnx", "encoder.onnx"]
            )

            let tokensPath = (customPath as NSString).appendingPathComponent("tokens.txt")

            // Verify tokens file exists
            guard fileManager.fileExists(atPath: tokensPath) else {
                throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "tokens.txt not found at path: \(customPath)",
                ])
            }
            let tokens = (try? String(contentsOfFile: tokensPath, encoding: .utf8)) ?? ""

            let traits: SttModelTraits
            var modelConfig: SherpaOnnxOnlineModelConfig
            if let ctcModelPath {
                traits = SttModelTraits(kind: .ctc, tokensFileContents: tokens)
                Bridge.log("Detected CTC model at \(customPath)")

                let nemoCtc = sherpaOnnxOnlineNemoCtcModelConfig(
                    model: ctcModelPath
                )
                modelConfig = sherpaOnnxOnlineModelConfig(
                    tokens: tokensPath,
                    numThreads: traits.numThreads,
                    nemoCtc: nemoCtc
                )
            } else if let transducerEncoderPath {
                traits = SttModelTraits(kind: .transducer, tokensFileContents: tokens)
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

                let transducer = sherpaOnnxOnlineTransducerModelConfig(
                    encoder: transducerEncoderPath,
                    decoder: decoderPath,
                    joiner: joinerPath
                )
                modelConfig = sherpaOnnxOnlineModelConfig(
                    tokens: tokensPath,
                    transducer: transducer,
                    numThreads: traits.numThreads
                )
            } else {
                throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "No valid model files found at path: \(customPath)",
                ])
            }

            let featureConfig = sherpaOnnxFeatureConfig()
            var config = sherpaOnnxOnlineRecognizerConfig(
                featConfig: featureConfig,
                modelConfig: modelConfig,
                enableEndpoint: true,
                rule1MinTrailingSilence: 1.2,
                rule2MinTrailingSilence: 0.8,
                rule3MinUtteranceLength: 10.0
            )
            let recognizer = SherpaOnnxRecognizer(config: &config)

            Bridge.log(
                "Sherpa-ONNX ASR initialized with \(traits.kind.rawValue) model, threads=\(traits.numThreads), " +
                    "finalizeEarly=\(traits.canFinalizeEarly), lowercase=\(traits.uppercaseOnlyVocabulary)"
            )
            return (recognizer, traits)
        } catch {
            Bridge.log("Failed to initialize Sherpa-ONNX: \(error.localizedDescription)")
            return nil
        }
    }

    /// Worker queue only. Loads the model Speech settings selects right now.
    private func makeSession() -> Session? {
        setLoadedModelPath(nil)
        guard let path = Self.selectedModelPath else {
            Bridge.log("No Sherpa ONNX model available. Transcription will be disabled.")
            Bridge.log("Please download a model using the model downloader in settings.")
            return nil
        }
        Bridge.log("Loading STT model: \(path)")
        let language = UserDefaults.standard.string(forKey: "STTModelLanguageCode") ?? "en-US"
        guard let loaded = Self.makeRecognizer(modelPath: path) else { return nil }
        setLoadedModelPath(path)
        return Session(loaded.0, modelPath: path, language: language, traits: loaded.1)
    }

    private func setLoadedModelPath(_ path: String?) {
        loadedLock.lock()
        loadedModelPath = path
        loadedLock.unlock()
    }

    /// Whether on-device demand currently has `path` loaded. Never waits for a load.
    func isModelLoaded(_ path: String) -> Bool {
        guard worker.snapshot().initialized else { return false }
        loadedLock.lock()
        defer { loadedLock.unlock() }
        return loadedModelPath == Self.resolveModelPath(path)
    }

    /// Reload the selected model when on-device transcription is in demand. Returns false only
    /// when the reload failed; true once it loaded or when there is no demand.
    func restart() async -> Bool {
        let state = await worker.restartAndAwaitLoad()
        return state != .failed
    }

    /**
     * End the active recognizer's current utterance now, after all audio queued before the call.
     * Returns the final text once its `local_transcription` event has been sent ("" if nothing was
     * pending), or nil when there is no active streaming model, the model can't finalize early, or
     * the bounded wait expires.
     */
    func finishUtterance() async -> String? {
        await withBoundedWait(timeout: Self.FINISH_TIMEOUT_SECONDS, timeoutValue: nil) { resolver in
            Task {
                let started = await self.worker.withCurrentProcessor { session, generation -> Bool in
                    // A late run after the caller gave up must not cut the utterance.
                    guard !resolver.isSettled, session.traits.canFinalizeEarly else { return false }
                    let text = self.flush(session)
                    DispatchQueue.main.async {
                        guard self.worker.isCurrent(generation) else {
                            resolver.resolve(nil)
                            return
                        }
                        if !text.isEmpty {
                            STTTools.sendTranscription(text, isFinal: true, language: session.language)
                        }
                        resolver.resolve(text)
                    }
                    return true
                }
                if started != true { resolver.resolve(nil) }
            }
        }
    }

    /// Worker queue only. Decodes everything the stream holds and replaces the ended stream.
    private func flush(_ session: Session) -> String {
        let startedAt = Date()
        let recognizer = session.recognizer
        // Sherpa's streaming file decoder uses 660 ms of padding before inputFinished.
        // This is synthetic context, decoded immediately; it is not a wall-clock wait.
        recognizer.acceptWaveform(samples: [Float](repeating: 0, count: Self.SAMPLE_RATE * 66 / 100), sampleRate: Self.SAMPLE_RATE)
        recognizer.inputFinished()
        while recognizer.isReady() {
            recognizer.decode()
        }
        let text = session.traits.format(recognizer.getResult().text.trimmingCharacters(in: .whitespacesAndNewlines))
        // An ended stream cannot accept new samples. Keep the model and replace only its stream.
        if !recognizer.recreateStream() {
            recognizer.reset()
        }
        session.lastPartialResult = ""
        Bridge.log("STT_FINISH elapsedMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) characters=\(text.count)")
        return text
    }

    private func handleTranscriptionResult(text: String, isFinal: Bool, language: String, generation: UInt64) {
        DispatchQueue.main.async { [weak self] in
            // A decode or main-queue delivery may finish after stop/model replacement.
            guard let self, self.worker.isCurrent(generation) else { return }
            STTTools.sendTranscription(text, isFinal: isFinal, language: language)
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
        let text = session.traits.format(recognizer.getResult().text.trimmingCharacters(in: .whitespacesAndNewlines))
        if recognizer.isEndpoint() {
            if !text.isEmpty {
                handleTranscriptionResult(text: text, isFinal: true, language: session.language, generation: generation)
            }
            recognizer.reset()
            session.lastPartialResult = ""
        } else if !text.isEmpty, text != session.lastPartialResult {
            handleTranscriptionResult(text: text, isFinal: false, language: session.language, generation: generation)
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
            for i in 0 ..< count {
                let bits = UInt16(bufferPointer[i * 2]) | (UInt16(bufferPointer[i * 2 + 1]) << 8)
                samples[i] = Float(Int16(bitPattern: bits)) / 32768.0
            }
        }

        return samples
    }

    func shutdown() {
        worker.setActive(false)
    }
}
