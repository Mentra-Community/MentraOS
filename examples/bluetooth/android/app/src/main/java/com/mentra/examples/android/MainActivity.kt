package com.mentra.examples.android

import android.Manifest
import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.mentra.bluetoothsdk.MentraBatteryStatusEvent
import com.mentra.bluetoothsdk.MentraBluetoothError
import com.mentra.bluetoothsdk.MentraBluetoothSdk
import com.mentra.bluetoothsdk.MentraBluetoothSdkListener
import com.mentra.bluetoothsdk.MentraBluetoothStatusUpdate
import com.mentra.bluetoothsdk.MentraButtonMode
import com.mentra.bluetoothsdk.MentraButtonPhotoSettings
import com.mentra.bluetoothsdk.MentraButtonPressEvent
import com.mentra.bluetoothsdk.MentraButtonVideoRecordingSettings
import com.mentra.bluetoothsdk.MentraCameraFov
import com.mentra.bluetoothsdk.MentraDashboardPositionRequest
import com.mentra.bluetoothsdk.MentraDeviceModel
import com.mentra.bluetoothsdk.MentraDiscoveredDevice
import com.mentra.bluetoothsdk.MentraDisplayTextRequest
import com.mentra.bluetoothsdk.MentraGalleryStatusEvent
import com.mentra.bluetoothsdk.MentraGlassesStatusUpdate
import com.mentra.bluetoothsdk.MentraLocalTranscriptionEvent
import com.mentra.bluetoothsdk.MentraMicConfig
import com.mentra.bluetoothsdk.MentraMicPreference
import com.mentra.bluetoothsdk.MentraPhotoResponseEvent
import com.mentra.bluetoothsdk.MentraPhotoRequest
import com.mentra.bluetoothsdk.MentraPhotoSize
import com.mentra.bluetoothsdk.MentraScanStopReason
import com.mentra.bluetoothsdk.MentraStreamStatusEvent
import com.mentra.bluetoothsdk.MentraVideoRecordingRequest
import com.mentra.bluetoothsdk.MentraWifiStatusEvent
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlin.math.PI
import kotlin.math.sin
import org.json.JSONObject

private enum class DemoTab(val title: String) {
    STATUS("Status"),
    AUDIO("Audio"),
    CAMERA("Camera"),
    DISPLAY("Display"),
    LOGS("Logs"),
}

