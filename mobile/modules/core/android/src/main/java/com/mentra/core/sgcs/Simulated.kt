package com.mentra.core.sgcs

import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import com.mentra.core.utils.ConnTypes
import com.mentra.core.utils.DeviceTypes
import com.mentra.core.GlassesStore

class Simulated : SGCManager() {

    init {
        type = DeviceTypes.SIMULATED
        GlassesStore.apply("glasses", "fullyBooted", true)
        GlassesStore.apply("glasses", "connected", true)
        GlassesStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
        GlassesStore.apply("glasses", "micEnabled", false)
    }

    // Audio Control
    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("setMicEnabled")
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    // Camera & Media
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
        Bridge.log("requestPhoto flash=$flash, sound=$sound")
    }

    override fun startRtmpStream(message: MutableMap<String, Any>) {
        Bridge.log("startRtmpStream")
    }

    override fun stopRtmpStream() {
        Bridge.log("stopRtmpStream")
    }

    override fun sendRtmpKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("sendRtmpKeepAlive")
    }

    override fun startBufferRecording() {
        Bridge.log("startBufferRecording")
    }

    override fun stopBufferRecording() {
        Bridge.log("stopBufferRecording")
    }

    override fun saveBufferVideo(requestId: String, durationSeconds: Int) {
        Bridge.log("saveBufferVideo")
    }

    override fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) {
        Bridge.log("startVideoRecording flash=$flash, sound=$sound")
    }

    override fun stopVideoRecording(requestId: String) {
        Bridge.log("stopVideoRecording")
    }

    // Button Settings
    override fun sendButtonPhotoSettings() {
        Bridge.log("sendButtonPhotoSettings")
    }

    override fun sendButtonModeSetting() {
        Bridge.log("sendButtonModeSetting")
    }

    override fun sendButtonVideoRecordingSettings() {
        Bridge.log("sendButtonVideoRecordingSettings")
    }

    override fun sendButtonMaxRecordingTime() {
        Bridge.log("sendButtonMaxRecordingTime")
    }

    override fun sendButtonCameraLedSetting() {
        Bridge.log("sendButtonCameraLedSetting")
    }

    // Display Control
    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("setBrightness")
    }

    override fun clearDisplay() {
        Bridge.log("clearDisplay")
    }

    override fun sendTextWall(text: String) {
        Bridge.log("sendTextWall")
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("sendDoubleTextWall")
    }

    override fun displayBitmap(base64ImageData: String): Boolean {
        Bridge.log("displayBitmap")
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
            ontime: Int,
            offtime: Int,
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

    // Network Management
    override fun requestWifiScan() {
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

    override fun sendIncidentId(incidentId: String) {
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
}
