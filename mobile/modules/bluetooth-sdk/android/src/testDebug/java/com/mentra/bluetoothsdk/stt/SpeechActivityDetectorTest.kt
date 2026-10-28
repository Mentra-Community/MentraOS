package com.mentra.bluetoothsdk.stt

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Lifecycle of the threaded detector with a stand-in classifier (no native model). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SpeechActivityDetectorTest {
    private class Classifier(private val quietFramesToEnd: Int) : SpeechFrameClassifier {
        @Volatile var released = false
        private var speaking = false
        private var quiet = 0

        override fun accept(frame: FloatArray): Boolean {
            if (frame.any { it > 0.1f }) {
                speaking = true
                quiet = 0
            } else if (speaking && ++quiet >= quietFramesToEnd) {
                speaking = false
            }
            return speaking
        }

        override fun release() {
            released = true
        }
    }

    private val created = CopyOnWriteArrayList<Classifier>()
    private val events = CopyOnWriteArrayList<Pair<Boolean, Long>>()
    @Volatile private var onEvent: () -> Unit = {}

    private val defaultFactory = SpeechActivityDetector.classifierFactory
    private val defaultEmitter = SpeechActivityDetector.emitter
    private val defaultClock = SpeechActivityDetector.clock

    @Before
    fun setUp() {
        SpeechActivityDetector.classifierFactory = { minSilenceMs ->
            Classifier(((minSilenceMs + 31) / 32)).also { created.add(it) }
        }
        SpeechActivityDetector.emitter = { speaking, silentForMs ->
            events.add(speaking to silentForMs)
            onEvent()
        }
        SpeechActivityDetector.clock = { System.nanoTime() / 1_000_000 }
    }

    @After
    fun tearDown() {
        SpeechActivityDetector.configure(false)
        SpeechActivityDetector.classifierFactory = defaultFactory
        SpeechActivityDetector.emitter = defaultEmitter
        SpeechActivityDetector.clock = defaultClock
    }

    private fun loudPcm(samples: Int): ByteArray =
        ByteArray(samples * 2).also { bytes ->
            for (i in 0 until samples) {
                bytes[i * 2] = 0x00
                bytes[i * 2 + 1] = 0x40 // 0x4000 = 0.5 of full scale
            }
        }

    @Test
    fun missingAudioAfterSpeechIsReportedAsSilence() {
        val speaking = CountDownLatch(1)
        val silent = CountDownLatch(1)
        onEvent = {
            if (events.last().first) speaking.countDown() else silent.countDown()
        }
        SpeechActivityDetector.configure(true, 300)

        // 200 ms of speech in odd-sized chunks, then the microphone stops sending.
        val pcm = loudPcm(3_200)
        var off = 0
        while (off < pcm.size) {
            val end = minOf(pcm.size, off + 333)
            SpeechActivityDetector.accept(pcm.copyOfRange(off, end))
            off = end
        }
        assertTrue("no speaking event", speaking.await(2, TimeUnit.SECONDS))
        val stoppedAt = System.nanoTime()
        assertTrue("no silence after audio stopped", silent.await(3, TimeUnit.SECONDS))
        val elapsedMs = (System.nanoTime() - stoppedAt) / 1_000_000
        assertTrue("silence took ${elapsedMs}ms", elapsedMs in 250..1_500)
        assertEquals(listOf(true to 0L, false to 300L), events.toList())
    }

    @Test
    fun disablingReleasesTheModelAndIgnoresAudio() {
        SpeechActivityDetector.configure(true, 300)
        assertEquals(1, created.size)
        assertTrue(SpeechActivityDetector.isModelLoadedForTest)

        SpeechActivityDetector.configure(false)
        assertTrue(created.single().released)
        assertFalse(SpeechActivityDetector.isModelLoadedForTest)

        SpeechActivityDetector.accept(loudPcm(1_600))
        Thread.sleep(200)
        assertTrue(events.isEmpty())
    }

    @Test
    fun changingTheSilenceGapReloadsTheModel() {
        SpeechActivityDetector.configure(true, 300)
        SpeechActivityDetector.configure(true, 300)
        assertEquals(1, created.size)
        SpeechActivityDetector.configure(true, 1_000)
        assertEquals(2, created.size)
        assertTrue(created[0].released)
        assertFalse(created[1].released)
    }
}
