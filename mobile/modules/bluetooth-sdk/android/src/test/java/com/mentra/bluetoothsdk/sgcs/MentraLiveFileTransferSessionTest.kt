package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MentraLiveFileTransferSessionTest {
    @Test fun dynamicPayloadUsesTrueSizeEvenWhenDivisibleBy400() {
        for (pack in listOf(244, 474, 800)) {
            val session = MentraLive.FileTransferSession("photo", 80000, 2)
            session.recalculateTotalPackets(pack)
            assertEquals((80000 + pack - 1) / pack, session.totalPackets)
            for (index in 0 until session.totalPackets) {
                assertTrue(session.addPacket(index, ByteArray(minOf(pack, 80000 - index * pack))))
            }
            assertTrue(session.isComplete)
            assertEquals(80000, session.assembleFile()!!.size)
        }
    }

    @Test fun shortLastPacketFirstThenFullPackets() {
        // After a reconnect the first packet through can be the last, short one.
        for (flags in listOf(0, 2)) {
            val source = ByteArray(4611) { (it % 251).toByte() }
            val session = MentraLive.FileTransferSession("T1", source.size, flags)
            session.recalculateTotalPackets(211)
            assertTrue(session.addPacket(11, source.copyOfRange(4400, 4611)))
            for (index in 0 until 11) {
                assertTrue(session.addPacket(index, source.copyOfRange(index * 400, index * 400 + 400)))
            }
            assertEquals(12, session.totalPackets)
            assertTrue(session.isComplete)
            assertArrayEquals(source, session.assembleFile())
        }
    }

    @Test fun legacyInflatedSizeAndLargeUnflaggedPayloads() {
        // Flag 1 enables batched ACKs but still uses legacy size semantics.
        for ((pack, headerSize, actualSize, packets) in listOf(
                listOf(221, 80000, 43982, 200),
                listOf(400, 80000, 79777, 200),
                listOf(800, 80000, 80000, 100))) {
            val session = MentraLive.FileTransferSession("photo", headerSize, 1)
            session.recalculateTotalPackets(pack)
            assertEquals(packets, session.totalPackets)
            val source = ByteArray(actualSize) { (it % 251).toByte() }
            for (index in (0 until packets).reversed()) {
                val start = index * pack
                assertTrue(session.addPacket(index, source.copyOfRange(start, minOf(start + pack, actualSize))))
            }
            assertTrue(session.isComplete)
            assertArrayEquals(source, session.assembleFile())
        }
    }

    @Test fun malformedOrDuplicatePacketsCannotCompleteFile() {
        val session = MentraLive.FileTransferSession("photo", 1000, 2)
        session.recalculateTotalPackets(800)
        assertFalse(session.addPacket(0, ByteArray(799)))
        assertFalse(session.addPacket(2, ByteArray(200)))
        assertTrue(session.addPacket(1, ByteArray(200)))
        assertFalse(session.isComplete)
        assertFalse(session.addPacket(1, ByteArray(200)))
        assertTrue(session.addPacket(0, ByteArray(800)))
        assertEquals(1000, session.assembleFile()!!.size)
    }
}
