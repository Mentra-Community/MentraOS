package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.PhotoRequest
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
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.DeviceTypes
import java.io.ByteArrayOutputStream
import java.util.TimeZone
import java.util.UUID
import java.util.regex.Pattern
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

// ---------- G2 Protocol Constants ----------

private object G2BLE {
    // EvenHub BLE characteristic UUIDs (NOT the G1 UART UUIDs!)
    val CHAR_WRITE: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E5401")
    val CHAR_NOTIFY: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E5402")
    val FILE_WRITE: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E7401")
    val FILE_NOTIFY: UUID = UUID.fromString("00002760-08C2-11E1-9073-0E8AC72E7402")
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
    NOTIFICATION(0x04), // UI_FOREGROUND_NOTIFICATION_ID (the on-glasses notification centre)
    FILE_CMD(0xC4.toByte()), // Even File Service — command channel (START/DATA/RESULT_CHECK)
    FILE_DATA(0xC5.toByte()), // Even File Service — raw file bytes
    EVEN_AI(0x07), // UI_FOREGROUND_EVEN_AI_ID
    NAVIGATION(0x08), // UI_BACKGROUND_NAVIGATION_ID (compass/heading lives here)
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
    AUDIO_CONTROL(15),
    IMU_CONTROL(19) // APP_REQUEST_IMU_CTR_PACKET (confirmed via on-device brute-force)
}

// Navigation_Cmd_list from navigation.proto (service 0x08)
private enum class NavigationCmd(val value: Int) {
    APP_SEND_HEARTBEAT(0), // APP_SEND_HEARTBEAT_CMD
    APP_REQUEST_START_UP(5), // APP_REQUEST_START_UP — begin navigation/compass session
    APP_SEND_BASIC_INFO(7), // APP_SEND_BASIC_INFO
    APP_REQUEST_EXIT(12), // APP_REQUEST_EXIT
    OS_NOTIFY_EXIT(13), // OS_NOTIFY_EXIT
    OS_NOTIFY_REVIEW_CHANGED(14), // OS_NOTIFY_REVIEW_CHANGED
    OS_NOTIFY_COMPASS_CHANGED(15), // OS_NOTIFY_COMPASS_CHANGED — heading update
    OS_NOTIFY_COMPASS_CALIBRATE_START(16), // OS_NOTIFY_COMPASS_CALIBRATE_STRAT (sic)
    OS_NOTIFY_COMPASS_CALIBRATE_COMPLETE(17) // OS_NOTIFY_COMPASS_CALIBRATE_COMPLETE
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
    SYSTEM_EXIT(7),
    IMU_DATA_REPORT(8); // IMU_DATA_REPORT — Sys_ItemEvent carries imuData

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

    // ---------- IMU control ----------
    //
    // Wire format recovered by on-device brute-force (sample magnitude ≈ 1.0 g confirms
    // the decode). Shapes from even_hub_sdk@0.0.10; numeric proto tags confirmed live:
    //   EvenHub_Cmd_List IMU command = 19
    //   evenhub_main_msg_ctx ImuCtrlCmd slot = field 20
    //   ImuCtrlCmd { field 1 = IMU_ReportEn (bool), field 2 = reportFrq (pacing 100…1000) }
    //   Report path: cmd=2 (osNotifyEventToApp) → SendDeviceEvent.field13 →
    //                Sys_ItemEvent { field 1 = eventType = 8 (IMU_DATA_REPORT),
    //                                field 3 = imuData = IMU_Report_Data }
    //   IMU_Report_Data { field 1 = x, 2 = y, 3 = z } — each a 32-bit float (NOT double),
    //                     gravity-normalized (|v| ≈ 1 at rest).
    const val IMU_CTRL_SUB_FIELD = 20

    /** ImuReportPace pacing codes (protocol values, NOT literal Hz). Step 100, 100…1000. */
    const val IMU_PACE_P100 = 100
    const val IMU_PACE_P500 = 500
    const val IMU_PACE_P1000 = 1000

    /** Build an ImuCtrlCmd sub-message. */
    fun imuCtrlCmd(enable: Boolean, reportFrq: Int): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, if (enable) 1 else 0) // IMU_ReportEn
        if (enable) {
            w.writeInt32Field(2, reportFrq) // reportFrq (pacing code 100…1000)
        }
        return w.toByteArray()
    }

    /**
     * Build a full evenhub_main_msg_ctx that enables/disables IMU reporting. `reportFrq` is an
     * ImuReportPace pacing code; ignored when disabling.
     */
    fun imuControlMessage(
        enable: Boolean,
        reportFrq: Int = IMU_PACE_P100,
        magicRandom: Int = 0
    ): ByteArray {
        val imuMsg = imuCtrlCmd(enable, reportFrq)
        val w = ProtobufWriter()
        w.writeInt32Field(1, EvenHubCmd.IMU_CONTROL.value) // Cmd
        w.writeInt32Field(2, magicRandom) // MagicRandom
        w.writeMessageField(IMU_CTRL_SUB_FIELD, imuMsg) // ImuCtrlCmd slot (field 20)
        return w.toByteArray()
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

    /// DevCfgDataPackage with TIME_SYNC command.
    /// TimeSync submessage: f1 = (Unix seconds + TZ offset seconds) as Int32, no TZ field.
    /// Firmware appears to ignore the TZ field, so we pre-shift the timestamp itself
    /// to make UTC interpretation read as local. Empirically confirmed via probe variants in dbg1().
    fun timeSync(
        magicRandom: Int,
        timestampMs: Long = System.currentTimeMillis()
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.TIME_SYNC.value)
        w.writeInt32Field(2, magicRandom)

        val tsW = ProtobufWriter()
        val timestampSec = timestampMs / 1000
        val tzSec = (TimeZone.getDefault().getOffset(timestampMs) / 1000).toLong()
        tsW.writeInt32Field(1, (timestampSec + tzSec).toInt())
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
    /**
     * EvenAIDataPackage with CONFIG command to toggle Hey Even wakeword.
     * voiceSwitch: 0 = OFF, 1 = ON.
     *
     * Wire format confirmed by sniffing the official app toggling the setting:
     *   EvenAIConfig (field 13) = { f1=voiceSwitch, f2=32 }
     * The app OMITS f1 when disabling (proto3 zero) and sends f2=32 (0x20), NOT 80.
     * Observed echoes: ON  → 6A04 08 01 10 20  ({f1:1, f2:32})
     *                  OFF → 6A02 10 20         ({f2:32})
     */
    fun setHeyEven(magicRandom: Int, enabled: Boolean): ByteArray {
        // EvenAIConfig
        val configW = ProtobufWriter()
        if (enabled) {
            configW.writeInt32Field(1, 1) // voiceSwitch (omitted when off, matching the app)
        }
        configW.writeInt32Field(2, 32) // streamSpeed (always sent, app uses 32)

        // EvenAIDataPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, 10) // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(13, configW.toByteArray()) // config (field 13)
        return w.toByteArray()
    }

    /**
     * EvenAIDataPackage with CTRL — used to put glasses into / out of an AI session.
     * Mirrors Flutter `sendWakeupResp` which sends EvenAIControl{status=ENTER}.
     * status: 1 WAKE_UP, 2 ENTER, 3 EXIT
     */
    fun aiCtrl(magicRandom: Int, status: Int): ByteArray {
        val ctrlW = ProtobufWriter()
        ctrlW.writeInt32Field(1, status) // status

        val w = ProtobufWriter()
        w.writeInt32Field(1, 1) // commandId = CTRL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, ctrlW.toByteArray()) // ctrl (field 3)
        return w.toByteArray()
    }

    /**
     * EvenAIDataPackage with ASK — what the phone sends after cloud ASR resolves the
     * user's audio into text. Mirrors Flutter `sendAsr`: EvenAIAskInfo{text, streamEnable=0}.
     */
    fun aiAsk(magicRandom: Int, text: String, streamEnable: Int = 0): ByteArray {
        val askW = ProtobufWriter()
        askW.writeInt32Field(2, streamEnable) // streamEnable
        askW.writeBytesField(4, text.toByteArray(Charsets.UTF_8)) // text

        val w = ProtobufWriter()
        w.writeInt32Field(1, 3) // commandId = ASK
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(5, askW.toByteArray()) // askInfo (field 5)
        return w.toByteArray()
    }

    /**
     * EvenAIDataPackage with SKILL — triggers a built-in glasses UI the same way
     * "Hey Even, show X" voice command does.
     * skillId values (per even_ai.proto):
     *   0 SKILL_NONE, 1 BRIGHTNESS, 2 TRANSLATE_CTRL, 3 NOTIFICATION,
     *   4 TELEPROMPT, 5 NAVIGATE, 6 CONVERSATE, 7 QUICKLIST, 8 AUTO_BRIGHTNESS
     */
    fun triggerSkill(
        magicRandom: Int,
        skillId: Int,
        skillParam: Int = 0,
        text: String = "",
        streamEnable: Int = 1,
        fTextEnd: Int = 1
    ): ByteArray {
        // EvenAISkillInfo
        val skillW = ProtobufWriter()
        skillW.writeInt32Field(1, streamEnable) // streamEnable
        skillW.writeInt32Field(2, skillId) // skillId
        skillW.writeInt32Field(3, skillParam) // skillParam — for NOTIFICATION skill this is a NotificationType enum
        skillW.writeBytesField(4, text.toByteArray(Charsets.UTF_8)) // text
        skillW.writeInt32Field(6, fTextEnd) // fTextEnd — 1 signals "this is the final/complete packet"

        // EvenAIDataPackage
        val w = ProtobufWriter()
        w.writeInt32Field(1, 6) // commandId = SKILL
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(8, skillW.toByteArray()) // skillInfo (field 8)
        return w.toByteArray()
    }
}

// ---------- Notification Service (notification.proto, service ID 4) ----------

/**
 * Control plane for the on-glasses notification centre. Content does not travel here — it goes
 * over the file service below. Wire formats: `notes/g2-notification-service.md`.
 */
private object NotificationProto {
    const val CMD_CTRL = 1
    const val CMD_NOTIFICATION_IOS = 2
    const val CMD_WHITELIST_CTRL = 3
    const val CMD_WHITELIST_CHK = 4
    const val CMD_COMM_RSP = 161

    fun notificationCtrl(
        magicRandom: Int,
        notifEnable: Int = 1,
        autoDispEnable: Int = 1,
        dispTime: Int = 5,
        avoidDisturbEnable: Int = 0
    ): ByteArray {
        val ctrlW = ProtobufWriter()
        ctrlW.writeInt32Field(1, notifEnable)
        ctrlW.writeInt32Field(2, autoDispEnable)
        ctrlW.writeInt32Field(3, dispTime)
        ctrlW.writeInt32Field(5, avoidDisturbEnable)

        val w = ProtobufWriter()
        w.writeInt32Field(1, CMD_CTRL)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, ctrlW.toByteArray())
        return w.toByteArray()
    }

    /**
     * `whitelistDisable = 1` stops the glasses filtering incoming notifications against the
     * whitelist file they hold, so we can filter phone-side instead of maintaining that file.
     */
    fun whitelistCtrl(magicRandom: Int, whitelistDisable: Int): ByteArray {
        val wlW = ProtobufWriter()
        wlW.writeInt32Field(1, whitelistDisable)

        val w = ProtobufWriter()
        w.writeInt32Field(1, CMD_WHITELIST_CTRL)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(6, wlW.toByteArray())
        return w.toByteArray()
    }

    fun cmdName(cmd: Int): String =
        when (cmd) {
            CMD_CTRL -> "CTRL"
            CMD_NOTIFICATION_IOS -> "NOTIFICATION_IOS"
            CMD_WHITELIST_CTRL -> "WHITELIST_CTRL"
            CMD_WHITELIST_CHK -> "WHITELIST_CHK"
            CMD_COMM_RSP -> "COMM_RSP"
            else -> "cmd_$cmd"
        }
}

// ---------- Even File Service (service 0xC4 cmd / 0xC5 data) ----------

/**
 * The glasses' generic file-push channel, and how notification content gets across: the body is a
 * JSON document pushed as a file. Unlike every other G2 service this is **not** protobuf —
 * SEND_START is a fixed 93-byte struct and the data phase writes raw bytes.
 *
 * Each phase is acked with a 2-byte `[cid][status]`:
 *   START(fileType, length, crc32, filename) → ack → DATA → raw bytes on 0xC5 → ack
 *     → RESULT_CHECK → ack
 */
private object FileService {
    // eEvenFileSendServiceCID — first byte of every 0xC4 payload
    const val CID_SEND_START = 0
    const val CID_SEND_DATA = 1
    const val CID_SEND_RESULT_CHECK = 2

    const val TYPE_ANDROID_MSG_JSON_NOTIFICATION = 1

    // Notification bodies and the whitelist share this path: the firmware has one filename
    // constant (`BleG2GlassesFilePath.notifyWhitelist`) and discriminates on `fileType`.
    const val PATH_NOTIFY = "user/notify_whitelist.json"

    const val FILENAME_FIELD_LEN = 80
    const val SEND_START_LEN = 93 // 1 + 4 + 4 + 4 + 80

    // eEvenFileServiceRsp
    fun statusName(status: Int): String =
        when (status) {
            0 -> "SUCCESS"
            1 -> "START_ERR"
            2 -> "DATA_CRC_ERR"
            3 -> "FLASH_WRITE_ERR"
            4 -> "TIMEOUT"
            5 -> "NO_RESOURCES"
            6 -> "RESULT_CHECK_FAIL"
            7 -> "FAIL"
            8 -> "CANCEL"
            else -> "status_$status"
        }

    private fun ByteArrayOutputStream.writeU32LE(value: Int) {
        write(value and 0xFF)
        write((value ushr 8) and 0xFF)
        write((value ushr 16) and 0xFF)
        write((value ushr 24) and 0xFF)
    }

    /** 93-byte fixed struct: cid | fileType u32 | fileLength u32 | fileCrc32 u32 | filename[80]. */
    fun sendStart(fileType: Int, fileLength: Int, fileCrc32: Int, filename: String): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(CID_SEND_START)
        out.writeU32LE(fileType)
        out.writeU32LE(fileLength)
        out.writeU32LE(fileCrc32)

        val nameBytes = filename.toByteArray(Charsets.US_ASCII)
        require(nameBytes.size < FILENAME_FIELD_LEN) { "filename too long: $filename" }
        out.write(nameBytes)
        repeat(FILENAME_FIELD_LEN - nameBytes.size) { out.write(0) } // NUL-padded to 80

        return out.toByteArray().also { check(it.size == SEND_START_LEN) }
    }

    fun sendData(): ByteArray = byteArrayOf(CID_SEND_DATA.toByte())

    fun resultCheck(): ByteArray = byteArrayOf(CID_SEND_RESULT_CHECK.toByte())
}

// ---------- Notification payload JSON ----------

/**
 * The JSON document the glasses expect on the file service — these nine fields, exactly. Schema
 * confirmed against a BLE capture of the Even app; see `notes/g2-notification-service.md`.
 *
 * `time_s` is UTC epoch seconds while `date` is **device-local** wall time; formatting `date` in
 * UTC would skew every displayed timestamp by the device's offset.
 */
private object NotificationJson {
    fun androidNotification(
        msgId: Int,
        action: Int,
        appIdentifier: String,
        title: String,
        subtitle: String,
        message: String,
        postTimeMs: Long,
        displayName: String
    ): ByteArray {
        val dateFmt = java.text.SimpleDateFormat("yyyyMMdd'T'HHmmss", java.util.Locale.US)
        val body =
            org.json.JSONObject()
                .put("msg_id", msgId)
                .put("action", action)
                .put("app_identifier", appIdentifier)
                .put("title", title)
                .put("subtitle", subtitle)
                .put("message", message)
                .put("time_s", postTimeMs / 1000)
                .put("date", dateFmt.format(java.util.Date(postTimeMs)))
                .put("display_name", displayName)

        return org.json.JSONObject()
            .put("android_notification", body)
            .toString()
            .toByteArray(Charsets.UTF_8)
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

/**
 * Builders for the dashboard calendar widget (service 0x01, command Dashboard_Receive = 2).
 * Field numbers come from the extracted dashboard.proto v2.1.0_beta_v3 and mirror the iOS
 * DashboardProto.calendarPush builder so both platforms produce the same wire payload.
 */
private object CalendarProto {
    // Dashboard_Receive — phone → glasses widget/config push.
    const val DASHBOARD_RECEIVE = 2

    /**
     * Build a Schedule submessage (the calendar event payload).
     *   f1 = scheduleId (int32, required)
     *   f2 = title (string, optional)
     *   f3 = location (string, optional)
     *   f4 = time (string, optional — display text e.g. "10:00 AM")
     *   f5 = endTimestamp (int32, Unix seconds — pre-shifted by TZ so the glasses,
     *        which treat timestamps as already-local, display local time)
     */
    private fun schedule(
        scheduleId: Int,
        title: String?,
        location: String?,
        time: String?,
        endTimestamp: Int
    ): ByteArray {
        val w = ProtobufWriter()
        w.writeInt32Field(1, scheduleId)
        title?.let { w.writeStringField(2, it) }
        location?.let { w.writeStringField(3, it) }
        time?.let { w.writeStringField(4, it) }
        w.writeInt32Field(5, endTimestamp)
        return w.toByteArray()
    }

    /**
     * Build the full calendar-push DashboardDataPackage:
     *   DashboardDataPackage {
     *     commandId = Dashboard_Receive (2)
     *     magicRandom
     *     dashboardReceive = DashboardReceiveFromApp {
     *       packageId = 1
     *       bashboardConfig = DashboardContent {
     *         widgetComponents = rWidgetComponent {
     *           schedule = rScheduleWidget {
     *             scheduleTotal, scheduleNum (0-based), Schedule, scheduleAuthority
     *           }
     *         }
     *       }
     *     }
     *   }
     */
    fun calendarPush(
        magicRandom: Int,
        packageId: Int,
        scheduleId: Int,
        title: String?,
        location: String?,
        time: String?,
        endTimestamp: Int,
        scheduleAuthority: Int,
        scheduleTotal: Int,
        scheduleNum: Int
    ): ByteArray {
        val sched = schedule(scheduleId, title, location, time, endTimestamp)

        // rScheduleWidget { f1 = scheduleTotal, f2 = scheduleNum, f3 = Schedule, f4 = scheduleAuthority }
        val rSchedW = ProtobufWriter()
        rSchedW.writeInt32Field(1, scheduleTotal)
        rSchedW.writeInt32Field(2, scheduleNum)
        rSchedW.writeMessageField(3, sched)
        rSchedW.writeInt32Field(4, scheduleAuthority)

        // rWidgetComponent { f3 = rScheduleWidget }
        val rWidgetW = ProtobufWriter()
        rWidgetW.writeMessageField(3, rSchedW.toByteArray())

        // DashboardContent { f2 = rWidgetComponent }
        val contentW = ProtobufWriter()
        contentW.writeMessageField(2, rWidgetW.toByteArray())

        // DashboardReceiveFromApp { f1 = packageId, f3 = DashboardContent }
        val receiveW = ProtobufWriter()
        receiveW.writeInt32Field(1, packageId)
        receiveW.writeMessageField(3, contentW.toByteArray())

        // DashboardDataPackage { f1 = commandId, f2 = magicRandom, f4 = dashboardReceive }
        val pkgW = ProtobufWriter()
        pkgW.writeInt32Field(1, DASHBOARD_RECEIVE)
        pkgW.writeInt32Field(2, magicRandom)
        pkgW.writeMessageField(4, receiveW.toByteArray())
        return pkgW.toByteArray()
    }

    fun calendarClear(magicRandom: Int, packageId: Int, scheduleAuthority: Int): ByteArray {
        // rScheduleWidget with scheduleTotal=0 clears the widget without sending a stale Schedule.
        val rSchedW = ProtobufWriter()
        rSchedW.writeInt32Field(1, 0)
        rSchedW.writeInt32Field(2, 0)
        rSchedW.writeInt32Field(4, scheduleAuthority)

        val rWidgetW = ProtobufWriter()
        rWidgetW.writeMessageField(3, rSchedW.toByteArray())

        val contentW = ProtobufWriter()
        contentW.writeMessageField(2, rWidgetW.toByteArray())

        val receiveW = ProtobufWriter()
        receiveW.writeInt32Field(1, packageId)
        receiveW.writeMessageField(3, contentW.toByteArray())

        val pkgW = ProtobufWriter()
        pkgW.writeInt32Field(1, DASHBOARD_RECEIVE)
        pkgW.writeInt32Field(2, magicRandom)
        pkgW.writeMessageField(4, receiveW.toByteArray())
        return pkgW.toByteArray()
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

        if (resultCode != 0) {
            // Silent drops here look identical to an ack timeout at the file layer, so say so.
            val sid = serviceId.toInt() and 0xFF
            if (sid == 0xC4 || sid == 0xC5) {
                Bridge.log("G2/FILE: inbound dropped before dispatch — resultCode=$resultCode")
            }
            return null
        }

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
    // The file service has its own characteristic group (…7401/…7402), separate from the UI one,
    // and is driven over the right leg only — see [writeFilePackets].
    private var rightFileWriteChar: BluetoothGattCharacteristic? = null
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

    /** How many redundant resends each text update gets (text has no ACK). The reconcile loop sets a
     * container's [TextContainer.pendingSends] to `1 + EVEN_HUB_RESEND_COUNT` on change. */
    private val EVEN_HUB_RESEND_COUNT: Int = 1

    /** ~100ms idle-tick interval for the reconcile loop (text resends, image retries while idle). */
    private val EVEN_HUB_QUEUE_TICK_MS = 100L
    private var startupPageCreated: Boolean = false
    private var pageCreated: Boolean = false
    // Live hardware truth: is the firmware mic actually streaming. DISTINCT from the
    // glasses/micEnabled DeviceStore flag, which is *intent* (does the user want the mic on).
    // Cleared on every page teardown WITHOUT touching intent, so recovery can re-arm iff intent
    // still says the mic should be on. See the iOS G2.swift counterpart.
    private var evenHubMicActive: Boolean = false
    private var currentTextContent: String = ""
    private var textContainerID: Int = 1
    private var imageSessionCounter: Int = 0
    private var heartbeatCounter: Int = 0

    // Image-send ACK/retry: the glasses ACK EACH fragment with an ImgResCmd carrying MapSessionId
    // (field 3), MapFragmentIndex (field 6) and ErrorCode (field 8; 4=success, 5=failed). One
    // MapSessionId identifies the WHOLE image transfer (constant across its fragments) — the
    // glasses key their reassembly buffer on it — so each fragment reuses the same session id with
    // an incrementing MapFragmentIndex. We correlate a fragment's ACK by the (session,
    // fragmentIndex) pair; sendImageData() awaits it before sending the next fragment. Only one
    // transfer is ever outstanding (the reconcile loop is the sole sender of images), so a single
    // slot suffices.
    // @Volatile: written on the main thread (in sendImageData) but read/completed on the BLE
    // callback thread (in correlateImageAck) so the ACK is never delayed behind a backed-up main
    // queue. CompletableDeferred.complete() is itself thread-safe.
    @Volatile
    private var pendingImgAckSession: Int? = null

    @Volatile
    private var pendingImgAckFragment: Int? = null

    @Volatile
    private var pendingImgAck: CompletableDeferred<Boolean>? = null
    private val IMG_ACK_TIMEOUT_MS = 2000L // matches Dart host
    private val IMG_MAX_ATTEMPTS = 3
    private var authStarted: Boolean = false
    private var leftAuthenticated: Boolean = false
    private var rightAuthenticated: Boolean = false
    private var currentBitmapBase64: String = ""
    private var dashboardShowing = 0
    // The 08011A00 gesture_ctrl event is ambiguous: the firmware sends it BOTH when the dashboard
    // opens (shuts our page down to take the screen) and when it closes. showDashboard() sets this
    // latch; the next 08011A00 is the OPEN confirm — consume it WITHOUT recovering (else we rebuild
    // and snatch the screen back). The following 08011A00 is the real CLOSE → recover. See iOS.
    private var dashboardOpening = false
    // Recovery throttle (see iOS G2.swift): the firmware spams systemExit + dashboard-close
    // ~1×/sec. Coalesce so recovery can't storm — one rebuild in flight, one per RECOVERY_DEBOUNCE_MS.
    private var recoveryInFlight = false
    private var lastRecoveryRebuildMs: Long = 0
    private val RECOVERY_DEBOUNCE_MS: Long = 1500

    // Dashboard menu state
    private var menuAppIdToPackageName: MutableMap<Int, String> = mutableMapOf()
    private var dashboardMenuItems: MutableList<MenuProto.MenuItem> = mutableListOf()
    private var activeMenuAppId: Int? = null
    private var lastClickTimestamp: Long? = null
    private var lastEvenHubResponseTimestamp: Long? = null
    private var lastMenuSelectTimestamp: Long? = null
    private var lastGestureCtrlTimestamp: Long? = null

    /**
     * Owns every display mutation. Each public display entry point launches on this single-threaded
     * Main scope and only mutates container state (content / bmpData / dirty flags), never sends
     * directly. The [displayReconcileJob] background loop — also on this scope — is the sole sender,
     * so exactly one image transfer is ever in flight by construction (no lock needed; matches the
     * iOS reconcile design that replaced DisplayMutex).
     */
    private val displayScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    /** Background loop that owns ALL display sends (text + images): each pass pushes dirty text
     * containers, then dirty image containers one at a time. Display ops just mark containers dirty
     * and signal [displayDirtySignal]. */
    private var displayReconcileJob: Job? = null

    /** ~100ms ticker that nudges the reconcile loop while idle, so text resends and image retries
     * still happen with no new mutations. Just sends into [displayDirtySignal]. */
    private var displayTickJob: Job? = null

    /** Wakes the reconcile loop the instant a container is marked dirty, instead of waiting out the
     * idle tick. CONFLATED (1-deep, newest-wins) so a burst of mutations coalesces into one wake —
     * the Kotlin analogue of iOS's `AsyncStream(bufferingPolicy: .bufferingNewest(1))`. */
    private var displayDirtySignal: Channel<Unit>? = null

    /** A tracked image container on the current page. Keyed by its rect for reuse. */
    private data class ImgContainer(
        val id: Int,
        val x: Int,
        val y: Int,
        val width: Int,
        val height: Int,
        // The converted BMP cached so the container can be re-sent on a page rebuild.
        // NOTE: this ByteArray makes the auto-generated equals/hashCode unreliable, but the
        // class is only ever compared via matches()/id, so that is never relied upon.
        var bmpData: ByteArray,
        // Set true when bmpData changes and the new pixels haven't been pushed yet. The reconcile
        // loop is the sole sender; it clears this once the exact bytes it sent still match the
        // container. Lets every display op be a pure state mutation (no DisplayMutex needed).
        var dirty: Boolean = false
    ) {
        val name: String
            get() = "img-$id"

        fun matches(x: Int, y: Int, width: Int, height: Int): Boolean =
            this.x == x && this.y == y && this.width == width && this.height == height
    }

    /** A tracked text container on the current page. Keyed by its rect for reuse. */
    private data class TextContainer(
        val id: Int,
        val x: Int,
        val y: Int,
        val width: Int,
        val height: Int,
        var content: String,
        val borderWidth: Int,
        val borderColor: Int,
        val borderRadius: Int,
        val paddingLength: Int,
        // Remaining sends the reconcile loop owes this container. Text has no ACK, so each content
        // change schedules `1 + EVEN_HUB_RESEND_COUNT` sends (the update + a redundant resend on a
        // later tick) as a delivery hedge; the loop sends once and decrements per tick until 0.
        var pendingSends: Int = 0
    ) {
        val name: String
            get() = "text-$id"

        fun matches(
            x: Int,
            y: Int,
            width: Int,
            height: Int,
            borderWidth: Int,
            borderColor: Int,
            borderRadius: Int,
            paddingLength: Int
        ): Boolean =
            this.x == x &&
                this.y == y &&
                this.width == width &&
                this.height == height &&
                this.borderWidth == borderWidth &&
                this.borderColor == borderColor &&
                this.borderRadius == borderRadius &&
                this.paddingLength == paddingLength
    }

    /**
     * Live list of image containers on the page, ordered oldest→newest (for LRU eviction). The page
     * may hold at most 4 image containers (IDs from the pool below).
     */
    private val imageContainers: MutableList<ImgContainer> = mutableListOf()
    private val textContainers: MutableList<TextContainer> = mutableListOf()

    /** Fixed pool of container IDs the page protocol expects. */
    private val imageContainerIDPool: List<Int> = listOf(10, 11, 12, 13)
    private val textContainerIDPool: List<Int> = listOf(1, 2, 3, 4, 5, 6)

    /**
     * One firmware text line (hardware-calibrated 2026-07-03: 28px overflows —
     * the fw draws its overflow-indicator tick — 40px is clean). Text
     * containers are silently grown to at least this.
     */
    private val minTextContainerHeight = 40

    /** Default container seeded into every fresh page: 200x100 centered at 188,44. */
    private val defaultImgX = 188
    private val defaultImgY = 44
    private val defaultImgWidth = 200
    private val defaultImgHeight = 100

    /** Default text container: full-screen 576x288 with a 4px padding. */
    private val defaultTextX = 0
    private val defaultTextY = 0
    private val defaultTextWidth = 576
    private val defaultTextHeight = 288
    private val defaultTextBorderWidth = 0
    private val defaultTextBorderColor = 0
    private val defaultTextBorderRadius = 0
    private val defaultTextPaddingLength = 4

    // Battery state
    private var _batteryLevel: Int = -1
    private var batteryLevel_: Int
        get() = _batteryLevel
        set(value) {
            val old = _batteryLevel
            _batteryLevel = value
            if (value != old && value >= 0) {
                DeviceStore.apply("glasses", "batteryLevel", value)
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

    // Dedicated single-thread executor for pacing BLE packet bursts. We must NOT spread the burst
    // across [mainHandler]: the incoming image ACK is also delivered on the main thread, and a long
    // run of postDelayed writes (plus heartbeats and the text-queue tick) can push ACK processing
    // past IMG_ACK_TIMEOUT_MS — the glasses appear to "stop responding" even though the ACK arrived.
    // Pacing here keeps the main looper free so ACKs are processed promptly.
    private val bleWriteExecutor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "G2-ble-write").apply { isDaemon = true }
        }

    @Suppress("deprecation")
    // BGCAP diagnostic: Android G2's text path is already direct (single packet -> writeOnePacket),
    // so the iOS root cause (the canSend gate) does NOT exist here. This measures whether
    // writeCharacteristic is being REJECTED (returns false = Android GATT stack busy/throttled, the
    // packet is dropped) in the background — the suspected Android accumulation/loss point. The
    // current code discards the return value. Rate-limited; "BGCAP:" prefix; remove after the
    // Android repro pins the mechanism.
    private var bgcapWriteOk = 0
    private var bgcapWriteFail = 0
    private var bgcapWriteLogAt = 0L

    private fun bgcapNoteWriteResult(ok: Boolean) {
        if (ok) bgcapWriteOk++ else bgcapWriteFail++
        val now = android.os.SystemClock.uptimeMillis()
        if (now - bgcapWriteLogAt >= 1000) {
            if (bgcapWriteOk > 0 || bgcapWriteFail > 0) {
                Bridge.log("BGCAP: g2 writeCharacteristic ok=$bgcapWriteOk fail=$bgcapWriteFail in ${now - bgcapWriteLogAt}ms (fail = stack busy/dropped)")
            }
            bgcapWriteOk = 0
            bgcapWriteFail = 0
            bgcapWriteLogAt = now
        }
    }

    /**
     * One characteristic write. Shared by the UI path ([writeOnePacket]) and the file path
     * ([writeFilePackets]), which differ only in the characteristic pair they target. No-ops if
     * the leg isn't bound. [leg] non-null also logs the write — file transfers only; the UI path
     * is far too hot for that.
     */
    private fun writeTo(
        char: BluetoothGattCharacteristic?,
        gatt: BluetoothGatt?,
        packet: ByteArray,
        leg: String?
    ) {
        if (char == null || gatt == null) return
        char.value = packet
        char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        val ok = gatt.writeCharacteristic(char)
        bgcapNoteWriteResult(ok) // BGCAP
        if (leg != null) {
            Bridge.log("G2/FILE: write $leg ${packet.size}B -> ${if (ok) "queued" else "DROPPED (stack busy)"}")
        }
    }

    private fun writeOnePacket(packet: ByteArray, left: Boolean, right: Boolean) {
        if (right) writeTo(rightWriteChar, rightGatt, packet, null)
        if (left) writeTo(leftWriteChar, leftGatt, packet, null)
    }

    private fun sendToGlasses(
        packets: List<ByteArray>,
        left: Boolean = false,
        right: Boolean = true
    ) {
        // Bridge.log("G2: sendToGlasses() - sending ${packets.size} packets first byte: ${packets[0][0]}")
        if (packets.isEmpty()) return
        // Single-packet sends (the common case for text/settings) go straight through.
        if (packets.size == 1) {
            writeOnePacket(packets[0], left, right)
            return
        }
        // Multi-packet bursts (bitmaps, large protobufs): pace the whole burst on a dedicated
        // write thread with a blocking gap between packets, so the Android BLE stack can drain each
        // write before the next is queued WITHOUT occupying the main looper (which also carries the
        // image ACK and would otherwise starve it under load — see [bleWriteExecutor]).
        bleWriteExecutor.execute {
            for (i in packets.indices) {
                writeOnePacket(packets[i], left, right)
                if (i < packets.size - 1) {
                    try {
                        Thread.sleep(BLE_PACKET_GAP_MS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return@execute
                    }
                }
            }
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

    private fun sendNavigationCommand(payload: ByteArray) {
        val packets =
            sendManager.buildPackets(
                serviceId = ServiceID.NAVIGATION.value,
                payload = payload,
                reserveFlag = true
            )
        sendToGlasses(packets)
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

    // ---------- Even File Service ----------

    /**
     * Ack slot. One transfer is ever in flight (serialized on [fileTransferMutex]), so one slot
     * suffices. @Volatile + CompletableDeferred for the same reason as [pendingImgAck]: the ack
     * lands on the BLE callback thread.
     */
    @Volatile private var pendingFileAckCid: Int? = null

    @Volatile private var pendingFileAck: CompletableDeferred<Int>? = null
    private val fileTransferMutex = Mutex()

    /**
     * Generous on purpose. `sendToGlasses` enqueues rather than transmits, and the BLE write queue
     * routinely runs 2-5s deep under display/audio load — a tighter timeout would measure our own
     * queue latency instead of the glasses' response.
     */
    private val FILE_ACK_TIMEOUT_MS = 15000L

    /** [ServiceID.FILE_CMD] carries the phase opcodes, [ServiceID.FILE_DATA] the raw file bytes. */
    private suspend fun sendOnFileService(serviceId: Byte, payload: ByteArray) {
        // reserveFlag=false per the capture: every file frame carries status byte 0x00, where a
        // set flag stamps 0x20 (what the multi-packet dashboard frames use).
        writeFilePackets(
            sendManager.buildPackets(serviceId = serviceId, payload = payload, reserveFlag = false)
        )
    }

    /**
     * File-service writes go to the bulk-group write characteristic ([G2BLE.FILE_WRITE], ATT
     * 0x0882) — **not** the UI write characteristic every other service uses. A file opcode sent
     * to the UI characteristic is silently ignored: no ack, no error.
     *
     * Right leg only, per the capture: every 0xC4/0xC5 frame went to the right connection, with
     * ATT 0x0882/0x0884 active only there. Both legs expose the characteristic; the glasses relay
     * internally.
     *
     * Paced like [sendToGlasses] — back-to-back WRITE_TYPE_NO_RESPONSE writes in a multi-fragment
     * body get dropped as "stack busy" and read as an ack timeout. suspend + delay so the gap
     * doesn't block the main looper.
     */
    private suspend fun writeFilePackets(packets: List<ByteArray>) {
        if (rightFileWriteChar == null) {
            Bridge.log("G2/FILE: no FILE WRITE characteristic bound — cannot send")
            return
        }
        for ((index, packet) in packets.withIndex()) {
            if (index > 0) delay(BLE_PACKET_GAP_MS)
            writeTo(rightFileWriteChar, rightGatt, packet, "RIGHT")
        }
    }

    /**
     * Arm the ack slot *before* transmitting, so a fast reply can't land while we aren't listening.
     * Separate from [awaitFileAck] because the data phase transmits twice (the 0xC4 open and the
     * 0xC5 bytes) against a single ack.
     */
    private fun armFileAck(cid: Int): CompletableDeferred<Int> {
        val ack = CompletableDeferred<Int>()
        pendingFileAckCid = cid
        pendingFileAck = ack
        return ack
    }

    /** Wait for the armed ack's `[cid][status]`. Returns the status, or null on timeout. */
    private suspend fun awaitFileAck(ack: CompletableDeferred<Int>): Int? {
        val status = withTimeoutOrNull(FILE_ACK_TIMEOUT_MS) { ack.await() }
        pendingFileAck = null
        pendingFileAckCid = null
        return status
    }

    /**
     * Push a file to the glasses over the Even File Service. Bodies of any length are fine —
     * [G2SendManager.buildPackets] fragments correctly, verified by re-encoding a full capture
     * byte-for-byte.
     *
     * Returns RESULT_CHECK's `eEvenFileServiceRsp` status (0 = SUCCESS), or null if a phase timed
     * out. A failing phase returns its own status, so a checksum rejection (DATA_CRC_ERR at
     * RESULT_CHECK) is distinguishable from a refusal at START.
     */
    private suspend fun sendFile(fileType: Int, filename: String, bytes: ByteArray): Int? =
        fileTransferMutex.withLock {
            if (rightFileWriteChar == null) {
                // Checked before arming: an armed ack with nothing transmitted holds the caller
                // on a wait that can only time out.
                Bridge.log("G2/FILE: no FILE WRITE characteristic bound — cannot send")
                return@withLock null
            }
            val crc32 = evenCrc32(bytes)
            Bridge.log(
                "G2/FILE: START type=$fileType len=${bytes.size} crc32=0x${
                    String.format("%08X", crc32)
                } name=$filename"
            )

            val startAck = armFileAck(FileService.CID_SEND_START)
            sendOnFileService(ServiceID.FILE_CMD.value, FileService.sendStart(fileType, bytes.size, crc32, filename))
            val startStatus = awaitFileAck(startAck)
            if (startStatus != 0) {
                Bridge.log("G2/FILE: START failed — ${startStatus?.let(FileService::statusName) ?: "timeout"}")
                return@withLock startStatus
            }

            // The data phase opens and fills without an ack in between. The captured session is
            //     TX 0xC4 01  ->  TX 0xC5 <raw>  ->  RX 0xC5 01 00
            // i.e. ONE ack, after the bytes. Waiting on the 0xC4 open stalls until timeout, since
            // the glasses never ack it on its own.
            val dataAck = armFileAck(FileService.CID_SEND_DATA)
            sendOnFileService(ServiceID.FILE_CMD.value, FileService.sendData())
            // WRITE_TYPE_NO_RESPONSE writes go straight at the stack; back-to-back ones get
            // dropped as "stack busy", and dropping the raw bytes here would read as a timeout.
            delay(BLE_PACKET_GAP_MS)
            sendOnFileService(ServiceID.FILE_DATA.value, bytes)
            val dataStatus = awaitFileAck(dataAck)
            if (dataStatus != 0) {
                Bridge.log("G2/FILE: DATA failed — ${dataStatus?.let(FileService::statusName) ?: "timeout"}")
                return@withLock dataStatus
            }

            val checkAck = armFileAck(FileService.CID_SEND_RESULT_CHECK)
            sendOnFileService(ServiceID.FILE_CMD.value, FileService.resultCheck())
            val checkStatus = awaitFileAck(checkAck)
            Bridge.log(
                "G2/FILE: RESULT_CHECK — ${checkStatus?.let(FileService::statusName) ?: "timeout"}"
            )
            // DATA_CRC_ERR means framing and struct were accepted and only the checksum is wrong.
            if (checkStatus == 2) {
                Bridge.log("G2/FILE: DATA_CRC_ERR — everything but evenCrc32 is correct")
            }
            return@withLock checkStatus
        }

    /**
     * SEND_START's `fileCrc32`: CRC-32/Castagnoli polynomial, but MSB-first and unreflected, with
     * no final xor — not stock CRC-32C. Verified against all four captured transfers.
     */
    private val evenCrc32Table: IntArray =
        IntArray(256) { i ->
            var c = i shl 24
            repeat(8) { c = if (c < 0) (c shl 1) xor 0x1EDC6F41 else c shl 1 }
            c
        }

    private fun evenCrc32(data: ByteArray): Int {
        var crc = 0
        for (byte in data) {
            crc = (crc shl 8) xor evenCrc32Table[((byte.toInt() and 0xFF) xor (crc ushr 24)) and 0xFF]
        }
        return crc
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
        sendToGlasses(packets, left = true, right = true)
    }

    // ---------- Authentication Sequence ----------

    private suspend fun runAuthSequence() {
        Bridge.log("G2: Running auth sequence")

        // Auth to left side
        if (leftGatt != null && leftWriteChar != null) {
            val authL = DevSettingsProto.authCmd(sendManager.nextMagicRandom())
            sendDevSettingsCommand(authL, left = true, right = false)
        }

        // Small delay then auth right + pipe role change + time sync
        delay(200)
        val authR = DevSettingsProto.authCmd(sendManager.nextMagicRandom())
        sendDevSettingsCommand(authR, left = false, right = true)

        delay(200)
        val roleChange = DevSettingsProto.pipeRoleChange(sendManager.nextMagicRandom())
        sendDevSettingsCommand(roleChange, left = false, right = true)

        delay(200)
        val timeSync = DevSettingsProto.timeSync(sendManager.nextMagicRandom())
        sendDevSettingsCommand(timeSync, left = true, right = true)

        // Skip onboarding on connect
        delay(200)
        val onboarding = OnboardingProto.skipOnboarding(sendManager.nextMagicRandom())
        sendOnboardingCommand(onboarding)
        Bridge.log("G2: Sent onboarding skip (FINISH)")

        // 1. gesture_ctrl init (field1=0, field2=magicRandom)
        val gestureInitW = ProtobufWriter()
        gestureInitW.writeInt32Field(1, 0)
        gestureInitW.writeInt32Field(2, sendManager.nextMagicRandom())
        sendGestureCtrlCommand(gestureInitW.toByteArray())

        // 2. ui_setting_app (0x0C) — query (cmd=2, field4={settingInfoType=1, autoBrightnessLevel=0})
        val uiSettW = ProtobufWriter()
        uiSettW.writeInt32Field(1, 2) // cmd = DeviceReceiveRequest
        uiSettW.writeInt32Field(2, sendManager.nextMagicRandom())
        uiSettW.writeMessageField(4, byteArrayOf(0x08, 0x01, 0x10, 0x00)) // {1:1, 2:0}
        sendToGlasses(
            sendManager.buildPackets(
                serviceId = 0x0C,
                payload = uiSettW.toByteArray(),
                reserveFlag = true
            )
        )

        // 6. Dashboard init (0x01) — display settings
        // halfDayFormat: 1 = 12h, 0 = 24h
        // temperatureUnit: 1 = Celsius (metric), 2 = Fahrenheit (imperial)
        val dashDisplayW = ProtobufWriter()
        dashDisplayW.writeInt32Field(1, 4) // displayMode
        dashDisplayW.writeInt32Field(2, 3) // statusDisplayCount
        dashDisplayW.writeMessageField(3, byteArrayOf(1, 2, 3)) // statusDisplayOrder
        dashDisplayW.writeInt32Field(4, 4) // widgetDisplayCount
        // WidgetType: 1=News, 2=Stock, 3=Schedule, 4=Quicklist, 5=Health
        dashDisplayW.writeMessageField(
            5,
            byteArrayOf(3, 1, 2, 4, 5)
        ) // widgetDisplayOrder: Schedule, News, Stock, Quicklist
        dashDisplayW.writeInt32Field(6, dashboardHalfDayFormat()) // halfDayFormat
        dashDisplayW.writeInt32Field(7, dashboardTemperatureUnit()) // temperatureUnit

        val dashRecvW = ProtobufWriter()
        dashRecvW.writeMessageField(2, dashDisplayW.toByteArray())

        val dashPkgW = ProtobufWriter()
        dashPkgW.writeInt32Field(1, 2) // Dashboard_Receive
        dashPkgW.writeInt32Field(2, sendManager.nextMagicRandom())
        dashPkgW.writeMessageField(4, dashRecvW.toByteArray())
        sendDashboardCommand(dashPkgW.toByteArray())

        // Disable "Hey Even" wakeword on connect
        val heyEvenOff = EvenAIProto.setHeyEven(sendManager.nextMagicRandom(), false)
        sendEvenAICommand(heyEvenOff)
        Bridge.log("G2: Disabled Hey Even wakeword")

        Bridge.log("G2: Sent full Even-compatible init sequence")

        // Start heartbeats after auth
        startHeartbeats()

        reconnectionManager.stop()
        Bridge.log("G2: Auth sequence complete, glasses ready")

        // Set device_name so DeviceManager can save it for reconnection
        val peripheralName = rightGatt?.device?.name ?: leftGatt?.device?.name
        val serialNumber = peripheralName?.let { deviceNameToSerialNumber[it] }
        if (serialNumber != null) {
            DeviceStore.apply("bluetooth", "device_name", serialNumber)
            Bridge.log("G2: Set device_name to $serialNumber")
        }

        // Set bluetooth name and device model for Device Info page
        val btName = rightGatt?.device?.name ?: leftGatt?.device?.name ?: ""
        DeviceStore.apply("glasses", "bluetoothName", btName)
        DeviceStore.apply("glasses", "deviceModel", DeviceTypes.G2)

        setFullyConnected()

        // Connect a controller if we have one
        connectController()

        // Query version + battery info from glasses
        requestDeviceInfo()

        sendMenuApps()
        sendStoredCalendarEvents()

        // Re-apply the IMU preference: the store only pushes imu_enabled to the glasses when
        // the value changes, so after a reconnect an already-on IMU would otherwise stay off
        // (accel_event stops) until the user toggles the setting again.
        val imuEnabled = DeviceStore.get("bluetooth", "imu_enabled") as? Boolean ?: false
        if (imuEnabled) {
            Bridge.log("G2: re-applying imu_enabled=true after connect")
            setImuEnabled(true)
        }
    }

    private fun dashboardHalfDayFormat(): Int {
        val twelveHour = DeviceStore.get("bluetooth", "twelve_hour_time") as? Boolean ?: true
        return if (twelveHour) 1 else 0
    }

    private fun dashboardTemperatureUnit(): Int {
        val metric = DeviceStore.get("bluetooth", "metric_system") as? Boolean ?: false
        return if (metric) 1 else 2
    }

    override fun sendDashboardDisplaySettings() {
        val dashDisplayW = ProtobufWriter()
        dashDisplayW.writeInt32Field(1, 4) // displayMode
        dashDisplayW.writeInt32Field(2, 3) // statusDisplayCount
        dashDisplayW.writeMessageField(3, byteArrayOf(1, 2, 3)) // statusDisplayOrder
        dashDisplayW.writeInt32Field(4, 4) // widgetDisplayCount
        dashDisplayW.writeMessageField(5, byteArrayOf(1, 3, 2, 2)) // widgetDisplayOrder
        dashDisplayW.writeInt32Field(6, dashboardHalfDayFormat()) // halfDayFormat
        dashDisplayW.writeInt32Field(7, dashboardTemperatureUnit()) // temperatureUnit

        val dashRecvW = ProtobufWriter()
        dashRecvW.writeMessageField(2, dashDisplayW.toByteArray())

        val dashPkgW = ProtobufWriter()
        dashPkgW.writeInt32Field(1, 2) // Dashboard_Receive
        dashPkgW.writeInt32Field(2, sendManager.nextMagicRandom())
        dashPkgW.writeMessageField(4, dashRecvW.toByteArray())
        sendDashboardCommand(dashPkgW.toByteArray())
    }

    // ---------- Heartbeats ----------

    private fun startHeartbeats() {
        // EvenHub heartbeat every 10 seconds
        stopHeartbeats()

        val hbRunnable =
            object : Runnable {
                override fun run() {
                    sendEvenHubHeartbeat()
                    mainHandler.postDelayed(this, 10000)
                }
            }
        heartbeatRunnable = hbRunnable
        mainHandler.postDelayed(hbRunnable, 10000)

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

        // Display reconcile loop: push any dirty text containers (one send each, with a redundant
        // resend), then any dirty image containers one at a time. Single sender, so a sendImageData
        // never overlaps another and can't clobber the pending image ACK — the invariant displayMutex
        // used to enforce. The loop wakes on each channel element: mutations send one immediately
        // (instant reaction), and a ~100ms ticker sends one when idle so periodic work (text resends,
        // image retries) still runs. The CONFLATED buffer coalesces bursts into a single wake.
        val signal = Channel<Unit>(Channel.CONFLATED)
        displayDirtySignal = signal
        displayTickJob =
            displayScope.launch {
                while (isActive) {
                    delay(EVEN_HUB_QUEUE_TICK_MS)
                    signal.trySend(Unit)
                }
            }
        displayReconcileJob =
            displayScope.launch {
                for (sig in signal) {
                    reconcileDisplay()
                }
            }
    }

    private fun stopHeartbeats() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
        devSettingsHeartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        devSettingsHeartbeatRunnable = null
        displayTickJob?.cancel()
        displayTickJob = null
        displayReconcileJob?.cancel()
        displayReconcileJob = null
        displayDirtySignal?.close()
        displayDirtySignal = null
    }

    /** Wake the reconcile loop now (a container was just marked dirty / had sends scheduled). Cheap
     * and idempotent: coalesced by the conflated channel, so a burst of mutations wakes at most once
     * extra. */
    private fun signalDisplayDirty() {
        displayDirtySignal?.trySend(Unit)
    }

    private fun sendEvenHubHeartbeat() {
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
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
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
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
            DeviceStore.get("bluetooth", "menu_apps") as? List<Map<String, Any>> ?: emptyList()
        if (menuItems.isNotEmpty()) {
            setDashboardMenu(menuItems)
        }
    }

    private fun sendStoredCalendarEvents() {
        val calendarEvents =
            DeviceStore.get("bluetooth", "calendar_events") as? List<Map<String, Any>>
                ?: emptyList()
        sendCalendarEvents(calendarEvents)
    }

    // ---------- SGCManager: Display Control ----------

    override fun sendText(text: String) {
        displayScope.launch {
            sendText2(text)
        }
    }

    override fun sendTextWall(text: String) {
        displayScope.launch {
            sendText2(
                text,
                x = defaultTextX,
                y = defaultTextY,
                width = defaultTextWidth,
                height = defaultTextHeight,
                borderWidth = defaultTextBorderWidth,
                borderColor = defaultTextBorderColor,
                borderRadius = defaultTextBorderRadius,
                paddingLength = defaultTextPaddingLength
            )
        }
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
        displayScope.launch {
            sendText2(
                text,
                x = x,
                y = y,
                width = width,
                height = height,
                borderWidth = borderWidth,
                borderColor = defaultTextBorderColor,
                borderRadius = borderRadius,
                paddingLength = defaultTextPaddingLength
            )
        }
    }

    private suspend fun sendText2(
        text: String,
        x: Int? = null,
        y: Int? = null,
        width: Int? = null,
        height: Int? = null,
        borderWidth: Int? = null,
        borderColor: Int? = null,
        borderRadius: Int? = null,
        paddingLength: Int? = null
    ) {
        // Bridge.log("G2: sendTextWall(${text.take(50)}...)")

        // ignore events while the ER dashboard is open:
        val useNativeDashboard =
            DeviceStore.get("bluetooth", "use_native_dashboard") as? Boolean ?: false
        if (useNativeDashboard && dashboardShowing > 0) {
            return
        }

        val rx = x ?: defaultTextX
        // Legacy callers can hand us y beyond the canvas — clamp it first so
        // the height formula below can't go negative/below one fw line.
        val ry = minOf(maxOf(y ?: defaultTextY, 0), 288 - minTextContainerHeight)
        val rw = width ?: defaultTextWidth
        // Firmware guard: grow to at least one fw line, clamped to the canvas.
        // Content-independent so rect keys stay stable across updates.
        val rh = minOf(maxOf(height ?: defaultTextHeight, minTextContainerHeight), 288 - ry)
        // Honor caller-provided border styling (scene rects render as bordered
        // empty containers — a border of 0-by-default here made them invisible).
        val rBorderWidth = borderWidth ?: defaultTextBorderWidth
        val rBorderColor = borderColor ?: defaultTextBorderColor
        val rBorderRadius = borderRadius ?: defaultTextBorderRadius
        val rPaddingLength = paddingLength ?: defaultTextPaddingLength
        val content = if (text.isEmpty()) " " else text

        // Pure state mutation: update the container's content and schedule its sends; the reconcile
        // loop does the actual updateText writes. Reuse an existing container if the rect matches
        // exactly; otherwise add a new one.
        val container: TextContainer
        val existingIndex =
            textContainers.indexOfFirst {
                it.matches(
                    rx,
                    ry,
                    rw,
                    rh,
                    rBorderWidth,
                    rBorderColor,
                    rBorderRadius,
                    rPaddingLength
                )
            }
        if (existingIndex >= 0) {
            textContainers[existingIndex].content = content
            textContainers[existingIndex].pendingSends = 1 + EVEN_HUB_RESEND_COUNT
            container = textContainers[existingIndex]
            // Wake the reconcile loop either way. When the page is live it sends the text; when the
            // page is down the loop coalesces the burst into a single rebuild (see reconcileDisplay)
            // instead of one shutdown/rebuild per caption. The container's content is overwritten in
            // place (last-wins), so a backlog that piled up while we were suspended collapses to one
            // catch-up render — no flood on resume.
            signalDisplayDirty()
            if (!pageCreated) {
                Bridge.log("G2: sendText() - page down, buffering latest content for container ${container.id} (rebuild deferred to reconcile)")
                return
            }
            Bridge.log("G2: sendText() - reusing container ${container.id} for rect $rx,$ry ${rw}x$rh")
            return
        }
        container =
            addTextContainer(
                rx,
                ry,
                rw,
                rh,
                content,
                rBorderWidth,
                rBorderColor,
                rBorderRadius,
                rPaddingLength
            )
        Bridge.log("G2: sendText() - added text container ${container.id} for rect $rx,$ry ${rw}x$rh, rebuilding page")
        // New container changes page structure: rebuild it (the rebuild embeds initial content), then
        // schedule sends so the loop refreshes it.
        val newIndex = textContainers.indexOfFirst { it.id == container.id }
        if (newIndex >= 0) {
            textContainers[newIndex].pendingSends = 1 + EVEN_HUB_RESEND_COUNT
        }
        signalDisplayDirty()
        requestPageRebuild()
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("G2: sendDoubleTextWall() - top: $top, bottom: $bottom")
        // G2 doesn't have native double text wall, combine them
        val combined = "$top\n\n$bottom"
        sendTextWall(combined)
    }

    override fun clearDisplay() {
        Bridge.log("G2: clearDisplay()")
        // Clear the text in place — do NOT shut down + rebuild the EvenHub page. Tearing the page
        // down (rebuildPage) kills audio streaming AND triggers a firmware systemExit /
        // dashboard-close → recovery → another rebuild. The cloud sends clearDisplay in bursts
        // (caption gaps → clear → new caption), and when each clear tore down + rebuilt the page
        // those bursts became a rebuild storm that churned the display and dropped audio for
        // several seconds (incident 8164175a). Just blank the text + clear images; the reconcile
        // loop pushes the blanked text on a live page, and a dead page is only resurrected for
        // meaningful (non-blank) content, so a clear can't churn it back up.
        for (i in textContainers.indices) {
            textContainers[i].content = "\n"
            textContainers[i].pendingSends = 1 + EVEN_HUB_RESEND_COUNT
        }
        for (i in imageContainers.indices) {
            // The firmware still shows this container's image; emptying bmpData locally never reaches
            // it (#3232 dropped the teardown that used to drop empty containers on rebuild). Empty +
            // dirty tells the reconcile loop to push an all-black frame that overwrites the image
            // on-glass — the page stays up, so no audio/mic churn. Skip already-empty containers.
            if (imageContainers[i].bmpData.isNotEmpty()) {
                imageContainers[i].bmpData = ByteArray(0)
                imageContainers[i].dirty = true
            }
        }
        signalDisplayDirty()

        // Purge scene HUD containers structurally: a blanked small box still
        // renders the firmware's overflow tick (a "\n" husk is two empty lines
        // in a one-line box) and corrupts whatever app draws next. Full-canvas
        // containers stay blanked-in-place — the shipped caption-gap behavior,
        // storm-safe (no rebuild on ordinary clears). Only when positioned HUD
        // husks exist (app exit) do we drop them + rebuild ONCE.
        val huskIds = textContainers
            .filter { !(it.x == 0 && it.y == 0 && it.width >= defaultTextWidth && it.height >= defaultTextHeight) }
            .map { it.id }
            .toSet()
        if (huskIds.isNotEmpty()) {
            textContainers.removeAll { it.id in huskIds }
            sceneTextByElement.entries.removeAll { it.value in huskIds }
            sceneImageByElement.clear()
            Bridge.log("G2: clearDisplay() — purging ${huskIds.size} positioned husk container(s), one rebuild")
            displayScope.launch { coalescedPageRebuild() }
        }
    }

    /**
     * Display a bitmap inside a positioned image container.
     *
     * The page keeps a live list of up to 4 image containers keyed by exact rect:
     * - If a container with the requested rect already exists, the image is just resent to it (no
     * page rebuild).
     * - Otherwise a new container is added (evicting the oldest when the list would exceed 4) and
     * the page is rebuilt before the image is sent.
     *
     * Omitted params default to a 100x100 container in the top-left corner.
     */
    override fun displayBitmap(
        base64ImageData: String,
        x: Int?,
        y: Int?,
        width: Int?,
        height: Int?
    ): Boolean {
        val rx = x ?: defaultImgX
        val ry = y ?: defaultImgY
        val rw = width ?: defaultImgWidth
        val rh = height ?: defaultImgHeight

        // ignore events while the ER dashboard is open:
        val useNativeDashboard = DeviceStore.get("bluetooth", "use_native_dashboard") as? Boolean ?: false
        if (useNativeDashboard && dashboardShowing > 0) {
            return false
        }

        val rawData =
            Base64.decode(base64ImageData, Base64.DEFAULT)
                ?: run {
                    Bridge.log("G2: displayBitmap() - failed to decode base64")
                    return false
                }

        val bmpData =
            convertToG2Bmp(rawData, containerWidth = rw, containerHeight = rh)
                ?: run {
                    Bridge.log("G2: displayBitmap() - failed to convert image to BMP")
                    return false
                }

        // Pure state mutation: update the target container's bytes and mark it dirty. The reconcile
        // loop is the sole sender, so two displayBitmap calls can never overlap a sendImageData and
        // clobber the single-slot image ACK — no lock needed. Reuse an existing container if the rect
        // matches exactly; otherwise add a new one.
        val container: ImgContainer
        val existingIndex = imageContainers.indexOfFirst { it.matches(rx, ry, rw, rh) }
        if (existingIndex >= 0) {
            imageContainers[existingIndex].bmpData = bmpData
            imageContainers[existingIndex].dirty = true
            signalDisplayDirty()
            container = imageContainers[existingIndex]
            Bridge.log("G2: displayBitmap() - reusing container ${container.id} for rect $rx,$ry ${rw}x$rh")
            // A brand-new page needs its structure built before the loop can push pixels; the dirty
            // flag stays set so the reconcile loop sends the image once the page exists.
            if (!pageCreated) {
                if (sceneBatchActive) sceneStructuralPending = true else displayScope.launch { coalescedPageRebuild() }
            }
            return true
        } else {
            container = addImageContainer(rx, ry, rw, rh, bmpData)
            val newIndex = imageContainers.indexOfFirst { it.id == container.id }
            if (newIndex >= 0) {
                imageContainers[newIndex].dirty = true
            }
            signalDisplayDirty()
            Bridge.log("G2: displayBitmap() - added container ${container.id} for rect $rx,$ry ${rw}x$rh, rebuilding page")
            // New container changes page structure: rebuild it, then the loop sends the pixels.
            if (sceneBatchActive) sceneStructuralPending = true else displayScope.launch { coalescedPageRebuild() }
        }

        return true
    }

    // ── Scene verbs (display.render() pipeline) ─────────────────────────────
    // Element-id-aware wrappers over the container machinery. The base
    // SGCManager.applySceneFrame walks host-diffed frames into these; identity
    // is the element id (DeviceManager sweeps the previous app's elements on an
    // app switch, so at most one app's ids are live at a time). Containers are
    // still rect-keyed underneath — the maps pin element↔container so content
    // updates go in place and moves recreate at the SAME container id.
    private val sceneTextByElement = mutableMapOf<String, Int>()

    // Images map to an ARRAY of containers: firmware refuses image transfers
    // into containers beyond ~200x100 (hardware-verified 2026-07-03), so bigger
    // images tile across multiple containers (400x100 → two side-by-side,
    // 150x150 → two stacked).
    private val sceneImageByElement = mutableMapOf<String, List<Int>>()

    private data class ImageTile(val dx: Int, val dy: Int, val w: Int, val h: Int)

    /** Tile rects (relative to the element box) with firmware-acceptable sizes. Row-major. */
    private fun imageTileRects(w: Int, h: Int): List<ImageTile> {
        val maxW = 200
        val maxH = 100
        val cols = (w + maxW - 1) / maxW
        val rows = (h + maxH - 1) / maxH
        val out = ArrayList<ImageTile>(cols * rows)
        for (r in 0 until rows) {
            for (c in 0 until cols) {
                val dx = c * maxW
                val dy = r * maxH
                out.add(ImageTile(dx, dy, minOf(maxW, w - dx), minOf(maxH, h - dy)))
            }
        }
        return out
    }

    // Scene-frame rebuild batching. A frame with several new containers must
    // NOT rebuild the page once per create: rebuildPage sends SHUTDOWN_PAGE,
    // and 4-5 shutdown/recover cycles back-to-back are a firmware rebuild
    // storm — the G2 punishes those by dropping the BLE link (same failure
    // family as the mic-session incidents). While a frame is being applied,
    // structural changes only mark the flag; applySceneFrame does ONE rebuild
    // at the end. Both flags are only touched on displayScope (Dispatchers.Main).
    private var sceneBatchActive = false
    private var sceneStructuralPending = false

    /** Rebuild now — or, inside an applySceneFrame batch, once at frame end. */
    private suspend fun requestPageRebuild() {
        if (sceneBatchActive) {
            sceneStructuralPending = true
            return
        }
        coalescedPageRebuild()
    }

    /**
     * Structural change: tear down + rebuild ONLY when the page is actually
     * live. When the page is already down (mid-recovery, or a prior frame's
     * rebuild in flight), sending another SHUTDOWN_PAGE restarts the firmware
     * recovery cycle — frames arriving faster than recovery completes then keep
     * the page down FOREVER (nothing renders, image fragments all fail). A down
     * page just needs the dirty signal: the reconcile loop resurrects it once,
     * with the full current container list, which already includes every
     * structural change accumulated while it was down.
     */
    private suspend fun coalescedPageRebuild() {
        if (pageCreated) {
            rebuildPage()
        } else {
            Bridge.log("G2: structural change while page down — deferring to reconcile rebuild (no extra shutdown)")
            signalDisplayDirty()
        }
    }

    /**
     * G2 override of the default paint-then-sweep: identical walk, but run as
     * ONE displayScope coroutine with structural rebuilds coalesced to a single
     * shutdown/rebuild per frame.
     */
    override fun applySceneFrame(frame: SceneFrame) {
        displayScope.launch {
            if (frame.replay) {
                sceneTextByElement.clear()
                sceneImageByElement.clear()
            }
            sceneBatchActive = true
            sceneStructuralPending = false
            try {
                // Type-changed ids (removed AND re-painted this frame) must be
                // removed BEFORE the paint — post-paint removal would delete
                // the just-painted replacement (registries key by id).
                val paintedIds = frame.elements.mapTo(HashSet()) { it.id }
                for (id in frame.removed) {
                    if (id in paintedIds) applySceneRemove(id)
                }
                for (el in frame.elements) {
                    if (!frame.replay && el.change == "unchanged") continue
                    when (el.type) {
                        "text" ->
                            applySceneText(el.text ?: "", el.x, el.y, el.w, el.h, el.border, el.radius, el.id)
                        "rect" ->
                            applySceneText("", el.x, el.y, el.w, el.h, maxOf(1, el.border), el.radius, el.id)
                        "image" ->
                            el.data?.let { applySceneBitmap(it, el.x, el.y, el.w, el.h, el.id) }
                        else -> Bridge.log("G2: applySceneFrame: unknown element type ${el.type}")
                    }
                }
                for (id in frame.removed) {
                    if (id !in paintedIds) applySceneRemove(id)
                }
            } finally {
                // Flush inside finally: a mid-frame exception must not strand
                // a pending structural rebuild (the page would sit stale until
                // the next frame happened to be structural).
                sceneBatchActive = false
                if (sceneStructuralPending) {
                    sceneStructuralPending = false
                    Bridge.log("G2: applySceneFrame — structural changes, ONE coalesced rebuild for the whole frame")
                    coalescedPageRebuild()
                }
            }
        }
    }

    override fun onSceneReplay(appId: String) {
        // A replay frame repaints from scratch through the create path; forget
        // the element mapping so creates re-match/re-register cleanly.
        sceneTextByElement.clear()
        sceneImageByElement.clear()
    }

    override fun drawLayoutText(
        text: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        borderWidth: Int,
        borderRadius: Int,
        elementId: String,
        layoutId: String?
    ) {
        displayScope.launch { applySceneText(text, x, y, width, height, borderWidth, borderRadius, elementId) }
    }

    /** Scene text upsert — runs on displayScope; rebuilds go through [requestPageRebuild]. */
    private suspend fun applySceneText(
        text: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        borderWidth: Int,
        borderRadius: Int,
        elementId: String
    ) {
        // Same firmware min-height guard as sendText2, applied before the
        // registry rect checks so grown rects stay consistent across calls.
        @Suppress("NAME_SHADOWING")
        val y = minOf(maxOf(y, 0), 288 - minTextContainerHeight)
        @Suppress("NAME_SHADOWING")
        val height = minOf(maxOf(height, minTextContainerHeight), 288 - y)
        run {
            val content = if (text.isEmpty()) " " else text
            val existingId = sceneTextByElement[elementId]
            if (existingId != null) {
                val idx = textContainers.indexOfFirst { it.id == existingId }
                if (idx >= 0) {
                    val c = textContainers[idx]
                    if (c.x == x && c.y == y && c.width == width && c.height == height &&
                        c.borderWidth == borderWidth && c.borderRadius == borderRadius
                    ) {
                        // Content-only change: update in place — NEVER a page
                        // rebuild. On G2 this is correctness, not perf: page
                        // teardown couples to mic state and firmware recovery
                        // storms (design doc §3.4.1 hard rule).
                        c.content = content
                        c.pendingSends = 1 + EVEN_HUB_RESEND_COUNT
                        signalDisplayDirty()
                        return@run
                    }
                    // Moved/restyled: recreate at the SAME container id (structural).
                    textContainers[idx] =
                        TextContainer(
                            id = existingId,
                            x = x,
                            y = y,
                            width = width,
                            height = height,
                            content = content,
                            borderWidth = borderWidth,
                            borderColor = defaultTextBorderColor,
                            borderRadius = borderRadius,
                            paddingLength = defaultTextPaddingLength,
                            pendingSends = 1 + EVEN_HUB_RESEND_COUNT
                        )
                    signalDisplayDirty()
                    requestPageRebuild()
                    return@run
                }
                // Container got evicted underneath us — fall through to create.
                sceneTextByElement.remove(elementId)
            }

            sendText2(
                content,
                x,
                y,
                width,
                height,
                borderWidth,
                defaultTextBorderColor,
                borderRadius,
                defaultTextPaddingLength
            )
            val idx =
                textContainers.indexOfFirst {
                    it.matches(x, y, width, height, borderWidth, defaultTextBorderColor, borderRadius, defaultTextPaddingLength)
                }
            if (idx >= 0) {
                val cid = textContainers[idx].id
                // The container id may have been LRU-recycled from another element.
                sceneTextByElement.entries.removeAll { it.value == cid }
                sceneTextByElement[elementId] = cid
            }
        }
    }

    override fun drawLayoutBitmap(
        base64ImageData: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        elementId: String,
        layoutId: String?
    ): Boolean {
        // applySceneBitmap is suspend (tile encodes + batched rebuilds); legacy
        // per-element callers fire it on displayScope like every other verb.
        displayScope.launch { applySceneBitmap(base64ImageData, x, y, width, height, elementId) }
        return true
    }

    /** Scene bitmap upsert — rebuilds go through the batch flag (see applySceneFrame). */
    private suspend fun applySceneBitmap(
        base64ImageData: String,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        elementId: String
    ): Boolean {
        val tiles = imageTileRects(width, height)
        if (tiles.size > imageContainerIDPool.size) {
            Bridge.log(
                "G2: applySceneBitmap '$elementId' ${width}x$height needs ${tiles.size} tiles — exceeds the ${imageContainerIDPool.size}-container pool, dropping"
            )
            return false
        }

        // Element moved or re-tiled: blacken any containers whose rects no
        // longer belong to this element's tile set.
        sceneImageByElement[elementId]?.let { existing ->
            val wantedRects = tiles.map { listOf(x + it.dx, y + it.dy, it.w, it.h) }.toSet()
            for (cid in existing) {
                val idx = imageContainers.indexOfFirst { it.id == cid }
                if (idx >= 0) {
                    val c = imageContainers[idx]
                    val stillWanted = listOf(c.x, c.y, c.width, c.height) in wantedRects
                    if (!stillWanted && c.bmpData.isNotEmpty()) {
                        c.bmpData = ByteArray(0)
                        c.dirty = true
                        signalDisplayDirty()
                    }
                }
            }
        }
        sceneImageByElement.remove(elementId)

        val cids = mutableListOf<Int>()
        if (tiles.size == 1) {
            // Single container — the existing path (decode, aspect-fit, encode).
            if (!displayBitmap(base64ImageData, x, y, width, height)) return false
            val idx = imageContainers.indexOfFirst { it.matches(x, y, width, height) }
            if (idx < 0) return false
            cids.add(imageContainers[idx].id)
        } else {
            // Tiled: render the whole image to grayscale ONCE at the element
            // size, then slice per-tile rows into their own 4-bit BMPs, one
            // firmware container per tile.
            val rawData = Base64.decode(base64ImageData, Base64.DEFAULT) ?: return false
            val gray = renderG2Grayscale(rawData, width, height) ?: run {
                Bridge.log("G2: applySceneBitmap - failed to render grayscale")
                return false
            }
            Bridge.log("G2: applySceneBitmap '$elementId' ${width}x$height → ${tiles.size} tiles")
            for (t in tiles) {
                val tilePixels = ByteArray(t.w * t.h)
                for (row in 0 until t.h) {
                    System.arraycopy(gray, (t.dy + row) * width + t.dx, tilePixels, row * t.w, t.w)
                }
                val bmp = build4BitBmp(tilePixels, t.w, t.h) ?: run {
                    Bridge.log("G2: applySceneBitmap - tile encode failed")
                    return false
                }
                val tx = x + t.dx
                val ty = y + t.dy
                val idx = imageContainers.indexOfFirst { it.matches(tx, ty, t.w, t.h) }
                if (idx >= 0) {
                    imageContainers[idx].bmpData = bmp
                    imageContainers[idx].dirty = true
                    cids.add(imageContainers[idx].id)
                } else {
                    val container = addImageContainer(tx, ty, t.w, t.h, bmp)
                    val j = imageContainers.indexOfFirst { it.id == container.id }
                    if (j >= 0) imageContainers[j].dirty = true
                    cids.add(container.id)
                    requestPageRebuild()
                }
            }
            signalDisplayDirty()
        }

        // Container ids may have been LRU-recycled from other elements.
        val taken = cids.toSet()
        val keys = sceneImageByElement.keys.toList()
        for (key in keys) {
            val remaining = sceneImageByElement[key]?.filter { it !in taken } ?: continue
            if (remaining.isEmpty()) sceneImageByElement.remove(key) else sceneImageByElement[key] = remaining
        }
        sceneImageByElement[elementId] = cids
        return true
    }

    /**
     * Decode an image and render it to raw 8-bit grayscale at target size
     * (aspect-fit, centered on black) — the front half of [convertToG2Bmp],
     * exposed for the tiler which encodes per-tile BMPs from one render.
     */
    private fun renderG2Grayscale(data: ByteArray, targetWidth: Int, targetHeight: Int): ByteArray? {
        val srcBitmap = BitmapFactory.decodeByteArray(data, 0, data.size) ?: return null
        val scale = minOf(targetWidth.toDouble() / srcBitmap.width, targetHeight.toDouble() / srcBitmap.height)
        val scaledW = maxOf(1, (srcBitmap.width * scale).toInt())
        val scaledH = maxOf(1, (srcBitmap.height * scale).toInt())
        val offsetX = (targetWidth - scaledW) / 2
        val offsetY = (targetHeight - scaledH) / 2

        val destBitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(destBitmap)
        canvas.drawColor(Color.BLACK)
        canvas.drawBitmap(
            srcBitmap,
            Rect(0, 0, srcBitmap.width, srcBitmap.height),
            Rect(offsetX, offsetY, offsetX + scaledW, offsetY + scaledH),
            Paint(Paint.FILTER_BITMAP_FLAG)
        )

        val gray = ByteArray(targetWidth * targetHeight)
        for (yy in 0 until targetHeight) {
            for (xx in 0 until targetWidth) {
                val pixel = destBitmap.getPixel(xx, yy)
                val v = (Color.red(pixel) * 299 + Color.green(pixel) * 587 + Color.blue(pixel) * 114) / 1000
                gray[yy * targetWidth + xx] = v.toByte()
            }
        }
        srcBitmap.recycle()
        destBitmap.recycle()
        return gray
    }

    override fun removeLayoutElement(elementId: String, layoutId: String?) {
        displayScope.launch { applySceneRemove(elementId) }
    }

    /**
     * Scene element removal — STRUCTURAL. Blanked-in-place containers still
     * RENDER (the firmware draws a cursor-like mark at a whitespace container's
     * content origin — the stray tick; legacy never saw it because its only
     * container's origin sat above the visible eyebox). A removed element
     * leaves the page: drop it from the tracked list (freeing the pool id) and
     * mark the frame structural — the batched frame-end rebuild recreates the
     * page without it. Never a per-remove shutdown (mic coupling).
     */
    private suspend fun applySceneRemove(elementId: String) {
        sceneTextByElement.remove(elementId)?.let { id ->
            val idx = textContainers.indexOfFirst { it.id == id }
            if (idx >= 0) {
                textContainers.removeAt(idx)
                requestPageRebuild()
            }
        }
        sceneImageByElement.remove(elementId)?.let { ids ->
            for (id in ids) {
                val idx = imageContainers.indexOfFirst { it.id == id }
                if (idx >= 0 && imageContainers[idx].bmpData.isNotEmpty()) {
                    imageContainers[idx].bmpData = ByteArray(0)
                    imageContainers[idx].dirty = true
                }
            }
            signalDisplayDirty()
            requestPageRebuild()
        }
    }

    /**
     * Sweep a set of scene elements as ONE batched structural change (called by
     * DeviceManager on scene→legacy and cross-app transitions, outside any
     * applySceneFrame batch — without batching, each remove would rebuild).
     */
    override fun clearSceneElements(elementIds: List<String>) {
        displayScope.launch {
            sceneBatchActive = true
            try {
                for (id in elementIds) applySceneRemove(id)
            } finally {
                sceneBatchActive = false
            }
            if (sceneStructuralPending) {
                sceneStructuralPending = false
                coalescedPageRebuild()
            }
        }
    }

    /**
     * Add a new image container for the rect, evicting the oldest when the list is full (max 4).
     * Returns the newly tracked container (with an assigned ID from the pool).
     */
    private fun addImageContainer(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        bmpData: ByteArray
    ): ImgContainer {
        // Evict the oldest container when at capacity, freeing its ID for reuse.
        if (imageContainers.size >= imageContainerIDPool.size) {
            val evicted = imageContainers.removeAt(0)
            Bridge.log("G2: evicting oldest image container ${evicted.id}")
        }
        // Pick the lowest free ID from the pool.
        val usedIDs = imageContainers.map { it.id }.toSet()
        val id = imageContainerIDPool.firstOrNull { it !in usedIDs } ?: imageContainerIDPool[0]
        val container =
            ImgContainer(id = id, x = x, y = y, width = width, height = height, bmpData = bmpData)
        imageContainers.add(container)
        return container
    }

    private fun addTextContainer(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        content: String,
        borderWidth: Int,
        borderColor: Int,
        borderRadius: Int,
        paddingLength: Int
    ): TextContainer {
        // Evict the oldest container when at capacity, freeing its ID for reuse.
        if (textContainers.size >= textContainerIDPool.size) {
            val evicted = textContainers.removeAt(0)
            Bridge.log("G2: evicting oldest text container ${evicted.id}")
        }
        // Pick the lowest free ID from the pool.
        val usedIDs = textContainers.map { it.id }.toSet()
        val id = textContainerIDPool.firstOrNull { it !in usedIDs } ?: textContainerIDPool[0]
        val container =
            TextContainer(
                id = id,
                x = x,
                y = y,
                width = width,
                height = height,
                content = content,
                borderWidth = borderWidth,
                borderColor = borderColor,
                borderRadius = borderRadius,
                paddingLength = paddingLength
            )
        textContainers.add(container)
        return container
    }

    /**
     * Shutdown and rebuild everything, re-sending all data to the glasses.
     *
     * Suspends until the rebuild (shutdown → create → image/text re-send) has been issued, so
     * callers no longer race a detached coroutine. Always invoke on [displayScope].
     */
    private suspend fun rebuildPage() {
        val msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        // we will automatically rebuild state when we detect the glasses shutdown:
        delay(300) // 300ms to settle
        // rebuildState()
    }

    /**
     * Re-creates the containers and re-sends all images to the glasses.
     *
     * Runs inline (suspending) rather than launching a detached coroutine, so the page is fully
     * rebuilt before the caller continues. Always invoke on [displayScope].
     */
    private suspend fun rebuildState() {
        Bridge.log("G2: rebuildState()")
        // recreate the containers (sets pageCreated = true; embeds text content directly):
        createPageWithContainers()
        delay(300) // 300ms to settle

        // Mark every image container dirty and let the reconcile loop re-send them, one at a time.
        // Doing the sends here directly is what used to race a concurrent displayBitmap and clobber
        // the image ACK; routing through the dirty flag keeps a single sender (the reconcile loop).
        // Text needs no resend here: createPageWithContainers already embeds each container's content.
        for (i in imageContainers.indices) {
            if (imageContainers[i].bmpData.isNotEmpty()) {
                Bridge.log(
                    "G2: rebuildState() - marking container ${imageContainers[i].id} dirty (${imageContainers[i].bmpData.size} bytes)"
                )
                imageContainers[i].dirty = true
            }
        }
        signalDisplayDirty()

        delay(300) // 300ms to settle
        restartMicIfAlreadyEnabled()
    }

    /**
     * Single coalesced recovery: rebuild the page + re-arm the mic from intent, never stacking
     * rebuilds (the firmware spams systemExit/dashboard-close ~1×/sec). Skips when the page is
     * already alive and the mic matches intent; otherwise one rebuild in flight, one per
     * RECOVERY_DEBOUNCE_MS. See iOS G2.swift.
     */
    private fun recoverPageAndMic(reason: String) {
        val now = System.currentTimeMillis()
        // Page alive and mic matches intent → phantom firmware event, nothing to recover.
        val micIntent = DeviceStore.get("glasses", "micEnabled") as? Boolean ?: false
        if (pageCreated && evenHubMicActive == micIntent) {
            return
        }
        if (recoveryInFlight) {
            // Bridge.log("G2: recover($reason) skipped — already in flight")
            return
        }
        if (now - lastRecoveryRebuildMs < RECOVERY_DEBOUNCE_MS) {
            // Bridge.log("G2: recover($reason) skipped — debounced")
            return
        }
        recoveryInFlight = true
        lastRecoveryRebuildMs = now
        Bridge.log("G2: recover($reason) — rebuilding EvenHub page")
        displayScope.launch {
            rebuildState()
            DeviceManager.getInstance().sendCurrentState()
            recoveryInFlight = false
        }
    }

    /**
     * Push pending display state to the glasses: dirty text containers first (one updateText each,
     * with a redundant resend per [TextContainer.pendingSends]), then dirty image containers one at a
     * time. This awaits each [sendImageData] in turn, so image sends never overlap and the single
     * image-ACK slot is never clobbered. A failed image send leaves the container dirty for the next
     * cycle; if its bytes changed mid-send, the flag stays set so the newer image is sent next.
     */
    private suspend fun reconcileDisplay() {
        // Page is dead but content is waiting (e.g. captions kept arriving while we were suspended
        // and the firmware tore the session down). Rebuild the page ONCE here — the reconcile loop
        // is coalesced, so a burst of buffered sendText calls collapses into a single rebuild
        // instead of one shutdown/rebuild per caption. rebuildState() recreates the page, re-pushes
        // the current text/image, and re-arms the mic iff intent says so. Skip while the native
        // dashboard owns the screen.
        if (!pageCreated) {
            val useNativeDashboard = DeviceStore.get("bluetooth", "use_native_dashboard") as? Boolean ?: false
            // Only resurrect a dead page for MEANINGFUL content. A clearDisplay (blank " ") on an
            // already-dead page has nothing to show, so don't rebuild just to render blankness —
            // that would let a clear burst churn the page back up pointlessly.
            val hasPendingText = textContainers.any { it.pendingSends > 0 && it.content.isNotBlank() }
            val hasPendingImage = imageContainers.any { it.dirty && it.bmpData.isNotEmpty() }
            if ((hasPendingText || hasPendingImage) && !(useNativeDashboard && dashboardShowing > 0)) {
                Bridge.log("G2: reconcileDisplay() - page down with pending content, rebuilding once")
                rebuildState()
            }
            return
        }

        // Text: synchronous, no ACK. Send one update per container with pending sends and decrement.
        for (i in textContainers.indices) {
            if (textContainers[i].pendingSends <= 0) continue
            val container = textContainers[i]
            val msg =
                EvenHubProto.updateTextMessage(
                    containerID = container.id,
                    contentOffset = 0,
                    contentLength = container.content.toByteArray(Charsets.UTF_8).size,
                    content = container.content
                )
            sendEvenHubCommand(msg)
            textContainers[i].pendingSends -= 1
        }

        // Images: ACK-gated, exactly one in flight. Cap iterations defensively so a container that
        // keeps being re-dirtied mid-send can't spin this pass forever (next tick picks it up).
        var guardCount = 0
        while (pageCreated && guardCount < imageContainerIDPool.size) {
            val i = imageContainers.indexOfFirst { it.dirty }
            if (i < 0) break
            guardCount += 1
            val container = imageContainers[i]
            val sentBytes = container.bmpData
            // Empty + dirty means "just cleared": the firmware still shows the old image, so push an
            // all-black frame sized to the container to overwrite it on-glass (the page stays up — no
            // teardown, no mic churn). A container only reaches here when dirty, and clearDisplay is
            // the sole source of an empty-but-dirty container, so this fires exactly on a clear.
            if (sentBytes.isEmpty()) {
                val blank = blankBmp(container.width, container.height)
                if (blank != null) {
                    sendImageData(container.id, container.name, blank)
                }
                // Only settle the flag if it's still empty — a displayBitmap during the await would
                // have set new bytes, so leave it dirty for the next pass to send the real image.
                val jj = imageContainers.indexOfFirst { it.id == container.id }
                if (jj >= 0 && imageContainers[jj].bmpData.isEmpty()) {
                    imageContainers[jj].dirty = false
                }
                continue
            }
            sendImageData(container.id, container.name, sentBytes)
            // Re-find by id: the list may have shifted (eviction) during the await.
            val j = imageContainers.indexOfFirst { it.id == container.id }
            if (j >= 0 && imageContainers[j].bmpData.contentEquals(sentBytes)) {
                imageContainers[j].dirty = false
            }
        }
    }

    /**
     * Send a bitmap to an image container as fragmented updateImageRawData packets.
     *
     * One MapSessionId identifies the whole image transfer (constant across its fragments); the
     * glasses ACK EACH fragment with an ImgResCmd ErrorCode (4=success, 5=failed). Each fragment is
     * gated on its own ACK — correlated by (session, fragmentIndex) — before the next is sent, so
     * the ACK itself paces the transfer (no fixed inter-fragment delay). A `failed` ACK OR no ACK
     * within [IMG_ACK_TIMEOUT_MS] abandons the attempt and re-sends the entire image (fresh session
     * id) up to [IMG_MAX_ATTEMPTS] times. On exhausting all attempts it logs a warning and returns
     * (best-effort — callers are unaffected).
     *
     * Suspends until the image is acknowledged (or all attempts fail), so the 300ms settle in
     * [rebuildState] only runs once the transfer has fully resolved.
     */
    private suspend fun sendImageData(
        containerID: Int,
        containerName: String,
        bmpData: ByteArray
    ) {
        val fragmentSize = 4096
        val totalSize = bmpData.size
        val fragmentCount = (bmpData.size + fragmentSize - 1) / fragmentSize

        // skip if the image is empty:
        if (bmpData.size == 0) {
            return
        }

        // Bridge.log("G2: sendImageData($containerName) - $fragmentCount fragments, ${bmpData.size} bytes")

        for (attempt in 1..IMG_MAX_ATTEMPTS) {
            // One session id per WHOLE image transfer (per attempt). The glasses key their
            // reassembly buffer on MapSessionId, so every fragment reuses it with an incrementing
            // MapFragmentIndex. A retry uses a fresh session so a stale ACK from a prior attempt
            // can't match.
            imageSessionCounter = (imageSessionCounter + 1) % 256
            val sessionId = imageSessionCounter

            var fragmentIndex = 0
            var offset = 0
            var transferOk = true
            // if (attempt > 1) {
            //     Bridge.log("G2: sendImageData($containerName) - attempt $attempt starting")
            // }
            while (offset < bmpData.size) {
                val end = minOf(offset + fragmentSize, bmpData.size)
                val fragment = bmpData.copyOfRange(offset, end)

                val ack = CompletableDeferred<Boolean>()
                pendingImgAckSession = sessionId
                pendingImgAckFragment = fragmentIndex
                pendingImgAck = ack

                Bridge.log("G2: img_sen: session=$sessionId fragment=$fragmentIndex")

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

                // Gate on THIS fragment's ACK before sending the next (the ACK provides pacing).
                // null=timeout, false=img_failed → abandon the attempt and retry the whole image.
                val ok = withTimeoutOrNull(IMG_ACK_TIMEOUT_MS) { ack.await() }
                if (pendingImgAck === ack) {
                    pendingImgAck = null
                    pendingImgAckSession = null
                    pendingImgAckFragment = null
                }
                if (ok != true) {
                    val reason = if (ok == null) "timeout" else "img_failed"
                    // Bridge.log("G2: sendImageData($containerName) - attempt $attempt fragment $fragmentIndex failed ($reason)")
                    transferOk = false
                    break
                }
                fragmentIndex++
                offset = end
            }

            if (transferOk) {
                // Bridge.log("G2: img_sen: container=$containerName - success=true")
                return
            }
        }

        Bridge.log("G2: img_sen: sendImageData($containerName) - failed after $IMG_MAX_ATTEMPTS attempts")
    }

    /// Bring the Even Realities dashboard (the OS-level home/idle screen) to
    /// the foreground by tearing down whatever EvenHub page we currently own.
    /// The glasses fall back to the dashboard automatically when no page is up.
    override fun showDashboard() {
        Bridge.log("G2: showDashboard()")
        // Dashboard is open: a 0/1 flag (the old +=2/-=1 depth dance drifted >0 and wedged the
        // mic). dashboardOpening latches so the open-confirm 08011A00 doesn't trigger recovery.
        dashboardShowing = 1
        dashboardOpening = true
        val msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        evenHubMicActive = false // dashboard takes EvenHub focus; firmware kills the mic
        currentBitmapBase64 = ""
        mainHandler.postDelayed({
            // activate the dashboard by setting depth to the current setting:
            val currentDepth = DeviceStore.get("bluetooth", "dashboard_depth") as? Int ?: 0
            setDashboardDepthOnly(currentDepth)
        }, 500)
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

    /**
     * Bridge entry for `calendar_events` store updates. Each map is expected to match
     * the TS `CalendarEvent` shape: { title, location?, time, endDate } where `endDate`
     * is Unix seconds.
     *
     * Sends one BLE push per event, with `scheduleTotal` set to the batch size and
     * `scheduleNum` set to this event's 0-based slot. The widget pages through them on
     * the glasses — without paging info the firmware overwrites slot 0 on each push and
     * only the last event survives.
     */
    override fun sendCalendarEvents(events: List<Map<String, Any>>) {
        Bridge.log("G2: sendCalendarEvents -- ${events.size} events")
        if (events.isEmpty()) {
            sendDashboardCommand(
                CalendarProto.calendarClear(
                    magicRandom = sendManager.nextMagicRandom(),
                    packageId = 1,
                    scheduleAuthority = 1
                )
            )
            return
        }

        val total = events.size
        // Fold the local TZ offset into the timestamp so the glasses (which treat
        // timestamps as already-local) display the correct time — same hack as time-sync.
        val tzSec = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 1000
        events.forEachIndexed { i, ev ->
            val title = ev["title"] as? String ?: return@forEachIndexed
            val time = ev["time"] as? String ?: return@forEachIndexed
            val endTs = (ev["endDate"] as? Number)?.toLong() ?: return@forEachIndexed
            val location = ev["location"] as? String

            val payload =
                CalendarProto.calendarPush(
                    magicRandom = sendManager.nextMagicRandom(),
                    packageId = 1,
                    scheduleId = i + 1,
                    title = title,
                    location = location,
                    time = time,
                    endTimestamp = (endTs + tzSec).toInt(),
                    scheduleAuthority = 1,
                    scheduleTotal = total,
                    scheduleNum = i
                )
            sendDashboardCommand(payload)
        }
    }

    /**
     * Open the on-glasses notification panel — same effect as the user saying
     * "Hey Even, show notifications". Replicates the official-app voice flow:
     *   1. CTRL{status=ENTER}     — puts glasses in AI session
     *   2. ASK{text=" "}          — minimal ASR transcript to seed session context
     *   3. SKILL{skillId=NOTIFICATION, skillParam=show, ...} — dispatches the intent
     * The SKILL step alone is ignored by firmware; the preceding ENTER+ASK
     * supply the session context that lets the glasses act on the SKILL.
     */
    override suspend fun showNotificationsPanel() {
        Bridge.log("G2: showNotificationsPanel()")
        val enterPayload = EvenAIProto.aiCtrl(
            magicRandom = sendManager.nextMagicRandom(),
            status = 2 // EVEN_AI_ENTER
        )
        sendEvenAICommand(enterPayload)

        delay(400)
        val askPayload = EvenAIProto.aiAsk(
            magicRandom = sendManager.nextMagicRandom(),
            text = " ",
            streamEnable = 0
        )
        sendEvenAICommand(askPayload)

        delay(400)
        val skillPayload = EvenAIProto.triggerSkill(
            magicRandom = sendManager.nextMagicRandom(),
            skillId = 3, // NOTIFICATION
            skillParam = 1, // show
            text = " ",
            streamEnable = 1,
            fTextEnd = 1
        )
        sendEvenAICommand(skillPayload)
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

    private fun createPageWithContainers() {
        // Dedicated event-capture container: id 0, 1x1, borderless, empty — the
        // designated event-capture slot per the RE demos ("container 0 is
        // event-capture"). Touch events keep flowing through it, and no REAL
        // container carries the flag: marking whichever container happened to
        // be first painted a visible artifact once pages stopped being one
        // full-screen box (the stray persistent line).
        val textContainerProps: List<ByteArray> = ArrayList<ByteArray>(textContainers.size + 1).apply {
            add(
                EvenHubProto.textContainerProperty(
                    x = 0,
                    y = 0,
                    width = 1,
                    height = 1,
                    borderWidth = 0,
                    borderColor = 0,
                    borderRadius = 0,
                    paddingLength = 0,
                    containerID = 0,
                    containerName = "evt-0",
                    isEventCapture = true,
                    content = ""
                )
            )
            for (c in textContainers) {
                add(
                    EvenHubProto.textContainerProperty(
                        x = c.x,
                        y = c.y,
                        width = c.width,
                        height = c.height,
                        borderWidth = c.borderWidth,
                        borderColor = c.borderColor,
                        borderRadius = c.borderRadius,
                        paddingLength = c.paddingLength,
                        containerID = c.id,
                        containerName = c.name,
                        isEventCapture = false,
                        content = c.content
                    )
                )
            }
        }


        // iterate all image containers, remove any entries with duplicate ids or empty data,
        // and ensure the ids are still in the imageContainerIDPool:
        val seenIDs = mutableSetOf<Int>()
        imageContainers.retainAll { c ->
            if (c.bmpData.isEmpty()) {
                Bridge.log("G2: removing empty image container ${c.id}")
                return@retainAll false
            }
            if (!seenIDs.add(c.id)) {
                Bridge.log("G2: removing duplicate image container ${c.id}")
                return@retainAll false
            }
            imageContainerIDPool.contains(c.id)
        }

        // Build the page's image containers from the live tracked list.
        val imageContainerProps: List<ByteArray> =
            imageContainers.map { c ->
                EvenHubProto.imageContainerProperty(
                    x = c.x,
                    y = c.y,
                    width = c.width,
                    height = c.height,
                    containerID = c.id,
                    containerName = c.name
                )
            }

        val msg: ByteArray
        if (!pageCreated) {
            Bridge.log("G2: using createPageMessage (first time)")
            msg =
                EvenHubProto.createPageMessage(
                    textContainers = textContainerProps,
                    imageContainers = imageContainerProps,
                    magicRandom = sendManager.nextMagicRandom(),
                    appId = activeMenuAppId
                )
        } else {
            Bridge.log("G2: using rebuildPageMessage")
            msg =
                EvenHubProto.rebuildPageMessage(
                    textContainers = textContainerProps,
                    imageContainers = imageContainerProps,
                    magicRandom = sendManager.nextMagicRandom(),
                    appId = activeMenuAppId
                )
        }
        sendEvenHubCommand(msg)
        pageCreated = true
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

        // Bridge.log(
        //         "G2: convertToG2Bmp - input ${srcWidth}x${srcHeight} → scaled ${scaledW}x${scaledH} in ${containerWidth}x${containerHeight}"
        // )

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

    /**
     * Build an all-black BMP sized to a container. Sent to overwrite (and thus visually clear) an
     * image container without tearing the page down — on the green monochrome display, pixel 0 is
     * unlit, so an all-zero frame reads as blank. Used by the reconcile loop to clear a bitmap.
     */
    private fun blankBmp(width: Int, height: Int): ByteArray? {
        if (width <= 0 || height <= 0) return null
        val zeros = ByteArray(width * height)  // all-zero 8-bit grayscale = black
        return build4BitBmp(zeros, width, height)
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

        // Bridge.log(
        //         "G2: build4BitBmp - ${bmp.size()} bytes (header=$headerSize, pixels=$pixelDataSize, rows=${paddedRowSize}x$height)"
        // )
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

    private fun restartMicIfAlreadyEnabled() {
        val currentEnabled = DeviceStore.get("glasses", "micEnabled") as? Boolean ?: false
        if (currentEnabled) {
            restartMic()
        }
    }

    fun restartMic() {
        // Intent is "mic on". The mic only exists inside a live EvenHub page, so we toggle it
        // off then back on (the firmware needs the off→on edge to re-arm).
        DeviceStore.apply("glasses", "micEnabled", true)
        evenHubMicActive = false
        val msg = EvenHubProto.audioControlMessage(false)
        sendEvenHubCommand(msg)
        mainHandler.postDelayed({
            val useNativeDashboard = DeviceStore.get("bluetooth", "use_native_dashboard") as? Boolean ?: false
            // Bridge.log("G2: setMicEnabled - useNativeDashboard=$useNativeDashboard, dashboardShowing=$dashboardShowing")
            // Dashboard owns the screen + session right now — don't arm the mic into a page the
            // dashboard has taken over; recovery re-arms on dashboard close.
            if (useNativeDashboard && dashboardShowing > 0) {
                return@postDelayed
            }
            // Never send audioControl(enable=true) without a live page — no page means no mic.
            // Rebuild first, which itself re-arms the mic at the end (intent is on), so we're done.
            if (!pageCreated) {
                displayScope.launch {
                    rebuildState()
                    DeviceManager.getInstance().sendCurrentState()
                }
                return@postDelayed
            }
            val msg = EvenHubProto.audioControlMessage(true)
            sendEvenHubCommand(msg)
            evenHubMicActive = true
        }, 500)
    }

    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("G2: setMicEnabled($enabled)")
        if (enabled && !pageCreated) {
            restartMic()
            return
        }
        val currentEnabled = DeviceStore.get("glasses", "micEnabled") as? Boolean ?: false
        if (enabled && currentEnabled) {
            restartMic()
            return
        }

        DeviceStore.apply("glasses", "micEnabled", enabled)
        val msg = EvenHubProto.audioControlMessage(enabled)
        sendEvenHubCommand(msg)
        evenHubMicActive = enabled
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    // Camera & Media - G2 has no camera
    override fun requestPhoto(request: PhotoRequest) {
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

    override fun sendButtonVideoRecordingSettings() {
        Bridge.log("G2: sendButtonVideoRecordingSettings")
    }

    override fun sendButtonMaxRecordingTime() {
        Bridge.log("G2: sendButtonMaxRecordingTime")
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
        clearDisplay()
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
        imageContainers.clear()
        textContainers.clear()
        dashboardShowing = 0
        dashboardOpening = false
        heartbeatCounter = 0
        currentBitmapBase64 = ""
        menuAppIdToPackageName.clear()
        activeMenuAppId = null
        lastClickTimestamp = null
        lastMenuSelectTimestamp = null
        notificationCentreArmed = false
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "fullyBooted", false)
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
        rightFileWriteChar = null
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
        // showNotificationsPanel()
    }

    private var compassRunning = false

    override fun dbg2() {
        // compassRunning = !compassRunning
        // Bridge.log("G2: dbg2() — ${if (compassRunning) "start" else "stop"} compass")
        // if (compassRunning) {
        //     startCompass()
        // } else {
        //     stopCompass()
        // }
        displayScope.launch { runAuthSequence() }
    }

    /**
     * Start a navigation session so the glasses stream compass heading via
     * OS_NOTIFY_COMPASS_CHANGED — surfaced as `CompassHeadingEvent { heading: 0…359 }` in
     * handleNavigationResponse.
     *
     * If the magnetometer needs calibration, the glasses emit OS_NOTIFY_COMPASS_CALIBRATE_STRAT
     * (→ `CompassCalibrationEvent {status:"start"}`); the wearer should look around until
     * `…{status:"complete"}`.
     */
    fun startCompass() {
        val w = ProtobufWriter()
        w.writeInt32Field(1, NavigationCmd.APP_REQUEST_START_UP.value) // cmd
        w.writeInt32Field(2, sendManager.nextMagicRandom()) // magicRandom
        sendNavigationCommand(w.toByteArray())
    }

    /** Stop the navigation/compass session (ends heading streaming). */
    fun stopCompass() {
        val w = ProtobufWriter()
        w.writeInt32Field(1, NavigationCmd.APP_REQUEST_EXIT.value)
        w.writeInt32Field(2, sendManager.nextMagicRandom())
        sendNavigationCommand(w.toByteArray())
    }

    override suspend fun setImuEnabled(enabled: Boolean) {
        setImuEnabled(enabled, reportFrq = EvenHubProto.IMU_PACE_P100)
    }

    /**
     * Enable or disable IMU motion reporting on the glasses.
     *
     * When enabled, the glasses continuously push `IMU_Report_Data { x, y, z }` (32-bit floats,
     * gravity-normalized) via the EvenHub notify path; these surface in `handleTouchEvent` as a
     * Sys_ItemEvent with `eventType == IMU_DATA_REPORT (8)` and are emitted through
     * `Bridge.sendAccelEvent` (a single accelerometer reading; a richer combined IMU event
     * covering gyro + magnetometer is future work).
     */
    suspend fun setImuEnabled(enabled: Boolean, reportFrq: Int) {
        Bridge.log("G2: setImuEnabled($enabled, frq=$reportFrq)")

        // IMU requires an active EvenHub page (same prerequisite as the mic). Await the rebuild so
        // the control packet is sent only after the page actually exists — page creation is async
        // with variable delays, so a fixed wait could send too early and reporting would never start.
        if (enabled && !pageCreated) {
            rebuildState()
        }

        val msg =
            EvenHubProto.imuControlMessage(
                enable = enabled,
                reportFrq = reportFrq,
                magicRandom = sendManager.nextMagicRandom()
            )
        sendEvenHubCommand(msg)
    }

    fun reconnectController() {
        val mac = DeviceStore.get("glasses", "controllerMacAddress") as? String
        if (mac.isNullOrEmpty()) {
            Bridge.log("G2: reconnectController - no MAC address found")
            return
        }
        connectController()
    }

    override fun connectController() {
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            Bridge.log("G2: connectController - g2 not fully booted, ignoring")
            return
        }
        val mac = DeviceStore.get("glasses", "controllerMacAddress") as? String
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
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            Bridge.log("G2: disconnectController - g2 not fully booted, ignoring")
            return
        }
        val mac = DeviceStore.get("glasses", "controllerMacAddress") as? String
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
        // DeviceStore.apply("glasses", "controllerMacAddress", "")
        DeviceStore.apply("glasses", "controllerConnected", false)
        DeviceStore.apply("glasses", "controllerFullyBooted", false)
        Bridge.log("G2: Sent RING_DISCONNECT_INFO for MAC $mac")
    }

    // ---------- Native Notification Centre ----------

    /**
     * Set the notification centre's control plane: whether it's on, and whether the glasses filter
     * against the whitelist file they hold. Two commands with a gap — back-to-back writes on this
     * service have been seen to drop.
     */
    private suspend fun pinControlPlane(notifEnable: Int, whitelistDisable: Int) {
        Bridge.log("G2/NOTIF: pinning notifEnable=$notifEnable whitelistDisable=$whitelistDisable")
        sendToGlasses(
            sendManager.buildPackets(
                serviceId = ServiceID.NOTIFICATION.value,
                payload = NotificationProto.notificationCtrl(
                    magicRandom = sendManager.nextMagicRandom(),
                    notifEnable = notifEnable,
                    autoDispEnable = 1,
                    dispTime = 5,
                    avoidDisturbEnable = 0
                ),
                reserveFlag = true
            )
        )
        delay(400)
        sendToGlasses(
            sendManager.buildPackets(
                serviceId = ServiceID.NOTIFICATION.value,
                payload = NotificationProto.whitelistCtrl(
                    magicRandom = sendManager.nextMagicRandom(),
                    whitelistDisable = whitelistDisable
                ),
                reserveFlag = true
            )
        )
    }

    /**
     * Bounded hand-off from the Expo bridge thread to the BLE send loop. A push is three BLE round
     * trips serialized behind [fileTransferMutex] — seconds under display load — so an unbounded
     * queue would grow faster than it drains during a burst. DROP_OLDEST because a backlog of
     * stale notifications is worth less than the newest one.
     */
    private val notificationQueue =
        Channel<Map<String, Any>>(capacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    private var notificationPumpStarted = false

    /**
     * Whether THIS connection has had its notification centre switched on. Armed lazily on the
     * first push, so a user who never enables the feature never has these settings written;
     * cleared on disconnect and on a refused pin, since the glasses don't persist it and
     * re-arming is two writes.
     */
    @Volatile private var notificationCentreArmed = false

    /**
     * Push a phone notification into the G2's own notification centre. Runs in PARALLEL with the
     * normal MentraOS card — neither replaces nor suppresses it. Enqueue and return; the transfer
     * happens on [notificationQueue]'s consumer.
     */
    override fun sendPhoneNotification(notification: Map<String, Any>) {
        ensureNotificationPump()
        notificationQueue.trySend(notification)
    }

    /**
     * Start the single consumer coroutine, once. Synchronized because a racing check-then-set
     * would start two pumps, and two transfers would then interleave on the one ack slot.
     */
    @Synchronized
    private fun ensureNotificationPump() {
        if (notificationPumpStarted) return
        notificationPumpStarted = true
        displayScope.launch {
            for (notification in notificationQueue) {
                // One bad notification must not kill the pump for the process's lifetime.
                try {
                    pushNotificationToCentre(notification)
                } catch (e: Exception) {
                    Bridge.log("G2/NOTIF: push failed — ${e.message}")
                }
            }
        }
    }

    private suspend fun pushNotificationToCentre(notification: Map<String, Any>) {
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyBooted) {
            Bridge.log("G2/NOTIF: glasses not ready - dropping")
            return
        }

        if (!notificationCentreArmed) {
            // Set before the writes go out: a refusal can only arrive after its write, so the
            // clear-on-reject always lands after this set. Set after the pin instead, a refusal
            // arriving inside the pin's inter-write gap would be overwritten.
            notificationCentreArmed = true
            // whitelistDisable=1 turns off the on-glass per-app filter, which otherwise drops
            // every notification absent from the stored whitelist. We push no whitelist:
            // per-app filtering already happens phone-side in the notification listener.
            pinControlPlane(notifEnable = 1, whitelistDisable = 1)
            Bridge.log("G2/NOTIF: centre armed (on-glass filtering disabled)")
        }

        val packageName = notification["packageName"] as? String ?: ""
        val appName = notification["appName"] as? String ?: ""
        val title = notification["title"] as? String ?: ""
        val subtitle = notification["subtitle"] as? String ?: ""
        val body = notification["body"] as? String ?: ""
        // JS numbers cross the bridge as Double - `as? Long`/`as? Int` would silently null out.
        val timestampMs = (notification["timestampMs"] as? Number)?.toLong() ?: System.currentTimeMillis()
        val action = (notification["action"] as? Number)?.toInt() ?: 0
        val msgId = msgIdFor(notification["notificationId"] as? String ?: "")

        val bytes = NotificationJson.androidNotification(
            msgId = msgId,
            action = action,
            appIdentifier = packageName,
            title = title,
            subtitle = subtitle,
            message = body,
            postTimeMs = timestampMs,
            displayName = appName
        )

        // Length and package, never the text.
        Bridge.log("G2/NOTIF: pushing ${bytes.size}B from $packageName msgId=$msgId action=$action")
        val status =
            sendFile(FileService.TYPE_ANDROID_MSG_JSON_NOTIFICATION, FileService.PATH_NOTIFY, bytes)
        Bridge.log("G2/NOTIF: push -> ${status?.let(FileService::statusName) ?: "timeout"}")
    }

    /**
     * The glasses key notification cards on a numeric `msg_id`; the phone id is a string
     * ("$packageName-${sbn.key}"), so ids are minted here. The same phone id keeps the same
     * msg_id while it stays in the LRU: a notification re-posts under its id on update, and
     * reusing the msg_id makes the glasses replace the card in place rather than stack a
     * duplicate. Numeric phone ids pass straight through; an empty id gets a fresh mint, since
     * there is nothing to correlate on. Only touched from [notificationQueue]'s single consumer.
     */
    private val msgIdsByPhoneId =
        object : LinkedHashMap<String, Int>(32, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>) = size > 512
        }

    private fun msgIdFor(notificationId: String): Int {
        notificationId.toIntOrNull()?.let { return it }
        if (notificationId.isEmpty()) return mintMsgId()
        return msgIdsByPhoneId.getOrPut(notificationId) { mintMsgId() }
    }

    /**
     * Four digits like the captured ones — a wider field costs payload budget, and the firmware
     * has only been seen handling short ids. Minting skips ids still mapped to a phone id: the
     * counter wraps after 8000 mints while up to 512 mappings stay live, and a reused id would
     * make the glasses replace the wrong card. Any 513 consecutive candidates contain a free id.
     */
    private var syntheticMsgId = 2000

    private fun mintMsgId(): Int {
        repeat(msgIdsByPhoneId.size + 1) {
            val candidate = nextSyntheticMsgId()
            if (!msgIdsByPhoneId.containsValue(candidate)) return candidate
        }
        return nextSyntheticMsgId()
    }

    private fun nextSyntheticMsgId(): Int {
        syntheticMsgId = if (syntheticMsgId >= 9999) 2000 else syntheticMsgId + 1
        return syntheticMsgId
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
        val msg = EvenHubProto.shutdownMessage()
        sendEvenHubCommand(msg)
        pageCreated = false
        disconnect()
    }

    override fun sendReboot() {
        // TODO: Implement via dev_settings
    }

    /// Push the current time to the glasses. Useful after DST transitions,
    /// time-zone travel, or a long sleep where the glasses' clock has drifted.
    fun syncTime() {
        Bridge.log("G2: syncTime()")
        sendSetSystemTime(System.currentTimeMillis())
    }

    override fun sendSetSystemTime(timestampMs: Long) {
        Bridge.log("G2: sendSetSystemTime()")
        val msg = DevSettingsProto.timeSync(sendManager.nextMagicRandom(), timestampMs)
        sendDevSettingsCommand(msg, left = true, right = true)
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
        // G2 doesn't have RGB LEDs
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // ---------- SGCManager: Network (G2 has no WiFi) ----------

    override fun requestWifiScan(scanId: String?) {}
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
                                DeviceStore.apply("glasses", "leftMacAddress", mac)
                                DeviceStore.apply("glasses", "bluetoothMacAddress", mac)
                            } else if (name.contains("_R_")) {
                                DeviceStore.apply("glasses", "rightMacAddress", mac)
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

    override fun stopScan() {
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
                        rightFileWriteChar = null
                        leftAudioChar = null
                        rightAudioChar = null
                        authStarted = false
                        leftAuthenticated = false
                        rightAuthenticated = false

                        startupPageCreated = false
                        pageCreated = false
                        dashboardShowing = 0
                        dashboardOpening = false
                        notificationCentreArmed = false
                        DeviceStore.apply("glasses", "connected", false)
                        DeviceStore.apply("glasses", "fullyBooted", false)

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

                                G2BLE.FILE_WRITE -> {
                                    Bridge.log("G2: Found FILE WRITE char on $side")
                                    if (side != "LEFT") rightFileWriteChar = char
                                }

                                G2BLE.FILE_NOTIFY -> {
                                    Bridge.log("G2: Found FILE NOTIFY char on $side")
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
                        displayScope.launch { runAuthSequence() }
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
                    // File-service acks arrive on their own characteristic and share the standard
                    // transport framing, so they need no demux — just the usual decode.
                    G2BLE.FILE_NOTIFY -> mainHandler.post { handleNotifyData(data, sourceKey) }

                    G2BLE.AUDIO_NOTIFY -> handleAudioData(data, sourceKey)
                    G2BLE.CHAR_NOTIFY -> {
                        // Correlate an in-flight image ACK INLINE on the BLE callback thread, before
                        // posting the rest of the handling to the (potentially backed-up) main
                        // queue. This guarantees the ACK that sendImageData() is awaiting resolves
                        // promptly even while the main looper is busy draining a packet burst /
                        // heartbeats — the cause of the intermittent "glasses stopped responding".
                        correlateImageAck(data, sourceKey)
                        mainHandler.post { handleNotifyData(data, sourceKey) }
                    }
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

    /**
     * Resolve an in-flight image-fragment ACK directly from a raw notify packet, on the BLE
     * callback thread. This runs BEFORE [handleNotifyData] is posted to [mainHandler] so the ACK
     * that [sendImageData] is awaiting completes promptly even when the main looper is saturated by
     * a packet burst, heartbeats, or the text-queue tick — the root cause of the intermittent
     * "glasses stop responding to image sends".
     *
     * Deliberately a read-only, SINGLE-PACKET parse: it does NOT touch the stateful [receiveManager]
     * (that stays exclusively on the main thread). An ImgResCmd always fits in one BLE packet, so a
     * multi-packet frame (totalPackets > 1) is not an image ACK and is left entirely to the
     * main-thread path. Completing an already-completed CompletableDeferred is a no-op, so the
     * duplicate L/R ACK and the residual main-thread correlation are both harmless.
     */
    private fun correlateImageAck(rawData: ByteArray, @Suppress("UNUSED_PARAMETER") sourceKey: String) {
        // Fast path: only proceed if a transfer is actually outstanding.
        val ack = pendingImgAck ?: return
        if (rawData.size < 8) return
        if (rawData[0] != G2BLE.HEADER_BYTE) return

        val payloadLen = rawData[3].toInt() and 0xFF
        val expectedLen = payloadLen + 8
        if (rawData.size < expectedLen) return

        val totalPackets = rawData[4].toInt() and 0xFF
        val serialNum = rawData[5].toInt() and 0xFF
        val serviceId = rawData[6]
        val status = rawData[7].toInt() and 0xFF
        val resultCode = (status shr 1) and 0x0F
        if (resultCode != 0) return
        if (serviceId != ServiceID.EVEN_HUB.value) return
        // Single complete packet only (ImgResCmd never spans packets); else defer to main thread.
        if (totalPackets != 1 || serialNum != 1) return

        // Last packet carries a 2-byte CRC trailer; strip it from the payload.
        val payloadEnd = 8 + payloadLen - 2
        if (payloadEnd < 8 || payloadEnd > rawData.size) return
        val payload = rawData.copyOfRange(8, payloadEnd)

        val fields = ProtobufReader(payload).parseFields()
        val resData = fields[6] as? ByteArray ?: return // field 6 = ImgResCmd
        val resFields = ProtobufReader(resData).parseFields()
        val errorCode = resFields[8] as? Int ?: return
        val ackSession = resFields[3] as? Int ?: return
        val ackFragment = (resFields[6] as? Int) ?: 0
        Bridge.log("G2: img_res: session=$ackSession fragment=$ackFragment errorCode=$errorCode success=${errorCode == 4}")
        if (ackSession == pendingImgAckSession && ackFragment == pendingImgAckFragment) {
            ack.complete(errorCode == 4)
        }
    }

    private fun handleNotifyData(data: ByteArray, sourceKey: String) {
        val result = receiveManager.handlePacket(data, sourceKey) ?: return

        val serviceId = result.first
        val payload = result.second


        // print raw log, first 32 bytes:
        // Bridge.log("G2: handleNotifyData() - serviceId=$serviceId, payload=${payload.take(32).joinToString("") { String.format("%02X", it) }}")

        when (serviceId) {
            ServiceID.EVEN_HUB.value -> handleEvenHubResponse(payload)
            ServiceID.DEVICE_SETTINGS.value -> handleDevSettingsResponse(payload, sourceKey)
            ServiceID.G2_SETTING.value -> handleG2SettingResponse(payload)
            ServiceID.MENU.value -> handleMenuResponse(payload)
            ServiceID.DASHBOARD.value -> handleDashboardResponse(payload)
            ServiceID.GESTURE_CTRL.value -> handleGestureCtrl(payload)
            ServiceID.NAVIGATION.value -> handleNavigationResponse(payload)
            ServiceID.EVEN_AI.value -> handleEvenAIResponse(payload)
            ServiceID.EVEN_HUB_CTRL.value -> handleEvenHubCtrlResponse(payload)
            ServiceID.NOTIFICATION.value -> handleNotificationResponse(payload)
            ServiceID.FILE_CMD.value -> handleFileServiceResponse(payload)
            ServiceID.FILE_DATA.value -> handleFileServiceResponse(payload)
            else -> {
                Bridge.log(
                    "G2: Unhandled service ${serviceId.toInt() and 0xFF} (${payload.size} bytes): ${
                        payload.take(32).joinToString("") { String.format("%02X", it) }
                    }"
                )
            }
        }
    }

    /**
     * Even File Service acks. A real ack is **exactly two bytes** — `[cid][status]`. Resolves
     * whichever phase [sendFile] is waiting on.
     *
     * The size check is load-bearing: our own transmissions come back on this characteristic, and
     * with the transport header stripped they present as payloads starting with the very CID we
     * just sent. Accepting those as SUCCESS makes every phase pass unconditionally, including the
     * RESULT_CHECK that verifies the checksum.
     */
    private fun handleFileServiceResponse(payload: ByteArray) {
        if (payload.isEmpty()) {
            Bridge.log("G2/FILE: empty response")
            return
        }

        val cid = payload[0].toInt() and 0xFF
        if (payload.size != 2 || cid > FileService.CID_SEND_RESULT_CHECK) {
            Bridge.log("G2/FILE: ignoring ${payload.size}B frame — our own echo, not an ack")
            return
        }

        val status = payload[1].toInt() and 0xFF
        Bridge.log("G2/FILE: ACK cid=$cid status=$status (${FileService.statusName(status)})")

        if (pendingFileAckCid == cid) {
            pendingFileAck?.complete(status)
        } else {
            Bridge.log("G2/FILE: ack cid=$cid ignored — waiting on ${pendingFileAckCid ?: "nothing"}")
        }
    }

    /**
     * Notification service (0x04). Log-only — it acknowledges [pinControlPlane] and reports the
     * glasses' own notification activity; content never travels here. Field map in
     * `notes/g2-notification-service.md`.
     */
    private fun handleNotificationResponse(payload: ByteArray) {
        val fields = ProtobufReader(payload).parseFields()
        val cmd = fields[1] as? Int ?: -1
        val magic = fields[2] as? Int

        // COMM_RSP carries field 5 = {f1=commandId that failed, f2=errorCode}.
        var verdict = ""
        if (cmd == NotificationProto.CMD_COMM_RSP) {
            val rsp = (fields[5] as? ByteArray)?.let { ProtobufReader(it).parseFields() }
            val failedCmd = rsp?.get(1) as? Int
            val errorCode = rsp?.get(2) as? Int
            verdict =
                " REJECTED cmd=${failedCmd?.let { NotificationProto.cmdName(it) } ?: "?"}" +
                    " errorCode=$errorCode" +
                    (if (errorCode == 8) " (NOT_SUPPORT)" else "")
            // A refused pin means the centre is NOT armed, whatever the flag says; dropping the
            // latch makes the next push re-pin instead of pushing into a disabled centre forever.
            if (failedCmd == NotificationProto.CMD_CTRL ||
                failedCmd == NotificationProto.CMD_WHITELIST_CTRL
            ) {
                notificationCentreArmed = false
            }
        }

        Bridge.log(
            "G2/NOTIF: RX ${NotificationProto.cmdName(cmd)}" +
                (magic?.let { " magic=$it" } ?: "") +
                verdict
        )
    }

    /**
     * EvenAI service (0x07). Logs the decoded EvenAIDataPackage so we can read the CONFIG
     * (Hey Even) echo: commandId=10 (CONFIG), config sub-message in field 13.
     */
    private fun handleEvenAIResponse(payload: ByteArray) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()
        val cmd = fields[1] as? Int ?: -1
        val configData = fields[13] as? ByteArray
        if (cmd == 10 && configData != null) {
            val cReader = ProtobufReader(configData)
            val cFields = cReader.parseFields()
            val voiceSwitch = cFields[1] as? Int ?: 0 // omitted = 0 = OFF
            Bridge.log(
                "G2: EvenAI CONFIG echo — voiceSwitch=$voiceSwitch (${if (voiceSwitch == 1) "ON" else "OFF"}) config=$cFields"
            )
        } else {
            Bridge.log(
                "G2: EvenAI cmd=$cmd fields=${fields.keys.sorted()} raw=${
                    payload.joinToString("") {
                        String.format(
                            "%02X",
                            it
                        )
                    }
                }"
            )
        }
    }

    /**
     * Navigation service (0x08).
     *
     * OS_NOTIFY_COMPASS_CHANGED (15) carries the magnetometer heading in compass_info_msg
     * (field 10) → field 1, as whole degrees 0…359. (The proto names that field `compassIndex`,
     * but on the notify path it's the live heading — verified on-device: values sweep 0–359 as
     * the wearer turns.)
     */
    private fun handleNavigationResponse(payload: ByteArray) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()
        val cmd = fields[1] as? Int ?: return

        when (cmd) {
            NavigationCmd.OS_NOTIFY_COMPASS_CHANGED.value -> {
                val compassData = fields[10] as? ByteArray ?: return
                val cReader = ProtobufReader(compassData)
                val cFields = cReader.parseFields()
                val heading = cFields[1] as? Int ?: return
                // Heading in degrees, 0…359.
                Bridge.log("G2: compass heading=$heading°")
                Bridge.sendTypedMessage(
                    "CompassHeadingEvent",
                    mapOf(
                        "heading" to heading,
                        "timestamp" to System.currentTimeMillis()
                    )
                )
            }

            NavigationCmd.OS_NOTIFY_COMPASS_CALIBRATE_START.value -> {
                Bridge.log("G2: compass calibration started — wearer should look around")
                Bridge.sendTypedMessage("CompassCalibrationEvent", mapOf("status" to "start"))
            }

            NavigationCmd.OS_NOTIFY_COMPASS_CALIBRATE_COMPLETE.value -> {
                Bridge.log("G2: compass calibration complete")
                Bridge.sendTypedMessage("CompassCalibrationEvent", mapOf("status" to "complete"))
            }
        }
    }

    private fun handleEvenHubResponse(payload: ByteArray) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()

        // print raw payload:
        val payloadStr = payload.joinToString("") { String.format("%02X", it) }
        if (payloadStr.contains("080C7A02100C") || payloadStr.contains("080652020808")) {
            // heartbeat response
            return
        }
        Bridge.log("G2: res: ${payload.joinToString("") { String.format("%02X", it) }}")

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
            // NOTE: the per-fragment image ACK is correlated inline on the BLE callback thread in
            // correlateImageAck() (called before this runs is posted to the main looper) so it is
            // never delayed behind a saturated main queue. Nothing to do here for ImgResCmd.

            val timestamp = System.currentTimeMillis()
            val lastResponse = lastEvenHubResponseTimestamp
            if (lastResponse != null && timestamp - lastResponse < 100) {
                return
            }
            lastEvenHubResponseTimestamp = timestamp

            // If glasses sent a shutdown (cmd=9/10), our page is gone — reset state.
            if (cmdValue == 9 || cmdValue == 10) {
                Bridge.log("G2: ERROR: Glasses shutdown our EvenHub page — resetting page state")
                pageCreated = false
                evenHubMicActive = false // mic dies with the page
            }

            // Scan response fields for a shutdown/error code regardless of the debounce window.
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
                        pageCreated = false
                        evenHubMicActive = false // mic dies with the page
                    }
                }
            }

            // for (resField in listOf(4, 6, 8, 10)) {
            //     val resData = fields[resField] as? ByteArray ?: continue
            //     val resReader = ProtobufReader(resData)
            //     val resFields = resReader.parseFields()
            //     (resFields[8] as? Int)?.let { errorCode ->
            //         // ImgResCmd ErrorCode in field 8 (the sendImageData ACK is completed above,
            //         // before the dedup window — this is just the deduped logging path).
            //         if (errorCode == 4) {
            //             Bridge.log("G2: img_success")
            //         } else {
            //             Bridge.log("G2: EvenHub ImgRes errorCode=$errorCode")
            //         }
            //     }
            // }
        }
    }

