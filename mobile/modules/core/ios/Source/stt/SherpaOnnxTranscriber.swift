import Foundation
import UIKit

/**
 * SherpaOnnxTranscriber handles real-time audio transcription using Sherpa-ONNX.
 *
 * It works fully offline and processes PCM audio in real-time to provide partial and final ASR results.
 * This class runs on a background thread, processes short PCM chunks, and emits transcribed text using a delegate.
 */
class SherpaOnnxTranscriber {
    private static let TAG = "SherpaOnnxTranscriber"

    private static let SAMPLE_RATE = 16000 // Sherpa-ONNX model's required sample rate
    private static let QUEUE_CAPACITY = 100 // Max number of audio buffers to keep in queue

    private let pcmQueue = DispatchQueue(label: "com.augmentos.sherpaonnx.pcmQueue", qos: .userInteractive)
    private var pcmBuffers = [Data]()
    private var isRunning = false
    private var processingQueue: DispatchQueue?
    private var processingTask: DispatchWorkItem?

    // The underlying Sherpa-ONNX objects
    private var recognizer: SherpaOnnxRecognizer?

    private var lastPartialResult = ""

    // Parent context
    private weak var context: UIViewController?

    // Session start time for relative timestamps
    private var transcriptionSessionStart: Date

    // Dynamic model path support
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

    /**
     * Constructor that accepts a UIViewController to load model assets.
     */
    init(context: UIViewController) {
        self.context = context
        transcriptionSessionStart = Date()
    }

    deinit {
        shutdown()
    }

