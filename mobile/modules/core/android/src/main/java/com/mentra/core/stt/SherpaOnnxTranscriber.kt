package com.mentra.mentra.stt

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.k2fsa.sherpa.onnx.*
import com.mentra.core.Bridge
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.BlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SherpaOnnxTranscriber handles real-time audio transcription using Sherpa-ONNX.
 *
 * It works fully offline and processes PCM audio in real-time to provide partial and final ASR
 * results. This class runs on a background thread, processes short PCM chunks, and emits
 * transcribed text using a listener.
 *
 * Ported from iOS SherpaOnnxTranscriber.swift to match iOS functionality 1:1
 */
class SherpaOnnxTranscriber(private val context: Context) {
    companion object {
        private const val TAG = "SherpaOnnxTranscriber"
        private const val SAMPLE_RATE = 16000 // Sherpa-ONNX model's required sample rate
        private const val QUEUE_CAPACITY = 100 // Max number of audio buffers to keep in queue
        private const val PREFS_NAME = "MentraPrefs"
        private const val KEY_STT_MODEL_PATH = "STTModelPath"
        private const val KEY_STT_MODEL_LANGUAGE = "STTModelLanguageCode"
    }

    /** Interface to receive transcription results from Sherpa-ONNX */
    interface TranscriptListener {
        /** Called with live partial transcription (not final yet) */
        fun onPartialResult(text: String, language: String)

        /** Called when an utterance ends and final text is available */
        fun onFinalResult(text: String, language: String)
    }

    private val pcmQueue: BlockingQueue<ByteArray> = ArrayBlockingQueue(QUEUE_CAPACITY)
    private val running = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var workerThread: Thread? = null
    private var recognizer: OnlineRecognizer? = null
    private var stream: OnlineStream? = null

    private var lastPartialResult = ""
    @Volatile private var transcriptListener: TranscriptListener? = null

    private val restartLock = Any()
    private var restartRunning = false

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Get the custom model path from SharedPreferences Resolves relative paths from Documents
     * directory
     */
    private fun getCustomModelPath(): String? {
        val storedPath = prefs.getString(KEY_STT_MODEL_PATH, null) ?: return null

        // Always resolve to absolute path if it contains "Documents/"
        // This handles app ID changes between dev builds
        if (storedPath.contains("/Documents/")) {
            val documentsDir =
                    context.filesDir // In Android, this is the app's private files directory
            val relativePath = storedPath.substringAfter("/Documents/")
            val fixedPath = File(documentsDir, relativePath).absolutePath
            Bridge.log("Reconstructed STTModelPath: $fixedPath")
            return fixedPath
        }

        Bridge.log("STTModelPath (raw): $storedPath")
        return storedPath
    }

    /** Get the model language code from SharedPreferences */
    private fun getModelLanguage(): String {
        return prefs.getString(KEY_STT_MODEL_LANGUAGE, "en-US") ?: "en-US"
    }

