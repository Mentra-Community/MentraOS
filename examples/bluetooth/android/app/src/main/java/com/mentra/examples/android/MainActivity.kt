package com.mentra.examples.android

import android.Manifest
import android.app.Activity
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.mentra.bluetoothsdk.MentraBatteryStatusEvent
import com.mentra.bluetoothsdk.MentraBluetoothError
import com.mentra.bluetoothsdk.MentraBluetoothSdk
import com.mentra.bluetoothsdk.MentraBluetoothSdkListener
import com.mentra.bluetoothsdk.MentraBluetoothStatusUpdate
import com.mentra.bluetoothsdk.MentraButtonMode
import com.mentra.bluetoothsdk.MentraButtonPressEvent
import com.mentra.bluetoothsdk.MentraDashboardPositionRequest
import com.mentra.bluetoothsdk.MentraDeviceModel
import com.mentra.bluetoothsdk.MentraDiscoveredDevice
import com.mentra.bluetoothsdk.MentraDisplayTextRequest
import com.mentra.bluetoothsdk.MentraGalleryStatusEvent
import com.mentra.bluetoothsdk.MentraGlassesStatusUpdate
import com.mentra.bluetoothsdk.MentraLocalTranscriptionEvent
import com.mentra.bluetoothsdk.MentraMicConfig
import com.mentra.bluetoothsdk.MentraPhotoResponseEvent
import com.mentra.bluetoothsdk.MentraScanStopReason
import com.mentra.bluetoothsdk.MentraStreamStatusEvent
import com.mentra.bluetoothsdk.MentraWifiStatusEvent

class MainActivity : Activity(), MentraBluetoothSdkListener {
    private lateinit var sdk: MentraBluetoothSdk
    private lateinit var connectionText: TextView
    private lateinit var deviceText: TextView
    private lateinit var batteryText: TextView
    private lateinit var wifiText: TextView
    private lateinit var versionText: TextView
    private lateinit var micText: TextView
    private lateinit var eventText: TextView
    private lateinit var debugButton: Button
    private lateinit var logText: TextView

