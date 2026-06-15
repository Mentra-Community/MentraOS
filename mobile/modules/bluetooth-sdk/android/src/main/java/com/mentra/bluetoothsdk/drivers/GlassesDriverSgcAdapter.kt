package com.mentra.bluetoothsdk.drivers

import com.mentra.bluetoothsdk.sgcs.SGCManager

/**
 * Bridges a public [GlassesDriver] onto the internal [SGCManager] so the rest of
 * the app (DeviceManager, etc.) is unchanged. Public commands delegate to the
 * driver (respecting nothing here — capability gating is the caller's job for
 * now); app-internal/no-op members are supplied here so a driver never has to
 * implement them. See docs/device-driver-contract.md §5.
 */
class GlassesDriverSgcAdapter(
    private val driver: GlassesDriver,
    private val host: DeviceHost,
) : SGCManager() {

    init {
        type = driver.deviceType
        hasMic = driver.capabilities.hasMic
        host.reset()
        driver.start(host)
    }

    // ---- audio ----
    override fun setMicEnabled(enabled: Boolean) = driver.setMicEnabled(enabled)
    override fun sortMicRanking(list: MutableList<String>): MutableList<String> = driver.sortMicRanking(list)
    override suspend fun setImuEnabled(enabled: Boolean) = driver.setImuEnabled(enabled)

    // ---- camera / media ----
    override fun requestPhoto(
        requestId: String, appId: String, size: String, webhookUrl: String?, authToken: String?,
        compress: String?, flash: Boolean, save: Boolean, sound: Boolean, exposureTimeNs: Long?, iso: Int?,
    ) = driver.requestPhoto(requestId, appId, size, webhookUrl, authToken, compress, flash, save, sound, exposureTimeNs, iso)
    override fun startStream(message: MutableMap<String, Any>) = driver.startStream(message)
    override fun stopStream() = driver.stopStream()
    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) = driver.sendStreamKeepAlive(message)
    override fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) =
        driver.startVideoRecording(requestId, save, flash, sound)
    override fun stopVideoRecording(requestId: String) = driver.stopVideoRecording(requestId)

    // ---- button settings (app-internal config; no-op) ----
    override fun sendButtonPhotoSettings() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendButtonCameraLedSetting() {}
    override fun sendCameraFovSetting() {}

    // ---- display ----
    override fun setBrightness(level: Int, autoMode: Boolean) = driver.setBrightness(level, autoMode)
    override fun clearDisplay() = driver.clearDisplay()
    override fun sendTextWall(text: String) = driver.sendTextWall(text)
    override fun sendDoubleTextWall(top: String, bottom: String) = driver.sendDoubleTextWall(top, bottom)
    override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean =
        driver.displayBitmap(base64ImageData, x, y, width, height)
    override fun showDashboard() = driver.showDashboard()
    override fun setDashboardPosition(height: Int, depth: Int) = driver.setDashboardPosition(height, depth)

    // ---- device control ----
    override fun setHeadUpAngle(angle: Int) = driver.setHeadUpAngle(angle)
    override fun getBatteryStatus() = driver.getBatteryStatus()
    override fun setSilentMode(enabled: Boolean) = driver.setSilentMode(enabled)
    override fun exit() = driver.clearDisplay()
    override fun sendShutdown() = driver.sendShutdown()
    override fun sendReboot() = driver.sendReboot()
    override fun sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?,
        onDurationMs: Int, offDurationMs: Int, count: Int,
    ) = driver.sendRgbLedControl(requestId, packageName, action, color, onDurationMs, offDurationMs, count)

    // ---- connection management ----
    override fun disconnect() = driver.disconnect()
    override fun forget() = driver.disconnect()
    override fun findCompatibleDevices() = driver.findCompatibleDevices()
    override fun stopScan() = driver.stopScan()
    override fun connectById(id: String) = driver.connectById(id)
    override fun getConnectedBluetoothName(): String = driver.getConnectedName() ?: ""
    override fun cleanup() = driver.cleanup()
    override fun ping() = driver.ping()
    override fun dbg1() {}
    override fun dbg2() {}

    // ---- network ----
    override fun requestWifiScan() = driver.requestWifiScan()
    override fun sendWifiCredentials(ssid: String, password: String) = driver.sendWifiCredentials(ssid, password)
    override fun forgetWifiNetwork(ssid: String) = driver.forgetWifiNetwork(ssid)
    override fun sendHotspotState(enabled: Boolean) = driver.sendHotspotState(enabled)

    // ---- user context / incident / gallery (app-internal; no-op) ----
    override fun sendUserEmailToGlasses(email: String) {}
    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}
    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}

    // ---- version ----
    override fun requestVersionInfo() = driver.requestVersionInfo()
}
