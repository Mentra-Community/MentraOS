package com.mentra.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.mentra.core.services.ForegroundService
import com.mentra.core.services.PhoneMic
import com.mentra.core.sgcs.G1
import com.mentra.core.sgcs.Mach1
import com.mentra.core.sgcs.MentraLive
import com.mentra.core.sgcs.MentraNex
import com.mentra.core.sgcs.SGCManager
import com.mentra.core.sgcs.Simulated
import com.mentra.core.utils.DeviceTypes
import com.mentra.core.utils.MicMap
import com.mentra.core.utils.MicTypes
import com.mentra.lc3Lib.Lc3Cpp
import com.mentra.mentra.stt.SherpaOnnxTranscriber
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.jvm.JvmStatic

class CoreManager {
    companion object {

        @Volatile private var _instance: CoreManager? = null

        @JvmStatic
        fun getInstance(): CoreManager {
            return _instance
                    ?: synchronized(this) { _instance ?: CoreManager().also { _instance = it } }
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

    // notifications settings
    public var notificationsEnabled = false
    public var notificationsBlocklist = listOf<String>()
    // MARK: - End Unique

    // MARK: - Properties
    var sgc: SGCManager? = null

    // settings:
    private var defaultWearable: String
        get() = GlassesStore.store.get("core", "default_wearable") as? String ?: ""
        set(value) = GlassesStore.apply("core", "default_wearable", value)

    private var pendingWearable: String
        get() = GlassesStore.store.get("core", "pending_wearable") as? String ?: ""
        set(value) = GlassesStore.apply("core", "pending_wearable", value)

    public var deviceName: String
        get() = GlassesStore.store.get("core", "device_name") as? String ?: ""
        set(value) = GlassesStore.apply("core", "device_name", value)

    public var deviceAddress: String
        get() = GlassesStore.store.get("core", "device_address") as? String ?: ""
        set(value) = GlassesStore.apply("core", "device_address", value)

    private var screenDisabled: Boolean
        get() = GlassesStore.store.get("core", "screen_disabled") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "screen_disabled", value)

    private var preferredMic: String
        get() = GlassesStore.store.get("core", "preferred_mic") as? String ?: "auto"
        set(value) = GlassesStore.apply("core", "preferred_mic", value)

    private var autoBrightness: Boolean
        get() = GlassesStore.store.get("core", "auto_brightness") as? Boolean ?: true
        set(value) = GlassesStore.apply("core", "auto_brightness", value)

    private var brightness: Int
        get() = GlassesStore.store.get("core", "brightness") as? Int ?: 50
        set(value) = GlassesStore.apply("core", "brightness", value)

    private var headUpAngle: Int
        get() = GlassesStore.store.get("core", "head_up_angle") as? Int ?: 30
        set(value) = GlassesStore.apply("core", "head_up_angle", value)

    private var sensingEnabled: Boolean
        get() = GlassesStore.store.get("core", "sensing_enabled") as? Boolean ?: true
        set(value) = GlassesStore.apply("core", "sensing_enabled", value)

    public var powerSavingMode: Boolean
        get() = GlassesStore.store.get("core", "power_saving_mode") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "power_saving_mode", value)

