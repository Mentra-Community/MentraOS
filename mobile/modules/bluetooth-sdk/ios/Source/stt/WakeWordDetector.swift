import Foundation

/// Native keyword spotting, independent of full speech transcription.
///
/// The model comes from the Speech-page model directory passed to `configure`. It is loaded
/// while detection is enabled and released when detection is disabled.
final class WakeWordDetector {
    static let shared = WakeWordDetector()

    static let requiredModelFiles = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "keywords.txt"]
    private static let phrase = "Hey Mentra"

    private let lock = NSLock()
    private var modelDir: String?
    // Worker queue only.
    private var lastDetection: TimeInterval = 0
    private lazy var worker: DemandDrivenAudioWorker<SherpaOnnxKeywordSpotterWrapper> = DemandDrivenAudioWorker(
        queue: DispatchQueue(label: "com.mentra.wakeword.processor", qos: .userInitiated),
        makeProcessor: { [weak self] in self?.makeSpotter() },
        process: { [weak self] spotter, data, generation in
            self?.process(spotter, data: data, generation: generation)
        }
    )

    private init() {
        _ = worker
    }

    /// Enable with the model in `modelDir`, or disable and release the model. Enabling returns
    /// once the model is loaded and `ready` has been sent; it throws when the model is missing
    /// or fails to load, and sends no `ready` in that case.
    func configure(enabled: Bool, modelDir requestedDir: String?) async throws {
        guard enabled else {
            setModelDir(nil)
            worker.setActive(false)
            return
        }
        guard let dir = requestedDir, !dir.isEmpty else {
            throw Self.error("Wake-word model directory is required to enable detection")
        }
        let missing = Self.requiredModelFiles.filter {
            !FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent($0))
        }
        guard missing.isEmpty else {
            throw Self.error("Wake-word model files are missing: \(missing.joined(separator: ", "))")
        }

        lock.lock()
        let changed = modelDir != dir
        modelDir = dir
        lock.unlock()
        if changed {
            // Load the new directory even if detection was already on with another one.
            worker.setActive(false)
        }

        // The engine retries a failed load by enabling the same directory again.
        switch await worker.activateAndAwaitLoad() {
        case .loaded:
            // Send `ready` only for the detector that is still on; disabling in the meantime
            // invalidates the generation captured here.
            let sent = await worker.withCurrentProcessor { _, _ -> Bool in
                Self.emit("ready")
                return true
            }
            if sent != true {
                Bridge.log("WAKE_WORD: disabled before the model finished loading")
            }
        case .failed:
            throw Self.error("Could not load the wake-word model")
        case .noDemand:
            break // Disabled while loading.
        }
    }

    func accept(_ pcm: Data) {
        worker.accept(pcm)
    }

    private func setModelDir(_ dir: String?) {
        lock.lock()
        modelDir = dir
        lock.unlock()
    }

    /// Worker queue only.
    private func makeSpotter() -> SherpaOnnxKeywordSpotterWrapper? {
        lock.lock()
        let dir = modelDir
        lock.unlock()
        guard let dir else { return nil }
        let path = { (name: String) in (dir as NSString).appendingPathComponent(name) }
        guard Self.requiredModelFiles.allSatisfy({ FileManager.default.fileExists(atPath: path($0)) }) else {
            Bridge.log("WAKE_WORD: model files are missing in \(dir)")
            return nil
        }
        let transducer = sherpaOnnxOnlineTransducerModelConfig(
            encoder: path("encoder.int8.onnx"), decoder: path("decoder.onnx"), joiner: path("joiner.int8.onnx")
        )
        let model = sherpaOnnxOnlineModelConfig(tokens: path("tokens.txt"), transducer: transducer, numThreads: 1)
        var config = sherpaOnnxKeywordSpotterConfig(featConfig: sherpaOnnxFeatureConfig(), modelConfig: model,
                                                    keywordsFile: path("keywords.txt"), maxActivePaths: 8, numTrailingBlanks: 1, keywordsScore: 3.0)
        guard let spotter = SherpaOnnxKeywordSpotterWrapper(config: &config) else {
            Bridge.log("WAKE_WORD: sherpa-onnx rejected the keyword spotter model in \(dir)")
            return nil
        }
        lastDetection = 0
        Bridge.log("WAKE_WORD: keyword spotter loaded from \(dir)")
        return spotter
    }

    /// Worker queue only.
    private func process(_ spotter: SherpaOnnxKeywordSpotterWrapper, data: Data, generation: UInt64) {
        let samples: [Float] = data.withUnsafeBytes { bytes in
            (0 ..< (bytes.count / 2)).map { i in
                let bits = UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8
                return Float(Int16(bitPattern: bits)) / 32768
            }
        }
        spotter.acceptWaveform(samples: samples)
        while spotter.isReady() {
            spotter.decode()
            if !spotter.getResult().keyword.isEmpty {
                spotter.reset()
                let now = Date().timeIntervalSince1970
                if worker.isCurrent(generation), now - lastDetection >= 0.25 {
                    lastDetection = now
                    Self.emit("detected")
                }
            }
        }
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "WakeWordDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func emit(_ kind: String) {
        Bridge.sendTypedMessage("wake_word", body: [
            "kind": kind,
            "phrase": phrase,
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ])
    }
}
