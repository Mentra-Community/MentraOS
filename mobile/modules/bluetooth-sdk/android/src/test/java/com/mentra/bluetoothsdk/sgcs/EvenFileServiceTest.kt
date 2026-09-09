package com.mentra.bluetoothsdk.sgcs

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class EvenFileServiceTest {
    @Test fun `upload arms fast acknowledgements and only checks result after data`() = runBlocking {
        lateinit var files: EvenFileService
        val frames = mutableListOf<Pair<Byte, ByteArray>>()
        files = EvenFileService { service, data ->
            frames += service to data
            when {
                service == 0xC5.toByte() -> files.acceptAck(byteArrayOf(1, 0))
                data[0] == 0.toByte() -> files.acceptAck(byteArrayOf(0, 0))
                data[0] == 2.toByte() -> files.acceptAck(byteArrayOf(2, 0))
            }
        }
        assertEquals(0, files.transfer(1, FileService.PATH_NOTIFY, byteArrayOf(7, 8)))
        assertEquals(listOf(0xC4.toByte(), 0xC4.toByte(), 0xC5.toByte(), 0xC4.toByte()), frames.map { it.first })
        assertEquals(93, frames[0].second.size)
        assertArrayEquals(byteArrayOf(7, 8), frames[2].second)
        assertFalse(files.needsReconnect)
    }

    @Test fun `start refusal stops before sending content`() = runBlocking {
        lateinit var files: EvenFileService
        var writes = 0
        files = EvenFileService { _, _ -> writes++; files.acceptAck(byteArrayOf(0, 1)) }
        assertEquals(1, files.transfer(1, "n", byteArrayOf(1)))
        assertEquals(1, writes)
    }

    @Test fun `CRC rejection is observable and never reported delivered`() = runBlocking {
        lateinit var files: EvenFileService
        files = EvenFileService { service, data ->
            val cid = if (service == 0xC5.toByte()) 1 else data[0].toInt()
            if (service == 0xC5.toByte() || cid != 1) files.acceptAck(byteArrayOf(cid.toByte(), if (cid == 2) 2 else 0))
        }
        assertEquals(2, files.transfer(1, "n", byteArrayOf(9)))
    }

    @Test fun `wrong phase and echoed payload cannot satisfy a pending ACK`() = runBlocking {
        val sent = CompletableDeferred<Unit>()
        val files = EvenFileService { _, _ -> sent.complete(Unit) }
        val transfer = async { files.transfer(1, "n", byteArrayOf(1)) }
        sent.await()
        files.acceptAck(byteArrayOf(1, 0))
        files.acceptAck(byteArrayOf(0, 0, 0))
        assertFalse(transfer.isCompleted)
        transfer.cancelAndJoin()
        assertTrue(files.needsReconnect)
    }

    @Test fun `disable cancels wait and blocks ambiguous reuse until reconnect`() = runBlocking {
        val sent = CompletableDeferred<Unit>()
        val files = EvenFileService { _, _ -> sent.complete(Unit) }
        val transfer = launch { files.transfer(1, "n", byteArrayOf(1)) }
        sent.await(); transfer.cancelAndJoin()
        files.acceptAck(byteArrayOf(0, 0)) // late old response
        try { files.transfer(1, "n", byteArrayOf(2)); fail("ambiguous channel was reused") } catch (_: IllegalStateException) {}
        files.resetConnection()
        assertFalse(files.needsReconnect)
    }

    @Test fun `connection reset cancels old wait without tainting new connection`() = runBlocking {
        val sent = CompletableDeferred<Unit>()
        val files = EvenFileService { _, _ -> sent.complete(Unit) }
        val transfer = launch { files.transfer(1, "n", byteArrayOf(1)) }
        sent.await(); files.resetConnection(); transfer.join()
        assertTrue(transfer.isCancelled)
        assertFalse(files.needsReconnect)
    }

    @Test fun `ack timeout prevents the next upload from consuming a late response`() = runBlocking {
        val files = EvenFileService(timeoutMs = 1) { _, _ -> }
        try { files.transfer(1, "n", byteArrayOf(1)); fail("expected timeout") } catch (_: IOException) {}
        assertTrue(files.needsReconnect)
    }

    @Test fun `start struct encodes unsigned little endian sizes and zero padded filename`() {
        val data = FileService.sendStart(1, 0x01020304, 0x11223344, "n")
        assertEquals(93, data.size)
        assertArrayEquals(byteArrayOf(0, 1, 0, 0, 0, 4, 3, 2, 1, 0x44, 0x33, 0x22, 0x11), data.copyOfRange(0, 13))
        assertEquals('n'.code.toByte(), data[13])
        assertTrue(data.drop(14).all { it == 0.toByte() })
    }

    @Test fun `corrupt or truncated BLE acknowledgements cannot complete a transfer`() {
        val valid = byteArrayOf(0xAA.toByte(), 0x12, 1, 4, 1, 1, 0xC4.toByte(), 0, 0, 0, 0x0F, 0x1D)
        assertArrayEquals(byteArrayOf(0, 0), EvenFileService.decodeAckFrame(valid))
        assertNull(EvenFileService.decodeAckFrame(valid.copyOf(11)))
        valid[10] = 0
        assertNull(EvenFileService.decodeAckFrame(valid))
    }

    @Test fun `Even CRC uses the non reflected zero seed variant`() {
        assertEquals(0, EvenFileService.crc32(byteArrayOf()))
        assertEquals(0xC052A8C8.toInt(), EvenFileService.crc32("123456789".toByteArray()))
    }

    @Test fun `updates reuse ids without colliding with numeric phone ids`() {
        val ids = NotificationIds()
        val first = ids.forPhoneId("app-key")
        assertEquals(first, ids.forPhoneId("app-key"))
        assertNotEquals(first, ids.forPhoneId(first.toString()))
        assertNotEquals(ids.forPhoneId(""), ids.forPhoneId(""))
        repeat(10000) { ids.forPhoneId("other-$it") }
        assertNotEquals(ids.forPhoneId("a"), ids.forPhoneId("b"))
    }
}
