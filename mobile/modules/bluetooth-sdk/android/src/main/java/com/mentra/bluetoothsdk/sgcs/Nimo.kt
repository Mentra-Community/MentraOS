package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import java.util.TimeZone
import java.util.UUID
import java.util.zip.Deflater

// ---------- Nimo BLE Constants ----------

internal object NimoBLE {
    // UART-style service: TX = phone→glasses commands, RX = glasses→phone notifications.
    // Short UUIDs from the vendor SDK expanded onto the Bluetooth base UUID.
    val SERVICE_UUID: UUID = UUID.fromString("00007033-0000-1000-8000-00805F9B34FB")
    val CHAR_TX: UUID = UUID.fromString("00002021-0000-1000-8000-00805F9B34FB")
    val CHAR_RX: UUID = UUID.fromString("00002022-0000-1000-8000-00805F9B34FB")
    val CHAR_MIC: UUID = UUID.fromString("00002025-0000-1000-8000-00805F9B34FB")
    val CLIENT_CHARACTERISTIC_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    const val NAME_PREFIX = "nimo"
    // iOS ANCS side-channel devices advertise "<name>_ble" — never the data channel.
    const val BLE_NAME_SUFFIX = "_ble"

    const val CHUNK_SIZE = 501
    const val INTER_FRAME_DELAY_MS = 5L
}

// ---------- Nimo Protocol Constants ----------
// Byte values follow the glasses firmware protocol and must not be changed.

internal object NimoProtocol {
    const val FRAME_MAGIC = 0xBF

    // status bits
    const val STATUS_ERR = 0x01
    const val STATUS_ACK = 0x02

    // command categories
    const val CMD_GET_PARAMETER = 0x02
    const val CMD_SET_PARAMETER = 0x03
    const val CMD_INSTRUCTION_REPORT = 0x06
    const val CMD_CONTROL_INSTRUCTION = 0x07
    const val CMD_CONTROL_FACTORY = 0x08
    const val CMD_CONTROL_NOTIFICATION = 0x09

    // get parameter keys
    const val GET_BRIGHTNESS = 0x02
    const val GET_BATTERY = 0x06
    const val GET_SCREEN_INFO = 0x07
    const val GET_VERSION = 0x0A
    const val GET_VERSION_DETAIL = 0x0B
    const val GET_TWS_STATUS = 0x16

    // set parameter keys
    const val SET_TIME = 0x01
    const val SET_BRIGHTNESS = 0x02
    const val SET_DISTANCE = 0x03
    const val SET_ANGLE = 0x04
    const val SET_HEADUP_DISPLAY = 0x0D
    const val SET_AUTO_BRIGHTNESS = 0x0E
    const val SET_DISPLAY_OFF = 0x0F
    const val SET_PHONE_TYPE = 0x14
    const val SET_HEIGHT_LEVEL = 0x17

    // control instruction keys
    const val CTRL_ENTER_APP = 0x01
    const val CTRL_QUIT_APP = 0x03
    const val CTRL_UPDATE_CONTENT = 0x04

    // notification keys
    const val NOTIFICATION_SEND = 0x01

    // report keys (cmd 0x06)
    const val REPORT_INPUT = 0x01
    const val REPORT_APP = 0x02
    const val REPORT_TWS = 0x03
    const val REPORT_BUSINESS = 0x04
    const val REPORT_GATT_STATE = 0x05

    // business report ids
    const val BUSINESS_MESSAGE_PUSH = 0x01
    const val BUSINESS_HEARTBEAT = 0x03
    const val BUSINESS_BATTERY = 0x05

    // input event codes
    const val INPUT_HEAD_UP = 0x01
    const val INPUT_HEAD_DOWN = 0x02
    const val INPUT_CLICK_RIGHT = 0x03
    const val INPUT_DOUBLE_CLICK_RIGHT = 0x04
    const val INPUT_LONG_PRESS_RIGHT = 0x05
    const val INPUT_TOUCH_PRESS_RIGHT = 0x06
    const val INPUT_TOUCH_RELEASE_RIGHT = 0x07
    const val INPUT_CLICK_LEFT = 0x13
    const val INPUT_DOUBLE_CLICK_LEFT = 0x14
    const val INPUT_LONG_PRESS_LEFT = 0x15
    const val INPUT_TOUCH_PRESS_LEFT = 0x16
    const val INPUT_TOUCH_RELEASE_LEFT = 0x17

    // app state report phases
    const val STATE_ENTER = 0x01
    const val STATE_EXIT = 0x03

    // app ids
    const val APP_ID_DASHBOARD = 0x00
    const val APP_ID_NAV = 0x01
    const val APP_ID_ASR_NOTE = 0x04
    const val APP_ID_PROMPTER = 0x06
    const val APP_ID_AI_TALK = 0x07

    // enterApp modes
    const val APP_MODE_STANDALONE = 0x00
    // Undocumented: defined in the vendor SDK constants (appModePopup) but never used there.
    // Hardware-tested June 2026: does NOT remove the ASR view's time/battery status bar.
    const val APP_MODE_POPUP = 0x01

    // widget resTypes
    const val WIDGET_TEXT_NEW = 0x00
    const val WIDGET_TEXT_APPEND = 0x01
    const val WIDGET_PICTURE = 0x80

    // navigation widget resIds (appId 0x01): mini map 0x00, arrow 0x01, turn text 0x02,
    // status bar 0x03 (raw), tip 0x04, large map 0x05.
    const val NAV_RES_MINI_MAP = 0x00
    const val NAV_RES_TURN_TEXT = 0x02
    const val NAV_RES_LARGE_MAP = 0x05

    // navigation image widget sizes (hard firmware requirements; see IMAGE_PROTOCOL).
    const val NAV_MINI_MAP_SIZE = 160
    const val NAV_LARGE_MAP_WIDTH = 452
    const val NAV_LARGE_MAP_HEIGHT = 170

    // phone types
    const val PHONE_TYPE_OTHER = 0x02

    // image header
    const val COM_IMAGE_HEADER = 0x16
    const val FORMAT_2BPP = 0x02
    const val COMPRESSION_NONE = 0x00
    const val COMPRESSION_ZLIB = 0x07

    const val MAX_BRIGHTNESS_LEVEL = 16
}

// ---------- CRC16-CCITT ----------

/**
 * CRC-16/CCITT-FALSE: init 0xFFFF, poly 0x1021, no reflection, no final XOR.
 * Computed over the application payload (app header + data), NOT the transport header.
 */
internal fun nimoCrc16(data: ByteArray): Int {
    var crc = 0xFFFF
    for (byte in data) {
        crc = crc xor ((byte.toInt() and 0xFF) shl 8)
        for (i in 0 until 8) {
            crc =
                    if (crc and 0x8000 != 0) {
                        ((crc shl 1) xor 0x1021) and 0xFFFF
                    } else {
                        (crc shl 1) and 0xFFFF
                    }
        }
    }
    return crc
}

// ---------- Frame Codec ----------

/**
 * Pure bytes-in/bytes-out frame codec for the Nimo 0xBF transport.
 *
 * Frame layout (little-endian):
 * - 8-byte transport header: [magic][status][len(2)][crc16(2)][index(2)]
 * - 4-byte application header (requests): [cmd][key][len(2)]
 * - responses/reports carry an extra status byte: [cmd][key][len(2)][status][data...]
 */
internal object NimoFrameCodec {

    fun transportHeader(payload: ByteArray, index: Int = 0, needsAck: Boolean = true): ByteArray {
        val header = ByteArray(8)
        header[0] = NimoProtocol.FRAME_MAGIC.toByte()
        header[1] = (if (needsAck) NimoProtocol.STATUS_ACK else 0).toByte()
        header[2] = (payload.size and 0xFF).toByte()
        header[3] = ((payload.size shr 8) and 0xFF).toByte()
        val crc = nimoCrc16(payload)
        header[4] = (crc and 0xFF).toByte()
        header[5] = ((crc shr 8) and 0xFF).toByte()
        header[6] = (index and 0xFF).toByte()
        header[7] = ((index shr 8) and 0xFF).toByte()
        return header
    }

    fun applicationHeader(cmd: Int, key: Int, payloadSize: Int): ByteArray {
        return byteArrayOf(
                cmd.toByte(),
                key.toByte(),
                (payloadSize and 0xFF).toByte(),
                ((payloadSize shr 8) and 0xFF).toByte()
        )
    }

    /** One complete single frame: transport header + app header + payload. */
    fun encodeFrame(
            cmd: Int,
            key: Int,
            payload: ByteArray = ByteArray(0),
            index: Int = 0,
            needsAck: Boolean = true
    ): ByteArray {
        val appHeader = applicationHeader(cmd, key, payload.size)
        val transportPayload = appHeader + payload
        return transportHeader(transportPayload, index, needsAck) + transportPayload
    }

    /**
     * Content update (cmd=0x07 key=0x04) blind-sliced into 501-byte chunks, each wrapped in its
     * own transport header. Index rule: last chunk = 0, others = i+1 (first = 1); single chunk = 0.
     */
    fun updateContentFrames(
            appId: Int,
            layoutId: Int,
            resId: Int,
            resType: Int,
            content: ByteArray,
            chunkSize: Int = NimoBLE.CHUNK_SIZE
    ): List<ByteArray> {
        // App header payloadSize includes the 4-byte [appId][layoutId][resId][resType] prefix.
        val appHeader =
                applicationHeader(
                        NimoProtocol.CMD_CONTROL_INSTRUCTION,
                        NimoProtocol.CTRL_UPDATE_CONTENT,
                        4 + content.size
                )
        val full =
                appHeader +
                        byteArrayOf(
                                appId.toByte(),
                                layoutId.toByte(),
                                resId.toByte(),
                                resType.toByte()
                        ) +
                        content

        val chunkCount = (full.size + chunkSize - 1) / chunkSize
        val frames = mutableListOf<ByteArray>()
        for (i in 0 until chunkCount) {
            val start = i * chunkSize
            val end = minOf(start + chunkSize, full.size)
            val chunk = full.copyOfRange(start, end)
            val isLast = i == chunkCount - 1
            val index = if (isLast) 0 else i + 1
            frames.add(transportHeader(chunk, index) + chunk)
        }
        return frames
    }

    /**
     * 15-byte image header. [originalSize] MUST be the uncompressed pixel byte count
     * (the glasses use it to allocate the decompression buffer).
     */
    fun imageHeader(
            width: Int,
            height: Int,
            formatBpp: Int,
            compression: Int,
            originalSize: Int,
            compressedSize: Int
    ): ByteArray {
        val p = ByteArray(15)
        p[0] = NimoProtocol.COM_IMAGE_HEADER.toByte()
        p[1] = (width and 0xFF).toByte()
        p[2] = ((width shr 8) and 0xFF).toByte()
        p[3] = (height and 0xFF).toByte()
        p[4] = ((height shr 8) and 0xFF).toByte()
        p[5] = formatBpp.toByte()
        p[6] = compression.toByte()
        p[7] = (originalSize and 0xFF).toByte()
        p[8] = ((originalSize shr 8) and 0xFF).toByte()
        p[9] = ((originalSize shr 16) and 0xFF).toByte()
        p[10] = ((originalSize shr 24) and 0xFF).toByte()
        p[11] = (compressedSize and 0xFF).toByte()
        p[12] = ((compressedSize shr 8) and 0xFF).toByte()
        p[13] = ((compressedSize shr 16) and 0xFF).toByte()
        p[14] = ((compressedSize shr 24) and 0xFF).toByte()
        return p
    }

    /**
     * 9-byte device time: [year(2 LE)][month][day][hour][min][sec][week][zone]
     * week: Sunday=0..Saturday=6; zone: signed, 15-minute units, clamped to ±48.
     */
    fun encodeDeviceTime(timeMillis: Long = System.currentTimeMillis()): ByteArray {
        val cal = Calendar.getInstance()
        cal.timeInMillis = timeMillis
        val b = ByteArray(9)
        val year = cal.get(Calendar.YEAR)
        b[0] = (year and 0xFF).toByte()
        b[1] = ((year shr 8) and 0xFF).toByte()
        b[2] = (cal.get(Calendar.MONTH) + 1).toByte()
        b[3] = cal.get(Calendar.DAY_OF_MONTH).toByte()
        b[4] = cal.get(Calendar.HOUR_OF_DAY).toByte()
        b[5] = cal.get(Calendar.MINUTE).toByte()
        b[6] = cal.get(Calendar.SECOND).toByte()
        // Calendar.DAY_OF_WEEK: Sunday=1..Saturday=7 → protocol Sunday=0..Saturday=6
        b[7] = (cal.get(Calendar.DAY_OF_WEEK) - 1).toByte()
        val offsetMinutes = TimeZone.getDefault().getOffset(timeMillis) / 60_000
        val zone = (offsetMinutes / 15.0).toInt().coerceIn(-48, 48)
        b[8] = (zone and 0xFF).toByte()
        return b
    }

    /** A decoded frame. [cmd]/[key]/[statusCode]/[data] are null when the payload is too short. */
    data class DecodedFrame(
            val transportStatus: Int,
            val index: Int,
            val cmd: Int?,
            val key: Int?,
            val statusCode: Int?,
            val data: ByteArray?
    )

    /**
     * Decodes one complete frame (responses and reports both use the 5-byte
     * [cmd][key][len(2)][status] application header). Returns null on transport
     * error, bad CRC, or truncation.
     */
    fun decode(frame: ByteArray): DecodedFrame? {
        if (frame.size < 8) return null
        if ((frame[0].toInt() and 0xFF) != NimoProtocol.FRAME_MAGIC) return null
        val transportStatus = frame[1].toInt() and 0xFF
        val payloadLen = (frame[2].toInt() and 0xFF) or ((frame[3].toInt() and 0xFF) shl 8)
        val crcValue = (frame[4].toInt() and 0xFF) or ((frame[5].toInt() and 0xFF) shl 8)
        val index = (frame[6].toInt() and 0xFF) or ((frame[7].toInt() and 0xFF) shl 8)
        if (frame.size < 8 + payloadLen) return null
        if (transportStatus and NimoProtocol.STATUS_ERR != 0) return null

        val payload = frame.copyOfRange(8, 8 + payloadLen)
        if (nimoCrc16(payload) != crcValue) return null

        if (payload.size < 5) {
            return DecodedFrame(transportStatus, index, null, null, null, null)
        }
        val cmd = payload[0].toInt() and 0xFF
        val key = payload[1].toInt() and 0xFF
        val statusCode = payload[4].toInt() and 0xFF
        val data = if (payload.size > 5) payload.copyOfRange(5, payload.size) else ByteArray(0)
        return DecodedFrame(transportStatus, index, cmd, key, statusCode, data)
    }
}

// ---------- Receive Assembler ----------

/**
 * Reassembles multi-packet responses. Fragments are grouped by (cmd,key); each fragment carries
 * the full 5-byte response app header. The first fragment (index==1) keeps its header, the
 * continuation fragments (index>1) and the last fragment (index==0) contribute only their data
 * sections, concatenated in ascending index order with the last (0) treated as largest. The
 * merged message is re-framed (lengths and CRC recomputed) so [NimoFrameCodec.decode] can parse
 * it. Single packets (index==0, no cached group) pass through unchanged.
 */
internal class NimoReceiveAssembler {
    private class Pending {
        var firstAppPayload: ByteArray? = null
        val dataByIndex = mutableMapOf<Int, ByteArray>()
        val startTime = System.currentTimeMillis()
    }

    private val pending = mutableMapOf<Int, Pending>()

    fun ingest(packet: ByteArray): List<ByteArray> {
        if (packet.size < 8) return emptyList()
        val payloadLen = (packet[2].toInt() and 0xFF) or ((packet[3].toInt() and 0xFF) shl 8)
        val index = (packet[6].toInt() and 0xFF) or ((packet[7].toInt() and 0xFF) shl 8)
        if (packet.size < 8 + payloadLen) return emptyList()
        val appPayload = packet.copyOfRange(8, 8 + payloadLen)

        if (appPayload.size < 2) {
            return if (index == 0) listOf(packet) else emptyList()
        }

        val cmd = appPayload[0].toInt() and 0xFF
        val key = appPayload[1].toInt() and 0xFF
        val groupKey = (cmd shl 8) or key

        if (index == 0) {
            val p = pending.remove(groupKey) ?: return listOf(packet)
            p.dataByIndex[Int.MAX_VALUE] = dataSection(appPayload)
            return listOf(reframe(p))
        }

        if (index == 1) {
            // A new first fragment while an old first fragment is cached means the previous
            // round lost its last packet — drop the stale group and start over.
            val existing = pending[groupKey]
            if (existing?.firstAppPayload != null) {
                pending.remove(groupKey)
            }
        }

        val p = pending.getOrPut(groupKey) { Pending() }
        if (index == 1) {
            p.firstAppPayload = appPayload
        }
        p.dataByIndex[index] = dataSection(appPayload)
        return emptyList()
    }

    fun cleanup(timeoutMs: Long = 10_000) {
        val now = System.currentTimeMillis()
        pending.entries.removeAll { now - it.value.startTime >= timeoutMs }
    }

    fun reset() = pending.clear()

    private fun dataSection(appPayload: ByteArray): ByteArray {
        return if (appPayload.size <= 5) ByteArray(0) else appPayload.copyOfRange(5, appPayload.size)
    }

    private fun reframe(p: Pending): ByteArray {
        val merged = ByteArrayOutputStream()
        for (k in p.dataByIndex.keys.sorted()) {
            merged.write(p.dataByIndex[k]!!)
        }
        val mergedData = merged.toByteArray()
        val first = p.firstAppPayload
        val cmd = if (first != null && first.isNotEmpty()) first[0] else 0
        val key = if (first != null && first.size >= 2) first[1] else 0
        val status = if (first != null && first.size >= 5) first[4] else 0

        val appPayload = ByteArray(5 + mergedData.size)
        appPayload[0] = cmd
        appPayload[1] = key
        appPayload[2] = (mergedData.size and 0xFF).toByte()
        appPayload[3] = ((mergedData.size shr 8) and 0xFF).toByte()
        appPayload[4] = status
        mergedData.copyInto(appPayload, 5)

        return NimoFrameCodec.transportHeader(appPayload, index = 0) + appPayload
    }
}

// ---------- Mic Audio Parser ----------

/**
 * H-T-L-V parser for the mic channel (char 2025). Packets: [0x52][type][len(2 LE)][payload].
 * For Opus packets the payload is [SN(2 LE)][frameCnt][reserved] then frameCnt frames of
 * [frameLen(1)][body] where opusLen = body[3] and the Opus bytes are body[8 .. 8+opusLen].
 * Slicing by opusLen (not frameLen-8) is mandatory — the tail holds CRC/padding bytes.
 */
internal object NimoAudioParser {
    const val HEADER = 0x52
    const val TYPE_STOP = 0x00
    const val TYPE_START = 0x01
    const val TYPE_OPUS_LEFT = 0x02
    const val TYPE_OPUS_RIGHT = 0x03

    data class Packet(val type: Int, val sequence: Int, val opusFrames: List<ByteArray>)

    fun parse(data: ByteArray): Packet? {
        if (data.size < 4 || (data[0].toInt() and 0xFF) != HEADER) return null
        val type = data[1].toInt() and 0xFF
        val len = (data[2].toInt() and 0xFF) or ((data[3].toInt() and 0xFF) shl 8)
        if (data.size < 4 + len) return Packet(type, 0, emptyList())
        if (type != TYPE_OPUS_LEFT && type != TYPE_OPUS_RIGHT) return Packet(type, 0, emptyList())

        val payload = data.copyOfRange(4, 4 + len)
        if (payload.size < 4) return Packet(type, 0, emptyList())
        val sn = (payload[0].toInt() and 0xFF) or ((payload[1].toInt() and 0xFF) shl 8)
        val frameCnt = payload[2].toInt() and 0xFF
        var offset = 4
        val frames = mutableListOf<ByteArray>()
        var i = 0
        while (i < frameCnt && offset < payload.size) {
            val frameLen = payload[offset].toInt() and 0xFF
            offset += 1
            if (offset + frameLen > payload.size) break
            val body = payload.copyOfRange(offset, offset + frameLen)
            offset += frameLen
            i++
            if (frameLen < 8) continue
            val opusLen = body[3].toInt() and 0xFF
            if (8 + opusLen > frameLen) continue
            frames.add(body.copyOfRange(8, 8 + opusLen))
        }
        return Packet(type, sn, frames)
    }
}

// ---------- Opus Decoder (MediaCodec) ----------

/**
 * Decodes the glasses' 16 kHz mono Opus frames to 16-bit PCM via the platform
 * MediaCodec "audio/opus" decoder, so no native Opus library has to be vendored.
 */
private class NimoOpusDecoder(
        private val sampleRate: Int = 16_000,
        private val channels: Int = 1
) {
    private var codec: MediaCodec? = null
    private var ptsUs: Long = 0

    fun start(): Boolean {
        if (codec != null) return true
        return try {
            val format =
                    MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, sampleRate, channels)
            // csd-0: OpusHead identification header
            val opusHead = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
            opusHead.put("OpusHead".toByteArray(Charsets.US_ASCII))
            opusHead.put(1) // version
            opusHead.put(channels.toByte())
            opusHead.putShort(0) // pre-skip
            opusHead.putInt(sampleRate)
            opusHead.putShort(0) // output gain
            opusHead.put(0) // mapping family
            opusHead.flip()
            format.setByteBuffer("csd-0", opusHead)
            // csd-1/csd-2: 64-bit pre-skip and seek pre-roll in nanoseconds
            format.setByteBuffer(
                    "csd-1",
                    ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0).apply { flip() }
            )
            format.setByteBuffer(
                    "csd-2",
                    ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(0).apply { flip() }
            )
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            c.configure(format, null, null, 0)
            c.start()
            codec = c
            ptsUs = 0
            true
        } catch (e: Exception) {
            Bridge.log("NIMO: failed to start Opus decoder: ${e.message}")
            codec = null
            false
        }
    }

    /** Decodes one Opus frame. May return empty while the codec is still buffering. */
    fun decode(opusFrame: ByteArray): ByteArray {
        val c = codec ?: return ByteArray(0)
        val out = ByteArrayOutputStream()
        try {
            val inIdx = c.dequeueInputBuffer(10_000)
            if (inIdx >= 0) {
                val buf = c.getInputBuffer(inIdx) ?: return ByteArray(0)
                buf.clear()
                buf.put(opusFrame)
                c.queueInputBuffer(inIdx, 0, opusFrame.size, ptsUs, 0)
                ptsUs += 20_000 // 20 ms frames
            }
            val info = MediaCodec.BufferInfo()
            var outIdx = c.dequeueOutputBuffer(info, 10_000)
            while (outIdx >= 0) {
                val buf = c.getOutputBuffer(outIdx)
                if (buf != null && info.size > 0) {
                    val pcm = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(pcm)
                    out.write(pcm)
                }
                c.releaseOutputBuffer(outIdx, false)
                outIdx = c.dequeueOutputBuffer(info, 0)
            }
        } catch (e: Exception) {
            Bridge.log("NIMO: Opus decode error: ${e.message}")
            release()
        }
        return out.toByteArray()
    }

    fun release() {
        try {
            codec?.stop()
            codec?.release()
        } catch (_: Exception) {}
        codec = null
    }
}

