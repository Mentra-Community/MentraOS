package com.mentra.bluetoothsdk

import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.mentra.bluetoothsdk.controllers.ControllerManager
import com.mentra.bluetoothsdk.controllers.R1
import com.mentra.bluetoothsdk.services.ForegroundService
import com.mentra.bluetoothsdk.services.PhoneMic
import com.mentra.bluetoothsdk.sgcs.Ar99
import com.mentra.bluetoothsdk.sgcs.G1
import com.mentra.bluetoothsdk.sgcs.G2
import com.mentra.bluetoothsdk.sgcs.SceneElement
import com.mentra.bluetoothsdk.sgcs.SceneFrame
import com.mentra.bluetoothsdk.sgcs.Mach1
import com.mentra.bluetoothsdk.sgcs.MentraLive
import com.mentra.bluetoothsdk.sgcs.MentraNex
import com.mentra.bluetoothsdk.sgcs.Nimo
import com.mentra.bluetoothsdk.sgcs.SGCManager
import com.mentra.bluetoothsdk.sgcs.Simulated
import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.MicMap
import com.mentra.bluetoothsdk.utils.MicTypes
import com.mentra.bluetoothsdk.utils.PhoneAudioMonitor
import com.mentra.lc3Lib.Lc3Cpp
import com.mentra.bluetoothsdk.stt.SherpaOnnxTranscriber
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.jvm.JvmStatic

class DeviceManager {
    companion object {

        @Volatile
        private var _instance: DeviceManager? = null

        @JvmStatic
        fun getInstance(): DeviceManager {
            return _instance
                ?: synchronized(this) { _instance ?: DeviceManager().also { _instance = it } }
        }
    }

    // MARK: - Unique (Android)
    private var serviceStarted = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private var sendStateWorkItem: Runnable? = null
    private var phoneMic: PhoneMic? = null

    // Track last known permissions
    private var lastHadBluetoothPermission = false
    private var lastHadMicrophonePermission = false
    private var permissionReceiver: BroadcastReceiver? = null
    private val handler = Handler(Looper.getMainLooper())
    private var permissionCheckRunnable: Runnable? = null

    // Bluetooth adapter state monitoring (detects BT toggle from control center)
    private var bluetoothStateReceiver: BroadcastReceiver? = null
    private var isBluetoothStateReceiverRegistered = false

    // MARK: - End Unique

    // MARK: - Properties
    var sgc: SGCManager? = null
    var controller: ControllerManager? = null