    /**
     * Initialize the Sherpa-ONNX recognizer.
     * Loads models and configuration, sets up processing thread.
     */
    func initialize() {
        do {
            var tokensPath: String
            var modelType = "unknown"
            let fileManager = FileManager.default

            // Check if we have a custom model path set
            if let customPath = SherpaOnnxTranscriber.customModelPath {
                // Detect model type based on available files
                let ctcModelPath = (customPath as NSString).appendingPathComponent("model.int8.onnx")
                let transducerEncoderPath = (customPath as NSString).appendingPathComponent("encoder.onnx")

                tokensPath = (customPath as NSString).appendingPathComponent("tokens.txt")

                // Verify tokens file exists
                guard fileManager.fileExists(atPath: tokensPath) else {
                    throw NSError(domain: "SherpaOnnxTranscriber", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "tokens.txt not found at path: \(customPath)",
                    ])
                }

                if fileManager.fileExists(atPath: ctcModelPath) {
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

                } else if fileManager.fileExists(atPath: transducerEncoderPath) {
                    // Transducer model detected
                    modelType = "transducer"
                    Bridge.log("Detected transducer model at \(customPath)")

                    let decoderPath = (customPath as NSString).appendingPathComponent("decoder.onnx")
                    let joinerPath = (customPath as NSString).appendingPathComponent("joiner.onnx")

                    // Verify all transducer files exist
                    guard fileManager.fileExists(atPath: decoderPath),
                          fileManager.fileExists(atPath: joinerPath)
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
                isRunning = false
                return
            }

            if recognizer == nil {
                throw NSError(domain: "SherpaOnnxTranscriber", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create recognizer"])
            }

            startProcessingTask()
            isRunning = true

            Bridge.log("Sherpa-ONNX ASR initialized successfully with \(modelType) model")

        } catch {
            Bridge.log("Failed to initialize Sherpa-ONNX: \(error.localizedDescription)")
        }
    }

    /**
     * Handle transcription results - send only to delegate
     */
    private func handleTranscriptionResult(text: String, isFinal: Bool) {
        // Forward to delegate if set
        DispatchQueue.main.async { [weak self] in
            if isFinal {
                STTTools.didReceiveFinalTranscription(text)
            } else {
                STTTools.didReceivePartialTranscription(text)
            }
        }
    }

    /**
     * Feed PCM audio data (16-bit little endian) into the transcriber.
     * This method should be called continuously with short chunks (e.g., 100-300ms).
     *
     * Note: Audio passed to this method is assumed to have already passed VAD elsewhere,
     * so it's directly queued for processing without additional VAD checks.
     */
    func acceptAudio(pcm16le: Data) {
        guard isRunning else {
            Bridge.log("⚠️ Ignoring audio - transcriber not running")
            return
        }

        // Directly queue the audio data for processing
        // No VAD check here as it's assumed to be done upstream
        queueAudioData(pcm16le)
    }

    private func queueAudioData(_ pcm16le: Data) {
        pcmQueue.async { [weak self] in
            guard let self = self else { return }

            let queueSizeBefore = self.pcmBuffers.count
            self.pcmBuffers.append(pcm16le)

            // Keep queue size manageable
            if self.pcmBuffers.count > Self.QUEUE_CAPACITY {
                let removedBuffer = self.pcmBuffers.removeFirst()
                Bridge.log("⚠️ Audio queue overflow - dropped buffer of \(removedBuffer.count) bytes")
            }
        }
    }

    /**
     * Start a background task to continuously consume audio and decode using Sherpa.
     */
    private func startProcessingTask() {
        Bridge.log("🚀 Starting Sherpa-ONNX processing task...")

        processingQueue = DispatchQueue(label: "com.augmentos.sherpaonnx.processor", qos: .userInitiated)

        let workItem = DispatchWorkItem { [weak self] in
            self?.runLoop()
        }

        processingTask = workItem
        processingQueue?.async(execute: workItem)
    }

    /**
     * Main processing loop that handles transcription in real-time.
     * Pulls audio from queue, feeds into Sherpa, emits partial/final results.
     */
    private func runLoop() {
        Bridge.log("🔄 Sherpa-ONNX processing loop started")

        while isRunning {
            // Pull data from queue
            var audioData: Data?

            pcmQueue.sync {
                if !self.pcmBuffers.isEmpty {
                    audioData = self.pcmBuffers.removeFirst()
                }
            }

            if let data = audioData {
                // Synchronize access to recognizer to prevent race conditions
                objc_sync_enter(self)
                defer { objc_sync_exit(self) }

                guard let recognizer = recognizer else {
                    Bridge.log("⚠️ Recognizer not available, skipping audio chunk")
                    continue
                }

                do {
                    // Convert PCM to float [-1.0, 1.0]
                    let floatBuf = toFloatArray(from: data)

                    // Pass audio data to the Sherpa-ONNX stream
                    recognizer.acceptWaveform(samples: floatBuf, sampleRate: Self.SAMPLE_RATE)

                    // Decode continuously while model is ready
                    var decodeCount = 0
                    while recognizer.isReady() {
                        recognizer.decode()
                        decodeCount += 1
                    }

                    // If utterance endpoint detected
                    if recognizer.isEndpoint() {
                        let result = recognizer.getResult()
                        let finalText = result.text.trimmingCharacters(in: .whitespacesAndNewlines)

                        if !finalText.isEmpty {
                            handleTranscriptionResult(text: finalText, isFinal: true)
                        }

                        recognizer.reset() // Start new utterance
                        lastPartialResult = ""
                    } else {
                        // Emit partial results if changed
                        let result = recognizer.getResult()
                        let partial = result.text.trimmingCharacters(in: .whitespacesAndNewlines)

                        if partial != lastPartialResult, !partial.isEmpty {
                            handleTranscriptionResult(text: partial, isFinal: false)
                            lastPartialResult = partial
                        }
                    }
                } catch {
                    Bridge.log("❌ Error processing audio: \(error.localizedDescription)")
                }
            } else {
                // Sleep briefly to avoid tight CPU loop if no audio is available
                Thread.sleep(forTimeInterval: 0.01)
            }
        }

        Bridge.log("ASR processing thread stopped")
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

    /**
     * Stop transcription processing.
     * This shuts down the processing thread and releases Sherpa-ONNX resources.
     */
    func shutdown() {
        Bridge.log("🛑 Shutting down SherpaOnnxTranscriber...")

        isRunning = false
        processingTask?.cancel()

        // Synchronize access to recognizer during shutdown
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }

        // The recognizer will be automatically cleaned up by ARC when set to nil
        if recognizer != nil {
            Bridge.log("🧹 Cleaning up Sherpa-ONNX recognizer")
            recognizer = nil
        }

        // Clear any remaining audio buffers
        pcmQueue.sync {
            let remainingBuffers = self.pcmBuffers.count
            if remainingBuffers > 0 {
                Bridge.log("🗑️ Clearing \(remainingBuffers) remaining audio buffers")
            }
            self.pcmBuffers.removeAll()
        }

        Bridge.log("✅ SherpaOnnxTranscriber shutdown complete")
    }

    /**
     * Restarts the transcriber after a model change.
     * Shuts down existing resources, clears buffers, and reinitializes the recognizer.
     */
    func restart() {
        Bridge.log("♻️ Restarting SherpaOnnxTranscriber...")
        shutdown()
        initialize()
    }
}
