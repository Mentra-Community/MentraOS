package com.konovalov.vad.silero.utils

import com.konovalov.vad.silero.utils.AudioUtils.getFramesCount
import com.konovalov.vad.silero.utils.AudioUtils.toFloatArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Created by Georgiy Konovalov on 12/04/2023.
 *
 * Unit tests for AudioUtils class.
 */
class AudioUtilsTest {

    @Test
    fun `convert ShortArray to FloatArray`() {
        val input = shortArrayOf(100, 200, 300)
        val expected = floatArrayOf(0.003051851f, 0.006103702f, 0.009155553f)
        val result = toFloatArray(input)

        assertArrayEquals(expected, result, 0f)
    }

    @Test
    fun `convert ByteArray to FloatArray`() {
        val input = byteArrayOf(10, 20, 30)
        val expected = floatArrayOf(0.15655996f)
        val result = toFloatArray(input)

        assertArrayEquals(expected, result, 0f)
    }

    @Test
    fun `getFramesCount calculates frame count correctly`() {
        val sampleRate = 8000
        val frameSize = 256
        val durationMs = 300
        val expected = 9
        val result = getFramesCount(sampleRate, frameSize, durationMs)

        assertEquals(expected, result)
    }
}