// ---------- Audio Client ----------

/**
 * Mic audio client, mirroring the vendor's GlassesAudioClient:
 * - bounded FIFO of raw uplink packets (listener only enqueues; a sequential drain
 *   on a dedicated thread decodes one packet at a time); on overflow the oldest is
 *   dropped with a periodic warning (backpressure guard);
 * - codec is initialized BEFORE the start command is sent (the glasses begin
 *   uplinking immediately) and on stop, processing halts and the queue is cleared
 *   BEFORE the codec is released (tail frames arrive after the stop command);
 * - first-event diagnostics: one log each for first packet / first non-opus /
 *   first decode skip / first emitted frame, to locate where "frames=0" stalls;
 * - frame duration varies (10 ms / 20 ms) — PCM length is never assumed.
 */
private class NimoAudioClient(
        private val sendCommand: (ByteArray) -> Unit,
        private val onPcm: (ByteArray) -> Unit,
        private val onActivity: () -> Unit,
) {
    companion object {
        // Same cap as the vendor's maxPendingPackets.
        private const val MAX_PENDING_PACKETS = 64
        // Fall back to the other ear if the preferred one goes quiet for this long.
        private const val SIDE_FALLBACK_MS = 2_000L
    }

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var decoder: NimoOpusDecoder? = null
    @Volatile private var started = false
    private val pendingCount = java.util.concurrent.atomic.AtomicInteger(0)
    private var droppedCount = 0
    private var lastRightPacketMs = 0L
    private var preferRight = true

    private var logFirstPacket = true
    private var logFirstNonOpus = true
    private var logFirstSkip = true
    private var logFirstEmit = true

    fun start() {
        if (started) {
            // Already running: just re-send the start command (idempotent on the
            // firmware) so a watchdog-triggered re-enable can recover a real outage.
            sendCommand(byteArrayOf(0x52, 0x01, 0x00, 0x00))
            return
        }
        val t = HandlerThread("NimoAudio")
        t.start()
        thread = t
        handler = Handler(t.looper)
        decoder =
                NimoOpusDecoder().also {
                    if (!it.start()) Bridge.log("NIMO: audio: Opus decoder failed to start")
                }
        logFirstPacket = true
        logFirstNonOpus = true
        logFirstSkip = true
        logFirstEmit = true
        droppedCount = 0
        // started=true BEFORE the start command: the glasses begin uplinking the
        // moment they receive it; otherwise the first frames would be discarded.
        started = true
        sendCommand(byteArrayOf(0x52, 0x01, 0x00, 0x00))
    }

    fun stop() {
        if (!started) return
        // Halt processing and drop in-flight frames BEFORE releasing the decoder —
        // the glasses keep sending a few frames after the stop command, and decoding
        // on a released codec would throw.
        started = false
        handler?.removeCallbacksAndMessages(null)
        pendingCount.set(0)
        sendCommand(byteArrayOf(0x52, 0x00, 0x00, 0x00))
        val h = handler
        val t = thread
        val d = decoder
        handler = null
        thread = null
        decoder = null
        if (h != null) {
            h.post {
                d?.release()
                t?.quitSafely()
            }
        } else {
            d?.release()
            t?.quitSafely()
        }
    }

    /** Called from the GATT notify callback (binder thread): enqueue only. */
    fun enqueue(bytes: ByteArray) {
        if (!started) return
        val h = handler ?: return
        if (pendingCount.get() >= MAX_PENDING_PACKETS) {
            droppedCount++
            if (droppedCount == 1 || droppedCount % 50 == 0) {
                Bridge.log(
                        "NIMO: audio backpressure: queue full ($MAX_PENDING_PACKETS), dropped packet (total=$droppedCount) — decode lagging capture"
                )
            }
            return
        }
        pendingCount.incrementAndGet()
        h.post {
            pendingCount.decrementAndGet()
            process(bytes)
        }
    }

    // Flow stats: one summary line every 5s while audio streams, including the
    // DeviceManager forwarding flags so "is audio reaching the cloud" is visible.
    private var statsPackets = 0
    private var statsFrames = 0
    private var statsPcmBytes = 0
    private var statsLastReportMs = 0L

    private fun reportStats(now: Long) {
        if (now - statsLastReportMs < 5_000) return
        if (statsLastReportMs != 0L) {
            val sendLc3 = DeviceStore.get("bluetooth", "should_send_lc3") as? Boolean ?: false
            val sendPcm = DeviceStore.get("bluetooth", "should_send_pcm") as? Boolean ?: false
            val sendTranscript =
                    DeviceStore.get("bluetooth", "should_send_transcript") as? Boolean ?: false
            Bridge.log(
                    "NIMO: audio: flowing — $statsPackets pkts, $statsFrames frames, $statsPcmBytes PCM bytes in 5s (cloud: lc3=$sendLc3 pcm=$sendPcm transcript=$sendTranscript)"
            )
        }
        statsPackets = 0
        statsFrames = 0
        statsPcmBytes = 0
        statsLastReportMs = now
    }

    /** Runs on the audio thread, one packet at a time (sequential drain). */
    private fun process(bytes: ByteArray) {
        if (!started) return
        if (logFirstPacket) {
            logFirstPacket = false
            Bridge.log("NIMO: audio: first uplink packet (${bytes.size} bytes)")
        }
        statsPackets++
        reportStats(System.currentTimeMillis())
        val packet = NimoAudioParser.parse(bytes)
        if (packet == null ||
                        (packet.type != NimoAudioParser.TYPE_OPUS_LEFT &&
                                packet.type != NimoAudioParser.TYPE_OPUS_RIGHT)
        ) {
            if (logFirstNonOpus) {
                logFirstNonOpus = false
                Bridge.log(
                        "NIMO: audio: first packet not an opus frame (parsed=${packet != null}, type=${packet?.type})"
                )
            }
            return
        }
        // Any parsed opus packet counts as glasses-audio activity for the watchdog.
        onActivity()

        val now = System.currentTimeMillis()
        when (packet.type) {
            NimoAudioParser.TYPE_OPUS_RIGHT -> {
                lastRightPacketMs = now
                preferRight = true
            }
            NimoAudioParser.TYPE_OPUS_LEFT -> {
                // Only fall back to the left ear when the right has gone quiet —
                // forwarding both would duplicate the audio.
                if (preferRight && now - lastRightPacketMs < SIDE_FALLBACK_MS) return
                preferRight = false
            }
        }

        val codec = decoder ?: return
        for (opusFrame in packet.opusFrames) {
            // Frame duration varies (10 ms = 160 samples, 20 ms = 320 samples at
            // 16 kHz) — accept whatever the decoder returns, never assume a length.
            val pcm48 = codec.decode(opusFrame)
            if (pcm48.isEmpty()) {
                if (logFirstSkip) {
                    logFirstSkip = false
                    Bridge.log("NIMO: audio: first frame skipped at decode (opusLen=${opusFrame.size})")
                }
                continue
            }
            // MediaCodec's Opus decoder always outputs 48 kHz regardless of the
            // OpusHead rate; the MentraOS pipeline expects 16 kHz mono → decimate by 3.
            val pcm16 = downsample48kTo16k(pcm48)
            if (pcm16.isEmpty()) continue
            if (logFirstEmit) {
                logFirstEmit = false
                Bridge.log("NIMO: audio: first decoded PCM frame emitted (${pcm16.size} bytes @16kHz)")
            }
            statsFrames++
            statsPcmBytes += pcm16.size
            onPcm(pcm16)
        }
    }

    /** 48 kHz → 16 kHz: average each group of 3 samples (cheap low-pass + decimate). */
    private fun downsample48kTo16k(pcm48: ByteArray): ByteArray {
        val inSamples = pcm48.size / 2
        val outSamples = inSamples / 3
        if (outSamples == 0) return ByteArray(0)
        val out = ByteArray(outSamples * 2)
        var i = 0
        for (o in 0 until outSamples) {
            var sum = 0
            for (k in 0 until 3) {
                val lo = pcm48[i].toInt() and 0xFF
                val hi = pcm48[i + 1].toInt() // sign-extended high byte
                sum += (hi shl 8) or lo
                i += 2
            }
            val sample = (sum / 3).coerceIn(-32768, 32767)
            out[o * 2] = (sample and 0xFF).toByte()
            out[o * 2 + 1] = ((sample shr 8) and 0xFF).toByte()
        }
        return out
    }
}

// ---------- Reconnection Manager ----------

private class NimoReconnectionManager(
        private val intervalMs: Long = 30_000L,
        // First attempt comes quickly so a transient failure during pairing
        // self-heals well inside the pairing timeout.
        private val firstDelayMs: Long = 5_000L,
        private val maxAttempts: Int = -1 // -1 for unlimited
) {
    private val handler = Handler(Looper.getMainLooper())
    private var runnable: Runnable? = null
    private var attempts = 0

    fun start(onAttempt: () -> Boolean) {
        stop()
        attempts = 0
        val r =
                object : Runnable {
                    override fun run() {
                        if (maxAttempts > 0 && attempts >= maxAttempts) {
                            Bridge.log("NIMO: Max reconnection attempts ($maxAttempts) reached")
                            stop()
                            return
                        }
                        attempts++
                        Bridge.log("NIMO: Reconnection attempt $attempts")
                        if (onAttempt()) {
                            Bridge.log("NIMO: Reconnection successful, stopping")
                            stop()
                            return
                        }
                        handler.postDelayed(this, intervalMs)
                    }
                }
        runnable = r
        handler.postDelayed(r, firstDelayMs)
    }

    fun stop() {
        runnable?.let { handler.removeCallbacks(it) }
        runnable = null
        attempts = 0
    }
}

// ---------- Nimo Class ----------

class Nimo : SGCManager() {

