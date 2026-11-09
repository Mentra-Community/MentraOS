package com.mentra.bluetoothsdk.sgcs

import java.security.MessageDigest

/** The one NIMO firmware the app supports: the vendor's 537cf1 dynamic-v1 build. */
internal object NimoFirmwareTarget {
    const val PACKED_VERSION = "0.1.1.1"
    const val BUILD_TAG = "537cf1"
    const val SHA256 = "5e23c574e3dfd8c27172f4f9a33475e6efd0d33e7230bfcce8f4fe8ca59fe433"
    const val ASSET_PATH = "nimo/nimo-firmware-0.1.1.1-537cf1.bin"
    const val UPDATING_TEXT = "Updating your NIMO glasses.\n\nKeep the Mentra app open."

    /** A missing detail string (older firmware) is judged on the packed version alone. */
    fun isCurrent(packedVersion: String, detail: String): Boolean =
        packedVersion == PACKED_VERSION && (detail.isEmpty() || detail.contains("-$BUILD_TAG-"))

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
}

/**
 * Single-attempt NIMO OTA over the 2001/2002 channel. Main-thread confined; [scheduler] posts there.
 * [finished] gets null once the reboot command was sent, otherwise the failure reason.
 * No failure path sends reset; the next connection decides again from the reported version.
 */