class MainActivity : Activity(), MentraBluetoothSdkListener {
    private lateinit var sdk: MentraBluetoothSdk
    private lateinit var tabContent: FrameLayout
    private lateinit var tabViews: Map<DemoTab, ScrollView>
    private lateinit var connectionText: TextView
    private lateinit var deviceText: TextView
    private lateinit var batteryText: TextView
    private lateinit var wifiText: TextView
    private lateinit var versionText: TextView
    private lateinit var micText: TextView
    private lateinit var audioOutputText: TextView
    private lateinit var cameraText: TextView
    private lateinit var webhookUrlInput: EditText
    private lateinit var photoPreview: ImageView
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
    private var isPlayingTone = false
    private var latestPhotoRequestId: String? = null
    private var activePhotoPollRequestId: String? = null
    private var activeVideoRequestId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sdk = MentraBluetoothSdk.create(applicationContext, listener = this)
        setContentView(createContentView())
        requestRuntimePermissions()
        refreshSnapshot()
        appendAppLog("SDK ready. Scan for Mentra Live, then connect.")
    }

    override fun onDestroy() {
        sdk.setOwnAppAudioPlaying(false)
        sdk.close()
        super.onDestroy()
    }

    private fun createContentView(): LinearLayout {
        connectionText = statusLine("Connection: not connected")
        deviceText = statusLine("Device: none")
        batteryText = statusLine(latestBatteryLine)
        wifiText = statusLine(latestWifiLine)
        versionText = statusLine("Version: waiting for device status")
        micText = statusLine("Mic: off")
        audioOutputText = statusLine("Output: idle")
        cameraText = statusLine("Camera: idle")
        webhookUrlInput =
            EditText(this).apply {
                hint = "http://192.168.1.42:8787/upload"
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                setSingleLine(true)
            }
        photoPreview = ImageView(this).apply {
            adjustViewBounds = true
            maxHeight = 700
            setPadding(0, 12, 0, 12)
        }
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

        tabViews =
            mapOf(
                DemoTab.STATUS to tabScrollView(buildStatusTab()),
                DemoTab.AUDIO to tabScrollView(buildAudioTab()),
                DemoTab.CAMERA to tabScrollView(buildCameraTab()),
                DemoTab.DISPLAY to tabScrollView(buildDisplayTab()),
                DemoTab.LOGS to tabScrollView(buildLogsTab()),
            )

        tabContent = FrameLayout(this).apply {
            layoutParams =
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f,
                )
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams =
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
        }
        root.addView(buildTabBar())
        root.addView(tabContent)
        showTab(DemoTab.STATUS)
        return root
    }

    private fun buildStatusTab(): LinearLayout {
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

        content.addView(sectionTitle("Device status"))
        content.addView(button("Refresh version / Wi-Fi / gallery") {
            refreshSnapshot()
            sdk.requestVersionInfo()
            sdk.requestWifiScan()
            sdk.queryGalleryStatus()
            appendAppLog("Requested version, Wi-Fi scan, and gallery status.")
        })
        return content
    }

    private fun buildAudioTab(): LinearLayout {
        val content = tabContentContainer()
        content.addView(sectionTitle("Audio input"))
        content.addView(micText)
        content.addView(button("Use automatic mic routing") {
            sdk.setPreferredMic(MentraMicPreference.AUTO)
            appendAppLog("Preferred mic set to auto.")
        })
        content.addView(button("Start PCM + transcript") {
            startMicCapture(sendPcm = true, sendLc3 = false, sendTranscript = true)
            appendAppLog("Requested PCM frames and local transcription.")
        })
        content.addView(button("Start LC3 frame counter") {
            startMicCapture(sendPcm = false, sendLc3 = true, sendTranscript = false)
            appendAppLog("Requested LC3 mic frames.")
        })
        content.addView(button("Stop mic") {
            stopMicCapture()
            appendAppLog("Mic stream disabled.")
        })

        content.addView(sectionTitle("Audio output"))
        content.addView(audioOutputText)
        content.addView(button("Play 2s output tone") {
            playOutputTone()
        })
        content.addView(
            statusLine(
                "Output uses Android's active audio route. If the glasses are paired as a media device, the tone should route there; the SDK is notified while audio is playing."
            )
        )
        return content
    }

    private fun buildCameraTab(): LinearLayout {
        val content = tabContentContainer()
        content.addView(sectionTitle("Webhook photo preview"))
        content.addView(cameraText)
        content.addView(photoPreview)
        content.addView(webhookUrlInput)
        content.addView(button("Take photo + upload to webhook") {
            requestWebhookPhotoPreview()
        })
        content.addView(
            statusLine(
                "Run the local webhook server on your computer, paste its /upload URL here, then tap the button. The glasses upload directly to that server; this app polls it by requestId and displays the image."
            )
        )
        content.addView(button("Query gallery status") {
            sdk.queryGalleryStatus()
            appendAppLog("Requested gallery status.")
        })

        content.addView(sectionTitle("Video recording"))
        content.addView(button("Set 1080p video button settings") {
            sdk.setButtonVideoRecordingSettings(
                MentraButtonVideoRecordingSettings(width = 1920, height = 1080, fps = 30)
            )
            sdk.setButtonMaxRecordingTime(1)
            sdk.setButtonCameraLed(true)
            sdk.setCameraFov(MentraCameraFov.STANDARD)
            appendAppLog("Applied video button settings: 1080p30, 1 minute max, LED on.")
        })
        content.addView(button("Start saved video recording") {
            startSavedVideoRecording()
        })
        content.addView(button("Stop saved video recording") {
            stopSavedVideoRecording()
        })

        content.addView(sectionTitle("Hardware button"))
        content.addView(button("Set button to photo") {
            sdk.setButtonMode(MentraButtonMode.PHOTO)
            sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(MentraPhotoSize.MEDIUM))
            appendAppLog("Set hardware button mode to photo.")
        })
        content.addView(button("Set button to video") {
            sdk.setButtonMode(MentraButtonMode.VIDEO)
            appendAppLog("Set hardware button mode to video.")
        })
        return content
    }

    private fun buildDisplayTab(): LinearLayout {
        val content = tabContentContainer()
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
        return content
    }

    private fun buildLogsTab(): LinearLayout {
        val content = tabContentContainer()
        content.addView(sectionTitle("Logs"))
        content.addView(debugButton)
        content.addView(logText)
        return content
    }

    private fun buildTabBar(): HorizontalScrollView {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(16, 16, 16, 8)
        }
        DemoTab.values().forEach { tab ->
            row.addView(button(tab.title) { showTab(tab) })
        }

        return HorizontalScrollView(this).apply { addView(row) }
    }

    private fun showTab(tab: DemoTab) {
        if (!::tabContent.isInitialized) return
        tabContent.removeAllViews()
        tabViews[tab]?.let { tabContent.addView(it) }
    }

    private fun tabScrollView(content: LinearLayout): ScrollView =
        ScrollView(this).apply { addView(content) }

    private fun tabContentContainer(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 16, 32, 32)
            layoutParams =
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
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

    private fun startMicCapture(sendPcm: Boolean, sendLc3: Boolean, sendTranscript: Boolean) {
        micLc3Frames = 0
        micPcmFrames = 0
        latestTranscript = "none"
        sdk.setMicState(
            MentraMicConfig(
                sendPcmData = sendPcm,
                sendLc3Data = sendLc3,
                sendTranscript = sendTranscript,
                bypassVad = false,
            )
        )
        updateMicStatus()
    }

    private fun stopMicCapture() {
        sdk.setMicState(
            MentraMicConfig(
                sendPcmData = false,
                sendLc3Data = false,
                sendTranscript = false,
                bypassVad = false,
            )
        )
        updateMicStatus()
    }

    private fun playOutputTone() {
        if (isPlayingTone) {
            appendAppLog("Output tone is already playing.")
            return
        }

        isPlayingTone = true
        updateAudioOutputStatus("Output: playing 2s tone")
        sdk.setOwnAppAudioPlaying(true)

        Thread {
            var track: AudioTrack? = null
            try {
                val sampleRate = 16_000
                val durationSeconds = 2
                val sampleCount = sampleRate * durationSeconds
                val samples = ShortArray(sampleCount) { index ->
                    val wave = sin(2.0 * PI * 440.0 * index / sampleRate)
                    (wave * Short.MAX_VALUE * 0.25).toInt().toShort()
                }
                val minBufferSize =
                    AudioTrack.getMinBufferSize(
                        sampleRate,
                        AudioFormat.CHANNEL_OUT_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                    )
                track =
                    AudioTrack.Builder()
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build()
                        )
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setSampleRate(sampleRate)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .build()
                        )
                        .setBufferSizeInBytes(maxOf(minBufferSize, samples.size * 2))
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()

                track.play()
                track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                track.stop()
                updateAudioOutputStatus("Output: played 2s tone")
                appendAppLog("Played output tone through Android's active audio route.")
            } catch (error: Exception) {
                updateAudioOutputStatus("Output: failed (${error.message ?: "unknown error"})")
                appendAppLog("Output tone failed: ${error.message ?: error.javaClass.simpleName}")
            } finally {
                track?.release()
                sdk.setOwnAppAudioPlaying(false)
                isPlayingTone = false
            }
        }.start()
    }

    private fun requestWebhookPhotoPreview() {
        if (!hasActiveGlassesSession()) {
            updateCameraStatus("Camera: connect to Mentra Live before requesting a photo")
            appendAppLog("Webhook photo skipped because the sample is not connected to glasses.")
            return
        }

        val webhookUrl = webhookUrlInput.text?.toString()?.trim().orEmpty()
        if (!webhookUrl.startsWith("http://") && !webhookUrl.startsWith("https://")) {
            updateCameraStatus("Camera: enter a webhook URL like http://<computer-ip>:8787/upload")
            appendAppLog("Webhook photo skipped because the upload URL is missing or invalid.")
            return
        }

        val requestId = nextRequestId("photo")
        latestPhotoRequestId = requestId
        activePhotoPollRequestId = requestId
        photoPreview.setImageDrawable(null)
        updateCameraStatus("Camera: webhook upload requested ($requestId)")
        sdk.requestPhoto(
            MentraPhotoRequest(
                requestId = requestId,
                appId = "com.mentra.examples.android",
                size = "medium",
                webhookUrl = webhookUrl,
                authToken = "",
                compress = "medium",
                flash = false,
                sound = true,
            )
        )
        appendAppLog("Requested webhook photo upload: $requestId -> $webhookUrl.")
        pollPhotoPreview(requestId, webhookUrl)
    }

    private fun startSavedVideoRecording() {
        val requestId = nextRequestId("video")
        activeVideoRequestId = requestId
        sdk.startVideoRecording(
            MentraVideoRecordingRequest(
                requestId = requestId,
                save = true,
                flash = false,
                sound = true,
            )
        )
        updateCameraStatus("Camera: video recording requested ($requestId)")
        appendAppLog("Started saved video recording: $requestId.")
    }

    private fun stopSavedVideoRecording() {
        val requestId = activeVideoRequestId ?: latestPhotoRequestId ?: nextRequestId("video")
        sdk.stopVideoRecording(requestId)
        activeVideoRequestId = null
        updateCameraStatus("Camera: stop video requested ($requestId)")
        appendAppLog("Stopped saved video recording: $requestId.")
    }

    private fun updateAudioOutputStatus(message: String) {
        runOnUiThread {
            audioOutputText.text = message
        }
    }

    private fun updateCameraStatus(message: String) {
        runOnUiThread {
            cameraText.text = message
        }
    }

    private fun nextRequestId(prefix: String): String = "$prefix-${System.currentTimeMillis()}"

    private fun hasActiveGlassesSession(): Boolean =
        glassesValues["connected"] == true ||
            dataChannelActive ||
            latestBatteryLine != "Battery: waiting for device status" ||
            latestWifiLine != "Wi-Fi: waiting for device status"

    private fun pollPhotoPreview(requestId: String, webhookUrl: String) {
        val statusUrl =
            try {
                photoStatusUrl(webhookUrl, requestId)
            } catch (error: Exception) {
                updateCameraStatus("Camera: invalid webhook URL (${error.message ?: "unknown error"})")
                return
            }

        Thread {
            repeat(45) { attempt ->
                if (activePhotoPollRequestId != requestId) return@Thread

                try {
                    val connection = URL(statusUrl).openConnection() as HttpURLConnection
                    try {
                        connection.connectTimeout = 1_500
                        connection.readTimeout = 1_500
                        connection.requestMethod = "GET"

                        if (connection.responseCode == HttpURLConnection.HTTP_OK) {
                            val body = connection.inputStream.bufferedReader().use { it.readText() }
                            val json = JSONObject(body)
                            val photoUrl =
                                json.optString("photoUrl")
                                    .ifBlank { json.optString("photo_url") }
                                    .ifBlank { json.optString("url") }

                            if (photoUrl.isNotBlank()) {
                                updateCameraStatus("Camera: server received photo; loading preview")
                                appendAppLog("Local webhook photo ready: $photoUrl")
                                loadPhotoPreview(photoUrl)
                                return@Thread
                            }
                        }
                    } finally {
                        connection.disconnect()
                    }
                } catch (error: Exception) {
                    if (attempt == 0 || attempt % 10 == 9) {
                        appendAppLog("Waiting for local photo server: ${error.message ?: error.javaClass.simpleName}")
                    }
                }

                Thread.sleep(1_000)
            }

            if (activePhotoPollRequestId == requestId) {
                updateCameraStatus("Camera: timed out waiting for local server upload")
                appendAppLog("Timed out polling local photo server for $requestId.")
            }
        }.start()
    }

    private fun photoStatusUrl(webhookUrl: String, requestId: String): String {
        val uploadUrl = URL(webhookUrl)
        val port = if (uploadUrl.port >= 0) ":${uploadUrl.port}" else ""
        val encodedRequestId = URLEncoder.encode(requestId, "UTF-8")
        return "${uploadUrl.protocol}://${uploadUrl.host}$port/uploads/$encodedRequestId.json"
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
        updateCameraStatus("Camera: gallery ${summarizeValues(event.values)}")
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
        val success = event.values["success"] as? Boolean
        val requestId = stringValue(event.values, "requestId", "request_id")
        val source = photoPreviewSource(event.values)

        if (success == false) {
            if (requestId == activePhotoPollRequestId) {
                activePhotoPollRequestId = null
            }
            val errorCode = stringValue(event.values, "errorCode", "error_code") ?: "unknown_error"
            val errorMessage = stringValue(event.values, "errorMessage", "error_message", "error") ?: "no details"
            updateCameraStatus("Camera: photo failed $errorCode - $errorMessage")
        } else if (source != null) {
            updateCameraStatus("Camera: photo response received; loading preview")
            loadPhotoPreview(source)
        } else if (requestId == activePhotoPollRequestId) {
            updateCameraStatus("Camera: photo acknowledged; waiting for local server upload")
        } else {
            updateCameraStatus("Camera: photo response had no preview source")
        }

        updateStatusPanel()
        appendAppLog("Photo response: ${summarizeValues(event.values)}")
    }

    override fun onStreamStatus(event: MentraStreamStatusEvent) {
        dataChannelActive = true
        latestEventLine = "Events: stream ${summarizeValues(event.values)}"
        updateCameraStatus("Camera: stream ${summarizeValues(event.values)}")
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

    private fun photoPreviewSource(values: Map<String, Any>): String? =
        stringValue(
            values,
            "photoUrl",
            "photo_url",
            "previewUrl",
            "preview_url",
            "localPath",
            "local_path",
            "mediaUrl",
            "media_url",
        )

    private fun loadPhotoPreview(source: String) {
        updateCameraStatus("Camera: loading photo preview")
        Thread {
            try {
                val bitmap =
                    if (source.startsWith("http://") || source.startsWith("https://")) {
                        URL(source).openStream().use { stream -> BitmapFactory.decodeStream(stream) }
                    } else {
                        val path = source.removePrefix("file://")
                        BitmapFactory.decodeFile(path)
                    }

                runOnUiThread {
                    if (bitmap != null) {
                        photoPreview.setImageBitmap(bitmap)
                        cameraText.text = "Camera: loaded photo preview"
                    } else {
                        cameraText.text = "Camera: photo response had a source, but Android could not decode it"
                    }
                }
            } catch (error: Exception) {
                updateCameraStatus("Camera: preview load failed (${error.message ?: "unknown error"})")
            }
        }.start()
    }

    private fun stringValue(values: Map<String, Any>, vararg keys: String): String? {
        for (key in keys) {
            val value = values[key]
            if (value is String && value.isNotBlank()) return value
        }

        return null
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
