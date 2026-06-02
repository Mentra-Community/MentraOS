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

data class OtaUpdateAvailableEvent(
    val versionCode: Long?,
    val versionName: String?,
    val updates: List<String>,
    val totalSize: Long?,
    val cacheReady: Boolean?,
    val values: Map<String, Any>,
) {
    companion object {
        internal fun fromMap(values: Map<String, Any>): OtaUpdateAvailableEvent =
            OtaUpdateAvailableEvent(
                versionCode = longValue(values, "version_code"),
                versionName = stringValue(values, "version_name"),
                updates = (values["updates"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
                totalSize = longValue(values, "total_size"),
                cacheReady = boolValue(values, "cache_ready"),
                values = values,
            )
    }
}

data class OtaStartAckEvent(
    val timestamp: Long?,
    val values: Map<String, Any>,
) {
    companion object {
        internal fun fromMap(values: Map<String, Any>): OtaStartAckEvent =
            OtaStartAckEvent(
                timestamp = longValue(values, "timestamp"),
                values = values,
            )
    }
}

data class OtaStatusEvent(
    val sessionId: String,
    val totalSteps: Int,
    val currentStep: Int,
    val stepType: String,
    val phase: String,
    val stepPercent: Int,
    val overallPercent: Int,
    val status: String,
    val errorMessage: String?,
    val glassesTimeMs: Long?,
    val values: Map<String, Any>,
) {
    companion object {
        internal fun fromMap(values: Map<String, Any>): OtaStatusEvent =
            OtaStatusEvent(
                sessionId = stringValue(values, "session_id") ?: "",
                totalSteps = numberValue(values, "total_steps") ?: 0,
                currentStep = numberValue(values, "current_step") ?: 0,
                stepType = stringValue(values, "step_type") ?: "",
                phase = stringValue(values, "phase") ?: "",
                stepPercent = numberValue(values, "step_percent") ?: 0,
                overallPercent = numberValue(values, "overall_percent") ?: 0,
                status = stringValue(values, "status") ?: "",
                errorMessage = stringValue(values, "error_message"),
                glassesTimeMs = longValue(values, "glasses_time_ms"),
                values = values,
            )
    }
}

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
    fun onOtaUpdateAvailable(event: OtaUpdateAvailableEvent) {}
    fun onOtaStartAck(event: OtaStartAckEvent) {}
    fun onOtaStatus(event: OtaStatusEvent) {}
    fun onMicPcm(event: MicPcmEvent) {}
    fun onMicLc3(event: MicLc3Event) {}
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: Device?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener
