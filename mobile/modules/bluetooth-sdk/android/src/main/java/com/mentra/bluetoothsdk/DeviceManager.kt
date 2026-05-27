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
import com.mentra.bluetoothsdk.sgcs.G1
import com.mentra.bluetoothsdk.sgcs.G2
import com.mentra.bluetoothsdk.sgcs.Mach1
import com.mentra.bluetoothsdk.sgcs.MentraLive
import com.mentra.bluetoothsdk.sgcs.MentraNex
import com.mentra.bluetoothsdk.sgcs.SGCManager
import com.mentra.bluetoothsdk.sgcs.Simulated
import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.MicMap
import com.mentra.bluetoothsdk.utils.MicTypes
import com.mentra.lc3Lib.Lc3Cpp
import com.mentra.bluetoothsdk.stt.SherpaOnnxTranscriber
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.jvm.JvmStatic

class DeviceManager {
    companion object {

        @Volatile private var _instance: DeviceManager? = null

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

    private var offlineCaptionsRunning: Boolean
        get() = DeviceStore.store.get("bluetooth", "offline_captions_running") as? Boolean ?: false
        set(value) = DeviceStore.apply("bluetooth", "offline_captions_running", value)

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
        // Initialize local STT transcriber
        try {
            val context = Bridge.getContext()
            transcriber = SherpaOnnxTranscriber(context)
            transcriber?.setTranscriptListener(
                    object : SherpaOnnxTranscriber.TranscriptListener {
                        override fun onPartialResult(text: String, language: String) {
                            Bridge.log("STT: Partial result: $text")
                            Bridge.sendLocalTranscription(text, false, language)
                        }

                        override fun onFinalResult(text: String, language: String) {
                            Bridge.log("STT: Final result: $text")
                            Bridge.sendLocalTranscription(text, true, language)
                        }
                    }
            )
            transcriber?.initialize()
            Bridge.log("SherpaOnnxTranscriber fully initialized")
        } catch (e: Exception) {
            Bridge.log("Failed to initialize SherpaOnnxTranscriber: ${e.message}")
            transcriber = null
        }

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

        // When no frame has ever been received, treat elapsed as "forever" so we
        // actually attempt recovery (was 0 before, which made the watchdog a no-op).
        val timeSinceLastLc3Event = System.currentTimeMillis() - (lastLc3Event ?: 0L)
        if (timeSinceLastLc3Event > 5000) {
            Bridge.log("MAN: No audio activity in the last 5 seconds from glasses, reinitializing glasses mic")
            sgc?.setMicEnabled(true)
        }
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
            var animationData: Map<String, Any>?
    )
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
        handleSendingPcm(pcmData)

