package com.mentra.core.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64

import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import com.mentra.core.GlassesStore
import com.mentra.core.utils.DeviceTypes

import java.io.ByteArrayOutputStream
import java.util.TimeZone
import java.util.UUID
import java.util.regex.Pattern

// ---------- G2 Protocol Constants ----------

private object G2BLE {
    // EvenHub BLE characteristic UUIDs (NOT the G1 UART UUIDs!)
    val CHAR_WRITE: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E5401")
    val CHAR_NOTIFY: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E5402")
    val AUDIO_NOTIFY: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E6402")
    val SERVICE_UUID: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E0000")
    val CLIENT_CHARACTERISTIC_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    const val HEADER_BYTE: Byte = 0xAA.toByte()
    const val SOURCE_PHONE: Byte = 1
    const val DEST_GLASSES: Byte = 2
    const val MAX_PACKET_PAYLOAD: Int = 236
}

// Service IDs from service_id_def.proto
private enum class ServiceID(val value: Byte) {
    G2_SETTING(0x09),
    ONBOARDING(0x10),
    DEVICE_SETTINGS(0x80.toByte()),
    EVEN_HUB(0xE0.toByte());

    companion object {
        fun fromByte(b: Byte): ServiceID? = entries.find { it.value == b }
    }
}

// EvenHub command IDs from EvenHub.proto
private enum class EvenHubCmd(val value: Int) {
    CREATE_STARTUP_PAGE(0),
    UPDATE_IMAGE_RAW_DATA(3),
    UPDATE_TEXT_DATA(5),
    REBUILD_PAGE(7),
    SHUTDOWN_PAGE(9),
    HEARTBEAT(12),
    AUDIO_CONTROL(15)
}

// EvenHub response command IDs (glasses → phone)
private enum class EvenHubResponseCmd(val value: Int) {
    OS_NOTIFY_EVENT_TO_APP(2)
}

// OsEventTypeList from EvenHub.proto
private enum class OsEventType(val value: Int) {
    CLICK(0),
    SCROLL_TOP(1),
    SCROLL_BOTTOM(2),
    DOUBLE_CLICK(3),
    FOREGROUND_ENTER(4),
    FOREGROUND_EXIT(5),
    ABNORMAL_EXIT(6),
    SYSTEM_EXIT(7);

    companion object {
        fun fromInt(v: Int): OsEventType? = entries.find { it.value == v }
    }
}

// g2_settingCommandId from g2_setting.proto
private enum class G2SettingCommandId(val value: Int) {
    NONE(0),
    DEVICE_RECEIVE_INFO(1),
    DEVICE_RECEIVE_REQUEST(2),
    DEVICE_SEND_TO_APP(3),
    DEVICE_RESPOND_TO_APP(4)
}

// DevCfgCommandId from dev_config_protocol.proto
private enum class DevCfgCommandId(val value: Int) {
    AUTHENTICATION(4),
    PIPE_ROLE_CHANGE(5),
    TIME_SYNC(128),
    BASE_CONN_HEART_BEAT(14)
}

// ---------- CRC16 ----------

private fun calcCRC16(data: ByteArray): Int {
    var crc = 0xFFFF
    for (byte in data) {
        val b = byte.toInt() and 0xFF
        crc = ((crc shr 8) or ((crc shl 8) and 0xFF00)) xor b
        crc = crc xor ((crc and 0xFF) shr 4)
        crc = crc xor ((crc shl 12) and 0xFFFF)
        crc = crc xor (((crc and 0xFF) shl 5) and 0xFFFF)
    }
    return crc and 0xFFFF
}

// ---------- Minimal Protobuf Encoding ----------

private class ProtobufWriter {
    private val stream = ByteArrayOutputStream()

    fun writeVarint(value: Long) {
        var v = value
        // Use unsigned comparison so negative values (sign-extended) produce 10-byte varints
        while (v.toULong() > 0x7FuL) {
            stream.write(((v and 0x7F) or 0x80).toInt())
            v = v ushr 7
        }
        stream.write((v and 0x7F).toInt())
    }

    fun writeInt32Field(fieldNumber: Int, value: Int) {
        val tag = (fieldNumber shl 3).toLong() // wire type 0 = varint
        writeVarint(tag)
        // Kotlin Int.toLong() sign-extends, which is correct for protobuf int32
        // Negative values produce 10-byte varints via unsigned comparison in writeVarint
        writeVarint(value.toLong())
    }

    fun writeStringField(fieldNumber: Int, value: String) {
        val tag = ((fieldNumber shl 3) or 2).toLong() // wire type 2 = length-delimited
        writeVarint(tag)
        val utf8 = value.toByteArray(Charsets.UTF_8)
        writeVarint(utf8.size.toLong())
        stream.write(utf8)
    }

    fun writeBytesField(fieldNumber: Int, value: ByteArray) {
        val tag = ((fieldNumber shl 3) or 2).toLong()
        writeVarint(tag)
        writeVarint(value.size.toLong())
        stream.write(value)
    }

    fun writeMessageField(fieldNumber: Int, subMessage: ByteArray) {
        val tag = ((fieldNumber shl 3) or 2).toLong()
        writeVarint(tag)
        writeVarint(subMessage.size.toLong())
        stream.write(subMessage)
    }

    fun writeBoolField(fieldNumber: Int, value: Boolean) {
        writeInt32Field(fieldNumber, if (value) 1 else 0)
    }

    fun toByteArray(): ByteArray = stream.toByteArray()
}

// ---------- Minimal Protobuf Decoding ----------

private class ProtobufReader(private val data: ByteArray) {
    private var offset: Int = 0

    val hasMore: Boolean get() = offset < data.size

    fun readVarint(): Long? {
        var result: Long = 0
        var shift = 0
        while (offset < data.size) {
            val byte = data[offset].toInt() and 0xFF
            offset++
            result = result or ((byte.toLong() and 0x7F) shl shift)
            if (byte and 0x80 == 0) return result
            shift += 7
            if (shift > 63) return null
        }
        return null
    }

    fun readTag(): Pair<Int, Int>? {
        val tag = readVarint() ?: return null
        return Pair((tag shr 3).toInt(), (tag and 0x07).toInt())
    }

    fun readInt32(): Int? {
        val v = readVarint() ?: return null
        return v.toInt()
    }

    fun readBytes(): ByteArray? {
        val len = readVarint()?.toInt() ?: return null
        if (offset + len > data.size) return null
        val result = data.copyOfRange(offset, offset + len)
        offset += len
        return result
    }

    fun readString(): String? {
        val bytes = readBytes() ?: return null
        return String(bytes, Charsets.UTF_8)
    }

    fun skipField(wireType: Int) {
        when (wireType) {
            0 -> readVarint() // varint
            1 -> offset += 8 // 64-bit
            2 -> readBytes() // length-delimited
            5 -> offset += 4 // 32-bit
        }
    }

    fun parseFields(): Map<Int, Any> {
        val fields = mutableMapOf<Int, Any>()
        while (hasMore) {
            val (fieldNum, wireType) = readTag() ?: break
            when (wireType) {
                0 -> {
                    val v = readVarint()
                    if (v != null) fields[fieldNum] = v.toInt()
                }
                2 -> {
                    val d = readBytes()
                    if (d != null) fields[fieldNum] = d
                }
                else -> skipField(wireType)
            }
        }
        return fields
    }
}

// ---------- EvenHub Protobuf Message Builders ----------