    // settings:
    private var defaultWearable: String
        get() = DeviceStore.store.get("bluetooth", "default_wearable") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "default_wearable", value)

    private var pendingWearable: String
        get() = DeviceStore.store.get("bluetooth", "pending_wearable") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "pending_wearable", value)

    public var deviceName: String
        get() = DeviceStore.store.get("bluetooth", "device_name") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "device_name", value)

    public var deviceAddress: String
        get() = DeviceStore.store.get("bluetooth", "device_address") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "device_address", value)

    private var defaultController: String
        get() = DeviceStore.store.get("bluetooth", "default_controller") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "default_controller", value)

    private var pendingController: String
        get() = DeviceStore.store.get("bluetooth", "pending_controller") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "pending_controller", value)

    private var controllerDeviceName: String
        get() = DeviceStore.store.get("bluetooth", "controller_device_name") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "controller_device_name", value)

    private var searchingController: Boolean
        get() = DeviceStore.store.get("bluetooth", "searchingController") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "searchingController", value)

    private var screenDisabled: Boolean
        get() = DeviceStore.store.get("bluetooth", "screen_disabled") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "screen_disabled", value)

    private var preferredMic: String
        get() = DeviceStore.store.get("bluetooth", "preferred_mic") as? String ?: "auto"
        set(value) = DeviceStore.apply("bluetooth", "preferred_mic", value)

    private var autoBrightness: Boolean
        get() = DeviceStore.store.get("bluetooth", "auto_brightness") as? Boolean ?: true
        set(value) = DeviceStore.apply("bluetooth", "auto_brightness", value)

    private var brightness: Int
        get() = DeviceStore.store.get("bluetooth", "brightness") as? Int ?: 50
        set(value) = DeviceStore.apply("bluetooth", "brightness", value)

    private var headUpAngle: Int
        get() = DeviceStore.store.get("bluetooth", "head_up_angle") as? Int ?: 30
        set(value) = DeviceStore.apply("bluetooth", "head_up_angle", value)

    private var sensingEnabled: Boolean
        get() = DeviceStore.store.get("bluetooth", "sensing_enabled") as? Boolean ?: true
        set(value) = DeviceStore.apply("bluetooth", "sensing_enabled", value)

    public var powerSavingMode: Boolean
        get() = DeviceStore.store.get("bluetooth", "power_saving_mode") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "power_saving_mode", value)

    // Phone-side VAD gating switch. Default is OFF (VAD runs) so the
    // coordinator can drive per-utterance offline/online STT switching from
    // `vad_status` events. Set to `true` only as an emergency kill-switch.
    private var bypassVad: Boolean
        get() = DeviceStore.store.get("bluetooth", "bypass_vad") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "bypass_vad", value)

    private var localSttFallbackActive: Boolean
        get() = DeviceStore.store.get("bluetooth", "local_stt_fallback_active") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "local_stt_fallback_active", value)

    private var shouldSendPcm: Boolean
        get() = DeviceStore.store.get("bluetooth", "should_send_pcm") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "should_send_pcm", value)

    private var shouldSendLc3: Boolean
        get() = DeviceStore.store.get("bluetooth", "should_send_lc3") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "should_send_lc3", value)

    private var shouldSendTranscript: Boolean
        get() = DeviceStore.store.get("bluetooth", "should_send_transcript") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "should_send_transcript", value)

    private var contextualDashboard: Boolean
        get() = DeviceStore.store.get("bluetooth", "contextual_dashboard") as? Boolean ?: true
        set(value) = DeviceStore.apply("bluetooth", "contextual_dashboard", value)

    private var dashboardHeight: Int
        get() = (DeviceStore.store.get("bluetooth", "dashboard_height") as? Number)?.toInt() ?: 4
        set(value) = DeviceStore.apply("bluetooth", "dashboard_height", value)

    private var dashboardDepth: Int
        get() = (DeviceStore.store.get("bluetooth", "dashboard_depth") as? Number)?.toInt() ?: 2
        set(value) = DeviceStore.apply("bluetooth", "dashboard_depth", value)

    private var galleryMode: Boolean
        get() = DeviceStore.store.get("bluetooth", "gallery_mode") as? Boolean ?: true
        set(value) = DeviceStore.apply("bluetooth", "gallery_mode", value)

    // state:
    private var searching: Boolean
        get() = DeviceStore.store.get("bluetooth", "searching") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "searching", value)

    private var glassesBluetoothClassicConnected: Boolean
        get() = DeviceStore.store.get("glasses", "bluetoothClassicConnected") as? Boolean ?: false
        set(value) = DeviceStore.apply("glasses", "bluetoothClassicConnected", value)

    public var micRanking: MutableList<String>
        get() =
            (DeviceStore.store.get("bluetooth", "micRanking") as? List<*>)
                ?.mapNotNull { it as? String }
                ?.toMutableList()
                ?: MicMap.map["auto"]?.toMutableList() ?: mutableListOf()
        set(value) = DeviceStore.apply("bluetooth", "micRanking", value)

    private var shouldSendBootingMessage: Boolean
        get() = DeviceStore.store.get("bluetooth", "shouldSendBootingMessage") as? Boolean ?: true
        set(value) = DeviceStore.apply("bluetooth", "shouldSendBootingMessage", value)

    // Guard against duplicate ready callbacks firing back-to-back.
    private var lastReadyHandledAtMs: Long = 0L
    private var lastReadyHandledKey: String = ""
    private var lastSystemTimeSyncConnectionKey: String = ""

    private var systemMicUnavailable: Boolean
        get() = DeviceStore.store.get("bluetooth", "systemMicUnavailable") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "systemMicUnavailable", value)

    public var headUp: Boolean
        get() = DeviceStore.store.get("glasses", "headUp") as? Boolean ?: false
        set(value) = DeviceStore.apply("glasses", "headUp", value)

    private var micEnabled: Boolean
        get() = DeviceStore.store.get("bluetooth", "micEnabled") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "micEnabled", value)

    private var currentMic: String
        get() = DeviceStore.store.get("bluetooth", "currentMic") as? String ?: ""
        set(value) = DeviceStore.apply("bluetooth", "currentMic", value)

    private var searchResults: List<Any>
        get() = DeviceStore.store.get("bluetooth", "searchResults") as? List<Any> ?: emptyList()
        set(value) = DeviceStore.apply("bluetooth", "searchResults", value)

    private var wifiScanResults: List<Any>
        get() = DeviceStore.store.get("bluetooth", "wifiScanResults") as? List<Any> ?: emptyList()
        set(value) = DeviceStore.apply("bluetooth", "wifiScanResults", value)

    private var lastLog: MutableList<String>
        get() = DeviceStore.store.get("bluetooth", "lastLog") as? MutableList<String> ?: mutableListOf()
        set(value) = DeviceStore.apply("bluetooth", "lastLog", value)

    // LC3 Audio Encoding
    // Audio output format enum
    enum class AudioOutputFormat {
        LC3,
        PCM
    }

    // Canonical LC3 config: 16kHz sample rate, 10ms frame duration
    // Frame size is configurable: 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps)
    private var lc3EncoderPtr: Long = 0
    private var lc3DecoderPtr: Long = 0
    private val lc3Lock = Any()

    // Audio output format - defaults to LC3 for bandwidth savings
    private var audioOutputFormat: AudioOutputFormat = AudioOutputFormat.LC3
    private var lastLc3Event: Long? = null
    private var micReinitRunnable: Runnable? = null
    private var systemMicAvailabilityRecheckRunnable: Runnable? = null

    // VAD
    private val vadBuffer = mutableListOf<ByteArray>()
    private var isSpeaking = false
    private var vadPolicy: com.mentra.bluetoothsdk.stt.VadGateSpeechPolicy? = null

    // STT
    private var transcriber: SherpaOnnxTranscriber? = null

    // View states
    private val viewStates = mutableListOf<ViewState>()

    init {
        Bridge.log("DeviceManager: init()")
        initializeViewStates()
        startForegroundService()
        // setupPermissionMonitoring()
        setupBluetoothStateMonitoring()
        phoneMic = PhoneMic.getInstance()
        // Sherpa is intentionally lazy. Initializing it during app startup
        // competes with Cloud V2 captions even when cloud transcription is
        // healthy; start it only when offline/local transcription is requested.

        // Initialize LC3 encoder/decoder for unified audio encoding
        try {
            Lc3Cpp.init()
            lc3EncoderPtr = Lc3Cpp.initEncoder()
            lc3DecoderPtr = Lc3Cpp.initDecoder()
            Bridge.log("LC3 encoder/decoder initialized successfully")
        } catch (e: Exception) {
            Bridge.log("Failed to initialize LC3 encoder/decoder: ${e.message}")
            lc3EncoderPtr = 0
            lc3DecoderPtr = 0
        }

        // Initialize phone-side Silero VAD. Used by handlePcm to gate audio
        // fan-out and to drive per-utterance offline/online STT switching
        // (see LocalSttFallbackCoordinator on the JS side). If a previous
        // policy somehow exists (re-init on hot reload), stop it first to
        // release the ONNX session.
        try {
            vadPolicy?.stop()
            val ctx = Bridge.getContext()
            val policy = com.mentra.bluetoothsdk.stt.VadGateSpeechPolicy(ctx)
            policy.init(blockSizeSamples = 512)
            policy.onSpeechStateChanged = { speaking ->
                isSpeaking = speaking
                Bridge.sendVoiceActivityDetectionStatus(speaking)
            }
            vadPolicy = policy
            Bridge.log("VadGateSpeechPolicy initialized")
        } catch (e: Exception) {
            Bridge.log("Failed to initialize VadGateSpeechPolicy: ${e.message}")
            vadPolicy = null
        } catch (e: LinkageError) {
            Bridge.log("Failed to initialize VadGateSpeechPolicy: ${e.message}")
            vadPolicy = null
        }

        // Mic reinit check every 10 seconds
        val micReinitR =
            object : Runnable {
                override fun run() {
                    checkAndReinitGlassesMic()
                    mainHandler.postDelayed(this, 10_000)
                }
            }
        micReinitRunnable = micReinitR
        mainHandler.postDelayed(micReinitR, 10_000)
    }

    private fun checkAndReinitGlassesMic() {
        // if the glasses mic is marked as enabled (and the glasses are connected), but our last known lc3 event is from > 5 seconds ago, reinitialize the mic:
        val glassesMicEnabled = DeviceStore.get("glasses", "micEnabled") as? Boolean ?: false
        val glassesConnected = DeviceStore.get("glasses", "connected") as? Boolean ?: false
        if (!glassesMicEnabled || !glassesConnected) {
            return
        }

        if (sgc?.isMicSuspendedForAudio == true) {
            Bridge.log("MAN: Glasses mic intentionally suspended for phone audio; skipping mic recovery")
            return
        }

        if (PhoneAudioMonitor.getInstance(Bridge.getContext()).isOwnAppAudioPlaying()) {
            Bridge.log("MAN: Mentra audio is playing; skipping glasses mic recovery")
            return
        }

        // When no frame has ever been received, treat elapsed as "forever" so we
        // actually attempt recovery (was 0 before, which made the watchdog a no-op).
        val timeSinceLastLc3Event = System.currentTimeMillis() - (lastLc3Event ?: 0L)
        if (timeSinceLastLc3Event > 5000) {
            Bridge.log("MAN: No audio activity in the last 5 seconds from glasses, reinitializing glasses mic")
            sgc?.setMicEnabled(true)
        }
    }

    private fun scheduleSystemMicAvailabilityRecheck(reason: String) {
        if (systemMicAvailabilityRecheckRunnable != null) {
            return
        }

        val recheck =
            object : Runnable {
                override fun run() {
                    systemMicAvailabilityRecheckRunnable = null

                    if (!micEnabled || !systemMicUnavailable) {
                        return
                    }

                    val stillBlocked = phoneMic?.hasBlockingMicInterruption() ?: true
                    if (stillBlocked) {
                        scheduleSystemMicAvailabilityRecheck(reason)
                        return
                    }

                    systemMicUnavailable = false
                    Bridge.log("MAN: MIC_UNAVAILABLE: FALSE recheck_after_$reason")
                    appendLog("MAN: MIC_UNAVAILABLE: FALSE recheck_after_$reason")
                    updateMicState()
                }
            }

        systemMicAvailabilityRecheckRunnable = recheck
        mainHandler.postDelayed(recheck, 2_000)
    }

    // MARK: - Unique (Android)
    private fun setupPermissionMonitoring() {
        val context = Bridge.getContext()

        // Store initial permission state
        lastHadBluetoothPermission = checkBluetoothPermission(context)
        lastHadMicrophonePermission = checkMicrophonePermission(context)

        Bridge.log(
            "MAN: Initial permissions - BT: $lastHadBluetoothPermission, Mic: $lastHadMicrophonePermission"
        )

        // Create receiver for package changes (fires when permissions change)
        permissionReceiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    if (intent?.action == Intent.ACTION_PACKAGE_CHANGED &&
                        intent.data?.schemeSpecificPart == context?.packageName
                    ) {

                        Bridge.log("MAN: Package changed, checking permissions...")
                        checkPermissionChanges()
                    }
                }
            }

        // Register the receiver
        try {
            val filter =
                IntentFilter().apply {
                    addAction(Intent.ACTION_PACKAGE_CHANGED)
                    addDataScheme("package")
                }
            context.registerReceiver(permissionReceiver, filter)
            Bridge.log("MAN: Permission monitoring started")
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to register permission receiver: ${e.message}")
        }

        // Also set up a periodic check as backup (some devices don't fire PACKAGE_CHANGED reliably)
        // startPeriodicPermissionCheck()
    }

    private fun startPeriodicPermissionCheck() {
        permissionCheckRunnable =
            object : Runnable {
                override fun run() {
                    checkPermissionChanges()
                    handler.postDelayed(this, 10000) // Check every 10 seconds
                }
            }
        handler.postDelayed(permissionCheckRunnable!!, 10000)
    }

    private fun checkPermissionChanges() {
        val context = Bridge.getContext()

        val currentHasBluetoothPermission = checkBluetoothPermission(context)
        val currentHasMicrophonePermission = checkMicrophonePermission(context)

        var permissionsChanged = false

        if (currentHasBluetoothPermission != lastHadBluetoothPermission) {
            Bridge.log(
                "MAN: Bluetooth permission changed: $lastHadBluetoothPermission -> $currentHasBluetoothPermission"
            )
            lastHadBluetoothPermission = currentHasBluetoothPermission
            permissionsChanged = true
        }

        if (currentHasMicrophonePermission != lastHadMicrophonePermission) {
            Bridge.log(
                "MAN: Microphone permission changed: $lastHadMicrophonePermission -> $currentHasMicrophonePermission"
            )
            lastHadMicrophonePermission = currentHasMicrophonePermission
            permissionsChanged = true
        }

        if (permissionsChanged && !currentHasBluetoothPermission) {
            Bridge.log("MAN: Bluetooth permission revoked disconnecting glasses")
            disconnect()
        }

        if (permissionsChanged && serviceStarted) {
            Bridge.log("MAN: Permissions changed, restarting service")
            restartForegroundService()
        }
    }

    private fun checkBluetoothPermission(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val connect = ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
            val scan = ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.BLUETOOTH_SCAN
            ) == PackageManager.PERMISSION_GRANTED
            connect && scan
        } else {
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.BLUETOOTH) ==
                PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasBluetoothPermissions(): Boolean {
        return checkBluetoothPermission(Bridge.getContext())
    }

    private fun checkMicrophonePermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun setupBluetoothStateMonitoring() {
        val context = Bridge.getContext()

        bluetoothStateReceiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return

                    val state =
                        intent.getIntExtra(
                            BluetoothAdapter.EXTRA_STATE,
                            BluetoothAdapter.ERROR
                        )
                    when (state) {
                        BluetoothAdapter.STATE_OFF -> {
                            Bridge.log("MAN: Bluetooth turned OFF (control center or settings)")
                            disconnect()
                        }

                        BluetoothAdapter.STATE_TURNING_OFF -> {
                            Bridge.log("MAN: Bluetooth turning off...")
                        }

                        BluetoothAdapter.STATE_ON -> {
                            Bridge.log("MAN: Bluetooth turned ON")
                            // Auto-reconnect to last known device if we have one
                            if (defaultWearable.isNotEmpty() && deviceName.isNotEmpty()) {
                                Bridge.log(
                                    "MAN: Bluetooth restored, attempting reconnect to: $deviceName"
                                )
                                handler.postDelayed(
                                    { connectDefault() },
                                    2000
                                ) // Small delay to let BT stack stabilize
                            }
                        }

                        BluetoothAdapter.STATE_TURNING_ON -> {
                            Bridge.log("MAN: Bluetooth turning on...")
                        }
                    }
                }
            }

        try {
            val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
            context.registerReceiver(bluetoothStateReceiver, filter)
            isBluetoothStateReceiverRegistered = true
            Bridge.log("MAN: Bluetooth state monitoring started")
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to register Bluetooth state receiver: ${e.message}")
        }
    }

    private fun stopBluetoothStateMonitoring() {
        if (isBluetoothStateReceiverRegistered && bluetoothStateReceiver != null) {
            try {
                Bridge.getContext().unregisterReceiver(bluetoothStateReceiver)
            } catch (e: Exception) {
                Bridge.log("MAN: Error unregistering Bluetooth state receiver: ${e.message}")
            }
            isBluetoothStateReceiverRegistered = false
        }
    }

    private fun startForegroundService() {
        val context = Bridge.getContext()

        try {
            Bridge.log("MAN: Starting foreground service")
            val serviceIntent = Intent(context, ForegroundService::class.java)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }

            serviceStarted = true
            Bridge.log("MAN: Foreground service started")
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to start service: ${e.message}")
        }
    }

    /**
     * Re-evaluate the active foreground-service types while the host Activity is visible.
     *
     * Location is a while-in-use permission, so Android 14+ only allows the service to add
     * the location type from the foreground. Sending a command to the existing service
     * updates its type mask without tearing down the glasses connection.
     */
    fun refreshForegroundServiceTypes() {
        val context = Bridge.getContext()

        try {
            Bridge.log("MAN: Refreshing foreground service types")
            val serviceIntent =
                Intent(context, ForegroundService::class.java).apply {
                    action = ForegroundService.ACTION_REFRESH_TYPES
                }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }

            serviceStarted = true
            Bridge.log("MAN: Foreground service types refreshed")
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to refresh foreground service types: ${e.message}")
        }
    }

    private fun restartForegroundService() {
        val context = Bridge.getContext()

        try {
            // Stop the service
            val stopIntent = Intent(context, ForegroundService::class.java)
            context.stopService(stopIntent)

            // Small delay
            Thread.sleep(100)

            // Start it again with new permissions
            val startIntent = Intent(context, ForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(startIntent)
            } else {
                context.startService(startIntent)
            }

            Bridge.log("MAN: Service restarted with updated permissions")
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to restart service: ${e.message}")
        }
    }

    private fun initializeViewStates() {
        viewStates.clear()

        // Matching Swift's 4 view states exactly
        viewStates.add(ViewState(" ", " ", " ", "text_wall", "", null, null))
        viewStates.add(
            ViewState(
                " ",
                " ",
                " ",
                "text_wall",
                "\$TIME12$ \$DATE$ \$GBATT$ \$CONNECTION_STATUS$",
                null,
                null
            )
        )
        viewStates.add(ViewState(" ", " ", " ", "text_wall", "", null, null))
        viewStates.add(
            ViewState(
                " ",
                " ",
                " ",
                "text_wall",
                "\$TIME12$ \$DATE$ \$GBATT$ \$CONNECTION_STATUS$",
                null,
                null
            )
        )
    }

    private fun statesEqual(s1: ViewState, s2: ViewState): Boolean {
        val state1 =
            "${s1.layoutType}${s1.text}${s1.topText}${s1.bottomText}${s1.title}${s1.data ?: ""}"
        val state2 =
            "${s2.layoutType}${s2.text}${s2.topText}${s2.bottomText}${s2.title}${s2.data ?: ""}"
        return state1 == state2
    }

    private fun Map<String, Any>.getString(key: String, defaultValue: String): String {
        return (this[key] as? String) ?: defaultValue
    }

    // Inner classes

    data class ViewState(
        var topText: String,
        var bottomText: String,
        var title: String,
        var layoutType: String,
        var text: String,
        var data: String?,
        var animationData: Map<String, Any>?,
        // Optional bitmap_view container position/size (used by G2; ignored by others).
        // Reused by positioned_text for its container rect.
        var bmpX: Int? = null,
        var bmpY: Int? = null,
        var bmpWidth: Int? = null,
        var bmpHeight: Int? = null,
        // Optional positioned_text border (used by G2; ignored by others).
        var borderWidth: Int? = null,
        var borderRadius: Int? = null
    )

    // Scene slots — one whole SceneFrame per view (main/dashboard), parallel to
    // viewStates. When a slot holds a scene, viewStates carries a "scene"
    // sentinel so sendCurrentState routes here. Holding the WHOLE frame keeps
    // native re-dispatch coherent (dashboard exit re-applies a complete scene,
    // not whatever element happened to arrive last).
    private val sceneStates = arrayOfNulls<SceneFrame>(2)
    // MARK: - End Unique

    // MARK: - Voice Data Handling

    private fun convertAndSendMicLc3(pcmData: ByteArray) {
        synchronized(lc3Lock) {
            if (lc3EncoderPtr == 0L) {
                Bridge.log("MAN: ERROR - LC3 encoder not initialized but format is LC3")
                return
            }
            val lc3FrameSize = (DeviceStore.store.get("bluetooth", "lc3_frame_size") as Number).toInt()
            val lc3Data = Lc3Cpp.encodeLC3(lc3EncoderPtr, pcmData, lc3FrameSize)
            if (lc3Data == null || lc3Data.isEmpty()) {
                Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
                return
            }
            Bridge.sendMicLc3(lc3Data)
        }
    }

    private fun handleSendingPcm(pcmData: ByteArray) {
        if (shouldSendPcm) {
            Bridge.sendMicPcm(pcmData)
        }
        if (shouldSendLc3) {
            convertAndSendMicLc3(pcmData)
        }
    }

    /**
     * Marks glasses-mic audio as alive for the 10s reinit watchdog. SGCs that decode
     * audio themselves and feed [handlePcm] directly (e.g. Nimo's Opus path) must call
     * this per uplink packet — otherwise the watchdog keeps re-enabling a working mic.
     */
    fun reportGlassesAudioActivity() {
        lastLc3Event = System.currentTimeMillis()
    }

    /**
     * Handle raw LC3 audio data from glasses. Decodes the glasses LC3, then passes to handlePcm for
     * canonical LC3 encoding. Note: frameSize here is for glasses→phone decoding, NOT for
     * phone→cloud encoding.
     */
    fun handleGlassesMicData(rawLC3Data: ByteArray, frameSize: Int = 40) {
        lastLc3Event = System.currentTimeMillis()
        val pcmData: ByteArray?
        synchronized(lc3Lock) {
            if (lc3DecoderPtr == 0L) {
                Bridge.log("MAN: LC3 decoder not initialized, cannot process glasses audio")
                return
            }

            try {
                // Decode glasses LC3 to PCM (glasses may use different LC3 configs)
                pcmData = Lc3Cpp.decodeLC3(lc3DecoderPtr, rawLC3Data, frameSize)
            } catch (e: Exception) {
                Bridge.log("MAN: Failed to decode glasses LC3: ${e.message}")
                return
            }
        }
        if (pcmData != null && pcmData.isNotEmpty()) {
            // Re-encode to canonical LC3 via handlePcm (outside lock to avoid deadlock)
            handlePcm(pcmData)
        } else {
            Bridge.log("MAN: LC3 decode returned empty data")
        }
    }

    fun handlePcm(pcmData: ByteArray) {
        // Audio always flows. The previous phone-side Silero VAD gate was a
        // bandwidth-saver that ate transcripts when the mic delivered frames
        // not aligned to 512 samples (the case for Android AudioRecord on the
        // phone internal mic) and was never wired up correctly anyway —
        // `bypass_vad_for_debugging` was dead, cloud-side `bypass_vad` was
        // the only knob, and the policy double-VAD'd what the cloud already
        // VADs server-side. VadGateSpeechPolicy is kept around because
        // hardware-side VAD events from the glasses route through the same
        // class to fire `vad_status` (a separate signal the cloud SDK
        // surfaces as `session.audio.isSpeaking`).
        handleSendingPcm(pcmData)
        if (shouldSendTranscript || localSttFallbackActive) {
            if (ensureTranscriberInitialized()) {
                transcriber?.acceptAudio(pcmData)
            }
        }
    }

    // turns a single mic on and turns off all other mics:
    private var isUpdatingMicState = false
    private var pendingMicStateUpdate = false

    internal fun updateMicState() {
        // Guard against re-entrant calls from onRouteChange callbacks
        if (isUpdatingMicState) {
            pendingMicStateUpdate = true
            return
        }
        isUpdatingMicState = true
        pendingMicStateUpdate = false

        try {
            updateMicStateInternal()
        } finally {
            isUpdatingMicState = false
            // If a re-entrant call was requested, run it now
            if (pendingMicStateUpdate) {
                pendingMicStateUpdate = false
                updateMicState()
            }
        }
    }

    private fun updateMicStateInternal() {
        // go through the micRanking and find the first mic that is available:
        var micUsed: String = ""

        // allow the sgc to make changes to the micRanking:
        micRanking = sgc?.sortMicRanking(micRanking) ?: micRanking
        Bridge.log("MAN: updateMicState() micRanking: $micRanking")

        if (micEnabled) {

            for (micMode in micRanking) {
                if (micMode == MicTypes.PHONE_INTERNAL ||
                    micMode == MicTypes.BLUETOOTH_CLASSIC ||
                    micMode == MicTypes.BLUETOOTH
                ) {

                    if (phoneMic?.isRecordingWithMode(micMode) == true) {
                        micUsed = micMode
                        break
                    }

                    if (systemMicUnavailable) {
                        Bridge.log("MAN: systemMicUnavailable, continuing to next mic")
                        continue
                    }

                    // if the phone mic is not recording, start recording:
                    val success = phoneMic?.startMode(micMode) ?: false
                    Bridge.log("MAN: starting mic mode: $micMode -> $success")
                    if (success) {
                        micUsed = micMode
                        break
                    }
                }

                if (micMode == MicTypes.GLASSES_CUSTOM) {
                    if (sgc?.hasMic == true) {
                        // enable the mic if it's not already on:
                        if (sgc?.micEnabled == false) {
                            sgc?.setMicEnabled(true)
                            micUsed = micMode
                            break
                        } else {
                            // the mic is already on, mark it as used and break:
                            micUsed = micMode
                            break
                        }
                    }
                    // if the glasses doesn't have a mic, continue to the next mic:
                    continue
                }
            }
        }

        currentMic = micUsed

        if (micUsed == "" && micEnabled) {
            Bridge.log("MAN: No available mic found!")
            return
        }

        // go through and disable all mics after the first used one:
        val allMics = micRanking
        // add any missing mics to the list:
        for (micMode in MicMap.map["auto"]!!) {
            if (!allMics.contains(micMode)) {
                allMics.add(micMode)
            }
        }
        for (micMode in allMics) {
            if (micMode == micUsed) {
                continue
            }

            if (micMode == MicTypes.PHONE_INTERNAL ||
                micMode == MicTypes.BLUETOOTH_CLASSIC ||
                micMode == MicTypes.BLUETOOTH
            ) {
                phoneMic?.stopMode(micMode)
            }

            if (micMode == MicTypes.GLASSES_CUSTOM && sgc?.hasMic == true && sgc?.micEnabled == true
            ) {
                sgc?.setMicEnabled(false)
            }
        }
    }

    private fun setOnboardMicEnabled(enabled: Boolean) {
        Bridge.log("MAN: setOnboardMicEnabled(): $enabled")
        if (enabled) {
            phoneMic?.startRecording()
        } else {
            phoneMic?.stopRecording()
        }
    }

    fun sendCurrentState() {
        val hUp = DeviceStore.get("glasses", "headUp") as? Boolean ?: false
        // Bridge.log("MAN: sendCurrentState(): $isHeadUp")
        if (screenDisabled) {
            return
        }

        // executor.execute {
        val currentStateIndex = if (hUp && contextualDashboard) 1 else 0
        val currentViewState: ViewState = viewStates[currentStateIndex]

        if (sgc?.type?.contains(DeviceTypes.SIMULATED) == true) {
            // dont send the event to glasses that aren't there:
            return
        }

        var fullyBooted = sgc?.fullyBooted ?: false
        if (!fullyBooted) {
            Bridge.log("MAN: DeviceManager.sendCurrentState(): sgc not ready")
            return
        }

        // Cancel any pending clear display work item
        // sendStateWorkItem?.let { mainHandler.removeCallbacks(it) }

        // Bridge.log("MAN: parsing layoutType: ${currentViewState.layoutType}")
        // Bridge.log(
        //         "MAN: viewState text: '${currentViewState.text}' (len=${currentViewState.text.length})"
        // )

        when (currentViewState.layoutType) {
            "text_wall" -> {
                sgc?.sendTextWall(parsePlaceholders(currentViewState.text))
            }

            "double_text_wall" -> {
                sgc?.sendDoubleTextWall(
                    parsePlaceholders(currentViewState.topText),
                    parsePlaceholders(currentViewState.bottomText)
                )
            }

            "reference_card" -> {
                val title = parsePlaceholders(currentViewState.title)
                val text = parsePlaceholders(currentViewState.text)
                sgc?.sendTextWall("$title\n\n$text")
            }

            "bitmap_view" -> {
                currentViewState.data?.let { data ->
                    sgc?.displayBitmap(
                        data,
                        currentViewState.bmpX,
                        currentViewState.bmpY,
                        currentViewState.bmpWidth,
                        currentViewState.bmpHeight
                    )
                }
            }

            "positioned_text" -> {
                sgc?.sendPositionedText(
                    parsePlaceholders(currentViewState.text),
                    currentViewState.bmpX ?: 0,
                    currentViewState.bmpY ?: 0,
                    currentViewState.bmpWidth ?: 576,
                    currentViewState.bmpHeight ?: 288,
                    currentViewState.borderWidth ?: 0,
                    currentViewState.borderRadius ?: 0
                )
            }

            "scene" -> {
                sceneStates[currentStateIndex]?.let { sgc?.applySceneFrame(it) }
            }

            "clear_view" -> sgc?.clearDisplay()
            else -> Bridge.log("MAN: UNHANDLED LAYOUT_TYPE ${currentViewState.layoutType}")
        }
        // }
    }

    private fun parsePlaceholders(text: String): String {
        if (!text.contains('$')) return text

        val dateFormatter = SimpleDateFormat("M/dd, h:mm", Locale.getDefault())
        val formattedDate = dateFormatter.format(Date())

        val time12Format = SimpleDateFormat("hh:mm", Locale.getDefault())
        val time12 = time12Format.format(Date())

        val time24Format = SimpleDateFormat("HH:mm", Locale.getDefault())
        val time24 = time24Format.format(Date())

        val dateFormat = SimpleDateFormat("MM/dd", Locale.getDefault())
        val currentDate = dateFormat.format(Date())

        val placeholders =
            mapOf(
                "\$no_datetime$" to formattedDate,
                "\$DATE$" to currentDate,
                "\$TIME12$" to time12,
                "\$TIME24$" to time24,
                "\$GBATT$" to
                    (sgc?.batteryLevel?.let { if (it == -1) "" else "$it%" } ?: ""),
                "\$CONNECTION_STATUS$" to "Connected"
            )

        return placeholders.entries.fold(text) { result, (key, value) ->
            result.replace(key, value)
        }
    }

    private fun appendLog(entry: String) {
        lastLog = (lastLog + entry).takeLast(100).toMutableList()
    }

    fun onRouteChange(reason: String, availableInputs: List<String>) {
        Bridge.log("MAN: onRouteChange: reason: $reason")
        Bridge.log("MAN: onRouteChange: inputs: $availableInputs")

        // Handle external app conflicts - automatically switch to glasses mic if available
        when (reason) {
            "external_app_recording" -> {
                // Another app is using the microphone
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE external_app_recording")
                // appendLog("MAN: MIC_UNAVAILABLE: TRUE external_app_recording")
                // scheduleSystemMicAvailabilityRecheck("external_app_recording")
            }

            "audio_focus_available" -> {
                // Audio focus is available again
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE audio_focus_available")
                // appendLog("MAN: MIC_UNAVAILABLE: FALSE audio_focus_available")
            }

            "external_app_stopped" -> {
                // External app stopped recording
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE external_app_stopped")
                // appendLog("MAN: MIC_UNAVAILABLE: FALSE external_app_stopped")
            }

            "phone_call_interruption" -> {
                // Phone call started - mark mic as unavailable
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE phone_call_interruption")
                appendLog("MAN: MIC_UNAVAILABLE: TRUE phone_call_interruption")
                // scheduleSystemMicAvailabilityRecheck("phone_call_interruption")
            }

            "phone_call_ended" -> {
                // Phone call ended - mark mic as available again
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE phone_call_ended")
                // appendLog("MAN: MIC_UNAVAILABLE: FALSE phone_call_ended")
            }

            "phone_call_active" -> {
                // Tried to start recording while phone call already active
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE phone_call_active")
                // appendLog("MAN: MIC_UNAVAILABLE: TRUE phone_call_active")
            }

            "audio_focus_denied" -> {
                // Another app has audio focus
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE audio_focus_denied")
                // appendLog("MAN: MIC_UNAVAILABLE: TRUE audio_focus_denied")
            }

            "permission_denied" -> {
                // Microphone permission not granted
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE permission_denied")
                // appendLog("MAN: MIC_UNAVAILABLE: TRUE permission_denied")
                // Don't trigger fallback - need to request permission from user
            }

            "audio_route_changed" -> {
                // Audio route changed
                // systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN audio_route_changed")
                // appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN audio_route_changed")
            }

            "recording_started" -> {
                // this is an event from the PhoneMic saying we have started recording
                // Audio recording started
                // systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN recording_started")
                // appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN recording_started")
            }

            "recording_stopped" -> {
                // this is an event from the PhoneMic saying we have stopped recording
                // Audio recording stopped
                // systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN recording_stopped")
                // appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN recording_stopped")
            }

            else -> {
                // Other route changes (headset plug/unplug, BT connect/disconnect, etc.)
                // Just log for now - may want to handle these in the future
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN other: $reason")
                // appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN other: $reason")
                // systemMicUnavailable = false
            }
        }

        updateMicState()
    }

    fun onInterruption(began: Boolean) {
        Bridge.log("MAN: Interruption: $began")
        systemMicUnavailable = began
        updateMicState()
    }

    // MARK: - Auxiliary Commands

    fun initSGC(wearable: String) {
        Bridge.log("Initializing manager for wearable: $wearable")
        if (sgc != null && sgc?.type != wearable) {
            Bridge.log("MAN: Manager already initialized, cleaning up previous sgc")
            Bridge.log("MAN: Cleaning up previous sgc type: ${sgc?.type}")
            sgc?.cleanup()
            sgc = null
            lastSystemTimeSyncConnectionKey = ""
        }

        if (sgc != null) {
            Bridge.log("MAN: SGC already initialized")
            return
        }

        if (wearable.contains(DeviceTypes.SIMULATED)) {
            sgc = Simulated()
        } else if (wearable.contains(DeviceTypes.G1)) {
            sgc = G1()
        } else if (wearable.contains(DeviceTypes.G2)) {
            sgc = G2()
        } else if (wearable.contains(DeviceTypes.LIVE)) {
            sgc = MentraLive()
        } else if (wearable.contains(DeviceTypes.NEX)) {
            sgc = MentraNex()
        } else if (wearable.contains(DeviceTypes.AR99)) {
            sgc = Ar99()
        } else if (wearable.contains(DeviceTypes.MACH1)) {
            sgc = createOptionalMach1Sgc(DeviceTypes.MACH1)
        } else if (wearable.contains(DeviceTypes.Z100)) {
            sgc = createOptionalMach1Sgc(DeviceTypes.Z100)
        } else if (wearable.contains(DeviceTypes.NIMO)) {
            sgc = Nimo()
        } else if (wearable.contains(DeviceTypes.FRAME)) {
            // sgc = FrameManager()
        }
        // update device model:
        DeviceStore.apply("glasses", "deviceModel", sgc?.type ?: "")
    }

    private fun createOptionalMach1Sgc(deviceType: String): SGCManager? {
        return try {
            Mach1().also { sgc ->
                if (deviceType == DeviceTypes.Z100) {
                    sgc.type = DeviceTypes.Z100
                }
            }
        } catch (e: LinkageError) {
            Bridge.log("Failed to initialize $deviceType support: ${e.message}")
            null
        }
    }

    fun initController(controllerType: String) {
        Bridge.log("MAN: Initializing controller: $controllerType")
        if (controller != null && controller?.type != controllerType) {
            Bridge.log("MAN: Controller already initialized, cleaning up previous controller")
            controller?.cleanup()
            controller = null
        }

        if (controller != null) {
            Bridge.log("MAN: Controller already initialized")
            return
        }

        if (controllerType == ControllerTypes.R1) {
            controller = R1()
        }
    }

    fun restartTranscriber() {
        Bridge.log("MAN: Restarting transcriber via command")
        if (ensureTranscriberInitialized()) {
            transcriber?.restart()
        }
    }

    private fun ensureTranscriberInitialized(): Boolean {
        if (transcriber != null) return true

        return try {
            val context = Bridge.getContext()
            val nextTranscriber = SherpaOnnxTranscriber(context)
            nextTranscriber.setTranscriptListener(
                object : SherpaOnnxTranscriber.TranscriptListener {
                    override fun onPartialResult(text: String, language: String) {
                        Bridge.log("STT: Partial result: $text")
                        // The Sherpa model emits all-caps text; lowercase English
                        // output to match the rest of the pipeline (parity with iOS).
                        val formatted = if (language == "en-US") text.lowercase() else text
                        Bridge.sendLocalTranscription(formatted, false, language)
                    }

                    override fun onFinalResult(text: String, language: String) {
                        Bridge.log("STT: Final result: $text")
                        // The Sherpa model emits all-caps text; lowercase English
                        // output to match the rest of the pipeline (parity with iOS).
                        val formatted = if (language == "en-US") text.lowercase() else text
                        Bridge.sendLocalTranscription(formatted, true, language)
                    }
                }
            )
            nextTranscriber.initialize()
            if (!nextTranscriber.isInitialized()) {
                Bridge.log("SherpaOnnxTranscriber initialize() returned without becoming ready")
                return false
            }
            transcriber = nextTranscriber
            Bridge.log("SherpaOnnxTranscriber fully initialized")
            true
        } catch (e: Exception) {
            Bridge.log("Failed to initialize SherpaOnnxTranscriber: ${e.message}")
            transcriber = null
            false
        } catch (e: LinkageError) {
            Bridge.log("Failed to initialize SherpaOnnxTranscriber: ${e.message}")
            transcriber = null
            false
        }
    }

    // MARK: - connection state management

    fun handleDeviceReady() {
        if (sgc == null) {
            Bridge.log("MAN: SGC is null, returning")
            return
        }

        val readyKey = "${sgc?.type}:${deviceName}"
        val now = System.currentTimeMillis()
        if (readyKey == lastReadyHandledKey && now - lastReadyHandledAtMs < 2000) {
            Bridge.log("MAN: handleDeviceReady() duplicate suppressed for $readyKey")
            return
        }
        lastReadyHandledKey = readyKey
        lastReadyHandledAtMs = now

        Bridge.log("MAN: handleDeviceReady() ${sgc?.type}")
        pendingWearable = ""
        defaultWearable = sgc?.type ?: ""
        searching = false

        syncSystemTimeOnceForConnection(readyKey)

        // re-apply display height/depth after reconnection
        mainHandler.postDelayed(
            {
                val h =
                    (DeviceStore.store.get("bluetooth", "dashboard_height") as? Number)
                        ?.toInt()
                        ?: 4
                val rawDepth =
                    (DeviceStore.store.get("bluetooth", "dashboard_depth") as? Number)
                        ?.toInt()
                        ?: dashboardDepth // canonical default (2), not 1
                val d = rawDepth.coerceIn(1, 4)
                sgc?.setDashboardPosition(h, d)
            },
            2000
        )

        // Show welcome message on first connect for all display glasses
        if (shouldSendBootingMessage) {
            shouldSendBootingMessage = false
            executor.execute {
                sgc?.sendTextWall("// MentraOS Connected")
                Thread.sleep(3000)
                sgc?.clearDisplay()
            }
        }

        // Call device-specific setup handlers
        if (defaultWearable.contains(DeviceTypes.G1)) {
            handleG1Ready()
        } else if (defaultWearable.contains(DeviceTypes.MACH1)) {
            handleMach1Ready()
        } else if (defaultWearable.contains(DeviceTypes.Z100)) {
            handleMach1Ready() // Z100 uses same initialization as Mach1
        }

        // Re-apply microphone settings after reconnection
        // Cache was cleared on disconnect, so this will definitely send commands
        Bridge.log("MAN: Re-applying microphone settings after reconnection")
        updateMicState()

        // send to the server our battery status:
        Bridge.sendBatteryStatus(sgc?.batteryLevel ?: -1, false)

        // save the default_wearable now that we're connected:
        Bridge.saveSetting("default_wearable", defaultWearable)
        Bridge.saveSetting("device_name", deviceName)
        Bridge.saveSetting("device_address", deviceAddress)
        if (defaultWearable.contains(DeviceTypes.AR99)) {
            val projectName = (DeviceStore.store.get("bluetooth", "project_name") as? String)?.trim().orEmpty()
            Bridge.saveSetting("project_name", projectName)
        }
    }

    private fun syncSystemTimeOnceForConnection(connectionKey: String) {
        val activeSgc = sgc ?: return
        if (activeSgc.type.contains(DeviceTypes.SIMULATED)) {
            return
        }
        if (connectionKey == lastSystemTimeSyncConnectionKey) {
            return
        }

        lastSystemTimeSyncConnectionKey = connectionKey
        val timestampMs = System.currentTimeMillis()
        Bridge.log("MAN: Syncing glasses system time once for connection: $timestampMs")
        activeSgc.sendSetSystemTime(timestampMs)
    }

    private fun handleG1Ready() {
        // G1-specific setup (if any needed in the future)
        // Note: G1-specific settings like silent mode, battery status,
        // head up angle, brightness, etc. could be configured here
    }

    private fun handleMach1Ready() {
        // Mach1-specific setup (if any needed in the future)
    }

    fun handleDeviceDisconnected() {
        Bridge.log("MAN: Device disconnected")
        lastSystemTimeSyncConnectionKey = ""
        DeviceStore.apply("glasses", "headUp", false)
        DeviceStore.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
        )
    }

    fun handleControllerReady() {
        val c = controller
        if (c == null) {
            Bridge.log("MAN: Controller is nil, returning")
            return
        }
        Bridge.log("MAN: handleControllerReady(): ${c.type}")

        pendingController = ""
        defaultController = c.type
        searching = false

        // save the default_controller now that we're connected:
        Bridge.saveSetting("default_controller", defaultController)
        Bridge.saveSetting("controller_device_name", controllerDeviceName)
    }

    fun handleControllerDisconnected() {
        Bridge.log("MAN: Controller disconnected")
    }

    // MARK: - Network Command handlers

    fun displayText(params: Map<String, Any>) {
        (params["text"] as? String)?.let { text ->
            Bridge.log("MAN: Displaying text: $text")
            sgc?.sendTextWall(text)
        }
    }

    fun clearDisplay() {
        Bridge.log("MAN: Clearing Display")
        sgc?.clearDisplay()
    }

    fun displayEvent(event: Map<String, Any>) {
        val view = event["view"] as? String
        if (view == null) {
            Bridge.log("MAN: Invalid view")
            return
        }

        val isDashboard = view == "dashboard"
        val stateIndex = if (isDashboard) 1 else 0

        // Scene frames (display.render() pipeline) take their own path: the
        // whole frame is the unit, not a layout, and the host's per-element
        // annotations make redundant frames self-deduping (all-"unchanged"
        // frames no-op in the SGC base handler).
        @Suppress("UNCHECKED_CAST") val sceneMap = event["scene"] as? Map<String, Any>
        if (sceneMap != null) {
            handleSceneEvent(stateIndex, sceneMap)
            return
        }

        @Suppress("UNCHECKED_CAST") val layout = event["layout"] as? Map<String, Any> ?: return

        val layoutType = layout["layoutType"] as? String

        // Scene→legacy handoff: a legacy layout is about to draw over a scene
        // (e.g. a cloud app taking the view from a miniapp). Sweep the scene's
        // elements first so they don't linger under the new content; clear_view
        // wipes everything anyway.
        sceneStates[stateIndex]?.let { prevFrame ->
            sceneStates[stateIndex] = null
            if (layoutType != "clear_view") {
                sgc?.clearSceneElements(prevFrame.elements.map { it.id })
            }
        }

        val text = parsePlaceholders(layout.getString("text", " "))
        val topText = parsePlaceholders(layout.getString("topText", " "))
        val bottomText = parsePlaceholders(layout.getString("bottomText", " "))
        val title = parsePlaceholders(layout.getString("title", " "))
        val data = layout["data"] as? String

        // Optional container position/size — used by bitmap_view and positioned_text (G2).
        val bmpX = (layout["x"] as? Number)?.toInt()
        val bmpY = (layout["y"] as? Number)?.toInt()
        val bmpWidth = (layout["width"] as? Number)?.toInt()
        val bmpHeight = (layout["height"] as? Number)?.toInt()

        // Optional positioned_text border (G2).
        val borderWidth = (layout["borderWidth"] as? Number)?.toInt()
        val borderRadius = (layout["borderRadius"] as? Number)?.toInt()

        var newViewState =
            ViewState(
                topText,
                bottomText,
                title,
                layoutType ?: "",
                text,
                data,
                null,
                bmpX,
                bmpY,
                bmpWidth,
                bmpHeight,
                borderWidth,
                borderRadius
            )

        val currentState = viewStates[stateIndex]

        if (statesEqual(currentState, newViewState)) {
            return
        }

        viewStates[stateIndex] = newViewState
        val hUp = headUp && contextualDashboard
        // send the state we just received if the user is currently in that state:
        if (stateIndex == 0 && !hUp) {
            sendCurrentState()
        } else if (stateIndex == 1 && hUp) {
            sendCurrentState()
        }
    }

    /** Parse + store a scene frame, then dispatch it if its view is visible. */
    private fun handleSceneEvent(stateIndex: Int, sceneMap: Map<String, Any>) {
        var frame = parseSceneFrame(sceneMap) ?: return
        val prevFrame = sceneStates[stateIndex]

        if (prevFrame == null) {
            // Legacy→scene handoff: stale legacy content (e.g. a cloud app's
            // text wall) must not linger under the scene's elements.
            // clearDisplay is the per-device "wipe what's there" (blank-in-place
            // on G2 — no page rebuild).
            val prevLegacyType = viewStates[stateIndex].layoutType
            if (prevLegacyType.isNotEmpty() && prevLegacyType != "clear_view" && prevLegacyType != "scene") {
                sgc?.clearDisplay()
            }
        } else if (prevFrame.appId != frame.appId) {
            // Cross-app switch: the host's diff baseline is per-app, so the new
            // app's annotations don't know the old app's elements are on the
            // glasses. Sweep the old app's elements (SGC registries still map
            // them), then paint the new frame from scratch. In practice the
            // boot message interposes between apps, so this isn't visible as a
            // blank.
            sgc?.clearSceneElements(prevFrame.elements.map { it.id })
            frame = frame.copy(replay = true, elements = frame.elements.map { it.copy(change = "created") })
        }

        // Store the REDISPATCH form: any later sendCurrentState (dashboard
        // exit, head-up return) must repaint the whole frame — the original
        // annotations are only valid for the first dispatch right now.
        sceneStates[stateIndex] =
            frame.copy(replay = true, elements = frame.elements.map { it.copy(change = "created") })
        viewStates[stateIndex] = ViewState(" ", " ", " ", "scene", " ", null, null)

        val hUp = headUp && contextualDashboard
        if ((stateIndex == 0 && !hUp) || (stateIndex == 1 && hUp)) {
            dispatchSceneFrame(frame)
        }
    }

    /** Guarded scene dispatch — mirrors sendCurrentState's send conditions. */
    private fun dispatchSceneFrame(frame: SceneFrame) {
        if (screenDisabled) return
        if (sgc?.type?.contains(DeviceTypes.SIMULATED) == true) return
        if (sgc?.fullyBooted != true) {
            Bridge.log("MAN: dispatchSceneFrame(): sgc not ready")
            return
        }
        sgc?.applySceneFrame(frame)
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseSceneFrame(sceneMap: Map<String, Any>): SceneFrame? {
        val elementsRaw = sceneMap["elements"] as? List<Map<String, Any>> ?: return null
        val elements =
            elementsRaw.mapNotNull { el ->
                val box = el["box"] as? Map<String, Any> ?: return@mapNotNull null
                val style = el["style"] as? Map<String, Any>
                SceneElement(
                    id = el["id"] as? String ?: return@mapNotNull null,
                    type = el["type"] as? String ?: return@mapNotNull null,
                    x = (box["x"] as? Number)?.toInt() ?: 0,
                    y = (box["y"] as? Number)?.toInt() ?: 0,
                    w = (box["w"] as? Number)?.toInt() ?: 0,
                    h = (box["h"] as? Number)?.toInt() ?: 0,
                    text = (el["text"] as? String)?.let { parsePlaceholders(it) },
                    data = el["data"] as? String,
                    border = (style?.get("border") as? Number)?.toInt() ?: 0,
                    radius = (style?.get("radius") as? Number)?.toInt() ?: 0,
                    change = el["change"] as? String ?: "created",
                    contentHash = el["contentHash"] as? String ?: ""
                )
            }
        return SceneFrame(
            appId = sceneMap["appId"] as? String ?: "",
            epoch = (sceneMap["sceneEpoch"] as? Number)?.toInt() ?: 0,
            replay = sceneMap["replay"] as? Boolean ?: false,
            elements = elements,
            removed = (sceneMap["removed"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
        )
    }

    fun showDashboard() {
        sgc?.showDashboard()
    }

    fun showNotificationsPanel() {
        CoroutineScope(Dispatchers.Main).launch {
            sgc?.showNotificationsPanel()
        }
    }

    fun ping() {
        sgc?.ping()
    }

    fun dbg1() {
        Bridge.log("MAN: dbg1()")
        sgc?.dbg1()
    }

    fun dbg2() {
        Bridge.log("MAN: dbg2()")
        sgc?.dbg2()
    }

    fun startStream(message: MutableMap<String, Any>) {
        Bridge.log("MAN: startStream")
        sgc?.startStream(message)
    }

    fun stopStream() {
        Bridge.log("MAN: stopStream")
        sgc?.stopStream()
    }

    fun keepStreamAlive(message: MutableMap<String, Any>) {
        Bridge.log("MAN: keepStreamAlive: (message)")
        sgc?.sendStreamKeepAlive(message)
    }

    fun requestWifiScan(scanId: String? = null) {
        Bridge.log("MAN: Requesting wifi scan")
        DeviceStore.apply("bluetooth", "wifiScanResults", emptyList<Any>())
        sgc?.requestWifiScan(scanId)
    }

    fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null) {
        Bridge.log("MAN: Sending incidentId to glasses for log upload: $incidentId")
        sgc?.sendIncidentId(incidentId, apiBaseUrl)
    }

    fun sendWifiCredentials(ssid: String, password: String) {
        Bridge.log("MAN: Sending wifi credentials: $ssid")
        sgc?.sendWifiCredentials(ssid, password)
    }

    fun forgetWifiNetwork(ssid: String) {
        Bridge.log("MAN: Forgetting wifi network: $ssid")
        sgc?.forgetWifiNetwork(ssid)
    }

    fun setHotspotState(enabled: Boolean) {
        Bridge.log("MAN: Setting glasses hotspot state: $enabled")
        sgc?.sendHotspotState(enabled)
    }

    fun setWifiAdbState(enabled: Boolean) {
        Bridge.log("MAN: Setting glasses Wi-Fi ADB state: $enabled")
        sgc?.sendWifiAdbState(enabled)
    }

    fun setSystemTime(timestampMs: Long) {
        Bridge.log("MAN: Setting glasses system time: $timestampMs")
        sgc?.sendSetSystemTime(timestampMs)
    }

    fun queryGalleryStatus() {
        Bridge.log("MAN: Querying gallery status from glasses")
        sgc?.queryGalleryStatus()
    }

    /**
     * Send OTA start command to glasses. Called when user approves an update (onboarding or
     * background mode). Triggers glasses to begin download and installation.
     */
    fun sendOtaStart(otaVersionUrl: String? = null) {
        Bridge.log("MAN: 📱 Sending OTA start command to glasses")
        (sgc as? MentraLive)?.sendOtaStart(otaVersionUrl)
    }

    fun sendOtaQueryStatus() {
        Bridge.log("MAN: 📱 Sending OTA query status command to glasses")
        (sgc as? MentraLive)?.sendOtaQueryStatus()
    }

    fun startAr99OtaFromFile(path: String): Boolean {
        val ar99 = sgc as? Ar99 ?: throw IllegalStateException("unsupported_device")
        return ar99.startOtaFromFile(path)
    }

    fun cancelAr99Ota() {
        (sgc as? Ar99)?.cancelAr99Ota()
    }

    fun sendAr99FactoryReset() {
        val ar99 = sgc as? Ar99 ?: throw IllegalStateException("unsupported_device")
        ar99.sendFactoryReset()
    }

    fun sendGalleryMode(requestId: String, enabled: Boolean) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendGalleryMode(requestId, enabled)
    }

    fun sendButtonPhotoSettings(requestId: String, size: String) {
        sendButtonPhotoSettings(requestId, PhotoCaptureDefaults(PhotoSize.fromValue(size)))
    }

    fun sendButtonPhotoSettings(requestId: String, settings: PhotoCaptureDefaults) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendButtonPhotoSettings(
            requestId,
            settings.size?.value,
            settings.mfnr,
            settings.zsl,
            settings.noiseReduction,
            settings.edgeEnhancement,
            settings.ispDigitalGain,
            settings.ispAnalogGain,
            settings.aeExposureDivisor,
            settings.isoCap,
            settings.compress,
            settings.sound,
            settings.resetCaptureTuning == true,
        )
    }

    fun sendButtonVideoRecordingSettings(requestId: String, width: Int, height: Int, fps: Int) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendButtonVideoRecordingSettings(requestId, width, height, fps)
    }

    fun sendButtonMaxRecordingTime(requestId: String, minutes: Int) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendButtonMaxRecordingTime(requestId, minutes)
    }

    fun sendCameraFovSetting(requestId: String, fov: Int, roiPosition: Int) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendCameraFovSetting(requestId, fov, roiPosition)
    }

    /** Sends the pre-lease FOV command used by ASG clients that do not send an acknowledgement. */
    fun sendLegacyCameraFovSetting(fov: Int, roiPosition: Int) {
        val glassesConnected = DeviceStore.get("glasses", "connected") as? Boolean ?: false
        if (!glassesConnected) throw IllegalStateException("not_connected")
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendCameraFovSetting(null, fov, roiPosition)
    }

    /** Replays the persistent base FOV without waiting for an acknowledgement. */
    fun restoreLegacyCameraFovSetting() {
        val glassesConnected = DeviceStore.get("glasses", "connected") as? Boolean ?: false
        if (!glassesConnected) throw IllegalStateException("not_connected")
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendCameraFovSetting()
    }

    fun sendCameraFovOverride(
        requestId: String,
        leaseId: String,
        fov: Int,
        roiPosition: Int,
        ttlMs: Int,
    ) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendCameraFovOverride(requestId, leaseId, fov, roiPosition, ttlMs)
    }

    fun releaseCameraFovOverride(requestId: String, leaseId: String) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.releaseCameraFovOverride(requestId, leaseId)
    }

    fun sendCameraTuningConfig(requestId: String, anrOn: Boolean, gainOn: Boolean) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.sendCameraTuningConfig(requestId, anrOn, gainOn)
    }

    fun warmUpCamera(
        requestId: String,
        size: PhotoSize,
        mode: PhotoMode = PhotoMode.PHOTO,
        exposureTimeNs: Long?,
        durationMs: Int,
        zsl: Boolean? = null,
        mfnr: Boolean? = null,
    ) {
        // Fail fast like other camera commands so the SDK promise rejects immediately instead of
        // hanging until the request timeout with no camera_status.
        val live =
            sgc as? MentraLive
                ?: throw BluetoothSdkException(
                    "unsupported_device",
                    "This command requires Mentra Live glasses.",
                )
        live.warmUpCamera(requestId, size, mode, exposureTimeNs, durationMs, zsl, mfnr)
    }

    fun stopCameraWarmUp(requestId: String) {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        live.stopCameraWarmUp(requestId)
    }

    /**
     * Read glasses media step volume (0—5) via K900 on Mentra Live only. Blocks until response,
     * error, or timeout (used from JS AsyncFunction on a worker thread).
     */
    fun getGlassesMediaVolumeBlocking(): Map<String, Any> {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        val latch = CountDownLatch(1)
        var result: Map<String, Any>? = null
        var error: String? = null
        live.getGlassesMediaVolume(
            { m ->
                result = m
                latch.countDown()
            },
            { e ->
                error = e
                latch.countDown()
            }
        )
        val completed = latch.await(5, TimeUnit.SECONDS)
        if (!completed) {
            throw IllegalStateException("glasses_volume_timeout")
        }
        error?.let { throw IllegalStateException(it) }
        return result ?: throw IllegalStateException("glasses_volume_empty")
    }

    /** Set glasses media step volume (0—5) via K900 on Mentra Live only. */
    fun setGlassesMediaVolumeBlocking(level: Int): Map<String, Any> {
        val live = sgc as? MentraLive ?: throw IllegalStateException("unsupported_device")
        val latch = CountDownLatch(1)
        var result: Map<String, Any>? = null
        var error: String? = null
        live.setGlassesMediaVolume(
            level,
            { m ->
                result = m
                latch.countDown()
            },
            { e ->
                error = e
                latch.countDown()
            }
        )
        val completed = latch.await(5, TimeUnit.SECONDS)
        if (!completed) {
            throw IllegalStateException("glasses_volume_timeout")
        }
        error?.let { throw IllegalStateException(it) }
        return result ?: throw IllegalStateException("glasses_volume_empty")
    }

    /**
     * Request version info from glasses. Glasses will respond with version_info message containing
     * build number, firmware version, etc.
     */
    fun requestVersionInfo() {
        Bridge.log("MAN: 📱 Requesting version info from glasses")
        sgc?.requestVersionInfo()
    }

    fun sendWipeMediaForPairing(transferId: String? = null, requestId: String? = null) {
        requireMentraLiveForPairing().sendWipeMedia(transferId, requestId)
    }

    fun requireMentraLiveForPairing(): MentraLive {
        val live = sgc as? MentraLive
        if (live == null) {
            throw IllegalStateException("Pairing transfer commands require Mentra Live glasses")
        }
        return live
    }

    fun sendPairingFinalize(transferId: String? = null) {
        requireMentraLiveForPairing().sendPairingFinalize(transferId)
    }

    fun sendPairingAbort(transferId: String? = null) {
        requireMentraLiveForPairing().sendPairingAbort(transferId)
    }

    /** Send shutdown command to glasses. This will initiate a graceful shutdown of the device. */
    fun sendShutdown() {
        Bridge.log("MAN: 🔌 Sending shutdown command to glasses")
        sgc?.sendShutdown()
    }

    /** Send reboot command to glasses. This will initiate a reboot of the device. */
    fun sendReboot() {
        Bridge.log("MAN: 🔄 Sending reboot command to glasses")
        sgc?.sendReboot()
    }

    fun startVideoRecording(
        requestId: String,
        save: Boolean,
        sound: Boolean,
        width: Int = 0,
        height: Int = 0,
        fps: Int = 0,
        maxRecordingTimeMinutes: Int = 0,
    ) {
        Bridge.log(
            "MAN: onStartVideoRecording: requestId=$requestId, save=$save, sound=$sound, " +
                "resolution=${width}x${height}@${fps}fps, maxRecordingTimeMinutes=$maxRecordingTimeMinutes"
        )
        sgc?.startVideoRecording(
            requestId, save, sound, width, height, fps, maxRecordingTimeMinutes
        )
    }

    fun stopVideoRecording(requestId: String, webhookUrl: String?, authToken: String?) {
        Bridge.log(
            "MAN: onStopVideoRecording: requestId=$requestId, webhook=" +
                if (webhookUrl.isNullOrEmpty()) "none" else "set"
        )
        sgc?.stopVideoRecording(requestId, webhookUrl, authToken)
    }

    fun setMicState() {
        val willSendPcm = shouldSendPcm || shouldSendLc3
        val willSendTranscript = shouldSendTranscript || localSttFallbackActive
        val nextEnabled = willSendPcm || willSendTranscript
        // Tell VAD when the mic is shutting down so it doesn't get stuck in
        // a stale "speaking" state and keep emitting vad_status=true after
        // audio stops flowing.
        if (micEnabled && !nextEnabled) {
            vadPolicy?.microphoneStateChanged(false)
        }
        micEnabled = nextEnabled
        vadBuffer.clear()
        updateMicState()
    }

    fun requestPhoto(request: PhotoRequest) {
        val exposureNs: Long? =
            request.exposureTimeNs?.takeIf { it.isFinite() && it > 0 }?.let { v ->
                when {
                    v > Long.MAX_VALUE.toDouble() -> Long.MAX_VALUE
                    else -> v.toLong()
                }
            }
        val manualIso = if (exposureNs != null) request.iso?.takeIf { it > 0 } else null
        val routed =
            request.copy(
                exposureTimeNs = exposureNs?.toDouble(),
                iso = manualIso,
            )
        Bridge.log(
            "MAN: PHOTO PIPELINE [4/6] DeviceManager.requestPhoto requestId=${routed.requestId} size=${routed.size.value} mode=${routed.mode.value} compress=${routed.compress.value} save=${routed.save} sound=${routed.sound} exposureTimeNs=$exposureNs iso=${manualIso ?: "auto"} aeDivisor=${routed.aeExposureDivisor} isoCap=${routed.isoCap} sgc=${sgc?.javaClass?.simpleName ?: "null"}"
        )
        val activeSgc = sgc
        if (activeSgc == null) {
            Bridge.log(
                "MAN: PHOTO PIPELINE — sgc is null (glasses not connected); dropping requestId=${routed.requestId}"
            )
            return
        }
        activeSgc.requestPhoto(routed)
    }

    fun rgbLedControl(
        requestId: String,
        packageName: String?,
        action: String,
        color: String?,
        onDurationMs: Int,
        offDurationMs: Int,
        count: Int
    ) {
        Bridge.log("MAN: RGB LED control: action=$action, color=$color, requestId=$requestId")
        sgc?.sendRgbLedControl(requestId, packageName, action, color, onDurationMs, offDurationMs, count)
    }

    fun connectDefault() {
        if (defaultWearable.isEmpty()) {
            Bridge.log("MAN: No default wearable, returning")
            return
        }
        val reconnectTarget =
            if (defaultWearable.contains(DeviceTypes.AR99) && deviceAddress.isNotBlank()) {
                deviceAddress
            } else {
                deviceName
            }
        if (reconnectTarget.isEmpty()) {
            Bridge.log("MAN: No reconnect target, returning")
            return
        }
        if (!hasBluetoothPermissions()) {
            // Auto-reconnect paths (boot, BT toggle, app launch before perm flow)
            // may fire before user has granted runtime Bluetooth permissions on Android 12+.
            // Bail out instead of crashing with SecurityException on startScan / getRemoteName.
            Bridge.log("MAN: connectDefault skipped — bluetooth runtime permissions not granted")
            return
        }
        initSGC(defaultWearable)
        val live = sgc as? MentraLive
        if (live?.isPairingYieldActive() == true) {
            Bridge.log("MAN: connectDefault skipped — Mentra Live pairing yield active")
            return
        }
        searching = true
        sgc?.connectById(reconnectTarget)
        connectDefaultController()
    }

    fun connectDefaultController() {
        if (defaultController.isEmpty()) {
            Bridge.log("MAN: No default controller, returning")
            return
        }
        if (controllerDeviceName.isEmpty()) {
            Bridge.log("MAN: No controller device name, returning")
            return
        }
        if (!hasBluetoothPermissions()) {
            Bridge.log("MAN: connectDefaultController skipped — bluetooth runtime permissions not granted")
            return
        }
        initController(defaultController)
        searchingController = true
        controller?.connectById(controllerDeviceName)
    }

    fun connectByName(dName: String) {
        Bridge.log("MAN: Connecting to wearable: $dName")

        var name = dName

        // use stored device name if available:
        if (dName.isEmpty() && !deviceName.isEmpty()) {
            name = deviceName
        }

        if (pendingWearable.isEmpty() && defaultWearable.isEmpty()) {
            Bridge.log("MAN: No pending or default wearable, returning")
            return
        }

        if (pendingWearable.isEmpty() && !defaultWearable.isEmpty()) {
            Bridge.log("MAN: No pending wearable, using default wearable")
            pendingWearable = defaultWearable
        }

        // if the pending wearable is a controller, don't disconnect the glasses;
        // route through the controller manager instead
        if (ControllerTypes.ALL.contains(pendingWearable)) {
            controller?.disconnect()
            initController(pendingWearable)
            controller?.connectById(name)
            return
        }

        disconnect()
        Thread.sleep(100)
        searching = true
        deviceName = name

        initSGC(pendingWearable)
        sgc?.connectById(deviceName)
    }

    fun connectDevice(deviceModel: String, deviceName: String) {
        Bridge.log("MAN: Connecting to device: $deviceModel $deviceName")
        if (DeviceTypes.ALL.contains(deviceModel)) {
            pendingWearable = deviceModel
            initSGC(pendingWearable)
            sgc?.connectById(deviceName)
            return
        }
        if (ControllerTypes.ALL.contains(deviceModel)) {
            pendingWearable = deviceModel
            initController(deviceModel)
            controller?.connectById(deviceName)
            return
        }
        Bridge.log("MAN: No compatible device model, returning")
    }

    fun connectSimulated() {
        defaultWearable = DeviceTypes.SIMULATED
        deviceName = DeviceTypes.SIMULATED
        initSGC(defaultWearable)
        handleDeviceReady()
    }

    fun disconnect() {
        sgc?.clearDisplay()
        sgc?.disconnect()
        sgc = null // Clear the SGC reference after disconnect
        lastSystemTimeSyncConnectionKey = ""
        searching = false
        micEnabled = false
        updateMicState()
        shouldSendBootingMessage = true // Reset for next first connect
        // clear glasses properties:
        DeviceStore.apply("glasses", "deviceModel", "")
        // Device identifiers are session-bound. Clear them on every disconnect so a
        // previously connected pair can never be reported for the next connection.
        DeviceStore.apply("glasses", "serialNumber", "")
        DeviceStore.apply("glasses", "bluetoothMacAddress", "")
        DeviceStore.apply("glasses", "leftMacAddress", "")
        DeviceStore.apply("glasses", "rightMacAddress", "")
        DeviceStore.apply("glasses", "macAddress", "")
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
        )
        // disconnect the controller as well:
        searchingController = false
        DeviceStore.apply("glasses", "controllerConnected", false)
        controller?.disconnect()
        controller = null
    }

    fun disconnectController() {
        searchingController = false
        // disconnect the controller from the glasses if applicable:
        sgc?.disconnectController()
        controller?.disconnect()
        controller = null
    }

    fun forget() {
        // Mentra Live CTKD: refuse while the OS pairing dialog is in-flight.
        // forget() → removeBond/disconnect mid-BOND_BONDING aborts that dialog and
        // leaves the user waiting ~30s for "Pairing dialog canceled" before retry.
        val live = sgc as? MentraLive
        if (live?.isCtkdBondingInProgress() == true) {
            Bridge.log(
                    "MAN: Refusing forget during CTKD bonding — finish the system pairing dialog first"
            )
            throw BluetoothSdkException(
                    "ctkd_bonding_in_progress",
                    "Bluetooth Classic pairing is in progress. Accept or cancel the system pairing dialog first, then unpair.",
            )
        }

        Bridge.log("MAN: Forgetting smart glasses")

        if (live != null) {
            // MentraLive forget() owns teardown so its last-line CTKD guard cannot be
            // bypassed by a second disconnect here if bonding starts after the check above.
            live.forget()
            if (live.isCtkdBondingInProgress()) {
                // MentraLive refused teardown; surface the same error the UI already handles.
                throw BluetoothSdkException(
                        "ctkd_bonding_in_progress",
                        "Bluetooth Classic pairing is in progress. Accept or cancel the system pairing dialog first, then unpair.",
                )
            }
            // MentraLive.forget() already destroyed the SGC. Clear the manager reference and
            // session state without calling disconnect() again (that would hit a dead instance
            // and leave a destroyed MentraLive retained for the next scan).
            sgc = null
            lastSystemTimeSyncConnectionKey = ""
            searching = false
            micEnabled = false
            updateMicState()
            shouldSendBootingMessage = true
            DeviceStore.apply("glasses", "deviceModel", "")
            DeviceStore.apply("glasses", "serialNumber", "")
            DeviceStore.apply("glasses", "bluetoothMacAddress", "")
            DeviceStore.apply("glasses", "leftMacAddress", "")
            DeviceStore.apply("glasses", "rightMacAddress", "")
            DeviceStore.apply("glasses", "macAddress", "")
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
            DeviceStore.apply(
                    "glasses",
                    "voiceActivityDetectionEnabled",
                    BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED,
            )
            searchingController = false
            DeviceStore.apply("glasses", "controllerConnected", false)
            controller?.disconnect()
            controller = null
        } else {
            // Typical abandonAttempt path: disconnect() already destroyed SGC and nulled
            // this.sgc, so MentraLive.forget() never ran and Classic bonds stayed up —
            // glasses keep IBRT ACL and stop BLE advertising. Tear bonds down here.
            MentraLive.unbondBondedMentraLiveDevices(Bridge.getContext())
            sgc?.forget()
            disconnect()
        }

        // Clear state
        defaultWearable = ""
        deviceName = ""
        deviceAddress = ""
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
        Bridge.saveSetting("device_address", "")
        Bridge.saveSetting("project_name", "")
    }

    fun forgetController() {
        Bridge.log("MAN: Forgetting controller")
        controller?.forget()
        disconnectController()
        // Clear state
        defaultController = ""
        controllerDeviceName = ""
        Bridge.saveSetting("controller_device_name", "")
        Bridge.saveSetting("default_controller", "")
        DeviceStore.apply("glasses", "controllerConnected", false)
    }

    fun findCompatibleDevices(deviceModel: String) {
        Bridge.log("MAN: Searching for compatible device names for: $deviceModel")

        // reset the search results:
        searchResults = emptyList()

        if (DeviceTypes.ALL.contains(deviceModel)) {
            pendingWearable = deviceModel
        }

        if (ControllerTypes.ALL.contains(deviceModel)) {
            pendingWearable = deviceModel
            initController(deviceModel)
            controller?.findCompatibleDevices()
            return
        }

        initSGC(pendingWearable)
        Bridge.log("MAN: sgc initialized, calling findCompatibleDevices")
        sgc?.findCompatibleDevices()
    }

    fun stopScan() {
        controller?.stopScan()
        sgc?.stopScan()
        DeviceStore.apply("bluetooth", "searching", false)
        DeviceStore.apply("bluetooth", "searchingController", false)
    }

    // MARK: Cleanup
    fun cleanup() {
        stopBluetoothStateMonitoring()

        micReinitRunnable?.let { mainHandler.removeCallbacks(it) }
        micReinitRunnable = null
        systemMicAvailabilityRecheckRunnable?.let { mainHandler.removeCallbacks(it) }
        systemMicAvailabilityRecheckRunnable = null

        // Clean up transcriber resources
        transcriber?.shutdown()
        transcriber = null

        // Clean up LC3 encoder/decoder (synchronized to prevent use-after-free
        // if the recording thread is mid-encode/decode)
        synchronized(lc3Lock) {
            if (lc3EncoderPtr != 0L) {
                Lc3Cpp.freeEncoder(lc3EncoderPtr)
                lc3EncoderPtr = 0
            }
            if (lc3DecoderPtr != 0L) {
                Lc3Cpp.freeDecoder(lc3DecoderPtr)
                lc3DecoderPtr = 0
            }
        }
    }
}
