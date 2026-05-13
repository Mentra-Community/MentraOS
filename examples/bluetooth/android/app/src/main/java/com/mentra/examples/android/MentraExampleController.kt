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
import android.graphics.Bitmap
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
import com.mentra.core.BatteryStatusEvent
import com.mentra.core.BluetoothError
import com.mentra.core.MentraBluetoothSdk
import com.mentra.core.MentraBluetoothSdkCallback
import com.mentra.core.BluetoothStatus
import com.mentra.core.BluetoothStatusUpdate
import com.mentra.core.ButtonPressEvent
import com.mentra.core.Device
import com.mentra.core.DeviceModel
import com.mentra.core.GalleryMode
import com.mentra.core.GlassesStatus
import com.mentra.core.GlassesStatusUpdate
import com.mentra.core.HotspotErrorEvent
import com.mentra.core.HotspotStatus
import com.mentra.core.HotspotStatusEvent
import com.mentra.core.MicConfig
import com.mentra.core.PhotoCompression
import com.mentra.core.PhotoRequest
import com.mentra.core.PhotoResponse
import com.mentra.core.PhotoSize
import com.mentra.core.RgbLedAction
import com.mentra.core.RgbLedColor
import com.mentra.core.RgbLedRequest
import com.mentra.core.StreamState
import com.mentra.core.StreamKeepAliveRequest
import com.mentra.core.StreamRequest
import com.mentra.core.StreamStatus
import com.mentra.core.TouchEvent
import com.mentra.core.WifiScanResult
import com.mentra.core.WifiStatus
import com.mentra.core.WifiStatusEvent
import com.mentra.examples.android.media.GStreamerWhipReceiver
import com.mentra.examples.android.media.LocalPhotoUploadServer
import com.mentra.examples.android.media.PhotoUpload
import com.mentra.examples.android.media.WhipHeaderProxy
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
import java.net.Inet4Address
import java.net.NetworkInterface
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

enum class PhotoDestination {
    MACBOOK_SERVER,
    THIS_PHONE,
}

data class ExampleEvent(
    val time: String,
    val tag: String,
    val text: String,
)

private data class RgbLedPattern(
    val action: RgbLedAction,
    val color: RgbLedColor?,
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

val rgbLedColorOptions = RgbLedColor.values().map { it.value }
const val MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD = "00001111"

data class MentraExampleState(
    val activeAction: String? = null,
    val bluetoothStatus: BluetoothStatus? = null,
    val cameraStatus: String = "Camera: phone receiver will start before capture",
    val discoveredDevices: List<Device> = emptyList(),
    val selectedDiscoveredDevice: Device? = null,
    val events: List<ExampleEvent> = listOf(exampleEvent("LIVE", "SDK ready. Scan to discover glasses.")),
    val galleryModeAuto: Boolean = false,
    val galleryServerReachable: Boolean? = null,
    val galleryServerStatus: String = "Gallery server: enable hotspot to check",
    val glassesStatus: GlassesStatus? = null,
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
    val photoDestination: PhotoDestination = PhotoDestination.THIS_PHONE,
    val photoPreviewUrl: String? = null,
    val photoCompression: String = "medium",
    val photoFlash: Boolean = false,
    val photoSize: String = "medium",
    val phonePhotoServerRunning: Boolean = false,
    val phonePhotoUploadUrl: String = "Phone receiver not started",
    val audioBondStatus: String = "Bond: checking",
    val audioMediaStatus: String = "Media: checking A2DP",
    val audioMediaConnected: Boolean = false,
    val phoneAudioRoute: String = "Phone media output",
    val phoneMediaVolume: Int? = null,
    val phoneMediaVolumeMax: Int? = null,
    val rawJsonExpanded: Boolean = false,
    val directStreamFrame: Bitmap? = null,
    val directStreamReceiverRunning: Boolean = false,
    val directStreamWhipUrl: String = "Phone receiver not started",
    val streamCloudServerEnabled: Boolean = false,
    val streamProtocol: String = "webrtc",
    val streamRequested: Boolean = false,
    val streamPreviewReady: Boolean = false,
    val streamStartedAt: Long? = null,
    val streamStatus: String = "Ready to stream WebRTC to this phone",
    val streamUrl: String = defaultStreamUrl("webrtc"),
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
    private val photoUploadServer = LocalPhotoUploadServer(
        appContext,
        onLog = { message -> scope.launch { addEvent("HTTP", message) } },
        onUpload = ::handleDirectPhotoUpload,
    )
    private var activePhotoRequestId: String? = null
    private var activeStreamId: String? = null
    private var pollGeneration = 0
    private var directPhotoTimeoutJob: Job? = null
    private var gStreamerWhipReceiver: GStreamerWhipReceiver? = null
    private var whipHeaderProxy: WhipHeaderProxy? = null
    private var keepAliveJob: Job? = null
    private var previewHealthJob: Job? = null
    private var directStreamStartJob: Job? = null
    private var directStreamStopJob: Job? = null
    private var directStreamFirstFrameSeen = false
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
        val initialGlassesStatus = mentraBluetoothSdk.getGlassesStatus()
        val initialBluetoothStatus = mentraBluetoothSdk.getBluetoothStatus()
        state = state.copy(
            glassesStatus = initialGlassesStatus,
            bluetoothStatus = initialBluetoothStatus,
            galleryModeAuto = galleryModeAuto(initialBluetoothStatus),
            hotspotEnabled = enabledHotspotStatus(initialGlassesStatus) != null,
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
        mentraBluetoothSdk.startScan(DeviceModel.MENTRA_LIVE)
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

    fun connect(device: Device) = runAction("Connect ${device.name}") {
        state = state.copy(selectedDiscoveredDevice = device)
        mentraBluetoothSdk.connect(device)
    }

    fun selectDiscoveredDevice(device: Device) {
        state = state.copy(
            selectedDiscoveredDevice = device,
            lastAction = "Selected: ${device.name}",
        )
    }

    fun disconnect() = runAction("Disconnect") {
        stopKeepAlive()
        stopPreviewHealthPoll()
        stopDirectPhoneStreamReceiver("Disconnected")
        mentraBluetoothSdk.disconnect()
        applyDisconnectedState("Disconnected")
    }

    fun clearDefaultDevice() = runAction("Clear default") {
        mentraBluetoothSdk.clearDefaultDevice()
        state = state.copy(
            bluetoothStatus = state.bluetoothStatus?.withDefaultDevice(null),
            selectedDiscoveredDevice = null,
        )
    }

    fun displayHello() = runAction("Display Hello") {
        requireConnected("display text")
        mentraBluetoothSdk.displayText(com.mentra.core.DisplayTextRequest("Hello from Mentra Bluetooth SDK"))
    }

    fun clearDisplay() = runAction("Clear Display") {
        requireConnected("clear the display")
        mentraBluetoothSdk.clearDisplay()
    }

    fun setGalleryModeAuto(enabled: Boolean) = runAction(if (enabled) "Save in gallery mode" else "Report button events") {
        requireConnected("change gallery mode")
        mentraBluetoothSdk.setGalleryMode(if (enabled) GalleryMode.AUTO else GalleryMode.MANUAL)
        state = state.copy(galleryModeAuto = enabled)
    }

    fun setWebhookUrl(url: String) {
        state = state.copy(webhookUrl = url)
    }

    fun setPhotoDestination(destination: PhotoDestination) {
        if (state.photoDestination == destination) {
            return
        }
        if (destination == PhotoDestination.MACBOOK_SERVER) {
            stopPhonePhotoServer()
            state = state.copy(cameraStatus = "Camera: enter a Photo upload URL")
        } else {
            state = state.copy(cameraStatus = "Camera: phone receiver will start before capture")
        }
        state = state.copy(photoDestination = destination)
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
        requireGlassesWifi("capture photos")
        if (state.photoDestination == PhotoDestination.THIS_PHONE) {
            captureAndUploadToPhone()
            return@runAction
        }
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
            PhotoRequest(
                requestId = requestId,
                appId = "com.mentra.examples.android",
                size = PhotoSize.fromValue(state.photoSize),
                webhookUrl = uploadUrl,
                compress = PhotoCompression.fromValue(state.photoCompression),
                flash = state.photoFlash,
                sound = true,
            )
        )
        pollPhotoPreview(requestId, statusUrl, generation)
    }

    private fun captureAndUploadToPhone() {
        val uploadUrl = startPhonePhotoServer()
        val requestId = "photo-${System.currentTimeMillis()}"
        activePhotoRequestId = requestId
        pollGeneration += 1
        directPhotoTimeoutJob?.cancel()
        directPhotoTimeoutJob = scope.launch {
            delay(75_000)
            if (activePhotoRequestId == requestId) {
                activePhotoRequestId = null
                state = state.copy(cameraStatus = "Camera: timed out waiting for phone upload")
                addEvent("TX", "phone photo upload timed out $requestId")
            }
        }
        state = state.copy(
            cameraStatus = "Camera: requested phone upload ($requestId)",
            photoPreviewUrl = null,
        )
        mentraBluetoothSdk.requestPhoto(
            PhotoRequest(
                requestId = requestId,
                appId = "com.mentra.examples.android",
                size = PhotoSize.fromValue(state.photoSize),
                webhookUrl = uploadUrl,
                compress = PhotoCompression.fromValue(state.photoCompression),
                flash = state.photoFlash,
                sound = true,
            )
        )
        addEvent("TX", "requestPhoto requestId=$requestId webhookUrl=$uploadUrl")
    }

    private fun startPhonePhotoServer(): String {
        val host = bestLocalIpv4Address()
        if (host == null) {
            val message = "No phone LAN IP found. Connect this phone to Wi-Fi or a network reachable by the glasses."
            state = state.copy(cameraStatus = "Camera: $message")
            throw IllegalStateException(message)
        }
        val existingUrl = state.phonePhotoUploadUrl
        if (photoUploadServer.running && existingUrl.startsWith("http://$host:")) {
            return existingUrl
        }

        state = state.copy(
            cameraStatus = "Camera: starting phone upload receiver",
            phonePhotoServerRunning = false,
            phonePhotoUploadUrl = "Starting phone receiver",
        )
        val ports = listOf(8787, 8788, 8789, 8790)
        var lastError: Throwable? = null
        for (port in ports) {
            try {
                val actualPort = photoUploadServer.start(port)
                val url = "http://$host:$actualPort/upload"
                state = state.copy(
                    phonePhotoServerRunning = true,
                    phonePhotoUploadUrl = url,
                    cameraStatus = "Camera: phone receiver ready",
                )
                addEvent("HTTP", "phone photo receiver $url")
                return url
            } catch (error: Throwable) {
                lastError = error
                addEvent("HTTP", "photo receiver port $port unavailable: ${error.message ?: error::class.java.simpleName}")
            }
        }
        val message = lastError?.message ?: "No local photo receiver port was available."
        state = state.copy(
            phonePhotoServerRunning = false,
            phonePhotoUploadUrl = "Phone receiver failed",
            cameraStatus = "Camera: phone receiver failed: $message",
        )
        throw IllegalStateException("Phone photo receiver failed: $message")
    }

    private fun stopPhonePhotoServer() {
        directPhotoTimeoutJob?.cancel()
        directPhotoTimeoutJob = null
        photoUploadServer.stop()
        state = state.copy(
            phonePhotoServerRunning = false,
            phonePhotoUploadUrl = "Phone receiver not started",
        )
    }

    fun testWebhook() = runAction("Test webhook") {
        if (state.photoDestination == PhotoDestination.THIS_PHONE) {
            startPhonePhotoServer()
            state = state.copy(cameraStatus = "Camera: phone receiver ready at ${state.phonePhotoUploadUrl}")
            return@runAction
        }
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
        if (state.streamProtocol == protocol) {
            return
        }
        val currentUrl = state.streamUrl.trim()
        val shouldUseDefault = currentUrl.isEmpty() || currentUrl in streamDefaultUrls.values
        val stoppedStream = stopStreamForConfigurationChange("Stopped before changing stream protocol")
        state = state.copy(
            streamProtocol = protocol,
            streamUrl = if (shouldUseDefault) defaultStreamUrl(protocol) else state.streamUrl,
            streamStatus = if (stoppedStream) "Ready to start stream" else state.streamStatus,
        )
    }

    fun setStreamCloudServerEnabled(enabled: Boolean) {
        if (state.streamCloudServerEnabled == enabled) {
            return
        }
        stopStreamForConfigurationChange("Stopped before changing stream destination")
        if (enabled) {
            val currentUrl = state.streamUrl.trim()
            val shouldUseDefault = currentUrl.isEmpty() || currentUrl in streamDefaultUrls.values
            state = state.copy(
                streamCloudServerEnabled = true,
                streamUrl = if (shouldUseDefault) defaultStreamUrl(state.streamProtocol) else state.streamUrl,
                streamStatus = "Ready to start stream",
                streamPreviewReady = false,
                directStreamFrame = null,
            )
            return
        }

        state = state.copy(
            streamCloudServerEnabled = false,
            streamStatus = "Ready to stream WebRTC to this phone",
            streamPreviewReady = false,
            directStreamFrame = null,
        )
    }

    fun setStreamUrl(url: String) {
        if (state.streamUrl == url) {
            return
        }
        val stoppedStream = stopStreamForConfigurationChange("Stopped before changing stream URL")
        state = state.copy(
            streamUrl = url,
            streamStatus = if (stoppedStream) "Ready to start stream" else state.streamStatus,
        )
    }

    fun toggleStream() = runAction(if (!state.streamRequested && state.streamStartedAt == null) "Start stream" else "Stop stream") {
        if (state.streamRequested || state.streamStartedAt != null) {
            stopKeepAlive()
            stopPreviewHealthPoll()
            if (isDirectPhoneWebRtcSelected()) {
                directStreamStartJob?.cancel()
                directStreamStartJob = null
                if (isGlassesConnected()) {
                    mentraBluetoothSdk.stopStream()
                    state = state.copy(streamStatus = "Stopping WebRTC direct phone stream")
                    directStreamStopJob?.cancel()
                    directStreamStopJob = scope.launch {
                        delay(5_000)
                        if (isDirectPhoneWebRtcSelected() && state.directStreamReceiverRunning) {
                            activeStreamId = null
                            stopDirectPhoneStreamReceiver("WebRTC direct phone stopped")
                            state = state.copy(streamRequested = false, streamStartedAt = null)
                        }
                    }
                    return@runAction
                }
                stopDirectPhoneStreamReceiver("Stopped")
                activeStreamId = null
                state = state.copy(streamRequested = false, streamPreviewReady = false, streamStartedAt = null, streamStatus = "Stopped")
                return@runAction
            }
            if (isGlassesConnected()) {
                mentraBluetoothSdk.stopStream()
            }
            state = state.copy(streamRequested = false, streamPreviewReady = false, streamStartedAt = null, streamStatus = "Stopped")
            return@runAction
        }
        requireConnected("start streaming")
        requireGlassesWifi("start streaming")
        if (isDirectPhoneWebRtcSelected()) {
            startDirectPhoneWebRtcStream()
            return@runAction
        }
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
            StreamRequest(
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

    private fun startDirectPhoneWebRtcStream() {
        stopPreviewHealthPoll()
        directStreamStopJob?.cancel()
        directStreamStopJob = null
        stopDirectPhoneStreamReceiver("Starting phone receiver")
        val host = bestLocalIpv4Address()
        if (host == null) {
            val message = "No phone LAN IP found. Connect this phone to Wi-Fi or a network reachable by the glasses."
            state = state.copy(streamStatus = message)
            throw IllegalStateException(message)
        }
        val receiver = directWhipReceiver()
        val proxy = directWhipProxy()
        val ports = listOf(8190 to 8191, 8192 to 8193, 8194 to 8195)
        var lastError: Throwable? = null
        for ((publicPort, backendPort) in ports) {
            try {
                val url = receiver.start(host, publicPort, backendPort)
                proxy.start(publicPort, backendPort)
                val streamId = "android-gst-${System.currentTimeMillis()}"
                activeStreamId = streamId
                directStreamFirstFrameSeen = false
                state = state.copy(
                    directStreamFrame = null,
                    directStreamReceiverRunning = true,
                    directStreamWhipUrl = url,
                    streamPreviewReady = false,
                    streamRequested = true,
                    streamStartedAt = null,
                    streamStatus = "WebRTC phone receiver ready; starting stream",
                )
                addEvent("STREAM", "phone WHIP receiver $url -> GStreamer $backendPort")
                directStreamStartJob?.cancel()
                directStreamStartJob = scope.launch {
                    delay(1_000)
                    if (activeStreamId == streamId && state.directStreamReceiverRunning && state.streamRequested) {
                        sendDirectPhoneStartStream(url, streamId)
                    }
                }
                return
            } catch (error: Throwable) {
                lastError = error
                proxy.stop()
                receiver.stop()
                addEvent("GST", "port pair $publicPort->$backendPort unavailable: ${error.message ?: error::class.java.simpleName}")
            }
        }

        val message = lastError?.message ?: "No local WHIP port pair was available."
        state = state.copy(
            directStreamReceiverRunning = false,
            directStreamWhipUrl = "Phone receiver failed",
            streamPreviewReady = false,
            streamRequested = false,
            streamStatus = "WebRTC phone receiver failed: $message",
        )
        throw IllegalStateException("WebRTC phone receiver failed: $message")
    }

    private fun sendDirectPhoneStartStream(streamUrl: String, streamId: String) {
        mentraBluetoothSdk.startStream(
            StreamRequest(
                streamUrl = streamUrl,
                streamId = streamId,
                keepAlive = true,
                keepAliveIntervalSeconds = 15,
            )
        )
        startKeepAlive(streamId)
        state = state.copy(
            streamRequested = true,
            streamStartedAt = state.streamStartedAt ?: System.currentTimeMillis(),
            streamStatus = "WebRTC stream requested; waiting for first frame",
        )
        addEvent("TX", "startStream direct phone $streamUrl")
    }

    private fun stopDirectPhoneStreamReceiver(status: String) {
        directStreamStartJob?.cancel()
        directStreamStartJob = null
        directStreamStopJob?.cancel()
        directStreamStopJob = null
        directStreamFirstFrameSeen = false
        whipHeaderProxy?.stop()
        gStreamerWhipReceiver?.stop()
        state = state.copy(
            directStreamFrame = null,
            directStreamReceiverRunning = false,
            directStreamWhipUrl = "Phone receiver not started",
            streamPreviewReady = false,
            streamStatus = status,
        )
    }

    private fun stopStreamForConfigurationChange(status: String): Boolean {
        val streamActive = state.streamRequested || state.streamStartedAt != null || state.directStreamReceiverRunning
        if (!streamActive) {
            return false
        }

        stopKeepAlive()
        stopPreviewHealthPoll()
        directStreamStartJob?.cancel()
        directStreamStartJob = null
        directStreamStopJob?.cancel()
        directStreamStopJob = null
        if (isGlassesConnected()) {
            mentraBluetoothSdk.stopStream()
            addEvent("TX", "stopStream before stream configuration change")
        }
        activeStreamId = null
        if (state.directStreamReceiverRunning) {
            stopDirectPhoneStreamReceiver(status)
        }
        state = state.copy(
            streamRequested = false,
            streamPreviewReady = false,
            streamStartedAt = null,
            streamStatus = status,
        )
        return true
    }

    private fun directWhipReceiver(): GStreamerWhipReceiver {
        gStreamerWhipReceiver?.let { return it }
        return GStreamerWhipReceiver(
            appContext,
            onStatus = { message ->
                scope.launch {
                    addEvent("GST", message)
                    if (isDirectPhoneWebRtcSelected() && state.directStreamReceiverRunning && !state.streamPreviewReady) {
                        state = state.copy(streamStatus = "WebRTC phone receiver: $message")
                    }
                }
            },
            onFrame = ::handleDirectStreamFrame,
        ).also { gStreamerWhipReceiver = it }
    }

    private fun directWhipProxy(): WhipHeaderProxy {
        whipHeaderProxy?.let { return it }
        return WhipHeaderProxy { message -> scope.launch { addEvent("WHIP", message) } }
            .also { whipHeaderProxy = it }
    }

    private fun handleDirectStreamFrame(bitmap: Bitmap) {
        if (!isDirectPhoneWebRtcSelected() || !state.directStreamReceiverRunning) {
            return
        }
        val firstFrame = !directStreamFirstFrameSeen
        directStreamFirstFrameSeen = true
        state = state.copy(
            directStreamFrame = bitmap,
            streamPreviewReady = true,
            streamStartedAt = state.streamStartedAt ?: System.currentTimeMillis(),
            streamStatus = "WebRTC direct phone live",
        )
        if (firstFrame) {
            addEvent("LIVE", "first WebRTC frame received on phone")
        }
    }

    private fun isDirectPhoneWebRtcSelected(): Boolean =
        !state.streamCloudServerEnabled

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
        val wifi = connectedWifiStatus(state.glassesStatus)
            ?: throw IllegalStateException("No connected Wi-Fi network to forget.")
        mentraBluetoothSdk.forgetWifiNetwork(wifi.ssid)
    }

    fun toggleHotspot() = runAction(if (state.hotspotEnabled) "Disable hotspot" else "Enable hotspot") {
        requireConnected("toggle hotspot")
        val current = enabledHotspotStatus(state.glassesStatus) != null ||
            (state.glassesStatus == null && state.hotspotEnabled)
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
            RgbLedRequest(
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
            "Solid" -> RgbLedPattern(RgbLedAction.ON, rgbLedColorFor(color), 30_000, 0, 1)
            "Pulse" -> RgbLedPattern(RgbLedAction.ON, rgbLedColorFor(color), 900, 900, 6)
            "Blink" -> RgbLedPattern(RgbLedAction.ON, rgbLedColorFor(color), 250, 250, 12)
            else -> RgbLedPattern(RgbLedAction.OFF, null, 0, 0, 0)
        }
    }

    fun toggleRawJson() {
        state = state.copy(rawJsonExpanded = !state.rawJsonExpanded)
    }

    private fun handleDirectPhotoUpload(upload: PhotoUpload) {
        scope.launch {
            val requestId = upload.requestId
            if (activePhotoRequestId != null && requestId != null && requestId != activePhotoRequestId) {
                addEvent("HTTP", "ignoring stale phone upload $requestId")
                return@launch
            }
            activePhotoRequestId = null
            directPhotoTimeoutJob?.cancel()
            directPhotoTimeoutJob = null
            state = state.copy(
                cameraStatus = "Camera: received phone upload ${requestId ?: ""}".trim(),
                photoPreviewUrl = Uri.fromFile(upload.photoFile).toString(),
            )
            addEvent("LIVE", "phone photo ready ${upload.byteCount} bytes requestId=${requestId ?: ""}")
        }
    }

    override fun onGlassesStatusChanged(status: GlassesStatusUpdate) {
        val wasConnected = isGlassesConnected()
        val nextStatus = state.glassesStatus?.applyUpdate(status) ?: mentraBluetoothSdk.getGlassesStatus()
        state = state.copy(glassesStatus = nextStatus)
        status.hotspot?.let { hotspot ->
            state = state.copy(hotspotEnabled = hotspot is HotspotStatus.Enabled)
        }
        if (isDisconnectedStatus(status)) {
            applyDisconnectedState("Disconnected")
        } else if (!wasConnected && isGlassesConnected()) {
            refreshGlassesMediaVolume()
        }
        addEvent("STORE", summarize(status))
    }

    override fun onBluetoothStatusChanged(status: BluetoothStatusUpdate) {
        val nextStatus = state.bluetoothStatus?.applyUpdate(status) ?: mentraBluetoothSdk.getBluetoothStatus()
        state = state.copy(
            bluetoothStatus = nextStatus,
            galleryModeAuto = status.galleryModeAuto ?: state.galleryModeAuto,
        )
        addEvent("BLE", summarize(status))
    }

    override fun onDeviceDiscovered(device: Device) {
        if (state.discoveredDevices.none { discoveredDeviceKey(it) == discoveredDeviceKey(device) }) {
            state = state.copy(
                discoveredDevices = state.discoveredDevices + device,
            )
        }
        addEvent("BLE", "discovered ${device.name}")
    }

    override fun onDefaultDeviceChanged(device: Device?) {
        savePersistedDefaultDevice(device)
        state = state.copy(bluetoothStatus = state.bluetoothStatus?.withDefaultDevice(device))
        if (device != null) {
            addEvent("BLE", "saved default ${device.name}")
        }
    }

    override fun onButtonPress(event: ButtonPressEvent) {
        addEvent("LIVE", "button ${event.buttonId}: ${event.pressType}")
    }

    override fun onTouch(event: TouchEvent) {
        val gesture = event.gestureName ?: summarize(event.values)
        addEvent("LIVE", "${if (event.isSwipe) "swipe" else "touch"} $gesture")
    }

    override fun onBatteryStatus(event: BatteryStatusEvent) {
        state = state.copy(
            glassesStatus = state.glassesStatus?.copy(
                batteryLevel = event.level ?: -1,
                charging = event.charging ?: false,
            )
        )
        addEvent("STORE", "battery ${event.level ?: "--"}%")
    }

    override fun onWifiStatusChanged(event: WifiStatusEvent) {
        val status = event.status
        state = state.copy(
            glassesStatus = state.glassesStatus?.copy(wifi = status),
            wifiPendingSsid = null,
        )
        val label = when (status) {
            is WifiStatus.Connected -> status.ssid
            WifiStatus.Disconnected -> "disconnected"
        }
        addEvent("STORE", "Wi-Fi $label")
    }

    override fun onHotspotStatusChanged(event: HotspotStatusEvent) {
        val status = event.status
        val enabled = status is HotspotStatus.Enabled
        val nextGlassesStatus = state.glassesStatus?.copy(
            hotspot = status,
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
        addEvent("STORE", "hotspot ${hotspotSummary(status)}")
    }

    override fun onHotspotError(event: HotspotErrorEvent) {
        state = state.copy(
            hotspotEnabled = false,
            galleryServerReachable = false,
            galleryServerStatus = "Gallery server: hotspot error",
            glassesStatus = state.glassesStatus?.copy(hotspot = HotspotStatus.Disabled),
        )
        addEvent("TX", "hotspot error ${event.message ?: summarize(event.values)}")
    }

    override fun onPhotoResponse(event: com.mentra.core.PhotoResponseEvent) {
        val response = event.response
        val requestId = response.requestId
        if (activePhotoRequestId != null && requestId != activePhotoRequestId) {
            addEvent("LIVE", "ignoring stale photo $requestId")
            return
        }
        val uploadTarget = if (state.photoDestination == PhotoDestination.THIS_PHONE) "phone upload" else "local upload"
        state = state.copy(
            cameraStatus = when (response) {
                is PhotoResponse.Error ->
                    "Camera: glasses reported ${response.errorCode ?: response.errorMessage}; waiting for $uploadTarget"
                is PhotoResponse.Success ->
                    "Camera: photo acknowledged; waiting for $uploadTarget"
            },
        )
        addEvent("LIVE", "photo response $requestId")
    }

    override fun onStreamStatus(event: com.mentra.core.StreamStatusEvent) {
        applyStreamStatus(event.status)
        val summary = summarize(event.values)
        val streamState = event.state
        if (isDirectPhoneWebRtcSelected()) {
            state = state.copy(
                streamStatus = when (streamState) {
                    StreamState.STOPPED, StreamState.STOPPING, StreamState.RECONNECT_FAILED ->
                        "WebRTC direct phone stopped"
                    StreamState.ERROR -> "WebRTC direct phone error: $summary"
                    else ->
                        if (state.streamPreviewReady) {
                            "WebRTC direct phone live"
                        } else {
                            "WebRTC stream requested; waiting for first frame"
                        }
                },
            )
        } else {
            state = state.copy(streamStatus = summary)
        }
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

    override fun onError(error: BluetoothError) {
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
        directPhotoTimeoutJob?.cancel()
        directStreamStartJob?.cancel()
        photoUploadServer.close()
        whipHeaderProxy?.close()
        gStreamerWhipReceiver?.close()
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

    private fun loadPersistedDefaultDevice(): Device? {
        val model = defaultDevicePrefs.getString(DEFAULT_DEVICE_MODEL_KEY, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val name = defaultDevicePrefs.getString(DEFAULT_DEVICE_NAME_KEY, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val address = defaultDevicePrefs.getString(DEFAULT_DEVICE_ADDRESS_KEY, null)?.takeIf { it.isNotBlank() }
        return Device(
            model = DeviceModel.fromDeviceType(model),
            name = name,
            address = address,
        )
    }

    private fun savePersistedDefaultDevice(device: Device?) {
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

    private fun requireGlassesWifi(feature: String) {
        if (isGlassesWifiConnected(state.glassesStatus)) {
            return
        }
        val message = "Connect the glasses to Wi-Fi from the System tab before you $feature."
        if ("photo" in feature || "capture" in feature) {
            state = state.copy(cameraStatus = "Camera: $message")
        }
        if ("stream" in feature) {
            state = state.copy(streamStatus = message)
        }
        addEvent("TX", message)
        throw IllegalStateException(message)
    }

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
        stopDirectPhoneStreamReceiver(status)
        activeStreamId = null
        val hadPhotoRequest = activePhotoRequestId != null
        activePhotoRequestId = null
        directPhotoTimeoutJob?.cancel()
        directPhotoTimeoutJob = null
        photoUploadServer.stop()
        if (hadPhotoRequest) {
            pollGeneration += 1
        }
        state = state.copy(
            glassesStatus = disconnectedGlassesStatus(state.glassesStatus),
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
            phonePhotoServerRunning = false,
            phonePhotoUploadUrl = "Phone receiver not started",
            cameraStatus = if (hadPhotoRequest) "Disconnected before photo upload completed" else state.cameraStatus,
            wifiPendingSsid = null,
        )
        stopMicElapsedTimer()
        stopMicPlayback()
    }

    private fun applyStreamStatus(status: StreamStatus) {
        when (status.state) {
            StreamState.INITIALIZING,
            StreamState.STREAMING,
            StreamState.RECONNECTING,
            StreamState.RECONNECTED -> {
                activeStreamId = status.streamId ?: activeStreamId
                state = state.copy(
                    streamRequested = true,
                    streamStartedAt = state.streamStartedAt ?: System.currentTimeMillis(),
                )
                if (keepAliveJob == null) {
                    startKeepAlive(activeStreamId ?: return)
                }
            }
            StreamState.STOPPED,
            StreamState.STOPPING,
            StreamState.RECONNECT_FAILED,
            StreamState.ERROR -> {
                stopKeepAlive()
                stopPreviewHealthPoll()
                activeStreamId = null
                state = state.copy(streamRequested = false, streamPreviewReady = false, streamStartedAt = null)
                if (state.directStreamReceiverRunning) {
                    stopDirectPhoneStreamReceiver("WebRTC direct phone stopped")
                }
            }
        }
    }

    private fun startKeepAlive(streamId: String) {
        stopKeepAlive()
        keepAliveJob = scope.launch {
            while (isActive) {
                delay(15_000)
                mentraBluetoothSdk.keepStreamAlive(
                    StreamKeepAliveRequest(
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
        mentraBluetoothSdk.setMicState(MicConfig(sendPcmData = true, sendTranscript = false, bypassVad = true))
        startMicElapsedTimer()
    }

    private fun stopMicRecording() {
        if (isGlassesConnected()) {
            mentraBluetoothSdk.setMicState(MicConfig(sendPcmData = false, sendTranscript = false, bypassVad = true))
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
            ?: state.bluetoothStatus?.deviceAddress?.takeIf { it.isNotBlank() }

    private fun currentTargetName(): String? =
        state.selectedDiscoveredDevice?.name
            ?: state.bluetoothStatus?.deviceName?.takeIf { it.isNotBlank() }
            ?: state.glassesStatus?.bluetoothName?.takeIf { it.isNotBlank() }
            ?: state.glassesStatus?.serialNumber?.takeIf { it.isNotBlank() }

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

fun rgbLedColorFor(color: String): RgbLedColor =
    RgbLedColor.fromValue(color) ?: RgbLedColor.RED

fun disconnectedGlassesStatus(status: GlassesStatus?): GlassesStatus? =
    status?.copy(
        connected = false,
        connectionState = "DISCONNECTED",
        fullyBooted = false,
        batteryLevel = -1,
        charging = false,
        hotspot = HotspotStatus.Disabled,
        wifi = WifiStatus.Disconnected,
    )

val photoSizeOptions = listOf("small", "medium", "large", "full")
val photoCompressionOptions = listOf("none", "medium", "heavy")

fun cameraSdkCall(
    size: String,
    compression: String,
    flash: Boolean,
): String = """
mentraBluetoothSdk.requestPhoto(
    PhotoRequest(
      requestId = requestId,
      appId = "com.mentra.examples.android",
      size = PhotoSize.${size.uppercase(Locale.US)},
      webhookUrl = uploadUrl,
      compress = PhotoCompression.${compression.uppercase(Locale.US)},
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
        return "Enter the cloud server Photo upload URL."
    }
    if (value.contains("<computer-ip>")) {
        return "Replace <computer-ip> with the cloud server IP."
    }
    return null
}

fun bestLocalIpv4Address(): String? {
    val interfaces = NetworkInterface.getNetworkInterfaces().toList()
    var fallback: String? = null
    interfaces.forEach { networkInterface ->
        if (!networkInterface.isUp || networkInterface.isLoopback) return@forEach
        networkInterface.inetAddresses.toList().forEach { address ->
            if (address is Inet4Address && !address.isLoopbackAddress) {
                if (networkInterface.name == "wlan0") return address.hostAddress
                fallback = fallback ?: address.hostAddress
            }
        }
    }
    return fallback
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

fun summarize(status: GlassesStatusUpdate): String =
    listOfNotNull(
        status.connectionState?.let { "connectionState: $it" },
        status.connected?.let { "connected: $it" },
        status.fullyBooted?.let { "fullyBooted: $it" },
        status.batteryLevel?.let { "batteryLevel: $it" },
        status.wifi?.let { "wifi: ${wifiSummary(it)}" },
        status.hotspot?.let { "hotspot: ${hotspotSummary(it)}" },
        status.signalStrength?.let { "signalStrength: $it" },
        status.signalStrengthUpdatedAt?.let { "RSSI updated: ${formatTime(it)}" },
    ).take(3).joinToString(", ").ifBlank { "empty update" }

fun summarize(status: BluetoothStatusUpdate): String =
    listOfNotNull(
        status.searching?.let { "searching: $it" },
        status.searchResults?.let { "searchResults: ${it.size}" },
        status.wifiScanResults?.let { "wifiScanResults: ${it.size}" },
        status.galleryModeAuto?.let { "galleryModeAuto: $it" },
        status.defaultWearable?.let { "defaultWearable: $it" },
        status.deviceName?.let { "deviceName: $it" },
    ).take(3).joinToString(", ").ifBlank { "empty update" }

fun GlassesStatus.applyUpdate(update: GlassesStatusUpdate): GlassesStatus =
    copy(
        fullyBooted = update.fullyBooted ?: fullyBooted,
        connected = update.connected ?: connected,
        micEnabled = update.micEnabled ?: micEnabled,
        connectionState = update.connectionState ?: connectionState,
        btcConnected = update.btcConnected ?: btcConnected,
        signalStrength = update.signalStrength ?: signalStrength,
        signalStrengthUpdatedAt = update.signalStrengthUpdatedAt ?: signalStrengthUpdatedAt,
        deviceModel = update.deviceModel ?: deviceModel,
        androidVersion = update.androidVersion ?: androidVersion,
        firmwareVersion = update.firmwareVersion ?: firmwareVersion,
        besFirmwareVersion = update.besFirmwareVersion ?: besFirmwareVersion,
        mtkFirmwareVersion = update.mtkFirmwareVersion ?: mtkFirmwareVersion,
        btMacAddress = update.btMacAddress ?: btMacAddress,
        leftMacAddress = update.leftMacAddress ?: leftMacAddress,
        rightMacAddress = update.rightMacAddress ?: rightMacAddress,
        macAddress = update.macAddress ?: macAddress,
        buildNumber = update.buildNumber ?: buildNumber,
        otaVersionUrl = update.otaVersionUrl ?: otaVersionUrl,
        appVersion = update.appVersion ?: appVersion,
        bluetoothName = update.bluetoothName ?: bluetoothName,
        serialNumber = update.serialNumber ?: serialNumber,
        style = update.style ?: style,
        color = update.color ?: color,
        wifi = update.wifi ?: wifi,
        batteryLevel = update.batteryLevel ?: batteryLevel,
        charging = update.charging ?: charging,
        caseBatteryLevel = update.caseBatteryLevel ?: caseBatteryLevel,
        caseCharging = update.caseCharging ?: caseCharging,
        caseOpen = update.caseOpen ?: caseOpen,
        caseRemoved = update.caseRemoved ?: caseRemoved,
        hotspot = update.hotspot ?: hotspot,
        headUp = update.headUp ?: headUp,
        controllerConnected = update.controllerConnected ?: controllerConnected,
        controllerFullyBooted = update.controllerFullyBooted ?: controllerFullyBooted,
        controllerMacAddress = update.controllerMacAddress ?: controllerMacAddress,
        controllerBatteryLevel = update.controllerBatteryLevel ?: controllerBatteryLevel,
        controllerSignalStrength = update.controllerSignalStrength ?: controllerSignalStrength,
        ringSignalStrength = update.ringSignalStrength ?: ringSignalStrength,
    )

fun BluetoothStatus.applyUpdate(update: BluetoothStatusUpdate): BluetoothStatus =
    copy(
        searching = update.searching ?: searching,
        searchingController = update.searchingController ?: searchingController,
        systemMicUnavailable = update.systemMicUnavailable ?: systemMicUnavailable,
        micEnabled = update.micEnabled ?: micEnabled,
        currentMic = update.currentMic ?: currentMic,
        micRanking = update.micRanking ?: micRanking,
        searchResults = update.searchResults ?: searchResults,
        wifiScanResults = update.wifiScanResults ?: wifiScanResults,
        lastLog = update.lastLog ?: lastLog,
        otherBtConnected = update.otherBtConnected ?: otherBtConnected,
        defaultWearable = update.defaultWearable ?: defaultWearable,
        pendingWearable = update.pendingWearable ?: pendingWearable,
        deviceName = update.deviceName ?: deviceName,
        deviceAddress = update.deviceAddress ?: deviceAddress,
        defaultController = update.defaultController ?: defaultController,
        pendingController = update.pendingController ?: pendingController,
        controllerDeviceName = update.controllerDeviceName ?: controllerDeviceName,
        screenDisabled = update.screenDisabled ?: screenDisabled,
        preferredMic = update.preferredMic ?: preferredMic,
        sensingEnabled = update.sensingEnabled ?: sensingEnabled,
        powerSavingMode = update.powerSavingMode ?: powerSavingMode,
        brightness = update.brightness ?: brightness,
        autoBrightness = update.autoBrightness ?: autoBrightness,
        dashboardHeight = update.dashboardHeight ?: dashboardHeight,
        dashboardDepth = update.dashboardDepth ?: dashboardDepth,
        headUpAngle = update.headUpAngle ?: headUpAngle,
        contextualDashboard = update.contextualDashboard ?: contextualDashboard,
        galleryModeAuto = update.galleryModeAuto ?: galleryModeAuto,
        buttonPhotoSize = update.buttonPhotoSize ?: buttonPhotoSize,
        buttonCameraLed = update.buttonCameraLed ?: buttonCameraLed,
        buttonMaxRecordingTime = update.buttonMaxRecordingTime ?: buttonMaxRecordingTime,
        buttonVideoWidth = update.buttonVideoWidth ?: buttonVideoWidth,
        buttonVideoHeight = update.buttonVideoHeight ?: buttonVideoHeight,
        buttonVideoFps = update.buttonVideoFps ?: buttonVideoFps,
        shouldSendPcm = update.shouldSendPcm ?: shouldSendPcm,
        shouldSendLc3 = update.shouldSendLc3 ?: shouldSendLc3,
        shouldSendTranscript = update.shouldSendTranscript ?: shouldSendTranscript,
        bypassVad = update.bypassVad ?: bypassVad,
        offlineCaptionsRunning = update.offlineCaptionsRunning ?: offlineCaptionsRunning,
        localSttFallbackActive = update.localSttFallbackActive ?: localSttFallbackActive,
        shouldSendBootingMessage = update.shouldSendBootingMessage ?: shouldSendBootingMessage,
    )

fun stringValue(values: Map<String, Any>, key: String): String? =
    (values[key] as? String)?.takeIf { it.isNotBlank() }

fun intValue(values: Map<String, Any>, key: String): Int? =
    when (val value = values[key]) {
        is Int -> value
        is Number -> value.toInt()
        else -> null
    }

fun boolValue(values: Map<String, Any>, key: String): Boolean? = values[key] as? Boolean

fun galleryModeAuto(status: BluetoothStatus?): Boolean = status?.galleryModeAuto ?: false

fun connectionLabel(status: GlassesStatus?): String =
    status?.connectionState?.takeIf { it.isNotBlank() }
        ?: if (isGlassesConnected(status)) "CONNECTED" else "WAITING"

fun isGlassesConnected(status: GlassesStatus?): Boolean {
    return when (status?.connectionState?.lowercase()) {
        "connected" -> true
        "disconnected" -> false
        else -> status?.connected == true
    }
}

fun isDisconnectedStatus(update: GlassesStatusUpdate): Boolean {
    return when (update.connectionState?.lowercase()) {
        "disconnected" -> true
        "connected" -> false
        else -> update.connected == false
    }
}

fun deviceLabel(status: GlassesStatus?): String =
    status?.bluetoothName?.takeIf { it.isNotBlank() }
        ?: status?.serialNumber?.takeIf { it.isNotBlank() }
        ?: status?.deviceModel?.takeIf { it.isNotBlank() }
        ?: "Mentra Live"

fun supportsDisplay(status: GlassesStatus?): Boolean {
    val model = listOfNotNull(
        status?.deviceModel,
        status?.bluetoothName,
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

fun modelLabel(status: GlassesStatus?): String =
    status?.deviceModel?.takeIf { it.isNotBlank() } ?: "Mentra Live"

fun batteryLevel(status: GlassesStatus?): Int? {
    val level = status?.batteryLevel ?: return null
    return if (level < 0 || !isGlassesConnected(status)) null else level.coerceAtMost(100)
}

fun batteryLabel(status: GlassesStatus?): String =
    batteryLevel(status)?.let { "$it%${if (status?.charging == true) " charging" else ""}" }
        ?: if (status?.connected == false || status?.connectionState?.lowercase() == "disconnected") "Not connected" else "Waiting for status"

fun wifiLabel(status: GlassesStatus?): String =
    when (val wifi = status?.wifi) {
        is WifiStatus.Connected -> wifi.ssid
        WifiStatus.Disconnected -> if (isGlassesConnected(status)) "Not connected" else "Unknown"
        null -> "Unknown"
    }

fun wifiSummary(wifi: WifiStatus): String =
    when (wifi) {
        is WifiStatus.Connected -> wifi.ssid.ifBlank { "connected" }
        WifiStatus.Disconnected -> "disconnected"
    }

fun hotspotSummary(hotspot: HotspotStatus): String =
    when (hotspot) {
        is HotspotStatus.Enabled -> "${hotspot.ssid} · ${hotspot.localIp}"
        HotspotStatus.Disabled -> "disabled"
    }

fun isGlassesWifiConnected(status: GlassesStatus?): Boolean =
    connectedWifiStatus(status) != null

fun connectedWifiStatus(status: GlassesStatus?): WifiStatus.Connected? =
    status?.wifi as? WifiStatus.Connected

fun enabledHotspotStatus(status: GlassesStatus?): HotspotStatus.Enabled? =
    status?.hotspot as? HotspotStatus.Enabled

fun hotspotLabel(status: GlassesStatus?, fallbackEnabled: Boolean): String {
    val hotspot = enabledHotspotStatus(status)
    if (hotspot != null) {
        return "${hotspot.ssid} · ${hotspot.localIp}"
    }
    return if (status == null && fallbackEnabled) "waiting for SSID" else "disabled"
}

fun galleryServerUrl(status: GlassesStatus?, fallbackEnabled: Boolean): String? {
    val hotspot = enabledHotspotStatus(status)
    if (hotspot == null && !(status == null && fallbackEnabled)) {
        return null
    }
    val gateway = hotspot?.localIp ?: "192.168.43.1"
    return "http://$gateway:8089"
}

fun galleryHotspotSsidLabel(status: GlassesStatus?): String {
    val ssid = enabledHotspotStatus(status)?.ssid
    return if (ssid == null) "the glasses hotspot" else "Wi-Fi $ssid"
}

fun galleryHotspotPasswordLabel(status: GlassesStatus?): String =
    enabledHotspotStatus(status)?.password
        ?: MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD

fun firmwareLabel(status: GlassesStatus?): String =
    status?.firmwareVersion?.takeIf { it.isNotBlank() }
        ?: status?.besFirmwareVersion?.takeIf { it.isNotBlank() }
        ?: status?.mtkFirmwareVersion?.takeIf { it.isNotBlank() }
        ?: "Unknown"

fun firmwareSubLabel(status: GlassesStatus?): String {
    val appVersion = status?.appVersion?.takeIf { it.isNotBlank() }
    return when {
        !status?.firmwareVersion.isNullOrBlank() -> "reported"
        !status?.besFirmwareVersion.isNullOrBlank() -> "BES firmware"
        !status?.mtkFirmwareVersion.isNullOrBlank() -> "MTK firmware"
        appVersion != null -> "ASG app $appVersion"
        else -> "not reported"
    }
}

fun rssiLabel(status: GlassesStatus?): String =
    status?.signalStrength?.takeIf { it != -1 }?.let { "$it dBm" } ?: "Unknown"

fun rssiUpdatedLabel(status: GlassesStatus?): String =
    status?.signalStrengthUpdatedAt?.takeIf { it > 0 }?.let { "updated ${formatTime(it)}" } ?: "signal"

private fun formatTime(timestampMs: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(timestampMs))

fun bluetoothSearchLabel(status: BluetoothStatus?): String {
    val searching = status?.searching == true
    val count = status?.searchResults?.size ?: 0
    return "${if (searching) "Scanning" else "Idle"} · $count result${if (count == 1) "" else "s"}"
}

fun discoveredDeviceKey(device: Device): String =
    device.id

fun targetDeviceDetail(device: Device): String =
    device.rssi?.let { "${device.model.deviceType} · $it dBm" } ?: device.model.deviceType

fun connectionTargetLabel(state: MentraExampleState, status: GlassesStatus?): String =
    when {
        isGlassesConnected(status) -> state.bluetoothStatus?.deviceName?.takeIf { it.isNotBlank() } ?: deviceLabel(status)
        state.selectedDiscoveredDevice != null -> state.selectedDiscoveredDevice.name
        state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus) -> savedConnectionTargetName(state.bluetoothStatus)
        state.discoveredDevices.isNotEmpty() -> "Choose a discovered device"
        else -> "Scan required"
    }

fun canConnectTarget(state: MentraExampleState): Boolean =
    state.selectedDiscoveredDevice != null ||
        (state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus))

fun hasSavedConnectionTarget(status: BluetoothStatus?): Boolean =
    !status?.defaultWearable.isNullOrBlank() && !status?.deviceName.isNullOrBlank()

fun BluetoothStatus.withDefaultDevice(device: Device?): BluetoothStatus =
    copy(
        defaultWearable = device?.model?.deviceType ?: "",
        deviceName = device?.name ?: "",
        deviceAddress = device?.address ?: "",
    )

fun savedConnectionTargetName(status: BluetoothStatus?): String =
    status?.deviceName?.takeIf { it.isNotBlank() } ?: "Saved glasses"

fun savedConnectionTargetDetail(status: BluetoothStatus?): String {
    val model = status?.defaultWearable?.takeIf { it.isNotBlank() } ?: "Saved model"
    return "$model · mentraBluetoothSdk.connectDefault()"
}

fun wifiScanResults(status: BluetoothStatus?): List<WifiScanResult> =
    status?.wifiScanResults ?: emptyList()

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