private object EvenHubProto {
    fun textContainerProperty(
        x: Int, y: Int, width: Int, height: Int,
        borderWidth: Int = 0, borderColor: Int = 0, borderRadius: Int = 0,
        paddingLength: Int = 0, containerID: Int,
        containerName: String? = null, isEventCapture: Boolean = false,
        content: String? = null
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, x)
        w.writeInt32Field(2, y)
        w.writeInt32Field(3, width)
        w.writeInt32Field(4, height)
        w.writeInt32Field(5, borderWidth)
        w.writeInt32Field(6, borderColor)
        w.writeInt32Field(7, borderRadius)
        w.writeInt32Field(8, paddingLength)
        w.writeInt32Field(9, containerID)
        containerName?.let { w.writeStringField(10, it) }
        w.writeInt32Field(11, if (isEventCapture) 1 else 0)
        content?.let { w.writeStringField(12, it) }
        return w.toByteArray()
    }

    fun imageContainerProperty(
        x: Int, y: Int, width: Int, height: Int,
        containerID: Int, containerName: String? = null
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, x)
        w.writeInt32Field(2, y)
        w.writeInt32Field(3, width)
        w.writeInt32Field(4, height)
        w.writeInt32Field(5, containerID)
        containerName?.let { w.writeStringField(6, it) }
        return w.toByteArray()
    }

    fun imageRawDataUpdate(
        containerID: Int, containerName: String? = null,
        mapSessionId: Int, mapTotalSize: Int, compressMode: Int = 0,
        mapFragmentIndex: Int, mapFragmentPacketSize: Int, mapRawData: ByteArray
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, containerID)
        containerName?.let { w.writeStringField(2, it) }
        w.writeInt32Field(3, mapSessionId)
        w.writeInt32Field(4, mapTotalSize)
        w.writeInt32Field(5, compressMode)
        w.writeInt32Field(6, mapFragmentIndex)
        w.writeInt32Field(7, mapFragmentPacketSize)
        w.writeBytesField(8, mapRawData)
        return w.toByteArray()
    }

    fun createStartupPageContainer(
        containerTotalNum: Int,
        textContainers: List<ByteArray> = emptyList(),
        imageContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, containerTotalNum)
        for (tc in textContainers) w.writeMessageField(3, tc)
        for (ic in imageContainers) w.writeMessageField(4, ic)
        return w.toByteArray()
    }

    fun textContainerUpgrade(
        containerID: Int, contentOffset: Int = 0,
        contentLength: Int, content: String
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, containerID)
        w.writeInt32Field(3, contentOffset)
        w.writeInt32Field(4, contentLength)
        w.writeStringField(5, content)
        return w.toByteArray()
    }

    fun shutdownContainer(exitMode: Int = 0): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, exitMode)
        return w.toByteArray()
    }

    fun heartbeatPacket(cnt: Int = 0): ByteArray {
        val w = ProtobufWriter()
        if (cnt != 0) w.writeInt32Field(1, cnt)
        return w.toByteArray()
    }

    fun audioCtrCmd(enable: Boolean): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, if (enable) 1 else 0)
        return w.toByteArray()
    }

    fun evenHubMessage(cmd: EvenHubCmd, subFieldNumber: Int, subMessage: ByteArray): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, cmd.value)
        w.writeMessageField(subFieldNumber, subMessage)
        return w.toByteArray()
    }

    fun createPageMessage(
        textContainers: List<ByteArray> = emptyList(),
        imageContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val total = textContainers.size + imageContainers.size
        val createMsg = createStartupPageContainer(total, textContainers, imageContainers)
        return evenHubMessage(EvenHubCmd.CREATE_STARTUP_PAGE, 3, createMsg)
    }

    fun rebuildPageMessage(
        textContainers: List<ByteArray> = emptyList(),
        imageContainers: List<ByteArray> = emptyList()
    ): ByteArray {
        val total = textContainers.size + imageContainers.size
        val rebuildMsg = createStartupPageContainer(total, textContainers, imageContainers)
        return evenHubMessage(EvenHubCmd.REBUILD_PAGE, 7, rebuildMsg)
    }

    fun updateImageRawDataMessage(
        containerID: Int, containerName: String? = null,
        mapSessionId: Int, mapTotalSize: Int, compressMode: Int = 0,
        mapFragmentIndex: Int, mapFragmentPacketSize: Int, mapRawData: ByteArray
    ): ByteArray {
        val updateMsg = imageRawDataUpdate(
            containerID, containerName, mapSessionId, mapTotalSize,
            compressMode, mapFragmentIndex, mapFragmentPacketSize, mapRawData
        )
        return evenHubMessage(EvenHubCmd.UPDATE_IMAGE_RAW_DATA, 5, updateMsg)
    }

    fun updateTextMessage(
        containerID: Int, contentOffset: Int = 0, contentLength: Int, content: String
    ): ByteArray {
        val upgradeMsg = textContainerUpgrade(containerID, contentOffset, contentLength, content)
        return evenHubMessage(EvenHubCmd.UPDATE_TEXT_DATA, 9, upgradeMsg)
    }

    fun shutdownMessage(exitMode: Int = 0): ByteArray {
        val msg = shutdownContainer(exitMode)
        return evenHubMessage(EvenHubCmd.SHUTDOWN_PAGE, 11, msg)
    }

    fun heartbeatMessage(): ByteArray {
        val msg = heartbeatPacket()
        return evenHubMessage(EvenHubCmd.HEARTBEAT, 14, msg)
    }

    fun audioControlMessage(enable: Boolean): ByteArray {
        val msg = audioCtrCmd(enable)
        return evenHubMessage(EvenHubCmd.AUDIO_CONTROL, 18, msg)
    }
}

// ---------- DevSettings Auth Protobuf Builders ----------

private object DevSettingsProto {
    fun authCmd(magicRandom: Int): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.AUTHENTICATION.value)
        w.writeInt32Field(2, magicRandom)

        // AuthMgr sub-message
        val authW = ProtobufWriter()
        authW.writeBoolField(1, true) // secAuth
        authW.writeInt32Field(2, 4)   // phoneType = PHONE_ANDROID (4)

        w.writeMessageField(3, authW.toByteArray())
        return w.toByteArray()
    }

    fun pipeRoleChange(magicRandom: Int): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.PIPE_ROLE_CHANGE.value)
        w.writeInt32Field(2, magicRandom)

        // PipeRoleChange: field 1 = asCmdRole (GlassesLR.RIGHT=1)
        val roleW = ProtobufWriter()
        roleW.writeInt32Field(1, 1) // RIGHT
        w.writeMessageField(4, roleW.toByteArray())
        return w.toByteArray()
    }

    fun timeSync(magicRandom: Int): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.TIME_SYNC.value)
        w.writeInt32Field(2, magicRandom)

        val tsW = ProtobufWriter()
        val timestamp = (System.currentTimeMillis() / 1000).toInt()
        tsW.writeInt32Field(1, timestamp)
        val tz = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 3600000
        tsW.writeInt32Field(2, tz)
        w.writeMessageField(128, tsW.toByteArray())
        return w.toByteArray()
    }

    fun baseHeartbeat(magicRandom: Int): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.BASE_CONN_HEART_BEAT.value)
        w.writeInt32Field(2, magicRandom)

        // BaseConnHeartBeat: empty message
        val hbW = ProtobufWriter()
        w.writeMessageField(13, hbW.toByteArray())
        return w.toByteArray()
    }
}

// ---------- G2 Settings Protobuf Builders ----------

private object G2SettingProto {
    fun setBrightness(magicRandom: Int, level: Int, autoAdjust: Boolean): ByteArray {
        val brightnessW = ProtobufWriter()
        brightnessW.writeInt32Field(1, if (autoAdjust) 1 else 0)
        brightnessW.writeInt32Field(2, level)

        val infoW = ProtobufWriter()
        infoW.writeMessageField(1, brightnessW.toByteArray())

        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_INFO.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.toByteArray())
        return w.toByteArray()
    }

    fun requestInfo(magicRandom: Int): ByteArray {
        val reqW = ProtobufWriter()
        reqW.writeInt32Field(1, 1) // settingInfoType = APP_REQUIRE_BASIC_SETTING

        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_REQUEST.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(4, reqW.toByteArray())
        return w.toByteArray()
    }
}

// ---------- Onboarding Protobuf Builders ----------

