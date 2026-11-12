package com.mentra.bluetoothsdk.stt

/**
 * Splits 16-bit little-endian mono PCM into fixed-size float frames.
 *
 * Chunks of any length are accepted, including odd byte counts: leftover samples and a
 * dangling byte carry over to the next chunk, so no audio is skipped.
 */
internal class PcmFrameAssembler(val frameSize: Int = SpeechActivityEngine.FRAME_SAMPLES) {
    private val frame = FloatArray(frameSize)
    private var filled = 0
    private var pendingByte = -1

    /** Samples waiting for a full frame. */
    val pendingSamples: Int
        get() = filled

    fun push(bytes: ByteArray, onFrame: (FloatArray) -> Unit) {
        var i = 0
        if (pendingByte >= 0 && bytes.isNotEmpty()) {
            add(pendingByte or (bytes[0].toInt() shl 8), onFrame)
            pendingByte = -1
            i = 1
        }
        while (i + 1 < bytes.size) {
            add((bytes[i].toInt() and 0xff) or (bytes[i + 1].toInt() shl 8), onFrame)
            i += 2
        }
        if (i < bytes.size) pendingByte = bytes[i].toInt() and 0xff
    }

    /** Append [samples] of digital silence (drops a dangling byte: the audio is discontinuous). */
    fun pushSilence(samples: Int, onFrame: (FloatArray) -> Unit) {
        pendingByte = -1
        repeat(samples) { add(0, onFrame) }
    }

    fun clear() {
        filled = 0
        pendingByte = -1
    }

    private fun add(sample16: Int, onFrame: (FloatArray) -> Unit) {
        frame[filled++] = sample16.toShort() / 32768f
        if (filled == frameSize) {
            filled = 0
            onFrame(frame.copyOf())
        }
    }
}

/** Classifies consecutive frames; returns whether speech is detected after each frame. */
internal interface SpeechFrameClassifier {
    fun accept(frame: FloatArray): Boolean

    /** Forget all state (a new session). */
    fun reset() {}

    fun release()
}

/**
 * Speech/silence transitions from a frame classifier, with missing audio treated as silence.
 *
 * Every complete [FRAME_SAMPLES]-sample frame is classified; nothing is skipped or throttled.
 * Transitions are emitted only when the classifier's state flips. When no audio has arrived for
 * [gapMs] (Mentra Live's loudness gate stops sending audio when it's quiet) while speech is
 * detected, silent frames are fed in real time from the end of the last audio, so silence comes
 * out of the same classifier as any other quiet. Feeding stops once silence has been reported;
 * real audio drives the classifier again as soon as it arrives. Same rules as iOS.
 *
 * Not thread-safe: drive it from one thread. Times are monotonic milliseconds.
 */
internal class SpeechActivityEngine(
    private val classifier: SpeechFrameClassifier,
    val minSilenceMs: Int,
    private val emit: (speaking: Boolean, silentForMs: Long) -> Unit,
    startedAtMs: Long,
    private val gapMs: Long = GAP_MS,
) {
    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SAMPLES = 512
        const val FRAME_MS = FRAME_SAMPLES * 1000L / SAMPLE_RATE // 32 ms
        const val GAP_MS = 100L
        const val DEFAULT_MIN_SILENCE_MS = 300
    }

    private val assembler = PcmFrameAssembler(FRAME_SAMPLES)

    var speaking = false
        private set

    /** Frames classified so far (real and synthetic). */
    var framesClassified = 0L
        private set

    private var lastAudioAtMs = startedAtMs
    private var filling = false
    private var filledUntilMs = startedAtMs

    fun onAudio(pcm: ByteArray, nowMs: Long) {
        filling = false
        lastAudioAtMs = nowMs
        filledUntilMs = nowMs
        assembler.push(pcm, ::classify)
    }

    /** Feed silence for an audio gap, if one is due. Call whenever the driving thread wakes. */
    fun onIdle(nowMs: Long) {
        if (nowMs - lastAudioAtMs < gapMs) return
        if (!filling) {
            filling = true
            filledUntilMs = lastAudioAtMs
        }
        while (filledUntilMs + FRAME_MS <= nowMs && speaking) {
            assembler.pushSilence(FRAME_SAMPLES, ::classify)
            filledUntilMs += FRAME_MS
        }
    }

    /** How long the driving thread may sleep before [onIdle] has work, or null if none is due. */
    fun nextWakeDelayMs(nowMs: Long): Long? {
        if (!speaking) return null
        if (!filling) return (lastAudioAtMs + gapMs - nowMs).coerceAtLeast(1)
        return (filledUntilMs + FRAME_MS - nowMs).coerceAtLeast(1)
    }

    private fun classify(frame: FloatArray) {
        framesClassified++
        val speech = classifier.accept(frame)
        if (speech == speaking) return
        speaking = speech
        // The classifier reports silence only after minSilenceMs of quiet.
        emit(speech, if (speech) 0L else minSilenceMs.toLong())
    }
}
