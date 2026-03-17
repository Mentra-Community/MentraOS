package com.mentra.core.sgcs

import com.mentra.core.Bridge
import com.mentra.core.utils.DeviceTypes

/**
 * Even Realities G2 Smart Glasses Communicator (Android)
 *
 * Stub implementation - BLE connection and EvenHub protocol TBD.
 * G2 uses dual-sided BLE (L+R) with EvenHub protobuf protocol.
 *
 * TODO: Implement with Nordic BLE Library (no.nordicsemi.android:ble)
 */
class G2 : SGCManager() {

    init {
        type = DeviceTypes.G2
        hasMic = true
    }

    // Audio Control
    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("G2: setMicEnabled $enabled")
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

    override fun startRtmpStream(message: MutableMap<String, Any>) {
        Bridge.log("G2: startRtmpStream - not supported")
    }

    override fun stopRtmpStream() {
        Bridge.log("G2: stopRtmpStream - not supported")
    }

    override fun sendRtmpKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("G2: sendRtmpKeepAlive - not supported")
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

    // Display Control
    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("G2: setBrightness level=$level auto=$autoMode")
        // TODO: Send EvenHub brightness command
    }

    override fun clearDisplay() {
        Bridge.log("G2: clearDisplay")
        // TODO: Send EvenHub SHUTDOWN_PAGE
    }

    override fun sendTextWall(text: String) {
        Bridge.log("G2: sendTextWall")
        // TODO: Send EvenHub CREATE_STARTUP_PAGE with TextContainer
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("G2: sendDoubleTextWall")
        // TODO: Send EvenHub CREATE_STARTUP_PAGE with two TextContainers
    }

    override fun displayBitmap(base64ImageData: String): Boolean {
        Bridge.log("G2: displayBitmap")
        // TODO: Send EvenHub ImageContainer with 4-bit BMP
        return false
    }

    override fun showDashboard() {
        Bridge.log("G2: showDashboard")
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("G2: setDashboardPosition")
    }

    // Device Control
    override fun setHeadUpAngle(angle: Int) {
        Bridge.log("G2: setHeadUpAngle")
    }

    override fun getBatteryStatus() {
        Bridge.log("G2: getBatteryStatus")
        // TODO: Request battery status via EvenHub
    }

    override fun setSilentMode(enabled: Boolean) {
        Bridge.log("G2: setSilentMode")
    }

    override fun exit() {
        Bridge.log("G2: exit")
    }

    override fun sendShutdown() {
        Bridge.log("G2: sendShutdown")
    }

    override fun sendReboot() {
        Bridge.log("G2: sendReboot")
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
        Bridge.log("G2: sendRgbLedControl - not supported")
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    // Connection Management
    override fun disconnect() {
        Bridge.log("G2: disconnect")
        // TODO: Disconnect both L+R BLE connections
    }

    override fun forget() {
        Bridge.log("G2: forget")
        // TODO: Clear saved device addresses
    }

    override fun findCompatibleDevices() {
        Bridge.log("G2: findCompatibleDevices")
        // TODO: Scan for G2 devices (L+R pattern)
    }

    override fun connectById(id: String) {
        Bridge.log("G2: connectById $id")
        // TODO: Connect to both L+R glasses
    }

    override fun getConnectedBluetoothName(): String {
        return ""
    }

    override fun cleanup() {
        Bridge.log("G2: cleanup")
    }

    override fun ping() {
        Bridge.log("G2: ping")
    }

    // Network Management - G2 has no WiFi
    override fun requestWifiScan() {
        Bridge.log("G2: requestWifiScan - not supported")
    }

    override fun sendWifiCredentials(ssid: String, password: String) {
        Bridge.log("G2: sendWifiCredentials - not supported")
    }

    override fun forgetWifiNetwork(ssid: String) {
        Bridge.log("G2: forgetWifiNetwork - not supported")
    }

    override fun sendHotspotState(enabled: Boolean) {
        Bridge.log("G2: sendHotspotState - not supported")
    }

    override fun sendUserEmailToGlasses(email: String) {
        Bridge.log("G2: sendUserEmailToGlasses")
    }

    // Gallery
    override fun queryGalleryStatus() {
        Bridge.log("G2: queryGalleryStatus - not supported")
    }

    override fun sendGalleryMode() {
        Bridge.log("G2: sendGalleryMode - not supported")
    }

    // Version info
    override fun requestVersionInfo() {
        Bridge.log("G2: requestVersionInfo")
        // TODO: Request version via EvenHub
    }

    override fun sendIncidentId(incidentId: String) {
        Bridge.log("G2: sendIncidentId $incidentId")
    }
}