private object OnboardingProto {
    fun skipOnboarding(magicRandom: Int): ByteArray {
        val configW = ProtobufWriter()
        configW.writeInt32Field(1, 4) // processId = FINISH

        val w = ProtobufWriter()
        w.writeInt32Field(1, 1) // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, configW.toByteArray())
        return w.toByteArray()
    }
}

// ---------- EvenBLE Transport Layer ----------

private object EvenBLETransport {
    fun buildPackets(
        syncId: Byte, serviceId: Byte, payload: ByteArray, reserveFlag: Boolean = false
    ): List<ByteArray> {
        val maxPayload = G2BLE.MAX_PACKET_PAYLOAD

        // Split payload into chunks
        val chunks = mutableListOf<ByteArray>()
        var offset = 0
        while (offset < payload.size) {
            val end = minOf(offset + maxPayload, payload.size)
            chunks.add(payload.copyOfRange(offset, end))
            offset = end
        }
        if (chunks.isEmpty()) {
            chunks.add(ByteArray(0))
        }

        // If last chunk is exactly max size, need extra packet for CRC
        if (chunks.last().size == maxPayload) {
            chunks.add(ByteArray(0))
        }

        val totalPackets = chunks.size.toByte()
        val crc = calcCRC16(payload)

        val packets = mutableListOf<ByteArray>()
        for ((i, chunk) in chunks.withIndex()) {
            val serialNum = (i + 1).toByte()
            val isLast = serialNum == totalPackets

            // status byte: bit5=reserveFlag
            val status: Byte = if (reserveFlag) 0x20 else 0x00

            // payload length includes CRC if last packet
            val payloadLen = (chunk.size + if (isLast) 2 else 0).toByte()

            val packet = ByteArrayOutputStream()
            packet.write(G2BLE.HEADER_BYTE.toInt() and 0xFF)
            packet.write(((G2BLE.DEST_GLASSES.toInt() shl 4) or G2BLE.SOURCE_PHONE.toInt()) and 0xFF)
            packet.write(syncId.toInt() and 0xFF)
            packet.write(payloadLen.toInt() and 0xFF)
            packet.write(totalPackets.toInt() and 0xFF)
            packet.write(serialNum.toInt() and 0xFF)
            packet.write(serviceId.toInt() and 0xFF)
            packet.write(status.toInt() and 0xFF)

            packet.write(chunk)

            if (isLast) {
                packet.write(crc and 0xFF)
                packet.write((crc shr 8) and 0xFF)
            }

            packets.add(packet.toByteArray())
        }

        return packets
    }
}

// ---------- G2 Send Manager ----------

private class G2SendManager {
    private var syncId: Byte = 0
    private var magicRandom: Byte = 0

    fun nextSyncId(): Byte {
        val id = syncId
        syncId = (syncId + 1).toByte()
        return id
    }

    fun nextMagicRandom(): Int {
        val v = magicRandom
        magicRandom = (magicRandom + 1).toByte()
        return v.toInt() and 0xFF
    }

    fun buildPackets(serviceId: Byte, payload: ByteArray, reserveFlag: Boolean = false): List<ByteArray> {
        val sid = nextSyncId()
        return EvenBLETransport.buildPackets(sid, serviceId, payload, reserveFlag)
    }
}

// ---------- G2 Receive Manager ----------

private class G2ReceiveManager {
    private val partials = mutableMapOf<String, Pair<ByteArrayOutputStream, Byte>>()

    fun handlePacket(rawData: ByteArray): Pair<Byte, ByteArray>? {
        if (rawData.size < 8) return null
        if (rawData[0] != G2BLE.HEADER_BYTE) return null

        val payloadLen = rawData[3].toInt() and 0xFF
        val expectedLen = payloadLen + 8
        if (rawData.size < expectedLen) return null

        val totalPackets = rawData[4]
        val serialNum = rawData[5]
        val serviceId = rawData[6]
        val status = rawData[7].toInt() and 0xFF
        val resultCode = (status shr 1) and 0x0F

        if (resultCode != 0) return null

        val isLast = serialNum == totalPackets
        val hasCrc = isLast
        val payloadEnd = 8 + payloadLen - if (hasCrc) 2 else 0
        val payload = rawData.copyOfRange(8, payloadEnd)

        val syncId = rawData[2]
        val key = "${serviceId.toInt() and 0xFF}-${syncId.toInt() and 0xFF}"

        if ((serialNum.toInt() and 0xFF) > 1) {
            val existing = partials[key] ?: return null
            existing.first.write(payload)
            partials[key] = Pair(existing.first, serialNum)
        } else if ((totalPackets.toInt() and 0xFF) > 1) {
            val baos = ByteArrayOutputStream()
            baos.write(payload)
            partials[key] = Pair(baos, serialNum)
        }

        if (!isLast) return null

        val fullPayload: ByteArray
        val existing = partials[key]
        if (existing != null) {
            fullPayload = existing.first.toByteArray()
            partials.remove(key)
        } else {
            fullPayload = payload
        }

        return Pair(serviceId, fullPayload)
    }
}

// ---------- G2 Reconnection Manager ----------

private class G2ReconnectionManager(
    private val intervalMs: Long = 30_000L,
    private val maxAttempts: Int = -1 // -1 for unlimited
) {
    private val handler = Handler(Looper.getMainLooper())
    private var runnable: Runnable? = null
    private var attempts = 0
    val isRunning: Boolean get() = runnable != null

    fun start(onAttempt: () -> Boolean) {
        stop()
        attempts = 0

        val r = object : Runnable {
            override fun run() {
                if (maxAttempts > 0 && attempts >= maxAttempts) {
                    Bridge.log("G2: Max reconnection attempts ($maxAttempts) reached")
                    stop()
                    return
                }

                attempts++
                Bridge.log("G2: Reconnection attempt $attempts")

                val shouldStop = onAttempt()
                if (shouldStop) {
                    Bridge.log("G2: Reconnection successful, stopping")
                    stop()
                    return
                }

                handler.postDelayed(this, intervalMs)
            }
        }
        runnable = r
        handler.postDelayed(r, intervalMs)
    }

    fun stop() {
        runnable?.let { handler.removeCallbacks(it) }
        runnable = null
        attempts = 0
    }
}

// ---------- G2 Class ----------

class G2 : SGCManager() {

    companion object {
        private const val PREFS_NAME = "G2Prefs"
        private const val KEY_LEFT_ADDRESS = "g2_leftGlassAddress"
        private const val KEY_RIGHT_ADDRESS = "g2_rightGlassAddress"
    }

    init {
        type = DeviceTypes.G2
        hasMic = true
    }

    // Connection state
    private var _ready: Boolean = false
    private var ready: Boolean
        get() = _ready
        set(value) {
            _ready = value
            if (!value) {
                _batteryLevel = -1
            }
        }

    // BLE
    private val context: Context get() = Bridge.getContext()
    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var leftGatt: BluetoothGatt? = null
    private var rightGatt: BluetoothGatt? = null
    private var leftWriteChar: BluetoothGattCharacteristic? = null
    private var rightWriteChar: BluetoothGattCharacteristic? = null
    private var leftNotifyChar: BluetoothGattCharacteristic? = null
    private var rightNotifyChar: BluetoothGattCharacteristic? = null
    private var leftAudioChar: BluetoothGattCharacteristic? = null
    private var rightAudioChar: BluetoothGattCharacteristic? = null
    private var leftInitialized: Boolean = false
    private var rightInitialized: Boolean = false
    private var isDisconnecting = false

    // Device search
    private var DEVICE_SEARCH_ID = "NOT_SET"

