package com.mentra.bluetoothsdk.sgcs

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** A single in-flight Even file upload. The wire ACK has no transaction id. */
internal class EvenFileService(
    private val timeoutMs: Long = 15_000,
    private val send: suspend (Byte, ByteArray) -> Unit,
) {
    private val mutex = Mutex()
    private data class Pending(val generation: Long, val cid: Int, val result: CompletableDeferred<Int>)
    @Volatile private var generation = 0L
    @Volatile private var pending: Pending? = null
    @Volatile var needsReconnect = false
        private set

    /** Only a new physical connection can clear an ambiguous in-flight transfer. */
    @Synchronized fun resetConnection() {
        generation++
        pending?.result?.cancel()
        pending = null
        needsReconnect = false
    }

    fun acceptFrame(frame: ByteArray) {
        decodeAckFrame(frame)?.let(::acceptAck)
    }

    /** Reject old-connection callbacks before calling this method. */
    @Synchronized fun acceptAck(payload: ByteArray) {
        if (payload.size != 2) return
        val current = pending ?: return
        if (current.generation == generation && current.cid == (payload[0].toInt() and 0xff)) {
            current.result.complete(payload[1].toInt() and 0xff)
        }
    }

    private suspend fun phase(epoch: Long, cid: Int, write: suspend () -> Unit): Int {
        val ack = synchronized(this) {
            check(epoch == generation) { "connection_changed" }
            CompletableDeferred<Int>().also { pending = Pending(epoch, cid, it) }
        }
        try {
            write()
            return withTimeoutOrNull(timeoutMs) { ack.await() } ?: throw IOException("ack_timeout")
        } finally {
            synchronized(this) { if (pending?.result === ack) pending = null }
        }
    }

    suspend fun transfer(fileType: Int, filename: String, bytes: ByteArray): Int = mutex.withLock {
        check(!needsReconnect) { "needs_reconnect" }
        val epoch = generation
        try {
            val start = phase(epoch, FileService.CID_SEND_START) {
                send(0xC4.toByte(), FileService.sendStart(fileType, bytes.size, crc32(bytes), filename))
            }
            if (start != 0) return@withLock start
            val data = phase(epoch, FileService.CID_SEND_DATA) {
                send(0xC4.toByte(), FileService.sendData())
                send(0xC5.toByte(), bytes)
            }
            if (data != 0) return@withLock data
            phase(epoch, FileService.CID_SEND_RESULT_CHECK) {
                send(0xC4.toByte(), FileService.resultCheck())
            }
        } catch (error: Exception) {
            // No abort ACK or transaction id exists in the verified protocol. Reusing
            // this channel after a timeout/cancel could accept the old transfer's ACK.
            synchronized(this) { if (epoch == generation) needsReconnect = true }
            throw error
        }
    }

    companion object {
        /** Verified ACK shape: one frame carrying cid/status plus payload CRC16. */
        fun decodeAckFrame(frame: ByteArray): ByteArray? {
            if (frame.size != 12 || frame[0] != 0xAA.toByte() || frame[3] != 4.toByte() ||
                frame[4] != 1.toByte() || frame[5] != 1.toByte() ||
                (frame[6] != 0xC4.toByte() && frame[6] != 0xC5.toByte()) ||
                ((frame[7].toInt() shr 1) and 0x0F) != 0) return null
            val payload = frame.copyOfRange(8, 10)
            val crc = (frame[10].toInt() and 0xff) or ((frame[11].toInt() and 0xff) shl 8)
            return payload.takeIf { g2Crc16(it) == crc }
        }

        /** CRC-32/Castagnoli, MSB-first, zero seed and no final xor (Even wire format). */
        fun crc32(bytes: ByteArray): Int {
            var crc = 0
            for (byte in bytes) {
                crc = crc xor ((byte.toInt() and 0xff) shl 24)
                repeat(8) { crc = if (crc < 0) (crc shl 1) xor 0x1EDC6F41 else crc shl 1 }
            }
            return crc
        }
    }
}
