package com.mentra.bluetoothsdk.utils

import com.mentra.bluetoothsdk.debug.BleEvidenceLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MessageChunkReassemblerOriginTest {
    private val first = BleEvidenceLog.Origin(connection = 3, wire = 3)
    private val afterWireReset = BleEvidenceLog.Origin(connection = 3, wire = 9)

    @Test
    fun `chunks from one origin reassemble`() {
        val reassembler = MessageChunkReassembler()
        assertNull(reassembler.addChunk("c1", 0, 2, "{\"a\":", first))
        assertEquals("{\"a\":1}", reassembler.addChunk("c1", 1, 2, "1}", first))
        assertEquals(0L, reassembler.mixedOriginDrops)
    }

    @Test
    fun `a chunk from another origin discards the session instead of mixing`() {
        val reassembler = MessageChunkReassembler()
        assertNull(reassembler.addChunk("c1", 0, 2, "{\"a\":", first))
        // Completing index 1 from a later wire epoch must not produce a message.
        assertNull(reassembler.addChunk("c1", 1, 2, "1}", afterWireReset))
        assertEquals(1L, reassembler.mixedOriginDrops)
        // The discarded session's first chunk is gone; only fragments from the new origin combine.
        assertEquals("{\"b\":1}", reassembler.addChunk("c1", 0, 2, "{\"b\":", afterWireReset))
    }

    @Test
    fun `binary fragments from another origin are discarded`() {
        val reassembler = MessageChunkReassembler()
        assertNull(reassembler.addBinaryFragment(7, 0, 2, byteArrayOf(1), first))
        assertNull(reassembler.addBinaryFragment(7, 1, 2, byteArrayOf(2), afterWireReset))
        assertEquals(1L, reassembler.mixedOriginDrops)
    }

    @Test
    fun `callers without an origin keep the previous behavior`() {
        val reassembler = MessageChunkReassembler()
        assertNull(reassembler.addChunk("c1", 0, 2, "{\"a\":"))
        assertEquals("{\"a\":1}", reassembler.addChunk("c1", 1, 2, "1}"))
        assertEquals(0L, reassembler.mixedOriginDrops)
    }
}