    // Saved addresses for reconnection
    private var leftGlassAddress: String?
        get() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_LEFT_ADDRESS, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .apply { if (value != null) putString(KEY_LEFT_ADDRESS, value) else remove(KEY_LEFT_ADDRESS) }
                .apply()
        }

    private var rightGlassAddress: String?
        get() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_RIGHT_ADDRESS, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .apply { if (value != null) putString(KEY_RIGHT_ADDRESS, value) else remove(KEY_RIGHT_ADDRESS) }
                .apply()
        }

    // Reconnection
    private val reconnectionManager = G2ReconnectionManager()

    // Protocol state
    private val sendManager = G2SendManager()
    private val receiveManager = G2ReceiveManager()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private var devSettingsHeartbeatRunnable: Runnable? = null
    private var micEnabled_: Boolean = false
    private var startupPageCreated: Boolean = false
    private var pageCreated: Boolean = false
    private var pageHasTextContainer: Boolean = false
    private var currentTextContent: String = ""
    private var textContainerID: Int = 1
    private var imageSessionCounter: Int = 0
    private var heartbeatCounter: Int = 0
    private var authStarted: Boolean = false

    // Battery state
    private var _batteryLevel: Int = -1
    private var batteryLevel_: Int
        get() = _batteryLevel
        set(value) {
            val old = _batteryLevel
            _batteryLevel = value
            if (value != old && value >= 0) {
                GlassesStore.apply("glasses", "batteryLevel", value)
                Bridge.sendBatteryStatus(value, isCharging)
            }
        }
    private var isCharging: Boolean = false

    // Scanning
    private var scanCallback: ScanCallback? = null

    // GATT operation queue for descriptor writes
    private val gattOpQueue = mutableListOf<() -> Unit>()
    private var gattOpInProgress = false

    // ---------- BLE Sending ----------

    @Suppress("deprecation")
    private fun sendToGlasses(packets: List<ByteArray>, left: Boolean = false, right: Boolean = true) {
        for (packet in packets) {
            if (right) {
                rightWriteChar?.let { char ->
                    rightGatt?.let { gatt ->
                        char.value = packet
                        char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        gatt.writeCharacteristic(char)
                    }
                }
            }
            if (left) {
                leftWriteChar?.let { char ->
                    leftGatt?.let { gatt ->
                        char.value = packet
                        char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        gatt.writeCharacteristic(char)
                    }
                }
            }
        }
    }

    private fun sendEvenHubCommand(payload: ByteArray) {
        val packets = sendManager.buildPackets(
            serviceId = ServiceID.EVEN_HUB.value,
            payload = payload,
            reserveFlag = true
        )
        sendToGlasses(packets)
    }

    private fun sendDevSettingsCommand(payload: ByteArray, left: Boolean = false, right: Boolean = true) {
        val packets = sendManager.buildPackets(
            serviceId = ServiceID.DEVICE_SETTINGS.value,
            payload = payload
        )
        sendToGlasses(packets, left = left, right = right)
    }

    private fun sendG2SettingCommand(payload: ByteArray) {
        val packets = sendManager.buildPackets(
            serviceId = ServiceID.G2_SETTING.value,
            payload = payload,
            reserveFlag = true
        )
        sendToGlasses(packets)
    }

    private fun sendOnboardingCommand(payload: ByteArray) {
        val packets = sendManager.buildPackets(
            serviceId = ServiceID.ONBOARDING.value,
            payload = payload,
            reserveFlag = true
        )
        sendToGlasses(packets)
    }

    // ---------- Authentication Sequence ----------

    private fun runAuthSequence() {
        Bridge.log("G2: Running auth sequence")

        // Auth to left side
        if (leftGatt != null && leftWriteChar != null) {
            val authL = DevSettingsProto.authCmd(sendManager.nextMagicRandom())
            sendDevSettingsCommand(authL, left = true, right = false)
        }

        // Small delay then auth right + pipe role change + time sync
        mainHandler.postDelayed({
            val authR = DevSettingsProto.authCmd(sendManager.nextMagicRandom())
            sendDevSettingsCommand(authR, left = false, right = true)

            mainHandler.postDelayed({
                val roleChange = DevSettingsProto.pipeRoleChange(sendManager.nextMagicRandom())
                sendDevSettingsCommand(roleChange, left = false, right = true)

                mainHandler.postDelayed({
                    val timeSync = DevSettingsProto.timeSync(sendManager.nextMagicRandom())
                    sendDevSettingsCommand(timeSync)

                    // Skip onboarding on connect
                    mainHandler.postDelayed({
                        val onboarding = OnboardingProto.skipOnboarding(sendManager.nextMagicRandom())
                        sendOnboardingCommand(onboarding)
                        Bridge.log("G2: Sent onboarding skip (FINISH)")
                    }, 200)

                    // Start heartbeats after auth
                    startHeartbeats()

                    // Mark as ready and request device info
                    mainHandler.postDelayed({
                        ready = true
                        reconnectionManager.stop()
                        Bridge.log("G2: Auth sequence complete, glasses ready")

                        // Set device_name so CoreManager can save it for reconnection
                        val peripheralName = rightGatt?.device?.name ?: leftGatt?.device?.name
                        if (peripheralName != null) {
                            val idNumber = extractIdNumber(peripheralName)
                            if (idNumber != null) {
                                val deviceId = "$idNumber"
                                GlassesStore.apply("core", "device_name", deviceId)
                                Bridge.log("G2: Set device_name to $deviceId")
                            }
                        }

                        GlassesStore.apply("glasses", "connected", true)
                        GlassesStore.apply("glasses", "fullyBooted", true)

                        // Query version + battery info from glasses
                        requestDeviceInfo()
                    }, 500)
                }, 200)
            }, 200)
        }, 200)
    }

    // ---------- Heartbeats ----------

    private fun startHeartbeats() {
        // EvenHub heartbeat every 5 seconds
        stopHeartbeats()

        val hbRunnable = object : Runnable {
            override fun run() {
                sendEvenHubHeartbeat()
                mainHandler.postDelayed(this, 5000)
            }
        }
        heartbeatRunnable = hbRunnable
        mainHandler.postDelayed(hbRunnable, 5000)

        // DevSettings heartbeat every 5 seconds
        val dsRunnable = object : Runnable {
            override fun run() {
                sendDevSettingsHeartbeat()
                mainHandler.postDelayed(this, 5000)
            }
        }
        devSettingsHeartbeatRunnable = dsRunnable
        mainHandler.postDelayed(dsRunnable, 5000)
    }

    private fun stopHeartbeats() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
        devSettingsHeartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        devSettingsHeartbeatRunnable = null
    }

    private fun sendEvenHubHeartbeat() {
        if (!ready) return
        val msg = EvenHubProto.heartbeatMessage()
        sendEvenHubCommand(msg)

        // Poll battery every 10 heartbeats (~50 seconds)
        heartbeatCounter++
        if (heartbeatCounter % 10 == 0) {
            requestDeviceInfo()
        }
    }

    private fun sendDevSettingsHeartbeat() {
        if (!ready) return
        val msg = DevSettingsProto.baseHeartbeat(sendManager.nextMagicRandom())
        sendDevSettingsCommand(msg)
    }

    private fun requestDeviceInfo() {
        val msg = G2SettingProto.requestInfo(sendManager.nextMagicRandom())
        sendG2SettingCommand(msg)
        Bridge.log("G2: Requested device info (battery/version)")
    }

    // ---------- SGCManager: Display Control ----------

    override fun sendTextWall(text: String) {
        Bridge.log("G2: sendTextWall(${text.take(50)}...)")

        if (text.isEmpty()) {
            clearDisplay()
            return
        }

        if (!pageCreated || !pageHasTextContainer) {
            createPageWithText(text)
        } else {
            updateText(text)
        }
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        val combined = "$top\n$bottom"
        sendTextWall(combined)
    }

    override fun clearDisplay() {
        Bridge.log("G2: clearDisplay()")
        if (pageCreated) {
            sendTextWall(" ")
        }
    }

    override fun displayBitmap(base64ImageData: String): Boolean {
        val rawData = Base64.decode(base64ImageData, Base64.DEFAULT) ?: run {
            Bridge.log("G2: displayBitmap() - failed to decode base64")
            return false
        }

        Bridge.log("G2: displayBitmap() - decoded ${rawData.size} bytes from base64")
        Bridge.log("G2: displayBitmap() - state: startupPageCreated=$startupPageCreated, pageCreated=$pageCreated")

        val bmpData = convertToG2Bmp(rawData, 200, 100) ?: run {
            Bridge.log("G2: displayBitmap() - failed to convert image to BMP")
            return false
        }

        val containerW = 200
        val containerH = 100
        val containerX = (576 - containerW) / 2
        val containerY = (288 - containerH) / 2
        val containerID = 10
        val containerName = "img-single"

        val imageContainer = EvenHubProto.imageContainerProperty(
            x = containerX, y = containerY,
            width = containerW, height = containerH,
            containerID = containerID, containerName = containerName
        )

        val msg: ByteArray
        if (!startupPageCreated) {
            Bridge.log("G2: displayBitmap() - creating startup page with image container")
            msg = EvenHubProto.createPageMessage(imageContainers = listOf(imageContainer))
            startupPageCreated = true
        } else {
            Bridge.log("G2: displayBitmap() - rebuilding page with image container")
            msg = EvenHubProto.rebuildPageMessage(imageContainers = listOf(imageContainer))
        }
        sendEvenHubCommand(msg)
        pageCreated = true
        pageHasTextContainer = false
        currentTextContent = ""

        // Send fragments after a delay (fire and forget since Android displayBitmap is synchronous)
        Bridge.log("G2: displayBitmap() - page sent, scheduling fragment send in 1s...")
        mainHandler.postDelayed({
            sendImageData(containerID, containerName, bmpData)
        }, 1000)

        return true
    }

    private fun sendImageData(containerID: Int, containerName: String, bmpData: ByteArray) {
        val fragmentSize = 4096
        imageSessionCounter++
        val sessionId = imageSessionCounter
        val totalSize = bmpData.size
        var fragmentIndex = 0
        var offset = 0

        fun sendNextFragment() {
            if (offset >= bmpData.size) {
                Bridge.log("G2: sendImageData($containerName) - $fragmentIndex fragments, ${bmpData.size} bytes")
                return
            }

            val end = minOf(offset + fragmentSize, bmpData.size)
            val fragment = bmpData.copyOfRange(offset, end)

            val msg = EvenHubProto.updateImageRawDataMessage(
                containerID = containerID,
                containerName = containerName,
                mapSessionId = sessionId,
                mapTotalSize = totalSize,
                compressMode = 0,
                mapFragmentIndex = fragmentIndex,
                mapFragmentPacketSize = fragment.size,
                mapRawData = fragment
            )
            sendEvenHubCommand(msg)

            fragmentIndex++
            offset = end

            // 200ms between fragments
            if (offset < bmpData.size) {
                mainHandler.postDelayed({ sendNextFragment() }, 200)
            } else {
                Bridge.log("G2: sendImageData($containerName) - $fragmentIndex fragments, ${bmpData.size} bytes")
            }
        }

        sendNextFragment()
    }

    override fun showDashboard() {
        // G2 doesn't have a native dashboard concept via EvenHub
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        // No-op for G2
    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("G2: setBrightness($level, auto=$autoMode)")
        val msg = G2SettingProto.setBrightness(
            magicRandom = sendManager.nextMagicRandom(),
            level = level,
            autoAdjust = autoMode
        )
        sendG2SettingCommand(msg)
    }

    // ---------- Private Display Helpers ----------

    private fun createPageWithText(text: String) {
        val tc = EvenHubProto.textContainerProperty(
            x = 0, y = 0, width = 576, height = 288,
            borderWidth = 0, borderColor = 0, borderRadius = 0,
            paddingLength = 4, containerID = textContainerID,
            containerName = "text-main", isEventCapture = true,
            content = text
        )

        val msg: ByteArray
        if (!startupPageCreated) {
            Bridge.log("G2: createPageWithText - using createPageMessage (first time)")
            msg = EvenHubProto.createPageMessage(textContainers = listOf(tc))
            startupPageCreated = true
        } else {
            Bridge.log("G2: createPageWithText - using rebuildPageMessage")
            msg = EvenHubProto.rebuildPageMessage(textContainers = listOf(tc))
        }
        sendEvenHubCommand(msg)
        pageCreated = true
        pageHasTextContainer = true
        currentTextContent = text
    }

    private fun updateText(text: String) {
        val msg = EvenHubProto.updateTextMessage(
            containerID = textContainerID,
            contentOffset = 0,
            contentLength = text.toByteArray(Charsets.UTF_8).size,
            content = text
        )
        sendEvenHubCommand(msg)
        currentTextContent = text
    }

    // ---------- Bitmap Conversion ----------

    private fun convertToG2Bmp(data: ByteArray, containerWidth: Int, containerHeight: Int): ByteArray? {
        val srcBitmap = BitmapFactory.decodeByteArray(data, 0, data.size) ?: run {
            Bridge.log("G2: convertToG2Bmp - could not decode image")
            return null
        }

        val srcWidth = srcBitmap.width
        val srcHeight = srcBitmap.height

        // Scale to fit within container (maintain aspect ratio)
        val scale = minOf(
            containerWidth.toDouble() / srcWidth,
            containerHeight.toDouble() / srcHeight
        )
        val scaledW = maxOf(1, (srcWidth * scale).toInt())
        val scaledH = maxOf(1, (srcHeight * scale).toInt())
        val offsetX = (containerWidth - scaledW) / 2
        val offsetY = (containerHeight - scaledH) / 2

        Bridge.log("G2: convertToG2Bmp - input ${srcWidth}x${srcHeight} → scaled ${scaledW}x${scaledH} in ${containerWidth}x${containerHeight}")

        // Render to container-sized bitmap with black background
        val destBitmap = Bitmap.createBitmap(containerWidth, containerHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(destBitmap)
        canvas.drawColor(Color.BLACK)

        val srcRect = Rect(0, 0, srcWidth, srcHeight)
        val dstRect = Rect(offsetX, offsetY, offsetX + scaledW, offsetY + scaledH)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(srcBitmap, srcRect, dstRect, paint)

        // Extract grayscale pixels
        val grayscalePixels = ByteArray(containerWidth * containerHeight)
        for (y in 0 until containerHeight) {
            for (x in 0 until containerWidth) {
                val pixel = destBitmap.getPixel(x, y)
                val r = Color.red(pixel)
                val g = Color.green(pixel)
                val b = Color.blue(pixel)
                val gray = (r * 299 + g * 587 + b * 114) / 1000
                grayscalePixels[y * containerWidth + x] = gray.toByte()
            }
        }

        srcBitmap.recycle()
        destBitmap.recycle()

        return build4BitBmp(grayscalePixels, containerWidth, containerHeight)
    }

    private fun build4BitBmp(grayscalePixels: ByteArray, width: Int, height: Int): ByteArray? {
        // 4-bit: 2 pixels per byte, rows padded to 4-byte boundary
        val bytesPerRow4bit = (width + 1) / 2
        val paddedRowSize = (bytesPerRow4bit + 3) and 3.inv()
        val pixelDataSize = paddedRowSize * height

        // BMP file header (14) + DIB header (40) + color table (16 * 4 = 64)
        val headerSize = 14 + 40 + 64
        val fileSize = headerSize + pixelDataSize

        val bmp = ByteArrayOutputStream(fileSize)

        // --- BMP File Header (14 bytes) ---
        bmp.write(0x42); bmp.write(0x4D) // "BM"
        writeLittleEndianInt(bmp, fileSize)
        writeLittleEndianShort(bmp, 0) // Reserved1
        writeLittleEndianShort(bmp, 0) // Reserved2
        writeLittleEndianInt(bmp, headerSize) // Pixel data offset

        // --- DIB Header (BITMAPINFOHEADER, 40 bytes) ---
        writeLittleEndianInt(bmp, 40)        // DIB header size
        writeLittleEndianInt(bmp, width)      // Width
        writeLittleEndianInt(bmp, height)     // Height (positive = bottom-up)
        writeLittleEndianShort(bmp, 1)        // Color planes
        writeLittleEndianShort(bmp, 4)        // Bits per pixel (4-bit)
        writeLittleEndianInt(bmp, 0)          // Compression (none)
        writeLittleEndianInt(bmp, pixelDataSize) // Image size
        writeLittleEndianInt(bmp, 2835)       // X pixels/meter (~72 DPI)
        writeLittleEndianInt(bmp, 2835)       // Y pixels/meter
        writeLittleEndianInt(bmp, 16)         // Colors used
        writeLittleEndianInt(bmp, 0)          // Important colors (0 = all)

        // --- Color Table (16 entries, 4 bytes each: B, G, R, 0) ---
        for (i in 0 until 16) {
            val v = i * 17 // 0, 17, 34, ... 255
            bmp.write(v); bmp.write(v); bmp.write(v); bmp.write(0) // B, G, R, Reserved
        }

        // --- Pixel Data (bottom-up rows, 4-bit packed) ---
        for (row in 0 until height) {
            // BMP is bottom-up: row 0 in BMP = last row of image
            val srcRow = height - 1 - row
            val srcOffset = srcRow * width
            val rowBuf = ByteArray(paddedRowSize)

            for (col in 0 until width) {
                val pixelIndex = srcOffset + col
                if (pixelIndex >= grayscalePixels.size) continue

                val gray8 = grayscalePixels[pixelIndex].toInt() and 0xFF
                val index4 = gray8 shr 4

                val bytePos = col / 2
                if (col % 2 == 0) {
                    rowBuf[bytePos] = (index4 shl 4).toByte()
                } else {
                    rowBuf[bytePos] = (rowBuf[bytePos].toInt() or index4).toByte()
                }
            }
            bmp.write(rowBuf)
        }

        Bridge.log("G2: build4BitBmp - ${bmp.size()} bytes (header=$headerSize, pixels=$pixelDataSize, rows=${paddedRowSize}x$height)")
        return bmp.toByteArray()
    }

    private fun writeLittleEndianInt(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value shr 8) and 0xFF)
        out.write((value shr 16) and 0xFF)
        out.write((value shr 24) and 0xFF)
    }

    private fun writeLittleEndianShort(out: ByteArrayOutputStream, value: Int) {
        out.write(value and 0xFF)
        out.write((value shr 8) and 0xFF)
    }

    // ---------- SGCManager: Audio Control ----------

    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("G2: setMicEnabled($enabled)")
        micEnabled_ = enabled
        GlassesStore.apply("glasses", "micEnabled", enabled)

        val msg = EvenHubProto.audioControlMessage(enabled)
        sendEvenHubCommand(msg)
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    // Camera & Media - G2 has no camera
    override fun requestPhoto(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String?,
            authToken: String?,
            compress: String?,
            flash: Boolean,
            sound: Boolean
    ) {
        Bridge.log("G2: requestPhoto - not supported (no camera)")
    }

    override fun startStream(message: MutableMap<String, Any>) {
        Bridge.log("G2: startStream - not supported")
    }

    override fun stopStream() {
        Bridge.log("G2: stopStream - not supported")
    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("G2: sendStreamKeepAlive - not supported")
    }

    override fun startBufferRecording() {
        Bridge.log("G2: startBufferRecording - not supported")
    }

    override fun stopBufferRecording() {
        Bridge.log("G2: stopBufferRecording - not supported")
    }

    override fun saveBufferVideo(requestId: String, durationSeconds: Int) {
        Bridge.log("G2: saveBufferVideo - not supported")
    }

    override fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) {
        Bridge.log("G2: startVideoRecording - not supported")
    }

    override fun stopVideoRecording(requestId: String) {
        Bridge.log("G2: stopVideoRecording - not supported")
    }

    // Button Settings
    override fun sendButtonPhotoSettings() {
        Bridge.log("G2: sendButtonPhotoSettings")
    }

    override fun sendButtonModeSetting() {
        Bridge.log("G2: sendButtonModeSetting")
    }

    override fun sendButtonVideoRecordingSettings() {
        Bridge.log("G2: sendButtonVideoRecordingSettings")
    }

    override fun sendButtonMaxRecordingTime() {
        Bridge.log("G2: sendButtonMaxRecordingTime")
    }

    override fun sendButtonCameraLedSetting() {
        Bridge.log("G2: sendButtonCameraLedSetting")
    }

    override fun sendCameraFovSetting() {
        Bridge.log("G2: sendCameraFovSetting")
    }

    override fun findCompatibleDevices() {
        Bridge.log("G2: findCompatibleDevices()")
        DEVICE_SEARCH_ID = "NOT_SET"
        startScan()
    }

    override fun connectById(id: String) {
        Bridge.log("G2: connectById($id)")
        DEVICE_SEARCH_ID = "_${id}_"
        startScan()
    }

    override fun disconnect() {
        Bridge.log("G2: disconnect()")
        isDisconnecting = true
        stopHeartbeats()
        reconnectionManager.stop()

        leftGatt?.disconnect()
        leftGatt?.close()
        rightGatt?.disconnect()
        rightGatt?.close()

        ready = false
        leftInitialized = false
        rightInitialized = false
        authStarted = false
        startupPageCreated = false
        pageCreated = false
        pageHasTextContainer = false
        heartbeatCounter = 0
        GlassesStore.apply("glasses", "connected", false)
        GlassesStore.apply("glasses", "fullyBooted", false)
    }

    override fun forget() {
        Bridge.log("G2: forget()")
        stopHeartbeats()
        reconnectionManager.stop()
        disconnect()
        leftGlassAddress = null
        rightGlassAddress = null
        leftGatt = null
        rightGatt = null
        leftWriteChar = null
        rightWriteChar = null
        leftNotifyChar = null
        rightNotifyChar = null
        leftAudioChar = null
        rightAudioChar = null
        DEVICE_SEARCH_ID = "NOT_SET"
    }

    override fun cleanup() {
        disconnect()
    }

    override fun getConnectedBluetoothName(): String {
        return rightGatt?.device?.name ?: leftGatt?.device?.name ?: ""
    }

    override fun ping() {
        sendEvenHubHeartbeat()
    }

    override fun dbg1() {}
    override fun dbg2() {}

    // ---------- SGCManager: Device Control ----------

    override fun setHeadUpAngle(angle: Int) {
        // TODO: Implement via g2_setting service
    }

    override fun getBatteryStatus() {
        Bridge.log("G2: getBatteryStatus()")
        requestDeviceInfo()
    }

    override fun setSilentMode(enabled: Boolean) {
        // TODO: Implement
    }

    override fun exit() {
        clearDisplay()
    }

    override fun sendShutdown() {
        clearDisplay()
        disconnect()
    }

    override fun sendReboot() {
        // TODO: Implement via dev_settings
    }

    override fun sendRgbLedControl(
        requestId: String,
        packageName: String?,
        action: String,
        color: String?,
        ontime: Int,
        offtime: Int,
        count: Int
    ) {
        // G2 doesn't have RGB LEDs
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // ---------- SGCManager: Network (G2 has no WiFi) ----------

    override fun requestWifiScan() {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}

    // ---------- SGCManager: User Context ----------

    override fun sendUserEmailToGlasses(email: String) {
        // TODO: Could send via dev_settings
    }

    // ---------- SGCManager: Gallery ----------

    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}

    // ---------- SGCManager: Version Info ----------

    override fun requestVersionInfo() {
        Bridge.log("G2: requestVersionInfo()")
        requestDeviceInfo()
    }

    override fun sendIncidentId(incidentId: String) {}

    // ---------- BLE Scanning ----------

    private fun startScan(): Boolean {
        Bridge.log("G2: startScan()")

        val adapter = bluetoothAdapter ?: run {
            Bridge.log("G2: BluetoothAdapter not available")
            return false
        }

        if (!adapter.isEnabled) {
            Bridge.log("G2: Bluetooth not enabled")
            return false
        }

        isDisconnecting = false

        // Try address-based reconnection first
        if (connectByAddress()) {
            return true
        }

        val scanner = adapter.bluetoothLeScanner ?: run {
            Bridge.log("G2: BluetoothLeScanner not available")
            return false
        }

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                result ?: return
                val device = result.device ?: return
                val name = device.name ?: return

                if (!name.contains("G2")) return

                mainHandler.post {
                    Bridge.log("G2: Discovered: $name (RSSI: ${result.rssi})")
                    emitDiscoveredDevice(name)

                    // If scan-only mode, don't auto-connect
                    if (DEVICE_SEARCH_ID == "NOT_SET") return@post

                    // Only connect to devices matching our search ID
                    if (!name.contains(DEVICE_SEARCH_ID)) return@post

                    if (name.contains("_L_")) {
                        // Hard coded conflict resolution for dev (from iOS)
                        if (!name.contains("_4935")) return@post
                        if (leftGatt == null) {
                            Bridge.log("G2: Connecting to LEFT: $name")
                            leftGatt = device.connectGatt(context, false, leftGattCallback)
                        }
                    } else if (name.contains("_R_")) {
                        // Hard coded conflict resolution for dev (from iOS)
                        if (!name.contains("_BCEF")) return@post
                        if (rightGatt == null) {
                            Bridge.log("G2: Connecting to RIGHT: $name")
                            rightGatt = device.connectGatt(context, false, rightGattCallback)
                        }
                    }

                    // Stop scanning once we have both
                    if (leftGatt != null && rightGatt != null) {
                        stopScan()
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                Bridge.log("G2: Scan failed with error code: $errorCode")
            }
        }

        scanCallback = callback
        scanner.startScan(null, settings, callback)
        return true
    }

    private fun stopScan() {
        scanCallback?.let { cb ->
            bluetoothAdapter?.bluetoothLeScanner?.stopScan(cb)
        }
        scanCallback = null
    }

    private fun connectByAddress(): Boolean {
        if (DEVICE_SEARCH_ID == "NOT_SET" || DEVICE_SEARCH_ID.isEmpty()) {
            Bridge.log("G2: No DEVICE_SEARCH_ID set, skipping connect by address")
            return false
        }

        val leftAddr = leftGlassAddress ?: return false
        val rightAddr = rightGlassAddress ?: return false

        val adapter = bluetoothAdapter ?: return false

        try {
            val leftDevice = adapter.getRemoteDevice(leftAddr)
            val rightDevice = adapter.getRemoteDevice(rightAddr)

            Bridge.log("G2: connectByAddress - left: ${leftDevice.name ?: leftAddr}, right: ${rightDevice.name ?: rightAddr}")

            leftGatt = leftDevice.connectGatt(context, false, leftGattCallback)
            rightGatt = rightDevice.connectGatt(context, false, rightGattCallback)
            return true
        } catch (e: Exception) {
            Bridge.log("G2: connectByAddress failed: ${e.message}")
            return false
        }
    }

    private fun emitDiscoveredDevice(name: String) {
        val idNumber = extractIdNumber(name)
        if (idNumber == null) {
            Bridge.log("G2: Could not extract ID from: $name")
            return
        }
        Bridge.sendDiscoveredDevice(DeviceTypes.G2, "$idNumber")
    }

    private fun extractIdNumber(name: String): Int? {
        val pattern = Pattern.compile("G2_(\\d+)_")
        val matcher = pattern.matcher(name)
        if (matcher.find()) {
            return matcher.group(1)?.toIntOrNull()
        }
        return null
    }

    // ---------- GATT Callbacks ----------

    private val leftGattCallback = createGattCallback("LEFT")
    private val rightGattCallback = createGattCallback("RIGHT")

    @Suppress("deprecation")
    private fun createGattCallback(side: String): BluetoothGattCallback {
        return object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                mainHandler.post {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Bridge.log("G2: Connected to $side: ${gatt.device?.name ?: "unknown"}")

                        // Save address for reconnection
                        val address = gatt.device?.address
                        if (side == "LEFT") {
                            leftGlassAddress = address
                        } else {
                            rightGlassAddress = address
                        }

                        gatt.discoverServices()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        Bridge.log("G2: Disconnected $side")

                        if (isDisconnecting) return@post

                        // Clear both sides to force re-discovery
                        leftGatt?.close()
                        rightGatt?.close()
                        leftGatt = null
                        rightGatt = null
                        leftInitialized = false
                        rightInitialized = false
                        leftWriteChar = null
                        rightWriteChar = null
                        leftNotifyChar = null
                        rightNotifyChar = null
                        leftAudioChar = null
                        rightAudioChar = null
                        authStarted = false

                        ready = false
                        startupPageCreated = false
                        pageCreated = false
                        pageHasTextContainer = false
                        GlassesStore.apply("glasses", "connected", false)
                        GlassesStore.apply("glasses", "fullyBooted", false)

                        startReconnectionTimer()
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) return

                mainHandler.post {
                    val services = gatt.services ?: return@post

                    for (service in services) {
                        for (char in service.characteristics) {
                            val uuid = char.uuid
                            val props = char.properties

                            var propStr = mutableListOf<String>()
                            if (props and BluetoothGattCharacteristic.PROPERTY_READ != 0) propStr.add("read")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) propStr.add("write")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) propStr.add("writeNoResp")
                            if (props and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) propStr.add("notify")
                            if (props and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) propStr.add("indicate")
                            Bridge.log("G2: $side char $uuid props=[${propStr.joinToString(",")}]")

                            when (uuid) {
                                G2BLE.CHAR_WRITE -> {
                                    Bridge.log("G2: Found WRITE char on $side")
                                    if (side == "LEFT") leftWriteChar = char else rightWriteChar = char
                                }
                                G2BLE.CHAR_NOTIFY -> {
                                    Bridge.log("G2: Found NOTIFY char on $side")
                                    if (side == "LEFT") leftNotifyChar = char else rightNotifyChar = char
                                    enqueueGattOp { enableNotifications(gatt, char) }
                                }
                                G2BLE.AUDIO_NOTIFY -> {
                                    Bridge.log("G2: Found AUDIO char on $side")
                                    if (side == "LEFT") leftAudioChar = char else rightAudioChar = char
                                    enqueueGattOp { enableNotifications(gatt, char) }
                                }
                            }
                        }
                    }

                    // Check if this side is fully initialized
                    if (side == "LEFT" && leftWriteChar != null) {
                        leftInitialized = true
                        Bridge.log("G2: LEFT initialized")
                    } else if (side == "RIGHT" && rightWriteChar != null && rightNotifyChar != null) {
                        rightInitialized = true
                        Bridge.log("G2: RIGHT initialized")
                    }

                    // Both sides ready -> run auth (once)
                    if (leftInitialized && rightInitialized && !authStarted) {
                        authStarted = true
                        Bridge.log("G2: Both sides initialized, starting auth sequence")
                        runAuthSequence()
                    }
                }
            }

            @Deprecated("Deprecated in API level 33")
            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                val data = characteristic.value ?: return

                mainHandler.post {
                    when (characteristic.uuid) {
                        G2BLE.AUDIO_NOTIFY -> handleAudioData(data)
                        G2BLE.CHAR_NOTIFY -> handleNotifyData(data)
                    }
                }
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                mainHandler.post {
                    // Process next queued GATT operation
                    gattOpInProgress = false
                    processGattOpQueue()
                }
            }
        }
    }

    // GATT operation queue (Android only allows one outstanding GATT op at a time)
    private fun enqueueGattOp(op: () -> Unit) {
        gattOpQueue.add(op)
        if (!gattOpInProgress) {
            processGattOpQueue()
        }
    }

    private fun processGattOpQueue() {
        if (gattOpQueue.isEmpty()) return
        gattOpInProgress = true
        val op = gattOpQueue.removeAt(0)
        op()
    }

    @Suppress("deprecation")
    private fun enableNotifications(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        gatt.setCharacteristicNotification(characteristic, true)
        val descriptor = characteristic.getDescriptor(G2BLE.CLIENT_CHARACTERISTIC_CONFIG)
        if (descriptor != null) {
            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            gatt.writeDescriptor(descriptor)
        } else {
            // No descriptor, move to next op
            gattOpInProgress = false
            processGattOpQueue()
        }
    }

    // ---------- Incoming Data Handling ----------

    private fun handleNotifyData(data: ByteArray) {
        val result = receiveManager.handlePacket(data) ?: return

        val serviceId = result.first
        val payload = result.second

        when (serviceId) {
            ServiceID.EVEN_HUB.value -> handleEvenHubResponse(payload)
            ServiceID.DEVICE_SETTINGS.value -> handleDevSettingsResponse(payload)
            ServiceID.G2_SETTING.value -> handleG2SettingResponse(payload)
            else -> {
                Bridge.log(
                    "G2: Unhandled service ${serviceId.toInt() and 0xFF} (${payload.size} bytes): ${
                        payload.take(32).joinToString("") { String.format("%02X", it) }
                    }"
                )
            }
        }
    }

    private fun handleEvenHubResponse(payload: ByteArray) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()

        val cmdValue = fields[1] as? Int ?: run {
            Bridge.log(
                "G2: EvenHub response - no cmd field, ${payload.size} bytes: ${
                    payload.joinToString("") { String.format("%02X", it) }
                }"
            )
            return
        }

        if (cmdValue == EvenHubResponseCmd.OS_NOTIFY_EVENT_TO_APP.value) {
            val devEventData = fields[13] as? ByteArray ?: return
            handleTouchEvent(devEventData)
        } else {
            // Parse error codes from responses
            for (resField in listOf(4, 6, 8, 10)) {
                val resData = fields[resField] as? ByteArray ?: continue
                val resReader = ProtobufReader(resData)
                val resFields = resReader.parseFields()
                (resFields[1] as? Int)?.let { errorCode ->
                    Bridge.log("G2: EvenHub response field$resField errorCode=$errorCode")
                }
                (resFields[8] as? Int)?.let { errorCode ->
                    Bridge.log("G2: EvenHub ImgRes errorCode=$errorCode")
                }
            }

            // If glasses sent a shutdown, our page is gone — reset state
            if (cmdValue == 9 || cmdValue == 10) {
                Bridge.log("G2: Glasses shutdown our EvenHub page — resetting page state")
                startupPageCreated = false
                pageCreated = false
                pageHasTextContainer = false
                currentTextContent = ""
            }
        }
    }

    private fun handleTouchEvent(devEventData: ByteArray) {
        val reader = ProtobufReader(devEventData)
        val fields = reader.parseFields()
        val timestamp = System.currentTimeMillis()

        // SysEvent (field 3)
        (fields[3] as? ByteArray)?.let { sysData ->
            val sysReader = ProtobufReader(sysData)
            val sysFields = sysReader.parseFields()
            val eventTypeRaw = sysFields[1] as? Int ?: return@let
            val eventType = OsEventType.fromInt(eventTypeRaw) ?: return@let
            val gestureName = mapEventTypeToGesture(eventType) ?: return@let
            Bridge.sendTouchEvent(DeviceTypes.G2, gestureName, timestamp)
            Bridge.log("G2: SysEvent → $gestureName")
            return
        }

        // TextEvent (field 2)
        (fields[2] as? ByteArray)?.let { textData ->
            val textReader = ProtobufReader(textData)
            val textFields = textReader.parseFields()
            val eventTypeRaw = textFields[3] as? Int ?: return@let
            val eventType = OsEventType.fromInt(eventTypeRaw) ?: return@let
            val gestureName = mapEventTypeToGesture(eventType) ?: return@let
            Bridge.sendTouchEvent(DeviceTypes.G2, gestureName, timestamp)
            Bridge.log("G2: TextEvent → $gestureName")
            return
        }

        // ListEvent (field 1)
        (fields[1] as? ByteArray)?.let { listData ->
            val listReader = ProtobufReader(listData)
            val listFields = listReader.parseFields()
            val eventTypeRaw = listFields[5] as? Int ?: return@let
            val eventType = OsEventType.fromInt(eventTypeRaw) ?: return@let
            val gestureName = mapEventTypeToGesture(eventType) ?: return@let
            Bridge.sendTouchEvent(DeviceTypes.G2, gestureName, timestamp)
            Bridge.log("G2: ListEvent → $gestureName")
        }
    }

    private fun mapEventTypeToGesture(eventType: OsEventType): String? {
        return when (eventType) {
            OsEventType.CLICK -> "single_tap"
            OsEventType.DOUBLE_CLICK -> "double_tap"
            OsEventType.SCROLL_TOP -> "swipe_down"
            OsEventType.SCROLL_BOTTOM -> "swipe_up"
            OsEventType.FOREGROUND_ENTER -> "foreground_enter"
            OsEventType.FOREGROUND_EXIT -> "foreground_exit"
            OsEventType.SYSTEM_EXIT -> "system_exit"
            OsEventType.ABNORMAL_EXIT -> null
        }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun handleDevSettingsResponse(payload: ByteArray) {
        // DevSettings responses (auth acks, heartbeat acks) — mostly informational
    }

    private fun handleG2SettingResponse(payload: ByteArray) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()

        val cmdValue = fields[1] as? Int ?: return

        if (cmdValue == G2SettingCommandId.DEVICE_RECEIVE_REQUEST.value ||
            cmdValue == G2SettingCommandId.DEVICE_SEND_TO_APP.value
        ) {
            (fields[4] as? ByteArray)?.let { parseDeviceRequestResponse(it) }
            (fields[5] as? ByteArray)?.let { parseDeviceSendToApp(it) }
        }
    }

    private fun parseDeviceRequestResponse(data: ByteArray) {
        val reader = ProtobufReader(data)
        val fields = reader.parseFields()

        // Battery
        (fields[12] as? Int)?.let { battery ->
            if (battery in 0..100) {
                Bridge.log("G2: Battery level: $battery%")
                batteryLevel_ = battery
            }
        }

        // Charging status
        (fields[13] as? Int)?.let { charging ->
            isCharging = charging != 0
            Bridge.log("G2: Charging: $isCharging")
            if (_batteryLevel >= 0) {
                Bridge.sendBatteryStatus(_batteryLevel, isCharging)
            }
        }

        // Software versions
        (fields[5] as? ByteArray)?.let { leftVer ->
            val leftVersion = String(leftVer, Charsets.UTF_8)
            Bridge.log("G2: Left firmware: $leftVersion")
            GlassesStore.apply("glasses", "leftFirmwareVersion", leftVersion)
        }

        (fields[6] as? ByteArray)?.let { rightVer ->
            val rightVersion = String(rightVer, Charsets.UTF_8)
            Bridge.log("G2: Right firmware: $rightVersion")
            GlassesStore.apply("glasses", "rightFirmwareVersion", rightVersion)
            GlassesStore.apply("glasses", "firmwareVersion", rightVersion)
        }
    }

    private fun parseDeviceSendToApp(data: ByteArray) {
        val reader = ProtobufReader(data)
        val fields = reader.parseFields()
        (fields[2] as? Int)?.let { silentMode ->
            Bridge.log("G2: Silent mode: ${silentMode != 0}")
        }
    }

    // ---------- Audio Handling ----------

    private fun handleAudioData(data: ByteArray) {
        val usableLength = minOf(data.size, 200)
        if (usableLength < 40) return

        val audioData = data.copyOfRange(0, usableLength)
        CoreManager.getInstance().handleGlassesMicData(audioData, 40)
    }

    // ---------- Reconnection ----------

    private fun startReconnectionTimer() {
        reconnectionManager.start {
            if (ready) {
                Bridge.log("G2: Already connected, stopping reconnection")
                return@start true
            }

            Bridge.log("G2: Attempting reconnection...")
            startScan()
            return@start false
        }
    }
}