internal class NimoFirmwareUpdater(
    firmware: ByteArray,
    writeCapacity: Int,
    private val scheduler: NimoScheduler,
    private val write: (ByteArray, (Boolean) -> Unit) -> Unit,
    private val progress: (Int) -> Unit,
    private val finished: (String?) -> Unit,
) {
    private class Pending(val command: Int, val sequence: Int, val callback: (Result<ByteArray>) -> Unit)

    private val firmware = firmware.copyOf()
    private val capacity = writeCapacity.coerceAtMost(512)
    private val decoder = NimoOtaProtocol.Decoder()
    private var sequence = 0
    private var pending: Pending? = null
    private var cancelTimer: (() -> Unit)? = null
    private var cancelDelay: (() -> Unit)? = null
    private var done = false
    private var crc = false
    private val covered = BooleanArray(firmware.size)
    private var coveredCount = 0
    private var lastPercent = -1
    private var stalls = 0
    private var transferStarted = 0L
    private var syncPending = 0
    private var syncFailures = 0

    fun start() {
        exchange(NimoOtaProtocol.INFO, ByteArray(4) { 255.toByte() }) { info ->
            checkDeviceInfo(info)
            exchange(NimoOtaProtocol.FILE_OFFSET) { body ->
                val header = NimoOtaProtocol.firmwareSlice(firmware, NimoOtaProtocol.fileOffset(body))
                exchange(NimoOtaProtocol.CAN_UPDATE, header) { result ->
                    // 0 = can update, 3 = same image already staged; anything else is a refusal.
                    require(result.contentEquals(byteArrayOf(0)) || result.contentEquals(byteArrayOf(3))) {
                        "Glasses refused the firmware (battery or prerequisites)"
                    }
                    exchange(NimoOtaProtocol.ENTER) { entryBody ->
                        val entry = NimoOtaProtocol.enterResult(entryBody)
                        crc = entry.crc
                        transferStarted = System.currentTimeMillis()
                        sendBlock(entry.slice)
                    }
                }
            }
        }
    }

    fun receive(data: ByteArray) {
        if (done) return
        try {
            for (reply in decoder.feed(data)) {
                val expected = pending ?: continue
                if (expected.command != reply.command || expected.sequence != reply.sequence) continue
                pending = null
                cancelTimer?.invoke(); cancelTimer = null
                if (reply.status == 0) expected.callback(Result.success(reply.body))
                else expected.callback(Result.failure(IllegalStateException("OTA command ${reply.command} returned status ${reply.status}")))
            }
        } catch (error: Exception) { fail(error) }
    }

    /** The connection went away; stop without reporting. */
    fun cancel() {
        done = true
        clearTimers()
    }

    private fun checkDeviceInfo(body: ByteArray) {
        val fields = NimoOtaProtocol.deviceInfo(body)
        val batteries = fields[2]
        require(fields[3]?.contentEquals(byteArrayOf(1)) == true && fields[5]?.contentEquals(byteArrayOf(1)) == true &&
            batteries?.size == 2) { "Both arms must be connected and ready to update" }
    }

    private fun sendBlock(slice: NimoOtaProtocol.Slice) {
        check(System.currentTimeMillis() - transferStarted <= 20 * 60_000L) { "Transfer exceeded 20 minutes" }
        val parts = NimoOtaProtocol.blockParts(firmware, slice, crc, capacity)
        sendPart(parts, 0) { body ->
            val next = NimoOtaProtocol.blockResult(body)
            var added = 0
            for (index in slice.offset.toInt() until slice.offset.toInt() + slice.length) {
                if (!covered[index]) { covered[index] = true; added++ }
            }
            coveredCount += added
            stalls = if (added == 0) stalls + 1 else 0
            check(stalls < 5) { "Five repeated blocks without progress" }
            val percent = coveredCount * 100 / firmware.size
            if (percent != lastPercent) { lastPercent = percent; progress(percent) }
            if (next.slice.offset == 0L && next.slice.length == 0) {
                exchange(NimoOtaProtocol.VALIDATE, timeoutMs = 30_000) { validation ->
                    require(validation.contentEquals(byteArrayOf(0))) { "Glasses rejected the transferred image" }
                    pollSync()
                }
            } else {
                NimoOtaProtocol.firmwareSlice(firmware, next.slice)
                delay(next.delayMs.toLong()) { sendBlock(next.slice) }
            }
        }
    }

    private fun sendPart(parts: List<ByteArray>, index: Int, completion: (ByteArray) -> Unit) {
        if (index == parts.lastIndex) { exchange(NimoOtaProtocol.BLOCK, parts[index], 30_000, completion); return }
        val packet = nextPacket(NimoOtaProtocol.BLOCK, parts[index])
        write(packet) { ok ->
            if (done) return@write
            if (!ok) fail(IllegalStateException("OTA write failed"))
            else delay(5) { sendPart(parts, index + 1, completion) }
        }
    }

    /** Wait for the right arm to copy the image to the left arm, then reboot both. */
    private fun pollSync() {
        exchangeResult(NimoOtaProtocol.SYNC, timeoutMs = 8_000) { result ->
            val body = result.getOrNull()
            if (body?.contentEquals(byteArrayOf(0)) == true) {
                val packet = nextPacket(NimoOtaProtocol.RESET, byteArrayOf(0))
                write(packet) { }
                done = true
                clearTimers()
                finished(null)
                return@exchangeResult
            }
            if (body?.contentEquals(byteArrayOf(1)) == true) syncPending++ else syncFailures++
            if (syncPending >= 180 || syncFailures >= 8) fail(IllegalStateException("Arms did not finish synchronizing; no reboot sent"))
            else delay(1_000) { pollSync() }
        }
    }

    private fun exchange(command: Int, params: ByteArray = byteArrayOf(), timeoutMs: Long = 15_000,
                         completion: (ByteArray) -> Unit) {
        exchangeResult(command, params, timeoutMs) { result ->
            try { completion(result.getOrThrow()) } catch (error: Exception) { fail(error) }
        }
    }

    private fun exchangeResult(command: Int, params: ByteArray = byteArrayOf(), timeoutMs: Long,
                               completion: (Result<ByteArray>) -> Unit) {
        if (done) return
        try {
            val packet = nextPacket(command, params)
            val entry = Pending(command, sequence, completion)
            pending = entry
            cancelTimer = scheduler.post(timeoutMs) {
                if (pending === entry && !done) {
                    pending = null; cancelTimer = null
                    completion(Result.failure(IllegalStateException("OTA command $command timed out")))
                }
            }
            write(packet) { ok ->
                if (!ok && pending === entry && !done) {
                    pending = null
                    cancelTimer?.invoke(); cancelTimer = null
                    completion(Result.failure(IllegalStateException("OTA write failed")))
                }
            }
        } catch (error: Exception) { completion(Result.failure(error)) }
    }

    private fun nextPacket(command: Int, params: ByteArray = byteArrayOf()): ByteArray {
        sequence = (sequence + 1) and 255
        val packet = NimoOtaProtocol.request(command, sequence, params)
        require(packet.size <= capacity) { "OTA request exceeds the negotiated write capacity" }
        return packet
    }

    private fun delay(delayMs: Long, callback: () -> Unit) {
        cancelDelay?.invoke()
        cancelDelay = scheduler.post(delayMs) {
            cancelDelay = null
            if (!done) try { callback() } catch (error: Exception) { fail(error) }
        }
    }

    private fun clearTimers() {
        cancelTimer?.invoke(); cancelTimer = null
        cancelDelay?.invoke(); cancelDelay = null
        pending = null
        decoder.reset()
    }

    private fun fail(error: Throwable) {
        if (done) return
        done = true
        clearTimers()
        finished(error.message ?: "NIMO firmware update failed")
    }
}
