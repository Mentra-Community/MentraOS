package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.SimulatedDisplayEvent
import com.mentra.bluetoothsdk.SimulatedDisplayEventKind
import com.mentra.bluetoothsdk.SimulatedGlasses
import com.mentra.bluetoothsdk.TouchGesture
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.MicTypes

class Simulated : SGCManager() {
    private val displayEvents = mutableListOf<SimulatedDisplayEvent>()

    init {
        type = DeviceTypes.SIMULATED
        DeviceStore.apply("glasses", "fullyBooted", true)
        DeviceStore.apply("glasses", "connected", true)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        DeviceStore.apply("glasses", "micEnabled", false)
        DeviceStore.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
        )
    }

    // Audio Control
    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("setMicEnabled")
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    // Camera & Media
    override fun uploadPhoto(request: PhotoRequest) {
        Bridge.log("uploadPhoto save=${request.save}, sound=${request.sound}")
    }

    override fun startStream(message: MutableMap<String, Any>) {
        Bridge.log("startStream")
    }

    override fun stopStream() {
        Bridge.log("stopStream")
    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("sendStreamKeepAlive")
    }

    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {
        Bridge.log("startVideoRecording sound=$sound")
    }

    override fun stopVideoRecording(requestId: String) {
        Bridge.log("stopVideoRecording")
    }

    // Button Settings
    override fun sendButtonPhotoSettings() {
        Bridge.log("sendButtonPhotoSettings")
    }

    override fun sendButtonVideoRecordingSettings() {
        Bridge.log("sendButtonVideoRecordingSettings")
    }

    override fun sendButtonMaxRecordingTime() {
        Bridge.log("sendButtonMaxRecordingTime")
    }

    override fun sendCameraFovSetting() {
        Bridge.log("sendCameraFovSetting")
    }

    // Display Control
    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("setBrightness")
    }

    override fun clearDisplay() {
        Bridge.log("clearDisplay")
        synchronized(displayEvents) {
            displayEvents.add(SimulatedDisplayEvent(kind = SimulatedDisplayEventKind.CLEAR))
        }
    }
    
    override fun sendText(text: String) {
        Bridge.log("sendText")
        synchronized(displayEvents) {
            displayEvents.add(SimulatedDisplayEvent(kind = SimulatedDisplayEventKind.TEXT, text = text))
        }
    }

    override fun sendTextWall(text: String) {
        Bridge.log("sendTextWall")
        synchronized(displayEvents) {
            displayEvents.add(SimulatedDisplayEvent(kind = SimulatedDisplayEventKind.TEXT_WALL, text = text))
        }
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("sendDoubleTextWall")
        synchronized(displayEvents) {
            displayEvents.add(
                SimulatedDisplayEvent(
                    kind = SimulatedDisplayEventKind.DOUBLE_TEXT_WALL,
                    top = top,
                    bottom = bottom,
                )
            )
        }
    }

    override fun displayBitmap(
            base64ImageData: String,
            x: Int?,
            y: Int?,
            width: Int?,
            height: Int?
    ): Boolean {
        Bridge.log("displayBitmap")
        synchronized(displayEvents) {
            displayEvents.add(
                SimulatedDisplayEvent(
                    kind = SimulatedDisplayEventKind.BITMAP,
                    base64ImageData = base64ImageData,
                )
            )
        }
        return false
    }

    override fun showDashboard() {
        Bridge.log("showDashboard")
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("setDashboardPosition")
    }

    // Device Control
    override fun setHeadUpAngle(angle: Int) {
        Bridge.log("setHeadUpAngle")
    }

    override fun getBatteryStatus() {
        Bridge.log("getBatteryStatus")
    }

    override fun setSilentMode(enabled: Boolean) {
        Bridge.log("setSilentMode")
    }

    override fun exit() {
        Bridge.log("exit")
    }

    override fun sendShutdown() {
        Bridge.log("sendShutdown - not supported on Simulated")
    }

    override fun sendReboot() {
        Bridge.log("sendReboot - not supported on Simulated")
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
        Bridge.log("sendRgbLedControl - not supported on Simulated")
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // Connection Management
    override fun disconnect() {
        Bridge.log("disconnect")
    }

    override fun forget() {
        Bridge.log("forget")
    }

    override fun findCompatibleDevices() {
        Bridge.log("findCompatibleDevices")
    }

    override fun stopScan() {
        Bridge.log("stopScan")
    }

    override fun connectById(id: String) {
    }

    override fun getConnectedBluetoothName(): String {
        return ""
    }

    override fun cleanup() {
        Bridge.log("cleanup")
    }

    override fun ping() {
        Bridge.log("ping")
    }

    override fun dbg1() {}
    override fun dbg2() {}

    // Network Management
    override fun requestWifiScan(scanId: String?) {
        Bridge.log("requestWifiScan")
    }

    override fun sendWifiCredentials(ssid: String, password: String) {
        Bridge.log("sendWifiCredentials")
    }

    override fun forgetWifiNetwork(ssid: String) {
        Bridge.log("forgetWifiNetwork: $ssid")
    }

    override fun sendHotspotState(enabled: Boolean) {
        Bridge.log("sendHotspotState")
    }

    override fun sendUserEmailToGlasses(email: String) {
        Bridge.log("sendUserEmailToGlasses: $email")
    }

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {
        Bridge.log("sendIncidentId: $incidentId")
    }

    // Gallery
    override fun queryGalleryStatus() {
        Bridge.log("queryGalleryStatus")
    }

    override fun sendGalleryMode() {
        Bridge.log("SIMULATED: 📸 Received gallery mode")
    }

    // Version info
    override fun requestVersionInfo() {
        Bridge.log("SIMULATED: 📱 Requesting version info (no-op)")
    }

    /** Returns a public scriptable handle bound to this simulated manager. */
    fun snapshot(): SimulatedGlasses = object : SimulatedGlasses {
        override fun displayTranscript(): List<SimulatedDisplayEvent> =
            synchronized(displayEvents) { displayEvents.toList() }

        override fun clearDisplayTranscript() {
            synchronized(displayEvents) { displayEvents.clear() }
        }

        override fun injectMicPcm(pcm: ByteArray) {
            Bridge.sendMicPcm(pcm, MicTypes.GLASSES_CUSTOM)
        }

        override fun injectTouch(gesture: TouchGesture) {
            Bridge.sendTouchEvent(
                DeviceTypes.SIMULATED,
                gesture.wireName,
                System.currentTimeMillis(),
            )
        }

        override fun injectHeadUp(headUp: Boolean) {
            Bridge.sendHeadUp(headUp)
        }

        override fun simulateDisconnect() {
            DeviceStore.apply("glasses", "connected", false)
            DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
        }

        override fun simulateReconnect() {
            DeviceStore.apply("glasses", "connected", true)
            DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            DeviceStore.apply("glasses", "fullyBooted", true)
        }
    }
}
