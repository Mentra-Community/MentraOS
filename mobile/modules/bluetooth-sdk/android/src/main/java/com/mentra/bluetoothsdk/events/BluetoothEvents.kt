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

data class WipeMediaResultEvent(
    val success: Boolean,
    val values: Map<String, Any>,
) {
    val requestId: String? get() = values["request_id"] as? String
    val transferId: String? get() = values["transfer_id"] as? String
    val error: String? get() = values["error"] as? String
}

data class PairingTransferResultEvent(
    val transferId: String,
    val operation: String,
    val success: Boolean,
    val values: Map<String, Any>,
) {
    val state: Int? get() = (values["state"] as? Number)?.toInt()
    val error: String? get() = values["error"] as? String
    val binding: String? get() = values["binding"] as? String
    val protocolVersion: Int? get() = (values["protocol_version"] as? Number)?.toInt()
}

/**
 * Response to a `pairing_transfer_status` query — the current state of an in-flight or
 * completed secure pairing transfer, queried without finalizing or aborting it. Used to
 * recover after finalize/abort times out on the phone side.
 */
data class PairingTransferStatusEvent(
    val transferId: String,
    val state: String,
    val values: Map<String, Any>,
) {
    val terminalOperation: String? get() = values["terminal_operation"] as? String
    val binding: String? get() = values["binding"] as? String
    val credentialCleanupPending: Boolean? get() = values["credential_cleanup_pending"] as? Boolean
    val protocolVersion: Int? get() = (values["protocol_version"] as? Number)?.toInt()
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
    fun onLocalTranscription(event: LocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: Device?) {}
    fun onLog(message: String) {}
    fun onError(error: BluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener
