package com.mentra.examples.android

import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.mentra.core.MentraBatteryStatusEvent
import com.mentra.core.MentraBluetoothError
import com.mentra.core.MentraBluetoothSdk
import com.mentra.core.MentraBluetoothSdkCallback
import com.mentra.core.MentraBluetoothStatusUpdate
import com.mentra.core.MentraButtonPressEvent
import com.mentra.core.MentraDeviceModel
import com.mentra.core.MentraDiscoveredDevice
import com.mentra.core.MentraGalleryMode
import com.mentra.core.MentraGlassesStatusUpdate
import com.mentra.core.MentraHotspotErrorEvent
import com.mentra.core.MentraHotspotStatusEvent
import com.mentra.core.MentraMicConfig
import com.mentra.core.MentraPairedDevice
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
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

val streamDefaultUrls = mapOf(
    "rtmp" to "rtmp://<computer-ip>:1935/live/mentra-live",
    "srt" to "srt://<computer-ip>:8890?streamid=publish:mentra-live",
    "webrtc" to "http://<computer-ip>:8889/mentra-live/whip",
)

const val photoUploadDefaultUrl = "http://<computer-ip>:8787/upload"

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
)

private data class AudioProfileStatus(
    val label: String,
    val connected: Boolean,
)

private data class GalleryServerCheck(
    val reachable: Boolean,
    val status: String,
    val eventTag: String,
    val eventText: String,
)

val rgbLedColorOptions = MentraRgbLedColor.values().map { it.value }
const val MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD = "00001111"

data class MentraExampleState(
    val activeAction: String? = null,
    val bluetoothStatus: Map<String, Any> = emptyMap(),
    val cameraStatus: String = "Camera: replace <computer-ip> in the Photo upload URL",
    val discoveredDevices: List<MentraDiscoveredDevice> = emptyList(),
    val selectedDiscoveredDevice: MentraDiscoveredDevice? = null,
    val events: List<ExampleEvent> = listOf(exampleEvent("LIVE", "SDK ready. Scan to discover glasses.")),
    val galleryModeAuto: Boolean = false,
    val galleryServerReachable: Boolean? = null,
    val galleryServerStatus: String = "Gallery server: enable hotspot to check",
    val glassesStatus: Map<String, Any> = emptyMap(),
    val glassesMediaVolume: Int? = null,
    val glassesVolumeStatus: String = "Glasses volume: not checked",
    val hotspotEnabled: Boolean = false,
    val lastAction: String = "No actions yet.",
    val ledColor: String = "green",
    val ledMode: String = "Off",
    val lastMicBytes: Int = 0,
    val lastMicDurationSeconds: Int? = null,
    val micElapsedSeconds: Int = 0,
    val micPlaybackHint: String? = null,
    val micPlaying: Boolean = false,
    val micRecording: Boolean = false,
    val pcmBytes: Int = 0,
    val pcmFrames: Int = 0,
    val photoPreviewUrl: String? = null,
    val photoCompression: String = "medium",
    val photoFlash: Boolean = false,
    val photoSize: String = "medium",
    val audioBondStatus: String = "Bond: checking",
    val audioMediaStatus: String = "Media: checking A2DP",
    val audioMediaConnected: Boolean = false,
    val phoneAudioRoute: String = "Phone media output",
    val phoneMediaVolume: Int? = null,
    val phoneMediaVolumeMax: Int? = null,
    val rawJsonExpanded: Boolean = false,
    val streamProtocol: String = "rtmp",
    val streamRequested: Boolean = false,
    val streamPreviewReady: Boolean = false,
    val streamStartedAt: Long? = null,
    val streamStatus: String = "Ready to start stream",
    val streamUrl: String = defaultStreamUrl("rtmp"),
    val webhookUrl: String = photoUploadDefaultUrl,
    val wifiPendingSsid: String? = null,
)

class MentraExampleController(context: Context) : MentraBluetoothSdkCallback(), AutoCloseable {
    var state by mutableStateOf(MentraExampleState())
        private set

    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private val defaultDevicePrefs =
        appContext.getSharedPreferences("mentra_example_default_device", Context.MODE_PRIVATE)
    private val mentraBluetoothSdk = MentraBluetoothSdk.create(appContext, this)
    private val controllerJob = Job()
    private val scope = CoroutineScope(Dispatchers.Main + controllerJob)
    private var activePhotoRequestId: String? = null
    private var activeStreamId: String? = null
    private var pollGeneration = 0
    private var keepAliveJob: Job? = null
    private var previewHealthJob: Job? = null
    private var lastMicFile: File? = null
    private var micElapsedJob: Job? = null
    private var micPlayer: MediaPlayer? = null
    private var micPcmBuffer = ByteArrayOutputStream()
    private var micStartedAt: Long? = null
    private var bluetoothA2dp: BluetoothA2dp? = null
    private var audioObserversRegistered = false
    private var volumeRefreshJob: Job? = null

    private val micSampleRate = 16_000
    private val micChannelCount = 1
    private val micBitsPerSample = 16

    companion object {
        private const val ACTION_VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION"
        private const val EXTRA_VOLUME_STREAM_TYPE = "android.media.EXTRA_VOLUME_STREAM_TYPE"
        private const val DEFAULT_DEVICE_SCHEMA_KEY = "version"
        private const val DEFAULT_DEVICE_MODEL_KEY = "model"
        private const val DEFAULT_DEVICE_NAME_KEY = "name"
        private const val DEFAULT_DEVICE_ADDRESS_KEY = "address"
        private const val DEFAULT_DEVICE_SAVED_AT_KEY = "saved_at"
    }

    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
            scope.launch { refreshAudioSystemState() }
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
            scope.launch { refreshAudioSystemState() }
        }
    }

    private val audioStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                BluetoothDevice.ACTION_BOND_STATE_CHANGED,
                BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED -> refreshAudioSystemState()
                ACTION_VOLUME_CHANGED -> {
                    val streamType = intent.getIntExtra(EXTRA_VOLUME_STREAM_TYPE, -1)
                    if (streamType == AudioManager.STREAM_MUSIC) {
                        refreshAudioSystemState()
                        scheduleGlassesVolumeRefresh()
                    }
                }
            }
        }
    }

    private val a2dpServiceListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile?) {
            if (profile == BluetoothProfile.A2DP) {
                bluetoothA2dp = proxy as? BluetoothA2dp
                scope.launch { refreshAudioSystemState() }
            }
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile == BluetoothProfile.A2DP) {
                bluetoothA2dp = null
                scope.launch { refreshAudioSystemState() }
            }
        }
    }

    init {
        val savedDefaultDevice = loadPersistedDefaultDevice()
        savedDefaultDevice?.let { mentraBluetoothSdk.setDefaultDevice(it) }
        val initialGlassesStatus = mentraBluetoothSdk.getGlassesStatus().values
        val initialBluetoothStatus = mentraBluetoothSdk.getBluetoothStatus().values
        state = state.copy(
            glassesStatus = initialGlassesStatus,
            bluetoothStatus = initialBluetoothStatus,
            galleryModeAuto = galleryModeAuto(initialBluetoothStatus),
            hotspotEnabled = boolValue(initialGlassesStatus, "hotspotEnabled") ?: false,
            phoneAudioRoute = currentAudioOutputRouteLabel(),
        )
        registerAudioStateObservers()
        refreshAudioSystemState()
        if (savedDefaultDevice != null) {
            autoConnectDefaultOnStartup()
        }
    }

    fun startScan() = runAction("Scan") {
        state = state.copy(discoveredDevices = emptyList(), selectedDiscoveredDevice = null)
        mentraBluetoothSdk.startScan(MentraDeviceModel.MENTRA_LIVE)
    }

    fun connect() = runAction("Connect") {
        val target = state.selectedDiscoveredDevice
        when {
            target != null -> mentraBluetoothSdk.connect(target)
            state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus) -> mentraBluetoothSdk.connectDefault()
            state.discoveredDevices.isNotEmpty() -> throw IllegalStateException("Choose one of the discovered glasses first.")
            else -> throw IllegalStateException("Scan first to choose nearby glasses.")
        }
    }

    fun connect(device: MentraDiscoveredDevice) = runAction("Connect ${device.name}") {
        state = state.copy(selectedDiscoveredDevice = device)
        mentraBluetoothSdk.connect(device)
    }

    fun selectDiscoveredDevice(device: MentraDiscoveredDevice) {
        state = state.copy(
            selectedDiscoveredDevice = device,
            lastAction = "Selected: ${device.name}",
        )
    }

    fun disconnect() = runAction("Disconnect") {
        stopKeepAlive()
        stopPreviewHealthPoll()
        mentraBluetoothSdk.disconnect()
        applyDisconnectedState("Disconnected")
    }

    fun clearDefaultDevice() = runAction("Clear default") {
        mentraBluetoothSdk.clearDefaultDevice()
        state = state.copy(
            bluetoothStatus = state.bluetoothStatus + defaultDeviceStatus(null),
            selectedDiscoveredDevice = null,
        )
    }

    fun displayHello() = runAction("Display Hello") {
        requireConnected("display text")
        mentraBluetoothSdk.displayText(com.mentra.core.MentraDisplayTextRequest("Hello from Mentra Bluetooth SDK"))
    }

    fun clearDisplay() = runAction("Clear Display") {
        requireConnected("clear the display")
        mentraBluetoothSdk.clearDisplay()
    }

    fun setGalleryModeAuto(enabled: Boolean) = runAction(if (enabled) "Save in gallery mode" else "Report button events") {
        requireConnected("change gallery mode")
        mentraBluetoothSdk.setGalleryMode(if (enabled) MentraGalleryMode.AUTO else MentraGalleryMode.MANUAL)
        state = state.copy(galleryModeAuto = enabled)
    }

    fun setWebhookUrl(url: String) {
        state = state.copy(webhookUrl = url)
    }

    fun setPhotoSize(size: String) {
        state = state.copy(photoSize = size)
    }

    fun setPhotoCompression(compression: String) {
        state = state.copy(photoCompression = compression)
    }

    fun setPhotoFlash(enabled: Boolean) {
        state = state.copy(photoFlash = enabled)
    }

    fun captureAndUpload() = runAction("Capture & upload") {
        requireConnected("capture photos")
        val uploadUrl = state.webhookUrl.trim()
        photoUploadValidationMessage(uploadUrl)?.let { message ->
            state = state.copy(cameraStatus = "Camera: $message")
            throw IllegalArgumentException(message)
        }
        val requestId = "photo-${System.currentTimeMillis()}"
        val statusUrl = try {
            photoStatusUrl(uploadUrl, requestId)
        } catch (_: Exception) {
            state = state.copy(cameraStatus = "Camera: enter a valid http:// or https:// Photo upload URL")
            throw IllegalArgumentException("Enter a valid http:// or https:// Photo upload URL.")
        }
        activePhotoRequestId = requestId
        pollGeneration += 1
        val generation = pollGeneration
        state = state.copy(
            cameraStatus = "Camera: webhook upload requested ($requestId)",
            photoPreviewUrl = null,
        )
        mentraBluetoothSdk.requestPhoto(
            MentraPhotoRequest(
                requestId = requestId,
                appId = "com.mentra.examples.android",
                size = MentraPhotoSize.fromValue(state.photoSize),
                webhookUrl = uploadUrl,
                compress = MentraPhotoCompression.fromValue(state.photoCompression),
                flash = state.photoFlash,
                sound = true,
            )
        )
        pollPhotoPreview(requestId, statusUrl, generation)
    }

    fun testWebhook() = runAction("Test webhook") {
        val uploadUrl = state.webhookUrl.trim()
        photoUploadValidationMessage(uploadUrl)?.let { message ->
            state = state.copy(cameraStatus = "Camera: $message")
            throw IllegalArgumentException(message)
        }
        val healthUrl = try {
            webhookHealthUrl(uploadUrl)
        } catch (_: Exception) {
            state = state.copy(cameraStatus = "Camera: enter a valid http:// or https:// Photo upload URL")
            throw IllegalArgumentException("Enter a valid http:// or https:// Photo upload URL.")
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

    fun toggleStream() = runAction(if (!state.streamRequested && state.streamStartedAt == null) "Start stream" else "Stop stream") {
        if (state.streamRequested || state.streamStartedAt != null) {
            stopKeepAlive()
            stopPreviewHealthPoll()
            if (isGlassesConnected()) {
                mentraBluetoothSdk.stopStream()
            }
            state = state.copy(streamRequested = false, streamPreviewReady = false, streamStartedAt = null, streamStatus = "Stopped")
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
        if (selectedProtocol == "rtmp" || selectedProtocol == "srt" || selectedProtocol == "webrtc") {
            state = state.copy(streamStatus = "Checking local ${selectedProtocol.uppercase()} server")
            scope.launch(Dispatchers.IO) {
                val reachabilityMessage = when (selectedProtocol) {
                    "rtmp" -> localRtmpReachabilityMessage(streamUrl)
                    "srt" -> localSrtReachabilityMessage(streamUrl)
                    else -> localWebrtcReachabilityMessage(streamUrl)
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
        mentraBluetoothSdk.startStream(
            MentraStreamRequest(
                streamUrl = streamUrl,
                streamId = streamId,
                keepAlive = true,
                keepAliveIntervalSeconds = 15,
            )
        )
        activeStreamId = streamId
        state = state.copy(
            streamRequested = true,
            streamPreviewReady = false,
            streamStatus = "Starting ${protocol.uppercase()} stream; waiting for preview",
        )
        startPreviewReadinessPoll(streamUrl, protocol, streamId)
    }

    private fun startPreviewReadinessPoll(streamUrl: String, protocol: String, streamId: String) {
        scope.launch(Dispatchers.IO) {
            repeat(30) {
                delay(1_000)
                if (activeStreamId != streamId) return@launch
                if (streamPreviewIsReady(streamUrl, protocol)) {
                    scope.launch {
                        if (activeStreamId == streamId) {
                            state = state.copy(
                                streamPreviewReady = true,
                                streamStatus = "${protocol.uppercase()} preview ready",
                            )
                            addEvent("LIVE", "${protocol.uppercase()} preview ready")
                            startPreviewHealthPoll(streamUrl, protocol, streamId)
                        }
                    }
                    return@launch
                }
            }
            scope.launch {
                if (activeStreamId == streamId) {
                    state = state.copy(streamStatus = "Stream requested; preview is still starting")
                    addEvent("TX", "${protocol.uppercase()} preview did not become ready")
                }
            }
        }
    }

    private fun startPreviewHealthPoll(streamUrl: String, protocol: String, streamId: String) {
        stopPreviewHealthPoll()
        previewHealthJob = scope.launch(Dispatchers.IO) {
            var lastReady = true
            while (isActive && activeStreamId == streamId) {
                delay(3_000)
                val ready = streamPreviewIsReady(streamUrl, protocol)
                withContext(Dispatchers.Main) {
                    if (activeStreamId != streamId) return@withContext
                    when {
                        ready && !lastReady -> {
                            state = state.copy(
                                streamPreviewReady = true,
                                streamStatus = "${protocol.uppercase()} preview ready",
                            )
                            addEvent("LIVE", "${protocol.uppercase()} preview ready")
                        }
                        !ready && lastReady -> {
                            state = state.copy(
                                streamPreviewReady = false,
                                streamStatus = "${protocol.uppercase()} media path lost; waiting for preview",
                            )
                            addEvent("TX", "${protocol.uppercase()} media path lost")
                        }
                    }
                    lastReady = ready
                }
            }
        }
    }

    private fun stopPreviewHealthPoll() {
        previewHealthJob?.cancel()
        previewHealthJob = null
    }

    fun requestWifiScan() = runAction("Scan Wi-Fi") {
        requireConnected("scan Wi-Fi")
        mentraBluetoothSdk.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String, password: String, requiresPassword: Boolean) = runAction("Connect Wi-Fi $ssid") {
        requireConnected("send Wi-Fi credentials")
        if (requiresPassword && password.isBlank()) {
            throw IllegalArgumentException("Enter the Wi-Fi password before connecting to $ssid.")
        }
        mentraBluetoothSdk.sendWifiCredentials(ssid, if (requiresPassword) password else "")
        state = state.copy(wifiPendingSsid = ssid)
    }

    fun forgetCurrentWifiNetwork() = runAction("Forget current Wi-Fi") {
        requireConnected("forget Wi-Fi network")
        val ssid = stringValue(state.glassesStatus, "wifiSsid")
        if (ssid.isNullOrBlank() || boolValue(state.glassesStatus, "wifiConnected") != true) {
            throw IllegalStateException("No connected Wi-Fi network to forget.")
        }
        mentraBluetoothSdk.forgetWifiNetwork(ssid)
    }

    fun toggleHotspot() = runAction(if (state.hotspotEnabled) "Disable hotspot" else "Enable hotspot") {
        requireConnected("toggle hotspot")
        val current = boolValue(state.glassesStatus, "hotspotEnabled") ?: state.hotspotEnabled
        val next = !current
        mentraBluetoothSdk.setHotspotState(next)
    }

    fun openGalleryServer() = runAction("Open gallery server") {
        val baseUrl = requireGalleryServerUrl()
        state = state.copy(
            galleryServerReachable = null,
            galleryServerStatus = "Gallery server: checking $baseUrl",
        )
        scope.launch {
            val result = checkGalleryServerReachability(baseUrl)
            state = state.copy(
                galleryServerReachable = result.reachable,
                galleryServerStatus = result.status,
            )
            addEvent(result.eventTag, result.eventText)
            if (result.reachable) {
                appContext.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(baseUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    fun copyGalleryServerUrl() = runAction("Copy gallery URL") {
        val baseUrl = requireGalleryServerUrl()
        val clipboard = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Mentra Live gallery server", baseUrl))
        state = state.copy(galleryServerStatus = "Gallery server: copied $baseUrl")
    }

    fun copyGalleryHotspotPassword() = runAction("Copy hotspot password") {
        val password = galleryHotspotPasswordLabel(state.glassesStatus)
        val clipboard = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Mentra Live hotspot password", password))
        state = state.copy(galleryServerStatus = "Hotspot password copied: $password")
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
        sendRgbLedRequest(mode, state.ledColor)
    }

    fun selectLedColor(color: String) = runAction("RGB LED color ${color.uppercase(Locale.US)}") {
        requireConnected("control the RGB LED")
        if (color !in rgbLedColorOptions) {
            throw IllegalArgumentException("Unsupported RGB LED color: $color")
        }
        state = state.copy(ledColor = color)
        if (state.ledMode != "Off") {
            sendRgbLedRequest(state.ledMode, color)
        }
    }

    private fun sendRgbLedRequest(mode: String, color: String) {
        val request = rgbLedRequestFor(mode, color)
        mentraBluetoothSdk.rgbLedControl(
            MentraRgbLedRequest(
                requestId = "rgb-${System.currentTimeMillis()}",
                packageName = "com.mentra.examples.android",
                action = request.action,
                color = request.color,
                ontime = request.ontime,
                offtime = request.offtime,
                count = request.count,
            )
        )
    }

    private fun rgbLedRequestFor(mode: String, color: String): RgbLedPattern {
        return when (mode) {
            "Solid" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 30_000, 0, 1)
            "Pulse" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 900, 900, 6)
            "Blink" -> RgbLedPattern(MentraRgbLedAction.ON, rgbLedColorFor(color), 250, 250, 12)
            else -> RgbLedPattern(MentraRgbLedAction.OFF, null, 0, 0, 0)
        }
    }

    fun toggleRawJson() {
        state = state.copy(rawJsonExpanded = !state.rawJsonExpanded)
    }

    override fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {
        val wasConnected = isGlassesConnected()
        state = state.copy(glassesStatus = state.glassesStatus + status.values)
        boolValue(status.values, "hotspotEnabled")?.let { enabled ->
            state = state.copy(hotspotEnabled = enabled)
        }
        if (isDisconnectedStatus(status.values)) {
            applyDisconnectedState("Disconnected")
        } else if (!wasConnected && isGlassesConnected()) {
            refreshGlassesMediaVolume()
        }
        addEvent("STORE", summarize(status.values))
    }

    override fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {
        state = state.copy(
            bluetoothStatus = state.bluetoothStatus + status.values,
            galleryModeAuto = boolValue(status.values, "gallery_mode") ?: state.galleryModeAuto,
        )
        addEvent("BLE", summarize(status.values))
    }

    override fun onDeviceDiscovered(device: MentraDiscoveredDevice) {
        if (state.discoveredDevices.none { discoveredDeviceKey(it) == discoveredDeviceKey(device) }) {
            state = state.copy(
                discoveredDevices = state.discoveredDevices + device,
            )
        }
        addEvent("BLE", "discovered ${device.name}")
    }

    override fun onDefaultDeviceChanged(device: MentraPairedDevice?) {
        savePersistedDefaultDevice(device)
        state = state.copy(bluetoothStatus = state.bluetoothStatus + defaultDeviceStatus(device))
        if (device != null) {
            addEvent("BLE", "saved default ${device.name}")
        }
    }

    override fun onButtonPress(event: MentraButtonPressEvent) {
        addEvent("LIVE", "button ${event.buttonId}: ${event.pressType}")
    }

    override fun onTouch(event: MentraTouchEvent) {
        val gesture = event.gestureName ?: summarize(event.values)
        addEvent("LIVE", "${if (event.isSwipe) "swipe" else "touch"} $gesture")
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
        val status = event.status
        state = state.copy(
            glassesStatus = state.glassesStatus + mapOf(
                "wifiConnected" to status.connected,
                "wifiSsid" to status.ssid,
                "wifiLocalIp" to status.localIp,
            ),
            wifiPendingSsid = null,
        )
        addEvent("STORE", "Wi-Fi ${summarize(event.values)}")
    }

    override fun onHotspotStatusChanged(event: MentraHotspotStatusEvent) {
        val enabled = event.enabled ?: false
        val nextGlassesStatus = state.glassesStatus + mapOf(
            "hotspotEnabled" to enabled,
            "hotspotSsid" to (event.ssid ?: ""),
            "hotspotPassword" to (event.password ?: ""),
            "hotspotGatewayIp" to (event.localIp ?: ""),
        )
        state = state.copy(
            hotspotEnabled = enabled,
            galleryServerReachable = null,
            galleryServerStatus = if (enabled) {
                "Gallery server: ${galleryServerUrl(nextGlassesStatus, enabled)}"
            } else {
                "Gallery server: hotspot off"
            },
            glassesStatus = nextGlassesStatus,
        )
        addEvent("STORE", "hotspot ${summarize(event.values)}")
    }

    override fun onHotspotError(event: MentraHotspotErrorEvent) {
        state = state.copy(
            hotspotEnabled = false,
            galleryServerReachable = false,
            galleryServerStatus = "Gallery server: hotspot error",
            glassesStatus = state.glassesStatus + mapOf("hotspotEnabled" to false),
        )
        addEvent("TX", "hotspot error ${event.message ?: summarize(event.values)}")
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

    fun refreshAudioRoute() {
        refreshAudioSystemState()
        addEvent("LIVE", "audio output ${state.phoneAudioRoute}; ${state.audioMediaStatus}")
    }

    fun openBluetoothSettings() = runAction("Open Bluetooth settings") {
        appContext.startActivity(
            Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    fun openWifiSettings() = runAction("Open Wi-Fi settings") {
        appContext.startActivity(
            Intent(Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    fun refreshGlassesMediaVolume() {
        refreshGlassesMediaVolume(showLoading = true)
    }

    fun decreaseGlassesMediaVolume() {
        adjustGlassesMediaVolume(-1)
    }

    fun increaseGlassesMediaVolume() {
        adjustGlassesMediaVolume(1)
    }

    fun setGlassesMediaVolume(level: Int) = runAction("Set glasses volume $level") {
        requireConnected("change glasses media volume")
        val nextLevel = level.coerceIn(0, 15)
        state = state.copy(glassesVolumeStatus = "Glasses volume: setting $nextLevel...")
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { mentraBluetoothSdk.setGlassesMediaVolume(nextLevel) }
                state = state.copy(
                    glassesMediaVolume = nextLevel,
                    glassesVolumeStatus = "Glasses volume: $nextLevel / 15",
                )
                refreshAudioSystemState()
                addEvent("LIVE", "set glasses volume $nextLevel (${result.statusCode ?: "ok"})")
            } catch (error: Throwable) {
                state = state.copy(glassesVolumeStatus = "Glasses volume: ${error.message ?: "set failed"}")
                addEvent("TX", "set glasses volume failed: ${error.message ?: error::class.java.simpleName}")
            }
        }
    }

    private fun refreshGlassesMediaVolume(showLoading: Boolean) {
        refreshAudioSystemState()
        if (!isGlassesConnected()) {
            state = state.copy(
                glassesMediaVolume = null,
                glassesVolumeStatus = "Glasses volume: connect first",
            )
            return
        }

        if (showLoading) {
            state = state.copy(glassesVolumeStatus = "Glasses volume: reading...")
        }
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { mentraBluetoothSdk.getGlassesMediaVolume() }
                val volume = result.volume
                state = state.copy(
                    glassesMediaVolume = volume,
                    glassesVolumeStatus = if (volume != null) {
                        "Glasses volume: $volume / 15"
                    } else {
                        "Glasses volume: response ${summarize(result.values)}"
                    },
                )
                refreshAudioSystemState()
                addEvent("LIVE", "glasses volume ${volume ?: summarize(result.values)}")
            } catch (error: Throwable) {
                state = state.copy(
                    glassesMediaVolume = null,
                    glassesVolumeStatus = "Glasses volume: ${error.message ?: "unavailable"}",
                )
                refreshAudioSystemState()
                addEvent("TX", "glasses volume failed: ${error.message ?: error::class.java.simpleName}")
            }
        }
    }

    override fun close() {
        stopKeepAlive()
        stopPreviewHealthPoll()
        stopMicElapsedTimer()
        stopMicPlayback()
        unregisterAudioStateObservers()
        volumeRefreshJob?.cancel()
        controllerJob.cancel()
        mentraBluetoothSdk.close()
    }

    private fun adjustGlassesMediaVolume(delta: Int) {
        val current = state.glassesMediaVolume ?: return
        val next = (current + delta).coerceIn(0, 15)
        if (next != current) {
            setGlassesMediaVolume(next)
        }
    }

    private fun registerAudioStateObservers() {
        if (audioObserversRegistered) {
            return
        }
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, null)
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            addAction(BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED)
            addAction(ACTION_VOLUME_CHANGED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(audioStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            appContext.registerReceiver(audioStateReceiver, filter)
        }
        bluetoothAdapter?.getProfileProxy(appContext, a2dpServiceListener, BluetoothProfile.A2DP)
        audioObserversRegistered = true
    }

    private fun unregisterAudioStateObservers() {
        if (!audioObserversRegistered) {
            return
        }
        runCatching { audioManager.unregisterAudioDeviceCallback(audioDeviceCallback) }
        runCatching { appContext.unregisterReceiver(audioStateReceiver) }
        bluetoothA2dp?.let { proxy ->
            runCatching { bluetoothAdapter?.closeProfileProxy(BluetoothProfile.A2DP, proxy) }
        }
        bluetoothA2dp = null
        audioObserversRegistered = false
    }

    private fun scheduleGlassesVolumeRefresh() {
        if (!isGlassesConnected()) {
            return
        }
        volumeRefreshJob?.cancel()
        volumeRefreshJob = scope.launch {
            delay(300)
            refreshGlassesMediaVolume(showLoading = false)
        }
    }

    private fun refreshAudioSystemState() {
        val mediaStatus = currentA2dpStatus()
        state = state.copy(
            audioBondStatus = currentBondStatusLabel(),
            audioMediaStatus = mediaStatus.label,
            audioMediaConnected = mediaStatus.connected,
            phoneAudioRoute = currentAudioOutputRouteLabel(),
            phoneMediaVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC),
            phoneMediaVolumeMax = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC),
        )
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

    private fun autoConnectDefaultOnStartup() {
        scope.launch {
            delay(500)
            if (isGlassesConnected() || !hasSavedConnectionTarget(state.bluetoothStatus)) {
                return@launch
            }
            runAction("Auto-connect default") {
                mentraBluetoothSdk.connectDefault()
            }
        }
    }

    private fun addEvent(tag: String, text: String) {
        state = state.copy(events = (listOf(exampleEvent(tag, text)) + state.events).take(30))
    }

    private fun loadPersistedDefaultDevice(): MentraPairedDevice? {
        val model = defaultDevicePrefs.getString(DEFAULT_DEVICE_MODEL_KEY, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val name = defaultDevicePrefs.getString(DEFAULT_DEVICE_NAME_KEY, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val address = defaultDevicePrefs.getString(DEFAULT_DEVICE_ADDRESS_KEY, null)?.takeIf { it.isNotBlank() }
        return MentraPairedDevice(
            model = MentraDeviceModel.fromDeviceType(model),
            name = name,
            address = address,
        )
    }

    private fun savePersistedDefaultDevice(device: MentraPairedDevice?) {
        defaultDevicePrefs.edit().apply {
            if (device == null || device.name.isBlank()) {
                clear()
            } else {
                putInt(DEFAULT_DEVICE_SCHEMA_KEY, 1)
                putString(DEFAULT_DEVICE_MODEL_KEY, device.model.deviceType)
                putString(DEFAULT_DEVICE_NAME_KEY, device.name)
                putString(DEFAULT_DEVICE_ADDRESS_KEY, device.address.orEmpty())
                putLong(DEFAULT_DEVICE_SAVED_AT_KEY, System.currentTimeMillis())
            }
        }.apply()
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

    private fun requireGalleryServerUrl(): String {
        return galleryServerUrl(state.glassesStatus, state.hotspotEnabled)
            ?: throw IllegalStateException("Enable the glasses hotspot first.")
    }

    private suspend fun checkGalleryServerReachability(baseUrl: String): GalleryServerCheck =
        withContext(Dispatchers.IO) {
            try {
                val connection = URL("$baseUrl/api/status").openConnection() as HttpURLConnection
                connection.connectTimeout = 1500
                connection.readTimeout = 1500
                val code = connection.responseCode
                val body = if (code in 200..299) {
                    connection.inputStream.bufferedReader().use { it.readText() }
                } else {
                    connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                }
                connection.disconnect()
                val totalPhotos = Regex("\"total_photos\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)
                if (code in 200..299) {
                    GalleryServerCheck(
                        reachable = true,
                        status = if (totalPhotos != null) {
                            "Gallery server: reachable · $totalPhotos items"
                        } else {
                            "Gallery server: reachable"
                        },
                        eventTag = "LIVE",
                        eventText = "gallery server reachable $baseUrl",
                    )
                } else {
                    GalleryServerCheck(
                        reachable = false,
                        status = "Gallery server: HTTP $code",
                        eventTag = "TX",
                        eventText = "gallery server HTTP $code",
                    )
                }
            } catch (error: Exception) {
                val message = error.message ?: error.javaClass.simpleName
                GalleryServerCheck(
                    reachable = false,
                    status = "Gallery server: not reachable. Join ${galleryHotspotSsidLabel(state.glassesStatus)} and retry.",
                    eventTag = "TX",
                    eventText = "gallery server unreachable: $message",
                )
            }
        }

    private fun applyDisconnectedState(status: String) {
        stopKeepAlive()
        stopPreviewHealthPoll()
        activeStreamId = null
        val hadPhotoRequest = activePhotoRequestId != null
        activePhotoRequestId = null
        if (hadPhotoRequest) {
            pollGeneration += 1
        }
        state = state.copy(
            glassesStatus = disconnectedGlassesStatus(),
            glassesMediaVolume = null,
            glassesVolumeStatus = "Glasses volume: not connected",
            galleryServerReachable = null,
            galleryServerStatus = "Gallery server: connect glasses first",
            streamRequested = false,
            streamPreviewReady = false,
            streamStartedAt = null,
            streamStatus = status,
            hotspotEnabled = false,
            micRecording = false,
            phoneAudioRoute = currentAudioOutputRouteLabel(),
            cameraStatus = if (hadPhotoRequest) "Disconnected before photo upload completed" else state.cameraStatus,
            wifiPendingSsid = null,
        )
        stopMicElapsedTimer()
        stopMicPlayback()
    }

    private fun applyStreamStatus(values: Map<String, Any>) {
        when (values["status"] as? String) {
            "streaming", "initializing", "starting" -> {
                activeStreamId = values["streamId"] as? String ?: activeStreamId
                state = state.copy(
                    streamRequested = true,
                    streamStartedAt = state.streamStartedAt ?: System.currentTimeMillis(),
                )
                if (keepAliveJob == null) {
                    startKeepAlive(activeStreamId ?: return)
                }
            }
            "stopped", "stopping", "error", "error_not_streaming" -> {
                stopKeepAlive()
                stopPreviewHealthPoll()
                activeStreamId = null
                state = state.copy(streamRequested = false, streamPreviewReady = false, streamStartedAt = null)
            }
        }
    }

    private fun startKeepAlive(streamId: String) {
        stopKeepAlive()
        keepAliveJob = scope.launch {
            while (isActive) {
                delay(15_000)
                mentraBluetoothSdk.keepStreamAlive(
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
            micPlaybackHint = null,
        )
        mentraBluetoothSdk.setMicState(MentraMicConfig(sendPcmData = true, sendTranscript = false, bypassVad = true))
        startMicElapsedTimer()
    }

    private fun stopMicRecording() {
        if (isGlassesConnected()) {
            mentraBluetoothSdk.setMicState(MentraMicConfig(sendPcmData = false, sendTranscript = false, bypassVad = true))
        }
        stopMicElapsedTimer()
        val pcm = micPcmBuffer.toByteArray()
        val durationSeconds = maxOf(state.micElapsedSeconds, estimatedMicDurationSeconds(pcm.size))
        state = state.copy(
            micRecording = false,
            lastMicBytes = pcm.size,
            lastMicDurationSeconds = durationSeconds.takeIf { pcm.isNotEmpty() },
            micPlaybackHint = null,
        )

        if (pcm.isEmpty()) {
            lastMicFile = null
            state = state.copy(
                lastMicBytes = 0,
                lastMicDurationSeconds = null,
                micPlaybackHint = "No PCM frames captured. Replay is empty; keep the glasses connected and record again.",
            )
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

        val audioRoute = requireGlassesAudioRoute()
        stopMicPlayback()
        try {
            val player = MediaPlayer().apply {
                setAudioAttributes(
                    mediaAudioAttributes()
                )
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
            mentraBluetoothSdk.setOwnAppAudioPlaying(true)
            val routedDevice = player.routedDevice
            val actualRoute = routedDevice?.let(::audioOutputLabel) ?: audioRoute
            if (routedDevice != null && !isBluetoothAudioOutput(routedDevice)) {
                stopMicPlayback()
                throw IllegalStateException("Playback routed to $actualRoute instead of Bluetooth audio.")
            }
            state = state.copy(micPlaying = true, phoneAudioRoute = actualRoute, micPlaybackHint = null)
            addEvent("LIVE", "playing through $actualRoute")
            refreshGlassesMediaVolume()
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
            mentraBluetoothSdk.setOwnAppAudioPlaying(false)
        }
        state = state.copy(micPlaying = false)
    }

    private fun requireGlassesAudioRoute(): String {
        val bluetoothOutputs = bluetoothAudioOutputs()
        val routeName = bluetoothOutputs.firstOrNull()?.productName?.toString()?.takeIf { it.isNotBlank() }
            ?: "Bluetooth audio"

        if (bluetoothOutputs.isEmpty()) {
            val currentRoute = currentAudioOutputRouteLabel()
            state = state.copy(phoneAudioRoute = currentRoute)
            throw IllegalStateException(
                "Pair/connect the glasses as a Bluetooth audio device before playback. " +
                    "On Android, accept the system pairing dialog after BLE connects. " +
                    "Current output: $currentRoute."
            )
        }

        return routeName
    }

    private fun currentBondStatusLabel(): String {
        val bondedDevice = candidateBondedDevices().firstOrNull()
            ?: return if (currentTargetName() == null) "Bond: no selected glasses" else "Bond: not paired"
        val label = bluetoothDeviceLabel(bondedDevice)
        return when (bondedDevice.bondState) {
            BluetoothDevice.BOND_BONDED -> "Bond: paired with $label"
            BluetoothDevice.BOND_BONDING -> "Bond: pairing with $label"
            else -> "Bond: not paired with $label"
        }
    }

    private fun currentA2dpStatus(): AudioProfileStatus {
        val route = bluetoothAudioOutputs().firstOrNull()
        val proxy = bluetoothA2dp ?: return if (route != null) {
            AudioProfileStatus("Media: routed to ${audioOutputLabel(route)}", true)
        } else {
            AudioProfileStatus("Media: checking A2DP", false)
        }

        val connectedDevices = runCatching { proxy.connectedDevices }.getOrDefault(emptyList())
        val connectedDevice = connectedDevices.firstOrNull(::matchesCurrentTarget)
            ?: connectedDevices.firstOrNull(::isMentraLikeDevice)
            ?: connectedDevices.firstOrNull()
        if (connectedDevice != null) {
            return AudioProfileStatus("Media: connected to ${bluetoothDeviceLabel(connectedDevice)}", true)
        }

        val bondedDevice = candidateBondedDevices().firstOrNull()
        return if (bondedDevice != null) {
            AudioProfileStatus("Media: paired, not connected", false)
        } else {
            AudioProfileStatus("Media: not paired", false)
        }
    }

    private fun mediaAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()

    private fun bluetoothAudioOutputs(): List<AudioDeviceInfo> =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter(::isBluetoothAudioOutput)

    private fun currentAudioOutputRouteLabel(): String {
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        val preferred = bluetoothAudioOutputs().firstOrNull()
            ?: outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            ?: outputs.firstOrNull()
            ?: return "No media output"
        return audioOutputLabel(preferred)
    }

    private fun candidateBondedDevices(): List<BluetoothDevice> {
        val bondedDevices = runCatching { bluetoothAdapter?.bondedDevices ?: emptySet() }.getOrDefault(emptySet())
        val targetMatches = bondedDevices.filter(::matchesCurrentTarget)
        return targetMatches.ifEmpty { bondedDevices.filter(::isMentraLikeDevice) }
    }

    private fun matchesCurrentTarget(device: BluetoothDevice): Boolean {
        val targetAddress = currentTargetAddress()
        if (!targetAddress.isNullOrBlank()) {
            val deviceAddress = runCatching { device.address }.getOrNull()
            if (deviceAddress.equals(targetAddress, ignoreCase = true)) {
                return true
            }
        }

        val targetName = currentTargetName()
        val deviceName = bluetoothDeviceName(device)
        return !targetName.isNullOrBlank() && deviceName == targetName
    }

    private fun isMentraLikeDevice(device: BluetoothDevice): Boolean =
        bluetoothDeviceName(device)?.contains("Mentra", ignoreCase = true) == true

    private fun currentTargetAddress(): String? =
        state.selectedDiscoveredDevice?.address
            ?: stringValue(state.bluetoothStatus, "device_address")

    private fun currentTargetName(): String? =
        state.selectedDiscoveredDevice?.name
            ?: stringValue(state.bluetoothStatus, "device_name")
            ?: stringValue(state.glassesStatus, "bluetoothName")
            ?: stringValue(state.glassesStatus, "serialNumber")

    private fun bluetoothDeviceLabel(device: BluetoothDevice): String =
        bluetoothDeviceName(device)
            ?: runCatching { device.address }.getOrNull()?.takeLast(5)
            ?: "Bluetooth device"

    private fun bluetoothDeviceName(device: BluetoothDevice): String? =
        runCatching { device.name?.takeIf { it.isNotBlank() } }.getOrNull()

    private fun audioOutputLabel(device: AudioDeviceInfo): String {
        val name = device.productName?.toString()?.takeIf { it.isNotBlank() }
        return listOfNotNull(audioOutputKind(device.type), name).joinToString(": ")
    }

    private fun isBluetoothAudioOutput(device: AudioDeviceInfo): Boolean =
        when (device.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER -> true
            else -> false
        }

    private fun audioOutputKind(type: Int): String =
        when (type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
            AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth LE headset"
            AudioDeviceInfo.TYPE_BLE_SPEAKER -> "Bluetooth LE speaker"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Phone speaker"
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headphones"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset"
            else -> "Audio output"
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

fun rgbLedColorFor(color: String): MentraRgbLedColor =
    MentraRgbLedColor.fromValue(color) ?: MentraRgbLedColor.RED

fun disconnectedGlassesStatus(): Map<String, Any> =
    mapOf(
        "connected" to false,
        "connectionState" to "DISCONNECTED",
        "fullyBooted" to false,
        "batteryLevel" to -1,
        "charging" to false,
        "hotspotEnabled" to false,
        "hotspotGatewayIp" to "",
        "hotspotPassword" to "",
        "hotspotSsid" to "",
        "wifiConnected" to false,
        "wifiSsid" to "",
        "wifiLocalIp" to "",
    )

val photoSizeOptions = listOf("small", "medium", "large", "full")
val photoCompressionOptions = listOf("none", "medium", "heavy")

fun cameraSdkCall(
    size: String,
    compression: String,
    flash: Boolean,
): String = """
mentraBluetoothSdk.requestPhoto(
    MentraPhotoRequest(
      requestId = requestId,
      appId = "com.mentra.examples.android",
      size = MentraPhotoSize.${size.uppercase(Locale.US)},
      webhookUrl = uploadUrl,
      compress = MentraPhotoCompression.${compression.uppercase(Locale.US)},
      flash = $flash,
      sound = true,
    )
)
""".trimIndent()

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

fun photoUploadValidationMessage(uploadUrlText: String): String? {
    val value = uploadUrlText.trim()
    if (value.isEmpty()) {
        return "Paste the Photo upload URL printed by local demo cloud."
    }
    if (value.contains("<computer-ip>")) {
        return "Replace <computer-ip> with the IP printed by local demo cloud."
    }
    return null
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

fun localSrtReachabilityMessage(srtUrlText: String): String? {
    val previewUrl = try {
        srtHlsPreviewUrl(srtUrlText)
    } catch (_: Exception) {
        return "Enter a valid srt:// publish URL."
    }
    if (previewUrl == null) {
        return null
    }

    return localHttpPreviewReachabilityMessage(previewUrl, ::localSrtSetupMessage)
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

fun streamPreviewIsReady(streamUrl: String, protocol: String): Boolean {
    return try {
        when (protocol) {
            "rtmp" -> rtmpHlsPreviewUrl(streamUrl)?.let(::hlsPreviewIsReady) == true
            "srt" -> srtHlsPreviewUrl(streamUrl)?.let(::hlsPreviewIsReady) == true
            "webrtc" -> webrtcHlsPreviewUrl(streamUrl)?.let(::hlsPreviewIsReady) == true
            else -> false
        }
    } catch (_: Exception) {
        false
    }
}

private fun hlsPreviewIsReady(previewUrl: String): Boolean {
    return try {
        val connection = URL(previewUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 1500
        connection.readTimeout = 1500
        val code = connection.responseCode
        val body = if (code == 200) {
            connection.inputStream.bufferedReader().use { it.readText() }
        } else {
            ""
        }
        connection.disconnect()
        code == 200 && body.contains("#EXTM3U")
    } catch (_: Exception) {
        false
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
    val streamPath = uri.rawPath
        ?.trim('/')
        .orEmpty()
    val previewScheme = if (scheme == "rtmps") "https" else "http"
    val hlsPath = if (streamPath.isEmpty()) "index.m3u8" else "$streamPath/index.m3u8"
    return "$previewScheme://$host:8888/$hlsPath"
}

fun srtHlsPreviewUrl(srtUrlText: String): String? {
    val uri = URI(srtUrlText)
    val scheme = uri.scheme ?: throw IllegalArgumentException("Missing SRT URL scheme.")
    if (scheme != "srt") {
        throw IllegalArgumentException("Only srt URLs are supported.")
    }
    val host = uri.host ?: throw IllegalArgumentException("Missing SRT host.")
    if (!isLocalPreviewHost(host)) {
        return null
    }
    val path = srtStreamPath(uri) ?: return null
    return "http://$host:8888/$path/index.m3u8"
}

private fun srtStreamPath(uri: URI): String? {
    val streamId = uri.rawQuery
        ?.split("&")
        ?.firstNotNullOfOrNull { part ->
            val separator = part.indexOf("=")
            if (separator < 0) return@firstNotNullOfOrNull null
            val name = URLDecoder.decode(part.substring(0, separator), StandardCharsets.UTF_8.name())
            if (!name.equals("streamid", ignoreCase = true)) return@firstNotNullOfOrNull null
            URLDecoder.decode(part.substring(separator + 1), StandardCharsets.UTF_8.name())
        }
        ?: return null

    val pieces = streamId.split(":")
    val path = if (pieces.firstOrNull()?.lowercase() in setOf("publish", "read")) {
        pieces.getOrNull(1)
    } else {
        streamId
    }
    return path?.trim('/')?.takeIf { it.isNotBlank() }
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

fun webrtcHlsPreviewUrl(whipUrlText: String): String? {
    val url = URL(whipUrlText)
    if (url.protocol != "http" && url.protocol != "https") {
        throw IllegalArgumentException("Only http and https WHIP URLs are supported.")
    }
    if (!isLocalPreviewHost(url.host)) {
        return null
    }
    val basePath = url.path
        .removeSuffix("/whip")
        .removeSuffix("/whep")
        .trim('/')
    return "http://${url.host}:8888/${if (basePath.isBlank()) "index.m3u8" else "$basePath/index.m3u8"}"
}

fun localRtmpSetupMessage(detail: String): String =
    "Local RTMP/HLS server not reachable ($detail). Run python3 examples/local-demo-cloud/server.py and paste the printed RTMP publish URL."

fun localSrtSetupMessage(detail: String): String =
    "Local SRT/HLS server not reachable ($detail). Run python3 examples/local-demo-cloud/server.py and paste the printed SRT publish URL."

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

fun stringValue(values: Map<String, Any>, key: String): String? =
    (values[key] as? String)?.takeIf { it.isNotBlank() }

fun intValue(values: Map<String, Any>, key: String): Int? =
    when (val value = values[key]) {
        is Int -> value
        is Number -> value.toInt()
        else -> null
    }

fun boolValue(values: Map<String, Any>, key: String): Boolean? = values[key] as? Boolean

fun galleryModeAuto(values: Map<String, Any>): Boolean = boolValue(values, "gallery_mode") ?: false

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

fun supportsDisplay(values: Map<String, Any>): Boolean {
    listOf("supportsDisplay", "hasDisplay", "displaySupported", "display").forEach { key ->
        boolValue(values, key)?.let { return it }
    }
    listOf("features", "deviceFeatures", "capabilities").forEach { key ->
        val nested = values[key] as? Map<*, *> ?: return@forEach
        val display = nested["display"] as? Boolean
        if (display != null) {
            return display
        }
    }

    val model = listOfNotNull(
        stringValue(values, "deviceModel"),
        stringValue(values, "bluetoothName"),
        stringValue(values, "defaultWearable"),
    ).joinToString(" ").lowercase()

    if (
        "g1" in model ||
        "g2" in model ||
        "nex" in model ||
        "mach" in model ||
        "z100" in model ||
        "vuzix" in model ||
        "display" in model ||
        "frame" in model
    ) {
        return true
    }
    if ("live" in model || "r1" in model || "ring" in model) {
        return false
    }
    return false
}

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

fun hotspotLabel(values: Map<String, Any>, fallbackEnabled: Boolean): String {
    val enabled = boolValue(values, "hotspotEnabled") ?: fallbackEnabled
    if (!enabled) {
        return "disabled"
    }
    val ssid = stringValue(values, "hotspotSsid")
    if (ssid.isNullOrBlank()) {
        return "waiting for SSID"
    }
    val ip = stringValue(values, "hotspotGatewayIp")
    return if (ip.isNullOrBlank()) ssid else "$ssid · $ip"
}

fun galleryServerUrl(values: Map<String, Any>, fallbackEnabled: Boolean): String? {
    val enabled = boolValue(values, "hotspotEnabled") ?: fallbackEnabled
    if (!enabled) {
        return null
    }
    val gateway = stringValue(values, "hotspotGatewayIp")
        ?.takeIf { it.isNotBlank() }
        ?: "192.168.43.1"
    return "http://$gateway:8089"
}

fun galleryHotspotSsidLabel(values: Map<String, Any>): String {
    val ssid = stringValue(values, "hotspotSsid")?.takeIf { it.isNotBlank() }
    return if (ssid == null) "the glasses hotspot" else "Wi-Fi $ssid"
}

fun galleryHotspotPasswordLabel(values: Map<String, Any>): String =
    stringValue(values, "hotspotPassword")?.takeIf { it.isNotBlank() }
        ?: MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD

fun firmwareLabel(values: Map<String, Any>): String =
    stringValue(values, "fwVersion")
        ?: stringValue(values, "firmwareVersion")
        ?: stringValue(values, "deviceFirmwareVersion")
        ?: stringValue(values, "rightFirmwareVersion")
        ?: stringValue(values, "leftFirmwareVersion")
        ?: stringValue(values, "besFwVersion")
        ?: stringValue(values, "mtkFwVersion")
        ?: "Unknown"

fun firmwareSubLabel(values: Map<String, Any>): String {
    val appVersion = stringValue(values, "appVersion")
    return when {
        stringValue(values, "fwVersion") != null || stringValue(values, "firmwareVersion") != null -> "reported"
        stringValue(values, "deviceFirmwareVersion") != null -> "device firmware"
        stringValue(values, "rightFirmwareVersion") != null -> "right firmware"
        stringValue(values, "leftFirmwareVersion") != null -> "left firmware"
        stringValue(values, "besFwVersion") != null -> "BES firmware"
        stringValue(values, "mtkFwVersion") != null -> "MTK firmware"
        appVersion != null -> "ASG app $appVersion"
        else -> "not reported"
    }
}

fun rssiLabel(values: Map<String, Any>): String =
    intValue(values, "signalStrength")?.let { "$it dBm" } ?: "Unknown"

fun bluetoothSearchLabel(values: Map<String, Any>): String {
    val searching = boolValue(values, "searching") == true
    val count = (values["searchResults"] as? List<*>)?.size ?: 0
    return "${if (searching) "Scanning" else "Idle"} · $count result${if (count == 1) "" else "s"}"
}

fun discoveredDeviceKey(device: MentraDiscoveredDevice): String =
    device.address ?: "${device.model.deviceType}:${device.name}"

fun targetDeviceDetail(device: MentraDiscoveredDevice): String =
    device.rssi?.let { "${device.model.deviceType} · $it dBm" } ?: device.model.deviceType

fun connectionTargetLabel(state: MentraExampleState, values: Map<String, Any>): String =
    when {
        isGlassesConnected(values) -> stringValue(state.bluetoothStatus, "device_name") ?: deviceLabel(values)
        state.selectedDiscoveredDevice != null -> state.selectedDiscoveredDevice.name
        state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus) -> savedConnectionTargetName(state.bluetoothStatus)
        state.discoveredDevices.isNotEmpty() -> "Choose a discovered device"
        else -> "Scan required"
    }

fun canConnectTarget(state: MentraExampleState): Boolean =
    state.selectedDiscoveredDevice != null ||
        (state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus))

fun hasSavedConnectionTarget(values: Map<String, Any>): Boolean =
    !stringValue(values, "default_wearable").isNullOrBlank() && !stringValue(values, "device_name").isNullOrBlank()

fun defaultDeviceStatus(device: MentraPairedDevice?): Map<String, Any> =
    mapOf(
        "default_wearable" to (device?.model?.deviceType ?: ""),
        "device_name" to (device?.name ?: ""),
        "device_address" to (device?.address ?: ""),
    )

fun savedConnectionTargetName(values: Map<String, Any>): String =
    stringValue(values, "device_name") ?: "Saved glasses"

fun savedConnectionTargetDetail(values: Map<String, Any>): String {
    val model = stringValue(values, "default_wearable") ?: "Saved model"
    return "$model · BluetoothSdk.connectDefault()"
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
