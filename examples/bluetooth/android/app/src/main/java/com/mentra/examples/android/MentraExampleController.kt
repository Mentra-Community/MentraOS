package com.mentra.examples.android

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.mentra.core.MentraBatteryStatusEvent
import com.mentra.core.MentraBluetoothError
import com.mentra.core.MentraBluetoothSdk
import com.mentra.core.MentraBluetoothSdkCallback
import com.mentra.core.MentraBluetoothStatusUpdate
import com.mentra.core.MentraButtonPhotoSettings
import com.mentra.core.MentraButtonPressEvent
import com.mentra.core.MentraButtonVideoRecordingSettings
import com.mentra.core.MentraCameraFov
import com.mentra.core.MentraDashboardPositionRequest
import com.mentra.core.MentraDeviceModel
import com.mentra.core.MentraDiscoveredDevice
import com.mentra.core.MentraGalleryMode
import com.mentra.core.MentraGlassesStatusUpdate
import com.mentra.core.MentraMicConfig
import com.mentra.core.MentraPhotoRequest
import com.mentra.core.MentraPhotoSize
import com.mentra.core.MentraRgbLedRequest
import com.mentra.core.MentraStreamKeepAliveRequest
import com.mentra.core.MentraStreamRequest
import com.mentra.core.MentraTouchEvent
import com.mentra.core.MentraWifiStatusEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

val streamDefaultUrls = mapOf(
    "rtmp" to "rtmps://a.rtmps.youtube.com/live2/YOUR_STREAM_KEY",
    "srt" to "srt://srt.example.com:4201?streamid=YOUR_STREAM_ID&passphrase=YOUR_PASSPHRASE",
    "webrtc" to "https://whip.example.com/live/YOUR_STREAM_ID",
)

fun defaultStreamUrl(protocol: String): String = streamDefaultUrls[protocol] ?: streamDefaultUrls.getValue("rtmp")

fun streamProtocolLabel(protocol: String): String = if (protocol == "webrtc") "WHIP" else protocol.uppercase()

data class ExampleEvent(
    val time: String,
    val tag: String,
    val text: String,
)

data class MentraExampleState(
    val activeAction: String? = null,
    val bluetoothStatus: Map<String, Any> = emptyMap(),
    val cameraStatus: String = "Camera: enter the local webhook /upload URL",
    val discoveredDevices: List<MentraDiscoveredDevice> = emptyList(),
    val events: List<ExampleEvent> = listOf(exampleEvent("LIVE", "SDK ready. Scan to discover glasses.")),
    val glassesStatus: Map<String, Any> = emptyMap(),
    val hotspotEnabled: Boolean = false,
    val lastAction: String = "No actions yet.",
    val ledMode: String = "Solid",
    val micRecording: Boolean = false,
    val pcmBytes: Int = 0,
    val pcmFrames: Int = 0,
    val photoPreviewUrl: String? = null,
    val rawJsonExpanded: Boolean = false,
    val streamProtocol: String = "rtmp",
    val streamStartedAt: Long? = null,
    val streamStatus: String = "Ready to start stream",
    val streamUrl: String = defaultStreamUrl("rtmp"),
    val webhookUrl: String = "",
)

class MentraExampleController(context: Context) : MentraBluetoothSdkCallback(), AutoCloseable {
    var state by mutableStateOf(MentraExampleState())
        private set

    private val appContext = context.applicationContext
    private val sdk = MentraBluetoothSdk.create(appContext, this)
    private val controllerJob = Job()
    private val scope = CoroutineScope(Dispatchers.Main + controllerJob)
    private var activePhotoRequestId: String? = null
    private var pollGeneration = 0
    private var keepAliveJob: Job? = null

    init {
        state = state.copy(
            glassesStatus = sdk.getGlassesStatus().values,
            bluetoothStatus = sdk.getBluetoothStatus().values,
        )
    }

    fun startScan() = runAction("Scan") {
        state = state.copy(discoveredDevices = emptyList())
        sdk.startScan(MentraDeviceModel.MENTRA_LIVE)
    }

    fun connect() = runAction("Connect") {
        state.discoveredDevices.firstOrNull()?.let { sdk.connect(it) } ?: sdk.connectDefault()
    }

