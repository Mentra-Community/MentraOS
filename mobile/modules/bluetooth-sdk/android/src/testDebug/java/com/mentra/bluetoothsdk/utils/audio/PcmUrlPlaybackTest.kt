package com.mentra.bluetoothsdk.utils.audio

import java.io.ByteArrayOutputStream
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PcmUrlPlaybackTest {
    @Test
    fun carryKeepsSamplesWholeAcrossOddChunks() {
        val carry = Pcm16ByteCarry()
        assertNull(carry.push(byteArrayOf(1), 1))
        assertTrue(carry.hasPendingByte)
        assertArrayEquals(byteArrayOf(1, 2), carry.push(byteArrayOf(2, 3, 4, 5), 1))
        assertFalse(carry.hasPendingByte)
        assertArrayEquals(byteArrayOf(3, 4, 5, 6), carry.push(byteArrayOf(3, 4, 5, 6, 7), 5))
        assertTrue(carry.hasPendingByte)
        assertArrayEquals(byteArrayOf(7, 8, 9, 10), carry.push(byteArrayOf(8, 9, 10), 3))
        assertFalse(carry.hasPendingByte)
        assertNull(carry.push(byteArrayOf(), 0))
    }

    @Test
    fun compressedContentTypesAreRejectedAndRawTypesPlayed() {
        for (type in listOf("audio/mpeg", "Audio/MPEG; charset=binary", "audio/mp3", "audio/aac", "audio/ogg", "audio/opus", "audio/webm")) {
            assertTrue(type, PcmUrlPlayback.isCompressedAudio(type))
        }
        for (type in listOf(null, "", "audio/L16; rate=24000", "audio/pcm", "application/octet-stream")) {
            assertFalse(type.toString(), PcmUrlPlayback.isCompressedAudio(type))
        }
        assertEquals("audio/mpeg", PcmUrlPlayback.mediaType(" Audio/MPEG ; q=1"))
    }

    /** Returns at most a scripted number of bytes per read, like a network body. */
    private class TricklingStream(private val data: ByteArray, private val sizes: IntArray) : InputStream() {
        private var pos = 0
        private var call = 0

        override fun read(): Int = if (pos < data.size) data[pos++].toInt() and 0xff else -1

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (pos >= data.size) return -1
            val n = minOf(len, sizes[call++ % sizes.size], data.size - pos)
            System.arraycopy(data, pos, b, off, n)
            pos += n
            return n
        }
    }

    @Test
    fun pumpWritesEverySampleInOrderInEvenChunks() {
        val body = ByteArray(10_001) { (it * 7).toByte() }
        val written = ByteArrayOutputStream()
        val chunkSizes = mutableListOf<Int>()

        val total =
            PcmUrlPlayback.pump(TricklingStream(body, intArrayOf(1, 333, 2, 4095, 7, 64))) { chunk ->
                chunkSizes.add(chunk.size)
                written.write(chunk)
            }

        // The final odd byte has no pair and is dropped; everything else arrives in order.
        assertEquals(10_000L, total)
        assertArrayEquals(body.copyOf(10_000), written.toByteArray())
        assertTrue(chunkSizes.all { it > 0 && it % 2 == 0 })
    }
}