    private fun setFullyConnected() {
        val isFullyConnected = DeviceStore.get("glasses", "connected") as? Boolean ?: false
        val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
        if (!isFullyConnected) {
            DeviceStore.apply("glasses", "connected", true)
        }
        if (!isFullyBooted) {
            DeviceStore.apply("glasses", "fullyBooted", true)
        }
    }

    private fun setControllerFullyConnected() {
        val isControllerConnected =
            DeviceStore.get("glasses", "controllerConnected") as? Boolean ?: false
        val isControllerFullyBooted =
            DeviceStore.get("glasses", "controllerFullyBooted") as? Boolean ?: false
        if (!isControllerConnected) {
            DeviceStore.apply("glasses", "controllerConnected", true)
        }
        if (!isControllerFullyBooted) {
            DeviceStore.apply("glasses", "controllerFullyBooted", true)
        }
    }

    /**
     * Parse an IMU_Report_Data sub-message: fields 1/2/3 = x/y/z as 32-bit floats (wire type 5).
     * `ProtobufReader.parseFields()` skips wire-type-5 fields, so this walks the bytes manually.
     */
    private fun parseImuReportData(data: ByteArray): Triple<Float, Float, Float>? {
        var x: Float? = null
        var y: Float? = null
        var z: Float? = null
        var i = 0
        while (i < data.size) {
            val tag = data[i].toInt() and 0xFF
            i += 1
            val fieldNum = tag shr 3
            val wireType = tag and 0x07
            if (wireType != 5 || data.size - i < 4) break
            var bits = 0
            for (b in 0 until 4) {
                bits = bits or ((data[i + b].toInt() and 0xFF) shl (8 * b)) // little-endian
            }
            i += 4
            val value = Float.fromBits(bits)
            when (fieldNum) {
                1 -> x = value
                2 -> y = value
                3 -> z = value
            }
        }
        val fx = x ?: return null
        val fy = y ?: return null
        val fz = z ?: return null
        return Triple(fx, fy, fz)
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

            // IMU data report: eventType == IMU_DATA_REPORT (8), imuData in field 3
            // (IMU_Report_Data { x, y, z } as 32-bit floats). Handle and return before the
            // gesture-mapping path.
            val imuData = sysFields[3] as? ByteArray
            if ((sysFields[1] as? Int) == OsEventType.IMU_DATA_REPORT.value && imuData != null) {
                val imu = parseImuReportData(imuData)
                if (imu != null) {
                    Bridge.log("G2: IMU data report: ${imu.first}, ${imu.second}, ${imu.third}")
                    Bridge.sendAccelEvent(imu.first, imu.second, imu.third, timestamp)
                    return
                }
            }

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
                val isHeadUp = DeviceStore.get("glasses", "headUp") as? Boolean ?: false

                val useNativeDashboard = DeviceStore.get("bluetooth", "use_native_dashboard") as? Boolean ?: false
                if (useNativeDashboard) {
                    showDashboard()
                } else {
                    // toggle head up:
                    DeviceStore.apply("glasses", "headUp", !isHeadUp)
                }
            }

