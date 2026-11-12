package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test

class NimoFirmwareUpdaterTest {
    private class Clock : NimoScheduler {
        val tasks = mutableListOf<Pair<Long, () -> Unit>>(); var now = 0L
        override fun post(delayMs: Long, task: () -> Unit): () -> Unit {
            val e = (now + delayMs) to task; tasks += e; return { tasks.remove(e) }
        }
        fun run(limit: Int = 100000) { var n = 0
            while (tasks.isNotEmpty() && n++ < limit) { val e = tasks.minByOrNull { it.first }!!; tasks.remove(e); now = e.first; e.second() } }
    }
    private fun resp(cmd: Int, seq: Int, body: ByteArray, status: Int = 0): ByteArray {
        val len = body.size + 2
        return byteArrayOf(0x70, 0x07, 0x6E, 0, cmd.toByte(), (len shr 8).toByte(), len.toByte(), status.toByte(), seq.toByte()) + body + 0x33.toByte()
    }
    private fun u32(v: Int) = byteArrayOf((v shr 24).toByte(), (v shr 16).toByte(), (v shr 8).toByte(), v.toByte())
    private fun u16(v: Int) = byteArrayOf((v shr 8).toByte(), v.toByte())

    @Test fun fullTransferSendsReset() {
        val fw = ByteArray(1000) { it.toByte() }
        val clock = Clock()
        var result: String? = "pending"
        val received = ByteArray(fw.size); var syncCalls = 0
        val commands = mutableListOf<Int>()
        lateinit var updater: NimoFirmwareUpdater
        val blockSize = 256
        updater = NimoFirmwareUpdater(fw, 100, clock, write = { pkt, done ->
            val cmd = pkt[4].toInt() and 255; val seq = pkt[7].toInt() and 255
            val params = pkt.copyOfRange(8, pkt.size - 1)
            commands += cmd
            clock.post(1) { done(true) }
            val reply: ByteArray? = when (cmd) {
                0x02 -> byteArrayOf(2, 3, 1, 2, 5, 1, 3, 2, 80, 80)
                0xE1 -> u32(0) + u16(16)
                0xE2 -> byteArrayOf(0)
                0xE3 -> byteArrayOf(0) + u32(0) + u16(blockSize) + byteArrayOf(1)
                0xE5 -> {
                    val off = ((params[0].toInt() and 255) shl 24) or ((params[1].toInt() and 255) shl 16) or ((params[2].toInt() and 255) shl 8) or (params[3].toInt() and 255)
                    val data = params.copyOfRange(4, params.size - 4)
                    data.copyInto(received, off)
                    val end = off + data.size
                    if (end % blockSize == 0 || end == fw.size) {
                        if (end >= fw.size) byteArrayOf(0) + u32(0) + u16(0) + u16(0)
                        else byteArrayOf(0) + u32(end) + u16(minOf(blockSize, fw.size - end)) + u16(10)
                    } else null
                }
                0xE6 -> byteArrayOf(0)
                0xE8 -> if (syncCalls++ < 2) byteArrayOf(1) else byteArrayOf(0)
                else -> null
            }
            if (reply != null) clock.post(2) { updater.receive(resp(cmd, seq, reply)) }
        }, progress = {}, finished = { result = it })
        updater.start()
        clock.run()
        assertNull(result)
        assertArrayEquals(fw, received)
        assertEquals(0x03, commands.last())
    }

    @Test fun refusalReportsFailureWithoutReset() {
        val clock = Clock(); var result: String? = "pending"; val commands = mutableListOf<Int>()
        lateinit var updater: NimoFirmwareUpdater
        updater = NimoFirmwareUpdater(ByteArray(100), 100, clock, write = { pkt, done ->
            val cmd = pkt[4].toInt() and 255; val seq = pkt[7].toInt() and 255; commands += cmd
            done(true)
            val reply = when (cmd) { 0x02 -> byteArrayOf(2, 3, 1, 2, 5, 1, 3, 2, 10, 10); 0xE1 -> u32(0) + u16(16); 0xE2 -> byteArrayOf(2); else -> null }
            if (reply != null) clock.post(1) { updater.receive(resp(cmd, seq, reply)) }
        }, progress = {}, finished = { result = it })
        updater.start(); clock.run()
        assertNotNull(result); assertNotEquals("pending", result)
        assertFalse(commands.contains(0x03)); assertFalse(commands.contains(0xE3))
    }
}