    fun connect(device: MentraDiscoveredDevice) = runAction("Connect ${device.name}") {
        sdk.connect(device)
    }

    fun disconnect() = runAction("Disconnect") {
        stopKeepAlive()
        sdk.disconnect()
        state = state.copy(
            glassesStatus = disconnectedGlassesStatus(),
            streamStartedAt = null,
            streamStatus = "Disconnected",
        )
    }

    fun displayHello() = runAction("Display Hello") {
        sdk.displayText(com.mentra.core.MentraDisplayTextRequest("Hello from Mentra Bluetooth SDK"))
    }

    fun clearDisplay() = runAction("Clear Display") {
        sdk.clearDisplay()
    }

    fun applySettings() = runAction("Apply Settings") {
        sdk.setBrightness(72)
        sdk.setDashboardPosition(MentraDashboardPositionRequest(height = 4, depth = 6))
        sdk.setGalleryMode(MentraGalleryMode.AUTO)
        sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(MentraPhotoSize.MEDIUM))
        sdk.setButtonVideoRecordingSettings(MentraButtonVideoRecordingSettings(width = 1920, height = 1080, fps = 30))
        sdk.setButtonCameraLed(true)
        sdk.setButtonMaxRecordingTime(5)
        sdk.setCameraFov(MentraCameraFov.STANDARD)
    }

    fun setWebhookUrl(url: String) {
        state = state.copy(webhookUrl = url)
    }

    fun captureAndUpload() = runAction("Capture & upload") {
        val uploadUrl = state.webhookUrl.trim()
        val requestId = "photo-${System.currentTimeMillis()}"
        val statusUrl = try {
            photoStatusUrl(uploadUrl, requestId)
        } catch (_: Exception) {
            state = state.copy(cameraStatus = "Camera: enter a webhook URL like http://<computer-ip>:8787/upload")
            throw IllegalArgumentException("Invalid webhook URL")
        }
        activePhotoRequestId = requestId
        pollGeneration += 1
        val generation = pollGeneration
        state = state.copy(
            cameraStatus = "Camera: webhook upload requested ($requestId)",
            photoPreviewUrl = null,
        )
        sdk.requestPhoto(
            MentraPhotoRequest(
                requestId = requestId,
                appId = "com.mentra.examples.android",
                size = "medium",
                webhookUrl = uploadUrl,
                compress = "medium",
                flash = false,
                sound = true,
            )
        )
        pollPhotoPreview(requestId, statusUrl, generation)
    }

    fun testWebhook() = runAction("Test webhook") {
        val healthUrl = try {
            webhookHealthUrl(state.webhookUrl.trim())
        } catch (_: Exception) {
            state = state.copy(cameraStatus = "Camera: enter a webhook URL like http://<computer-ip>:8787/upload")
            throw IllegalArgumentException("Invalid webhook URL")
        }

        state = state.copy(cameraStatus = "Camera: testing local webhook")
        scope.launch(Dispatchers.IO) {
            try {
                val connection = URL(healthUrl).openConnection() as HttpURLConnection
                connection.connectTimeout = 1500
                connection.readTimeout = 1500
                val code = connection.responseCode
                if (code in 200..299) {
                    connection.inputStream.close()
                    scope.launch {
                        state = state.copy(cameraStatus = "Camera: webhook reachable (${URL(healthUrl).host})")
                        addEvent("LIVE", "webhook reachable $healthUrl")
                    }
                } else {
                    scope.launch {
                        state = state.copy(cameraStatus = "Camera: webhook returned HTTP $code")
                        addEvent("LIVE", "webhook returned HTTP $code")
                    }
                }
                connection.disconnect()
            } catch (error: Exception) {
                val message = error.message ?: error.javaClass.simpleName
                scope.launch {
                    state = state.copy(cameraStatus = "Camera: webhook test failed: $message")
                    addEvent("LIVE", "webhook test failed: $message")
                }
            }
        }
    }

    fun selectProtocol(protocol: String) {
        val currentUrl = state.streamUrl.trim()
        val shouldUseDefault = currentUrl.isEmpty() || currentUrl in streamDefaultUrls.values
        state = state.copy(
            streamProtocol = protocol,
            streamUrl = if (shouldUseDefault) defaultStreamUrl(protocol) else state.streamUrl,
        )
    }

    fun setStreamUrl(url: String) {
        state = state.copy(streamUrl = url)
    }

    fun toggleStream() = runAction(if (state.streamStartedAt == null) "Start stream" else "Stop stream") {
        if (state.streamStartedAt != null) {
            stopKeepAlive()
            sdk.stopStream()
            state = state.copy(streamStartedAt = null, streamStatus = "Stopped")
            return@runAction
        }
        val params = mapOf(
            "streamUrl" to state.streamUrl.trim(),
            "protocol" to state.streamProtocol,
            "keepAlive" to true,
            "keepAliveIntervalSeconds" to 15,
        )
        sdk.startStream(MentraStreamRequest(params))
        state = state.copy(
            streamStartedAt = System.currentTimeMillis(),
            streamStatus = "LIVE · ${state.streamProtocol.uppercase()}",
        )
        startKeepAlive(params)
    }

    fun requestWifiScan() = runAction("Scan Wi-Fi") {
        sdk.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String) = runAction("Connect Wi-Fi $ssid") {
        sdk.sendWifiCredentials(ssid, "")
    }

    fun toggleHotspot() = runAction(if (state.hotspotEnabled) "Disable hotspot" else "Enable hotspot") {
        val next = !state.hotspotEnabled
        sdk.setHotspotState(next)
        state = state.copy(hotspotEnabled = next)
    }

    fun toggleMic() = runAction(if (state.micRecording) "Stop microphone" else "Start microphone") {
        val next = !state.micRecording
        sdk.setMicState(MentraMicConfig(sendPcmData = next, sendTranscript = false, bypassVad = true))
        state = state.copy(micRecording = next, pcmBytes = if (next) 0 else state.pcmBytes, pcmFrames = if (next) 0 else state.pcmFrames)
    }

    fun selectLedMode(mode: String) = runAction("RGB LED $mode") {
        state = state.copy(ledMode = mode)
        sdk.rgbLedControl(
            MentraRgbLedRequest(
                requestId = "rgb-${System.currentTimeMillis()}",
                packageName = "com.mentra.examples.android",
                action = if (mode == "Off") "off" else mode.lowercase(),
                color = if (mode == "Off") null else "#34C759",
                ontime = if (mode == "Pulse") 600 else 1000,
                offtime = if (mode == "Blink") 400 else 0,
                count = if (mode == "Blink") 5 else 1,
            )
        )
    }

    fun toggleRawJson() {
        state = state.copy(rawJsonExpanded = !state.rawJsonExpanded)
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        state = state.copy(glassesStatus = state.glassesStatus + status.values)
        addEvent("STORE", summarize(status.values))
    }

    override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
        state = state.copy(bluetoothStatus = state.bluetoothStatus + status.values)
        addEvent("BLE", summarize(status.values))
    }

    override fun onDeviceDiscovered(device: MentraDiscoveredDevice) {
        if (state.discoveredDevices.none { it.name == device.name }) {
            state = state.copy(discoveredDevices = state.discoveredDevices + device)
        }
        addEvent("BLE", "discovered ${device.name}")
    }

    override fun onButtonPress(event: MentraButtonPressEvent) {
        addEvent("LIVE", "button ${event.buttonId}: ${event.pressType}")
    }

    override fun onTouch(event: MentraTouchEvent) {
        addEvent("LIVE", "touch ${summarize(event.values)}")
    }

    override fun onBatteryStatus(event: MentraBatteryStatusEvent) {
        state = state.copy(
            glassesStatus = state.glassesStatus + mapOf(
                "batteryLevel" to (event.level ?: -1),
                "charging" to (event.charging ?: false),
            )
        )
        addEvent("STORE", "battery ${event.level ?: "--"}%")
    }

    override fun onWifiStatusChanged(event: MentraWifiStatusEvent) {
        state = state.copy(glassesStatus = state.glassesStatus + event.values)
        addEvent("STORE", "Wi-Fi ${summarize(event.values)}")
    }

    override fun onPhotoResponse(event: com.mentra.core.MentraPhotoResponseEvent) {
        val requestId = event.values["requestId"] as? String ?: event.values["request_id"] as? String
        if (activePhotoRequestId != null && requestId != null && requestId != activePhotoRequestId) {
            addEvent("LIVE", "ignoring stale photo $requestId")
            return
        }
        val success = event.values["success"] as? Boolean
        state = state.copy(
            cameraStatus = if (success == false) {
                "Camera: glasses reported ${event.values["errorCode"] ?: "error"}; waiting for upload"
            } else {
                "Camera: photo acknowledged; waiting for local upload"
            }
        )
        addEvent("LIVE", "photo response ${requestId ?: ""}")
    }

    override fun onStreamStatus(event: com.mentra.core.MentraStreamStatusEvent) {
        state = state.copy(streamStatus = summarize(event.values))
        addEvent("LIVE", "stream ${summarize(event.values)}")
    }

    override fun onMicPcm(frame: ByteArray) {
        state = state.copy(pcmFrames = state.pcmFrames + 1, pcmBytes = state.pcmBytes + frame.size)
    }

    override fun onMicLc3(frame: ByteArray) {
        state = state.copy(pcmFrames = state.pcmFrames + 1, pcmBytes = state.pcmBytes + frame.size)
    }

    override fun onRawEvent(eventName: String, values: Map<String, Any>) {
        addEvent("LIVE", "$eventName ${summarize(values)}")
    }

    override fun onLog(message: String) {
        addEvent("LIVE", message)
    }

    override fun onError(error: MentraBluetoothError) {
        addEvent("TX", "${error.code}: ${error.message}")
    }

    override fun close() {
        stopKeepAlive()
        controllerJob.cancel()
        sdk.close()
    }

    private fun runAction(label: String, action: () -> Unit) {
        state = state.copy(activeAction = label, lastAction = "Running: $label")
        addEvent("TX", label)
        try {
            action()
            state = state.copy(lastAction = "Requested: $label")
        } catch (error: Throwable) {
            state = state.copy(lastAction = "Failed: $label - ${error.message}", activeAction = null)
            addEvent("TX", "$label failed: ${error.message}")
            return
        }
        state = state.copy(activeAction = null)
    }

    private fun addEvent(tag: String, text: String) {
        state = state.copy(events = (listOf(exampleEvent(tag, text)) + state.events).take(30))
    }

    private fun startKeepAlive(params: Map<String, Any>) {
        stopKeepAlive()
        keepAliveJob = scope.launch {
            while (isActive) {
                delay(15_000)
                sdk.keepStreamAlive(MentraStreamKeepAliveRequest(params))
                addEvent("TX", "stream keep alive")
            }
        }
    }

    private fun stopKeepAlive() {
        keepAliveJob?.cancel()
        keepAliveJob = null
    }

    private fun pollPhotoPreview(requestId: String, statusUrl: String, generation: Int) {
        scope.launch(Dispatchers.IO) {
            repeat(45) { attempt ->
                if (activePhotoRequestId != requestId || generation != pollGeneration) return@launch
                try {
                    val url = URL("$statusUrl?poll=${System.currentTimeMillis()}")
                    val connection = url.openConnection() as HttpURLConnection
                    connection.connectTimeout = 1500
                    connection.readTimeout = 1500
                    if (connection.responseCode == 200) {
                        val body = connection.inputStream.bufferedReader().use { it.readText() }
                        val photoUrl = Regex("\"photoUrl\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                        if (photoUrl != null) {
                            scope.launch {
                                state = state.copy(photoPreviewUrl = photoUrl, cameraStatus = "Camera: loaded photo preview")
                                addEvent("LIVE", "local photo ready $photoUrl")
                            }
                            activePhotoRequestId = null
                            return@launch
                        }
                    }
                    if (attempt == 0 || attempt % 10 == 9) {
                        scope.launch { addEvent("LIVE", "waiting for upload $requestId") }
                    }
                } catch (_: Exception) {
                    if (attempt == 0 || attempt % 10 == 9) {
                        scope.launch { addEvent("LIVE", "waiting for local photo server") }
                    }
                }
                delay(1000)
            }
            if (activePhotoRequestId == requestId) {
                scope.launch { state = state.copy(cameraStatus = "Camera: timed out waiting for local server upload") }
            }
        }
    }
}

fun exampleEvent(tag: String, text: String): ExampleEvent =
    ExampleEvent(
        time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date()),
        tag = tag,
        text = text,
    )

fun disconnectedGlassesStatus(): Map<String, Any> =
    mapOf(
        "connected" to false,
        "fullyBooted" to false,
        "batteryLevel" to -1,
        "charging" to false,
        "wifiConnected" to false,
        "wifiSsid" to "",
        "wifiLocalIp" to "",
    )

fun photoStatusUrl(uploadUrlText: String, requestId: String): String {
    val url = URL(uploadUrlText)
    if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalArgumentException("Only http and https webhook URLs are supported.")
    }
    return "${url.protocol}://${url.host}:${url.port.takeIf { it >= 0 } ?: url.defaultPort}/uploads/$requestId.json"
}

fun webhookHealthUrl(uploadUrlText: String): String {
    val url = URL(uploadUrlText)
    if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalArgumentException("Only http and https webhook URLs are supported.")
    }
    val port = url.port.takeIf { it >= 0 }?.let { ":$it" } ?: ""
    return "${url.protocol}://${url.host}$port/"
}

fun summarize(values: Map<String, Any>): String =
    values.entries.take(3).joinToString(", ") { "${it.key}: ${it.value}" }.ifBlank { "empty update" }

