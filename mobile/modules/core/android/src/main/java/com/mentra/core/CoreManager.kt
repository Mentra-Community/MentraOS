package com.mentra.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.mentra.core.services.ForegroundService
import com.mentra.core.services.PhoneMic
import com.mentra.core.sgcs.G1
import com.mentra.core.sgcs.Mach1
import com.mentra.core.sgcs.MentraLive
import com.mentra.core.sgcs.SGCManager
import com.mentra.core.sgcs.Simulated
import com.mentra.core.utils.DeviceTypes
import com.mentra.core.utils.MicTypes
import com.mentra.core.utils.MicMap
import com.mentra.mentra.stt.SherpaOnnxTranscriber
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class CoreManager {
    companion object {

        @Volatile private var instance: CoreManager? = null

        @JvmStatic
        fun getInstance(): CoreManager {
            return instance
                    ?: synchronized(this) { instance ?: CoreManager().also { instance = it } }
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
    var coreToken = ""
    var coreTokenOwner = ""
    var sgc: SGCManager? = null

    // state
    private var shouldSendBootingMessage = true
    private val lastStatusObj = ConcurrentHashMap<String, Any>()
    private var defaultWearable = ""
    private var pendingWearable = ""
    public var deviceName = ""
    public var deviceAddress = ""
    private var screenDisabled = false
    private var isSearching = false
    private var systemMicUnavailable = false
    public val currentRequiredData = mutableListOf<SpeechRequiredDataType>()
    public var micRanking = MicMap.map["auto"]?.toMutableList() ?: mutableListOf()

    // glasses settings
    private var contextualDashboard = true
    private var headUpAngle = 30
    public var brightness = 50
    public var autoBrightness = true
    public var dashboardHeight = 4
    public var dashboardDepth = 5
    public var galleryMode = false

    // glasses state
    private var isHeadUp = false

    // core settings
    public var sensingEnabled = true
    public var powerSavingMode = false
    private var alwaysOnStatusBar = false
    private var bypassVad = true
    private var bypassVadForPCM = false
    private var enforceLocalTranscription = false
    private var bypassAudioEncoding = false
    private var offlineMode = false
    private var metricSystem = false

    // mic
    public var useOnboardMic = false
    public var preferredMic = "glasses"
    public var micEnabled = false
    private var lastMicState: Triple<Boolean, Boolean, String>? =
            null // (useGlassesMic, useOnboardMic, preferredMic)

    // button settings
    public var buttonPressMode = "photo"
    public var buttonPhotoSize = "medium"
    public var buttonVideoWidth = 1280
    public var buttonVideoHeight = 720
    public var buttonVideoFps = 30
    public var buttonMaxRecordingTime = 10
    public var buttonCameraLed = true

    // VAD
    private val vadBuffer = mutableListOf<ByteArray>()
    private var isSpeaking = false

    // STT
    private var transcriber: SherpaOnnxTranscriber? = null
    private var shouldSendPcmData = false
    private var shouldSendTranscript = false

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

    enum class SpeechRequiredDataType(val rawValue: String) {
        PCM("pcm"),
        TRANSCRIPTION("transcription"),
        PCM_OR_TRANSCRIPTION("pcm_or_transcription");

        companion object {
            /**
             * Convert from string value to enum
             * @param value The string value to convert
             * @return The corresponding enum value, or null if not found
             */
            fun fromString(value: String): SpeechRequiredDataType? {
                return values().find { it.rawValue == value }
            }

            /**
             * Convert array of strings to array of enums
             * @param stringArray Array of string values
             * @return Array of enum values, filtering out invalid strings
             */
            fun fromStringArray(stringArray: List<String>): List<SpeechRequiredDataType> {
                return stringArray.mapNotNull { fromString(it) }
            }

            /**
             * Convert array of enums to array of strings
             * @param enumArray Array of enum values
             * @return Array of string values
             */
            fun toStringArray(enumArray: List<SpeechRequiredDataType>): List<String> {
                return enumArray.map { it.rawValue }
            }
        }

        /**
         * Convert enum to string value
         * @return The string representation of the enum
         */
        override fun toString(): String {
            return rawValue
        }
    }
    // MARK: - End Unique

    // MARK: - Voice Data Handling

    private fun checkSetVadStatus(speaking: Boolean) {
        if (speaking != isSpeaking) {
            isSpeaking = speaking
            Bridge.sendVadStatus(isSpeaking)
        }
    }

    private fun emptyVadBuffer() {
        while (vadBuffer.isNotEmpty()) {
            val chunk = vadBuffer.removeAt(0)
            Bridge.sendMicData(chunk)
        }
    }

    private fun addToVadBuffer(chunk: ByteArray) {
        val MAX_BUFFER_SIZE = 20
        vadBuffer.add(chunk)
        while (vadBuffer.size > MAX_BUFFER_SIZE) {
            vadBuffer.removeAt(0)
        }
    }

    fun handleGlassesMicData(rawLC3Data: ByteArray) {
        // decode the lc3 data to pcm and pass to the bridge to be sent to the server:
        // TODO: config
    }

    fun handlePcm(pcmData: ByteArray) {
        // Bridge.log("MAN: handlePcm()")

        // Send PCM to cloud if needed
        if (shouldSendPcmData) {
            Bridge.sendMicData(pcmData)
        }

        // Send PCM to local transcriber if needed
        if (shouldSendTranscript) {
            transcriber?.acceptAudio(pcmData)
        }
    }

    // turns a single mic on and turns off all other mics:
    private fun updateMicState() {
        Bridge.log("MAN: updateMicState() - micEnabled=$micEnabled, systemMicUnavailable=$systemMicUnavailable")
        Bridge.log("MAN: micRanking=$micRanking")

        // go through the micRanking and find the first mic that is available:
        var micUsed: String = ""

        // allow the sgc to make changes to the micRanking:
        micRanking = sgc?.sortMicRanking(micRanking) ?: micRanking

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
                    if (sgc?.hasMic == true && sgc?.micEnabled == false) {
                        sgc?.setMicEnabled(true)
                        micUsed = micMode
                        break
                    }
                }
            }
        }

        if (micUsed == "" && micEnabled) {
            Bridge.log("MAN: No available mic found!")
            return
        }

        // go through and disable all mics after the first used one:
        for (micMode in micRanking) {
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

    private fun sendCurrentState() {
        Bridge.log("MAN: sendCurrentState(): $isHeadUp")
        if (screenDisabled) {
            return
        }

        // executor.execute {
        val currentViewState =
                if (isHeadUp) {
                    viewStates[1]
                } else {
                    viewStates[0]
                }

        if (isHeadUp && !contextualDashboard) {
            return
        }

        if (sgc?.type?.contains(DeviceTypes.SIMULATED) == true) {
            // dont send the event to glasses that aren't there:
            return
        }

        var ready = sgc?.ready ?: false
        if (!ready) {
            Bridge.log("MAN: CoreManager.sendCurrentState(): sgc not ready")
            return
        }

        // Cancel any pending clear display work item
        // sendStateWorkItem?.let { mainHandler.removeCallbacks(it) }

        Bridge.log("MAN: parsing layoutType: ${currentViewState.layoutType}")

        when (currentViewState.layoutType) {
            "text_wall" -> sgc?.sendTextWall(currentViewState.text)
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

    fun onRouteChange(reason: String, availableInputs: List<String>) {
        Bridge.log("MAN: onRouteChange: reason: $reason")
        Bridge.log("MAN: onRouteChange: inputs: $availableInputs")

        // Handle external app conflicts - automatically switch to glasses mic if available
        when (reason) {
            "external_app_recording" -> {
                // Another app is using the microphone
                Bridge.log("MAN: External app took microphone - marking onboard mic as unavailable")
                systemMicUnavailable = true
            }
            "external_app_stopped", "audio_focus_available" -> {
                // External app released the microphone
                Bridge.log(
                        "MAN: External app released microphone - marking onboard mic as available"
                )
                systemMicUnavailable = false
                // // Only trigger recovery if we're in automatic/phone mode
                // if (preferredMic == "phone") {
                //     handle_microphone_state_change(currentRequiredData, bypassVadForPCM)
                // }
            }
            "phone_call_interruption" -> {
                // Phone call started - mark mic as unavailable
                Bridge.log("MAN: Phone call interruption - marking onboard mic as unavailable")
                systemMicUnavailable = true
            }
            "phone_call_ended" -> {
                // Phone call ended - mark mic as available again
                Bridge.log("MAN: Phone call ended - marking onboard mic as available")
                systemMicUnavailable = false
            }
            "phone_call_active" -> {
                // Tried to start recording while phone call already active
                Bridge.log("MAN: Phone call already active - marking onboard mic as unavailable")
                systemMicUnavailable = true
            }
            "audio_focus_denied" -> {
                // Another app has audio focus
                Bridge.log("MAN: Audio focus denied - marking onboard mic as unavailable")
                systemMicUnavailable = true
            }
            "permission_denied" -> {
                // Microphone permission not granted
                Bridge.log("MAN: Microphone permission denied - cannot use phone mic")
                systemMicUnavailable = true
                // Don't trigger fallback - need to request permission from user
            }
            else -> {
                // Other route changes (headset plug/unplug, BT connect/disconnect, etc.)
                // Just log for now - may want to handle these in the future
                Bridge.log("MAN: Audio route changed: $reason")
            }
        }

        updateMicState()
    }

    fun onInterruption(began: Boolean) {
        Bridge.log("MAN: Interruption: $began")
        systemMicUnavailable = began
        handle_microphone_state_change(currentRequiredData, bypassVadForPCM)
    }

    // MARK: - State Management

    fun updateHeadUp(headUp: Boolean) {
        isHeadUp = headUp
        sendCurrentState()
        Bridge.sendHeadUp(isHeadUp)
    }

    fun updateContextualDashboard(enabled: Boolean) {
        contextualDashboard = enabled
        handle_request_status()
    }

    fun updatePreferredMic(mic: String) {
        micRanking = MicMap.map[mic]?.toMutableList() ?: MicMap.map["auto"]?.toMutableList() ?: mutableListOf()
        handle_microphone_state_change(currentRequiredData, bypassVadForPCM)
        handle_request_status()
    }

    fun updateButtonMode(mode: String) {
        buttonPressMode = mode
        sgc?.sendButtonModeSetting()
        handle_request_status()
    }

    fun updateButtonPhotoSize(size: String) {
        buttonPhotoSize = size
        sgc?.sendButtonPhotoSettings()
        handle_request_status()
    }

    fun updateGalleryMode(mode: Boolean) {
        galleryMode = mode
        sgc?.sendGalleryMode()
        handle_request_status()
    }

    fun updateButtonVideoSettings(width: Int, height: Int, fps: Int) {
        Log.d("CoreManager", "🎥 [SETTINGS_SYNC] updateButtonVideoSettings called: ${width}x${height}@${fps}fps")
        Log.d("CoreManager", "📱 [SETTINGS_SYNC] Connected device model: $defaultWearable")
        buttonVideoWidth = width
        buttonVideoHeight = height
        buttonVideoFps = fps
        Log.d("CoreManager", "📡 [SETTINGS_SYNC] Sending button video settings to glasses via SGC")
        sgc?.sendButtonVideoRecordingSettings()
        Log.d("CoreManager", "✅ [SETTINGS_SYNC] Button video settings updated to: ${width}x${height}@${fps}fps")
        handle_request_status()
    }

    fun updateButtonCameraLed(enabled: Boolean) {
        buttonCameraLed = enabled
        sgc?.sendButtonCameraLedSetting()
        handle_request_status()
    }

    fun updateButtonMaxRecordingTime(minutes: Int) {
        buttonMaxRecordingTime = minutes
        sgc?.sendButtonMaxRecordingTime()
        handle_request_status()
    }

    fun updateNotificationsBlocklist(blacklist: List<String>) {
        notificationsBlocklist = blacklist
        handle_request_status()
    }

    fun updateNotificationsEnabled(enabled: Boolean) {
        notificationsEnabled = enabled
        handle_request_status()
    }

    fun updateGlassesHeadUpAngle(value: Int) {
        headUpAngle = value
        sgc?.setHeadUpAngle(value)
        handle_request_status()
    }

    fun updateGlassesBrightness(value: Int, autoMode: Boolean) {
        val autoBrightnessChanged = this.autoBrightness != autoMode
        brightness = value
        this.autoBrightness = autoMode

        executor.execute {
            sgc?.setBrightness(value, autoMode)
            if (autoBrightnessChanged) {
                sgc?.sendTextWall(
                        if (autoMode) "Enabled auto brightness" else "Disabled auto brightness"
                )
            } else {
                sgc?.sendTextWall("Set brightness to $value%")
            }
            try {
                Thread.sleep(800)
            } catch (e: InterruptedException) {
                // Ignore
            }
            sgc?.clearDisplay()
        }

        handle_request_status()
    }

    fun updateGlassesDepth(value: Int) {
        dashboardDepth = value
        sgc?.let {
            it.setDashboardPosition(dashboardHeight, dashboardDepth)
            Bridge.log("MAN: Set dashboard depth to $value")
        }
        handle_request_status()
    }

    fun updateGlassesHeight(value: Int) {
        dashboardHeight = value
        sgc?.let {
            it.setDashboardPosition(dashboardHeight, dashboardDepth)
            Bridge.log("MAN: Set dashboard height to $value")
        }
        handle_request_status()
    }

    fun updateSensing(enabled: Boolean) {
        sensingEnabled = enabled
        handle_microphone_state_change(currentRequiredData, bypassVadForPCM)
        handle_request_status()
    }

    fun updatePowerSavingMode(enabled: Boolean) {
        powerSavingMode = enabled
        handle_request_status()
    }

    fun updateAlwaysOnStatusBar(enabled: Boolean) {
        alwaysOnStatusBar = enabled
        handle_request_status()
    }

    fun updateBypassVad(enabled: Boolean) {
        bypassVad = enabled
        handle_request_status()
    }

    fun updateEnforceLocalTranscription(enabled: Boolean) {
        enforceLocalTranscription = enabled

        if (currentRequiredData.contains(SpeechRequiredDataType.PCM_OR_TRANSCRIPTION)) {
            if (enforceLocalTranscription) {
                shouldSendTranscript = true
                shouldSendPcmData = false
            } else {
                shouldSendPcmData = true
                shouldSendTranscript = false
            }
        }

        handle_request_status()
    }

    fun updateOfflineMode(enabled: Boolean) {
        offlineMode = enabled
        Bridge.log("Mentra: updating offline mode $enabled")

        val requiredData = mutableListOf<SpeechRequiredDataType>()
        if (enabled) {
            requiredData.add(SpeechRequiredDataType.TRANSCRIPTION)
        }

        handle_microphone_state_change(requiredData, bypassVadForPCM)
    }

    fun updateBypassAudioEncoding(enabled: Boolean) {
        bypassAudioEncoding = enabled
    }

    fun updateMetricSystem(enabled: Boolean) {
        metricSystem = enabled
        handle_request_status()
    }

    fun updateScreenDisabled(enabled: Boolean) {
        Bridge.log("MAN: Toggling screen disabled: $enabled")
        screenDisabled = enabled
        if (enabled) {
            sgc?.exit()
        } else {
            sgc?.clearDisplay()
        }
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

    fun handleConnectionStateChanged() {
        Bridge.log("MAN: Glasses connection state changed!")

        val currentSgc = sgc ?: return

        if (currentSgc.ready) {
            handleDeviceReady()
        } else {
            handleDeviceDisconnected()
            handle_request_status()
        }
    }

    private fun handleDeviceReady() {
        if (sgc == null) {
            Bridge.log("MAN: SGC is null, returning")
            return
        }

        Bridge.log("MAN: handleDeviceReady() ${sgc?.type}")
        pendingWearable = ""
        defaultWearable = sgc?.type ?: ""

        isSearching = false
        handle_request_status()

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
        // Request battery status after connection
        Thread.sleep(500)
        sgc?.getBatteryStatus()

        // load settings and send the animation:
        // give the glasses some extra time to finish booting:
        // Thread.sleep(1000)
        // await sgc?.setSilentMode(false) // turn off silent mode

        // if shouldSendBootingMessage {
        //     sgc?.sendTextWall("// BOOTING MENTRAOS")
        // }

        // // send loaded settings to glasses:
        // try? await Task.sleep(nanoseconds: 400_000_000)
        // sgc?.setHeadUpAngle(headUpAngle)
        // try? await Task.sleep(nanoseconds: 400_000_000)
        // sgc?.setBrightness(brightness, autoMode: autoBrightness)
        // try? await Task.sleep(nanoseconds: 400_000_000)
        // // self.g1Manager?.RN_setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
        // // try? await Task.sleep(nanoseconds: 400_000_000)
        // //      playStartupSequence()
        // if shouldSendBootingMessage {
        //     sgc?.sendTextWall("// MENTRAOS CONNECTED")
        //     try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
        //     sgc?.clearDisplay()
        // }

        // shouldSendBootingMessage = false

        // handle_request_status()
    }

    private fun handleMach1Ready() {
        // Send startup message
        sgc?.sendTextWall("MENTRAOS CONNECTED")
        Thread.sleep(1000)
        sgc?.clearDisplay()

        handle_request_status()
    }

    private fun handleDeviceDisconnected() {
        Bridge.log("MAN: Device disconnected")
        isHeadUp = false
        lastMicState = null // Clear cache - hardware is definitely off now
        handle_request_status()
    }

    // MARK: - Network Command handlers

    fun handle_display_text(params: Map<String, Any>) {
        (params["text"] as? String)?.let { text ->
            Bridge.log("MAN: Displaying text: $text")
            sgc?.sendTextWall(text)
        }
    }

    fun handle_display_event(event: Map<String, Any>) {
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

        if (!statesEqual(currentState, newViewState)) {
            Bridge.log("MAN: Updating view state $stateIndex with $layoutType")
            viewStates[stateIndex] = newViewState
            if (stateIndex == 0 && !isHeadUp) {
                sendCurrentState()
            } else if (stateIndex == 1 && isHeadUp) {
                sendCurrentState()
            }
        }
    }

    fun handle_show_dashboard() {
        sgc?.showDashboard()
    }

    fun handle_send_rtmp_stream_start(message: MutableMap<String, Any>) {
        Bridge.log("MAN: startRtmpStream")
        sgc?.startRtmpStream(message)
    }

    fun handle_stop_rtmp_stream() {
        Bridge.log("MAN: stopRtmpStream")
        sgc?.stopRtmpStream()
    }

    fun handle_keep_rtmp_stream_alive(message: MutableMap<String, Any>) {
        Bridge.log("MAN: keepRtmpStreamAlive: (message)")
        sgc?.sendRtmpKeepAlive(message)
    }

    fun handle_request_wifi_scan() {
        Bridge.log("MAN: Requesting wifi scan")
        sgc?.requestWifiScan()
    }

    fun handle_send_wifi_credentials(ssid: String, password: String) {
        Bridge.log("MAN: Sending wifi credentials: $ssid")
        sgc?.sendWifiCredentials(ssid, password)
    }

    fun handle_set_hotspot_state(enabled: Boolean) {
        Bridge.log("MAN: Setting glasses hotspot state: $enabled")
        sgc?.sendHotspotState(enabled)
    }

    fun handle_query_gallery_status() {
        Bridge.log("MAN: Querying gallery status from glasses")
        sgc?.queryGalleryStatus()
    }

    fun handle_start_buffer_recording() {
        Bridge.log("MAN: onStartBufferRecording")
        sgc?.startBufferRecording()
    }

    fun handle_stop_buffer_recording() {
        Bridge.log("MAN: onStopBufferRecording")
        sgc?.stopBufferRecording()
    }

    fun handle_save_buffer_video(requestId: String, durationSeconds: Int) {
        Bridge.log("MAN: onSaveBufferVideo: requestId=$requestId, duration=$durationSeconds")
        sgc?.saveBufferVideo(requestId, durationSeconds)
    }

    fun handle_start_video_recording(requestId: String, save: Boolean) {
        Bridge.log("MAN: onStartVideoRecording: requestId=$requestId, save=$save")
        sgc?.startVideoRecording(requestId, save)
    }

    fun handle_stop_video_recording(requestId: String) {
        Bridge.log("MAN: onStopVideoRecording: requestId=$requestId")
        sgc?.stopVideoRecording(requestId)
    }

    fun handle_microphone_state_change(
            requiredData: List<SpeechRequiredDataType>,
            bypassVad: Boolean
    ) {
        // Bridge.log(
        //         "MAN: MIC: changing mic with requiredData: $requiredData bypassVad=$bypassVad
        // offlineMode=$offlineMode"
        // )

        bypassVadForPCM = bypassVad

        shouldSendPcmData = false
        shouldSendTranscript = false

        // This must be done before the requiredData is modified by offline mode
        currentRequiredData.clear()
        currentRequiredData.addAll(requiredData)

        val mutableRequiredData = requiredData.toMutableList()
        if (offlineMode && mutableRequiredData.isNotEmpty &&
                        !mutableRequiredData.contains(
                                SpeechRequiredDataType.PCM_OR_TRANSCRIPTION
                        ) &&
                        !mutableRequiredData.contains(SpeechRequiredDataType.TRANSCRIPTION)
        ) {
            Bridge.log("MAN: MIC: Offline mode active - adding TRANSCRIPTION requirement")
            mutableRequiredData.add(SpeechRequiredDataType.TRANSCRIPTION)
        }

        when {
            mutableRequiredData.contains(SpeechRequiredDataType.PCM) &&
                    mutableRequiredData.contains(SpeechRequiredDataType.TRANSCRIPTION) -> {
                shouldSendPcmData = true
                shouldSendTranscript = true
            }
            mutableRequiredData.contains(SpeechRequiredDataType.PCM) -> {
                shouldSendPcmData = true
                shouldSendTranscript = false
            }
            mutableRequiredData.contains(SpeechRequiredDataType.TRANSCRIPTION) -> {
                shouldSendTranscript = true
                shouldSendPcmData = false
            }
            mutableRequiredData.contains(SpeechRequiredDataType.PCM_OR_TRANSCRIPTION) -> {
                if (enforceLocalTranscription) {
                    shouldSendTranscript = true
                    shouldSendPcmData = false
                } else {
                    shouldSendPcmData = true
                    shouldSendTranscript = false
                }
            }
        }

        vadBuffer.clear()
        micEnabled = mutableRequiredData.isNotEmpty()

        // Bridge.log(
        //         "MAN: MIC: Result - shouldSendPcmData=$shouldSendPcmData,
        // shouldSendTranscript=$shouldSendTranscript, micEnabled=$micEnabled"
        // )

        updateMicState()
    }

    fun handle_photo_request(
            requestId: String,
            appId: String,
            size: String,
            webhookUrl: String,
            authToken: String,
            compress: String
    ) {
        Bridge.log("MAN: onPhotoRequest: $requestId, $appId, $size, compress=$compress")
        sgc?.requestPhoto(requestId, appId, size, webhookUrl, authToken, compress)
    }

    fun handle_rgb_led_control(
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

    fun handle_connect_default() {
        if (defaultWearable.isEmpty()) {
            Bridge.log("MAN: No default wearable, returning")
            return
        }
        if (deviceName.isEmpty()) {
            Bridge.log("MAN: No device name, returning")
            return
        }
        initSGC(defaultWearable)
        isSearching = true
        handle_request_status()
        sgc?.connectById(deviceName)
    }

    fun handle_connect_by_name(dName: String) {
        Bridge.log("MAN: Connecting to wearable: $dName")

        if (pendingWearable.isEmpty() && defaultWearable.isEmpty()) {
            Bridge.log("MAN: No pending or default wearable, returning")
            return
        }

        if (pendingWearable.isEmpty() && !defaultWearable.isEmpty()) {
            Bridge.log("MAN: No pending wearable, using default wearable")
            pendingWearable = defaultWearable
        }

        handle_disconnect()
        Thread.sleep(100)
        isSearching = true
        deviceName = dName

        initSGC(pendingWearable)
        sgc?.connectById(deviceName)
        handle_request_status()
    }

    fun handle_connect_simulated() {
        defaultWearable = DeviceTypes.SIMULATED
        deviceName = DeviceTypes.SIMULATED
        initSGC(defaultWearable)
        handleDeviceReady()
    }

    fun handle_disconnect() {
        sgc?.clearDisplay()
        sgc?.disconnect()
        sgc = null // Clear the SGC reference after disconnect
        isSearching = false
        handle_microphone_state_change(emptyList(), false)
        handle_request_status()
    }

    fun handle_forget() {
        Bridge.log("MAN: Forgetting smart glasses")

        // Call forget first to stop timers/handlers/reconnect logic
        sgc?.forget()

        // Then disconnect to close connections
        sgc?.disconnect()

        // Clear state
        defaultWearable = ""
        deviceName = ""
        sgc = null
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
        isSearching = false
        handle_microphone_state_change(emptyList(), false)
        handle_request_status()
    }

    fun handle_find_compatible_devices(modelName: String) {
        Bridge.log("MAN: Searching for compatible device names for: $modelName")

        if (DeviceTypes.ALL.contains(modelName)) {
            pendingWearable = modelName
        }

        initSGC(pendingWearable)
        Bridge.log("MAN: sgc initialized, calling findCompatibleDevices")
        sgc?.findCompatibleDevices()
        handle_request_status()
    }

    fun handle_request_status() {
        val simulatedConnected = defaultWearable == DeviceTypes.SIMULATED
        val glassesConnected = sgc?.ready ?: false

        if (glassesConnected) {
            isSearching = false
        }

        val glassesSettings = mutableMapOf<String, Any>()
        val glassesInfo = mutableMapOf<String, Any>()

        glassesInfo["connected"] = glassesConnected

        sgc?.let { sgc ->
            glassesInfo["modelName"] = defaultWearable
            glassesInfo["batteryLevel"] = sgc.batteryLevel
            glassesInfo["appVersion"] = sgc.glassesAppVersion
            glassesInfo["buildNumber"] = sgc.glassesBuildNumber
            glassesInfo["deviceModel"] = sgc.glassesDeviceModel
            glassesInfo["androidVersion"] = sgc.glassesAndroidVersion
            glassesInfo["otaVersionUrl"] = sgc.glassesOtaVersionUrl
        }

        if (sgc is G1) {
            glassesInfo["caseRemoved"] = sgc!!.caseRemoved
            glassesInfo["caseOpen"] = sgc!!.caseOpen
            glassesInfo["caseCharging"] = sgc!!.caseCharging
            glassesInfo["caseBatteryLevel"] = sgc!!.caseBatteryLevel

            glassesInfo["serialNumber"] = sgc!!.glassesSerialNumber
            glassesInfo["style"] = sgc!!.glassesStyle
            glassesInfo["color"] = sgc!!.glassesColor
        }

        if (sgc is MentraLive) {
            glassesInfo["wifiSsid"] = sgc!!.wifiSsid
            glassesInfo["wifiConnected"] = sgc!!.wifiConnected
            glassesInfo["wifiLocalIp"] = sgc!!.wifiLocalIp
            glassesInfo["hotspotEnabled"] = sgc!!.isHotspotEnabled
            glassesInfo["hotspotSsid"] = sgc!!.hotspotSsid
            glassesInfo["hotspotPassword"] = sgc!!.hotspotPassword
            glassesInfo["hotspotGatewayIp"] = sgc!!.hotspotGatewayIp
        }

        // Bluetooth device name
        sgc?.getConnectedBluetoothName()?.let { bluetoothName ->
            glassesInfo["bluetoothName"] = bluetoothName
        }

        glassesSettings["brightness"] = brightness
        glassesSettings["auto_brightness"] = autoBrightness
        glassesSettings["dashboard_height"] = dashboardHeight
        glassesSettings["dashboard_depth"] = dashboardDepth
        glassesSettings["head_up_angle"] = headUpAngle
        glassesSettings["button_mode"] = buttonPressMode
        glassesSettings["button_photo_size"] = buttonPhotoSize

        val buttonVideoSettings =
                mapOf(
                        "width" to buttonVideoWidth,
                        "height" to buttonVideoHeight,
                        "fps" to buttonVideoFps
                )
        glassesSettings["button_video_settings"] = buttonVideoSettings
        glassesSettings["button_max_recording_time"] = buttonMaxRecordingTime
        glassesSettings["button_camera_led"] = buttonCameraLed

        val coreInfo =
                mapOf(
                        "default_wearable" to defaultWearable,
                        "preferred_mic" to preferredMic,
                        "is_searching" to isSearching,
                        "is_mic_enabled_for_frontend" to
                                (micEnabled && preferredMic == "glasses" && sgc?.ready == true),
                        "core_token" to coreToken,
                )

        val apps = emptyList<Any>()

        val authObj = mapOf("core_token_owner" to coreTokenOwner)

        val statusObj =
                mapOf(
                        "glasses_info" to glassesInfo,
                        "glasses_settings" to glassesSettings,
                        "apps" to apps,
                        "core_info" to coreInfo,
                        "auth" to authObj
                )

        Bridge.sendStatus(statusObj)
    }

    fun handle_update_settings(settings: Map<String, Any>) {
        Bridge.log("MAN: Received update settings: $settings")

        // Update settings with new values
        (settings["preferred_mic"] as? String)?.let { newPreferredMic ->
            if (preferredMic != newPreferredMic) {
                updatePreferredMic(newPreferredMic)
            }
        }

        (settings["notifications_enabled"] as? Boolean)?.let { newNotificationsEnabled ->
            if (notificationsEnabled != newNotificationsEnabled) {
                updateNotificationsEnabled(newNotificationsEnabled)
            }
        }

        // Head up angle - handle both Int and Double from JavaScript
        (settings["head_up_angle"] as? Number)?.toInt()?.let { newHeadUpAngle ->
            if (headUpAngle != newHeadUpAngle) {
                updateGlassesHeadUpAngle(newHeadUpAngle)
            }
        }

        // Brightness - handle both Int and Double from JavaScript
        (settings["brightness"] as? Number)?.toInt()?.let { newBrightness ->
            if (brightness != newBrightness) {
                updateGlassesBrightness(newBrightness, false)
            }
        }

        // Dashboard height - handle both Int and Double from JavaScript
        (settings["dashboard_height"] as? Number)?.toInt()?.let { newDashboardHeight ->
            if (dashboardHeight != newDashboardHeight) {
                updateGlassesHeight(newDashboardHeight)
            }
        }

        // Dashboard depth - handle both Int and Double from JavaScript
        (settings["dashboard_depth"] as? Number)?.toInt()?.let { newDashboardDepth ->
            if (dashboardDepth != newDashboardDepth) {
                updateGlassesDepth(newDashboardDepth)
            }
        }

        (settings["screen_disabled"] as? Boolean)?.let { screenDisabled ->
            updateScreenDisabled(screenDisabled)
        }

        (settings["auto_brightness"] as? Boolean)?.let { newAutoBrightness ->
            if (autoBrightness != newAutoBrightness) {
                updateGlassesBrightness(brightness, newAutoBrightness)
            }
        }

        (settings["sensing"] as? Boolean)?.let { newSensingEnabled ->
            if (sensingEnabled != newSensingEnabled) {
                updateSensing(newSensingEnabled)
            }
        }

        (settings["power_saving_mode"] as? Boolean)?.let { newPowerSavingMode ->
            if (powerSavingMode != newPowerSavingMode) {
                updatePowerSavingMode(newPowerSavingMode)
            }
        }

        (settings["always_on_status_bar"] as? Boolean)?.let { newAlwaysOnStatusBar ->
            if (alwaysOnStatusBar != newAlwaysOnStatusBar) {
                updateAlwaysOnStatusBar(newAlwaysOnStatusBar)
            }
        }

        (settings["bypass_vad_for_debugging"] as? Boolean)?.let { newBypassVad ->
            if (bypassVad != newBypassVad) {
                updateBypassVad(newBypassVad)
            }
        }

        (settings["enforce_local_transcription"] as? Boolean)?.let { newEnforceLocalTranscription ->
            if (enforceLocalTranscription != newEnforceLocalTranscription) {
                updateEnforceLocalTranscription(newEnforceLocalTranscription)
            }
        }

        (settings["offline_captions_running"] as? Boolean)?.let { newOfflineMode ->
            if (offlineMode != newOfflineMode) {
                updateOfflineMode(newOfflineMode)
            }
        }

        (settings["metric_system"] as? Boolean)?.let { newMetricSystem ->
            if (metricSystem != newMetricSystem) {
                updateMetricSystem(newMetricSystem)
            }
        }

        (settings["contextual_dashboard"] as? Boolean)?.let { newContextualDashboard ->
            if (contextualDashboard != newContextualDashboard) {
                updateContextualDashboard(newContextualDashboard)
            }
        }

        (settings["button_mode"] as? String)?.let { newButtonMode ->
            if (buttonPressMode != newButtonMode) {
                updateButtonMode(newButtonMode)
            }
        }

        // Button video settings - handle both nested object and flat keys
        // First check for nested object structure (from AsyncStorage)
        val videoSettingsObj = settings["button_video_settings"] as? Map<*, *>
        val newWidth = if (videoSettingsObj != null) {
            (videoSettingsObj["width"] as? Number)?.toInt() ?: buttonVideoWidth
        } else {
            // Fallback to flat key structure (backwards compatibility)
            (settings["button_video_width"] as? Number)?.toInt() ?: buttonVideoWidth
        }
        val newHeight = if (videoSettingsObj != null) {
            (videoSettingsObj["height"] as? Number)?.toInt() ?: buttonVideoHeight
        } else {
            (settings["button_video_height"] as? Number)?.toInt() ?: buttonVideoHeight
        }
        val newFps = if (videoSettingsObj != null) {
            (videoSettingsObj["fps"] as? Number)?.toInt() ?: buttonVideoFps
        } else {
            (settings["button_video_fps"] as? Number)?.toInt() ?: buttonVideoFps
        }
        
        // Only update if any value actually changed
        if (newWidth != buttonVideoWidth || newHeight != buttonVideoHeight || newFps != buttonVideoFps) {
            Bridge.log("MAN: Updating button video settings: $newWidth x $newHeight @ ${newFps}fps (was: $buttonVideoWidth x $buttonVideoHeight @ ${buttonVideoFps}fps)")
            updateButtonVideoSettings(newWidth, newHeight, newFps)
        }

        (settings["button_photo_size"] as? String)?.let { newPhotoSize ->
            if (buttonPhotoSize != newPhotoSize) {
                updateButtonPhotoSize(newPhotoSize)
            }
        }

        (settings["button_camera_led"] as? Boolean)?.let { newButtonCameraLed ->
            if (buttonCameraLed != newButtonCameraLed) {
                updateButtonCameraLed(newButtonCameraLed)
            }
        }

        (settings["gallery_mode"] as? Boolean)?.let { newGalleryMode ->
            if (galleryMode != newGalleryMode) {
                updateGalleryMode(newGalleryMode)
            }
        }

        (settings["button_max_recording_time"] as? Int)?.let { newMaxTime ->
            if (buttonMaxRecordingTime != newMaxTime) {
                updateButtonMaxRecordingTime(newMaxTime)
            }
        }

        (settings["notifications_blocklist"] as? List<String>)?.let { newBlocklist ->
            if (notificationsBlocklist != newBlocklist) {
                updateNotificationsBlocklist(newBlocklist)
            }
        }

        (settings["default_wearable"] as? String)?.let { newDefaultWearable ->
            if (defaultWearable != newDefaultWearable) {
                defaultWearable = newDefaultWearable
                Bridge.saveSetting("default_wearable", newDefaultWearable)
            }
        }

        (settings["device_name"] as? String)?.let { newDeviceName ->
            if (deviceName != newDeviceName) {
                deviceName = newDeviceName
            }
        }

        (settings["device_address"] as? String)?.let { newDeviceAddress ->
            if (deviceAddress != newDeviceAddress) {
                deviceAddress = newDeviceAddress
            }
        }
    }

    // MARK: Cleanup
    fun cleanup() {
        // Clean up transcriber resources
        transcriber?.shutdown()
        transcriber = null
    }
}