        // Send PCM to local transcriber (always needs raw PCM)
        if (shouldSendTranscript || offlineCaptionsRunning || localSttFallbackActive) {
            transcriber?.acceptAudio(pcmData)
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
        var currentViewState: ViewState
        if (hUp) {
            currentViewState = viewStates[1]
        } else {
            currentViewState = viewStates[0]
        }

        if (hUp && !contextualDashboard) {
            currentViewState = viewStates[0]
        }

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
                sgc?.sendTextWall(currentViewState.text)
            }
            "double_text_wall" -> {
                sgc?.sendDoubleTextWall(currentViewState.topText, currentViewState.bottomText)
            }
            "reference_card" -> {
                sgc?.sendTextWall("${currentViewState.title}\n\n${currentViewState.text}")
            }
            "bitmap_view" -> {
                currentViewState.data?.let { data -> sgc?.displayBitmap(data) }
            }
            "clear_view" -> sgc?.clearDisplay()
            else -> Bridge.log("MAN: UNHANDLED LAYOUT_TYPE ${currentViewState.layoutType}")
        }
        // }
    }

    private fun parsePlaceholders(text: String): String {
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
                appendLog("MAN: MIC_UNAVAILABLE: TRUE external_app_recording")
            }
            "audio_focus_available" -> {
                // Audio focus is available again
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE audio_focus_available")
                appendLog("MAN: MIC_UNAVAILABLE: FALSE audio_focus_available")
            }
            "external_app_stopped" -> {
                // External app stopped recording
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE external_app_stopped")
                appendLog("MAN: MIC_UNAVAILABLE: FALSE external_app_stopped")
            }
            "phone_call_interruption" -> {
                // Phone call started - mark mic as unavailable
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE phone_call_interruption")
                appendLog("MAN: MIC_UNAVAILABLE: TRUE phone_call_interruption")
            }
            "phone_call_ended" -> {
                // Phone call ended - mark mic as available again
                systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: FALSE phone_call_ended")
                appendLog("MAN: MIC_UNAVAILABLE: FALSE phone_call_ended")
            }
            "phone_call_active" -> {
                // Tried to start recording while phone call already active
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE phone_call_active")
                appendLog("MAN: MIC_UNAVAILABLE: TRUE phone_call_active")
            }
            "audio_focus_denied" -> {
                // Another app has audio focus
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE audio_focus_denied")
                appendLog("MAN: MIC_UNAVAILABLE: TRUE audio_focus_denied")
            }
            "permission_denied" -> {
                // Microphone permission not granted
                systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: TRUE permission_denied")
                appendLog("MAN: MIC_UNAVAILABLE: TRUE permission_denied")
                // Don't trigger fallback - need to request permission from user
            }
            "audio_route_changed" -> {
                // Audio route changed
                // systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN audio_route_changed")
                appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN audio_route_changed")
            }
            "recording_started" -> {
                // this is an event from the PhoneMic saying we have started recording
                // Audio recording started
                // systemMicUnavailable = true
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN recording_started")
                appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN recording_started")
            }
            "recording_stopped" -> {
                // this is an event from the PhoneMic saying we have stopped recording
                // Audio recording stopped
                // systemMicUnavailable = false
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN recording_stopped")
                appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN recording_stopped")
            }
            else -> {
                // Other route changes (headset plug/unplug, BT connect/disconnect, etc.)
                // Just log for now - may want to handle these in the future
                Bridge.log("MAN: MIC_UNAVAILABLE: UNKNOWN other: $reason")
                appendLog("MAN: MIC_UNAVAILABLE: UNKNOWN other: $reason")
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
        } else if (wearable.contains(DeviceTypes.MACH1)) {
            sgc = Mach1()
        } else if (wearable.contains(DeviceTypes.Z100)) {
            sgc = Mach1() // Z100 uses same hardware/SDK as Mach1
            sgc?.type = DeviceTypes.Z100 // Override type to Z100
        } else if (wearable.contains(DeviceTypes.FRAME)) {
            // sgc = FrameManager()
        }
        // update device model:
        DeviceStore.apply("glasses", "deviceModel", sgc?.type ?: "")
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
        transcriber?.restart()
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

        // Apply dashboard position before any boot text so content doesn't jump.
        sgc?.setDashboardPosition(dashboardHeight, dashboardDepth)

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
        DeviceStore.apply("glasses", "voiceActivityDetectionEnabled", true)
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

        @Suppress("UNCHECKED_CAST") val layout = event["layout"] as? Map<String, Any> ?: return

        val layoutType = layout["layoutType"] as? String
        val text = parsePlaceholders(layout.getString("text", " "))
        val topText = parsePlaceholders(layout.getString("topText", " "))
        val bottomText = parsePlaceholders(layout.getString("bottomText", " "))
        val title = parsePlaceholders(layout.getString("title", " "))
        val data = layout["data"] as? String

        var newViewState = ViewState(topText, bottomText, title, layoutType ?: "", text, data, null)

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

    fun showDashboard() {
        sgc?.showDashboard()
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
        message["flash"] = true
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

    fun requestWifiScan() {
        Bridge.log("MAN: Requesting wifi scan")
        DeviceStore.apply("bluetooth", "wifiScanResults", emptyList<Any>())
        sgc?.requestWifiScan()
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
    fun sendOtaStart() {
        Bridge.log("MAN: 📱 Sending OTA start command to glasses")
        (sgc as? MentraLive)?.sendOtaStart()
    }

    fun sendOtaQueryStatus() {
        Bridge.log("MAN: 📱 Sending OTA query status command to glasses")
        (sgc as? MentraLive)?.sendOtaQueryStatus()
    }

    fun retryOtaVersionCheck() {
        Bridge.log("MAN: ⏰ Retrying glasses OTA version check after clock sync")
        (sgc as? MentraLive)?.sendOtaRetryVersionCheck()
    }

    /**
     * Read glasses media step volume (0–15) via K900 on Mentra Live only. Blocks until response,
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

    /** Set glasses media step volume (0–15) via K900 on Mentra Live only. */
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

    fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {
        Bridge.log(
                "MAN: onStartVideoRecording: requestId=$requestId, save=$save, flash=true, sound=$sound"
        )
        sgc?.startVideoRecording(requestId, save, true, sound)
    }

    fun stopVideoRecording(requestId: String) {
        Bridge.log("MAN: onStopVideoRecording: requestId=$requestId")
        sgc?.stopVideoRecording(requestId)
    }

    fun setMicState() {
        val willSendPcm = shouldSendPcm || shouldSendLc3
        val willSendTranscript = shouldSendTranscript || offlineCaptionsRunning || localSttFallbackActive
        micEnabled = willSendPcm || willSendTranscript
        updateMicState()
    }

    fun requestPhoto(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String,
            authToken: String?,
            compress: String,
            flash: Boolean,
            sound: Boolean,
            exposureTimeNs: Double? = null,
    ) {
        val exposureNs: Long? =
                exposureTimeNs?.takeIf { it.isFinite() && it > 0 }?.let { v ->
                    when {
                        v > Long.MAX_VALUE.toDouble() -> Long.MAX_VALUE
                        else -> v.toLong()
                    }
                }
        Bridge.log(
                "MAN: PHOTO PIPELINE [4/6] DeviceManager.requestPhoto requestId=$requestId appId=$appId size=$size compress=$compress flash=$flash sound=$sound exposureTimeNs=$exposureNs sgc=${sgc?.javaClass?.simpleName ?: "null"}"
        )
        val activeSgc = sgc
        if (activeSgc == null) {
            Bridge.log(
                    "MAN: PHOTO PIPELINE — sgc is null (glasses not connected); dropping requestId=$requestId"
            )
            return
        }
        activeSgc.requestPhoto(requestId, appId, size, webhookUrl, authToken, compress, flash, sound, exposureNs)
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
        if (deviceName.isEmpty()) {
            Bridge.log("MAN: No device name, returning")
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
        searching = true
        sgc?.connectById(deviceName)
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
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "voiceActivityDetectionEnabled", true)
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
        Bridge.log("MAN: Forgetting smart glasses")

        // Call forget first to stop timers/handlers/reconnect logic
        sgc?.forget()

        // Then disconnect to close connections
        disconnect()

        // Clear state
        defaultWearable = ""
        deviceName = ""
        deviceAddress = ""
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
        Bridge.saveSetting("device_address", "")
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
