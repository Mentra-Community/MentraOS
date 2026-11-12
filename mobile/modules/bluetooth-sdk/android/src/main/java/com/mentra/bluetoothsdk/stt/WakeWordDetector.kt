package com.mentra.bluetoothsdk.stt

import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.mentra.bluetoothsdk.Bridge
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicLong

/**
 * Demand-driven keyword spotting ("Hey Mentra") on the 16 kHz mono microphone PCM.
 *
 * The model comes from the directory the host passes when enabling (the Speech-page download),
 * not from bundled assets. One worker thread owns the spotter: it loads, runs and releases it.
 * Control tasks are never dropped; when the worker falls behind only audio frames are dropped,
 * so a caller waiting on [configure] always gets an answer.
 */
internal object WakeWordDetector {
    const val PHRASE = "Hey Mentra"
    private const val SAMPLE_RATE = 16000
    private const val AUDIO_CAPACITY = 100
    private const val DETECTION_COOLDOWN_MS = 250L

    /** Files the model directory must contain. */
    val MODEL_FILES =
        listOf("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "keywords.txt")

    private sealed class Task {
        class Audio(val pcm: ByteArray, val generation: Long) : Task()
        class Control(val action: () -> Unit) : Task()
    }

    private val queue = BoundedAudioQueue<Task>(AUDIO_CAPACITY) { it is Task.Audio }
    private val generation = AtomicLong(0)
    @Volatile private var active = false
    @Volatile private var workerThread: Thread? = null

    // Accessed only on the worker thread, including release.
    private var engine: Engine? = null
    private var lastDetection = 0L

    /** The loaded spotter and its stream. */
    private class Engine(val modelDir: String, val spotter: KeywordSpotter, val stream: OnlineStream) {
        fun release() {
            stream.release()
            spotter.release()
        }
    }

    /**
     * Enable (loading the model from [modelDir]) or disable (releasing the stream and the model).
     * Blocks the calling thread (a background dispatcher) until the worker has done it: enabling
     * returns after the model is loaded and `ready` was emitted, and throws when loading fails
     * (no `wake_word` event; the caller reports the rejection).
     */
    fun configure(enabled: Boolean, modelDir: String?) {
        if (enabled && modelDir.isNullOrBlank()) {
            throw IllegalArgumentException("modelDir is required to enable wake-word detection")
        }
        active = false
        val token = generation.incrementAndGet()
        val done = CompletableFuture<Unit>()
        submit {
            try {
                if (enabled) enable(modelDir!!, token) else disable()
                done.complete(Unit)
            } catch (error: Throwable) {
                done.completeExceptionally(error)
            }
        }
        try {
            done.get()
        } catch (error: ExecutionException) {
            throw error.cause ?: error
        }
    }

    /** Release the model without waiting (module teardown). */
    fun shutdown() {
        active = false
        generation.incrementAndGet()
        submit { disable() }
    }

    private fun enable(modelDir: String, token: Long) {
        lastDetection = 0
        val loaded = engine
        if (loaded != null && loaded.modelDir == modelDir) {
            loaded.spotter.reset(loaded.stream)
        } else {
            disable()
            try {
                engine = load(modelDir)
            } catch (error: Throwable) {
                // The caller's promise rejects; the engine reports it as a wake_word error.
                val message =
                    when (error) {
                        is LinkageError -> "On-device wake-word detection is not available in this build"
                        else -> error.message ?: "Could not load the wake-word model"
                    }
                throw IllegalStateException(message, error)
            }
        }
        // A newer configure() call supersedes this one: don't report or listen for it.
        if (token != generation.get()) return
        active = true
        emit("ready", token)
    }

    private fun disable() {
        val loaded = engine ?: return
        engine = null
        try {
            loaded.release()
        } catch (error: Exception) {
            Bridge.log("WAKE_WORD: release failed: ${error.message}")
        }
        Bridge.log("WAKE_WORD: model released")
    }

    private fun load(modelDir: String): Engine {
        val dir = File(modelDir)
        val missing = MODEL_FILES.filter { name -> !File(dir, name).let { it.isFile && it.length() > 0 } }
        if (missing.isNotEmpty()) {
            throw IllegalStateException("Wake-word model is incomplete; missing ${missing.joinToString()}")
        }
        fun path(name: String) = File(dir, name).absolutePath
        val model =
            OnlineModelConfig(
                transducer =
                    OnlineTransducerModelConfig(
                        encoder = path("encoder.int8.onnx"),
                        decoder = path("decoder.onnx"),
                        joiner = path("joiner.int8.onnx"),
                    ),
                tokens = path("tokens.txt"),
                numThreads = 1,
            )
        val config =
            KeywordSpotterConfig(
                modelConfig = model,
                keywordsFile = path("keywords.txt"),
                numTrailingBlanks = 1,
                maxActivePaths = 8,
            )
        // Null AssetManager: load from files.
        val spotter = KeywordSpotter(null, config)
        val stream =
            try {
                spotter.createStream("")
            } catch (error: Exception) {
                spotter.release()
                throw error
            }
        Bridge.log("WAKE_WORD: model loaded from $modelDir")
        return Engine(modelDir, spotter, stream)
    }

    /** Called on the audio thread. Never loads or runs the model there. */
    fun accept(pcm: ByteArray) {
        if (!active || pcm.isEmpty() || pcm.size % 2 != 0) return
        queue.offer(Task.Audio(pcm.copyOf(), generation.get()))
        ensureWorker()
    }

    private fun process(task: Task.Audio) {
        if (!active || task.generation != generation.get()) return
        val loaded = engine ?: return
        try {
            val samples =
                FloatArray(task.pcm.size / 2) { i ->
                    val sample =
                        ((task.pcm[i * 2].toInt() and 0xff) or (task.pcm[i * 2 + 1].toInt() shl 8)).toShort()
                    sample.toFloat() / 32768f
                }
            loaded.stream.acceptWaveform(samples, SAMPLE_RATE)
            while (loaded.spotter.isReady(loaded.stream)) {
                loaded.spotter.decode(loaded.stream)
                if (loaded.spotter.getResult(loaded.stream).keyword.isNotEmpty()) {
                    loaded.spotter.reset(loaded.stream)
                    val now = System.currentTimeMillis()
                    if (active && task.generation == generation.get() && now - lastDetection >= DETECTION_COOLDOWN_MS) {
                        lastDetection = now
                        emit("detected", task.generation)
                    }
                }
            }
        } catch (error: Exception) {
            if (task.generation == generation.get()) {
                active = false
                emit("error", task.generation, error.message ?: "Wake-word detection failed")
            }
        }
    }

    private fun emit(kind: String, token: Long, message: String? = null) {
        if (token != generation.get()) return
        Bridge.sendWakeWord(kind, PHRASE, message)
    }

    private fun submit(action: () -> Unit) {
        queue.offer(Task.Control(action))
        ensureWorker()
    }

    private fun ensureWorker() {
        if (workerThread != null) return
        synchronized(this) {
            if (workerThread != null) return
            workerThread =
                Thread({ runLoop() }, "WakeWordDetector").apply {
                    isDaemon = true
                    start()
                }
        }
    }

    private fun runLoop() {
        while (true) {
            when (val task = queue.poll(60_000) ?: continue) {
                is Task.Audio -> process(task)
                is Task.Control ->
                    try {
                        task.action()
                    } catch (error: Throwable) {
                        Bridge.log("WAKE_WORD: control task failed: ${error.message}")
                    }
            }
        }
    }
}