    private val glassesValues = linkedMapOf<String, Any>()
    private val bluetoothValues = linkedMapOf<String, Any>()
    private val versionValues = linkedMapOf<String, Any>()
    private var latestDevice: MentraDiscoveredDevice? = null
    private var latestBatteryLine = "Battery: waiting for device status"
    private var latestWifiLine = "Wi-Fi: waiting for device status"
    private var latestEventLine = "Events: waiting for hardware events"
    private var showDebugLogs = false
    private var hiddenSdkLogCount = 0
    private var micPcmFrames = 0
    private var micLc3Frames = 0
    private var latestTranscript = "none"
    private var dataChannelActive = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sdk = MentraBluetoothSdk.create(applicationContext, listener = this)
        setContentView(createContentView())
        requestRuntimePermissions()
        refreshSnapshot()
        appendAppLog("SDK ready. Scan for Mentra Live, then connect.")
    }

    override fun onDestroy() {
        sdk.close()
        super.onDestroy()
    }

    private fun createContentView(): ScrollView {
        connectionText = statusLine("Connection: not connected")
        deviceText = statusLine("Device: none")
        batteryText = statusLine(latestBatteryLine)
        wifiText = statusLine(latestWifiLine)
        versionText = statusLine("Version: waiting for device status")
        micText = statusLine("Mic: off")
        eventText = statusLine(latestEventLine)
        logText = TextView(this).apply {
            textSize = 14f
            setTextIsSelectable(true)
        }
        debugButton = button("Show SDK debug logs") {
            showDebugLogs = !showDebugLogs
            debugButton.text = if (showDebugLogs) "Hide SDK debug logs" else "Show SDK debug logs"
            appendAppLog(
                if (showDebugLogs) {
                    "SDK debug logs are now visible."
                } else {
                    "SDK debug logs are hidden."
                }
            )
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }

        content.addView(sectionTitle("Mentra Live status"))
        content.addView(connectionText)
        content.addView(deviceText)
        content.addView(batteryText)
        content.addView(wifiText)
        content.addView(versionText)
        content.addView(micText)
        content.addView(eventText)

        content.addView(sectionTitle("Connection"))
        content.addView(button("Scan for Mentra Live") {
            latestDevice = null
            sdk.startScan(MentraDeviceModel.MENTRA_LIVE)
            appendAppLog("Scanning for Mentra Live glasses...")
        })
        content.addView(button("Connect first/default") {
            val device = latestDevice
            if (device != null) {
                sdk.connect(device)
                appendAppLog("Connecting to ${device.name}...")
            } else {
                sdk.connectDefault()
                appendAppLog("No scan result yet. Trying saved default device...")
            }
        })
        content.addView(button("Disconnect") {
            dataChannelActive = false
            sdk.disconnect()
            updateStatusPanel()
            appendAppLog("Disconnect requested.")
        })

        content.addView(sectionTitle("Displayless checks"))
        content.addView(button("Refresh version / Wi-Fi / gallery") {
            refreshSnapshot()
            sdk.requestVersionInfo()
            sdk.requestWifiScan()
            sdk.queryGalleryStatus()
            appendAppLog("Requested version, Wi-Fi scan, and gallery status.")
        })
        content.addView(button("Set glasses button to photo") {
            sdk.setButtonMode(MentraButtonMode.PHOTO)
            appendAppLog("Set hardware button mode to photo. Press the glasses button to test events.")
        })
        content.addView(button("Set glasses button to video") {
            sdk.setButtonMode(MentraButtonMode.VIDEO)
            appendAppLog("Set hardware button mode to video. Press the glasses button to test events.")
        })
        content.addView(button("Start mic LC3 frame counter") {
            micLc3Frames = 0
            micPcmFrames = 0
            sdk.setMicState(
                MentraMicConfig(
                    sendPcmData = false,
                    sendLc3Data = true,
                    sendTranscript = false,
                    bypassVad = false,
                )
            )
            updateMicStatus()
            appendAppLog("Requested LC3 mic frames. Speak near the glasses and watch the counter.")
        })
        content.addView(button("Stop mic") {
            sdk.setMicState(
                MentraMicConfig(
                    sendPcmData = false,
                    sendLc3Data = false,
                    sendTranscript = false,
                    bypassVad = false,
                )
            )
            updateMicStatus()
            appendAppLog("Mic stream disabled.")
        })

        content.addView(sectionTitle("Display models"))
        content.addView(button("Display hello") {
            sdk.displayText(
                MentraDisplayTextRequest(
                    text = "Hello from bare Android",
                    x = 0,
                    y = 0,
                    size = 24,
                )
            )
            appendAppLog("Sent display text. Mentra Live may report this as unsupported.")
        })
        content.addView(button("Apply display settings") {
            sdk.setBrightness(level = 60)
            sdk.setDashboardPosition(MentraDashboardPositionRequest(height = 4, depth = 6))
            appendAppLog("Applied brightness and dashboard position. Displayless glasses may ignore this.")
        })
        content.addView(button("Clear display") {
            sdk.clearDisplay()
            appendAppLog("Clear display requested.")
        })

        content.addView(sectionTitle("Logs"))
        content.addView(debugButton)
        content.addView(logText)

        return ScrollView(this).apply {
            addView(content)
        }
    }

    private fun sectionTitle(label: String): TextView =
        TextView(this).apply {
            text = label
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 28, 0, 8)
        }

    private fun statusLine(initialText: String): TextView =
        TextView(this).apply {
            text = initialText
            textSize = 15f
            setPadding(0, 4, 0, 4)
        }

    private fun button(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }

    private fun requestRuntimePermissions() {
        val permissions = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_SCAN)
                add(Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()

        requestPermissions(permissions, 42)
    }

    private fun refreshSnapshot() {
        glassesValues.putAll(sdk.getGlassesStatus().values)
        bluetoothValues.putAll(sdk.getBluetoothStatus().values)
        updateStatusPanel()
    }

    override fun onDeviceDiscovered(device: MentraDiscoveredDevice) {
        latestDevice = device
        latestEventLine = "Events: discovered ${device.name}"
        updateStatusPanel()
        appendAppLog("Discovered ${device.name}")
    }

    override fun onScanStopped(reason: MentraScanStopReason) {
        latestEventLine = "Events: scan stopped ($reason)"
        updateStatusPanel()
        appendAppLog("Scan stopped: $reason")
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        glassesValues.putAll(status.values)
        updateStatusPanel()
    }

    override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
        bluetoothValues.putAll(status.values)
        updateStatusPanel()
    }

    override fun onBatteryStatus(event: MentraBatteryStatusEvent) {
        dataChannelActive = true
        latestBatteryLine = formatBatteryLine(event.level, event.charging)
        latestEventLine = "Events: battery update"
        updateStatusPanel()
        appendAppLog(latestBatteryLine)
    }

    override fun onWifiStatusChanged(event: MentraWifiStatusEvent) {
        dataChannelActive = true
        val connected = event.values["connected"] ?: "unknown"
        val ssid = event.values["ssid"] ?: "unknown"
        val ip = event.values["local_ip"] ?: "unknown"
        latestWifiLine = "Wi-Fi: connected=$connected ssid=$ssid ip=$ip"
        latestEventLine = "Events: Wi-Fi status update"
        updateStatusPanel()
        appendAppLog(latestWifiLine)
    }

    override fun onGalleryStatus(event: MentraGalleryStatusEvent) {
        dataChannelActive = true
        latestEventLine = "Events: gallery ${summarizeValues(event.values)}"
        updateStatusPanel()
        appendAppLog("Gallery status: ${summarizeValues(event.values)}")
    }

    override fun onButtonPress(event: MentraButtonPressEvent) {
        dataChannelActive = true
        latestEventLine = "Events: button ${event.buttonId} ${event.pressType}"
        updateStatusPanel()
        appendAppLog("Button press: ${event.buttonId} ${event.pressType}")
    }

    override fun onPhotoResponse(event: MentraPhotoResponseEvent) {
        dataChannelActive = true
        latestEventLine = "Events: photo ${summarizeValues(event.values)}"
        updateStatusPanel()
        appendAppLog("Photo response: ${summarizeValues(event.values)}")
    }

    override fun onStreamStatus(event: MentraStreamStatusEvent) {
        dataChannelActive = true
        latestEventLine = "Events: stream ${summarizeValues(event.values)}"
        updateStatusPanel()
        appendAppLog("Stream status: ${summarizeValues(event.values)}")
    }

    override fun onMicPcm(frame: ByteArray) {
        dataChannelActive = true
        micPcmFrames += 1
        if (micPcmFrames == 1 || micPcmFrames % 25 == 0) {
            updateMicStatus()
        }
    }

    override fun onMicLc3(frame: ByteArray) {
        dataChannelActive = true
        micLc3Frames += 1
        if (micLc3Frames == 1 || micLc3Frames % 25 == 0) {
            updateMicStatus()
        }
    }

    override fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {
        dataChannelActive = true
        latestTranscript = if (event.isFinal) "${event.text} (final)" else event.text
        latestEventLine = "Events: transcription update"
        updateMicStatus()
        updateStatusPanel()
        appendAppLog("Transcript: $latestTranscript")
    }

    override fun onRawEvent(eventName: String, values: Map<String, Any>) {
        when (eventName) {
            "version_info", "version_info_1", "version_info_2", "version_info_3" -> {
                dataChannelActive = true
                versionValues.putAll(values)
                latestEventLine = "Events: $eventName"
                updateStatusPanel()
                appendAppLog("Version update: ${summarizeValues(values)}")
            }
            "hotspot_status_change", "hotspot_error", "ota_update_available", "ota_progress" -> {
                dataChannelActive = true
                latestEventLine = "Events: $eventName ${summarizeValues(values)}"
                updateStatusPanel()
                appendAppLog("$eventName: ${summarizeValues(values)}")
            }
            else -> {
                dataChannelActive = true
                latestEventLine = "Events: $eventName"
                updateStatusPanel()
                if (showDebugLogs) {
                    appendAppLog("Raw event $eventName: ${summarizeValues(values)}")
                }
            }
        }
    }

    override fun onLog(message: String) {
        if (showDebugLogs) {
            appendAppLog("SDK: $message")
            return
        }

        hiddenSdkLogCount += 1
        if (hiddenSdkLogCount == 1 || hiddenSdkLogCount % 50 == 0) {
            eventText.text = "Events: $hiddenSdkLogCount SDK debug logs hidden"
        }
    }

    override fun onError(error: MentraBluetoothError) {
        latestEventLine = "Events: error ${error.code}"
        updateStatusPanel()
        appendAppLog("Error ${error.code}: ${error.message}")
    }

    private fun updateStatusPanel() {
        runOnUiThread {
            val connected = glassesValues["connected"] ?: "unknown"
            val searching = bluetoothValues["searching"] ?: "unknown"
            val pending = bluetoothValues["pending_wearable"] ?: "none"
            val deviceName =
                glassesValues["bluetoothName"]
                    ?: bluetoothValues["device_name"]
                    ?: latestDevice?.name
                    ?: "none"
            val model =
                glassesValues["deviceModel"]
                    ?: bluetoothValues["default_wearable"]
                    ?: latestDevice?.model
                    ?: "unknown"

            connectionText.text =
                "Connection: sdkConnected=$connected dataChannel=${if (dataChannelActive) "active" else "idle"} scanning=$searching pending=$pending"
            deviceText.text = "Device: $deviceName model=$model"
            batteryText.text = latestBatteryLine
            wifiText.text = latestWifiLine
            versionText.text = "Version: ${summarizeVersion()}"
            eventText.text = latestEventLine
            updateMicStatus()
        }
    }

    private fun updateMicStatus() {
        runOnUiThread {
            micText.text = "Mic: LC3 frames=$micLc3Frames PCM frames=$micPcmFrames transcript=$latestTranscript"
        }
    }

    private fun formatBatteryLine(level: Int?, charging: Boolean?): String {
        val levelText = level?.takeIf { it >= 0 }?.let { "$it%" } ?: "unknown"
        return "Battery: $levelText charging=${charging ?: "unknown"}"
    }

    private fun summarizeVersion(): String {
        val appVersion = versionValue("appVersion", "app_version")
        val buildNumber = versionValue("buildNumber", "build_number")
        val androidVersion = versionValue("androidVersion", "android_version")
        val firmwareVersion = versionValue("fwVersion", "firmwareVersion", "firmware_version")
        val besVersion = versionValue("besFwVersion", "bes_fw_version")
        val mtkVersion = versionValue("mtkFwVersion", "mtk_fw_version")
        if (
            listOf(appVersion, buildNumber, androidVersion, firmwareVersion, besVersion, mtkVersion)
                .all { it == null }
        ) {
            return "waiting for device status"
        }

        val firmwareParts =
            listOfNotNull(
                firmwareVersion?.let { "fw=$it" },
                besVersion?.let { "BES=$it" },
                mtkVersion?.let { "MTK=$it" },
            )
                .ifEmpty { listOf("fw=unknown") }
                .joinToString(" ")

        return "app=${appVersion ?: "unknown"} build=${buildNumber ?: "unknown"} android=${androidVersion ?: "unknown"} $firmwareParts"
    }

    private fun versionValue(vararg keys: String): String? {
        for (key in keys) {
            val value = glassesValues[key] ?: versionValues[key]
            if (value is String && value.isNotBlank()) return value
            if (value is Number) return value.toString()
        }

        return null
    }

    private fun summarizeValues(values: Map<String, Any>): String =
        values
            .filterKeys { key -> key !in setOf("type", "timestamp", "password", "authToken") }
            .entries
            .take(6)
            .joinToString(", ") { (key, value) -> "$key=${formatValue(value)}" }
            .ifBlank { "no details" }

    private fun formatValue(value: Any?): String =
        when (value) {
            null -> "null"
            is Map<*, *> -> "{${value.entries.take(4).joinToString(", ") { "${it.key}=${it.value}" }}}"
            is List<*> -> "[${value.take(4).joinToString(", ")}${if (value.size > 4) ", ..." else ""}]"
            is ByteArray -> "ByteArray(${value.size})"
            else -> value.toString()
        }

    private fun appendAppLog(message: String) {
        runOnUiThread {
            val current = logText.text.toString()
            if (current.length > 12_000) {
                logText.text = current.takeLast(8_000)
            }
            logText.append("\n$message")
        }
    }
}