    private var alwaysOnStatusBar: Boolean
        get() = GlassesStore.store.get("core", "always_on_status_bar") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "always_on_status_bar", value)

    private var bypassVad: Boolean
        get() = GlassesStore.store.get("core", "bypass_vad") as? Boolean ?: true
        set(value) = GlassesStore.apply("core", "bypass_vad", value)

    private var enforceLocalTranscription: Boolean
        get() = GlassesStore.store.get("core", "enforce_local_transcription") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "enforce_local_transcription", value)

    private var offlineMode: Boolean
        get() = GlassesStore.store.get("core", "offline_mode") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "offline_mode", value)

    private var metricSystem: Boolean
        get() = GlassesStore.store.get("core", "metric_system") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "metric_system", value)

    private var contextualDashboard: Boolean
        get() = GlassesStore.store.get("core", "contextual_dashboard") as? Boolean ?: true
        set(value) = GlassesStore.apply("core", "contextual_dashboard", value)

    private var dashboardHeight: Int
        get() = GlassesStore.store.get("core", "dashboard_height") as? Int ?: 4
        set(value) = GlassesStore.apply("core", "dashboard_height", value)

    private var dashboardDepth: Int
        get() = GlassesStore.store.get("core", "dashboard_depth") as? Int ?: 5
        set(value) = GlassesStore.apply("core", "dashboard_depth", value)

    private var galleryMode: Boolean
        get() = GlassesStore.store.get("core", "gallery_mode") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "gallery_mode", value)

    // state:
    private var shouldSendPcmData: Boolean
        get() = GlassesStore.store.get("core", "shouldSendPcmData") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "shouldSendPcmData", value)

    private var shouldSendTranscript: Boolean
        get() = GlassesStore.store.get("core", "shouldSendTranscript") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "shouldSendTranscript", value)

    private var searching: Boolean
        get() = GlassesStore.store.get("core", "searching") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "searching", value)

    private var glassesBtcConnected: Boolean
        get() = GlassesStore.store.get("glasses", "btcConnected") as? Boolean ?: false
        set(value) = GlassesStore.apply("glasses", "btcConnected", value)

    public var micRanking: MutableList<String>
        get() =
                (GlassesStore.store.get("core", "micRanking") as? List<*>)
                        ?.mapNotNull { it as? String }
                        ?.toMutableList()
                        ?: MicMap.map["auto"]?.toMutableList() ?: mutableListOf()
        set(value) = GlassesStore.apply("core", "micRanking", value)

    private var shouldSendBootingMessage: Boolean
        get() = GlassesStore.store.get("core", "shouldSendBootingMessage") as? Boolean ?: true
        set(value) = GlassesStore.apply("core", "shouldSendBootingMessage", value)

    private var systemMicUnavailable: Boolean
        get() = GlassesStore.store.get("core", "systemMicUnavailable") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "systemMicUnavailable", value)

    public var headUp: Boolean
        get() = GlassesStore.store.get("glasses", "headUp") as? Boolean ?: false
        set(value) = GlassesStore.apply("glasses", "headUp", value)

    private var micEnabled: Boolean
        get() = GlassesStore.store.get("core", "micEnabled") as? Boolean ?: false
        set(value) = GlassesStore.apply("core", "micEnabled", value)

    private var currentMic: String
        get() = GlassesStore.store.get("core", "currentMic") as? String ?: ""
        set(value) = GlassesStore.apply("core", "currentMic", value)

    private var searchResults: List<Any>
        get() = GlassesStore.store.get("core", "searchResults") as? List<Any> ?: emptyList()
        set(value) = GlassesStore.apply("core", "searchResults", value)

    private var wifiScanResults: List<Any>
        get() = GlassesStore.store.get("core", "wifiScanResults") as? List<Any> ?: emptyList()
        set(value) = GlassesStore.apply("core", "wifiScanResults", value)

    private var lastLog: MutableList<String>
        get() = GlassesStore.store.get("core", "lastLog") as? MutableList<String> ?: mutableListOf()
        set(value) = GlassesStore.apply("core", "lastLog", value)

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
    // Audio output format - defaults to LC3 for bandwidth savings
    private var audioOutputFormat: AudioOutputFormat = AudioOutputFormat.LC3

    // VAD
    private val vadBuffer = mutableListOf<ByteArray>()
    private var isSpeaking = false

    // STT
    private var transcriber: SherpaOnnxTranscriber? = null

    // View states
    private val viewStates = mutableListOf<ViewState>()

    init {
        Bridge.log("Core: init()")
        initializeViewStates()
        startForegroundService()
        // setupPermissionMonitoring()
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

        if (permissionsChanged && serviceStarted) {
            Bridge.log("MAN: Permissions changed, restarting service")
            restartForegroundService()
        }
    }

    private fun checkBluetoothPermission(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(
                    context,
                    android.Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.BLUETOOTH) ==
                    PackageManager.PERMISSION_GRANTED
        }
    }

    private fun checkMicrophonePermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
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

    private fun checkSetVadStatus(speaking: Boolean) {
        if (speaking != isSpeaking) {
            isSpeaking = speaking
            Bridge.sendVadStatus(isSpeaking)
        }
    }

    /**
     * Send audio data to cloud via Bridge. Encodes to LC3 if audioOutputFormat is LC3, otherwise
     * sends raw PCM. All audio destined for cloud should go through this function.
     */
    private fun sendMicData(pcmData: ByteArray) {
        when (audioOutputFormat) {
            AudioOutputFormat.LC3 -> {
                if (lc3EncoderPtr == 0L) {
                    Bridge.log("MAN: ERROR - LC3 encoder not initialized but format is LC3")
                    return
                }
                val lc3FrameSize = (GlassesStore.store.get("core", "lc3_frame_size") as Number).toInt()
                val lc3Data = Lc3Cpp.encodeLC3(lc3EncoderPtr, pcmData, lc3FrameSize)
                if (lc3Data == null || lc3Data.isEmpty()) {
                    Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
                    return
                }
                Bridge.sendMicData(lc3Data)
            }
            AudioOutputFormat.PCM -> {
                Bridge.sendMicData(pcmData)
            }
        }
    }

    private fun emptyVadBuffer() {
        while (vadBuffer.isNotEmpty()) {
            val chunk = vadBuffer.removeAt(0)
            sendMicData(chunk) // Uses our encoder, not Bridge directly
        }
    }

    private fun addToVadBuffer(chunk: ByteArray) {
        val MAX_BUFFER_SIZE = 20
        vadBuffer.add(chunk)
        while (vadBuffer.size > MAX_BUFFER_SIZE) {
            vadBuffer.removeAt(0)
        }
    }

    /**
     * Handle raw LC3 audio data from glasses. Decodes the glasses LC3, then passes to handlePcm for
     * canonical LC3 encoding. Note: frameSize here is for glasses→phone decoding, NOT for
     * phone→cloud encoding.
     */
    fun handleGlassesMicData(rawLC3Data: ByteArray, frameSize: Int = 40) {
        if (lc3DecoderPtr == 0L) {
            Bridge.log("MAN: LC3 decoder not initialized, cannot process glasses audio")
            return
        }

        try {
            // Decode glasses LC3 to PCM (glasses may use different LC3 configs)
            val pcmData = Lc3Cpp.decodeLC3(lc3DecoderPtr, rawLC3Data, frameSize)
            if (pcmData != null && pcmData.isNotEmpty()) {
                // Re-encode to canonical LC3 via handlePcm
                handlePcm(pcmData)
            } else {
                Bridge.log("MAN: LC3 decode returned empty data")
            }
        } catch (e: Exception) {
            Bridge.log("MAN: Failed to decode glasses LC3: ${e.message}")
        }
    }

    fun handlePcm(pcmData: ByteArray) {
        // Send audio to cloud if needed (encoding handled by sendMicData)
        if (shouldSendPcmData) {
            sendMicData(pcmData)
        }

        // Send PCM to local transcriber (always needs raw PCM)
        if (shouldSendTranscript) {
            transcriber?.acceptAudio(pcmData)
        }
    }

    // turns a single mic on and turns off all other mics:
    private fun updateMicState() {
        // go through the micRanking and find the first mic that is available:
        var micUsed: String = ""

        // allow the sgc to make changes to the micRanking:
        micRanking = sgc?.sortMicRanking(micRanking) ?: micRanking
        Bridge.log("MAN: updateMicState() micRanking: $micRanking")

        if (micEnabled) {

            for (micMode in micRanking) {
                if (micMode == MicTypes.PHONE_INTERNAL ||
                                micMode == MicTypes.BT_CLASSIC ||
                                micMode == MicTypes.BT
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
                            micMode == MicTypes.BT_CLASSIC ||
                            micMode == MicTypes.BT
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
        val hUp = GlassesStore.get("glasses", "headUp") as? Boolean ?: false
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
            Bridge.log("MAN: CoreManager.sendCurrentState(): sgc not ready")
            return
        }

        // Cancel any pending clear display work item
        // sendStateWorkItem?.let { mainHandler.removeCallbacks(it) }

        Bridge.log("MAN: parsing layoutType: ${currentViewState.layoutType}")
        Bridge.log(
                "MAN: viewState text: '${currentViewState.text}' (len=${currentViewState.text.length})"
        )

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
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
    }

    // MARK: - Auxiliary Commands

    fun initSGC(wearable: String) {
        Bridge.log("Initializing manager for wearable: $wearable")
        if (sgc != null && sgc?.type != wearable) {
            Bridge.log("MAN: Manager already initialized, cleaning up previous sgc")
            Bridge.log("MAN: Cleaning up previous sgc type: ${sgc?.type}")
            sgc?.cleanup()
            sgc = null
        }

        if (sgc != null) {
            Bridge.log("MAN: SGC already initialized")
            return
        }

        if (wearable.contains(DeviceTypes.SIMULATED)) {
            sgc = Simulated()
        } else if (wearable.contains(DeviceTypes.G1)) {
            sgc = G1()
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

        Bridge.log("MAN: handleDeviceReady() ${sgc?.type}")
        pendingWearable = ""
        defaultWearable = sgc?.type ?: ""
        searching = false
        
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
        GlassesStore.apply("glasses", "headUp", false)
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

    fun startRtmpStream(message: MutableMap<String, Any>) {
        Bridge.log("MAN: startRtmpStream")
        sgc?.startRtmpStream(message)
    }

    fun stopRtmpStream() {
        Bridge.log("MAN: stopRtmpStream")
        sgc?.stopRtmpStream()
    }

    fun keepRtmpStreamAlive(message: MutableMap<String, Any>) {
        Bridge.log("MAN: keepRtmpStreamAlive: (message)")
        sgc?.sendRtmpKeepAlive(message)
    }

    fun requestWifiScan() {
        Bridge.log("MAN: Requesting wifi scan")
        GlassesStore.apply("core", "wifiScanResults", emptyList<Any>())
        sgc?.requestWifiScan()
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

    /**
     * Request version info from glasses.
     * Glasses will respond with version_info message containing build number, firmware version, etc.
     */
    fun requestVersionInfo() {
        Bridge.log("MAN: 📱 Requesting version info from glasses")
        sgc?.requestVersionInfo()
    }

    /**
     * Send shutdown command to glasses.
     * This will initiate a graceful shutdown of the device.
     */
    fun sendShutdown() {
        Bridge.log("MAN: 🔌 Sending shutdown command to glasses")
        sgc?.sendShutdown()
    }

    /**
     * Send reboot command to glasses.
     * This will initiate a reboot of the device.
     */
    fun sendReboot() {
        Bridge.log("MAN: 🔄 Sending reboot command to glasses")
        sgc?.sendReboot()
    }

    fun startBufferRecording() {
        Bridge.log("MAN: onStartBufferRecording")
        sgc?.startBufferRecording()
    }

    fun stopBufferRecording() {
        Bridge.log("MAN: onStopBufferRecording")
        sgc?.stopBufferRecording()
    }

    fun saveBufferVideo(requestId: String, durationSeconds: Int) {
        Bridge.log("MAN: onSaveBufferVideo: requestId=$requestId, duration=$durationSeconds")
        sgc?.saveBufferVideo(requestId, durationSeconds)
    }

    fun startVideoRecording(requestId: String, save: Boolean, silent: Boolean) {
        Bridge.log("MAN: onStartVideoRecording: requestId=$requestId, save=$save, silent=$silent")
        sgc?.startVideoRecording(requestId, save, silent)
    }

    fun stopVideoRecording(requestId: String) {
        Bridge.log("MAN: onStopVideoRecording: requestId=$requestId")
        sgc?.stopVideoRecording(requestId)
    }

    fun setMicState(sendPcm: Boolean, sendTranscript: Boolean, bypassVadForPCM: Boolean) {
        Bridge.log("MAN: MIC: setMicState($sendPcm, $sendTranscript, $bypassVad)")

        shouldSendPcmData = sendPcm
        shouldSendTranscript = sendTranscript
        bypassVad = bypassVadForPCM

        vadBuffer.clear()
        micEnabled = shouldSendPcmData || shouldSendTranscript
        updateMicState()
    }

    fun photoRequest(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String,
            authToken: String,
            compress: String,
            silent: Boolean
    ) {
        Bridge.log(
                "MAN: onPhotoRequest: $requestId, $appId, $size, compress=$compress, silent=$silent"
        )
        sgc?.requestPhoto(requestId, appId, size, webhookUrl, authToken, compress, silent)
    }

    fun rgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            ontime: Int,
            offtime: Int,
            count: Int
    ) {
        Bridge.log("MAN: RGB LED control: action=$action, color=$color, requestId=$requestId")
        sgc?.sendRgbLedControl(requestId, packageName, action, color, ontime, offtime, count)
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
        initSGC(defaultWearable)
        searching = true
        sgc?.connectById(deviceName)
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

        disconnect()
        Thread.sleep(100)
        searching = true
        deviceName = name

        initSGC(pendingWearable)
        sgc?.connectById(deviceName)
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
        searching = false
        shouldSendPcmData = false
        shouldSendTranscript = false
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
        shouldSendBootingMessage = true // Reset for next first connect
        GlassesStore.apply("glasses", "fullyBooted", false)
        GlassesStore.apply("glasses", "connected", false)
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
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
    }

    fun findCompatibleDevices(deviceModel: String) {
        Bridge.log("MAN: Searching for compatible device names for: $deviceModel")

        // reset the search results:
        searchResults = emptyList()

        if (DeviceTypes.ALL.contains(deviceModel)) {
            pendingWearable = deviceModel
        }

        initSGC(pendingWearable)
        Bridge.log("MAN: sgc initialized, calling findCompatibleDevices")
        sgc?.findCompatibleDevices()
    }

    // MARK: Cleanup
    fun cleanup() {
        // Clean up transcriber resources
        transcriber?.shutdown()
        transcriber = null

        // Clean up LC3 encoder/decoder
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