    /**
     * Initialize the Sherpa-ONNX recognizer. Loads models and configuration, sets up processing
     * thread.
     */
    fun initialize() {
        try {
            val modelPath = getCustomModelPath()

            if (modelPath == null) {
                Bridge.log("No Sherpa ONNX model available. Transcription will be disabled.")
                Bridge.log("Please download a model using the model downloader in settings.")
                recognizer = null
                stream = null
                return
            }

            val modelDir = File(modelPath)
            if (!modelDir.exists() || !modelDir.isDirectory) {
                Bridge.log("Model path does not exist or is not a directory: $modelPath")
                recognizer = null
                stream = null
                return
            }

            val tokensPath = File(modelDir, "tokens.txt").absolutePath
            val tokensFile = File(tokensPath)

            if (!tokensFile.exists()) {
                throw IllegalStateException("tokens.txt not found at path: $modelPath")
            }

            val modelType: String
            val modelConfig = OnlineModelConfig()

            // Detect model type based on available files
            val ctcModelFile = File(modelDir, "model.int8.onnx")
            val transducerEncoderFile = File(modelDir, "encoder.onnx")

            when {
                ctcModelFile.exists() -> {
                    // CTC model detected
                    modelType = "ctc"
                    Bridge.log("Detected CTC model at $modelPath")

                    val nemoCtc = OnlineNeMoCtcModelConfig()
                    nemoCtc.model = ctcModelFile.absolutePath

                    modelConfig.tokens = tokensPath
                    modelConfig.numThreads = 1
                    modelConfig.neMoCtc = nemoCtc
                }
                transducerEncoderFile.exists() -> {
                    // Transducer model detected
                    modelType = "transducer"
                    Bridge.log("Detected transducer model at $modelPath")

                    val decoderFile = File(modelDir, "decoder.onnx")
                    val joinerFile = File(modelDir, "joiner.onnx")

                    if (!decoderFile.exists() || !joinerFile.exists()) {
                        throw IllegalStateException(
                                "Transducer model files incomplete at path: $modelPath"
                        )
                    }

                    val transducer = OnlineTransducerModelConfig()
                    transducer.encoder = transducerEncoderFile.absolutePath
                    transducer.decoder = decoderFile.absolutePath
                    transducer.joiner = joinerFile.absolutePath

                    modelConfig.tokens = tokensPath
                    modelConfig.transducer = transducer
                    modelConfig.numThreads = 1
                }
                else -> {
                    throw IllegalStateException("No valid model files found at path: $modelPath")
                }
            }

            // Configure recognizer
            val config = OnlineRecognizerConfig()
            config.modelConfig = modelConfig
            config.decodingMethod = "greedy_search"
            config.enableEndpoint = true

            // Create recognizer (pass null for AssetManager since we're using file paths)
            recognizer =
                    try {
                        OnlineRecognizer(null, config)
                    } catch (e: Exception) {
                        Log.e(
                                TAG,
                                "Failed to create OnlineRecognizer - model file may be corrupted or incomplete",
                                e
                        )
                        null
                    }

            if (recognizer == null) {
                throw IllegalStateException("Failed to create recognizer")
            }

            stream = recognizer?.createStream("")

            startProcessingThread()
            running.set(true)

            Bridge.log("Sherpa-ONNX ASR initialized successfully with $modelType model")
        } catch (e: Exception) {
            Bridge.log("Failed to initialize Sherpa-ONNX: ${e.message}")
            Log.e(TAG, "Failed to initialize Sherpa-ONNX", e)

            // Clean up any partially initialized resources
            stream?.let {
                try {
                    it.release()
                } catch (releaseEx: Exception) {
                    Log.e(TAG, "Error releasing stream after initialization failure", releaseEx)
                }
            }
            stream = null

            recognizer?.let {
                try {
                    it.release()
                } catch (releaseEx: Exception) {
                    Log.e(TAG, "Error releasing recognizer after initialization failure", releaseEx)
                }
            }
            recognizer = null

            running.set(false)
        }
    }

    /**
     * Feed PCM audio data (16-bit little endian) into the transcriber. This method should be called
     * continuously with short chunks (e.g., 100-300ms).
     *
     * Note: Audio passed to this method is assumed to have already passed VAD elsewhere, so it's
     * directly queued for processing without additional VAD checks.
     */
    fun acceptAudio(pcm16le: ByteArray) {
        if (!running.get()) {
            // Bridge.log("⚠️ Ignoring audio - transcriber not running")
            return
        }

        // Directly queue the audio data for processing
        if (!pcmQueue.offer(pcm16le.copyOf())) {
            // Queue is full, drop oldest and try again
            pcmQueue.poll()
            pcmQueue.offer(pcm16le.copyOf())
            Bridge.log("⚠️ Audio queue overflow - dropped buffer")
        }
    }

    /** Start a background thread to continuously consume audio and decode using Sherpa */
    private fun startProcessingThread() {
        Bridge.log("🚀 Starting Sherpa-ONNX processing thread...")

        workerThread =
                Thread({ runLoop() }, "SherpaOnnxProcessor").apply {
                    isDaemon = true
                    start()
                }
    }

    /**
     * Main processing loop that handles transcription in real-time. Pulls audio from queue, feeds
     * into Sherpa, emits partial/final results.
     */
    private fun runLoop() {
        Bridge.log("🔄 Sherpa-ONNX processing loop started")

        while (running.get()) {
            try {
                val currentRecognizer = recognizer
                val currentStream = stream

                if (currentRecognizer == null || currentStream == null) {
                    Bridge.log("⚠️ Recognizer or stream not available, skipping audio chunk")
                    Thread.sleep(100)
                    continue
                }

                // Pull data from queue with timeout
                val audioData = pcmQueue.poll(50, java.util.concurrent.TimeUnit.MILLISECONDS)

                if (audioData != null) {
                    // Convert PCM to float [-1.0, 1.0]
                    val floatBuf = toFloatArray(audioData)

                    // Pass audio data to the Sherpa-ONNX stream
                    currentStream.acceptWaveform(floatBuf, SAMPLE_RATE)

                    // Decode continuously while model is ready
                    var decodeCount = 0
                    while (currentRecognizer.isReady(currentStream)) {
                        currentRecognizer.decode(currentStream)
                        decodeCount++
                    }

                    // If utterance endpoint detected
                    if (currentRecognizer.isEndpoint(currentStream)) {
                        val result = currentRecognizer.getResult(currentStream)
                        val finalText = result.text.trim()

                        if (finalText.isNotEmpty()) {
                            handleTranscriptionResult(finalText, isFinal = true)
                        }

                        currentRecognizer.reset(currentStream) // Start new utterance
                        lastPartialResult = ""
                    } else {
                        // Emit partial results if changed
                        val result = currentRecognizer.getResult(currentStream)
                        val partial = result.text.trim()

                        if (partial != lastPartialResult && partial.isNotEmpty()) {
                            handleTranscriptionResult(partial, isFinal = false)
                            lastPartialResult = partial
                        }
                    }
                }
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Bridge.log("Processing thread interrupted")
                break
            } catch (e: Exception) {
                Log.e(TAG, "Error processing audio", e)
                // Attempt stream reset to recover
                try {
                    recognizer?.let { rec -> stream?.let { str -> rec.reset(str) } }
                } catch (resetEx: Exception) {
                    Log.e(TAG, "Failed to reset stream after error", resetEx)
                }
            }
        }

        Bridge.log("ASR processing thread stopped")
    }

    /** Convert 16-bit PCM byte data (little-endian) to float array [-1.0, 1.0] */
    private fun toFloatArray(pcmData: ByteArray): FloatArray {
        val count = pcmData.size / 2
        val samples = FloatArray(count)

        val buffer = ByteBuffer.wrap(pcmData).order(ByteOrder.LITTLE_ENDIAN)

        for (i in 0 until count) {
            samples[i] = buffer.short / 32768.0f
        }

        return samples
    }

    /** Handle transcription results - send to listener on main thread */
    private fun handleTranscriptionResult(text: String, isFinal: Boolean) {
        val language = getModelLanguage()

        // Forward to listener on main thread
        mainHandler.post {
            transcriptListener?.let { listener ->
                if (isFinal) {
                    listener.onFinalResult(text, language)
                } else {
                    listener.onPartialResult(text, language)
                }
            }
        }
    }

    /**
     * Stop transcription processing. This shuts down the processing thread and releases Sherpa-ONNX
     * resources.
     */
    fun shutdown() {
        Bridge.log("🛑 Shutting down SherpaOnnxTranscriber...")

        running.set(false)

        workerThread?.let { thread ->
            thread.interrupt()
            try {
                thread.join(500)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        workerThread = null

        try {
            stream?.let {
                Bridge.log("🧹 Cleaning up Sherpa-ONNX stream")
                it.release()
            }
            stream = null

            recognizer?.let {
                Bridge.log("🧹 Cleaning up Sherpa-ONNX recognizer")
                it.release()
            }
            recognizer = null
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing Sherpa resources", e)
        }

        // Clear any remaining audio buffers
        val remainingBuffers = pcmQueue.size
        if (remainingBuffers > 0) {
            Bridge.log("🗑️ Clearing $remainingBuffers remaining audio buffers")
        }
        pcmQueue.clear()

        Bridge.log("✅ SherpaOnnxTranscriber shutdown complete")
    }

    /**
     * Restarts the transcriber after a model change. Shuts down existing resources, clears buffers,
     * and reinitializes the recognizer.
     */
    fun restart() {
        synchronized(restartLock) {
            if (restartRunning) {
                Bridge.log("Restart already in progress, skipping")
                return
            }
            restartRunning = true
        }

        try {
            Bridge.log("♻️ Restarting SherpaOnnxTranscriber...")
            shutdown()
            // Small delay to ensure cleanup completes
            Thread.sleep(100)
            initialize()
        } catch (e: Exception) {
            Log.e(TAG, "Error during transcriber restart", e)
        } finally {
            synchronized(restartLock) { restartRunning = false }
        }
    }

    /** Register a listener to receive partial and final transcription updates */
    fun setTranscriptListener(listener: TranscriptListener?) {
        transcriptListener = listener
    }

    /** Check if the transcriber was successfully initialized */
    fun isInitialized(): Boolean {
        return recognizer != null && stream != null
    }

    /** Handle microphone state changes */
    fun microphoneStateChanged(state: Boolean) {
        if (!state) {
            // Microphone turned off - clear queue and reset stream
            pcmQueue.clear()

            recognizer?.let { rec ->
                stream?.let { str ->
                    try {
                        rec.reset(str)
                        lastPartialResult = ""
                        Log.d(TAG, "Microphone off — stream reset")
                    } catch (e: Exception) {
                        Log.e(TAG, "Error resetting stream on mic off", e)
                    }
                }
            }
        } else {
            Log.d(TAG, "Microphone on")
        }
    }
}
