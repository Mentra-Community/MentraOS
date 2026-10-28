package com.mentra.bluetoothsdk.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure framing, transition and gap-fill logic. The classifier is a stand-in with Silero-like
 * hysteresis: a frame is speech when its peak is above 0.1, and speaking only ends after
 * minSilenceMs of quiet frames (sherpa-onnx's min_silence_duration).
 */
class SpeechActivityEngineTest {
    private class FakeClassifier(minSilenceMs: Int) : SpeechFrameClassifier {
        private val quietFramesToEnd =
            ((minSilenceMs + SpeechActivityEngine.FRAME_MS - 1) / SpeechActivityEngine.FRAME_MS).toInt()
        val frames = mutableListOf<FloatArray>()
        var released = false
        private var speaking = false
        private var quiet = 0

        override fun accept(frame: FloatArray): Boolean {
            frames.add(frame)
            val loud = frame.any { kotlin.math.abs(it) > 0.1f }
            if (loud) {
                speaking = true
                quiet = 0
            } else if (speaking && ++quiet >= quietFramesToEnd) {
                speaking = false
                quiet = 0
            }
            return speaking
        }

        override fun release() {
            released = true
        }
    }

    private data class Event(val speaking: Boolean, val silentForMs: Long, val atMs: Long)

    private var now = 0L
    private val events = mutableListOf<Event>()

    private fun engine(classifier: SpeechFrameClassifier, minSilenceMs: Int = 300) =
        SpeechActivityEngine(
            classifier = classifier,
            minSilenceMs = minSilenceMs,
            emit = { speaking, silentForMs -> events.add(Event(speaking, silentForMs, now)) },
            startedAtMs = now,
        )

    /** 16-bit LE PCM for [samples] samples of [value] (as a fraction of full scale). */
    private fun pcm(samples: Int, value: Float): ByteArray {
        val out = ByteArray(samples * 2)
        val s = (value * 32767).toInt()
        for (i in 0 until samples) {
            out[i * 2] = (s and 0xff).toByte()
            out[i * 2 + 1] = (s shr 8).toByte()
        }
        return out
    }

    /** Deliver [bytes] in chunks of [chunkBytes], advancing the clock in real time. */
    private fun deliver(engine: SpeechActivityEngine, bytes: ByteArray, chunkBytes: Int) {
        var off = 0
        while (off < bytes.size) {
            val end = minOf(bytes.size, off + chunkBytes)
            now += ((end - off) / 2) * 1000L / SpeechActivityEngine.SAMPLE_RATE
            engine.onAudio(bytes.copyOfRange(off, end), now)
            engine.onIdle(now)
            off = end
        }
    }

    /** Let wall time pass with no audio, waking the engine the way the worker does. */
    private fun idle(engine: SpeechActivityEngine, forMs: Long) {
        val until = now + forMs
        while (now < until) {
            val wait = engine.nextWakeDelayMs(now) ?: (until - now)
            now = minOf(until, now + wait)
            engine.onIdle(now)
        }
    }

    @Test
    fun assemblerAnalyzesEverySampleWhateverTheChunkSize() {
        val assembler = PcmFrameAssembler(512)
        val frames = mutableListOf<FloatArray>()
        // A ramp so order and alignment are checkable; odd chunk sizes split samples.
        val total = 512 * 7 + 100
        val bytes = ByteArray(total * 2)
        for (i in 0 until total) {
            bytes[i * 2] = (i and 0xff).toByte()
            bytes[i * 2 + 1] = (i shr 8).toByte()
        }
        var off = 0
        val sizes = intArrayOf(333, 1, 2, 1001, 77, 4096, 5)
        var k = 0
        while (off < bytes.size) {
            val end = minOf(bytes.size, off + sizes[k++ % sizes.size])
            assembler.push(bytes.copyOfRange(off, end)) { frames.add(it) }
            off = end
        }

        assertEquals(7, frames.size)
        assertEquals(100, assembler.pendingSamples)
        frames.forEachIndexed { f, frame ->
            assertEquals(512, frame.size)
            frame.forEachIndexed { j, value -> assertEquals((f * 512 + j) / 32768f, value, 0f) }
        }
    }

    @Test
    fun assemblerDecodesNegativeSamplesAcrossChunkBoundaries() {
        val assembler = PcmFrameAssembler(2)
        val frames = mutableListOf<FloatArray>()
        // -2 = 0xFFFE, -32768 = 0x8000, split mid-sample.
        assembler.push(byteArrayOf(0xFE.toByte())) { frames.add(it) }
        assembler.push(byteArrayOf(0xFF.toByte(), 0x00)) { frames.add(it) }
        assembler.push(byteArrayOf(0x80.toByte())) { frames.add(it) }
        assertEquals(1, frames.size)
        assertEquals(-2 / 32768f, frames[0][0], 0f)
        assertEquals(-1f, frames[0][1], 0f)
    }

    @Test
    fun nonAlignedChunksAreFullyAnalyzed() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        // 40 frames of audio delivered in 333-byte (odd) chunks.
        deliver(engine, pcm(512 * 40, 0.5f), 333)
        assertEquals(40, classifier.frames.size)
        assertEquals(40L, engine.framesClassified)
    }

    @Test
    fun emitsOnlyOnTransitions() {
        val engine = engine(FakeClassifier(300))
        deliver(engine, pcm(16_000, 0.5f), 640) // 1 s of speech
        deliver(engine, pcm(16_000, 0f), 640) // 1 s of quiet audio
        deliver(engine, pcm(8_000, 0.5f), 640) // speech again

        assertEquals(listOf(true, false, true), events.map { it.speaking })
        assertEquals(listOf(0L, 300L, 0L), events.map { it.silentForMs })
    }

    @Test
    fun speechToSilenceReportsWithinTheConfiguredGap() {
        for (minSilenceMs in listOf(300, 800)) {
            events.clear()
            now = 0
            val engine = engine(FakeClassifier(minSilenceMs), minSilenceMs)
            deliver(engine, pcm(16_000, 0.5f), 640)
            val speechEndedAt = now
            deliver(engine, pcm(32_000, 0f), 640)

            val silent = events.single { !it.speaking }
            val latency = silent.atMs - speechEndedAt
            assertTrue("silence after ${latency}ms for $minSilenceMs", latency in minSilenceMs.toLong()..(minSilenceMs + 80L))
            assertEquals(minSilenceMs.toLong(), silent.silentForMs)
        }
    }

    @Test
    fun audioThatStopsMidSessionProducesSilence() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        deliver(engine, pcm(16_000, 0.5f), 640) // speaking, then the loudness gate cuts audio
        val audioStoppedAt = now
        assertTrue(engine.speaking)

        idle(engine, 2_000)

        val silent = events.last()
        assertFalse(silent.speaking)
        // ~100 ms gap before filling starts from the end of the audio, then ~300 ms of silence.
        val latency = silent.atMs - audioStoppedAt
        assertTrue("silence reported after ${latency}ms", latency in 300L..500L)
    }

    @Test
    fun gapFillingIsRealTimeAndStopsOnceSettled() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        deliver(engine, pcm(16_000, 0.5f), 640)
        val framesBefore = classifier.frames.size

        // Shorter than the gap: nothing synthetic yet.
        idle(engine, 90)
        assertEquals(framesBefore, classifier.frames.size)

        // Past the gap: silent frames for the elapsed time, never ahead of the clock.
        idle(engine, 110)
        val synthetic = classifier.frames.size - framesBefore
        assertTrue("fed $synthetic frames for 200 ms", synthetic in 5..7)
        // The first one completes the partial frame of real audio (16000 % 512 = 128 samples).
        val firstFill = classifier.frames[framesBefore]
        assertTrue(firstFill.take(128).all { it > 0.4f } && firstFill.drop(128).all { it == 0f })
        assertTrue(classifier.frames.drop(framesBefore + 1).all { frame -> frame.all { it == 0f } })

        // After silence is reported and settled, no more inference while audio stays off.
        idle(engine, 5_000)
        val settled = classifier.frames.size
        idle(engine, 5_000)
        assertEquals(settled, classifier.frames.size)
        assertEquals(null, engine.nextWakeDelayMs(now))
    }

    @Test
    fun missingAudioWhileSilentNeedsNoFill() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        deliver(engine, pcm(16_000, 0f), 640)
        val frames = classifier.frames.size
        assertEquals(null, engine.nextWakeDelayMs(now))
        idle(engine, 2_000)
        assertEquals(frames, classifier.frames.size)
        assertTrue(events.isEmpty())
    }

    @Test
    fun fillStopsAsSoonAsSilenceIsReported() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        deliver(engine, pcm(16_000, 0.5f), 640)
        val framesBefore = classifier.frames.size
        idle(engine, 5_000)
        // 1 frame completing the partial real frame + 10 quiet frames (320 ms) to report silence.
        assertEquals(11, classifier.frames.size - framesBefore)
        assertFalse(events.last().speaking)
    }

    @Test
    fun realAudioResumingStopsTheFill() {
        val classifier = FakeClassifier(300)
        val engine = engine(classifier)
        deliver(engine, pcm(16_000, 0.5f), 640)
        idle(engine, 150) // gap fill has started; still speaking
        assertTrue(engine.speaking)
        deliver(engine, pcm(16_000, 0.5f), 640) // speech resumes
        assertEquals(listOf(true), events.map { it.speaking })
        assertEquals(SpeechActivityEngine.GAP_MS, engine.nextWakeDelayMs(now))
    }
}
