package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes

data class MentraBluetoothSdkConfig(
    val deliverCallbacksOnMainThread: Boolean = true,
    val scanNoResultsDiagnosticDelayMs: Long = 5_000L,
)

enum class MentraDeviceModel(val deviceType: String) {
    G1(DeviceTypes.G1),
    G2(DeviceTypes.G2),
    MENTRA_LIVE(DeviceTypes.LIVE),
    MENTRA_NEX(DeviceTypes.NEX),
    MACH1(DeviceTypes.MACH1),
    Z100(DeviceTypes.Z100),
    FRAME(DeviceTypes.FRAME),
    SIMULATED(DeviceTypes.SIMULATED),
    R1(ControllerTypes.R1);

    companion object {
        @JvmStatic
        fun fromDeviceType(deviceType: String?): MentraDeviceModel =
            values().firstOrNull { it.deviceType == deviceType } ?: MENTRA_LIVE
    }
}

data class MentraDiscoveredDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String? = null,
    val rssi: Int? = null,
)

data class MentraPairedDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String? = null,
)

data class MentraKnownDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String,
    val bonded: Boolean,
    val connected: Boolean,
)

data class MentraGlassesStatus(
    val values: Map<String, Any>,
)

data class MentraBluetoothStatus(
    val values: Map<String, Any>,
)

data class MentraGlassesStatusUpdate(
    val values: Map<String, Any>,
)

data class MentraBluetoothStatusUpdate(
    val values: Map<String, Any>,
)

data class MentraDisplayTextRequest(
    val text: String,
    val x: Int = 0,
    val y: Int = 0,
    val size: Int = 24,
) {
    fun toMap(): Map<String, Any> =
        mapOf(
            "text" to text,
            "x" to x,
            "y" to y,
            "size" to size,
        )
}

data class MentraDisplayEventRequest(
    val values: Map<String, Any>,
) {
    fun toMap(): Map<String, Any> = values
}

data class MentraDashboardPositionRequest(
    val height: Int,
    val depth: Int,
)

data class MentraDashboardMenuItem(
    val title: String,
    val packageName: String,
    val values: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> =
        values + mapOf(
            "title" to title,
            "packageName" to packageName,
        )
}

enum class MentraGalleryMode {
    AUTO,
    MANUAL,
}

enum class MentraButtonMode(val value: String) {
    PHOTO("photo"),
    VIDEO("video"),
    NONE("none"),
}

enum class MentraPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
}

data class MentraButtonPhotoSettings(
    val size: MentraPhotoSize,
)

data class MentraButtonVideoRecordingSettings(
    val width: Int,
    val height: Int,
    val fps: Int,
)

enum class MentraCameraFov(val fov: Int, val roiPosition: Int) {
    STANDARD(118, 0),
    WIDE(118, 0),
}

data class MentraMicConfig(
    val sendPcmData: Boolean,
    val sendTranscript: Boolean,
    val bypassVad: Boolean,
    val sendLc3Data: Boolean = false,
)

enum class MentraMicPreference(val value: String) {
    AUTO("auto"),
    PHONE("phone"),
    GLASSES("glasses"),
    BT_CLASSIC("btclassic"),
    BT("bt"),
}

data class MentraPhotoRequest(
    val requestId: String,
    val appId: String,
    val size: String,
    val webhookUrl: String,
    val authToken: String,
    val compress: String,
    val flash: Boolean,
    val sound: Boolean,
)

data class MentraStreamRequest(
    val values: Map<String, Any>,
)

data class MentraStreamKeepAliveRequest(
    val values: Map<String, Any>,
)

data class MentraVideoRecordingRequest(
    val requestId: String,
    val save: Boolean,
    val flash: Boolean,
    val sound: Boolean,
)

data class MentraButtonPressEvent(
    val buttonId: String,
    val pressType: String,
    val timestamp: Long? = null,
)

data class MentraTouchEvent(
    val values: Map<String, Any>,
)

data class MentraBatteryStatusEvent(
    val level: Int?,
    val charging: Boolean?,
    val values: Map<String, Any>,
)

data class MentraWifiStatusEvent(
    val values: Map<String, Any>,
)

data class MentraGalleryStatusEvent(
    val values: Map<String, Any>,
)

data class MentraPhotoResponseEvent(
    val values: Map<String, Any>,
)

data class MentraStreamStatusEvent(
    val values: Map<String, Any>,
)

data class MentraLocalTranscriptionEvent(
    val text: String,
    val isFinal: Boolean,
    val values: Map<String, Any>,
)

data class MentraBluetoothError(
    val code: String,
    val message: String,
    val cause: Throwable? = null,
    val values: Map<String, Any> = emptyMap(),
)

enum class MentraScanStopReason {
    COMPLETED,
    CANCELLED,
    ERROR,
}

interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDiscoveredDevice) {}
    fun onScanStopped(reason: MentraScanStopReason) {}
    fun onButtonPress(event: MentraButtonPressEvent) {}
    fun onTouch(event: MentraTouchEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: MentraBatteryStatusEvent) {}
    fun onWifiStatusChanged(event: MentraWifiStatusEvent) {}
    fun onGalleryStatus(event: MentraGalleryStatusEvent) {}
    fun onPhotoResponse(event: MentraPhotoResponseEvent) {}
    fun onStreamStatus(event: MentraStreamStatusEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: MentraPairedDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: MentraBluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener
