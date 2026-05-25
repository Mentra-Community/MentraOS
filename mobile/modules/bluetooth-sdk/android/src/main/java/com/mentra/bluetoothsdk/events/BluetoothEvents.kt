package com.mentra.bluetoothsdk

data class ButtonPressEvent(
    val buttonId: String,
    val pressType: String,
    val timestamp: Long? = null,
)

data class TouchEvent(
    val values: Map<String, Any>,
) {
    val deviceModel: String? get() = stringValue(values, "deviceModel")
    val gestureName: String? get() = stringValue(values, "gestureName")
    val timestamp: Long? get() = longValue(values, "timestamp")
    val isSwipe: Boolean get() = gestureName?.contains("swipe", ignoreCase = true) == true
}

data class SwipeEvent(
    val values: Map<String, Any>,
) {
    val deviceModel: String? get() = stringValue(values, "deviceModel")
    val gestureName: String? get() = stringValue(values, "gestureName")
    val timestamp: Long? get() = longValue(values, "timestamp")
}

data class BatteryStatusEvent(
    val level: Int?,
    val charging: Boolean?,
    val values: Map<String, Any>,
)

data class VoiceActivityDetectionStatusEvent(
    val voiceActivityDetectionEnabled: Boolean,
    val values: Map<String, Any>,
)

data class SpeakingStatusEvent(
    val speaking: Boolean,
    val values: Map<String, Any>,
)

interface MentraBluetoothSdkListener {
    fun onStateChanged(state: MentraBluetoothState) {}
    fun onGlassesChanged(glasses: GlassesRuntimeState) {}
    fun onSdkStateChanged(sdk: PhoneSdkRuntimeState) {}
    fun onScanChanged(scan: BluetoothScanState) {}
    fun onDeviceDiscovered(device: Device) {}
    fun onScanStopped(reason: ScanStopReason) {}
    fun onButtonPress(event: ButtonPressEvent) {}
    fun onTouch(event: TouchEvent) {}
    fun onSwipe(event: SwipeEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onVoiceActivityDetectionStatus(event: VoiceActivityDetectionStatusEvent) {}
    fun onSpeakingStatus(event: SpeakingStatusEvent) {}
    fun onBatteryStatus(event: BatteryStatusEvent) {}
    fun onWifiStatusChanged(event: WifiStatusEvent) {}
    fun onHotspotStatusChanged(event: HotspotStatusEvent) {}
    fun onHotspotError(event: HotspotErrorEvent) {}
    fun onGalleryStatus(event: GalleryStatusEvent) {}
    fun onPhotoResponse(event: PhotoResponseEvent) {}
    fun onStreamStatus(event: StreamStatusEvent) {}
    fun onKeepAliveAck(event: KeepAliveAckEvent) {}
    fun onMicPcm(event: MicPcmEvent) {}
    fun onMicLc3(event: MicLc3Event) {}
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: Device?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener
