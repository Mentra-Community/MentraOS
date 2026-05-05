package com.mentra.examples.android

import android.content.Context
import android.media.MediaPlayer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.mentra.core.MentraBatteryStatusEvent
import com.mentra.core.MentraBluetoothError
import com.mentra.core.MentraBluetoothSdk
import com.mentra.core.MentraBluetoothSdkCallback
import com.mentra.core.MentraBluetoothStatusUpdate
import com.mentra.core.MentraButtonPhotoSettings
import com.mentra.core.MentraButtonPhotoSize
import com.mentra.core.MentraButtonPressEvent
import com.mentra.core.MentraButtonVideoRecordingSettings
import com.mentra.core.MentraCameraFov
import com.mentra.core.MentraDashboardPositionRequest
import com.mentra.core.MentraDeviceModel
import com.mentra.core.MentraDiscoveredDevice
import com.mentra.core.MentraGalleryMode
import com.mentra.core.MentraGlassesStatusUpdate
import com.mentra.core.MentraMicConfig
import com.mentra.core.MentraPhotoCompression
import com.mentra.core.MentraPhotoRequest
import com.mentra.core.MentraPhotoSize
import com.mentra.core.MentraRgbLedAction
import com.mentra.core.MentraRgbLedColor
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
import java.net.URI
import java.net.URL
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

val streamDefaultUrls = mapOf(
    "rtmp" to "rtmp://<computer-ip>:1935/live/mentra-live",
    "srt" to "srt://srt.example.com:4201?streamid=YOUR_STREAM_ID&passphrase=YOUR_PASSPHRASE",
    "webrtc" to "http://<computer-ip>:8889/mentra-live/whip",
)

fun defaultStreamUrl(protocol: String): String = streamDefaultUrls[protocol] ?: streamDefaultUrls.getValue("rtmp")

fun streamProtocolLabel(protocol: String): String = if (protocol == "webrtc") "WHIP" else protocol.uppercase()

data class ExampleEvent(
    val time: String,
    val tag: String,
    val text: String,
)

private data class RgbLedPattern(
    val action: MentraRgbLedAction,
    val color: MentraRgbLedColor?,
    val ontime: Int,
    val offtime: Int,
    val count: Int,
    val brightness: Int?,
)

val rgbLedColorOptions = MentraRgbLedColor.values().map { it.value }

data class MentraExampleState(
    val activeAction: String? = null,
    val bluetoothStatus: Map<String, Any> = emptyMap(),
    val cameraStatus: String = "Camera: enter the local webhook /upload URL",
    val discoveredDevices: List<MentraDiscoveredDevice> = emptyList(),
    val events: List<ExampleEvent> = listOf(exampleEvent("LIVE", "SDK ready. Scan to discover glasses.")),
    val glassesStatus: Map<String, Any> = emptyMap(),
    val hotspotEnabled: Boolean = false,
    val lastAction: String = "No actions yet.",
    val ledBrightnessPercent: Int = 72,
    val ledColor: String = "green",
    val ledMode: String = "Solid",
    val lastMicBytes: Int = 0,
    val lastMicDurationSeconds: Int? = null,
    val micElapsedSeconds: Int = 0,
    val micPlaying: Boolean = false,
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
    private var activeStreamId: String? = null
    private var pollGeneration = 0
    private var keepAliveJob: Job? = null
    private var lastMicFile: File? = null
    private var micElapsedJob: Job? = null
    private var micPlayer: MediaPlayer? = null
    private var micPcmBuffer = ByteArrayOutputStream()
    private var micStartedAt: Long? = null

    private val micSampleRate = 16_000
    private val micChannelCount = 1
    private val micBitsPerSample = 16

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
        applyDisconnectedState("Disconnected")
    }

    fun displayHello() = runAction("Display Hello") {
        requireConnected("display text")
        sdk.displayText(com.mentra.core.MentraDisplayTextRequest("Hello from Mentra Bluetooth SDK"))
    }

    fun clearDisplay() = runAction("Clear Display") {
        requireConnected("clear the display")
        sdk.clearDisplay()
    }

    fun applySettings() = runAction("Apply Settings") {
        requireConnected("apply settings")
        sdk.setBrightness(72)
        sdk.setDashboardPosition(MentraDashboardPositionRequest(height = 4, depth = 6))
        sdk.setGalleryMode(MentraGalleryMode.AUTO)
        sdk.setButtonPhotoSettings(MentraButtonPhotoSettings(MentraButtonPhotoSize.MEDIUM))
        sdk.setButtonVideoRecordingSettings(MentraButtonVideoRecordingSettings(width = 1920, height = 1080, fps = 30))
        sdk.setButtonCameraLed(true)
        sdk.setButtonMaxRecordingTime(5)
        sdk.setCameraFov(MentraCameraFov.STANDARD)
    }

    fun setWebhookUrl(url: String) {
        state = state.copy(webhookUrl = url)
    }

    fun captureAndUpload() = runAction("Capture & upload") {
        requireConnected("capture photos")
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
                size = MentraPhotoSize.MEDIUM,
                webhookUrl = uploadUrl,
                compress = MentraPhotoCompression.MEDIUM,
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
            if (isGlassesConnected()) {
                sdk.stopStream()
            }
            state = state.copy(streamStartedAt = null, streamStatus = "Stopped")
            return@runAction
        }
        requireConnected("start streaming")
        val streamUrl = state.streamUrl.trim()
        streamUrlValidationMessage(streamUrl)?.let { message ->
            state = state.copy(streamStatus = message)
            throw IllegalArgumentException(message)
        }
        val streamId = "android-${System.currentTimeMillis()}"
        val selectedProtocol = state.streamProtocol
        if (selectedProtocol == "rtmp" || selectedProtocol == "webrtc") {
            state = state.copy(streamStatus = "Checking local ${selectedProtocol.uppercase()} server")
            scope.launch(Dispatchers.IO) {
                val reachabilityMessage = if (selectedProtocol == "rtmp") {
                    localRtmpReachabilityMessage(streamUrl)
                } else {
                    localWebrtcReachabilityMessage(streamUrl)
                }
                scope.launch {
                    if (reachabilityMessage != null) {
                        state = state.copy(streamStatus = reachabilityMessage)
                        addEvent("TX", "stream failed: $reachabilityMessage")
                        return@launch
                    }
                    startStream(streamUrl, streamId, selectedProtocol)
                }
            }
            return@runAction
        }
        startStream(streamUrl, streamId, selectedProtocol)
    }

    private fun startStream(streamUrl: String, streamId: String, protocol: String) {
        sdk.startStream(
            MentraStreamRequest(
                streamUrl = streamUrl,
                streamId = streamId,
                keepAlive = true,
                keepAliveIntervalSeconds = 15,
            )
        )
        activeStreamId = streamId
        state = state.copy(streamStatus = "Requested ${protocol.uppercase()} stream; waiting for glasses")
    }

    fun requestWifiScan() = runAction("Scan Wi-Fi") {
        requireConnected("scan Wi-Fi")
        sdk.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String) = runAction("Connect Wi-Fi $ssid") {
        requireConnected("send Wi-Fi credentials")
        sdk.sendWifiCredentials(ssid, "")
    }

    fun toggleHotspot() = runAction(if (state.hotspotEnabled) "Disable hotspot" else "Enable hotspot") {
        requireConnected("toggle hotspot")
        val next = !state.hotspotEnabled
        sdk.setHotspotState(next)
        state = state.copy(hotspotEnabled = next)
    }

    fun toggleMic() = runAction(if (state.micRecording) "Stop microphone" else "Start microphone") {
        if (state.micRecording) {
            stopMicRecording()
        } else {
            startMicRecording()
        }
    }

    fun playMicRecording() = runAction(if (state.micPlaying) "Stop mic playback" else "Play mic recording") {
        if (state.micPlaying) {
            stopMicPlayback()
            return@runAction
        }
        startMicPlayback()
    }

    fun selectLedMode(mode: String) = runAction("RGB LED $mode") {
        requireConnected("control the RGB LED")
        state = state.copy(ledMode = mode)
        sendRgbLedRequest(mode, state.ledColor, state.ledBrightnessPercent)
    }

    fun selectLedColor(color: String) = runAction("RGB LED color ${color.uppercase(Locale.US)}") {
        requireConnected("control the RGB LED")
        if (color !in rgbLedColorOptions) {
            throw IllegalArgumentException("Unsupported RGB LED color: $color")
        }
        state = state.copy(ledColor = color)
        if (state.ledMode != "Off") {
            sendRgbLedRequest(state.ledMode, color, state.ledBrightnessPercent)
        }
    }

    fun setLedBrightnessPercent(percent: Int) {
        state = state.copy(ledBrightnessPercent = percent.coerceIn(0, 100))
    }

    fun commitLedBrightness() = runAction("RGB LED brightness ${state.ledBrightnessPercent}%") {
        requireConnected("control the RGB LED")
        if (state.ledMode != "Off") {
            sendRgbLedRequest(state.ledMode, state.ledColor, state.ledBrightnessPercent)
        }
    }

    private fun sendRgbLedRequest(mode: String, color: String, brightnessPercent: Int) {
        val request = rgbLedRequestFor(mode, color, brightnessPercent)
        sdk.rgbLedControl(
            MentraRgbLedRequest(
                requestId = "rgb-${System.currentTimeMillis()}",
                packageName = "com.mentra.examples.android",
                action = request.action,
                color = request.color,
                ontime = request.ontime,
                offtime = request.offtime,
                count = request.count,
                brightness = request.brightness,
            )
        )
    }

    private fun rgbLedRequestFor(mode: String, color: String, brightnessPercent: Int): RgbLedPattern {
        val brightness = rgbBrightnessValue(brightnessPercent)
        return when (mode) {
            "Solid" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 30_000, 0, 1, brightness)
            "Pulse" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 900, 900, 6, brightness)
            "Blink" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 250, 250, 12, brightness)
            else -> RgbLedPattern(MentraRgbLedAction.OFF, null, 0, 0, 0, null)
        }
    }

    fun toggleRawJson() {
        state = state.copy(rawJsonExpanded = !state.rawJsonExpanded)
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        state = state.copy(glassesStatus = state.glassesStatus + status.values)
        if (isDisconnectedStatus(status.values)) {
            applyDisconnectedState("Disconnected")
        }
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
        applyStreamStatus(event.values)
        state = state.copy(streamStatus = summarize(event.values))
        addEvent("LIVE", "stream ${summarize(event.values)}")
    }

    override fun onMicPcm(frame: ByteArray) {
        if (!state.micRecording) return
        micPcmBuffer.write(frame)
        state = state.copy(pcmFrames = state.pcmFrames + 1, pcmBytes = state.pcmBytes + frame.size)
    }

    override fun onMicLc3(frame: ByteArray) {
        if (!state.micRecording) return
        addEvent("LIVE", "received LC3 mic frame while PCM recording is enabled")
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
        stopMicElapsedTimer()
        stopMicPlayback()
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

    private fun isGlassesConnected(): Boolean = isGlassesConnected(state.glassesStatus)

    private fun requireConnected(feature: String) {
        if (isGlassesConnected()) {
            return
        }
        val message = "Connect glasses first to $feature."
        if ("photo" in feature || "capture" in feature) {
            state = state.copy(cameraStatus = message)
        }
        if ("stream" in feature) {
            state = state.copy(streamStatus = message)
        }
        addEvent("TX", message)
        throw IllegalStateException(message)
    }

    private fun applyDisconnectedState(status: String) {
        stopKeepAlive()
        activeStreamId = null
        val hadPhotoRequest = activePhotoRequestId != null
        activePhotoRequestId = null
        if (hadPhotoRequest) {
            pollGeneration += 1
        }
        state = state.copy(
            glassesStatus = disconnectedGlassesStatus(),
            streamStartedAt = null,
            streamStatus = status,
            hotspotEnabled = false,
            micRecording = false,
            cameraStatus = if (hadPhotoRequest) "Disconnected before photo upload completed" else state.cameraStatus,
        )
        stopMicElapsedTimer()
        stopMicPlayback()
    }

    private fun applyStreamStatus(values: Map<String, Any>) {
        when (values["status"] as? String) {
            "streaming", "initializing", "starting" -> {
                activeStreamId = values["streamId"] as? String ?: activeStreamId
                state = state.copy(streamStartedAt = state.streamStartedAt ?: System.currentTimeMillis())
                if (keepAliveJob == null) {
                    startKeepAlive(activeStreamId ?: return)
                }
            }
            "stopped", "stopping", "error", "error_not_streaming" -> {
                stopKeepAlive()
                activeStreamId = null
                state = state.copy(streamStartedAt = null)
            }
        }
    }

    private fun startKeepAlive(streamId: String) {
        stopKeepAlive()
        keepAliveJob = scope.launch {
            while (isActive) {
                delay(15_000)
                sdk.keepStreamAlive(
                    MentraStreamKeepAliveRequest(
                        streamId = streamId,
                        ackId = "ack-${System.currentTimeMillis()}",
                    ),
                )
                addEvent("TX", "stream keep alive")
            }
        }
    }

    private fun stopKeepAlive() {
        keepAliveJob?.cancel()
        keepAliveJob = null
    }

    private fun startMicRecording() {
        requireConnected("stream microphone audio")
        stopMicPlayback()
        micPcmBuffer.reset()
        lastMicFile = null
        micStartedAt = System.currentTimeMillis()
        state = state.copy(
            micRecording = true,
            micElapsedSeconds = 0,
            pcmBytes = 0,
            pcmFrames = 0,
            lastMicBytes = 0,
            lastMicDurationSeconds = null,
        )
        sdk.setMicState(MentraMicConfig(sendPcmData = true, sendTranscript = false, bypassVad = true))
        startMicElapsedTimer()
    }

    private fun stopMicRecording() {
        if (isGlassesConnected()) {
            sdk.setMicState(MentraMicConfig(sendPcmData = false, sendTranscript = false, bypassVad = true))
        }
        stopMicElapsedTimer()
        val pcm = micPcmBuffer.toByteArray()
        val durationSeconds = maxOf(state.micElapsedSeconds, estimatedMicDurationSeconds(pcm.size))
        state = state.copy(
            micRecording = false,
            lastMicBytes = pcm.size,
            lastMicDurationSeconds = durationSeconds.takeIf { pcm.isNotEmpty() },
        )

        if (pcm.isEmpty()) {
            lastMicFile = null
            addEvent("LIVE", "microphone stopped with no PCM frames")
            return
        }

        val file = File(appContext.cacheDir, "mentra-mic-last.wav")
        file.writeBytes(wavBytes(pcm))
        lastMicFile = file
        addEvent("LIVE", "saved microphone WAV ${pcm.size} bytes")
    }

    private fun startMicPlayback(restart: Boolean = false) {
        val file = lastMicFile ?: throw IllegalStateException("Record microphone audio before playback.")
        if (!file.exists() || state.lastMicBytes <= 0) {
            throw IllegalStateException("Record microphone audio before playback.")
        }

        stopMicPlayback()
        try {
            val player = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    scope.launch { stopMicPlayback() }
                }
                setOnErrorListener { _, what, extra ->
                    scope.launch {
                        addEvent("TX", "mic playback failed: $what/$extra")
                        stopMicPlayback()
                    }
                    true
                }
                prepare()
                if (restart) seekTo(0)
                start()
            }
            micPlayer = player
            sdk.setOwnAppAudioPlaying(true)
            state = state.copy(micPlaying = true)
        } catch (error: Throwable) {
            stopMicPlayback()
            throw error
        }
    }

    private fun stopMicPlayback() {
        micPlayer?.let { player ->
            runCatching {
                player.setOnCompletionListener(null)
                player.setOnErrorListener(null)
                if (player.isPlaying) player.stop()
            }
            player.release()
        }
        micPlayer = null
        if (state.micPlaying) {
            sdk.setOwnAppAudioPlaying(false)
        }
        state = state.copy(micPlaying = false)
    }

    private fun startMicElapsedTimer() {
        stopMicElapsedTimer()
        micElapsedJob = scope.launch {
            while (isActive) {
                val startedAt = micStartedAt ?: return@launch
                state = state.copy(micElapsedSeconds = ((System.currentTimeMillis() - startedAt) / 1000).toInt().coerceAtLeast(0))
                delay(250)
            }
        }
    }

    private fun stopMicElapsedTimer() {
        micElapsedJob?.cancel()
        micElapsedJob = null
        micStartedAt = null
    }

    private fun estimatedMicDurationSeconds(byteCount: Int): Int {
        val bytesPerSecond = micSampleRate * micChannelCount * micBitsPerSample / 8
        return if (byteCount <= 0) 0 else ((byteCount + bytesPerSecond - 1) / bytesPerSecond)
    }

    private fun wavBytes(pcm: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.writeAscii("RIFF")
        out.writeUInt32Le(36 + pcm.size)
        out.writeAscii("WAVE")
        out.writeAscii("fmt ")
        out.writeUInt32Le(16)
        out.writeUInt16Le(1)
        out.writeUInt16Le(micChannelCount)
        out.writeUInt32Le(micSampleRate)
        out.writeUInt32Le(micSampleRate * micChannelCount * micBitsPerSample / 8)
        out.writeUInt16Le(micChannelCount * micBitsPerSample / 8)
        out.writeUInt16Le(micBitsPerSample)
        out.writeAscii("data")
        out.writeUInt32Le(pcm.size)
        out.write(pcm)
        return out.toByteArray()
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

fun rgbBrightnessValue(percent: Int): Int = ((percent.coerceIn(0, 100) * 255) / 100.0).roundToInt()

fun rgbLedColorFor(color: String): MentraRgbLedColor =
    MentraRgbLedColor.fromValue(color) ?: MentraRgbLedColor.RED

fun disconnectedGlassesStatus(): Map<String, Any> =
    mapOf(
        "connected" to false,
        "connectionState" to "DISCONNECTED",
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

fun localRtmpReachabilityMessage(rtmpUrlText: String): String? {
    val previewUrl = try {
        rtmpHlsPreviewUrl(rtmpUrlText)
    } catch (_: Exception) {
        return "Enter a valid rtmp:// or rtmps:// publish URL."
    }
    if (previewUrl == null) {
        return null
    }

    return localHttpPreviewReachabilityMessage(previewUrl, ::localRtmpSetupMessage)
}

fun localWebrtcReachabilityMessage(whipUrlText: String): String? {
    val previewUrl = try {
        webrtcPreviewUrl(whipUrlText)
    } catch (_: Exception) {
        return "Enter a valid http:// or https:// WHIP URL."
    }

    return localHttpPreviewReachabilityMessage(previewUrl, ::localWebrtcSetupMessage)
}

fun localHttpPreviewReachabilityMessage(previewUrl: String, setupMessage: (String) -> String): String? {
    return try {
        val connection = URL(previewUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 1500
        connection.readTimeout = 1500
        // MediaMTX may return 404 before a stream exists; any HTTP response means it is reachable.
        connection.responseCode
        connection.disconnect()
        null
    } catch (error: Exception) {
        setupMessage(error.message ?: error.javaClass.simpleName)
    }
}

fun rtmpHlsPreviewUrl(rtmpUrlText: String): String? {
    val uri = URI(rtmpUrlText)
    val scheme = uri.scheme ?: throw IllegalArgumentException("Missing RTMP URL scheme.")
    if (scheme != "rtmp" && scheme != "rtmps") {
        throw IllegalArgumentException("Only rtmp and rtmps URLs are supported.")
    }
    val host = uri.host ?: throw IllegalArgumentException("Missing RTMP host.")
    if (!isLocalPreviewHost(host)) {
        return null
    }
    val path = uri.rawPath?.ifBlank { "/" } ?: "/"
    val previewScheme = if (scheme == "rtmps") "https" else "http"
    return "$previewScheme://$host:8888$path"
}

fun isLocalPreviewHost(host: String): Boolean {
    val normalized = host.lowercase()
    if (
        normalized == "localhost" ||
        normalized.endsWith(".local") ||
        normalized.startsWith("192.168.") ||
        normalized.startsWith("10.") ||
        normalized.startsWith("169.254.")
    ) {
        return true
    }
    val parts = normalized.split(".").mapNotNull { it.toIntOrNull() }
    return parts.size == 4 && parts[0] == 172 && parts[1] in 16..31
}

fun webrtcPreviewUrl(whipUrlText: String): String {
    val url = URL(whipUrlText)
    if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalArgumentException("Only http and https WHIP URLs are supported.")
    }
    val port = url.port.takeIf { it >= 0 }?.let { ":$it" } ?: ""
    val path = url.path.removeSuffix("/whip").ifBlank { "/" }
    return "${url.protocol}://${url.host}$port$path"
}

fun localRtmpSetupMessage(detail: String): String =
    "Local RTMP/HLS server not reachable ($detail). Run python3 examples/local-demo-cloud/server.py and paste the printed RTMP publish URL."

fun localWebrtcSetupMessage(detail: String): String =
    "Local WebRTC server not reachable ($detail). Run python3 examples/local-demo-cloud/server.py and paste the printed WHIP publish URL."

fun streamUrlValidationMessage(streamUrl: String): String? = when {
    streamUrl.isEmpty() -> "Stream URL is required."
    streamUrl.contains("<computer-ip>") ->
        "Replace <computer-ip> with the matching publish URL printed by local demo cloud."
    streamUrl.contains("<") || streamUrl.contains(">") || streamUrl.contains("YOUR_") ->
        "Replace the placeholder stream URL before starting."
    rtmpPathSegmentCount(streamUrl)?.let { it < 2 } == true ->
        "RTMP URL must include an app and stream key, for example rtmp://<computer-ip>:1935/live/mentra-live."
    else -> null
}

fun rtmpPathSegmentCount(streamUrl: String): Int? {
    val uri = runCatching { URI(streamUrl) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "rtmp" && scheme != "rtmps") {
        return null
    }
    return uri.rawPath
        ?.split("/")
        ?.count { it.isNotBlank() }
        ?: 0
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
        ?: if (isGlassesConnected(values)) "CONNECTED" else "WAITING"

fun isGlassesConnected(values: Map<String, Any>): Boolean {
    return when (stringValue(values, "connectionState")?.lowercase()) {
        "connected" -> true
        "disconnected" -> false
        else -> boolValue(values, "connected") == true
    }
}

fun isDisconnectedStatus(values: Map<String, Any>): Boolean {
    return when (stringValue(values, "connectionState")?.lowercase()) {
        "disconnected" -> true
        "connected" -> false
        else -> boolValue(values, "connected") == false
    }
}

fun deviceLabel(values: Map<String, Any>): String =
    stringValue(values, "bluetoothName")
        ?: stringValue(values, "serialNumber")
        ?: stringValue(values, "deviceModel")
        ?: "Mentra Live"

fun modelLabel(values: Map<String, Any>): String =
    stringValue(values, "deviceModel") ?: "Mentra Live"

fun batteryLevel(values: Map<String, Any>): Int? {
    val level = intValue(values, "batteryLevel") ?: return null
    return if (level < 0 || !isGlassesConnected(values)) null else level.coerceAtMost(100)
}

fun batteryLabel(values: Map<String, Any>): String =
    batteryLevel(values)?.let { "$it%${if (boolValue(values, "charging") == true) " charging" else ""}" }
        ?: if (isDisconnectedStatus(values)) "Not connected" else "Waiting for status"

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
    return durationText(elapsed.toInt())
}

fun durationText(seconds: Int): String {
    val elapsed = seconds.coerceAtLeast(0)
    val h = elapsed / 3600
    val m = (elapsed % 3600) / 60
    val s = elapsed % 60
    return "%02d:%02d:%02d".format(h, m, s)
}

private fun ByteArrayOutputStream.writeAscii(value: String) {
    write(value.toByteArray(Charsets.US_ASCII))
}

private fun ByteArrayOutputStream.writeUInt16Le(value: Int) {
    write(value and 0xff)
    write((value shr 8) and 0xff)
}

private fun ByteArrayOutputStream.writeUInt32Le(value: Int) {
    write(value and 0xff)
    write((value shr 8) and 0xff)
    write((value shr 16) and 0xff)
    write((value shr 24) and 0xff)
}
