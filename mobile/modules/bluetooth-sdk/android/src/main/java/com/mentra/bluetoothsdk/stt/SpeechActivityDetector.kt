package com.mentra.bluetoothsdk.stt

import android.content.Context
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import com.mentra.bluetoothsdk.Bridge
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.atomic.AtomicLong

/**
 * Silero voice activity from sherpa-onnx ([Vad]) on one 512-sample window at a time.
 *
 * Settings are shared with iOS (`SherpaOnnxVoiceActivityDetectorWrapper`) so both platforms
 * report the same transitions: threshold 0.5, 0.25 s minimum speech, [minSilenceMs] minimum
 * silence, and a 30 s speech cap (bounds the buffered segment) after which sherpa-onnx splits
 * long speech at shorter pauses.
 */
internal class SileroSpeechClassifier(context: Context, minSilenceMs: Int) : SpeechFrameClassifier {
    companion object {
        /** Model shipped in the SDK's assets. */
        const val MODEL_ASSET = "vad/silero_vad.onnx"
        const val THRESHOLD = 0.5f
        const val MIN_SPEECH_SECONDS = 0.25f
        const val MAX_SPEECH_SECONDS = 30f
    }

    private val vad =
        Vad(
            context.assets,
            VadModelConfig(
                sileroVadModelConfig =
                    SileroVadModelConfig(
                        model = MODEL_ASSET,
                        threshold = THRESHOLD,
                        minSilenceDuration = minSilenceMs / 1000f,
                        minSpeechDuration = MIN_SPEECH_SECONDS,
                        windowSize = SpeechActivityEngine.FRAME_SAMPLES,
                        maxSpeechDuration = MAX_SPEECH_SECONDS,
                    ),
                sampleRate = SpeechActivityEngine.SAMPLE_RATE,
                numThreads = 1,
            ),
        )

    override fun accept(frame: FloatArray): Boolean {
        vad.acceptWaveform(frame)
        // Speech segments are not used; drop them so memory stays flat.
        if (!vad.empty()) vad.clear()
        return vad.isSpeechDetected()
    }

    override fun reset() = vad.reset()

    override fun release() = vad.release()
}

/**
 * Phone-side speech activity on the same 16 kHz mono microphone PCM the wake word and on-device
 * transcription see, for every microphone source. Runs only while enabled; disabling releases
 * the model. Emits `speech_activity` on transitions only.
 *
 * One worker thread owns the classifier. Control tasks are never dropped; if the worker falls
 * behind, the oldest audio frames are.
 */
internal object SpeechActivityDetector {
    private const val AUDIO_CAPACITY = 200

    private sealed class Task {
        class Audio(val pcm: ByteArray, val generation: Long) : Task()
        class Control(val action: () -> Unit) : Task()
    }

    private val queue = BoundedAudioQueue<Task>(AUDIO_CAPACITY) { it is Task.Audio }
    private val generation = AtomicLong(0)
    @Volatile private var active = false
    @Volatile private var workerThread: Thread? = null

    /** Builds the classifier; replaced in tests. */
    @Volatile
    internal var classifierFactory: (minSilenceMs: Int) -> SpeechFrameClassifier = { minSilenceMs ->
        SileroSpeechClassifier(Bridge.getContext(), minSilenceMs)
    }

    /** Receives transitions; replaced in tests. */
    @Volatile
    internal var emitter: (speaking: Boolean, silentForMs: Long) -> Unit = { speaking, silentForMs ->
        Bridge.sendSpeechActivity(speaking, silentForMs)
    }

    @Volatile internal var clock: () -> Long = { SystemClock.elapsedRealtime() }

    // Written only on the worker thread.
    @Volatile private var classifier: SpeechFrameClassifier? = null
    private var engine: SpeechActivityEngine? = null

    /**
     * Enable with [minSilenceMs] (the quiet gap before a silence transition) or disable,
     * releasing the model. Blocks the calling thread (a background dispatcher) until done;
     * throws when enabling fails.
     */
    fun configure(enabled: Boolean, minSilenceMs: Int = SpeechActivityEngine.DEFAULT_MIN_SILENCE_MS) {
        require(minSilenceMs > 0) { "minSilenceMs must be positive" }
        active = false
        val token = generation.incrementAndGet()
        val done = CompletableFuture<Unit>()
        submit {
            try {
                if (enabled) enable(minSilenceMs, token) else disable()
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

    /** Called on the audio thread; only copies and queues. */
    fun accept(pcm: ByteArray) {
        if (!active || pcm.isEmpty()) return
        queue.offer(Task.Audio(pcm.copyOf(), generation.get()))
    }

    private fun enable(minSilenceMs: Int, token: Long) {
        val loaded = classifier
        if (loaded != null && engine?.minSilenceMs == minSilenceMs) {
            loaded.reset()
        } else {
            disable()
            classifier =
                try {
                    classifierFactory(minSilenceMs)
                } catch (error: LinkageError) {
                    throw IllegalStateException("On-device speech detection is not available in this build", error)
                }
        }
        val current = classifier!!
        engine = SpeechActivityEngine(
            classifier = current,
            minSilenceMs = minSilenceMs,
            emit = { speaking, silentForMs -> if (token == generation.get()) emitter(speaking, silentForMs) },
            startedAtMs = clock(),
        )
        if (token == generation.get()) active = true
        Bridge.log("SPEECH_ACTIVITY: enabled (minSilenceMs=$minSilenceMs)")
    }

    private fun disable() {
        engine = null
        val loaded = classifier ?: return
        classifier = null
        try {
            loaded.release()
        } catch (error: Exception) {
            Bridge.log("SPEECH_ACTIVITY: release failed: ${error.message}")
        }
        Bridge.log("SPEECH_ACTIVITY: model released")
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
                Thread({ runLoop() }, "SpeechActivityDetector").apply {
                    isDaemon = true
                    start()
                }
        }
    }

    private fun runLoop() {
        while (true) {
            val wait = engine?.nextWakeDelayMs(clock()) ?: 60_000L
            val task = queue.poll(wait)
            try {
                when (task) {
                    is Task.Audio ->
                        if (active && task.generation == generation.get()) engine?.onAudio(task.pcm, clock())
                    is Task.Control -> task.action()
                    null -> Unit
                }
                if (active) engine?.onIdle(clock())
            } catch (error: Throwable) {
                Bridge.log("SPEECH_ACTIVITY: ${error.message}")
            }
        }
    }

    /** Test hook: whether a model is loaded (read on any thread; for assertions only). */
    internal val isModelLoadedForTest: Boolean
        get() = classifier != null
}
