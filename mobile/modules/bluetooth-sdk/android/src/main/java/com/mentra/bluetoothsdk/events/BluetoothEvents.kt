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

data class MicHealthEvent(
    val reason: String,
    val sequenceGapEvents: Long,
    val decodeFailures: Long,
    val lastLc3ReceivedAt: Long?,
    val lastPcmProducedAt: Long?,
    val timestamp: Long,
    val values: Map<String, Any>,
) {
    companion object {
        internal fun fromMap(values: Map<String, Any>): MicHealthEvent =
            MicHealthEvent(
                reason = stringValue(values, "reason") ?: "",
                sequenceGapEvents = longValue(values, "sequenceGapEvents") ?: 0,
                decodeFailures = longValue(values, "decodeFailures") ?: 0,
                lastLc3ReceivedAt = longValue(values, "lastLc3ReceivedAt"),
                lastPcmProducedAt = longValue(values, "lastPcmProducedAt"),
                timestamp = longValue(values, "timestamp") ?: System.currentTimeMillis(),
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

data class OtaQueryResult(
    val values: Map<String, Any>,
) {
    val type: String get() = stringValue(values, "type").orEmpty()
    val status: String? get() = stringValue(values, "status")
}

data class SettingsAckEvent(
    val values: Map<String, Any>,
) {
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val setting: String get() = stringValue(values, "setting").orEmpty()
    val status: String get() = stringValue(values, "status") ?: "applied"
    val timestamp: Long get() = longValue(values, "timestamp") ?: System.currentTimeMillis()
    val fov: Int? get() = numberValue(values, "fov")
    val roiPosition: Int? get() = numberValue(values, "roiPosition", "roi_position")
    val hardwareApplied: Boolean get() = boolValue(values, "hardwareApplied", "hardware_applied") ?: false
    val errorCode: String? get() = stringValue(values, "errorCode")
    val errorMessage: String? get() = stringValue(values, "errorMessage")
}

data class RgbLedControlResponseEvent(
    val values: Map<String, Any>,
) {
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val state: String get() = stringValue(values, "state") ?: "error"
    val errorCode: String? get() = stringValue(values, "errorCode")
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
    fun onPhotoStatus(event: PhotoStatusEvent) {}
    fun onCameraStatus(event: CameraStatusEvent) {}
    fun onVideoRecordingStatus(event: VideoRecordingStatusEvent) {}
    fun onMediaUpload(event: MediaUploadEvent) {}
    fun onRgbLedControlResponse(event: RgbLedControlResponseEvent) {}
    fun onStreamStatus(event: StreamStatusEvent) {}
    fun onKeepAliveAck(event: KeepAliveAckEvent) {}
    fun onOtaStartAck(event: OtaStartAckEvent) {}
    fun onOtaStatus(event: OtaStatusEvent) {}
    fun onSettingsAck(event: SettingsAckEvent) {}
    fun onVersionInfo(event: VersionInfoResult) {}
    fun onMicPcm(event: MicPcmEvent) {}
    fun onMicLc3(event: MicLc3Event) {}
    fun onMicHealth(event: MicHealthEvent) {}
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: Device?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener
