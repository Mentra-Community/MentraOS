package com.mentra.bluetoothsdk.stt

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.utils.NativeLog as Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Real-time on-device transcription with Sherpa-ONNX.
 *
 * Each loaded model is a session with its own worker thread. Audio and control requests
 * (finish, reset, release) go through one bounded queue, and the session's native recognizer
 * and stream are only ever touched on that worker, including when they are released. Replacing
 * or shutting down a session therefore never frees native memory that a decode is still using:
 * the release runs on the worker after the audio already queued to it.
 *
 * [initialModelPath] / [initialModelLanguage] pin a specific model; without them the model
 * stored by [STTTools.setSttModelDetails] is used.
 */
class SherpaOnnxTranscriber
@JvmOverloads
constructor(
    private val context: Context,
    private var initialModelPath: String? = null,
    private var initialModelLanguage: String? = null,
) {
    companion object {
        private const val TAG = "SherpaOnnxTranscriber"
        private const val SAMPLE_RATE = 16000 // Sherpa-ONNX model's required sample rate
        private const val QUEUE_CAPACITY = 100 // Max number of audio buffers to keep in queue

        /**
         * Streaming transducers (Zipformer, including Kroko) decode in real time on low-end
         * phones only with several threads. Decided by model type, never by folder name, and
         * the same on iOS.
         */
        internal const val TRANSDUCER_THREADS = 4
        internal const val CTC_THREADS = 1

        /** How long [finishUtterance] waits for the worker before giving up. */
        internal const val FINISH_TIMEOUT_MS = 3_000L
    }

    /** Interface to receive transcription results from Sherpa-ONNX */
    interface TranscriptListener {
        /** Called with live partial transcription (not final yet) */
        fun onPartialResult(text: String, language: String)

        /** Called when an utterance ends and final text is available */
        fun onFinalResult(text: String, language: String)
    }

    internal enum class ModelType {
        /** Streaming transducer: can be finalized early. */
        TRANSDUCER,
        /** Streaming NeMo CTC. */
        CTC,
    }

    private sealed class Item {
        class Audio(val pcm: ByteArray) : Item()
        class Finish(val result: CompletableFuture<String?>) : Item()
        object Reset : Item()
        object Close : Item()
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var transcriptListener: TranscriptListener? = null
    @Volatile private var session: Session? = null
    private val lifecycleLock = Any()

    /** One loaded model and its worker. */
    private inner class Session(
        /** Path as selected (before resolving a stale Documents prefix). */
        val requestedPath: String,
        /** Directory the model was loaded from. */
        val modelPath: String,
        val language: String,
        val modelType: ModelType,
        val casing: SttTextFormatter.Casing,
        private val recognizer: OnlineRecognizer,
        private var stream: OnlineStream,
    ) {
        private val queue = BoundedAudioQueue<Item>(QUEUE_CAPACITY) { it is Item.Audio }
        @Volatile var closed = false
            private set
        private var lastPartialResult = ""
        private var lastDropLogAt = 0L
        private val worker = Thread({ runLoop() }, "SherpaOnnxProcessor").apply { isDaemon = true }

        fun start() = worker.start()

        fun accept(pcm: ByteArray) {
            if (closed) return
            if (queue.offer(Item.Audio(pcm)) != null) {
                val now = System.currentTimeMillis()
                if (now - lastDropLogAt > 5_000) {
                    lastDropLogAt = now
                    Bridge.log("STT: audio queue full; dropped ${queue.droppedAudio} buffer(s) so far")
                }
            }
        }

        fun finish(): CompletableFuture<String?> {
            val result = CompletableFuture<String?>()
            if (closed) {
                result.complete(null)
            } else {
                queue.offer(Item.Finish(result))
            }
            return result
        }

        fun reset() {
            if (closed) return
            queue.clearAudio()
            queue.offer(Item.Reset)
        }

        /** Release after the audio already queued; returns immediately. */
        fun close() {
            if (closed) return
            closed = true
            queue.offer(Item.Close)
        }

        private fun runLoop() {
            try {
                while (true) {
                    when (val item = queue.poll(1_000) ?: continue) {
                        is Item.Audio -> decode(item.pcm)
                        is Item.Finish -> finishStream(item.result)
                        Item.Reset -> resetStream()
                        Item.Close -> return
                    }
                }
            } finally {
                for (item in queue.drain()) {
                    if (item is Item.Finish) item.result.complete(null)
                }
                try {
                    stream.release()
                    recognizer.release()
                } catch (e: Exception) {
                    Log.e(TAG, "Error releasing Sherpa resources", e)
                }
                Bridge.log("STT: released model at $modelPath")
            }
        }

        private fun decode(pcm: ByteArray) {
            try {
                stream.acceptWaveform(toFloatArray(pcm), SAMPLE_RATE)
                while (recognizer.isReady(stream)) {
                    recognizer.decode(stream)
                }
                val text = recognizer.getResult(stream).text.trim()
                if (recognizer.isEndpoint(stream)) {
                    if (text.isNotEmpty()) deliver(this, text, isFinal = true, onDelivered = null)
                    recognizer.reset(stream) // Start new utterance
                    lastPartialResult = ""
                } else if (text.isNotEmpty() && text != lastPartialResult) {
                    deliver(this, text, isFinal = false, onDelivered = null)
                    lastPartialResult = text
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error processing audio", e)
                resetStream()
            }
        }

        private fun finishStream(result: CompletableFuture<String?>) {
            if (modelType != ModelType.TRANSDUCER) {
                result.complete(null)
                return
            }
            try {
                val startedAt = System.currentTimeMillis()
                val current = stream
                // Sherpa's streaming file decoder uses 660 ms of padding before inputFinished.
                // This is synthetic context, decoded immediately; it is not a wall-clock wait.
                current.acceptWaveform(FloatArray(SAMPLE_RATE * 66 / 100), SAMPLE_RATE)
                current.inputFinished()
                while (recognizer.isReady(current)) recognizer.decode(current)
                val text = recognizer.getResult(current).text.trim()
                // An ended stream cannot accept new samples. Keep the model, replace the stream.
                stream = recognizer.createStream("")
                current.release()
                lastPartialResult = ""
                Bridge.log(
                    "STT_FINISH elapsedMs=${System.currentTimeMillis() - startedAt} characters=${text.length}"
                )
                if (text.isEmpty()) {
                    result.complete("")
                } else {
                    // Resolve only once the final event has been handed to the bridge.
                    deliver(this, text, isFinal = true) { formatted -> result.complete(formatted) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error finishing utterance", e)
                result.complete(null)
                resetStream()
            }
        }

        private fun resetStream() {
            try {
                recognizer.reset(stream)
                lastPartialResult = ""
            } catch (e: Exception) {
                Log.e(TAG, "Failed to reset stream", e)
            }
        }
    }

    /**
     * Get the custom model path from SharedPreferences. Resolves a stale Documents prefix
     * (app id changes between dev builds) against the current files directory.
     */
    private fun resolveModelPath(storedPath: String): String {
        if (storedPath.contains("/Documents/")) {
            val relativePath = storedPath.substringAfter("/Documents/")
            val fixedPath = File(context.filesDir, relativePath).absolutePath
            Bridge.log("Reconstructed STTModelPath: $fixedPath")
            return fixedPath
        }
        return storedPath
    }

    /**
     * Load the model now (synchronously, on the calling thread), replacing any loaded one.
     * The previous model is released on its own worker after the audio queued to it.
     * Throws when there is no model or it can't be loaded.
     */
    internal fun load() {
        val requestedPath =
            initialModelPath?.takeIf { it.isNotBlank() }
                ?: STTTools.getSttModelPath(context).takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("No on-device speech model is selected")
        val language = initialModelLanguage ?: STTTools.getSttModelLanguage(context)
        val modelPath = resolveModelPath(requestedPath)
        val next = createSession(requestedPath, modelPath, language)
        val previous =
            synchronized(lifecycleLock) {
                val old = session
                session = next
                old
            }
        next.start()
        previous?.close()
        Bridge.log("Sherpa-ONNX ASR initialized with ${next.modelType} model at $modelPath")
    }

    private fun createSession(requestedPath: String, modelPath: String, language: String): Session {
        val modelDir = File(modelPath)
        if (!modelDir.isDirectory) {
            throw IllegalStateException("Model path does not exist or is not a directory: $modelPath")
        }
        val tokensFile = File(modelDir, "tokens.txt")
        if (!tokensFile.isFile) {
            throw IllegalStateException("tokens.txt not found at path: $modelPath")
        }

        val modelConfig = OnlineModelConfig()
        modelConfig.tokens = tokensFile.absolutePath
        val ctcModelFile = findReadableFile(modelDir, listOf("model.int8.onnx", "model.onnx"))
        val encoderFile = findReadableFile(modelDir, listOf("encoder.onnx", "encoder.int8.onnx"))
        val modelType: ModelType
        when {
            ctcModelFile.exists() -> {
                modelType = ModelType.CTC
                val nemoCtc = OnlineNeMoCtcModelConfig()
                nemoCtc.model = ctcModelFile.absolutePath
                modelConfig.neMoCtc = nemoCtc
                modelConfig.numThreads = CTC_THREADS
            }
            encoderFile.exists() -> {
                modelType = ModelType.TRANSDUCER
                val decoderFile = findReadableFile(modelDir, listOf("decoder.onnx", "decoder.int8.onnx"))
                val joinerFile = findReadableFile(modelDir, listOf("joiner.onnx", "joiner.int8.onnx"))
                if (!decoderFile.exists() || !joinerFile.exists()) {
                    throw IllegalStateException("Transducer model files incomplete at path: $modelPath")
                }
                val transducer = OnlineTransducerModelConfig()
                transducer.encoder = encoderFile.absolutePath
                transducer.decoder = decoderFile.absolutePath
                transducer.joiner = joinerFile.absolutePath
                modelConfig.transducer = transducer
                modelConfig.numThreads = TRANSDUCER_THREADS
            }
            else -> throw IllegalStateException("No valid model files found at path: $modelPath")
        }

        val config = OnlineRecognizerConfig()
        config.modelConfig = modelConfig
        config.decodingMethod = "greedy_search"
        config.enableEndpoint = true

        // Null AssetManager: the model is loaded from file paths.
        val recognizer = OnlineRecognizer(null, config)
        val stream =
            try {
                recognizer.createStream("")
            } catch (e: Exception) {
                recognizer.release()
                throw e
            }
        return Session(
            requestedPath = requestedPath,
            modelPath = modelPath,
            language = language,
            modelType = modelType,
            casing = SttTextFormatter.casingForModel(modelDir),
            recognizer = recognizer,
            stream = stream,
        )
    }

    private fun findReadableFile(modelDir: File, candidates: List<String>): File {
        return candidates.map { File(modelDir, it) }.firstOrNull { file ->
            file.exists() && file.canRead() && file.length() > 0
        } ?: File(modelDir, candidates.first())
    }

    /**
     * Initialize the Sherpa-ONNX recognizer. Loads the model and starts its worker. On failure
     * the transcriber stays uninitialized (see [isInitialized]).
     */
    fun initialize() {
        try {
            load()
        } catch (e: Exception) {
            Bridge.log("Failed to initialize Sherpa-ONNX: ${e.message}")
            Log.e(TAG, "Failed to initialize Sherpa-ONNX", e)
        }
    }

    /**
     * Feed PCM audio data (16-bit little endian, 16 kHz mono). Never blocks and never touches
     * native code on the calling thread.
     */
    fun acceptAudio(pcm16le: ByteArray) {
        session?.accept(pcm16le.copyOf())
    }

    /** Whether the loaded model can finish its current utterance early (streaming transducer). */
    internal val canFinalize: Boolean
        get() = session?.modelType == ModelType.TRANSDUCER

    /** The selected path of the loaded model, or null. Lock-free. */
    internal val loadedModelPath: String?
        get() = session?.requestedPath

    /** Whether [path] is the loaded model. Lock-free. */
    internal fun isModelLoaded(path: String): Boolean {
        val current = session ?: return false
        return current.requestedPath == path || current.modelPath == path
    }

    /**
     * Finish the current utterance after all PCM queued before this call. Returns the final
     * text once its final result has been delivered to the listener, `""` when nothing was
     * pending, or null when no model is loaded, the model can't finalize early (not a
     * streaming transducer), or the worker didn't answer within [timeoutMs].
     */
    internal fun finishUtterance(timeoutMs: Long = FINISH_TIMEOUT_MS): String? {
        val current = session ?: return null
        if (current.modelType != ModelType.TRANSDUCER) return null
        return try {
            current.finish().get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: java.util.concurrent.TimeoutException) {
            Bridge.log("STT: finishUtterance timed out after ${timeoutMs}ms")
            null
        } catch (e: Exception) {
            Bridge.log("STT: finishUtterance failed: ${e.message}")
            null
        }
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

    /**
     * Format with the loaded model's casing and deliver on the main thread. [onDelivered] runs
     * right after the listener, with the delivered text.
     */
    private fun deliver(
        from: Session,
        text: String,
        isFinal: Boolean,
        onDelivered: ((String) -> Unit)?,
    ) {
        val formatted = SttTextFormatter.format(text, from.casing)
        mainHandler.post {
            try {
                transcriptListener?.let { listener ->
                    if (isFinal) {
                        listener.onFinalResult(formatted, from.language)
                    } else {
                        listener.onPartialResult(formatted, from.language)
                    }
                }
            } finally {
                onDelivered?.invoke(formatted)
            }
        }
    }

    /**
     * Stop transcription. Returns immediately; the model is released on its worker after the
     * audio already queued to it.
     */
    fun shutdown() {
        val previous =
            synchronized(lifecycleLock) {
                val old = session
                session = null
                old
            }
        previous?.close()
    }

    /** Reload the selected model (for example after a model change). */
    fun restart() {
        initialModelPath = null
        initialModelLanguage = null
        Bridge.log("Restarting SherpaOnnxTranscriber")
        initialize()
    }

    /** Register a listener to receive partial and final transcription updates */
    fun setTranscriptListener(listener: TranscriptListener?) {
        transcriptListener = listener
    }

    /** Check if the transcriber was successfully initialized */
    fun isInitialized(): Boolean = session != null

    /** Handle microphone state changes: turning off drops queued audio and starts a new utterance. */
    fun microphoneStateChanged(state: Boolean) {
        if (!state) session?.reset()
    }
}