fun stringValue(values: Map<String, Any>, key: String): String? = values[key] as? String

fun intValue(values: Map<String, Any>, key: String): Int? =
    when (val value = values[key]) {
        is Int -> value
        is Number -> value.toInt()
        else -> null
    }

fun boolValue(values: Map<String, Any>, key: String): Boolean? = values[key] as? Boolean

fun connectionLabel(values: Map<String, Any>): String =
    stringValue(values, "connectionState")
        ?: if (boolValue(values, "connected") == true) "CONNECTED" else "WAITING"

fun deviceLabel(values: Map<String, Any>): String =
    stringValue(values, "bluetoothName")
        ?: stringValue(values, "serialNumber")
        ?: stringValue(values, "deviceModel")
        ?: "Mentra Live"

fun modelLabel(values: Map<String, Any>): String =
    stringValue(values, "deviceModel") ?: "Mentra Live"

fun batteryLevel(values: Map<String, Any>): Int? {
    val level = intValue(values, "batteryLevel") ?: return null
    return if (level < 0 || boolValue(values, "connected") == false) null else level.coerceAtMost(100)
}

fun batteryLabel(values: Map<String, Any>): String =
    batteryLevel(values)?.let { "$it%${if (boolValue(values, "charging") == true) " charging" else ""}" }
        ?: if (boolValue(values, "connected") == false) "Not connected" else "Waiting for status"

