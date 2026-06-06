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
import android.graphics.BitmapFactory
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
import com.mentra.bluetoothsdk.BatteryStatusEvent
import com.mentra.bluetoothsdk.BluetoothScanState
import com.mentra.bluetoothsdk.BluetoothError
import com.mentra.bluetoothsdk.MentraBluetoothSdk
import com.mentra.bluetoothsdk.MentraBluetoothSdkCallback
import com.mentra.bluetoothsdk.MicLc3Event
import com.mentra.bluetoothsdk.MicPcmEvent
import com.mentra.bluetoothsdk.OtaQueryResult
import com.mentra.bluetoothsdk.OtaStatusEvent
import com.mentra.bluetoothsdk.OtaUpdateAvailableEvent
import com.mentra.bluetoothsdk.ButtonPressEvent
import com.mentra.bluetoothsdk.CameraFov
import com.mentra.bluetoothsdk.CameraFovResult
import com.mentra.bluetoothsdk.CameraRoiPosition
import com.mentra.bluetoothsdk.GlassesBatteryState
import com.mentra.bluetoothsdk.Device
import com.mentra.bluetoothsdk.DeviceModel
import com.mentra.bluetoothsdk.GlassesConnectionState
import com.mentra.bluetoothsdk.GlassesRuntimeState
import com.mentra.bluetoothsdk.HotspotErrorEvent
import com.mentra.bluetoothsdk.HotspotStatus
import com.mentra.bluetoothsdk.HotspotStatusEvent
import com.mentra.bluetoothsdk.PhoneSdkRuntimeState
import com.mentra.bluetoothsdk.PhotoCompression
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.PhotoResponse
import com.mentra.bluetoothsdk.PhotoSize
import com.mentra.bluetoothsdk.RgbLedAction
import com.mentra.bluetoothsdk.RgbLedColor
import com.mentra.bluetoothsdk.RgbLedRequest
import com.mentra.bluetoothsdk.ScanSession
import com.mentra.bluetoothsdk.SettingsAckEvent
import com.mentra.bluetoothsdk.SpeakingStatusEvent
import com.mentra.bluetoothsdk.StreamState
import com.mentra.bluetoothsdk.StreamRequest
import com.mentra.bluetoothsdk.StreamResolvedConfig
import com.mentra.bluetoothsdk.StreamStatus
import com.mentra.bluetoothsdk.StreamVideoConfig
import com.mentra.bluetoothsdk.TouchEvent
import com.mentra.bluetoothsdk.VoiceActivityDetectionStatusEvent
import com.mentra.bluetoothsdk.WifiScanResult
import com.mentra.bluetoothsdk.WifiStatus
import com.mentra.bluetoothsdk.WifiStatusEvent
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

data class PhotoPreviewDetails(
    val byteCount: Int? = null,
    val contentType: String? = null,
    val error: String? = null,
    val height: Int? = null,
    val previewUrl: String? = null,
    val requestId: String? = null,
    val source: String,
    val state: String,
    val timestamp: Long? = null,
    val uploadUrl: String? = null,
    val uploadedAt: String? = null,
    val width: Int? = null,
)