    companion object {
        private const val PREFS_NAME = "NimoPrefs"
        private const val KEY_LAST_ADDRESS = "nimo_lastDeviceAddress"
        private const val KEY_LAST_NAME = "nimo_lastDeviceName"

        private const val TWS_TIMEOUT_MS = 10_000L
        private const val ACK_TIMEOUT_MS = 5_000L
        // Generous: the glasses' classic bond can take 30-45s PER attempt and may need
        // a retry, so this must cover several bond attempts + discovery + the 10s TWS gate.
        private const val PAIRING_TIMEOUT_MS = 120_000L
        // Settle time after BOND_BONDED before the first GATT connect — connecting
        // immediately races the BR/EDR teardown + CTKD finalization (status 133).
        // Measured: 1.5s was too short (the first connect-after-bond still hit 133 and
        // only the 5s reconnection timer recovered it); 5s lets the first connect land.
        private const val POST_BOND_SETTLE_MS = 5_000L
        // The glasses' BR/EDR bond is slow and flaky — it can report BOND_NONE mid-pairing
        // yet succeed on a retry, so don't treat the first failure as terminal.
        private const val MAX_BOND_ATTEMPTS = 3
        private const val BOND_RETRY_DELAY_MS = 2_000L
        private const val BATTERY_POLL_MS = 30_000L
        private const val TEXT_QUEUE_TICK_MS = 100L
        private const val WRITE_WATCHDOG_MS = 1_000L
        private const val SET_TIME_MAX_ATTEMPTS = 3
        private const val SET_TIME_RETRY_DELAY_MS = 500L
    }

    init {
        type = DeviceTypes.NIMO
        hasMic = true
    }

    // The text surface every sendTextWall renders into. The ASR note view (appId 0x04,
    // note text resId 0x00) is a plain text page that renders pushed text directly;
    // Prompter (0x06) was tried first but did not display pushed text on hardware.
    private val textAppId = NimoProtocol.APP_ID_ASR_NOTE
    private val textLayoutId = 0
    private val textResId = 0

    // BLE
    private val context: Context
        get() = Bridge.getContext()
    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var gatt: BluetoothGatt? = null
    private var txChar: BluetoothGattCharacteristic? = null
    private var rxChar: BluetoothGattCharacteristic? = null
    private var micChar: BluetoothGattCharacteristic? = null
    private var isDisconnecting = false
    private var negotiatedMtu = 23

    // Device search
    private var DEVICE_SEARCH_ID = "NOT_SET"

    private var lastDeviceAddress: String?
        get() =
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(KEY_LAST_ADDRESS, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().apply {
                if (value != null) putString(KEY_LAST_ADDRESS, value) else remove(KEY_LAST_ADDRESS)
                apply()
            }
        }

    private var lastDeviceName: String?
        get() =
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(KEY_LAST_NAME, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().apply {
                if (value != null) putString(KEY_LAST_NAME, value) else remove(KEY_LAST_NAME)
                apply()
            }
        }

    private val reconnectionManager = NimoReconnectionManager()
    private val receiveAssembler = NimoReceiveAssembler()
    private val mainHandler = Handler(Looper.getMainLooper())

    // Handshake
    private enum class HandshakeState {
        IDLE,
        AWAITING_TWS,
        AWAITING_TIME_ACK,
        READY
    }
    private var handshakeState = HandshakeState.IDLE
    private var twsConnected = false
    private var twsTimeoutRunnable: Runnable? = null
    private var pairingTimeoutRunnable: Runnable? = null

    // Pending acks keyed by (cmd shl 8) or key
    private class PendingAck(val onResult: (Boolean) -> Unit, val timeout: Runnable)
    private val pendingAcks = mutableMapOf<Int, PendingAck>()

    // Serialized write queue: Android allows one in-flight GATT op; WRITE_TYPE_DEFAULT also
    // gives us long-writes when a 509-byte frame exceeds the negotiated MTU.
    private class QueuedWrite(val char: BluetoothGattCharacteristic, val bytes: ByteArray)
    private val writeQueue = ArrayDeque<QueuedWrite>()
    private var writeInFlight = false
    private var writeWatchdog: Runnable? = null

    // Heartbeat / text queue
    private var batteryPollRunnable: Runnable? = null
    private var textQueueRunnable: Runnable? = null
    private var pendingText: String? = null
    private var textAppEntered = false
    private var navAppEntered = false
    private var currentGlassesAppId = -1

    // Battery
    private var lastBatteryLevel = -1
    private var lastCharging = false

    // Version info
    private var firmwareVersionPacked: String = ""
    private var firmwareVersionDetail: String = ""

    // Mic audio (vendor GlassesAudioClient structure)
    private val audioClient =
            NimoAudioClient(
                    sendCommand = { bytes -> micChar?.let { enqueueWrite(it, bytes) } },
                    onPcm = { pcm -> DeviceManager.getInstance().handlePcm(pcm) },
                    onActivity = { DeviceManager.getInstance().reportGlassesAudioActivity() }
            )

    // ---------- SGCManager: Connection Management ----------

    override fun findCompatibleDevices() {
        Bridge.log("NIMO: findCompatibleDevices()")
        DEVICE_SEARCH_ID = "NOT_SET"
        DeviceStore.apply("glasses", "connectionState", ConnTypes.SCANNING)
        startScan()
    }

    override fun connectById(id: String) {
        Bridge.log("NIMO: connectById($id)")
        DEVICE_SEARCH_ID = id
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        isDisconnecting = false
        bondAttempts = 0
        startPairingTimeout()
        // Bonded target → connect directly, WITHOUT starting classic discovery.
        // Inquiry monopolizes the BR/EDR radio and kills an in-flight GATT page
        // (status 133), so discovery must only run when the device is unknown.
        if (connectToBondedTarget()) return
        if (connectByAddress()) return
        startScan()
    }

    private fun connectToBondedTarget(): Boolean {
        val adapter = bluetoothAdapter ?: return false
        val target =
                try {
                    adapter.bondedDevices?.firstOrNull { it.name == DEVICE_SEARCH_ID }
                } catch (e: SecurityException) {
                    null
                }
                        ?: return false
        Bridge.log("NIMO: target is bonded — connecting directly (no discovery)")
        lastDeviceName = target.name
        lastDeviceAddress = target.address
        mainHandler.post { connectGattLe(target) }
        return true
    }

