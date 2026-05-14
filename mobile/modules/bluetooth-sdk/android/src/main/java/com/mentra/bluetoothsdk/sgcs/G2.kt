package com.mentra.core.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
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
    DASHBOARD(0x01), // UI_BACKGROUND_DASHBOARD_APP_ID
    MENU(0x03), // UI_FOREGROUND_MEUN_ID (typo is intentional — matches Even's proto)
    EVEN_AI(0x07), // UI_FOREGROUND_EVEN_AI_ID
    G2_SETTING(0x09), // UI_SETTING_APP_ID
    GESTURE_CTRL(0x0D), // gesture_ctrl lifecycle signals
    ONBOARDING(0x10), // UI_ONBOARDING_APP_ID
    DEVICE_SETTINGS(0x80.toByte()), // UX_DEVICE_SETTINGS_APP_ID
    EVEN_HUB_CTRL(0x81.toByte()), // EvenHub CTRL channel (init/registration)
    EVEN_HUB(0xE0.toByte()); // UI_BACKGROUND_EVENHUB_APP_ID

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
    RING_CONNECT_INFO(6),
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

    val hasMore: Boolean
        get() = offset < data.size

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
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            borderWidth: Int = 0,
            borderColor: Int = 0,
            borderRadius: Int = 0,
            paddingLength: Int = 0,
            containerID: Int,
            containerName: String? = null,
            isEventCapture: Boolean = false,
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
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            containerID: Int,
            containerName: String? = null
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
            containerID: Int,
            containerName: String? = null,
            mapSessionId: Int,
            mapTotalSize: Int,
            compressMode: Int = 0,
            mapFragmentIndex: Int,
            mapFragmentPacketSize: Int,
            mapRawData: ByteArray
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
            containerID: Int,
            contentOffset: Int = 0,
            contentLength: Int,
            content: String
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

    fun evenHubMessage(
            cmd: EvenHubCmd,
            subFieldNumber: Int,
            subMessage: ByteArray,
            magicRandom: Int = 0,
            appId: Int? = null
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, cmd.value) // Cmd (field 1, enum)
        w.writeInt32Field(2, magicRandom) // MagicRandom (field 2)
        w.writeMessageField(subFieldNumber, subMessage) // the actual command payload
        appId?.let { w.writeInt32Field(5, it) } // Associate page with a menu item appId
        return w.toByteArray()
    }

    fun createPageMessage(
            textContainers: List<ByteArray> = emptyList(),
            imageContainers: List<ByteArray> = emptyList(),
            magicRandom: Int = 0,
            appId: Int? = null
    ): ByteArray {
        val total = textContainers.size + imageContainers.size
        val createMsg = createStartupPageContainer(total, textContainers, imageContainers)
        return evenHubMessage(
                EvenHubCmd.CREATE_STARTUP_PAGE,
                3,
                createMsg,
                magicRandom = magicRandom,
                appId = null
        )
    }

    fun rebuildPageMessage(
            textContainers: List<ByteArray> = emptyList(),
            imageContainers: List<ByteArray> = emptyList(),
            magicRandom: Int = 0,
            appId: Int? = null
    ): ByteArray {
        val total = textContainers.size + imageContainers.size
        val rebuildMsg = createStartupPageContainer(total, textContainers, imageContainers)
        return evenHubMessage(
                EvenHubCmd.REBUILD_PAGE,
                7,
                rebuildMsg,
                magicRandom = magicRandom,
                appId = appId
        )
    }

    fun updateImageRawDataMessage(
            containerID: Int,
            containerName: String? = null,
            mapSessionId: Int,
            mapTotalSize: Int,
            compressMode: Int = 0,
            mapFragmentIndex: Int,
            mapFragmentPacketSize: Int,
            mapRawData: ByteArray
    ): ByteArray {
        val updateMsg =
                imageRawDataUpdate(
                        containerID,
                        containerName,
                        mapSessionId,
                        mapTotalSize,
                        compressMode,
                        mapFragmentIndex,
                        mapFragmentPacketSize,
                        mapRawData
                )
        return evenHubMessage(EvenHubCmd.UPDATE_IMAGE_RAW_DATA, 5, updateMsg)
    }

    fun updateTextMessage(
            containerID: Int,
            contentOffset: Int = 0,
            contentLength: Int,
            content: String
    ): ByteArray {
        val upgradeMsg = textContainerUpgrade(containerID, contentOffset, contentLength, content)
        return evenHubMessage(EvenHubCmd.UPDATE_TEXT_DATA, 9, upgradeMsg)
    }

    fun shutdownMessage(exitMode: Int = 0): ByteArray {
        val msg = shutdownContainer(exitMode)
        return evenHubMessage(EvenHubCmd.SHUTDOWN_PAGE, 11, msg)
    }

    fun heartbeatMessage(magicRandom: Int = 0): ByteArray {
        val msg = heartbeatPacket()
        return evenHubMessage(EvenHubCmd.HEARTBEAT, 14, msg, magicRandom = magicRandom)
    }

    fun audioControlMessage(enable: Boolean, magicRandom: Int = 0): ByteArray {
        val msg = audioCtrCmd(enable)
        return evenHubMessage(EvenHubCmd.AUDIO_CONTROL, 18, msg, magicRandom = magicRandom)
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
        authW.writeInt32Field(2, 4) // phoneType = PHONE_ANDROID (4)

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

    fun ringConnectInfo(
            magicRandom: Int,
            connect: Boolean,
            ringMac: ByteArray,
            ringName: String = ""
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(
                1,
                DevCfgCommandId.RING_CONNECT_INFO.value
        ) // commandId = RING_CONNECT_INFO (6)
        w.writeInt32Field(2, magicRandom)

        // RingInfo sub-message (field 5 in DevCfgDataPackage)
        val ringW = ProtobufWriter()
        ringW.writeBoolField(1, connect) // connectRing
        ringW.writeBytesField(2, ringMac) // ringMac (6 bytes)
        if (ringName.isNotEmpty()) {
            ringW.writeBytesField(3, ringName.toByteArray(Charsets.UTF_8)) // ringName
        }

        w.writeMessageField(5, ringW.toByteArray()) // ringInfo (field 5)
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

    fun setHeadUpSwitch(magicRandom: Int, enabled: Boolean): ByteArray {
        // DeviceReceive_Head_UP_Setting
        val headUpW = ProtobufWriter()
        headUpW.writeInt32Field(1, if (enabled) 1 else 0) // headUpSwitch

        // DeviceReceiveInfoFromAPP
        val infoW = ProtobufWriter()
        infoW.writeMessageField(4, headUpW.toByteArray()) // deviceReceiveHeadUpSetting (field 4)

        // G2SettingPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_INFO.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.toByteArray()) // deviceReceiveInfoFromApp (field 3)
        return w.toByteArray()
    }

    fun setHeadUpAngle(magicRandom: Int, angle: Int): ByteArray {
        // DeviceReceive_Head_UP_Setting
        val headUpW = ProtobufWriter()
        headUpW.writeInt32Field(2, angle) // headUpAngle (field 2)

        // DeviceReceiveInfoFromAPP
        val infoW = ProtobufWriter()
        infoW.writeMessageField(4, headUpW.toByteArray()) // deviceReceiveHeadUpSetting (field 4)

        // G2SettingPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_INFO.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.toByteArray())
        return w.toByteArray()
    }

    fun setScreenHeight(magicRandom: Int, level: Int): ByteArray {
        // DeviceReceive_Y_Coordinate
        val yW = ProtobufWriter()
        yW.writeInt32Field(1, level) // yCoordinateLevel

        // DeviceReceiveInfoFromAPP
        val infoW = ProtobufWriter()
        infoW.writeMessageField(2, yW.toByteArray()) // deviceReceiveYCoordinate (field 2)

        // G2SettingPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_INFO.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.toByteArray())
        return w.toByteArray()
    }

    fun setScreenDepth(magicRandom: Int, level: Int): ByteArray {
        // DeviceReceive_X_Coordinate
        val xW = ProtobufWriter()
        xW.writeInt32Field(1, level) // xCoordinateLevel

        // DeviceReceiveInfoFromAPP
        val infoW = ProtobufWriter()
        infoW.writeMessageField(3, xW.toByteArray()) // deviceReceiveXCoordinate (field 3)

        // G2SettingPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, G2SettingCommandId.DEVICE_RECEIVE_INFO.value)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, infoW.toByteArray())
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

// ---------- EvenAI Protobuf Builders (even_ai.proto, service ID 7) ----------

private object EvenAIProto {
    fun setHeyEven(magicRandom: Int, enabled: Boolean): ByteArray {
        // EvenAIConfig
        val configW = ProtobufWriter()
        configW.writeInt32Field(1, if (enabled) 1 else 0) // voiceSwitch
        configW.writeInt32Field(2, 80) // streamSpeed (always sent)

        // EvenAIDataPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, 10) // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(13, configW.toByteArray()) // config (field 13)
        return w.toByteArray()
    }
}

// ---------- Menu Protobuf Builders (menu.proto, service ID 3) ----------

private object MenuProto {
    data class MenuItem(val packageName: String, val name: String, val running: Boolean)

    const val MIN_MENU_SIZE = 5
    const val MAX_MENU_SIZE = 10
    const val MAX_NAME_LENGTH = 15 // 17 char limit minus 2 for running indicator prefix
    val PLACEHOLDER_APP_IDS = listOf(10535, 10536, 10537, 10538, 10539)

    /** Deterministic hash of packageName -> numeric appId in range 10029-10534 */
    fun packageNameToAppId(packageName: String): Int {
        var hash = 0
        for (char in packageName) {
            hash = (hash shl 5) - hash + char.code
        }
        // 506 values: 10029-10534 (reserve 10535-10539 for placeholders)
        return 10029 + (kotlin.math.abs(hash) % 506)
    }

    /**
     * meun_main_msg_ctx with APP_SEND_MENU_INFO command Handles: name truncation (15 chars),
     * running prefix, padding to 5, cap at 10 Always prepends the built-in Notification item as the
     * first entry. Returns (protobuf data, appId->packageName mapping for reverse lookup)
     */
    fun sendMenuInfo(magicRandom: Int, items: List<MenuItem>): Pair<ByteArray, Map<Int, String>> {
        val appIdMap = mutableMapOf<Int, String>()

        data class WireItem(val displayName: String?, val appId: Int, val isBuiltIn: Boolean)
        val wireItems = mutableListOf<WireItem>()

        // Always first: built-in Notification (SID=4)
        wireItems.add(WireItem(null, 4, true))

        // Third-party items — leave room for the built-in
        for (item in items.take(MAX_MENU_SIZE - 1)) {
            val appId = packageNameToAppId(item.packageName)
            appIdMap[appId] = item.packageName

            val truncated =
                    if (item.name.length > MAX_NAME_LENGTH) item.name.take(MAX_NAME_LENGTH)
                    else item.name
            val prefix = if (item.running) "● " else "  "
            wireItems.add(WireItem(prefix + truncated, appId, false))
        }

        // Pad to MIN_MENU_SIZE with placeholder third-party items
        while (wireItems.size < MIN_MENU_SIZE) {
            val idx = wireItems.size - 1 // -1 because built-in occupies slot 0
            wireItems.add(WireItem("  ---", PLACEHOLDER_APP_IDS[idx], false))
        }

        // MenuInfoSend
        val menuW = ProtobufWriter()
        menuW.writeInt32Field(1, wireItems.size) // itemTotalNum

        for (item in wireItems) {
            val itemW = ProtobufWriter()
            if (item.isBuiltIn) {
                itemW.writeInt32Field(1, 0) // itemType = 0 (built-in)
                itemW.writeInt32Field(4, item.appId) // itemAppId = SID
            } else {
                itemW.writeInt32Field(1, 1) // itemType = 1 (third-party)
                itemW.writeInt32Field(2, 1) // iconNum = 1
                itemW.writeStringField(3, item.displayName ?: "") // itemName
                itemW.writeInt32Field(4, item.appId) // itemAppId
            }
            menuW.writeMessageField(2, itemW.toByteArray()) // repeated item (field 2)
        }

        // meun_main_msg_ctx
        val w = ProtobufWriter()
        w.writeInt32Field(1, 0) // Cmd = APP_SEND_MENU_INFO (0)
        w.writeInt32Field(2, magicRandom) // MagicRandom
        w.writeMessageField(3, menuW.toByteArray()) // sendData (field 3)
        return Pair(w.toByteArray(), appIdMap)
    }
}

// ---------- EvenBLE Transport Layer ----------

private object EvenBLETransport {
    fun buildPackets(
            syncId: Byte,
            serviceId: Byte,
            payload: ByteArray,
            reserveFlag: Boolean = false
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
            packet.write(
                    ((G2BLE.DEST_GLASSES.toInt() shl 4) or G2BLE.SOURCE_PHONE.toInt()) and 0xFF
            )
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

    fun buildPackets(
            serviceId: Byte,
            payload: ByteArray,
            reserveFlag: Boolean = false
    ): List<ByteArray> {
        val sid = nextSyncId()
        return EvenBLETransport.buildPackets(sid, serviceId, payload, reserveFlag)
    }
}

// ---------- G2 Receive Manager ----------

private class G2ReceiveManager {
    private val partials = mutableMapOf<String, Pair<ByteArrayOutputStream, Byte>>()

    fun handlePacket(rawData: ByteArray, sourceKey: String = ""): Pair<Byte, ByteArray>? {
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
        // Include sourceKey so concurrent multi-packet responses from the L and R lenses with
        // the same syncId don't cross-merge into one broken payload.
        val key = "$sourceKey-${serviceId.toInt() and 0xFF}-${syncId.toInt() and 0xFF}"

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
    val isRunning: Boolean
        get() = runnable != null

    fun start(onAttempt: () -> Boolean) {
        stop()
        attempts = 0

        val r =
                object : Runnable {
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

    // BLE
    private val context: Context
        get() = Bridge.getContext()
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
    private var pairingTimeoutRunnable: Runnable? = null

    // Device search
    private var DEVICE_SEARCH_ID = "NOT_SET"
    // Map device names to serial numbers (populated from manufacturer data during scan)
    private val deviceNameToSerialNumber = mutableMapOf<String, String>()

    // Saved addresses for reconnection
    private var leftGlassAddress: String?
        get() =
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(KEY_LEFT_ADDRESS, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .apply {
                        if (value != null) putString(KEY_LEFT_ADDRESS, value)
                        else remove(KEY_LEFT_ADDRESS)
                    }
                    .apply()
        }

    private var rightGlassAddress: String?
        get() =
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(KEY_RIGHT_ADDRESS, null)
        set(value) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .apply {
                        if (value != null) putString(KEY_RIGHT_ADDRESS, value)
                        else remove(KEY_RIGHT_ADDRESS)
                    }
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
    private var evenHubQueueRunnable: Runnable? = null
    private var pendingTextMsg: ByteArray? = null
    private var lastEvenHubMsg: ByteArray? = null
    private var lastEvenHubResendsRemaining: Int = 0
    private val EVEN_HUB_RESEND_COUNT: Int = 1
    private val EVEN_HUB_QUEUE_TICK_MS = 100L
    private var startupPageCreated: Boolean = false
    private var pageCreated: Boolean = false
    private var pageHasTextContainer: Boolean = false
    private var currentTextContent: String = ""
    private var textContainerID: Int = 1
    private var imageSessionCounter: Int = 0
    private var heartbeatCounter: Int = 0
    private var authStarted: Boolean = false
    private var leftAuthenticated: Boolean = false
    private var rightAuthenticated: Boolean = false
    private var currentBitmapBase64: String = ""

    // Dashboard menu state
    private var menuAppIdToPackageName: MutableMap<Int, String> = mutableMapOf()
    private var dashboardMenuItems: MutableList<MenuProto.MenuItem> = mutableListOf()
    private var activeMenuAppId: Int? = null
    private var lastClickTimestamp: Long? = null
    private var lastMenuSelectTimestamp: Long? = null

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

    // Min gap between BLE packets when bursting many in a row. Android serializes one in-flight
    // GATT op at a time even for WRITE_TYPE_NO_RESPONSE, so back-to-back writeCharacteristic() in
    // a tight loop drops packets silently. iOS gets this for free via CoreBluetooth; we don't.
    // Matches the 8 ms G1.java uses for its bitmap chunk loop (ANDROID_CHUNK_DELAY_MS).
    private val BLE_PACKET_GAP_MS = 8L

    @Suppress("deprecation")
    private fun writeOnePacket(packet: ByteArray, left: Boolean, right: Boolean) {
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

    private fun sendToGlasses(
            packets: List<ByteArray>,
            left: Boolean = false,
            right: Boolean = true
    ) {
        if (packets.isEmpty()) return
        // Single-packet sends (the common case for text/settings) go straight through.
        if (packets.size == 1) {
            writeOnePacket(packets[0], left, right)
            return
        }
        // Multi-packet bursts (bitmaps, large protobufs): write the first packet immediately,
        // then schedule the rest with BLE_PACKET_GAP_MS spacing so the Android BLE stack can
        // actually drain each write before the next one is queued.
        writeOnePacket(packets[0], left, right)
        for (i in 1 until packets.size) {
            val packet = packets[i]
            mainHandler.postDelayed({ writeOnePacket(packet, left, right) }, BLE_PACKET_GAP_MS * i)
        }
    }

    private fun sendEvenHubCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.EVEN_HUB.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendDevSettingsCommand(
            payload: ByteArray,
            left: Boolean = false,
            right: Boolean = true
    ) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.DEVICE_SETTINGS.value,
                        payload = payload
                )
        sendToGlasses(packets, left = left, right = right)
    }

    private fun sendG2SettingCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.G2_SETTING.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendOnboardingCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.ONBOARDING.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendEvenAICommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.EVEN_AI.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendMenuCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.MENU.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendGestureCtrlCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.GESTURE_CTRL.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendEvenHubCtrlCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.EVEN_HUB_CTRL.value,
                        payload = payload,
                        reserveFlag = true
                )
        sendToGlasses(packets)
    }

    private fun sendDashboardCommand(payload: ByteArray) {
        val packets =
                sendManager.buildPackets(
                        serviceId = ServiceID.DASHBOARD.value,
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
        mainHandler.postDelayed(
                {
                    val authR = DevSettingsProto.authCmd(sendManager.nextMagicRandom())
                    sendDevSettingsCommand(authR, left = false, right = true)

                    mainHandler.postDelayed(
                            {
                                val roleChange =
                                        DevSettingsProto.pipeRoleChange(
                                                sendManager.nextMagicRandom()
                                        )
                                sendDevSettingsCommand(roleChange, left = false, right = true)

                                mainHandler.postDelayed(
                                        {
                                            val timeSync =
                                                    DevSettingsProto.timeSync(
                                                            sendManager.nextMagicRandom()
                                                    )
                                            sendDevSettingsCommand(timeSync)

                                            // Skip onboarding on connect
                                            mainHandler.postDelayed(
                                                    {
                                                        val onboarding =
                                                                OnboardingProto.skipOnboarding(
                                                                        sendManager
                                                                                .nextMagicRandom()
                                                                )
                                                        sendOnboardingCommand(onboarding)
                                                        Bridge.log(
                                                                "G2: Sent onboarding skip (FINISH)"
                                                        )

                                                        // Disable "Hey Even" wakeword on connect
                                                        val heyEvenOff =
                                                                EvenAIProto.setHeyEven(
                                                                        sendManager
                                                                                .nextMagicRandom(),
                                                                        false
                                                                )
                                                        sendEvenAICommand(heyEvenOff)
                                                        Bridge.log("G2: Disabled Hey Even wakeword")

                                                        // Replicate Even app's full init sequence
                                                        // for menu selection support:

                                                        // 0. Universe settings (g2_setting cmd=1
                                                        // field3 with field9=universe settings)
                                                        val univW = ProtobufWriter()
                                                        univW.writeInt32Field(
                                                                1,
                                                                1
                                                        ) // DeviceReceiveInfo
                                                        univW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        univW.writeMessageField(
                                                                3,
                                                                byteArrayOf(
                                                                        0x4A,
                                                                        0x0A, // field 9, length 10
                                                                        0x08,
                                                                        0x00, // unitFormat=0
                                                                        0x10,
                                                                        0x00, // distanceUnit=0
                                                                        0x18,
                                                                        0x01, // timeFormat=1
                                                                        0x20,
                                                                        0x00, // dateFormat=0
                                                                        0x28,
                                                                        0x01 // temperatureUnit=1
                                                                )
                                                        )
                                                        sendG2SettingCommand(univW.toByteArray())

                                                        // 1. gesture_ctrl init (field1=0,
                                                        // field2=magicRandom)
                                                        val gestureInitW = ProtobufWriter()
                                                        gestureInitW.writeInt32Field(1, 0)
                                                        gestureInitW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        sendGestureCtrlCommand(
                                                                gestureInitW.toByteArray()
                                                        )

                                                        // 2. ui_setting_app (0x0C) — query
                                                        val uiSettW = ProtobufWriter()
                                                        uiSettW.writeInt32Field(
                                                                1,
                                                                2
                                                        ) // cmd = DeviceReceiveRequest
                                                        uiSettW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        uiSettW.writeMessageField(
                                                                4,
                                                                byteArrayOf(0x08, 0x01, 0x10, 0x00)
                                                        ) // {1:1, 2:0}
                                                        sendToGlasses(
                                                                sendManager.buildPackets(
                                                                        serviceId = 0x0C,
                                                                        payload =
                                                                                uiSettW.toByteArray(),
                                                                        reserveFlag = true
                                                                )
                                                        )

                                                        // 3. teleprompter (0x10) — config (cmd=1,
                                                        // field3={1:4})
                                                        val teleW = ProtobufWriter()
                                                        teleW.writeInt32Field(1, 1)
                                                        teleW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        teleW.writeMessageField(
                                                                3,
                                                                byteArrayOf(0x08, 0x04)
                                                        ) // {1:4}
                                                        sendToGlasses(
                                                                sendManager.buildPackets(
                                                                        serviceId = 0x10,
                                                                        payload =
                                                                                teleW.toByteArray(),
                                                                        reserveFlag = true
                                                                )
                                                        )

                                                        // 4. EvenHub CTRL on service 0x81 (cmd=1,
                                                        // empty field3)
                                                        val ehCtrlW = ProtobufWriter()
                                                        ehCtrlW.writeInt32Field(1, 1)
                                                        ehCtrlW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        ehCtrlW.writeMessageField(3, ByteArray(0))
                                                        sendEvenHubCtrlCommand(
                                                                ehCtrlW.toByteArray()
                                                        )

                                                        // 5. calendar (0x04) — config
                                                        val calW = ProtobufWriter()
                                                        calW.writeInt32Field(1, 1)
                                                        calW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        calW.writeMessageField(
                                                                3,
                                                                byteArrayOf(
                                                                        0x08,
                                                                        0x01,
                                                                        0x10,
                                                                        0x01,
                                                                        0x18,
                                                                        0x05,
                                                                        0x28,
                                                                        0x01
                                                                )
                                                        )
                                                        sendToGlasses(
                                                                sendManager.buildPackets(
                                                                        serviceId = 0x04,
                                                                        payload =
                                                                                calW.toByteArray(),
                                                                        reserveFlag = true
                                                                )
                                                        )

                                                        // 6. Dashboard init (0x01) — display
                                                        // settings
                                                        val dashDisplayW = ProtobufWriter()
                                                        dashDisplayW.writeInt32Field(
                                                                1,
                                                                4
                                                        ) // displayMode
                                                        dashDisplayW.writeInt32Field(
                                                                2,
                                                                3
                                                        ) // statusDisplayCount
                                                        dashDisplayW.writeMessageField(
                                                                3,
                                                                byteArrayOf(1, 2, 3)
                                                        ) // statusDisplayOrder
                                                        dashDisplayW.writeInt32Field(
                                                                4,
                                                                4
                                                        ) // widgetDisplayCount
                                                        dashDisplayW.writeMessageField(
                                                                5,
                                                                byteArrayOf(1, 3, 2, 2)
                                                        ) // widgetDisplayOrder
                                                        dashDisplayW.writeInt32Field(
                                                                6,
                                                                1
                                                        ) // halfDayFormat
                                                        dashDisplayW.writeInt32Field(
                                                                7,
                                                                1
                                                        ) // temperatureUnit

                                                        val dashRecvW = ProtobufWriter()
                                                        dashRecvW.writeMessageField(
                                                                2,
                                                                dashDisplayW.toByteArray()
                                                        )

                                                        val dashPkgW = ProtobufWriter()
                                                        dashPkgW.writeInt32Field(
                                                                1,
                                                                2
                                                        ) // Dashboard_Receive
                                                        dashPkgW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        dashPkgW.writeMessageField(
                                                                4,
                                                                dashRecvW.toByteArray()
                                                        )
                                                        sendDashboardCommand(dashPkgW.toByteArray())

                                                        // 7. Dashboard REQUEST_NEWS_INFO (cmd=5,
                                                        // field7={1:1})
                                                        val dashNewsReqW = ProtobufWriter()
                                                        dashNewsReqW.writeInt32Field(
                                                                1,
                                                                5
                                                        ) // REQUEST_NEWS_INFO
                                                        dashNewsReqW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        dashNewsReqW.writeMessageField(
                                                                7,
                                                                byteArrayOf(0x08, 0x01)
                                                        ) // {1:1}
                                                        sendDashboardCommand(
                                                                dashNewsReqW.toByteArray()
                                                        )

                                                        // 8. Gesture control list via g2_setting
                                                        val gestListW = ProtobufWriter()
                                                        gestListW.writeInt32Field(
                                                                1,
                                                                1
                                                        ) // DeviceReceiveInfo
                                                        gestListW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        // field 3 with field 10
                                                        // (gestureControlList): 3 items, all
                                                        // app_unable
                                                        val gestureCtrlPayload =
                                                                byteArrayOf(
                                                                        0x52,
                                                                        0x18, // field 10, length 24
                                                                        0x0A,
                                                                        0x06,
                                                                        0x08,
                                                                        0x00,
                                                                        0x10,
                                                                        0x00,
                                                                        0x18,
                                                                        0x00, // item 1
                                                                        0x0A,
                                                                        0x06,
                                                                        0x08,
                                                                        0x00,
                                                                        0x10,
                                                                        0x01,
                                                                        0x18,
                                                                        0x00, // item 2
                                                                        0x0A,
                                                                        0x06,
                                                                        0x08,
                                                                        0x00,
                                                                        0x10,
                                                                        0x02,
                                                                        0x18,
                                                                        0x00 // item 3
                                                                )
                                                        gestListW.writeMessageField(
                                                                3,
                                                                gestureCtrlPayload
                                                        )
                                                        sendG2SettingCommand(
                                                                gestListW.toByteArray()
                                                        )

                                                        // 9. Dashboard APP_REQUEST_NEWS_INFO
                                                        // (cmd=7, field9={1:1})
                                                        val dashAppNewsW = ProtobufWriter()
                                                        dashAppNewsW.writeInt32Field(
                                                                1,
                                                                7
                                                        ) // APP_REQUEST_NEWS_INFO
                                                        dashAppNewsW.writeInt32Field(
                                                                2,
                                                                sendManager.nextMagicRandom()
                                                        )
                                                        dashAppNewsW.writeMessageField(
                                                                9,
                                                                byteArrayOf(0x08, 0x01)
                                                        ) // {1:1}
                                                        sendDashboardCommand(
                                                                dashAppNewsW.toByteArray()
                                                        )

                                                        Bridge.log(
                                                                "G2: Sent full Even-compatible init sequence"
                                                        )
                                                    },
                                                    200
                                            )

                                            // Start heartbeats after auth
                                            startHeartbeats()

                                            // Mark as ready and request device info
                                            mainHandler.postDelayed(
                                                    {
                                                        reconnectionManager.stop()
                                                        Bridge.log(
                                                                "G2: Auth sequence complete, glasses ready"
                                                        )

                                                        // Set device_name so CoreManager can save
                                                        // it for reconnection
                                                        val peripheralName =
                                                                rightGatt?.device?.name
                                                                        ?: leftGatt?.device?.name
                                                        val serialNumber =
                                                                peripheralName?.let {
                                                                    deviceNameToSerialNumber[it]
                                                                }
                                                        if (serialNumber != null) {
                                                            GlassesStore.apply(
                                                                    "core",
                                                                    "device_name",
                                                                    serialNumber
                                                            )
                                                            Bridge.log(
                                                                    "G2: Set device_name to $serialNumber"
                                                            )
                                                        }

                                                        // Set bluetooth name and device model for
                                                        // Device Info page
                                                        val btName =
                                                                rightGatt?.device?.name
                                                                        ?: leftGatt?.device?.name
                                                                                ?: ""
                                                        GlassesStore.apply(
                                                                "glasses",
                                                                "bluetoothName",
                                                                btName
                                                        )
                                                        GlassesStore.apply(
                                                                "glasses",
                                                                "deviceModel",
                                                                DeviceTypes.G2
                                                        )

                                                        GlassesStore.apply(
                                                                "glasses",
                                                                "connected",
                                                                true
                                                        )
                                                        GlassesStore.apply(
                                                                "glasses",
                                                                "fullyBooted",
                                                                true
                                                        )

                                                        // Connect a controller if we have one
                                                        connectController()

                                                        // Query version + battery info from glasses
                                                        requestDeviceInfo()

                                                        sendMenuApps()
                                                    },
                                                    500
                                            )
                                        },
                                        200
                                )
                            },
                            200
                    )
                },
                200
        )
    }

    private fun runDashboardSequence() {
        Bridge.log("G2: Running dashboard sequence")

        // Send the shutdown command to the glasses
        val msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        currentTextContent = ""

        mainHandler.postDelayed(
                {
                    // 1. gesture_ctrl init (field1=0, field2=magicRandom)
                    val gestureInitW = ProtobufWriter()
                    gestureInitW.writeInt32Field(1, 0)
                    gestureInitW.writeInt32Field(2, sendManager.nextMagicRandom())
                    sendGestureCtrlCommand(gestureInitW.toByteArray())

                    // 6. Dashboard init (0x01) — display settings
                    val dashDisplayW = ProtobufWriter()
                    dashDisplayW.writeInt32Field(1, 4) // displayMode
                    dashDisplayW.writeInt32Field(2, 3) // statusDisplayCount
                    dashDisplayW.writeMessageField(3, byteArrayOf(1, 2, 3)) // statusDisplayOrder
                    dashDisplayW.writeInt32Field(4, 4) // widgetDisplayCount
                    dashDisplayW.writeMessageField(5, byteArrayOf(1, 3, 2, 2)) // widgetDisplayOrder
                    dashDisplayW.writeInt32Field(6, 1) // halfDayFormat
                    dashDisplayW.writeInt32Field(7, 1) // temperatureUnit

                    val dashRecvW = ProtobufWriter()
                    dashRecvW.writeMessageField(2, dashDisplayW.toByteArray())

                    val dashPkgW = ProtobufWriter()
                    dashPkgW.writeInt32Field(1, 2) // Dashboard_Receive
                    dashPkgW.writeInt32Field(2, sendManager.nextMagicRandom())
                    dashPkgW.writeMessageField(4, dashRecvW.toByteArray())
                    sendDashboardCommand(dashPkgW.toByteArray())

                    Bridge.log("G2: Sent full Even-compatible init sequence")
                },
                1000
        )
    }

    // ---------- Heartbeats ----------

    private fun startHeartbeats() {
        // EvenHub heartbeat every 5 seconds
        stopHeartbeats()

        val hbRunnable =
                object : Runnable {
                    override fun run() {
                        sendEvenHubHeartbeat()
                        mainHandler.postDelayed(this, 5000)
                    }
                }
        heartbeatRunnable = hbRunnable
        mainHandler.postDelayed(hbRunnable, 5000)

        // DevSettings heartbeat every 5 seconds
        val dsRunnable =
                object : Runnable {
                    override fun run() {
                        sendDevSettingsHeartbeat()
                        mainHandler.postDelayed(this, 5000)
                    }
                }
        devSettingsHeartbeatRunnable = dsRunnable
        mainHandler.postDelayed(dsRunnable, 5000)

        // EvenHub text command queue: drain the most recent pending updateText every 100ms
        val queueRunnable =
                object : Runnable {
                    override fun run() {
                        drainEvenHubQueue()
                        mainHandler.postDelayed(this, EVEN_HUB_QUEUE_TICK_MS)
                    }
                }
        evenHubQueueRunnable = queueRunnable
        mainHandler.postDelayed(queueRunnable, EVEN_HUB_QUEUE_TICK_MS)
    }

    private fun stopHeartbeats() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
        devSettingsHeartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        devSettingsHeartbeatRunnable = null
        evenHubQueueRunnable?.let { mainHandler.removeCallbacks(it) }
        evenHubQueueRunnable = null
        pendingTextMsg = null
        lastEvenHubMsg = null
        lastEvenHubResendsRemaining = 0
    }

    private fun sendEvenHubHeartbeat() {
        val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            return
        }
        val msg = EvenHubProto.heartbeatMessage()
        sendEvenHubCommand(msg)

        // Poll battery every 10 heartbeats (~50 seconds)
        heartbeatCounter++
        if (heartbeatCounter % 10 == 0) {
            requestDeviceInfo()
        }
    }

    private fun sendDevSettingsHeartbeat() {
        val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            return
        }
        val msg = DevSettingsProto.baseHeartbeat(sendManager.nextMagicRandom())
        sendDevSettingsCommand(msg)
    }

    private fun requestDeviceInfo() {
        val msg = G2SettingProto.requestInfo(sendManager.nextMagicRandom())
        sendG2SettingCommand(msg)
        Bridge.log("G2: Requested device info (battery/version)")
    }

    private fun sendMenuApps() {
        val menuItems =
                GlassesStore.get("core", "menu_apps") as? List<Map<String, Any>> ?: emptyList()
        if (menuItems.isNotEmpty()) {
            setDashboardMenu(menuItems)
        }
    }

    // ---------- SGCManager: Display Control ----------

    override fun sendTextWall(text: String) {
        // Bridge.log("G2: sendTextWall(${text.take(10)}...)")

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
        currentBitmapBase64 = base64ImageData
        currentTextContent = ""
        return displayBitmapQuad(base64ImageData)
    }

    private fun displayBitmapQuad(base64ImageData: String): Boolean {
        val rawData =
                Base64.decode(base64ImageData, Base64.DEFAULT)
                        ?: run {
                            Bridge.log("G2: displayBitmapQuad() - failed to decode base64")
                            return false
                        }

        val tiles =
                renderAndSliceTo4Tiles(rawData)
                        ?: run {
                            Bridge.log(
                                    "G2: displayBitmapQuad() - failed to slice image into tiles"
                            )
                            return false
                        }

        // 2x2 grid of 200x100 tiles covering 400x200 (matches G2.swift:1729-1745)
        val container1 =
                EvenHubProto.imageContainerProperty(
                        x = 0,
                        y = 0,
                        width = 200,
                        height = 100,
                        containerID = 10,
                        containerName = "img-10"
                )
        val container2 =
                EvenHubProto.imageContainerProperty(
                        x = 200,
                        y = 0,
                        width = 200,
                        height = 100,
                        containerID = 11,
                        containerName = "img-11"
                )
        val container3 =
                EvenHubProto.imageContainerProperty(
                        x = 0,
                        y = 100,
                        width = 200,
                        height = 100,
                        containerID = 12,
                        containerName = "img-12"
                )
        val container4 =
                EvenHubProto.imageContainerProperty(
                        x = 200,
                        y = 100,
                        width = 200,
                        height = 100,
                        containerID = 13,
                        containerName = "img-13"
                )
        val containers = listOf(container1, container2, container3, container4)

        val msg: ByteArray =
                if (!startupPageCreated) {
                    startupPageCreated = true
                    EvenHubProto.createPageMessage(
                            imageContainers = containers,
                            magicRandom = sendManager.nextMagicRandom(),
                            appId = activeMenuAppId
                    )
                } else {
                    EvenHubProto.rebuildPageMessage(
                            imageContainers = containers,
                            magicRandom = sendManager.nextMagicRandom(),
                            appId = activeMenuAppId
                    )
                }
        sendEvenHubCommand(msg)
        pageCreated = true
        pageHasTextContainer = false
        currentTextContent = ""

        // After the 1s settle delay iOS waits, send each tile's BMP in series. Android's
        // displayBitmap signature is synchronous Boolean, so this is fire-and-forget — we
        // chain tiles via callbacks rather than awaiting like iOS.
        Bridge.log("G2: displayBitmapQuad() - page sent, scheduling fragment send in 1s...")
        mainHandler.postDelayed(
                {
                    sendImageDataChained(
                            tiles =
                                    listOf(
                                            Triple(10, "img-10", tiles[0]),
                                            Triple(11, "img-11", tiles[1]),
                                            Triple(12, "img-12", tiles[2]),
                                            Triple(13, "img-13", tiles[3])
                                    ),
                            index = 0
                    )
                },
                1000
        )

        return true
    }

    /** Send the next tile's BMP in series; recurse to the next tile after this one finishes. */
    private fun sendImageDataChained(
            tiles: List<Triple<Int, String, ByteArray>>,
            index: Int
    ) {
        if (index >= tiles.size) return
        val (containerID, containerName, bmpData) = tiles[index]
        sendImageData(containerID, containerName, bmpData) {
            sendImageDataChained(tiles, index + 1)
        }
    }

    private fun sendImageData(
            containerID: Int,
            containerName: String,
            bmpData: ByteArray,
            onComplete: (() -> Unit)? = null
    ) {
        val fragmentSize = 4096
        imageSessionCounter++
        val sessionId = imageSessionCounter
        val totalSize = bmpData.size
        var fragmentIndex = 0
        var offset = 0

        fun sendNextFragment() {
            if (offset >= bmpData.size) {
                Bridge.log(
                        "G2: sendImageData($containerName) - $fragmentIndex fragments, ${bmpData.size} bytes"
                )
                onComplete?.invoke()
                return
            }

            val end = minOf(offset + fragmentSize, bmpData.size)
            val fragment = bmpData.copyOfRange(offset, end)

            val msg =
                    EvenHubProto.updateImageRawDataMessage(
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
            Bridge.log("G2: sendImageData($containerName) - sent fragment $fragmentIndex")

            fragmentIndex++
            offset = end

            // 200ms between fragments — and also before onComplete, so the next tile in
            // sendImageDataChained gets the same gap before its first fragment (matches iOS,
            // which awaits 200ms after every fragment including the last).
            if (offset < bmpData.size) {
                mainHandler.postDelayed({ sendNextFragment() }, 200)
            } else {
                Bridge.log(
                        "G2: sendImageData($containerName) - $fragmentIndex fragments, ${bmpData.size} bytes"
                )
                mainHandler.postDelayed({ onComplete?.invoke() }, 200)
            }
        }

        sendNextFragment()
    }

    /**
     * Render any image to 400x200 grayscale, then slice into 4 tiles (200x100 each).
     * Returns 4 BMP ByteArrays: [top-left, top-right, bottom-left, bottom-right].
     * Mirrors G2.swift renderAndSliceTo4Tiles.
     */
    private fun renderAndSliceTo4Tiles(data: ByteArray): List<ByteArray>? {
        val srcBitmap =
                BitmapFactory.decodeByteArray(data, 0, data.size)
                        ?: run {
                            Bridge.log("G2: renderAndSliceTo4Tiles - could not decode image")
                            return null
                        }

        val srcWidth = srcBitmap.width
        val srcHeight = srcBitmap.height
        val tileWidth = 200
        val tileHeight = 100
        val totalW = tileWidth * 2 // 400
        val totalH = tileHeight * 2 // 200

        // Scale source to fit within 400x200 (maintain aspect ratio)
        val scale = minOf(totalW.toDouble() / srcWidth, totalH.toDouble() / srcHeight)
        val scaledW = maxOf(1, (srcWidth * scale).toInt())
        val scaledH = maxOf(1, (srcHeight * scale).toInt())
        val offsetX = (totalW - scaledW) / 2
        val offsetY = (totalH - scaledH) / 2

        Bridge.log(
                "G2: renderAndSliceTo4Tiles - input ${srcWidth}x${srcHeight} → ${scaledW}x${scaledH} in ${totalW}x${totalH}"
        )

        // Render to 400x200 with black background
        val destBitmap = Bitmap.createBitmap(totalW, totalH, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(destBitmap)
        canvas.drawColor(Color.BLACK)
        val srcRect = Rect(0, 0, srcWidth, srcHeight)
        val dstRect = Rect(offsetX, offsetY, offsetX + scaledW, offsetY + scaledH)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(srcBitmap, srcRect, dstRect, paint)
        srcBitmap.recycle()

        // Pull a single 400x200 grayscale buffer once; slice each tile from it
        val fullPixels = ByteArray(totalW * totalH)
        val argbRow = IntArray(totalW)
        for (y in 0 until totalH) {
            destBitmap.getPixels(argbRow, 0, totalW, 0, y, totalW, 1)
            val rowOffset = y * totalW
            for (x in 0 until totalW) {
                val pixel = argbRow[x]
                val r = (pixel shr 16) and 0xFF
                val g = (pixel shr 8) and 0xFF
                val b = pixel and 0xFF
                fullPixels[rowOffset + x] = ((r * 299 + g * 587 + b * 114) / 1000).toByte()
            }
        }
        destBitmap.recycle()

        // Slice into 4 tiles: top-left, top-right, bottom-left, bottom-right (matches iOS order)
        val tileOrigins = listOf(0 to 0, tileWidth to 0, 0 to tileHeight, tileWidth to tileHeight)
        val tiles = mutableListOf<ByteArray>()
        for ((ox, oy) in tileOrigins) {
            val tilePixels = ByteArray(tileWidth * tileHeight)
            for (row in 0 until tileHeight) {
                val srcRowStart = (oy + row) * totalW + ox
                System.arraycopy(
                        fullPixels,
                        srcRowStart,
                        tilePixels,
                        row * tileWidth,
                        tileWidth
                )
            }
            val bmp =
                    build4BitBmp(tilePixels, tileWidth, tileHeight)
                            ?: run {
                                Bridge.log(
                                        "G2: renderAndSliceTo4Tiles - failed to build BMP for tile"
                                )
                                return null
                            }
            tiles.add(bmp)
        }
        return tiles
    }

    override fun showDashboard() {
        // G2 doesn't have a native dashboard concept via EvenHub
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("G2: setDashboardPosition(height=$height, depth=$depth)")
        setDashboardHeightOnly(height)
        setDashboardDepthOnly(depth)
    }

    override fun setDashboardHeightOnly(height: Int) {
        val clamped = height.coerceIn(0, 12)
        Bridge.log("G2: setDashboardHeightOnly($clamped)")
        val msg = G2SettingProto.setScreenHeight(sendManager.nextMagicRandom(), clamped)
        sendG2SettingCommand(msg)
    }

    override fun setDashboardDepthOnly(depth: Int) {
        val clamped = depth.coerceIn(0, 2)
        Bridge.log("G2: setDashboardDepthOnly($clamped)")
        val msg = G2SettingProto.setScreenDepth(sendManager.nextMagicRandom(), clamped)
        sendG2SettingCommand(msg)
    }

    override fun setDashboardMenu(items: List<Map<String, Any>>) {
        Bridge.log("G2: setDashboardMenu -- items: $items")
        val menuItems =
                items.mapNotNull { dict ->
                    val name = dict["name"] as? String ?: return@mapNotNull null
                    val packageName = dict["packageName"] as? String ?: return@mapNotNull null
                    val running = dict["running"] as? Boolean ?: false
                    MenuProto.MenuItem(packageName, name, running)
                }
        dashboardMenuItems.clear()
        dashboardMenuItems.addAll(menuItems)
        Bridge.log("G2: setDashboardMenu -- sending ${menuItems.size} items")
        val (msg, appIdMap) = MenuProto.sendMenuInfo(sendManager.nextMagicRandom(), menuItems)
        menuAppIdToPackageName = appIdMap.toMutableMap()
        activeMenuAppId = appIdMap.keys.sorted().firstOrNull()
        sendMenuCommand(msg)
    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("G2: setBrightness($level, auto=$autoMode)")
        val msg =
                G2SettingProto.setBrightness(
                        magicRandom = sendManager.nextMagicRandom(),
                        level = level,
                        autoAdjust = autoMode
                )
        sendG2SettingCommand(msg)
    }

    // ---------- Private Display Helpers ----------

    private fun createPageWithText(text: String) {
        val tc =
                EvenHubProto.textContainerProperty(
                        x = 0,
                        y = 0,
                        width = 576,
                        height = 288,
                        borderWidth = 0,
                        borderColor = 0,
                        borderRadius = 0,
                        paddingLength = 4,
                        containerID = textContainerID,
                        containerName = "text-main",
                        isEventCapture = true,
                        content = text
                )

        val msg: ByteArray
        if (!startupPageCreated) {
            Bridge.log("G2: createPageWithText - using createPageMessage (first time)")
            msg =
                    EvenHubProto.createPageMessage(
                            textContainers = listOf(tc),
                            magicRandom = sendManager.nextMagicRandom(),
                            appId = activeMenuAppId
                    )
            startupPageCreated = true
        } else {
            Bridge.log("G2: createPageWithText - using rebuildPageMessage")
            msg =
                    EvenHubProto.rebuildPageMessage(
                            textContainers = listOf(tc),
                            magicRandom = sendManager.nextMagicRandom(),
                            appId = activeMenuAppId
                    )
        }
        sendEvenHubCommand(msg)
        pageCreated = true
        pageHasTextContainer = true
        currentTextContent = text
        currentBitmapBase64 = ""
    }

    private fun updateText(text: String) {
        val msg =
                EvenHubProto.updateTextMessage(
                        containerID = textContainerID,
                        contentOffset = 0,
                        contentLength = text.toByteArray(Charsets.UTF_8).size,
                        content = text
                )
        queueEvenHubCommand(msg)
        currentTextContent = text
        currentBitmapBase64 = ""
    }

    @Synchronized
    private fun queueEvenHubCommand(payload: ByteArray) {
        pendingTextMsg = payload
    }

    @Synchronized
    private fun drainEvenHubQueue() {
        val msg = pendingTextMsg
        pendingTextMsg = null
        val toSend: ByteArray? = if (msg != null) {
            lastEvenHubMsg = msg
            lastEvenHubResendsRemaining = EVEN_HUB_RESEND_COUNT
            msg
        } else if (lastEvenHubResendsRemaining > 0 && lastEvenHubMsg != null) {
            lastEvenHubResendsRemaining -= 1
            lastEvenHubMsg
        } else {
            null
        }
        toSend?.let { sendEvenHubCommand(it) }
    }

    // ---------- Bitmap Conversion ----------

    private fun convertToG2Bmp(
            data: ByteArray,
            containerWidth: Int,
            containerHeight: Int
    ): ByteArray? {
        val srcBitmap =
                BitmapFactory.decodeByteArray(data, 0, data.size)
                        ?: run {
                            Bridge.log("G2: convertToG2Bmp - could not decode image")
                            return null
                        }

        val srcWidth = srcBitmap.width
        val srcHeight = srcBitmap.height

        // Scale to fit within container (maintain aspect ratio)
        val scale =
                minOf(containerWidth.toDouble() / srcWidth, containerHeight.toDouble() / srcHeight)
        val scaledW = maxOf(1, (srcWidth * scale).toInt())
        val scaledH = maxOf(1, (srcHeight * scale).toInt())
        val offsetX = (containerWidth - scaledW) / 2
        val offsetY = (containerHeight - scaledH) / 2

        Bridge.log(
                "G2: convertToG2Bmp - input ${srcWidth}x${srcHeight} → scaled ${scaledW}x${scaledH} in ${containerWidth}x${containerHeight}"
        )

        // Render to container-sized bitmap with black background
        val destBitmap =
                Bitmap.createBitmap(containerWidth, containerHeight, Bitmap.Config.ARGB_8888)
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
        bmp.write(0x42)
        bmp.write(0x4D) // "BM"
        writeLittleEndianInt(bmp, fileSize)
        writeLittleEndianShort(bmp, 0) // Reserved1
        writeLittleEndianShort(bmp, 0) // Reserved2
        writeLittleEndianInt(bmp, headerSize) // Pixel data offset

        // --- DIB Header (BITMAPINFOHEADER, 40 bytes) ---
        writeLittleEndianInt(bmp, 40) // DIB header size
        writeLittleEndianInt(bmp, width) // Width
        writeLittleEndianInt(bmp, height) // Height (positive = bottom-up)
        writeLittleEndianShort(bmp, 1) // Color planes
        writeLittleEndianShort(bmp, 4) // Bits per pixel (4-bit)
        writeLittleEndianInt(bmp, 0) // Compression (none)
        writeLittleEndianInt(bmp, pixelDataSize) // Image size
        writeLittleEndianInt(bmp, 2835) // X pixels/meter (~72 DPI)
        writeLittleEndianInt(bmp, 2835) // Y pixels/meter
        writeLittleEndianInt(bmp, 16) // Colors used
        writeLittleEndianInt(bmp, 0) // Important colors (0 = all)

        // --- Color Table (16 entries, 4 bytes each: B, G, R, 0) ---
        for (i in 0 until 16) {
            val v = i * 17 // 0, 17, 34, ... 255
            bmp.write(v)
            bmp.write(v)
            bmp.write(v)
            bmp.write(0) // B, G, R, Reserved
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

        Bridge.log(
                "G2: build4BitBmp - ${bmp.size()} bytes (header=$headerSize, pixels=$pixelDataSize, rows=${paddedRowSize}x$height)"
        )
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
        val currentEnabled = GlassesStore.get("glasses", "micEnabled") as? Boolean ?: false
        
        // if already enabled, set to disabled, then send enabled after 500ms:
        if (currentEnabled && enabled) {
            GlassesStore.apply("glasses", "micEnabled", true)
            val msg = EvenHubProto.audioControlMessage(false)
            sendEvenHubCommand(msg)
            mainHandler.postDelayed({
                val msg = EvenHubProto.audioControlMessage(true)
                sendEvenHubCommand(msg)
            }, 500)
            return
        }
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

    override fun startVideoRecording(
            requestId: String,
            save: Boolean,
            flash: Boolean,
            sound: Boolean
    ) {
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
        DEVICE_SEARCH_ID = id
        startScan()
        startPairingTimeout()
    }

    private fun startPairingTimeout() {
        pairingTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        val work = Runnable {
            if (leftGatt != null && rightGatt == null) {
                Bridge.log("G2: pairing timeout — found LEFT but not RIGHT")
                Bridge.sendPairFailureEvent("errors:pairNeedDisconnect")
            }
        }
        pairingTimeoutRunnable = work
        mainHandler.postDelayed(work, 10_000)
    }

    private fun cancelPairingTimeout() {
        pairingTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        pairingTimeoutRunnable = null
    }

    override fun disconnect() {
        Bridge.log("G2: disconnect()")
        isDisconnecting = true
        cancelPairingTimeout()
        stopScan()
        stopHeartbeats()
        reconnectionManager.stop()

        leftGatt?.disconnect()
        leftGatt?.close()
        rightGatt?.disconnect()
        rightGatt?.close()

        leftInitialized = false
        rightInitialized = false
        authStarted = false
        leftAuthenticated = false
        rightAuthenticated = false
        startupPageCreated = false
        pageCreated = false
        pageHasTextContainer = false
        heartbeatCounter = 0
        currentBitmapBase64 = ""
        menuAppIdToPackageName.clear()
        activeMenuAppId = null
        lastClickTimestamp = null
        lastMenuSelectTimestamp = null
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
        dashboardMenuItems.clear()
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

    override fun dbg1() {
        connectController()
    }
    override fun dbg2() {
        disconnectController()
    }

    fun reconnectController() {
        val mac = GlassesStore.get("glasses", "controllerMacAddress") as? String
        if (mac.isNullOrEmpty()) {
            Bridge.log("G2: reconnectController - no MAC address found")
            return
        }
        connectController()
    }

    override fun connectController() {
        val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            Bridge.log("G2: connectController - g2 not fully booted, ignoring")
            return
        }
        val mac = GlassesStore.get("glasses", "controllerMacAddress") as? String
        if (mac.isNullOrEmpty()) {
            Bridge.log("G2: connectController - no MAC address found")
            return
        }
        val hexParts = mac.split(":").mapNotNull { it.toIntOrNull(16)?.toByte() }
        if (hexParts.size != 6) {
            Bridge.log("G2: connectController - invalid MAC format: $mac")
            return
        }
        Bridge.log("G2: connectController() - MAC: $mac")
        val macData = hexParts.toByteArray()
        val msg = DevSettingsProto.ringConnectInfo(sendManager.nextMagicRandom(), true, macData)
        sendDevSettingsCommand(msg)
        Bridge.log("G2: Sent RING_CONNECT_INFO for MAC $mac")
    }

    override fun disconnectController() {
        val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            Bridge.log("G2: disconnectController - g2 not fully booted, ignoring")
            return
        }
        val mac = GlassesStore.get("glasses", "controllerMacAddress") as? String
        if (mac.isNullOrEmpty()) {
            Bridge.log("G2: disconnectController - no MAC address found")
            return
        }
        val hexParts = mac.split(":").mapNotNull { it.toIntOrNull(16)?.toByte() }
        if (hexParts.size != 6) {
            Bridge.log("G2: disconnectController - invalid MAC format: $mac")
            return
        }
        val macData = hexParts.toByteArray()
        val msg = DevSettingsProto.ringConnectInfo(sendManager.nextMagicRandom(), false, macData)
        sendDevSettingsCommand(msg)
        // GlassesStore.apply("glasses", "controllerMacAddress", "")
        GlassesStore.apply("glasses", "controllerConnected", false)
        GlassesStore.apply("glasses", "controllerFullyBooted", false)
        Bridge.log("G2: Sent RING_DISCONNECT_INFO for MAC $mac")
    }

    // ---------- SGCManager: Device Control ----------

    override fun setHeadUpAngle(angle: Int) {
        val clamped = angle.coerceIn(0, 60)
        Bridge.log("G2: setHeadUpAngle($clamped)")

        // Enable head-up display
        val enableMsg = G2SettingProto.setHeadUpSwitch(sendManager.nextMagicRandom(), true)
        sendG2SettingCommand(enableMsg)

        // Set the angle
        val angleMsg = G2SettingProto.setHeadUpAngle(sendManager.nextMagicRandom(), clamped)
        sendG2SettingCommand(angleMsg)
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

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}

    // ---------- BLE Scanning ----------

    private fun startScan(): Boolean {
        Bridge.log("G2: startScan()")

        stopScan()

        val adapter =
                bluetoothAdapter
                        ?: run {
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

        val scanner =
                adapter.bluetoothLeScanner
                        ?: run {
                            Bridge.log("G2: BluetoothLeScanner not available")
                            return false
                        }

        val settings =
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()

        val callback =
                object : ScanCallback() {
                    override fun onScanResult(callbackType: Int, result: ScanResult?) {
                        result ?: return
                        val device = result.device ?: return
                        val name = device.name ?: return

                        if (!name.contains("G2")) return

                        mainHandler.post {
                            // Extract serial number from manufacturer data (like iOS)
                            val serialNumber = extractSNFromScanRecord(result)
                            if (serialNumber == null) {
                                Bridge.log("G2: Discovered: $name but no SN in mfg data")
                                return@post
                            }

                            val mfgFirst = result.scanRecord?.manufacturerSpecificData?.valueAt(0)
                            val mfgHex =
                                    mfgFirst?.joinToString(" ") { String.format("%02X", it) }
                                            ?: "none"
                            Bridge.log(
                                    "G2: Discovered: $name (SN: $serialNumber) mfgData[${mfgFirst?.size ?: 0}]: $mfgHex"
                            )
                            deviceNameToSerialNumber[name] = serialNumber

                            // Save MAC per side; ring's advStart needs the left lens MAC.
                            val mac = extractMacFromScanRecord(result)
                            if (mac != null) {
                                if (name.contains("_L_")) {
                                    GlassesStore.apply("glasses", "leftMacAddress", mac)
                                    GlassesStore.apply("glasses", "btMacAddress", mac)
                                } else if (name.contains("_R_")) {
                                    GlassesStore.apply("glasses", "rightMacAddress", mac)
                                }
                            }
                            // Stop scanning once we have both
                            if (leftGatt != null && rightGatt != null) {
                                stopScan()
                                Bridge.log("G2: Stopped scan after discovering both devices")
                                return@post
                            }

                            // Always emit discovered device to frontend
                            emitDiscoveredDevice(serialNumber)

                            // If scan-only mode, don't auto-connect
                            if (DEVICE_SEARCH_ID == "NOT_SET") return@post

                            // Only connect to devices matching our search ID
                            if (!serialNumber.contains(DEVICE_SEARCH_ID)) return@post

                            if (name.contains("_L_")) {
                                if (leftGatt == null) {
                                    Bridge.log("G2: Connecting to LEFT: $name")
                                    leftGatt = device.connectGatt(context, false, leftGattCallback)
                                }
                            } else if (name.contains("_R_")) {
                                if (rightGatt == null) {
                                    Bridge.log("G2: Connecting to RIGHT: $name")
                                    rightGatt =
                                            device.connectGatt(context, false, rightGattCallback)
                                }
                            }

                            // Stop scanning once we have both
                            if (leftGatt != null && rightGatt != null) {
                                stopScan()
                                cancelPairingTimeout()
                                Bridge.log("G2: Stopped scan after discovering both devices2")
                            }
                        }
                    }

                    override fun onScanFailed(errorCode: Int) {
                        Bridge.log("G2: Scan failed with error code: $errorCode")
                    }
                }

        scanCallback = callback
        try {
            scanner.startScan(null, settings, callback)
        } catch (e: SecurityException) {
            // Auto-reconnect paths may fire before BLUETOOTH_SCAN is granted on Android 12+
            Bridge.log("G2: startScan SecurityException — bluetooth permission missing: ${e.message}")
            scanCallback = null
            return false
        } catch (e: Exception) {
            Bridge.log("G2: startScan failed: ${e.message}")
            scanCallback = null
            return false
        }
        return true
    }

    private fun stopScan() {
        scanCallback?.let { cb -> bluetoothAdapter?.bluetoothLeScanner?.stopScan(cb) }
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

            Bridge.log(
                    "G2: connectByAddress - left: ${leftDevice.name ?: leftAddr}, right: ${rightDevice.name ?: rightAddr}"
            )

            leftGatt = leftDevice.connectGatt(context, false, leftGattCallback)
            rightGatt = rightDevice.connectGatt(context, false, rightGattCallback)
            return true
        } catch (e: Exception) {
            Bridge.log("G2: connectByAddress failed: ${e.message}")
            return false
        }
    }

    /**
     * Extract serial number from BLE scan record manufacturer data. The SN is embedded in the
     * manufacturer-specific data payload. iOS: skip 2 bytes ("ER" prefix), read 14 bytes of ASCII
     * SN. Android: same approach on the manufacturer-specific data bytes.
     */
    private fun extractSNFromScanRecord(result: ScanResult): String? {
        val scanRecord = result.scanRecord ?: return null

        // Get manufacturer-specific data
        // Android strips the 2-byte company ID (0x4552 = "ER"), so the SN starts at offset 0.
        // iOS keeps the "ER" prefix so it skips 2 bytes — we don't need to skip on Android.
        val mfgData = scanRecord.manufacturerSpecificData
        if (mfgData == null || mfgData.size() == 0) return null

        val data = mfgData.valueAt(0) ?: return null
        if (data.size < 14) return null

        // Read 14 bytes of ASCII SN starting at offset 0
        val snBytes = data.copyOfRange(0, minOf(14, data.size))
        val sn =
                String(snBytes, Charsets.US_ASCII)
                        .replace(Regex("[\\x00-\\x1F\\x7F]"), "") // Strip control chars
        return if (sn.isNotEmpty()) sn else null
    }

    /**
     * Extract the BLE MAC from the G2 scan record manufacturer data. Layout (after Android strips
     * the 2-byte company ID): SN(14) + MAC(6, little-endian) + flag(1) Returns "AA:BB:CC:DD:EE:FF"
     * (big-endian, colon-separated).
     */
    private fun extractMacFromScanRecord(result: ScanResult): String? {
        val scanRecord = result.scanRecord ?: return null
        val mfgData = scanRecord.manufacturerSpecificData
        if (mfgData == null || mfgData.size() == 0) return null
        val data = mfgData.valueAt(0) ?: return null
        if (data.size < 20) return null
        val macLE = data.copyOfRange(14, 20)
        return macLE.reversed().joinToString(":") { String.format("%02X", it.toInt() and 0xFF) }
    }

    private fun emitDiscoveredDevice(serialNumber: String) {
        Bridge.sendDiscoveredDevice(DeviceTypes.G2, serialNumber)
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

                        // Request a larger MTU so 200-byte audio notifications aren't fragmented.
                        // Default ATT MTU is 23 → max payload 20 bytes, which would chop each audio
                        // chunk into 10+ pieces. We ask for 247 (max for BLE 4.2+ data length ext).
                        // discoverServices is deferred to onMtuChanged so the larger MTU is in
                        // effect for the rest of the setup.
                        val mtuRequested =
                                try {
                                    gatt.requestMtu(247)
                                } catch (e: SecurityException) {
                                    Bridge.log(
                                            "G2: requestMtu SecurityException on $side: ${e.message}"
                                    )
                                    false
                                }
                        if (!mtuRequested) {
                            Bridge.log(
                                    "G2: requestMtu returned false on $side, proceeding without MTU bump"
                            )
                            gatt.discoverServices()
                        }

                        // Ask for high connection priority so the link can sustain 16 kHz / 10 ms
                        // audio without dropped notifications. Caller is responsible for dropping
                        // back to BALANCED later if power becomes a concern.
                        try {
                            gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                        } catch (e: SecurityException) {
                            Bridge.log(
                                    "G2: requestConnectionPriority SecurityException on $side: ${e.message}"
                            )
                        }
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
                        leftAuthenticated = false
                        rightAuthenticated = false

                        startupPageCreated = false
                        pageCreated = false
                        pageHasTextContainer = false
                        GlassesStore.apply("glasses", "connected", false)
                        GlassesStore.apply("glasses", "fullyBooted", false)

                        startReconnectionTimer()
                    }
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                Bridge.log("G2: onMtuChanged $side mtu=$mtu status=$status")
                mainHandler.post {
                    // discoverServices was deferred until MTU negotiation finishes (success or
                    // not).
                    try {
                        gatt.discoverServices()
                    } catch (e: SecurityException) {
                        Bridge.log("G2: discoverServices SecurityException on $side: ${e.message}")
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
                            if (props and BluetoothGattCharacteristic.PROPERTY_READ != 0)
                                    propStr.add("read")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE != 0)
                                    propStr.add("write")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE !=
                                            0
                            )
                                    propStr.add("writeNoResp")
                            if (props and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0)
                                    propStr.add("notify")
                            if (props and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
                                    propStr.add("indicate")
                            Bridge.log("G2: $side char $uuid props=[${propStr.joinToString(",")}]")

                            when (uuid) {
                                G2BLE.CHAR_WRITE -> {
                                    Bridge.log("G2: Found WRITE char on $side")
                                    if (side == "LEFT") leftWriteChar = char
                                    else rightWriteChar = char
                                }
                                G2BLE.CHAR_NOTIFY -> {
                                    Bridge.log("G2: Found NOTIFY char on $side")
                                    if (side == "LEFT") leftNotifyChar = char
                                    else rightNotifyChar = char
                                    enqueueGattOp { enableNotifications(gatt, char) }
                                }
                                G2BLE.AUDIO_NOTIFY -> {
                                    Bridge.log("G2: Found AUDIO char on $side")
                                    if (side == "LEFT") leftAudioChar = char
                                    else rightAudioChar = char
                                    enqueueGattOp { enableNotifications(gatt, char) }
                                }
                            }
                        }
                    }

                    // Check if this side is fully initialized
                    if (side == "LEFT" && leftWriteChar != null) {
                        leftInitialized = true
                        Bridge.log("G2: LEFT initialized")
                    } else if (side == "RIGHT" && rightWriteChar != null && rightNotifyChar != null
                    ) {
                        rightInitialized = true
                        Bridge.log("G2: RIGHT initialized")
                    }

                    // Both sides ready -> run auth (once)
                    if (leftInitialized && rightInitialized && !authStarted) {
                        // stop scanning
                        stopScan()
                        authStarted = true
                        Bridge.log("G2: Both sides initialized, starting auth sequence")
                        runAuthSequence()
                    }
                }
            }

            @Deprecated("Deprecated in API level 33")
            override fun onCharacteristicChanged(
                    gatt: BluetoothGatt,
                    characteristic: BluetoothGattCharacteristic
            ) {
                val data = characteristic.value ?: return

                val sourceKey = if (side == "LEFT") "L" else "R"
                when (characteristic.uuid) {
                    G2BLE.AUDIO_NOTIFY -> handleAudioData(data, sourceKey)
                    G2BLE.CHAR_NOTIFY -> mainHandler.post { handleNotifyData(data, sourceKey) }
                }
            }

            override fun onDescriptorWrite(
                    gatt: BluetoothGatt,
                    descriptor: BluetoothGattDescriptor,
                    status: Int
            ) {
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
    private fun enableNotifications(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
    ) {
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

    private fun handleNotifyData(data: ByteArray, sourceKey: String) {
        val result = receiveManager.handlePacket(data, sourceKey) ?: return

        val serviceId = result.first
        val payload = result.second

        when (serviceId) {
            ServiceID.EVEN_HUB.value -> handleEvenHubResponse(payload)
            ServiceID.DEVICE_SETTINGS.value -> handleDevSettingsResponse(payload, sourceKey)
            ServiceID.G2_SETTING.value -> handleG2SettingResponse(payload)
            ServiceID.MENU.value -> handleMenuResponse(payload)
            ServiceID.DASHBOARD.value -> handleDashboardResponse(payload)
            ServiceID.GESTURE_CTRL.value -> handleGestureCtrl(payload)
            ServiceID.EVEN_HUB_CTRL.value -> handleEvenHubCtrlResponse(payload)
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

        val cmdValue =
                fields[1] as? Int
                        ?: run {
                            Bridge.log(
                                    "G2: EvenHub response - no cmd field, ${payload.size} bytes: ${
                    payload.joinToString("") { String.format("%02X", it) }
                }"
                            )
                            return
                        }

        if (cmdValue == EvenHubResponseCmd.OS_NOTIFY_EVENT_TO_APP.value) {
            // Touch/gesture event from glasses
            val devEventData = fields[13] as? ByteArray ?: return
            val timestamp = System.currentTimeMillis()
            val last = lastClickTimestamp
            if (last != null && timestamp - last < 250) {
                return
            }
            lastClickTimestamp = timestamp
            handleTouchEvent(devEventData)
        } else if (cmdValue == 17) {
            // Miniapp selection from glasses dashboard menu (cmdId=17)
            // Dedup: L and R peripherals both deliver this event, so debounce or
            // MantleManager toggles start→stop in quick succession.
            val timestamp = System.currentTimeMillis()
            val lastMenu = lastMenuSelectTimestamp
            if (lastMenu != null && timestamp - lastMenu < 500) {
                return
            }
            lastMenuSelectTimestamp = timestamp
            // field 20 contains sub-message with field 1 = itemAppId
            val selectData = fields[20] as? ByteArray ?: return
            val selectReader = ProtobufReader(selectData)
            val selectFields = selectReader.parseFields()
            val appId = selectFields[1] as? Int ?: return
            // Resolve appId → packageName using our stored mapping
            val packageName = menuAppIdToPackageName[appId]
            if (packageName != null) {
                Bridge.log("G2: Menu miniapp selected — $packageName")
                Bridge.sendMiniappSelected(packageName)
                mainHandler.postDelayed({ clearDisplay() }, 500)
            } else {
                Bridge.log("G2: Menu selection ignored — placeholder or unknown appId=$appId")
            }
        } else {
            // Parse error codes from responses
            // field 4 = StartupResCmd, field 6 = ImgResCmd, field 8 = RebuildResCmd, field 10 =
            // TextResCmd
            for (resField in listOf(4, 6, 8, 10)) {
                val resData = fields[resField] as? ByteArray ?: continue
                val resReader = ProtobufReader(resData)
                val resFields = resReader.parseFields()
                (resFields[1] as? Int)?.let { errorCode ->
                    // 0=page_success, 4=img_success, 5=img_failed, 6=rebuild_success,
                    // 7=rebuild_failed, 8=text_success, 9=text_failed
                    if (errorCode == 9) {
                        Bridge.log(
                                "G2: WARN: Glasses shutdown our EvenHub page — resetting page state"
                        )
                        startupPageCreated = false
                        pageCreated = false
                        pageHasTextContainer = false
                        currentTextContent = ""
                    }
                }
                (resFields[8] as? Int)?.let { errorCode ->
                    // ImgResCmd has ErrorCode in field 8
                    Bridge.log("G2: EvenHub ImgRes errorCode=$errorCode")
                }
            }

            // If glasses sent a shutdown (cmd=9/10), our page is gone — reset state
            if (cmdValue == 9 || cmdValue == 10) {
                Bridge.log("G2: ERROR: Glasses shutdown our EvenHub page — resetting page state")
                startupPageCreated = false
                pageCreated = false
                pageHasTextContainer = false
                currentTextContent = ""
            }
        }
    }

    private fun setFullyConnected() {
        val isFullyConnected = GlassesStore.get("glasses", "connected") as? Boolean ?: false
        val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyConnected) {
            GlassesStore.apply("glasses", "connected", true)
        }
        if (!isFullyBooted) {
            GlassesStore.apply("glasses", "fullyBooted", true)
        }
    }

    private fun setControllerFullyConnected() {
        val isControllerConnected =
                GlassesStore.get("glasses", "controllerConnected") as? Boolean ?: false
        val isControllerFullyBooted =
                GlassesStore.get("glasses", "controllerFullyBooted") as? Boolean ?: false
        if (!isControllerConnected) {
            GlassesStore.apply("glasses", "controllerConnected", true)
        }
        if (!isControllerFullyBooted) {
            GlassesStore.apply("glasses", "controllerFullyBooted", true)
        }
    }

    private fun handleTouchEvent(devEventData: ByteArray) {
        // Parse SendDeviceEvent: field 1=ListEvent, field 2=TextEvent, field 3=SysEvent
        val reader = ProtobufReader(devEventData)
        val fields = reader.parseFields()

        val timestamp = System.currentTimeMillis()

        // if we are receiving touch events we are fully booted:
        setFullyConnected()

        // SysEvent (field 3) - system-level gestures
        (fields[3] as? ByteArray)?.let { sysData ->
            val sysReader = ProtobufReader(sysData)
            val sysFields = sysReader.parseFields()

            val normalType = sysFields[1] as? Int
            val eventType: OsEventType? =
                    if (normalType != null) OsEventType.fromInt(normalType) else OsEventType.CLICK
            val eventSource: Int? = sysFields[2] as? Int

            if (eventType == null) {
                Bridge.log("G2: unknown event type: $sysFields")
                return@let
            }

            val gestureName = mapEventTypeToGesture(eventType)
            if (gestureName == null) {
                Bridge.log("G2: no gesture mapping for $eventType $sysFields")
                return@let
            }

            Bridge.sendTouchEvent(DeviceTypes.G2, gestureName, timestamp, eventSource)
            Bridge.log("G2: SysEvent → $eventType $eventSource")

            if (eventSource == 2) {
                // controller must be connected and fully booted:
                setControllerFullyConnected()
            }

            if (eventType == OsEventType.DOUBLE_CLICK) {
                // trigger dashboard:
                val isHeadUp = GlassesStore.get("glasses", "headUp") as? Boolean ?: false
                // toggle head up:
                GlassesStore.apply("glasses", "headUp", !isHeadUp)
                // if (isHeadUp) {
                //     // clear the display after a delay:
                //     mainHandler.postDelayed({ clearDisplay() }, 500)
                // }
            }

            // System exit: glasses killed our EvenHub page (user opened menu or another app)
            // Reset page state and re-create the page to reclaim EvenHub focus
            if (eventType == OsEventType.SYSTEM_EXIT || eventType == OsEventType.ABNORMAL_EXIT) {
                startupPageCreated = false
                pageCreated = false
                pageHasTextContainer = false
                currentTextContent = ""
                currentBitmapBase64 = ""
                // Firmware kills the mic on system exit; re-arm it if it should be on
                GlassesStore.apply("glasses", "micEnabled", false)
                CoreManager.getInstance().updateMicState()
            }
            return
        }

        // TextEvent (field 2) - tap on text container
        (fields[2] as? ByteArray)?.let { textData ->
            val textReader = ProtobufReader(textData)
            val textFields = textReader.parseFields()
            val eventTypeRaw = textFields[3] as? Int ?: return@let
            val eventType = OsEventType.fromInt(eventTypeRaw) ?: return@let
            val gestureName = mapEventTypeToGesture(eventType)
            // log raw event data:
            // Bridge.log("G2: TextEvent raw data: ${textData.joinToString("") {
            // String.format("%02X", it) }}")
            // Bridge.log("G2: TextEvent fields: $textFields")

            if (gestureName == null) {
                Bridge.log("G2: no gesture mapping for $eventType $textFields")
                return@let
            }
            Bridge.sendTouchEvent(DeviceTypes.G2, gestureName, timestamp)
            Bridge.log("G2: TextEvent → $gestureName")
            return
        }

        // ListEvent (field 1) - interaction with list container (not currently handled)
    }

    private fun mapEventTypeToGesture(eventType: OsEventType): String? {
        return when (eventType) {
            OsEventType.CLICK -> "single_tap"
            OsEventType.DOUBLE_CLICK -> "double_tap"
            OsEventType.SCROLL_TOP -> "swipe_up"
            OsEventType.SCROLL_BOTTOM -> "swipe_down"
            OsEventType.FOREGROUND_ENTER -> "foreground_enter"
            OsEventType.FOREGROUND_EXIT -> "foreground_exit"
            OsEventType.SYSTEM_EXIT -> "system_exit"
            OsEventType.ABNORMAL_EXIT -> null
        }
    }

    private fun handleDevSettingsResponse(payload: ByteArray, sourceKey: String) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()
        val cmdValue = fields[1] as? Int ?: -1

        // Ignore heartbeat acks
        if (cmdValue == DevCfgCommandId.BASE_CONN_HEART_BEAT.value) return

        Bridge.log(
                "G2: DevSettings response: ${payload.take(32).joinToString(":") { String.format("%02X", it) }}"
        )

        if (cmdValue == DevCfgCommandId.AUTHENTICATION.value) {
            // DevCfgDataPackage: field 2 = magicRandom, field 3 = AuthMgr { field 1 = secAuth }
            var secAuth: Boolean? = null
            (fields[3] as? ByteArray)?.let { authData ->
                val authReader = ProtobufReader(authData)
                val authFields = authReader.parseFields()
                (authFields[1] as? Int)?.let { secAuth = (it != 0) }
            }
            val secAuthStr = secAuth?.toString() ?: "?"
            Bridge.log("G2: Authentication response: $sourceKey secAuth=$secAuthStr")
            if (secAuth == true) {
                if (sourceKey == "L") {
                    leftAuthenticated = true
                } else if (sourceKey == "R") {
                    rightAuthenticated = true
                }
                if (leftAuthenticated && rightAuthenticated) {
                    Bridge.log("G2: Both sides authenticated, setting fully booted and connected")
                    setFullyConnected()
                }
            }
        }

        // RING_CONNECT_INFO response (cmd 6)
        if (cmdValue == DevCfgCommandId.RING_CONNECT_INFO.value) {
            (fields[5] as? ByteArray)?.let { ringData ->
                val ringReader = ProtobufReader(ringData)
                val ringFields = ringReader.parseFields()

                if ((ringFields[1] as? Int ?: 0) == 1) {
                    Bridge.log("G2: Ring maybe connected?")
                    GlassesStore.apply("glasses", "controllerFullyBooted", true)
                }

                if ((ringFields[4] as? Int ?: 0) == 62) {
                    Bridge.log("G2: Ring maybe reconnected?")
                    GlassesStore.apply("glasses", "controllerFullyBooted", true)
                }

                val connStatus = ringFields[4] as? Int ?: -1
                Bridge.log("G2: Ring connection status: connStatus?=$connStatus")

                if (connStatus == 22) {
                    Bridge.log("G2: Ring disconnected")
                    GlassesStore.apply("glasses", "controllerFullyBooted", false)
                    GlassesStore.apply("glasses", "controllerSearching", true)
                    reconnectController()
                }

                if (connStatus == 8) {
                    Bridge.log("G2: Ring maybe disconnected?")
                    // GlassesStore.apply("glasses", "controllerFullyBooted", false)
                    // GlassesStore.apply("glasses", "controllerSearching", true)
                    // reconnectController()
                }
            }
        }
    }

    private fun handleMenuResponse(payload: ByteArray) {
        Bridge.log(
                "G2: menu response: ${payload.take(32).joinToString("") { String.format("%02X", it) }}"
        )
    }

    private fun handleDashboardResponse(payload: ByteArray) {
        Bridge.log(
                "G2: dashboard response: ${payload.take(32).joinToString("") { String.format("%02X", it) }}"
        )
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()
        val cmd = fields[1] as? Int ?: -1
        val magicRandom = fields[2] as? Int ?: 0

        // Parse field 6 (DashboardSendToApp) if present
        var packageId = 0
        (fields[6] as? ByteArray)?.let { f6 ->
            val subReader = ProtobufReader(f6)
            val sub = subReader.parseFields()
            packageId = sub[1] as? Int ?: 0
        }

        // cmd=3 is APP_Respond — glasses sending us info, we should respond with cmd=4
        // (APP_RECEIVE)
        if (cmd == 3) {
            val appRespW = ProtobufWriter()
            appRespW.writeInt32Field(1, packageId) // packageId
            appRespW.writeInt32Field(2, 0) // flag = APP_RECEIVED_SUCCESS

            val pkgW = ProtobufWriter()
            pkgW.writeInt32Field(1, 4) // commandId = APP_RECEIVE
            pkgW.writeInt32Field(2, magicRandom)
            pkgW.writeMessageField(5, appRespW.toByteArray()) // field5 = appRespond
            sendDashboardCommand(pkgW.toByteArray())
        }
    }

    private fun handleEvenHubCtrlResponse(payload: ByteArray) {
        Bridge.log(
                "G2: evenHubCtrl response: ${payload.take(8).joinToString("") { String.format("%02X", it) }}"
        )
    }

    private fun handleGestureCtrl(payload: ByteArray) {
        // Dashboard close detection: 08011A00 means dashboard closed
        if (payload.contentEquals(byteArrayOf(0x08, 0x01, 0x1A, 0x00))) {
            Bridge.log("G2: gesture_ctrl response: dashboard closed")
            // Re-send mic on / update mic state
            GlassesStore.apply("glasses", "micEnabled", false)
            CoreManager.getInstance().updateMicState()
            // Reset the text container
            sendTextWall(" ")
        }
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

        setFullyConnected()

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
        (fields[2] as? Int)?.let { silentMode -> Bridge.log("G2: Silent mode: ${silentMode != 0}") }
    }

    // ---------- Audio Handling ----------

    private var lastAudioFrame: ByteArray? = null

    private fun handleAudioData(data: ByteArray, sourceKey: String) {
        // Diagnostic: if BLE notifications are arriving fragmented (MTU too small), data.size
        // will be consistently < 200. Expected: ~200-byte chunks (5 × 40-byte LC3 frames).

        val usableLength = minOf(data.size, 200)
        if (usableLength < 40) return

        val audioData = data.copyOfRange(0, usableLength)
        if (lastAudioFrame?.contentEquals(audioData) == true) {
            // Bridge.log("G2: audio dup from $sourceKey: ${data.take(10).joinToString("") { String.format("%02X", it) }}")
            return
        }
        lastAudioFrame = audioData
        Bridge.log("G2: audio data from $sourceKey: ${data.take(10).joinToString("") { String.format("%02X", it) }}")
        CoreManager.getInstance().handleGlassesMicData(audioData, 40)
    }

    // ---------- Reconnection ----------

    private fun startReconnectionTimer() {
        reconnectionManager.start {
            val isFullyBooted = GlassesStore.get("glasses", "fullyBooted") as? Boolean ?: false
            if (isFullyBooted) {
                Bridge.log("G2: Already connected, stopping reconnection")
                return@start true
            }

            Bridge.log("G2: Attempting reconnection...")
            startScan()
            return@start false
        }
    }
}
