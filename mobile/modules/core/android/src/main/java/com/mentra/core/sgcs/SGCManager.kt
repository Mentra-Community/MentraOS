package com.mentra.core.sgcs

import com.mentra.core.utils.ConnTypes

abstract class SGCManager {
    // Device Information
    @JvmField var type: String = ""
    @JvmField var ready: Boolean = false
    @JvmField
    var connectionState: String =
            ConnTypes.DISCONNECTED // "disconnected" | "connected" | "connecting"

    @JvmField var glassesAppVersion: String = ""
    @JvmField var glassesBuildNumber: String = ""
    @JvmField var glassesDeviceModel: String = ""
    @JvmField var glassesAndroidVersion: String = ""
    @JvmField var glassesOtaVersionUrl: String = ""
    @JvmField var glassesFirmwareVersion: String = ""
    @JvmField var glassesBtMacAddress: String = ""
    @JvmField var glassesSerialNumber: String = ""
    @JvmField var glassesStyle: String = ""
    @JvmField var glassesColor: String = ""

    // Hardware Status
    @JvmField var hasMic: Boolean = false
    @JvmField var micEnabled: Boolean = false
    @JvmField var batteryLevel: Int = -1
    @JvmField var isHeadUp: Boolean = false

    // Case Status
    @JvmField var caseOpen: Boolean = false
    @JvmField var caseRemoved: Boolean = false
    @JvmField var caseCharging: Boolean = false
    @JvmField var caseBatteryLevel: Int = -1

    // Network Status
    @JvmField var wifiSsid: String = ""
    @JvmField var wifiConnected: Boolean = false
    @JvmField var wifiLocalIp: String = ""
    @JvmField var isHotspotEnabled: Boolean = false
    @JvmField var hotspotSsid: String = ""
    @JvmField var hotspotPassword: String = ""
    @JvmField var hotspotGatewayIp: String = ""

    // Audio Control
    abstract fun setMicEnabled(enabled: Boolean)
    abstract fun sortMicRanking(list: MutableList<String>): MutableList<String>

    // Camera & Media
    abstract fun requestPhoto(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String?,
            authToken: String?,
            compress: String?
    )
    abstract fun startRtmpStream(message: MutableMap<String, Any>)
    abstract fun stopRtmpStream()
    abstract fun sendRtmpKeepAlive(message: MutableMap<String, Any>)
    abstract fun startBufferRecording()
    abstract fun stopBufferRecording()
    abstract fun saveBufferVideo(requestId: String, durationSeconds: Int)
    abstract fun startVideoRecording(requestId: String, save: Boolean)
    abstract fun stopVideoRecording(requestId: String)

    // Button Settings
    abstract fun sendButtonPhotoSettings()
    abstract fun sendButtonModeSetting()
    abstract fun sendButtonVideoRecordingSettings()
    abstract fun sendButtonMaxRecordingTime()
    abstract fun sendButtonCameraLedSetting()

    // Display Control
    abstract fun setBrightness(level: Int, autoMode: Boolean)
    abstract fun clearDisplay()
    abstract fun sendTextWall(text: String)
    abstract fun sendDoubleTextWall(top: String, bottom: String)
    abstract fun displayBitmap(base64ImageData: String): Boolean
    abstract fun showDashboard()
    abstract fun setDashboardPosition(height: Int, depth: Int)

    // Device Control
    abstract fun setHeadUpAngle(angle: Int)
    abstract fun getBatteryStatus()
    abstract fun setSilentMode(enabled: Boolean)
    abstract fun exit()
    abstract fun sendRgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            ontime: Int,
            offtime: Int,
            count: Int
    )

    // Connection Management
    abstract fun disconnect()
    abstract fun forget()
    abstract fun findCompatibleDevices()
    abstract fun connectById(id: String)
    abstract fun getConnectedBluetoothName(): String
    abstract fun cleanup()

    // Network Management
    abstract fun requestWifiScan()
    abstract fun sendWifiCredentials(ssid: String, password: String)
    abstract fun sendHotspotState(enabled: Boolean)

    // Gallery
    abstract fun queryGalleryStatus()
    abstract fun sendGalleryMode()
}