fun wifiLabel(values: Map<String, Any>): String =
    if (boolValue(values, "wifiConnected") == true) {
        stringValue(values, "wifiSsid") ?: "Connected"
    } else {
        "Unknown"
    }

fun firmwareLabel(values: Map<String, Any>): String =
    stringValue(values, "appVersion")
        ?: stringValue(values, "fwVersion")
        ?: stringValue(values, "mtkFwVersion")
        ?: stringValue(values, "besFwVersion")
        ?: "Unknown"

fun rssiLabel(values: Map<String, Any>): String =
    intValue(values, "signalStrength")?.let { "$it dBm" } ?: "Unknown"

fun bluetoothSearchLabel(values: Map<String, Any>): String {
    val searching = boolValue(values, "searching") == true
    val count = (values["searchResults"] as? List<*>)?.size ?: 0
    return "${if (searching) "Scanning" else "Idle"} · $count result${if (count == 1) "" else "s"}"
}

fun wifiScanResults(values: Map<String, Any>): List<Map<String, Any>> =
    (values["wifiScanResults"] as? List<*>)?.mapNotNull { value ->
        val map = value as? Map<*, *> ?: return@mapNotNull null
        map.entries.mapNotNull { (key, mapValue) ->
            mapValue?.let { key.toString() to it }
        }.toMap()
    } ?: emptyList()

fun elapsedText(startedAt: Long?): String {
    val elapsed = if (startedAt == null) 0 else ((System.currentTimeMillis() - startedAt) / 1000).coerceAtLeast(0)
    val h = elapsed / 3600
    val m = (elapsed % 3600) / 60
    val s = elapsed % 60
    return "%02d:%02d:%02d".format(h, m, s)
}