private data class RgbLedPattern(
    val action: RgbLedAction,
    val color: RgbLedColor?,
    val onDurationMs: Int,
    val offDurationMs: Int,
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
val scanModelOptions = listOf(DeviceModel.MENTRA_LIVE, DeviceModel.G2)
const val MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD = "00001111"
const val PHOTO_EXPOSURE_MIN_NS = 1_000_000
const val PHOTO_EXPOSURE_MAX_NS = 33_333_333
const val PHOTO_EXPOSURE_DEFAULT_NS = 8_333_333
const val PHOTO_ISO_MIN = 100
const val PHOTO_ISO_MAX = 6400
const val PHOTO_ISO_DEFAULT = 200
const val CAMERA_FOV_MIN = 62
const val CAMERA_FOV_MAX = 118
const val CAMERA_FOV_DEFAULT = 102
val cameraRoiPositions = listOf("Center" to 0, "Bottom" to 1, "Top" to 2)

data class MentraExampleState(
    val activeAction: String? = null,
    val bluetoothStatus: PhoneSdkRuntimeState? = null,
    val cameraStatus: String = "Camera: phone receiver will start before capture",
    val discoveredDevices: List<Device> = emptyList(),
    val selectedDiscoveredDevice: Device? = null,
    val selectedScanModel: DeviceModel = DeviceModel.MENTRA_LIVE,
    val events: List<ExampleEvent> = listOf(exampleEvent("LIVE", "SDK ready. Scan to discover glasses.")),
    val galleryModeEnabled: Boolean = false,
    val galleryServerReachable: Boolean? = null,
    val galleryServerStatus: String = "Gallery server: enable hotspot to check",
    val glassesStatus: GlassesRuntimeState? = null,
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
    val otaStatus: OtaStatusEvent? = null,
    val otaStatusMessage: String? = null,
    val otaUpdateAvailable: OtaUpdateAvailableEvent? = null,
    val pcmBytes: Int = 0,
    val pcmFrames: Int = 0,
    val speaking: Boolean? = null,
    val voiceActivityDetectionEnabled: Boolean = false,
    val photoDestination: PhotoDestination = PhotoDestination.THIS_PHONE,
    val photoPreviewDetails: PhotoPreviewDetails? = null,
    val photoPreviewUrl: String? = null,
    val photoCompression: String = "none",
    val photoSize: String = "full",
    val photoExposureManual: Boolean = false,
    val photoExposureTimeNs: Int = PHOTO_EXPOSURE_DEFAULT_NS,
    val photoIso: Int = PHOTO_ISO_DEFAULT,
    val cameraFov: Int = CAMERA_FOV_DEFAULT,
    val cameraRoiPosition: Int = 0,
    val cameraSettingsStatus: String = "Camera settings: default",
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
    val streamFps: Int = 15,
    val streamRequested: Boolean = false,
    val streamPreviewReady: Boolean = false,
    val streamResolvedConfig: StreamResolvedConfig? = null,
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
    private var previewHealthJob: Job? = null
    private var directStreamFrameWatchdogJob: Job? = null
    private var directStreamStartJob: Job? = null
    private var directStreamStopJob: Job? = null
    private var directStreamFirstFrameSeen = false
    private var lastDirectStreamFrameWatchdogRefreshMs = 0L
    private var scanSession: ScanSession? = null
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
        val initialState = mentraBluetoothSdk.getState()
        state = state.copy(
            glassesStatus = initialState.glasses,
            bluetoothStatus = initialState.sdk,
            discoveredDevices = initialState.scan.devices,
            galleryModeEnabled = galleryModeEnabled(initialState.sdk),
            hotspotEnabled = enabledHotspotStatus(initialState.glasses) != null,
            phoneAudioRoute = currentAudioOutputRouteLabel(),
        )
        registerAudioStateObservers()
        refreshAudioSystemState()
        if (savedDefaultDevice != null) {
            autoConnectDefaultOnStartup()
        }
    }

    fun startScan() {
        val model = state.selectedScanModel
        runAction("Scan ${deviceModelLabel(model)}") {
            scanSession?.stop()
            state = state.copy(discoveredDevices = emptyList(), selectedDiscoveredDevice = null)
            scanSession = mentraBluetoothSdk.scan(model, 10_000L) { devices ->
                state = state.copy(
                    discoveredDevices = devices,
                )
            }
        }
    }

    fun selectScanModel(model: DeviceModel) {
        if (state.selectedScanModel == model) {
            return
        }
        scanSession?.stop()
        scanSession = null
        state = state.copy(
            discoveredDevices = emptyList(),
            selectedDiscoveredDevice = null,
            selectedScanModel = model,
            lastAction = "Selected scan model: ${deviceModelLabel(model)}",
        )
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
        stopPreviewHealthPoll()
        stopDirectStreamFrameWatchdog()
        stopDirectPhoneStreamReceiver("Disconnected")
        mentraBluetoothSdk.disconnect()
        applyDisconnectedState("Disconnected")
    }

    fun clearDefaultDevice() = runAction("Clear default") {
        mentraBluetoothSdk.clearDefaultDevice()
        state = state.copy(
            bluetoothStatus = state.bluetoothStatus?.copy(defaultDevice = null),
            selectedDiscoveredDevice = null,
        )
    }

    fun displayHello() = runAction("Display Hello") {
        requireConnected("display text")
        mentraBluetoothSdk.displayText("Hello from Mentra Bluetooth SDK")
    }

    fun clearDisplay() = runAction("Clear Display") {
        requireConnected("clear the display")
        mentraBluetoothSdk.clearDisplay()
    }

    fun setGalleryModeEnabled(enabled: Boolean) = runAction(if (enabled) "Save in gallery mode" else "Report button events") {
        requireConnected("change gallery mode")
        val ack = withContext(Dispatchers.IO) { mentraBluetoothSdk.setGalleryModeEnabled(enabled) }
        addEvent("LIVE", "settings_ack ${describeSettingsAck(ack)}")
        state = state.copy(galleryModeEnabled = enabled)
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

    fun setPhotoExposureManual(enabled: Boolean) {
        state = state.copy(photoExposureManual = enabled)
    }

    fun setPhotoExposureTimeNs(exposureTimeNs: Int) {
        state = state.copy(photoExposureTimeNs = exposureTimeNs.coerceIn(PHOTO_EXPOSURE_MIN_NS, PHOTO_EXPOSURE_MAX_NS))
    }

    fun setPhotoIso(iso: Int) {
        state = state.copy(photoIso = iso.coerceIn(PHOTO_ISO_MIN, PHOTO_ISO_MAX))
    }

    fun setCameraFov(fov: Int) {
        val nextFov = fov.coerceIn(CAMERA_FOV_MIN, CAMERA_FOV_MAX)
        state = state.copy(
            cameraFov = nextFov,
            cameraRoiPosition = if (nextFov == CAMERA_FOV_MAX) 0 else state.cameraRoiPosition,
        )
    }

    fun setCameraRoiPosition(roiPosition: Int) {
        state = state.copy(cameraRoiPosition = if (state.cameraFov == CAMERA_FOV_MAX) 0 else roiPosition.coerceIn(0, 2))
    }

    fun applyCameraSettings() = runAction("Apply camera settings") {
        requireConnected("apply camera settings")
        val fov = state.cameraFov.coerceIn(CAMERA_FOV_MIN, CAMERA_FOV_MAX)
        val roiPosition = if (fov == CAMERA_FOV_MAX) 0 else state.cameraRoiPosition.coerceIn(0, 2)
        state = state.copy(cameraSettingsStatus = "Camera settings: waiting for glasses camera-ready ack")
        val result = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.setCameraFov(CameraFov(fov, CameraRoiPosition.fromValue(roiPosition)))
        }
        addEvent("LIVE", "camera_fov ${describeCameraFovResult(result)}")
        state = state.copy(
            cameraSettingsStatus = "Camera settings: camera ready; field of view ${result.fov}°, ${roiPositionLabel(result.roiPosition.value)} crop",
        )
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
            photoPreviewDetails = null,
            photoPreviewUrl = null,
        )
        val responseEvent = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.requestPhoto(
                PhotoRequest(
                    requestId = requestId,
                    appId = "com.mentra.examples.android",
                    size = PhotoSize.fromValue(state.photoSize),
                    webhookUrl = uploadUrl,
                    compress = PhotoCompression.fromValue(state.photoCompression),
                    sound = true,
                    exposureTimeNs = if (state.photoExposureManual) state.photoExposureTimeNs.toDouble() else null,
                    iso = if (state.photoExposureManual) state.photoIso else null,
                )
            )
        }
        handlePhotoResponse(responseEvent)
        pollPhotoPreview(requestId, statusUrl, generation)
    }

    private suspend fun captureAndUploadToPhone() {
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
            photoPreviewDetails = null,
            photoPreviewUrl = null,
        )
        val responseEvent = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.requestPhoto(
                PhotoRequest(
                    requestId = requestId,
                    appId = "com.mentra.examples.android",
                    size = PhotoSize.fromValue(state.photoSize),
                    webhookUrl = uploadUrl,
                    compress = PhotoCompression.fromValue(state.photoCompression),
                    sound = true,
                    exposureTimeNs = if (state.photoExposureManual) state.photoExposureTimeNs.toDouble() else null,
                    iso = if (state.photoExposureManual) state.photoIso else null,
                )
            )
        }
        handlePhotoResponse(responseEvent)
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
            streamResolvedConfig = null,
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
                streamResolvedConfig = null,
                directStreamFrame = null,
            )
            return
        }

        state = state.copy(
            streamCloudServerEnabled = false,
            streamStatus = "Ready to stream WebRTC to this phone",
            streamPreviewReady = false,
            streamResolvedConfig = null,
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
            streamResolvedConfig = null,
        )
    }

    fun setStreamFps(fps: Int) {
        if (state.streamRequested || state.streamStartedAt != null) {
            return
        }
        state = state.copy(streamFps = fps.coerceIn(1, 24))
    }

    fun toggleStream() = runAction(if (!state.streamRequested && state.streamStartedAt == null) "Start stream" else "Stop stream") {
        if (state.streamRequested || state.streamStartedAt != null) {
            stopPreviewHealthPoll()
            stopDirectStreamFrameWatchdog()
            if (isDirectPhoneWebRtcSelected()) {
                directStreamStartJob?.cancel()
                directStreamStartJob = null
                if (isGlassesConnected()) {
                    val status = withContext(Dispatchers.IO) { mentraBluetoothSdk.stopStream() }
                    addEvent("LIVE", "stream ${summarize(status.values)}")
                    state = state.copy(streamStatus = "Stopping WebRTC direct phone stream")
                    directStreamStopJob?.cancel()
                    directStreamStopJob = scope.launch {
                        delay(5_000)
                        if (isDirectPhoneWebRtcSelected() && state.directStreamReceiverRunning) {
                            activeStreamId = null
                            stopDirectPhoneStreamReceiver("WebRTC direct phone stopped")
                            state = state.copy(
                                streamRequested = false,
                                streamResolvedConfig = null,
                                streamStartedAt = null,
                            )
                        }
                    }
                    return@runAction
                }
                stopDirectPhoneStreamReceiver("Stopped")
                activeStreamId = null
                state = state.copy(
                    streamRequested = false,
                    streamPreviewReady = false,
                    streamResolvedConfig = null,
                    streamStartedAt = null,
                    streamStatus = "Stopped",
                )
                return@runAction
            }
            if (isGlassesConnected()) {
                val status = withContext(Dispatchers.IO) { mentraBluetoothSdk.stopStream() }
                addEvent("LIVE", "stream ${summarize(status.values)}")
            }
            state = state.copy(
                streamRequested = false,
                streamPreviewReady = false,
                streamResolvedConfig = null,
                streamStartedAt = null,
                streamStatus = "Stopped",
            )
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

    private suspend fun startStream(streamUrl: String, streamId: String, protocol: String) {
        val status = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.startStream(
                StreamRequest(
                    streamUrl = streamUrl,
                    streamId = streamId,
                    video = StreamVideoConfig(fps = state.streamFps),
                )
            )
        }
        addEvent("LIVE", "stream ${summarize(status.values)}")
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
                lastDirectStreamFrameWatchdogRefreshMs = 0L
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
        stopDirectStreamFrameWatchdog()
        throw IllegalStateException("WebRTC phone receiver failed: $message")
    }

    private suspend fun sendDirectPhoneStartStream(streamUrl: String, streamId: String) {
        val status = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.startStream(
                StreamRequest(
                    streamUrl = streamUrl,
                    streamId = streamId,
                    video = StreamVideoConfig(fps = state.streamFps),
                )
            )
        }
        addEvent("LIVE", "stream ${summarize(status.values)}")
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
        stopDirectStreamFrameWatchdog()
        directStreamFirstFrameSeen = false
        lastDirectStreamFrameWatchdogRefreshMs = 0L
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

        stopPreviewHealthPoll()
        stopDirectStreamFrameWatchdog()
        directStreamStartJob?.cancel()
        directStreamStartJob = null
        directStreamStopJob?.cancel()
        directStreamStopJob = null
        if (isGlassesConnected()) {
            scope.launch {
                try {
                    val status = withContext(Dispatchers.IO) { mentraBluetoothSdk.stopStream() }
                    addEvent("LIVE", "stream ${summarize(status.values)}")
                } catch (error: Throwable) {
                    addEvent("TX", "stopStream before configuration change failed: ${error.message ?: error::class.java.simpleName}")
                }
            }
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
        val now = System.currentTimeMillis()
        if (firstFrame || now - lastDirectStreamFrameWatchdogRefreshMs >= 1_000) {
            lastDirectStreamFrameWatchdogRefreshMs = now
            scheduleDirectStreamFrameWatchdog()
        }
    }

    private fun isDirectPhoneWebRtcSelected(): Boolean =
        !state.streamCloudServerEnabled

    private fun scheduleDirectStreamFrameWatchdog() {
        directStreamFrameWatchdogJob?.cancel()
        directStreamFrameWatchdogJob = scope.launch {
            delay(7_000)
            if (!isDirectPhoneWebRtcSelected() || !state.directStreamReceiverRunning || activeStreamId == null) {
                return@launch
            }
            state = state.copy(
                streamPreviewReady = false,
                streamStatus = "WebRTC preview stalled: no video frames received from glasses",
            )
            addEvent("TX", "WebRTC preview stalled")
        }
    }

    private fun stopDirectStreamFrameWatchdog() {
        directStreamFrameWatchdogJob?.cancel()
        directStreamFrameWatchdogJob = null
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
                                streamStatus = "${protocol.uppercase()} media path lost; preview may be frozen",
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
        val networks = withContext(Dispatchers.IO) { mentraBluetoothSdk.requestWifiScan() }
        addEvent("LIVE", "Wi-Fi scan returned ${networks.size} network${if (networks.size == 1) "" else "s"}")
    }

    fun sendWifiCredentials(ssid: String, password: String, requiresPassword: Boolean) = runAction("Connect Wi-Fi $ssid") {
        requireConnected("send Wi-Fi credentials")
        if (requiresPassword && password.isBlank()) {
            throw IllegalArgumentException("Enter the Wi-Fi password before connecting to $ssid.")
        }
        val status = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.sendWifiCredentials(ssid, if (requiresPassword) password else "")
        }
        addEvent("LIVE", "Wi-Fi ${summarize(status.values)}")
        state = state.copy(wifiPendingSsid = ssid)
    }

    fun forgetCurrentWifiNetwork() = runAction("Forget current Wi-Fi") {
        requireConnected("forget Wi-Fi network")
        val wifi = connectedWifiStatus(state.glassesStatus)
            ?: throw IllegalStateException("No connected Wi-Fi network to forget.")
        val status = withContext(Dispatchers.IO) { mentraBluetoothSdk.forgetWifiNetwork(wifi.ssid) }
        addEvent("LIVE", "Wi-Fi ${summarize(status.values)}")
    }

    fun toggleHotspot() = runAction(if (state.hotspotEnabled) "Disable hotspot" else "Enable hotspot") {
        requireConnected("toggle hotspot")
        val current = enabledHotspotStatus(state.glassesStatus) != null ||
            (state.glassesStatus == null && state.hotspotEnabled)
        val next = !current
        val status = withContext(Dispatchers.IO) { mentraBluetoothSdk.setHotspotState(next) }
        addEvent("LIVE", "hotspot ${summarize(status.values)}")
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

    fun setVoiceActivityDetectionEnabled(enabled: Boolean) = runAction(
        if (enabled) "Enable voice activity detection" else "Disable voice activity detection"
    ) {
        requireConnected("change voice activity detection")
        state = state.copy(voiceActivityDetectionEnabled = enabled)
        mentraBluetoothSdk.setVoiceActivityDetectionEnabled(enabled)
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

    private suspend fun sendRgbLedRequest(mode: String, color: String) {
        val request = rgbLedRequestFor(mode, color)
        val response = withContext(Dispatchers.IO) {
            mentraBluetoothSdk.rgbLedControl(
                RgbLedRequest(
                    requestId = "rgb-${System.currentTimeMillis()}",
                    packageName = "com.mentra.examples.android",
                    action = request.action,
                    color = request.color,
                    onDurationMs = request.onDurationMs,
                    offDurationMs = request.offDurationMs,
                    count = request.count,
                )
            )
        }
        addEvent("LIVE", "RGB LED ack ${response.requestId}")
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
            val dimensions = imageDimensions(upload.photoFile)
            val previewUrl = Uri.fromFile(upload.photoFile).toString()
            state = state.copy(
                cameraStatus = "Camera: received phone upload ${requestId ?: ""}".trim(),
                photoPreviewDetails = state.photoPreviewDetails.copyForUpload(
                    byteCount = upload.byteCount,
                    contentType = "image/jpeg",
                    height = dimensions?.second,
                    previewUrl = previewUrl,
                    requestId = requestId,
                    source = "Phone receiver",
                    width = dimensions?.first,
                ),
                photoPreviewUrl = previewUrl,
            )
            addEvent("LIVE", "phone photo ready ${upload.byteCount} bytes requestId=${requestId ?: ""}")
        }
    }

    override fun onGlassesChanged(glasses: GlassesRuntimeState) {
        val wasConnected = isGlassesConnected()
        state = state.copy(
            glassesStatus = glasses,
            hotspotEnabled = enabledHotspotStatus(glasses) != null,
        )
        if (!glasses.connected) {
            applyDisconnectedState("Disconnected")
        } else if (!wasConnected && isGlassesConnected()) {
            refreshGlassesMediaVolume()
        }
        addEvent("STORE", summarize(glasses))
    }

    override fun onSdkStateChanged(sdk: PhoneSdkRuntimeState) {
        state = state.copy(
            bluetoothStatus = sdk,
            galleryModeEnabled = galleryModeEnabled(sdk),
        )
        addEvent("BLE", summarize(sdk))
    }

    override fun onScanChanged(scan: BluetoothScanState) {
        state = state.copy(discoveredDevices = scan.devices)
    }

    override fun onDeviceDiscovered(device: Device) {
        addEvent("BLE", "discovered ${device.name}")
    }

    override fun onDefaultDeviceChanged(device: Device?) {
        savePersistedDefaultDevice(device)
        state = state.copy(bluetoothStatus = state.bluetoothStatus?.copy(defaultDevice = device))
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
        val glasses = state.glassesStatus as? GlassesRuntimeState.Connected
        state = state.copy(
            glassesStatus = glasses?.copy(
                battery = GlassesBatteryState(
                    charging = event.charging ?: false,
                    level = event.level?.takeUnless { it < 0 },
                ),
            )
        )
        addEvent("STORE", "battery ${event.level ?: "--"}%")
    }

    override fun onWifiStatusChanged(event: WifiStatusEvent) {
        val status = event.status
        val glasses = state.glassesStatus as? GlassesRuntimeState.Connected
        state = state.copy(
            glassesStatus = glasses?.copy(wifi = status),
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
        val nextGlassesStatus = (state.glassesStatus as? GlassesRuntimeState.Connected)?.copy(hotspot = status)
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
        val glasses = state.glassesStatus as? GlassesRuntimeState.Connected
        state = state.copy(
            hotspotEnabled = false,
            galleryServerReachable = false,
            galleryServerStatus = "Gallery server: hotspot error",
            glassesStatus = glasses?.copy(hotspot = HotspotStatus.Disabled),
        )
        addEvent("TX", "hotspot error ${event.message ?: summarize(event.values)}")
    }

    private fun handlePhotoResponse(event: com.mentra.bluetoothsdk.PhotoResponseEvent) {
        val response = event.response
        val requestId = response.requestId
        if (activePhotoRequestId != null && requestId != activePhotoRequestId) {
            addEvent("LIVE", "ignoring stale photo $requestId")
            return
        }
        val uploadTarget = if (state.photoDestination == PhotoDestination.THIS_PHONE) "phone receiver" else "cloud webhook"
        val nextDetails = when (response) {
            is PhotoResponse.Error -> PhotoPreviewDetails(
                error = response.errorCode ?: response.errorMessage,
                requestId = requestId,
                source = if (state.photoDestination == PhotoDestination.THIS_PHONE) "Phone receiver" else "Cloud server",
                state = "error",
                timestamp = response.timestamp,
            )
            is PhotoResponse.Success -> state.photoPreviewDetails.copyForAck(
                requestId = requestId,
                source = if (state.photoDestination == PhotoDestination.THIS_PHONE) "Phone receiver" else "Cloud server",
                timestamp = response.timestamp,
                uploadUrl = response.uploadUrl,
            )
        }
        state = state.copy(
            cameraStatus = when (response) {
                is PhotoResponse.Error ->
                    "Camera: photo failed (${response.errorCode ?: response.errorMessage})"
                is PhotoResponse.Success ->
                    "Camera: photo delivered to $uploadTarget"
            },
            photoPreviewDetails = nextDetails,
        )
        addEvent("LIVE", "photo response $requestId")
    }

    override fun onStreamStatus(event: com.mentra.bluetoothsdk.StreamStatusEvent) {
        applyStreamStatus(event.status)
        event.resolvedConfig?.let { resolvedConfig ->
            state = state.copy(streamResolvedConfig = resolvedConfig)
        }
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

    override fun onOtaStatus(event: OtaStatusEvent) {
        applyOtaStatus(event)
    }

    private fun handleOtaQueryResult(result: OtaQueryResult) {
        if (result.type == "ota_update_available") {
            val event = OtaUpdateAvailableEvent(
                versionCode = result.values.longValue("version_code"),
                versionName = result.values.stringValue("version_name"),
                updates = (result.values["updates"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
                totalSize = result.values.longValue("total_size"),
                cacheReady = result.values["cache_ready"] as? Boolean,
                values = result.values,
            )
            state = state.copy(
                otaStatus = null,
                otaStatusMessage = null,
                otaUpdateAvailable = event,
            )
            addEvent("LIVE", "OTA available ${event.versionName ?: "unknown"} (${event.updates.joinToString().ifBlank { "update" }})")
            return
        }

        val event = OtaStatusEvent(
            sessionId = result.values.stringValue("session_id").orEmpty(),
            totalSteps = result.values.intValue("total_steps") ?: 0,
            currentStep = result.values.intValue("current_step") ?: 0,
            stepType = result.values.stringValue("step_type").orEmpty(),
            phase = result.values.stringValue("phase").orEmpty(),
            stepPercent = result.values.intValue("step_percent") ?: 0,
            overallPercent = result.values.intValue("overall_percent") ?: 0,
            status = result.values.stringValue("status").orEmpty(),
            errorMessage = result.values.stringValue("error_message"),
            glassesTimeMs = result.values.longValue("glasses_time_ms"),
            values = result.values,
        )
        applyOtaStatus(event)
    }

    override fun onMicPcm(event: MicPcmEvent) {
        if (!state.micRecording) return
        val frame = event.pcm
        micPcmBuffer.write(frame)
        state = state.copy(pcmFrames = state.pcmFrames + 1, pcmBytes = state.pcmBytes + frame.size)
    }

    override fun onMicLc3(event: MicLc3Event) {
        if (!state.micRecording) return
        addEvent(
            "LIVE",
            "received LC3 mic frame while PCM recording is enabled (${event.lc3.size} bytes, ${event.frameDurationMs}ms)",
        )
    }

    override fun onVoiceActivityDetectionStatus(event: VoiceActivityDetectionStatusEvent) {
        state = state.copy(voiceActivityDetectionEnabled = event.voiceActivityDetectionEnabled)
        addEvent(
            "LIVE",
            "voice activity detection ${if (event.voiceActivityDetectionEnabled) "enabled" else "disabled"}",
        )
    }

    override fun onSpeakingStatus(event: SpeakingStatusEvent) {
        state = state.copy(speaking = event.speaking)
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

    fun checkForOtaUpdate() = runAction("Check OTA") {
        requireConnected("check OTA")
        requireGlassesWifi("check for OTA updates")
        handleOtaQueryResult(withContext(Dispatchers.IO) { mentraBluetoothSdk.checkForOtaUpdate() })
    }

    fun startOtaUpdate() = runAction("Start OTA") {
        requireConnected("start OTA")
        requireGlassesWifi("start OTA updates")
        withContext(Dispatchers.IO) { mentraBluetoothSdk.startOtaUpdate() }
        addEvent("LIVE", "OTA start acknowledged")
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
                glassesVolumeStatus = "Glasses volume: connect glasses",
            )
            return
        }

        if (showLoading) {
            state = state.copy(glassesVolumeStatus = "Glasses volume: reading...")
        }
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { mentraBluetoothSdk.getGlassesMediaVolume() }
                val volume = result.level
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
        stopPreviewHealthPoll()
        stopDirectStreamFrameWatchdog()
        directPhotoTimeoutJob?.cancel()
        directStreamStartJob?.cancel()
        scanSession?.stop()
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

    private fun runAction(label: String, action: suspend () -> Unit) {
        state = state.copy(activeAction = label, lastAction = "Running: $label")
        addEvent("TX", label)
        scope.launch {
            try {
                action()
                state = state.copy(lastAction = "Requested: $label")
            } catch (error: Throwable) {
                state = state.copy(lastAction = "Failed: $label - ${error.message}")
                addEvent("TX", "$label failed: ${error.message}")
            } finally {
                state = state.copy(activeAction = state.activeAction.takeUnless { it == label })
            }
        }
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
        stopPreviewHealthPoll()
        stopDirectStreamFrameWatchdog()
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
            otaStatus = null,
            otaStatusMessage = null,
            otaUpdateAvailable = null,
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

    private fun applyOtaStatus(event: OtaStatusEvent) {
        if (!isDisplayableOtaStatus(event)) {
            state = state.copy(
                otaStatus = null,
                otaStatusMessage = "No active OTA",
                otaUpdateAvailable = null,
            )
            addEvent("LIVE", "OTA idle")
            return
        }

        state = state.copy(
            otaStatus = event,
            otaStatusMessage = null,
            otaUpdateAvailable = state.otaUpdateAvailable.takeUnless {
                event.status == "complete" || event.status == "failed"
            },
        )
        addEvent("LIVE", "OTA ${event.status.ifBlank { "status" }} ${event.overallPercent}%")
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
            }
            StreamState.STOPPED,
            StreamState.STOPPING,
            StreamState.RECONNECT_FAILED,
            StreamState.ERROR -> {
                stopPreviewHealthPoll()
                stopDirectStreamFrameWatchdog()
                activeStreamId = null
                state = state.copy(
                    streamRequested = false,
                    streamPreviewReady = false,
                    streamResolvedConfig = null,
                    streamStartedAt = null,
                )
                if (state.directStreamReceiverRunning) {
                    stopDirectPhoneStreamReceiver("WebRTC direct phone stopped")
                }
            }
        }
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
        mentraBluetoothSdk.setMicState(enabled = true, useGlassesMic = true)
        startMicElapsedTimer()
    }

    private fun stopMicRecording() {
        if (isGlassesConnected()) {
            mentraBluetoothSdk.setMicState(enabled = false)
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
                micPlaybackHint = "No speech audio captured. Keep the glasses connected, speak while recording, and try again.",
            )
            addEvent("LIVE", "microphone stopped with no PCM data")
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
            ?: state.bluetoothStatus?.defaultDevice?.address

    private fun currentTargetName(): String? =
        state.selectedDiscoveredDevice?.name
            ?: state.bluetoothStatus?.defaultDevice?.name
            ?: connectedGlassesInfo(state.glassesStatus)?.bluetoothName
            ?: connectedGlassesInfo(state.glassesStatus)?.serialNumber

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
                            val bytes = Regex("\"bytes\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)?.toIntOrNull()
                            val contentType = Regex("\"contentType\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                            val uploadedAt = Regex("\"uploadedAt\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                            scope.launch {
                                state = state.copy(
                                    photoPreviewDetails = state.photoPreviewDetails.copyForUpload(
                                        byteCount = bytes,
                                        contentType = contentType,
                                        previewUrl = photoUrl,
                                        requestId = requestId,
                                        source = "Cloud server",
                                        uploadedAt = uploadedAt,
                                    ),
                                    photoPreviewUrl = photoUrl,
                                    cameraStatus = "Camera: loaded photo preview",
                                )
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

fun disconnectedGlassesStatus(status: GlassesRuntimeState?): GlassesRuntimeState? =
    status?.let { GlassesRuntimeState.Disconnected() }

val photoSizeOptions = listOf("small", "medium", "large", "full")
val photoCompressionOptions = listOf("none", "medium", "heavy")

fun roiPositionLabel(roiPosition: Int): String =
    cameraRoiPositions.firstOrNull { it.second == roiPosition }?.first ?: "Center"

fun cameraSdkCall(
    size: String,
    compression: String,
    exposureManual: Boolean,
    exposureTimeNs: Int,
    iso: Int,
    cameraFov: Int,
    cameraRoiPosition: Int,
): String = """
val cameraFovResult = mentraBluetoothSdk.setCameraFov(
    CameraFov(fov = $cameraFov, roiPosition = CameraRoiPosition.fromValue($cameraRoiPosition))
)
println("Camera ready at ${'$'}{cameraFovResult.fov}°")
val photo = mentraBluetoothSdk.requestPhoto(
    PhotoRequest(
      requestId = requestId,
      appId = "com.mentra.examples.android",
      size = PhotoSize.${size.uppercase(Locale.US)},
      webhookUrl = uploadUrl,
      compress = PhotoCompression.${compression.uppercase(Locale.US)},
      sound = true,
      exposureTimeNs = ${if (exposureManual) exposureTimeNs else "null"},
      iso = ${if (exposureManual) iso else "null"},
    )
)
println("Photo delivered: ${'$'}{photo.response.requestId}")
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

fun describeSettingsAck(ack: SettingsAckEvent): String =
    listOfNotNull(
        "${ack.setting} ${ack.status}",
        if (ack.ready) "ready" else "not ready",
        ack.values.intValue("fov")?.let { "fov=$it" },
        ack.values.intValue("roiPosition")?.let { "roi=$it" },
        ack.errorCode,
    ).joinToString(" ")

fun describeCameraFovResult(result: CameraFovResult): String =
    "ready fov=${result.fov} roi=${result.roiPosition.label} request=${result.requestId}"

private fun Map<String, Any>.stringValue(key: String): String? =
    this[key] as? String

private fun Map<String, Any>.intValue(key: String): Int? =
    (this[key] as? Number)?.toInt()

private fun Map<String, Any>.longValue(key: String): Long? =
    (this[key] as? Number)?.toLong()

fun summarize(status: GlassesRuntimeState): String =
    listOfNotNull(
        "connection: ${status.connection.value}",
        "ready: ${status.ready}",
        status.battery?.level?.let { "batteryLevel: $it" },
        status.wifi?.let { "wifi: ${wifiSummary(it)}" },
        status.hotspot?.let { "hotspot: ${hotspotSummary(it)}" },
        status.signal?.strengthDbm?.let { "signalStrength: $it" },
        status.signal?.updatedAt?.let { "RSSI updated: ${formatTime(it)}" },
    ).take(3).joinToString(", ")

fun summarize(status: PhoneSdkRuntimeState): String =
    listOfNotNull(
        "searching: ${status.searching}",
        "wifiScanResults: ${status.wifiScanResults.size}",
        "galleryModeEnabled: ${status.galleryMode.enabled}",
        status.defaultDevice?.let { "defaultDevice: ${it.name}" },
    ).take(3).joinToString(", ")

fun stringValue(values: Map<String, Any>, key: String): String? =
    (values[key] as? String)?.takeIf { it.isNotBlank() }

fun intValue(values: Map<String, Any>, key: String): Int? =
    when (val value = values[key]) {
        is Int -> value
        is Number -> value.toInt()
        else -> null
    }

fun boolValue(values: Map<String, Any>, key: String): Boolean? = values[key] as? Boolean

fun galleryModeEnabled(status: PhoneSdkRuntimeState?): Boolean = status?.galleryMode?.enabled ?: false

fun connectionLabel(status: GlassesRuntimeState?): String =
    status?.connection?.value
        ?: if (isGlassesConnected(status)) "CONNECTED" else "WAITING"

fun isGlassesConnected(status: GlassesRuntimeState?): Boolean = status?.connected == true

val GlassesRuntimeState.battery: GlassesBatteryState?
    get() = (this as? GlassesRuntimeState.Connected)?.battery

val GlassesRuntimeState.firmware
    get() = (this as? GlassesRuntimeState.Connected)?.firmware

val GlassesRuntimeState.hotspot: HotspotStatus?
    get() = (this as? GlassesRuntimeState.Connected)?.hotspot

val GlassesRuntimeState.signal
    get() = (this as? GlassesRuntimeState.Connected)?.signal

val GlassesRuntimeState.wifi: WifiStatus?
    get() = (this as? GlassesRuntimeState.Connected)?.wifi

fun connectedGlassesInfo(status: GlassesRuntimeState?) =
    (status as? GlassesRuntimeState.Connected)?.device

fun deviceLabel(status: GlassesRuntimeState?): String =
    connectedGlassesInfo(status)?.bluetoothName
        ?: connectedGlassesInfo(status)?.serialNumber
        ?: connectedGlassesInfo(status)?.deviceModel?.let { deviceModelLabel(it) }
        ?: "Mentra Live"

fun supportsDisplay(status: GlassesRuntimeState?): Boolean {
    val model = listOfNotNull(
        connectedGlassesInfo(status)?.deviceModel?.deviceType,
        connectedGlassesInfo(status)?.bluetoothName,
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

fun modelLabel(status: GlassesRuntimeState?): String =
    connectedGlassesInfo(status)?.deviceModel?.let { deviceModelLabel(it) } ?: "Mentra Live"

fun batteryLevel(status: GlassesRuntimeState?): Int? {
    val level = status?.battery?.level ?: return null
    return if (level < 0 || !isGlassesConnected(status)) null else level.coerceAtMost(100)
}

fun batteryLabel(status: GlassesRuntimeState?): String =
    batteryLevel(status)?.let { "$it%${if (status?.battery?.charging == true) " charging" else ""}" }
        ?: if (status?.connected == false || status?.connection == GlassesConnectionState.DISCONNECTED) "Not connected" else "Waiting for status"

fun wifiLabel(status: GlassesRuntimeState?): String =
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

fun isGlassesWifiConnected(status: GlassesRuntimeState?): Boolean =
    connectedWifiStatus(status) != null

fun isDisplayableOtaStatus(status: OtaStatusEvent): Boolean =
    status.status != "idle" || !status.errorMessage.isNullOrBlank()

fun connectedWifiStatus(status: GlassesRuntimeState?): WifiStatus.Connected? =
    status?.wifi as? WifiStatus.Connected

fun enabledHotspotStatus(status: GlassesRuntimeState?): HotspotStatus.Enabled? =
    status?.hotspot as? HotspotStatus.Enabled

fun hotspotLabel(status: GlassesRuntimeState?, fallbackEnabled: Boolean): String {
    val hotspot = enabledHotspotStatus(status)
    if (hotspot != null) {
        return "${hotspot.ssid} · ${hotspot.localIp}"
    }
    return if (status == null && fallbackEnabled) "waiting for SSID" else "disabled"
}

fun galleryServerUrl(status: GlassesRuntimeState?, fallbackEnabled: Boolean): String? {
    val hotspot = enabledHotspotStatus(status)
    if (hotspot == null && !(status == null && fallbackEnabled)) {
        return null
    }
    val gateway = hotspot?.localIp ?: "192.168.43.1"
    return "http://$gateway:8089"
}

fun galleryHotspotSsidLabel(status: GlassesRuntimeState?): String {
    val ssid = enabledHotspotStatus(status)?.ssid
    return if (ssid == null) "the glasses hotspot" else "Wi-Fi $ssid"
}

fun galleryHotspotPasswordLabel(status: GlassesRuntimeState?): String =
    enabledHotspotStatus(status)?.password
        ?: MENTRA_LIVE_DEFAULT_HOTSPOT_PASSWORD

fun firmwareLabel(status: GlassesRuntimeState?): String =
    status?.firmware?.version ?: "Unknown"

fun firmwareSubLabel(status: GlassesRuntimeState?): String {
    val firmware = status?.firmware
    val appVersion = firmware?.appVersion
    return when {
        firmware?.source?.name == "FIRMWARE" -> "reported"
        firmware?.source?.name == "BES" -> "BES firmware"
        firmware?.source?.name == "MTK" -> "MTK firmware"
        appVersion != null -> "ASG app $appVersion"
        else -> "not reported"
    }
}

fun rssiLabel(status: GlassesRuntimeState?): String =
    status?.signal?.strengthDbm?.let { "$it dBm" } ?: "Unknown"

fun rssiUpdatedLabel(status: GlassesRuntimeState?): String =
    status?.signal?.updatedAt?.let { "updated ${formatTime(it)}" } ?: "signal"

private fun PhotoPreviewDetails?.copyForAck(
    requestId: String,
    source: String,
    timestamp: Long,
    uploadUrl: String,
): PhotoPreviewDetails =
    (this ?: PhotoPreviewDetails(source = source, state = "acknowledged")).copy(
        requestId = requestId,
        source = source,
        state = if (this?.state == "preview") "preview" else "acknowledged",
        timestamp = timestamp,
        uploadUrl = uploadUrl,
    )

private fun PhotoPreviewDetails?.copyForUpload(
    byteCount: Int? = null,
    contentType: String? = null,
    height: Int? = null,
    previewUrl: String,
    requestId: String?,
    source: String,
    uploadedAt: String? = null,
    width: Int? = null,
): PhotoPreviewDetails =
    (this ?: PhotoPreviewDetails(source = source, state = "preview")).copy(
        byteCount = byteCount ?: this?.byteCount,
        contentType = contentType ?: this?.contentType,
        height = height ?: this?.height,
        previewUrl = previewUrl,
        requestId = requestId ?: this?.requestId,
        source = source,
        state = "preview",
        uploadedAt = uploadedAt ?: this?.uploadedAt,
        width = width ?: this?.width,
    )

private fun imageDimensions(file: File): Pair<Int, Int>? {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, options)
    return if (options.outWidth > 0 && options.outHeight > 0) {
        options.outWidth to options.outHeight
    } else {
        null
    }
}

private fun formatTime(timestampMs: Long): String =
    SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(timestampMs))

fun bluetoothSearchLabel(status: PhoneSdkRuntimeState?): String {
    val searching = status?.searching == true
    return if (searching) "Scanning" else "Idle"
}

fun discoveredDeviceKey(device: Device): String =
    device.id

fun deviceModelLabel(model: DeviceModel): String =
    when (model) {
        DeviceModel.MENTRA_LIVE -> "Mentra Live"
        DeviceModel.G2 -> "Even G2"
        DeviceModel.G1 -> "Even G1"
        DeviceModel.MENTRA_NEX -> "Mentra Nex"
        DeviceModel.MACH1 -> "Mach1"
        DeviceModel.Z100 -> "Z100"
        DeviceModel.FRAME -> "Frame"
        DeviceModel.R1 -> "R1"
        DeviceModel.SIMULATED -> "Simulated"
    }

fun targetDeviceDetail(device: Device): String =
    device.rssi?.let { "${device.model.deviceType} · $it dBm" } ?: device.model.deviceType

fun connectionTargetLabel(state: MentraExampleState, status: GlassesRuntimeState?): String =
    when {
        isGlassesConnected(status) -> state.bluetoothStatus?.defaultDevice?.name ?: deviceLabel(status)
        state.selectedDiscoveredDevice != null -> state.selectedDiscoveredDevice.name
        state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus) -> savedConnectionTargetName(state.bluetoothStatus)
        state.discoveredDevices.isNotEmpty() -> "Choose a discovered device"
        else -> "Scan required"
    }

fun canConnectTarget(state: MentraExampleState): Boolean =
    state.selectedDiscoveredDevice != null ||
        (state.discoveredDevices.isEmpty() && hasSavedConnectionTarget(state.bluetoothStatus))

fun hasSavedConnectionTarget(status: PhoneSdkRuntimeState?): Boolean =
    status?.defaultDevice != null

fun savedConnectionTargetName(status: PhoneSdkRuntimeState?): String =
    status?.defaultDevice?.name ?: "Saved glasses"

fun savedConnectionTargetDetail(status: PhoneSdkRuntimeState?): String {
    val model = status?.defaultDevice?.model?.deviceType ?: "Saved model"
    return "$model · mentraBluetoothSdk.connectDefault()"
}

fun wifiScanResults(status: PhoneSdkRuntimeState?): List<WifiScanResult> =
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