            // System exit: the firmware killed our page (and the mic). ONLY mark state dead; do
            // NOT rebuild here. systemExit is fired alongside the dashboard-close (08011A00) event
            // for the same transition — if both rebuilt, the fresh page gets torn down again →
            // rebuild→exit→rebuild loop. Recovery is owned by one place: the dashboard-close
            // handler (and the reconcile page-down path). Don't touch micEnabled (user intent) —
            // recovery reads it to re-arm; clobbering it strands the mic.
            if (eventType == OsEventType.SYSTEM_EXIT || eventType == OsEventType.ABNORMAL_EXIT) {
                pageCreated = false
                evenHubMicActive = false // firmware killed the mic with the page
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
            OsEventType.IMU_DATA_REPORT -> null
            OsEventType.ABNORMAL_EXIT -> null // don't report abnormal exits as gestures
        }
    }

    private fun handleDevSettingsResponse(payload: ByteArray, sourceKey: String) {
        val reader = ProtobufReader(payload)
        val fields = reader.parseFields()
        val cmdValue = fields[1] as? Int ?: -1

        // Ignore heartbeat acks
        if (cmdValue == DevCfgCommandId.BASE_CONN_HEART_BEAT.value) return

        // Bridge.log(
        //         "G2: DevSettings response: ${payload.take(32).joinToString(":") { String.format("%02X", it) }}"
        // )

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
                    DeviceStore.apply("glasses", "controllerFullyBooted", true)
                }

                if ((ringFields[4] as? Int ?: 0) == 62) {
                    Bridge.log("G2: Ring maybe reconnected?")
                    DeviceStore.apply("glasses", "controllerFullyBooted", true)
                }

                val connStatus = ringFields[4] as? Int ?: -1
                // Bridge.log("G2: Ring connection status: connStatus?=$connStatus")

                if (connStatus == 22) {
                    Bridge.log("G2: Ring disconnected")
                    DeviceStore.apply("glasses", "controllerFullyBooted", false)
                    DeviceStore.apply("glasses", "controllerSearching", true)
                    reconnectController()
                }

                if (connStatus == 8) {
                    Bridge.log("G2: Ring maybe disconnected?")
                    // DeviceStore.apply("glasses", "controllerFullyBooted", false)
                    // DeviceStore.apply("glasses", "controllerSearching", true)
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
        // Dedup: L and R peripherals both deliver this event, so debounce within 500ms.
        val timestamp = System.currentTimeMillis()
        val last = lastGestureCtrlTimestamp
        if (last != null && timestamp - last < 500) {
            // Bridge.log("G2: gesture_ctrl dedup")
            return
        }
        lastGestureCtrlTimestamp = timestamp

        // 08011A00 is the dashboard open/close toggle — it fires on BOTH transitions. Use the
        // dashboardOpening latch (set by showDashboard) to tell them apart:
        //   • First event after showDashboard → OPEN confirm. Consume it, keep the dashboard up,
        //     do NOT recover (recovering rebuilds our page and snatches the screen back — the
        //     "double-tap flickers captions but never opens the dashboard" bug).
        //   • Next event → real CLOSE. Reset state and recover our page + mic.
        if (payload.contentEquals(byteArrayOf(0x08, 0x01, 0x1A, 0x00))) {
            Bridge.log("G2: dashboard toggle - dashboardShowing=$dashboardShowing opening=$dashboardOpening")
            if (dashboardOpening) {
                dashboardOpening = false // open confirmed; dashboard now owns the screen
                return
            }
            dashboardShowing = 0
            recoverPageAndMic("dashboard-close")
            return
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
                // Bridge.log("G2: Battery level: $battery%")
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
            // Bridge.log("G2: Left firmware: $leftVersion")
            DeviceStore.apply("glasses", "leftFirmwareVersion", leftVersion)
        }

        (fields[6] as? ByteArray)?.let { rightVer ->
            val rightVersion = String(rightVer, Charsets.UTF_8)
            // Bridge.log("G2: Right firmware: $rightVersion")
            DeviceStore.apply("glasses", "rightFirmwareVersion", rightVersion)
            DeviceStore.apply("glasses", "firmwareVersion", rightVersion)
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
        // Bridge.log("G2: audio data from $sourceKey: ${data.take(10).joinToString("") { String.format("%02X", it) }}")
        DeviceManager.getInstance().handleGlassesMicData(audioData, 40)
    }

    // ---------- Reconnection ----------

    private fun startReconnectionTimer() {
        reconnectionManager.start {
            val isFullyBooted = DeviceStore.get("glasses", "fullyBooted") as? Boolean ?: false
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