    override fun stopScan() {
        try {
            bluetoothAdapter?.cancelDiscovery()
        } catch (_: Exception) {}
        discoveryReceiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: Exception) {}
        }
        discoveryReceiver = null
    }

    override fun disconnect() {
        Bridge.log("NIMO: disconnect()")
        isDisconnecting = true
        cancelPairingTimeout()
        cancelTwsTimeout()
        stopScan()
        unregisterBondReceiver()
        stopTimers()
        reconnectionManager.stop()
        failAllPendingAcks()

        gatt?.disconnect()
        gatt?.close()
        gatt = null
        txChar = null
        rxChar = null
        micChar = null
        resetSessionState()

        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
    }

    override fun forget() {
        Bridge.log("NIMO: forget()")
        disconnect()
        lastDeviceAddress = null
        lastDeviceName = null
        DEVICE_SEARCH_ID = "NOT_SET"
    }

    override fun cleanup() {
        disconnect()
        audioClient.stop()
    }

    override fun getConnectedBluetoothName(): String {
        return gatt?.device?.name ?: ""
    }

    override fun ping() {
        sendFrame(NimoFrameCodec.encodeFrame(NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_TWS_STATUS))
    }

    override fun dbg1() {}
    override fun dbg2() {}

    // ---------- SGCManager: Audio Control ----------

    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("NIMO: setMicEnabled($enabled)")
        if (micChar == null) {
            Bridge.log("NIMO: mic characteristic not available")
            return
        }
        DeviceStore.apply("glasses", "micEnabled", enabled)
        if (enabled) {
            audioClient.start()
        } else {
            audioClient.stop()
        }
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    // ---------- SGCManager: Display Control ----------

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("NIMO: setBrightness($level, auto=$autoMode)")
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_AUTO_BRIGHTNESS,
                        byteArrayOf(if (autoMode) 1 else 0)
                )
        )
        if (!autoMode) {
            // The firmware takes a 0–16 level, not a 0–100 percent.
            val lvl =
                    Math.round(level.coerceIn(0, 100) / 100.0 * NimoProtocol.MAX_BRIGHTNESS_LEVEL)
                            .toInt()
            sendFrame(
                    NimoFrameCodec.encodeFrame(
                            NimoProtocol.CMD_SET_PARAMETER,
                            NimoProtocol.SET_BRIGHTNESS,
                            byteArrayOf(lvl.toByte())
                    )
            )
        }
    }

    override fun clearDisplay() {
        // Keep the text app/page alive — a blank update avoids re-entering the app next time.
        sendTextWall(" ")
    }

    override fun sendText(text: String) {
        // Coalesced: only the most recent pending text survives until the next 100ms drain.
        Bridge.log("NIMO: sendText(text=$text)")
        pendingText = text
    }

    override fun sendTextWall(text: String) {
        // Coalesced: only the most recent pending text survives until the next 100ms drain.
        Bridge.log("NIMO: sendTextWall(text=$text)")
        pendingText = text
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        sendTextWall(top + "\n\n" + bottom)
    }

    override fun sendPositionedText(
            text: String,
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            borderWidth: Int,
            borderRadius: Int
    ) {
        // Navigation pushes turn text via positioned_text. Nimo widgets have fixed geometry, so
        // position/border are ignored — funnel the text through the same coalesced path as
        // sendTextWall so it renders on the ASR note page. Without this override the base no-op
        // silently dropped all navigation text.
        // Bridge.log("NIMO: sendPositionedText(text=$text)")
        // pendingText = text
    }

    override fun displayBitmap(
            base64ImageData: String,
            x: Int?,
            y: Int?,
            width: Int?,
            height: Int?
    ): Boolean {
        // Nimo widgets have fixed geometry; x/y are not honored. Renders into the navigation
        // large-map widget (appId 0x01, resId 0x05, 452x170 2bpp) — the full-width nav map,
        // which shows far more than the small 160x160 mini-map (resId 0x00). bitmapToGrayscale
        // aspect-fits onto black, so a non-matching source aspect letterboxes rather than
        // distorts. The nav app must be foregrounded before pushing content (mirrors the text
        // path). TODO: hardware-verify the large-map widget renders and the nav app-mode.
        val targetWidth = NimoProtocol.NAV_LARGE_MAP_WIDTH
        val targetHeight = NimoProtocol.NAV_LARGE_MAP_HEIGHT
        Bridge.log("NIMO: displayBitmap → nav large map (navAppEntered=$navAppEntered)")
        return try {
            val imageBytes = Base64.decode(base64ImageData, Base64.DEFAULT)
            val bitmap =
                    BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size) ?: return false
            val grayscale = bitmapToGrayscale(bitmap, targetWidth, targetHeight)
            val packed = packL8To2bpp(grayscale)
            val (payload, compression) = compressAdaptive(packed)
            if (!navAppEntered) {
                sendFrame(
                        NimoFrameCodec.encodeFrame(
                                NimoProtocol.CMD_CONTROL_INSTRUCTION,
                                NimoProtocol.CTRL_ENTER_APP,
                                byteArrayOf(
                                        NimoProtocol.APP_ID_NAV.toByte(),
                                        NimoProtocol.APP_MODE_STANDALONE.toByte()
                                )
                        )
                )
                // Optimistic; corrected by app-state reports if the glasses refuse/exit.
                navAppEntered = true
            }
            val content =
                    NimoFrameCodec.imageHeader(
                            width = targetWidth,
                            height = targetHeight,
                            formatBpp = NimoProtocol.FORMAT_2BPP,
                            compression = compression,
                            originalSize = packed.size,
                            compressedSize =
                                    if (compression == NimoProtocol.COMPRESSION_NONE) 0
                                    else payload.size
                    ) + payload
            val frames =
                    NimoFrameCodec.updateContentFrames(
                            appId = NimoProtocol.APP_ID_NAV,
                            layoutId = 0,
                            resId = NimoProtocol.NAV_RES_LARGE_MAP,
                            resType = NimoProtocol.WIDGET_PICTURE,
                            content = content
                    )
            enqueueFrames(frames)
            true
        } catch (e: Exception) {
            Bridge.log("NIMO: displayBitmap failed: ${e.message}")
            false
        }
    }

    override fun showDashboard() {
        Bridge.log("NIMO: showDashboard()")
        textAppEntered = false
        navAppEntered = false
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_CONTROL_INSTRUCTION,
                        NimoProtocol.CTRL_ENTER_APP,
                        byteArrayOf(
                                NimoProtocol.APP_ID_DASHBOARD.toByte(),
                                NimoProtocol.APP_MODE_STANDALONE.toByte()
                        )
                )
        )
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("NIMO: setDashboardPosition($height, $depth)")
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_HEIGHT_LEVEL,
                        byteArrayOf(height.coerceIn(0, 10).toByte())
                )
        )
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_DISTANCE,
                        byteArrayOf(depth.coerceIn(0, 10).toByte())
                )
        )
    }

    // ---------- SGCManager: Device Control ----------

    override fun setHeadUpAngle(angle: Int) {
        val clamped = angle.coerceIn(0, 90)
        Bridge.log("NIMO: setHeadUpAngle($clamped)")
        // Enable the head-up display gesture, then set the wake angle.
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_HEADUP_DISPLAY,
                        byteArrayOf(1)
                )
        )
        // setAngle payload is [optType, deg]. TODO: hardware-verify optType semantics.
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_ANGLE,
                        byteArrayOf(0x01, clamped.toByte())
                )
        )
    }

    override fun getBatteryStatus() {
        sendFrame(NimoFrameCodec.encodeFrame(NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_BATTERY))
    }

    override fun setSilentMode(enabled: Boolean) {
        Bridge.log("NIMO: setSilentMode($enabled)")
        // TODO: hardware-verify that display-off matches MentraOS silent-mode semantics.
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_DISPLAY_OFF,
                        byteArrayOf(if (enabled) 1 else 0)
                )
        )
    }

    override fun exit() {
        Bridge.log("NIMO: exit()")
        val appId = if (currentGlassesAppId >= 0) currentGlassesAppId else textAppId
        textAppEntered = false
        navAppEntered = false
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_CONTROL_INSTRUCTION,
                        NimoProtocol.CTRL_QUIT_APP,
                        byteArrayOf(appId.toByte())
                )
        )
    }

    override fun sendShutdown() {
        Bridge.log("NIMO: sendShutdown - not supported")
    }

    override fun sendReboot() {
        Bridge.log("NIMO: sendReboot - not supported")
    }

    override fun sendRgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            onDurationMs: Int,
            offDurationMs: Int,
            count: Int
    ) {
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // ---------- Notifications ----------

    /**
     * Pushes a notification (cmd=0x09 key=0x01, fixed 319-byte struct:
     * appId(1) + title(51, UTF-8 zero-padded) + time(9) + contentLen(2 LE) + content(256)).
     */
    fun sendNotification(notificationAppId: Int, title: String, content: String) {
        val payload = ByteArray(319)
        payload[0] = notificationAppId.coerceIn(0, 255).toByte()
        writeUtf8Padded(payload, 1, title, 51)
        NimoFrameCodec.encodeDeviceTime().copyInto(payload, 52)
        val contentBytes = content.toByteArray(Charsets.UTF_8)
        val clen = minOf(contentBytes.size, 256)
        payload[61] = (clen and 0xFF).toByte()
        payload[62] = ((clen shr 8) and 0xFF).toByte()
        writeUtf8Padded(payload, 63, content, 256)
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_CONTROL_NOTIFICATION,
                        NimoProtocol.NOTIFICATION_SEND,
                        payload
                )
        )
    }

    private fun writeUtf8Padded(dest: ByteArray, offset: Int, text: String, maxLen: Int) {
        var bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size > maxLen) {
            // Truncate on a UTF-8 boundary
            var end = maxLen
            while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
            bytes = bytes.copyOfRange(0, end)
        }
        bytes.copyInto(dest, offset)
    }

    // ---------- SGCManager: Camera & Media (no camera) ----------

    override fun requestPhoto(request: PhotoRequest) {
        Bridge.log("NIMO: requestPhoto - not supported (no camera)")
    }

    override fun startStream(message: MutableMap<String, Any>) {
        Bridge.log("NIMO: startStream - not supported")
    }

    override fun stopStream() {
        Bridge.log("NIMO: stopStream - not supported")
    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("NIMO: sendStreamKeepAlive - not supported")
    }

    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {
        Bridge.log("NIMO: startVideoRecording - not supported")
    }

    override fun stopVideoRecording(requestId: String) {
        Bridge.log("NIMO: stopVideoRecording - not supported")
    }

    override fun sendButtonPhotoSettings() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendCameraFovSetting() {}

    // ---------- SGCManager: Network (no WiFi) ----------

    override fun requestWifiScan(scanId: String?) {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}

    // ---------- SGCManager: User Context / Gallery / Version ----------

    override fun sendUserEmailToGlasses(email: String) {}
    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}
    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}

    override fun requestVersionInfo() {
        sendFrame(NimoFrameCodec.encodeFrame(NimoProtocol.CMD_GET_PARAMETER, NimoProtocol.GET_VERSION))
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_GET_PARAMETER,
                        NimoProtocol.GET_VERSION_DETAIL
                )
        )
    }

    // ---------- Device Discovery (classic Bluetooth — mirrors the vendor transport) ----------
    //
    // The MAIN Nimo device does not BLE-advertise under its name; only the "<name>_BLE"
    // ANCS side channel advertises, and that device has no data service. The vendor's
    // Android transport therefore discovers the main device over CLASSIC Bluetooth
    // (bonded list + discovery) and then connects BLE GATT to the same address
    // (dual-mode chip, shared MAC).

    private fun isNimoMainDevice(name: String): Boolean {
        val lower = name.lowercase()
        return lower.startsWith(NimoBLE.NAME_PREFIX) && !lower.endsWith(NimoBLE.BLE_NAME_SUFFIX)
    }

    private var discoveryReceiver: android.content.BroadcastReceiver? = null

    private fun startScan(): Boolean {
        Bridge.log("NIMO: startScan() (classic discovery)")
        stopScan()

        val adapter =
                bluetoothAdapter
                        ?: run {
                            Bridge.log("NIMO: BluetoothAdapter not available")
                            return false
                        }
        if (!adapter.isEnabled) {
            Bridge.log("NIMO: Bluetooth not enabled")
            return false
        }

        // 1) Bonded devices first: Android does not re-discover already-paired devices.
        try {
            for (device in adapter.bondedDevices ?: emptySet()) {
                val name = device.name ?: continue
                if (!isNimoMainDevice(name)) continue
                Bridge.log("NIMO: bonded Nimo device: $name (${device.address})")
                mainHandler.post { onDeviceFound(device, name) }
            }
        } catch (e: SecurityException) {
            Bridge.log("NIMO: bondedDevices SecurityException: ${e.message}")
        }

        // 2) Classic discovery for unbonded glasses.
        val receiver =
                object : android.content.BroadcastReceiver() {
                    @Suppress("deprecation")
                    override fun onReceive(ctx: Context?, intent: android.content.Intent?) {
                        if (intent?.action != android.bluetooth.BluetoothDevice.ACTION_FOUND) return
                        val device: android.bluetooth.BluetoothDevice =
                                intent.getParcelableExtra(
                                        android.bluetooth.BluetoothDevice.EXTRA_DEVICE
                                )
                                        ?: return
                        val name =
                                try {
                                    device.name
                                } catch (e: SecurityException) {
                                    null
                                }
                                        ?: intent.getStringExtra(
                                                android.bluetooth.BluetoothDevice.EXTRA_NAME
                                        )
                                        ?: return
                        if (!isNimoMainDevice(name)) return
                        mainHandler.post { onDeviceFound(device, name) }
                    }
                }
        discoveryReceiver = receiver
        context.registerReceiver(
                receiver,
                android.content.IntentFilter(android.bluetooth.BluetoothDevice.ACTION_FOUND)
        )
        return try {
            val started = adapter.startDiscovery()
            Bridge.log("NIMO: classic discovery started: $started")
            true
        } catch (e: SecurityException) {
            Bridge.log("NIMO: startDiscovery SecurityException — bluetooth permission missing: ${e.message}")
            false
        } catch (e: Exception) {
            Bridge.log("NIMO: startDiscovery failed: ${e.message}")
            false
        }
    }

    private fun onDeviceFound(device: android.bluetooth.BluetoothDevice, name: String) {
        Bridge.sendDiscoveredDevice(DeviceTypes.NIMO, name, device.address ?: "")

        if (DEVICE_SEARCH_ID == "NOT_SET") return
        if (name != DEVICE_SEARCH_ID) return
        if (gatt != null) return

        Bridge.log("NIMO: Connecting to $name (${device.address})")
        stopScan()
        lastDeviceName = name
        lastDeviceAddress = device.address
        connectGattLe(device)
    }

    /**
     * Vendor connection model (from bitfantasy_glasses_sdk_transport_ble + their
     * flutter_blue_plus fork notes, "Android CTKD transport=BREDR"):
     *
     * 1. The main device is discovered over CLASSIC Bluetooth (it never advertises its
     *    name over LE; the "<name>_BLE" peripheral is a separate ANCS-only device).
     * 2. Pairing is a CLASSIC (BR/EDR) bond. CTKD (cross-transport key derivation)
     *    derives the LE keys — critically the IRK — during that bond.
     * 3. The DATA channel is GATT over LE (service 7033). The glasses advertise with a
     *    resolvable private address, so connecting by their public MAC only works once
     *    the phone holds the IRK from step 2. (Same reason iOS requires Settings-app
     *    pairing first — iOS performs the classic bond + CTKD itself.)
     */
    private fun connectGattLe(device: android.bluetooth.BluetoothDevice) {
        // Classic discovery degrades/aborts connections — always cancel first.
        try {
            bluetoothAdapter?.cancelDiscovery()
        } catch (_: Exception) {}

        val bondState =
                try {
                    device.bondState
                } catch (e: SecurityException) {
                    android.bluetooth.BluetoothDevice.BOND_NONE
                }
        if (bondState != android.bluetooth.BluetoothDevice.BOND_BONDED) {
            // Bond over classic first (CTKD gives us the LE keys); connect on completion.
            startBond(device)
            return
        }
        connectLeTransport(device)
    }

    /**
     * Kicks off (or retries) the classic bond. The glasses' BR/EDR bond is slow (30-45s)
     * and flaky — it can report BOND_NONE mid-pairing yet succeed on a retry — so this is
     * called both on the initial attempt and from the BOND_NONE handler.
     */
    private fun startBond(device: android.bluetooth.BluetoothDevice) {
        val bondState =
                try {
                    device.bondState
                } catch (e: SecurityException) {
                    android.bluetooth.BluetoothDevice.BOND_NONE
                }
        // A previous (apparently failed) attempt may have bonded in the background.
        if (bondState == android.bluetooth.BluetoothDevice.BOND_BONDED) {
            Bridge.log("NIMO: already bonded with ${device.address} — connecting")
            unregisterBondReceiver()
            connectLeTransport(device)
            return
        }
        // Don't fire a second createBond on top of one already in flight (duplicate
        // connectById calls do this, and it poisons the bond).
        if (bondState == android.bluetooth.BluetoothDevice.BOND_BONDING ||
                        (bondReceiver != null && bondingAddress == device.address)
        ) {
            Bridge.log("NIMO: bond already in progress for ${device.address} — waiting")
            registerBondReceiver(device)
            bondingAddress = device.address
            return
        }
        bondAttempts++
        Bridge.log(
                "NIMO: creating classic bond with ${device.address} (attempt $bondAttempts/$MAX_BOND_ATTEMPTS)"
        )
        DeviceStore.apply("glasses", "connectionState", ConnTypes.BONDING)
        registerBondReceiver(device)
        bondingAddress = device.address
        val started =
                try {
                    device.createBond()
                } catch (e: SecurityException) {
                    Bridge.log("NIMO: createBond SecurityException: ${e.message}")
                    false
                }
        if (!started) {
            Bridge.log("NIMO: createBond failed to start — trying LE connect anyway")
            unregisterBondReceiver()
            connectLeTransport(device)
        }
    }

    private fun connectLeTransport(device: android.bluetooth.BluetoothDevice) {
        // GATT over BR/EDR: the glasses pair with a legacy (non-SC) link key, so no LE
        // keys exist (le_linkkey_known:F) and the controller records the device as
        // BR_EDR-only — the 7033 UART service is served over the classic link. This is
        // what the vendor's flutter_blue_plus fork patches in ("transport=BREDR"), and
        // why iOS needs Settings pairing (CoreBluetooth bridges GATT over BR/EDR only
        // for system-paired dual-mode accessories).
        Bridge.log("NIMO: connecting GATT over BR/EDR to ${device.address}")
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        gatt =
                device.connectGatt(
                        context,
                        false,
                        gattCallback,
                        android.bluetooth.BluetoothDevice.TRANSPORT_BREDR
                )
    }

    private var bondReceiver: android.content.BroadcastReceiver? = null
    private var bondAttempts = 0
    private var bondingAddress: String? = null

    private fun registerBondReceiver(target: android.bluetooth.BluetoothDevice) {
        unregisterBondReceiver()
        val receiver =
                object : android.content.BroadcastReceiver() {
                    @Suppress("deprecation")
                    override fun onReceive(ctx: Context?, intent: android.content.Intent?) {
                        if (intent?.action !=
                                        android.bluetooth.BluetoothDevice.ACTION_BOND_STATE_CHANGED
                        )
                                return
                        val device: android.bluetooth.BluetoothDevice =
                                intent.getParcelableExtra(
                                        android.bluetooth.BluetoothDevice.EXTRA_DEVICE
                                )
                                        ?: return
                        val state =
                                intent.getIntExtra(
                                        android.bluetooth.BluetoothDevice.EXTRA_BOND_STATE,
                                        android.bluetooth.BluetoothDevice.BOND_NONE
                                )
                        Bridge.log("NIMO: bond state changed: ${device.address} state=$state")
                        if (device.address != target.address) return
                        mainHandler.post {
                            when (state) {
                                android.bluetooth.BluetoothDevice.BOND_BONDED -> {
                                    Bridge.log(
                                            "NIMO: bonded with ${device.address} — settling before GATT connect"
                                    )
                                    unregisterBondReceiver()
                                    // Connecting GATT the instant BOND_BONDED fires races the
                                    // BR/EDR link teardown + CTKD finalization and comes back as
                                    // status 133. Let the stack settle so the first-ever connect
                                    // (right after pairing) succeeds instead of failing until the
                                    // user manually retries into the already-bonded fast path.
                                    mainHandler.postDelayed(
                                            { connectLeTransport(device) },
                                            POST_BOND_SETTLE_MS
                                    )
                                }
                                android.bluetooth.BluetoothDevice.BOND_NONE -> {
                                    unregisterBondReceiver()
                                    // The bond can report NONE mid-pairing yet succeed on a
                                    // retry — only surface failure once retries are exhausted.
                                    if (bondAttempts < MAX_BOND_ATTEMPTS && !isDisconnecting) {
                                        Bridge.log(
                                                "NIMO: bond attempt $bondAttempts failed for ${device.address} — retrying in ${BOND_RETRY_DELAY_MS}ms"
                                        )
                                        mainHandler.postDelayed(
                                                { if (!isDisconnecting) startBond(device) },
                                                BOND_RETRY_DELAY_MS
                                        )
                                    } else {
                                        Bridge.log(
                                                "NIMO: bonding failed with ${device.address} after $bondAttempts attempts"
                                        )
                                        Bridge.sendPairFailureEvent("errors:pairNeedDisconnect")
                                    }
                                }
                                // BOND_BONDING: in progress — wait.
                            }
                        }
                    }
                }
        bondReceiver = receiver
        context.registerReceiver(
                receiver,
                android.content.IntentFilter(
                        android.bluetooth.BluetoothDevice.ACTION_BOND_STATE_CHANGED
                )
        )
    }

    private fun unregisterBondReceiver() {
        bondReceiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: Exception) {}
        }
        bondReceiver = null
        bondingAddress = null
    }

    private fun connectByAddress(): Boolean {
        if (DEVICE_SEARCH_ID == "NOT_SET" || DEVICE_SEARCH_ID.isEmpty()) return false
        if (lastDeviceName != DEVICE_SEARCH_ID) return false
        val address = lastDeviceAddress ?: return false
        val adapter = bluetoothAdapter ?: return false
        return try {
            val device = adapter.getRemoteDevice(address)
            Bridge.log("NIMO: connectByAddress - ${device.name ?: address}")
            connectGattLe(device)
            true
        } catch (e: Exception) {
            Bridge.log("NIMO: connectByAddress failed: ${e.message}")
            false
        }
    }

    private fun startPairingTimeout() {
        cancelPairingTimeout()
        val work = Runnable {
            if (!fullyBooted) {
                Bridge.log("NIMO: pairing timeout — handshake never completed")
                Bridge.sendPairFailureEvent("errors:pairNeedDisconnect")
            }
        }
        pairingTimeoutRunnable = work
        mainHandler.postDelayed(work, PAIRING_TIMEOUT_MS)
    }

    private fun cancelPairingTimeout() {
        pairingTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        pairingTimeoutRunnable = null
    }

    // ---------- GATT Callback ----------

    private val gattCallback =
            object : BluetoothGattCallback() {
                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                    mainHandler.post {
                        Bridge.log("NIMO: onConnectionStateChange status=$status newState=$newState")
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            Bridge.log("NIMO: Connected to ${g.device?.name ?: "unknown"}")
                            lastDeviceAddress = g.device?.address
                            // Do NOT request a large MTU here: the vendor transport warns that
                            // requesting one during connect makes some Nimo firmwares throw a
                            // GATT error and loop reconnecting. The system negotiates the MTU;
                            // frames larger than it go out as ATT long writes (WRITE_TYPE_DEFAULT).
                            try {
                                g.discoverServices()
                            } catch (e: SecurityException) {
                                Bridge.log("NIMO: discoverServices SecurityException: ${e.message}")
                            }
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            Bridge.log("NIMO: Disconnected")
                            if (isDisconnecting) return@post

                            gatt?.close()
                            gatt = null
                            txChar = null
                            rxChar = null
                            micChar = null
                            resetSessionState()

                            DeviceStore.apply("glasses", "connected", false)
                            DeviceStore.apply("glasses", "fullyBooted", false)
                            DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
                            startReconnectionTimer()
                        }
                    }
                }

                override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                    Bridge.log("NIMO: onMtuChanged mtu=$mtu status=$status")
                    mainHandler.post {
                        negotiatedMtu = mtu
                        try {
                            g.discoverServices()
                        } catch (e: SecurityException) {
                            Bridge.log("NIMO: discoverServices SecurityException: ${e.message}")
                        }
                    }
                }

                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        Bridge.log("NIMO: onServicesDiscovered failed status=$status")
                        return
                    }
                    mainHandler.post {
                        val service = g.getService(NimoBLE.SERVICE_UUID)
                        if (service == null) {
                            // Dump everything so a UUID mismatch is diagnosable from logs.
                            Bridge.log("NIMO: UART service not found; discovered services:")
                            for (s in g.services ?: emptyList()) {
                                val chars = s.characteristics.joinToString(", ") { it.uuid.toString() }
                                Bridge.log("NIMO:   service ${s.uuid} chars=[$chars]")
                            }
                            // Vendor treats a missing service as a connection FAILURE (it throws
                            // and the upper layer reconnects). Disconnect so our reconnection /
                            // transport-alternation logic engages instead of idling here.
                            g.disconnect()
                            return@post
                        }
                        txChar = service.getCharacteristic(NimoBLE.CHAR_TX)
                        rxChar = service.getCharacteristic(NimoBLE.CHAR_RX)
                        micChar = service.getCharacteristic(NimoBLE.CHAR_MIC)
                        Bridge.log(
                                "NIMO: chars tx=${txChar != null} rx=${rxChar != null} mic=${micChar != null}"
                        )
                        if (txChar == null || rxChar == null) {
                            Bridge.log("NIMO: required characteristics missing")
                            g.disconnect()
                            return@post
                        }
                        enableNotifications(g, rxChar!!) {
                            micChar?.let { mic -> enableNotifications(g, mic) {} }
                            startHandshake()
                        }
                    }
                }

                @Deprecated("Deprecated in API level 33")
                override fun onCharacteristicChanged(
                        g: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic
                ) {
                    val data = characteristic.value ?: return
                    when (characteristic.uuid) {
                        NimoBLE.CHAR_RX -> mainHandler.post { handleRxPacket(data) }
                        NimoBLE.CHAR_MIC -> audioClient.enqueue(data)
                    }
                }

                override fun onCharacteristicWrite(
                        g: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic,
                        status: Int
                ) {
                    mainHandler.postDelayed(
                            {
                                writeInFlight = false
                                drainWriteQueue()
                            },
                            NimoBLE.INTER_FRAME_DELAY_MS
                    )
                }

                override fun onDescriptorWrite(
                        g: BluetoothGatt,
                        descriptor: BluetoothGattDescriptor,
                        status: Int
                ) {
                    mainHandler.post { descriptorWriteCompletion?.let { it() } }
                }
            }

    private var descriptorWriteCompletion: (() -> Unit)? = null

    @Suppress("deprecation")
    private fun enableNotifications(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            onComplete: () -> Unit
    ) {
        g.setCharacteristicNotification(characteristic, true)
        val descriptor = characteristic.getDescriptor(NimoBLE.CLIENT_CHARACTERISTIC_CONFIG)
        if (descriptor != null) {
            descriptorWriteCompletion = {
                descriptorWriteCompletion = null
                onComplete()
            }
            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            g.writeDescriptor(descriptor)
        } else {
            onComplete()
        }
    }

    // ---------- Write Queue ----------

    @Suppress("deprecation")
    private fun drainWriteQueue() {
        if (writeInFlight) return
        val item = writeQueue.removeFirstOrNull() ?: return
        val g = gatt
        if (g == null) {
            writeQueue.clear()
            return
        }
        writeInFlight = true
        item.char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        item.char.value = item.bytes
        val ok =
                try {
                    g.writeCharacteristic(item.char)
                } catch (e: Exception) {
                    Bridge.log("NIMO: writeCharacteristic failed: ${e.message}")
                    false
                }
        if (!ok) {
            // Another GATT op (e.g. a descriptor write) is in flight — requeue and retry
            // shortly instead of dropping the frame.
            writeInFlight = false
            writeQueue.addFirst(item)
            mainHandler.postDelayed({ drainWriteQueue() }, 100)
            return
        }
        // Watchdog: if the write callback never arrives, unblock the queue.
        writeWatchdog?.let { mainHandler.removeCallbacks(it) }
        val watchdog = Runnable {
            if (writeInFlight) {
                Bridge.log("NIMO: write watchdog fired — forcing queue drain")
                writeInFlight = false
                drainWriteQueue()
            }
        }
        writeWatchdog = watchdog
        mainHandler.postDelayed(watchdog, WRITE_WATCHDOG_MS)
    }

    private fun enqueueWrite(char: BluetoothGattCharacteristic, bytes: ByteArray) {
        mainHandler.post {
            writeQueue.addLast(QueuedWrite(char, bytes))
            drainWriteQueue()
        }
    }

    private fun sendFrame(frame: ByteArray) {
        val tx = txChar ?: return
        enqueueWrite(tx, frame)
    }

    private fun enqueueFrames(frames: List<ByteArray>) {
        val tx = txChar ?: return
        mainHandler.post {
            for (frame in frames) {
                writeQueue.addLast(QueuedWrite(tx, frame))
            }
            drainWriteQueue()
        }
    }

    // ---------- Pending ACKs ----------

    private fun sendAwaitingAck(
            cmd: Int,
            key: Int,
            payload: ByteArray,
            timeoutMs: Long = ACK_TIMEOUT_MS,
            onResult: (Boolean) -> Unit
    ) {
        val ackKey = (cmd shl 8) or key
        // Only one in-flight ack per (cmd,key); fail any previous waiter.
        pendingAcks.remove(ackKey)?.let {
            mainHandler.removeCallbacks(it.timeout)
            it.onResult(false)
        }
        val timeout = Runnable {
            pendingAcks.remove(ackKey)?.onResult(false)
        }
        pendingAcks[ackKey] = PendingAck(onResult, timeout)
        mainHandler.postDelayed(timeout, timeoutMs)
        sendFrame(NimoFrameCodec.encodeFrame(cmd, key, payload, needsAck = true))
    }

    private fun resolvePendingAck(cmd: Int, key: Int, success: Boolean) {
        val ackKey = (cmd shl 8) or key
        pendingAcks.remove(ackKey)?.let {
            mainHandler.removeCallbacks(it.timeout)
            it.onResult(success)
        }
    }

    private fun failAllPendingAcks() {
        val acks = pendingAcks.values.toList()
        pendingAcks.clear()
        for (ack in acks) {
            mainHandler.removeCallbacks(ack.timeout)
            ack.onResult(false)
        }
    }

    // ---------- Handshake ----------

    private fun startHandshake() {
        Bridge.log("NIMO: starting handshake (awaiting TWS service-connection state)")
        handshakeState = HandshakeState.AWAITING_TWS
        if (twsConnected) {
            proceedToTimeSync()
            return
        }
        cancelTwsTimeout()
        val timeout = Runnable {
            if (handshakeState == HandshakeState.AWAITING_TWS) {
                Bridge.log("NIMO: TWS state timeout — handshake failed, will reconnect")
                handshakeFailed()
            }
        }
        twsTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, TWS_TIMEOUT_MS)
        // Also actively query in case the glasses don't push the report unprompted.
        ping()
    }

    private fun cancelTwsTimeout() {
        twsTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        twsTimeoutRunnable = null
    }

    private var setTimeAttempts = 0

    private fun proceedToTimeSync() {
        if (handshakeState != HandshakeState.AWAITING_TWS) return
        cancelTwsTimeout()
        handshakeState = HandshakeState.AWAITING_TIME_ACK
        Bridge.log("NIMO: TWS OK — sending setTime (awaiting ACK)")
        setTimeAttempts = 0
        attemptSetTime()
    }

    private fun attemptSetTime() {
        if (handshakeState != HandshakeState.AWAITING_TIME_ACK || gatt == null) return
        setTimeAttempts++
        sendAwaitingAck(
                NimoProtocol.CMD_SET_PARAMETER,
                NimoProtocol.SET_TIME,
                NimoFrameCodec.encodeDeviceTime()
        ) { ok ->
            if (ok) {
                finishHandshake()
            } else if (setTimeAttempts < SET_TIME_MAX_ATTEMPTS &&
                            handshakeState == HandshakeState.AWAITING_TIME_ACK &&
                            gatt != null
            ) {
                // The firmware can answer "busy" right after the link comes up —
                // give it a moment and retry instead of dropping the connection.
                Bridge.log("NIMO: setTime attempt $setTimeAttempts failed — retrying")
                mainHandler.postDelayed({ attemptSetTime() }, SET_TIME_RETRY_DELAY_MS)
            } else {
                Bridge.log("NIMO: setTime failed after $setTimeAttempts attempts — handshake failed")
                handshakeFailed()
            }
        }
    }

    private fun finishHandshake() {
        Bridge.log("NIMO: handshake complete — fully connected")
        handshakeState = HandshakeState.READY
        sendFrame(
                NimoFrameCodec.encodeFrame(
                        NimoProtocol.CMD_SET_PARAMETER,
                        NimoProtocol.SET_PHONE_TYPE,
                        byteArrayOf(NimoProtocol.PHONE_TYPE_OTHER.toByte()),
                        needsAck = false
                )
        )
        getBatteryStatus()
        requestVersionInfo()

        cancelPairingTimeout()
        reconnectionManager.stop()
        DeviceStore.apply("glasses", "connected", true)
        DeviceStore.apply("glasses", "fullyBooted", true)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        startTimers()
    }

    private fun handshakeFailed() {
        handshakeState = HandshakeState.IDLE
        gatt?.disconnect()
        // The DISCONNECTED callback path handles cleanup + reconnection.
    }

    private fun resetSessionState() {
        handshakeState = HandshakeState.IDLE
        twsConnected = false
        textAppEntered = false
        navAppEntered = false
        currentGlassesAppId = -1
        pendingText = null
        audioClient.stop()
        receiveAssembler.reset()
        writeQueue.clear()
        writeInFlight = false
        writeWatchdog?.let { mainHandler.removeCallbacks(it) }
        writeWatchdog = null
        failAllPendingAcks()
        stopTimers()
    }

    private fun startReconnectionTimer() {
        reconnectionManager.start {
            if (fullyBooted) {
                return@start true
            }
            Bridge.log("NIMO: Attempting reconnection...")
            isDisconnecting = false
            // Each reconnection cycle is a fresh bond budget — the glasses drop their
            // bond on some disconnects (status 19), so this path may need to re-bond.
            bondAttempts = 0
            if (!connectByAddress()) {
                startScan()
            }
            return@start false
        }
    }

    // ---------- Timers (battery poll keepalive + text queue) ----------

    private fun startTimers() {
        stopTimers()
        val battery =
                object : Runnable {
                    override fun run() {
                        // Doubles as a keepalive so the link never goes idle long enough for
                        // the stack to reclaim it.
                        getBatteryStatus()
                        mainHandler.postDelayed(this, BATTERY_POLL_MS)
                    }
                }
        batteryPollRunnable = battery
        mainHandler.postDelayed(battery, BATTERY_POLL_MS)

        val textQueue =
                object : Runnable {
                    override fun run() {
                        drainTextQueue()
                        mainHandler.postDelayed(this, TEXT_QUEUE_TICK_MS)
                    }
                }
        textQueueRunnable = textQueue
        mainHandler.postDelayed(textQueue, TEXT_QUEUE_TICK_MS)
    }

    private fun stopTimers() {
        batteryPollRunnable?.let { mainHandler.removeCallbacks(it) }
        batteryPollRunnable = null
        textQueueRunnable?.let { mainHandler.removeCallbacks(it) }
        textQueueRunnable = null
    }

    // ---------- Text Rendering ----------

    /**
     * TEMP HW TEST: build a 160x160 grayscale test pattern (four vertical bands
     * at the 4 quantization levels: black | dark | light | white) and push it
     * through the exact same nav-minimap pipeline as displayBitmap. If the bands
     * render left→right on the glasses, the SDK bitmap path works end-to-end.
     */
    private fun displaySampleBitmap() {
        val w = 160
        val h = 160
        val gray = ByteArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val band = (x * 4 / w).coerceIn(0, 3) // 0..3 across the width
                gray[y * w + x] = (band * 85).toByte() // 0, 85, 170, 255
            }
        }
        val packed = packL8To2bpp(gray)
        val (payload, compression) = compressAdaptive(packed)
        if (!navAppEntered) {
            sendFrame(
                    NimoFrameCodec.encodeFrame(
                            NimoProtocol.CMD_CONTROL_INSTRUCTION,
                            NimoProtocol.CTRL_ENTER_APP,
                            byteArrayOf(
                                    NimoProtocol.APP_ID_NAV.toByte(),
                                    NimoProtocol.APP_MODE_STANDALONE.toByte()
                            )
                    )
            )
            navAppEntered = true
        }
        val content =
                NimoFrameCodec.imageHeader(
                        width = w,
                        height = h,
                        formatBpp = NimoProtocol.FORMAT_2BPP,
                        compression = compression,
                        originalSize = packed.size,
                        compressedSize =
                                if (compression == NimoProtocol.COMPRESSION_NONE) 0
                                else payload.size
                ) + payload
        val frames =
                NimoFrameCodec.updateContentFrames(
                        appId = NimoProtocol.APP_ID_NAV,
                        layoutId = 0,
                        resId = 0,
                        resType = NimoProtocol.WIDGET_PICTURE,
                        content = content
                )
        enqueueFrames(frames)
        Bridge.log(
                "NIMO: displaySampleBitmap → ${frames.size} frames, ${payload.size}B comp=$compression"
        )
    }

    private fun drainTextQueue() {
        val text = pendingText ?: return
        if (handshakeState != HandshakeState.READY) return
        pendingText = null

        // All text (text_wall / double_text_wall / reference_card / positioned_text) renders on
        // the ASR note page — the only text surface confirmed to render on hardware.
        Bridge.log("NIMO: text → glasses (enterApp=${!textAppEntered}): \"${text.take(60)}\"")
        if (!textAppEntered) {
            sendFrame(
                    NimoFrameCodec.encodeFrame(
                            NimoProtocol.CMD_CONTROL_INSTRUCTION,
                            NimoProtocol.CTRL_ENTER_APP,
                            byteArrayOf(textAppId.toByte(), NimoProtocol.APP_MODE_STANDALONE.toByte())
                    )
            )
            // Optimistic; corrected by app-state reports if the glasses refuse/exit.
            textAppEntered = true
        }

        val frames =
                NimoFrameCodec.updateContentFrames(
                        appId = textAppId,
                        layoutId = textLayoutId,
                        resId = textResId,
                        resType = NimoProtocol.WIDGET_TEXT_NEW,
                        content = text.toByteArray(Charsets.UTF_8)
                )
        enqueueFrames(frames)
    }

    // ---------- Incoming Data ----------

    private fun handleRxPacket(packet: ByteArray) {
        receiveAssembler.cleanup()
        for (frame in receiveAssembler.ingest(packet)) {
            val decoded = NimoFrameCodec.decode(frame) ?: continue
            val cmd = decoded.cmd ?: continue
            val key = decoded.key ?: continue
            if (cmd == NimoProtocol.CMD_INSTRUCTION_REPORT) {
                handleReport(key, decoded.data ?: ByteArray(0))
            } else {
                handleResponse(cmd, key, decoded.statusCode ?: 1, decoded.data ?: ByteArray(0))
            }
        }
    }

    private fun handleReport(key: Int, data: ByteArray) {
        when (key) {
            NimoProtocol.REPORT_INPUT -> {
                if (data.isNotEmpty()) handleInputEvent(data[0].toInt() and 0xFF)
            }
            NimoProtocol.REPORT_APP -> {
                if (data.size >= 2) {
                    val appId = data[0].toInt() and 0xFF
                    val phase = data[1].toInt() and 0xFF
                    Bridge.log("NIMO: app state report appId=$appId phase=$phase")
                    when (phase) {
                        NimoProtocol.STATE_ENTER -> {
                            currentGlassesAppId = appId
                            if (appId != textAppId) textAppEntered = false
                            if (appId != NimoProtocol.APP_ID_NAV) navAppEntered = false
                        }
                        NimoProtocol.STATE_EXIT -> {
                            if (appId == currentGlassesAppId) currentGlassesAppId = -1
                            if (appId == textAppId) textAppEntered = false
                            if (appId == NimoProtocol.APP_ID_NAV) navAppEntered = false
                        }
                    }
                }
            }
            NimoProtocol.REPORT_TWS -> {
                if (data.isNotEmpty()) {
                    onTwsState((data[0].toInt() and 0xFF) >= 1)
                }
            }
            NimoProtocol.REPORT_BUSINESS -> handleBusinessReport(data)
            NimoProtocol.REPORT_GATT_STATE -> {}
            else -> Bridge.log("NIMO: unknown report key=$key")
        }
    }

    private fun handleBusinessReport(data: ByteArray) {
        if (data.isEmpty()) return
        val id = data[0].toInt() and 0xFF
        val v = data.copyOfRange(1, data.size)
        when (id) {
            NimoProtocol.BUSINESS_HEARTBEAT -> {
                // [leftMv(2)][rightMv(2)][btSysStatus(4)][twsStatus(1)][slaveGatt(1)]
                if (v.size >= 10) {
                    onTwsState((v[8].toInt() and 0xFF) >= 1)
                }
            }
            NimoProtocol.BUSINESS_BATTERY -> {
                if (v.size >= 4) {
                    applyBattery(
                            left = v[0].toInt() and 0xFF,
                            right = v[1].toInt() and 0xFF,
                            leftCharging = v[2].toInt() == 1,
                            rightCharging = v[3].toInt() == 1
                    )
                }
            }
            else -> {}
        }
    }

    private fun onTwsState(connected: Boolean) {
        twsConnected = connected
        if (connected && handshakeState == HandshakeState.AWAITING_TWS) {
            proceedToTimeSync()
        }
        if (!connected && handshakeState == HandshakeState.READY) {
            Bridge.log("NIMO: TWS service dropped mid-session (arm removed/off?)")
        }
    }

    private fun handleInputEvent(code: Int) {
        val timestamp = System.currentTimeMillis()
        when (code) {
            NimoProtocol.INPUT_HEAD_UP -> {
                DeviceStore.apply("glasses", "headUp", true)
                Bridge.sendHeadUp(true)
            }
            NimoProtocol.INPUT_HEAD_DOWN -> {
                DeviceStore.apply("glasses", "headUp", false)
                Bridge.sendHeadUp(false)
            }
            NimoProtocol.INPUT_CLICK_RIGHT, NimoProtocol.INPUT_CLICK_LEFT ->
                    Bridge.sendTouchEvent(DeviceTypes.NIMO, "single_tap", timestamp)
            NimoProtocol.INPUT_DOUBLE_CLICK_RIGHT, NimoProtocol.INPUT_DOUBLE_CLICK_LEFT ->
                    Bridge.sendTouchEvent(DeviceTypes.NIMO, "double_tap", timestamp)
            NimoProtocol.INPUT_LONG_PRESS_RIGHT, NimoProtocol.INPUT_LONG_PRESS_LEFT ->
                    Bridge.sendTouchEvent(DeviceTypes.NIMO, "long_press", timestamp)
            NimoProtocol.INPUT_TOUCH_PRESS_RIGHT,
            NimoProtocol.INPUT_TOUCH_RELEASE_RIGHT,
            NimoProtocol.INPUT_TOUCH_PRESS_LEFT,
            NimoProtocol.INPUT_TOUCH_RELEASE_LEFT -> {
                // Raw press/release transitions are too chatty to forward; taps cover the UX.
            }
            else -> Bridge.log("NIMO: unknown input event code=$code")
        }
    }

    private fun handleResponse(cmd: Int, key: Int, statusCode: Int, data: ByteArray) {
        if (statusCode != 0) {
            // Protocol error codes: 1 fail, 2 timeout, 3 invalid format, 4 no memory,
            // 5 not supported, 6 bad parameter, 7 device busy.
            Bridge.log("NIMO: response cmd=$cmd key=$key error status=$statusCode")
        }
        resolvePendingAck(cmd, key, statusCode == 0)

        if (cmd != NimoProtocol.CMD_GET_PARAMETER || statusCode != 0) return
        when (key) {
            NimoProtocol.GET_BATTERY -> {
                if (data.size >= 4) {
                    applyBattery(
                            left = data[0].toInt() and 0xFF,
                            right = data[1].toInt() and 0xFF,
                            leftCharging = data[2].toInt() == 1,
                            rightCharging = data[3].toInt() == 1
                    )
                }
            }
            NimoProtocol.GET_VERSION -> {
                if (data.size >= 4) {
                    val v =
                            (data[0].toInt() and 0xFF) or
                                    ((data[1].toInt() and 0xFF) shl 8) or
                                    ((data[2].toInt() and 0xFF) shl 16) or
                                    ((data[3].toInt() and 0xFF) shl 24)
                    val major = (v ushr 28) and 0xF
                    val minor = (v ushr 21) and 0x7F
                    val micro = (v ushr 12) and 0x1FF
                    val build = v and 0xFFF
                    firmwareVersionPacked = "$major.$minor.$micro.$build"
                    emitVersionInfo()
                }
            }
            NimoProtocol.GET_VERSION_DETAIL -> {
                var end = data.size
                while (end > 0 && data[end - 1].toInt() == 0) end--
                firmwareVersionDetail = String(data, 0, end, Charsets.UTF_8).trim()
                emitVersionInfo()
            }
            NimoProtocol.GET_TWS_STATUS -> {
                if (data.isNotEmpty()) onTwsState((data[0].toInt() and 0xFF) >= 1)
            }
            else -> {}
        }
    }

    private fun applyBattery(left: Int, right: Int, leftCharging: Boolean, rightCharging: Boolean) {
        // Two independent arms → report the conservative (lower) level.
        val level = minOf(left, right)
        val charging = leftCharging || rightCharging
        if (level != lastBatteryLevel || charging != lastCharging) {
            lastBatteryLevel = level
            lastCharging = charging
            DeviceStore.apply("glasses", "batteryLevel", level)
            DeviceStore.apply("glasses", "charging", charging)
            Bridge.sendBatteryStatus(level, charging)
        }
    }

    private fun emitVersionInfo() {
        val version = firmwareVersionDetail.ifEmpty { firmwareVersionPacked }
        if (version.isEmpty()) return
        DeviceStore.apply("glasses", "firmwareVersion", version)
        Bridge.sendVersionInfo(mapOf("firmwareVersion" to version))
    }

    // ---------- Bitmap Helpers ----------

    /** Aspect-fit the bitmap into [width]x[height] on black, then convert to L8 grayscale. */
    private fun bitmapToGrayscale(source: Bitmap, width: Int, height: Int): ByteArray {
        val scaled = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(scaled)
        canvas.drawColor(Color.BLACK)
        val scale = minOf(width.toFloat() / source.width, height.toFloat() / source.height)
        val dw = (source.width * scale).toInt()
        val dh = (source.height * scale).toInt()
        val left = (width - dw) / 2
        val top = (height - dh) / 2
        canvas.drawBitmap(
                source,
                null,
                Rect(left, top, left + dw, top + dh),
                Paint(Paint.FILTER_BITMAP_FLAG)
        )

        val pixels = IntArray(width * height)
        scaled.getPixels(pixels, 0, width, 0, 0, width, height)
        val gray = ByteArray(width * height)
        for (i in pixels.indices) {
            val p = pixels[i]
            val luminance =
                    (0.299 * Color.red(p) + 0.587 * Color.green(p) + 0.114 * Color.blue(p)).toInt()
            // Invert luminance. MentraOS app bitmaps follow the platform convention of dark
            // content on a light background (see BitmapJavaUtils: gray<128 -> "black"). Nimo's
            // additive display lights up high 2bpp values (3 = white), so sending luma as-is
            // lights the whole lens for the background and leaves the content dark — the
            // inverted look. 255 - luma flips it so content renders lit on a dark lens.
            gray[i] = (255 - luminance.coerceIn(0, 255)).toByte()
        }
        scaled.recycle()
        return gray
    }

    /** L8 → 2bpp: thresholds 0x40/0x80/0xC0, 4 pixels per byte, MSB first. */
    private fun packL8To2bpp(l8: ByteArray): ByteArray {
        val outBytes = (l8.size + 3) shr 2
        val dst = ByteArray(outBytes)
        for (i in 0 until outBytes) {
            var packed = 0
            for (j in 0 until 4) {
                val idx = i * 4 + j
                var value = 0
                if (idx < l8.size) {
                    val px = l8[idx].toInt() and 0xFF
                    value =
                            when {
                                px < 0x40 -> 0
                                px < 0x80 -> 1
                                px < 0xC0 -> 2
                                else -> 3
                            }
                }
                packed = packed or ((value and 0x03) shl (6 - 2 * j))
            }
            dst[i] = packed.toByte()
        }
        return dst
    }

    /** zlib-compress; falls back to uncompressed when that isn't smaller. */
    private fun compressAdaptive(data: ByteArray): Pair<ByteArray, Int> {
        if (data.isEmpty()) return Pair(data, NimoProtocol.COMPRESSION_NONE)
        val deflater = Deflater()
        deflater.setInput(data)
        deflater.finish()
        val out = ByteArrayOutputStream(data.size)
        val buffer = ByteArray(4096)
        while (!deflater.finished()) {
            val n = deflater.deflate(buffer)
            out.write(buffer, 0, n)
        }
        deflater.end()
        val compressed = out.toByteArray()
        return if (compressed.size < data.size) {
            Pair(compressed, NimoProtocol.COMPRESSION_ZLIB)
        } else {
            Pair(data, NimoProtocol.COMPRESSION_NONE)
        }
    }
}
