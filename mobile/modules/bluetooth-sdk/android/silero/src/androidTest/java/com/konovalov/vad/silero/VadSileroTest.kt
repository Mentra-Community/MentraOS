package com.konovalov.silero

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.konovalov.vad.silero.Vad
import com.konovalov.vad.silero.VadSilero
import com.konovalov.vad.silero.config.FrameSize
import com.konovalov.vad.silero.config.Mode
import com.konovalov.vad.silero.config.SampleRate
import junit.framework.TestCase.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith


/**
 * Created by Georgiy Konovalov on 12/22/2023.
 *
 * Instrumented test for VadSilero class.
 */
@RunWith(AndroidJUnit4::class)
class VadSileroTest {

    private lateinit var vad: VadSilero
    private lateinit var testContext: Context

    @Before
    fun setUp() {
        this.testContext = InstrumentationRegistry.getInstrumentation().context

        this.vad = Vad.builder()
            .setContext(testContext)
            .setSampleRate(SampleRate.SAMPLE_RATE_16K)
            .setFrameSize(FrameSize.FRAME_SIZE_512)
            .setMode(Mode.VERY_AGGRESSIVE)
            .build()
    }

    @After
    fun shutdown() {
        vad.close()
    }

    @Test
    fun testIsSpeech() {
        // List for VAD results
        val actualResult = mutableListOf<Boolean>()

        // List with expected VAD results
        val expectedResult = listOf(
            false, false, false, false, false,
            false, true, true, true, true,
            true, true, true, true, true,
            true, true, true, false, false
        )

        // Buffer size should be 2x for ByteArray
        val chunkSize = vad.frameSize.value * 2

        // Reading audio data from test file
        testContext.assets.open("hello.wav").buffered().use { input ->
            // Skip WAV Header
            input.skip(44)

            while (input.available() > 0) {
                // Read audio Frame
                val frameChunk = ByteArray(chunkSize).apply { input.read(this) }

                // Save interference result
                actualResult.add(vad.isSpeech(frameChunk))
            }
        }

        // Compare expectedResult with actualResult
        assertEquals(expectedResult, actualResult)
    }
}