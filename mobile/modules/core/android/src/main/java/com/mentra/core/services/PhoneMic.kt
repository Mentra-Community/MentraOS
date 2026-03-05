package com.mentra.core.services

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.*
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import com.mentra.core.utils.MicTypes
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*

class PhoneMic private constructor(private val context: Context) {

    companion object {
        @Volatile private var instance: PhoneMic? = null

        fun getInstance(): PhoneMic {
            return instance
                    ?: synchronized(this) {
                        instance ?: PhoneMic(Bridge.getContext()).also { instance = it }
                    }
        }

        // Audio configuration constants
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val BUFFER_SIZE_MULTIPLIER = 2

        // Debouncing and retry constants
        private const val MODE_CHANGE_DEBOUNCE_MS = 500L
        private const val MAX_SCO_RETRIES = 3
        private const val FOCUS_REGAIN_DELAY_MS = 500L
        private const val SAMSUNG_MIC_TEST_DELAY_MS = 500L
        private const val MIC_SWITCH_DELAY_MS = 300L // Time for CoreManager to switch mics
    }

    // Audio recording components
    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    public val isRecording = AtomicBoolean(false)
    private var preferScoMode = true // Try SCO first, fallback to normal if needed

    // Audio manager and routing
    private val audioManager: AudioManager =
            context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var bluetoothHeadset: BluetoothHeadset? = null

    // Broadcast receivers
    private var audioRouteReceiver: BroadcastReceiver? = null
    private var bluetoothReceiver: BroadcastReceiver? = null

    // Phone call detection
    private var telephonyManager: TelephonyManager? = null
    private var phoneStateListener: PhoneStateListener? = null
    private var isPhoneCallActive = false

    // Audio focus management
    private var audioFocusListener: AudioManager.OnAudioFocusChangeListener? = null
    private var hasAudioFocus = false
    private var audioFocusRequest: AudioFocusRequest? = null // For Android 8.0+

    // Audio recording conflict detection (API 24+)
    private var audioRecordingCallback: AudioManager.AudioRecordingCallback? = null
    private val ourAudioSessionIds = mutableListOf<Int>()
    private var isExternalAudioActive = false

    // State tracking
    private var lastModeChangeTime = 0L
    private var scoRetries = 0
    private var pendingRecordingRequest = false
    private var currentMicMode: String = ""

    // Handler for main thread operations
    private val mainHandler = Handler(Looper.getMainLooper())

    // Coroutine scope for async operations
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    init {
        setupPhoneCallDetection()
        setupAudioFocusListener()
        setupAudioRecordingDetection()
        setupAudioRouteListener()
        setupBluetoothListener()
    }

    // MARK: - Public Methods (Simplified Interface)

    /**
     * Start recording from the phone microphone Will automatically handle SCO mode, conflicts, and
     * fallbacks
     */
    fun startRecording(): Boolean {
        // Ensure we're on main thread for consistency
        if (Looper.myLooper() != Looper.getMainLooper()) {
            var result = false
            runBlocking { withContext(Dispatchers.Main) { result = startRecording() } }
            return result
        }

        // Check if already recording
        if (isRecording.get()) {
            Bridge.log("MIC: Already recording")
            return true
        }

        // Check permissions
        if (!checkPermissions()) {
            Bridge.log("MIC: Microphone permissions not granted")
            notifyCoreManager("permission_denied", emptyList())
            return false
        }

        // Smart debouncing
        val now = System.currentTimeMillis()
        if (now - lastModeChangeTime < MODE_CHANGE_DEBOUNCE_MS) {
            Bridge.log("MIC: Debouncing rapid recording request")
            pendingRecordingRequest = true
            mainHandler.postDelayed(
                    {
                        if (pendingRecordingRequest && !isRecording.get()) {
                            startRecordingInternal()
                        }
                        pendingRecordingRequest = false
                    },
                    MODE_CHANGE_DEBOUNCE_MS
            )
            return false
        }

        return startRecordingInternal()
    }

    /** Stop recording from the phone microphone */
    fun stopRecording() {
        // Ensure we're on main thread for consistency
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runBlocking { withContext(Dispatchers.Main) { stopRecording() } }
            return
        }

        if (!isRecording.get()) {
            return
        }

        Bridge.log("MIC: Stopping recording")

        // Clean up recording
        cleanUpRecording()

        // Abandon audio focus
        abandonAudioFocus()

        // Reset Bluetooth SCO
        if (audioManager.isBluetoothScoOn) {
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
        }

        // Reset audio mode
        audioManager.mode = AudioManager.MODE_NORMAL

        // Notify CoreManager
        notifyCoreManager("recording_stopped", getAvailableInputDevices().values.toList())

        Bridge.log("MIC: Recording stopped")
    }

    fun isRecordingWithMode(mode: String): Boolean {
        return isRecording.get() && currentMicMode == mode
    }

    /**
     * Start recording from a specific microphone type
     * @param mode One of MicTypes constants (PHONE_INTERNAL, BT_CLASSIC, BT)
     * @return true if successfully started recording, false otherwise
     */
    fun startMode(mode: String): Boolean {
        // Ensure we're on main thread for consistency
        if (Looper.myLooper() != Looper.getMainLooper()) {
            var result = false
            runBlocking { withContext(Dispatchers.Main) { result = startMode(mode) } }
            return result
        }

        if (isRecordingWithMode(mode)) {
            return true
        }

        // recording with a different mode, so stop recording and start recording with the new mode:
        if (isRecording.get()) {
            Bridge.log(
                    "MIC: Already recording with different mode ($currentMicMode), stopping first"
            )
            stopRecording()
            // Brief delay to ensure clean stop
            Thread.sleep(50)
        }

        // Check permissions
        if (!checkPermissions()) {
            Bridge.log("MIC: Microphone permissions not granted")
            notifyCoreManager("permission_denied", emptyList())
            return false
        }

        // Smart debouncing
        val now = System.currentTimeMillis()
        if (now - lastModeChangeTime < MODE_CHANGE_DEBOUNCE_MS) {
            Bridge.log("MIC: Debouncing rapid recording request")
            return false
        }

        lastModeChangeTime = System.currentTimeMillis()

        // Check for conflicts
        if (isPhoneCallActive) {
            Bridge.log("MIC: Cannot start recording - phone call active")
            notifyCoreManager("phone_call_active", emptyList())
            return false
        }

        // Request audio focus for all modes (needed to detect Chrome STT)
        if (!requestAudioFocus()) {
            Bridge.log("MIC: Failed to get audio focus")
            if (isSamsungDevice()) {
                testMicrophoneAvailabilityOnSamsung()
            } else {
                notifyCoreManager("audio_focus_denied", emptyList())
            }
            return false
        }

        // Start recording based on mode
        return when (mode) {
            MicTypes.PHONE_INTERNAL -> {
                Bridge.log("MIC: Starting phone internal mic")
                return startRecordingPhoneInternal()
            }
            MicTypes.BT_CLASSIC -> {
                Bridge.log("MIC: Starting Bluetooth Classic (SCO)")
                if (!audioManager.isBluetoothScoAvailableOffCall) {
                    Bridge.log("MIC: Bluetooth SCO not available")
                    notifyCoreManager("bt_classic_unavailable", emptyList())
                    return false
                }
                return startRecordingBtClassic()
            }
            MicTypes.BT -> {
                Bridge.log("MIC: Starting high-quality Bluetooth mic")
                if (!isHighQualityBluetoothAvailable()) {
                    Bridge.log("MIC: High-quality Bluetooth not available")
                    notifyCoreManager("bt_hq_unavailable", emptyList())
                    return false
                }
                return startRecordingBtHighQuality()
            }
            else -> {
                Bridge.log("MIC: Unknown mic type: $mode")
                return false
            }
        }
    }

    
    fun stopMode(mode: String): Boolean {
        if (isRecordingWithMode(mode)) {
            stopRecording()
            return true
        }
        return false
    }

    private fun startRecordingPhoneInternal(): Boolean {
        try {
            Bridge.log("MIC: startRecordingPhoneInternal() - Setting up phone mic ONLY")

            // Use MODE_NORMAL to avoid any Bluetooth routing
            audioManager.mode = AudioManager.MODE_NORMAL
            Bridge.log("MIC: Set audio mode to MODE_NORMAL (${AudioManager.MODE_NORMAL})")

            // Ensure Bluetooth SCO is off
            if (audioManager.isBluetoothScoOn) {
                Bridge.log("MIC: Bluetooth SCO was on, turning it off")
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
            }

            // Disable speaker phone to ensure proper routing
            if (audioManager.isSpeakerphoneOn) {
                Bridge.log("MIC: Speakerphone was on, turning it off")
                audioManager.isSpeakerphoneOn = false
            }

            // Log current audio routing state
            Bridge.log("MIC: Audio state before recording - Mode: ${audioManager.mode}, " +
                      "BT SCO: ${audioManager.isBluetoothScoOn}, " +
                      "Speakerphone: ${audioManager.isSpeakerphoneOn}")

            // EXPERIMENTAL: Skip audio focus for phone internal mic to avoid media routing issues
            // This allows YouTube/Spotify to play normally through speakers
            Bridge.log("MIC: Skipping audio focus request for phone internal mic")

            val success = createAndStartAudioRecord(MediaRecorder.AudioSource.MIC)
            if (success) {
                currentMicMode = MicTypes.PHONE_INTERNAL
                Bridge.log("MIC: Phone internal mic started successfully")
            } else {
                Bridge.log("MIC: Failed to start phone internal mic")
            }
            return success
        } catch (e: Exception) {
            Bridge.log("MIC: Phone internal recording failed: ${e.message}")
            e.printStackTrace()
            return false
        }
    }

    private fun startRecordingBtClassic(): Boolean {
        try {
            // Use MODE_IN_COMMUNICATION for SCO
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

            // Start Bluetooth SCO
            audioManager.startBluetoothSco()
            audioManager.isBluetoothScoOn = true

            // Wait briefly for SCO to connect
            Thread.sleep(100)

            val success = createAndStartAudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            if (success) {
                currentMicMode = MicTypes.BT_CLASSIC
            }
            return success
        } catch (e: Exception) {
            Bridge.log("MIC: BT Classic recording failed: ${e.message}")

            // Clean up SCO
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
            audioManager.mode = AudioManager.MODE_NORMAL

            return false
        }
    }

    private fun startRecordingBtHighQuality(): Boolean {
        try {
            // For high-quality BT devices like AirPods, we want to avoid SCO mode
            // and use the standard microphone source which will route to BT automatically
            audioManager.mode = AudioManager.MODE_NORMAL

            // Ensure SCO is off - we want standard BT audio profile
            if (audioManager.isBluetoothScoOn) {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
            }

            // Use UNPROCESSED if available for highest quality, otherwise MIC
            val audioSource =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        MediaRecorder.AudioSource.UNPROCESSED
                    } else {
                        MediaRecorder.AudioSource.MIC
                    }

            val success = createAndStartAudioRecord(audioSource)
            if (success) {
                currentMicMode = MicTypes.BT
            }
            return success
        } catch (e: Exception) {
            Bridge.log("MIC: BT high-quality recording failed: ${e.message}")
            return false
        }
    }

    private fun isHighQualityBluetoothAvailable(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            // Look for Bluetooth A2DP or LE Audio devices (not just SCO)
            return devices.any { device ->
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                                device.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
            }
        }
        // Fallback: if any Bluetooth audio device is connected
        return bluetoothAdapter?.let { adapter ->
            if (ActivityCompat.checkSelfPermission(
                            context,
                            Manifest.permission.BLUETOOTH_CONNECT
                    ) == PackageManager.PERMISSION_GRANTED
            ) {
                adapter.bondedDevices.any { device ->
                    device.bluetoothClass?.majorDeviceClass ==
                            android.bluetooth.BluetoothClass.Device.Major.AUDIO_VIDEO
                }
            } else {
                false
            }
        }
                ?: false
    }

    // MARK: - Private Methods

    private fun startRecordingInternal(): Boolean {
        lastModeChangeTime = System.currentTimeMillis()

        // Check for conflicts
        if (isPhoneCallActive) {
            Bridge.log("MIC: Cannot start recording - phone call active")
            notifyCoreManager("phone_call_active", emptyList())
            return false
        }

        // Request audio focus
        if (!requestAudioFocus()) {
            Bridge.log("MIC: Failed to get audio focus")
            // On Samsung, test if another app actually needs the mic
            if (isSamsungDevice()) {
                testMicrophoneAvailabilityOnSamsung()
            } else {
                notifyCoreManager("audio_focus_denied", emptyList())
            }
            return false
        }

        // Try SCO mode first (if preferred)
        if (preferScoMode && audioManager.isBluetoothScoAvailableOffCall) {
            Bridge.log("MIC: Attempting to start with Bluetooth SCO")
            if (startRecordingWithSco()) {
                return true
            }
            Bridge.log("MIC: SCO failed, falling back to normal mode")
        }

        // Fallback to normal mode
        return startRecordingNormal()
    }

    private fun startRecordingWithSco(): Boolean {
        try {
            // Use MODE_IN_COMMUNICATION instead of MODE_IN_CALL
            // This allows media playback to coexist with microphone recording
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

            // Start Bluetooth SCO
            audioManager.startBluetoothSco()
            audioManager.isBluetoothScoOn = true

            // Wait briefly for SCO to connect
            Thread.sleep(100)

            return createAndStartAudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        } catch (e: Exception) {
            Bridge.log("MIC: SCO recording failed: ${e.message}")

            // Clean up SCO
            audioManager.stopBluetoothSco()
            audioManager.isBluetoothScoOn = false
            audioManager.mode = AudioManager.MODE_NORMAL

            // Retry logic
            if (scoRetries < MAX_SCO_RETRIES) {
                scoRetries++
                Bridge.log("MIC: Retrying SCO (attempt $scoRetries)")
                return startRecordingWithSco()
            }

            return false
        }
    }

    private fun startRecordingNormal(): Boolean {
        try {
            // Set appropriate audio mode for Samsung devices
            if (isSamsungDevice()) {
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            }

            return createAndStartAudioRecord(MediaRecorder.AudioSource.MIC)
        } catch (e: Exception) {
            Bridge.log("MIC: Normal recording failed: ${e.message}")
            return false
        }
    }

    private fun createAndStartAudioRecord(audioSource: Int): Boolean {
        // Calculate buffer size
        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)

        if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
            Bridge.log("MIC: Failed to get min buffer size")
            return false
        }

        val bufferSize = minBufferSize * BUFFER_SIZE_MULTIPLIER

        // Create AudioRecord
        audioRecord =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    AudioRecord.Builder()
                            .setAudioSource(audioSource)
                            .setAudioFormat(
                                    AudioFormat.Builder()
                                            .setSampleRate(SAMPLE_RATE)
                                            .setChannelMask(CHANNEL_CONFIG)
                                            .setEncoding(AUDIO_FORMAT)
                                            .build()
                            )
                            .setBufferSizeInBytes(bufferSize)
                            .build()
                } else {
                    AudioRecord(audioSource, SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferSize)
                }

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            Bridge.log("MIC: AudioRecord failed to initialize")
            audioRecord?.release()
            audioRecord = null
            return false
        }

        // Register this AudioRecord's session ID
        audioRecord?.let { ourAudioSessionIds.add(it.audioSessionId) }

        // Start recording
        audioRecord?.startRecording()
        isRecording.set(true)

        // Start recording thread
        startRecordingThread(bufferSize)

        // Notify CoreManager
        val activeDevice = getActiveInputDevice() ?: "Unknown"
        Bridge.log("MIC: Started recording from: $activeDevice")
        Bridge.log("MIC: Current audio mode: ${audioManager.mode} (NORMAL=${AudioManager.MODE_NORMAL}, IN_COMM=${AudioManager.MODE_IN_COMMUNICATION}, IN_CALL=${AudioManager.MODE_IN_CALL})")

        // Log detailed routing info for debugging
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioRecord?.routedDevice?.let { device ->
                Bridge.log("MIC: Routed to device - Type: ${device.type}, Name: ${device.productName}")
            }
        }

        notifyCoreManager("recording_started", listOf(activeDevice))

        // Reset retry counter on success
        scoRetries = 0

        return true
    }

    private fun startRecordingThread(bufferSize: Int) {
        recordingThread =
                Thread {
                    android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)

                    val audioBuffer = ShortArray(bufferSize / 2)

                    while (isRecording.get()) {
                        val readResult = audioRecord?.read(audioBuffer, 0, audioBuffer.size) ?: 0

                        if (readResult > 0) {
                            // Convert short array to byte array (16-bit PCM)
                            val pcmData = ByteArray(readResult * 2)
                            val byteBuffer = ByteBuffer.wrap(pcmData).order(ByteOrder.LITTLE_ENDIAN)

                            for (i in 0 until readResult) {
                                byteBuffer.putShort(audioBuffer[i])
                            }

                            // Send PCM data to CoreManager
                            CoreManager.getInstance().handlePcm(pcmData)
                        }
                    }
                }
                        .apply {
                            name = "AudioRecordingThread"
                            start()
                        }
    }

    private fun cleanUpRecording() {
        isRecording.set(false)

        // Stop recording thread
        recordingThread?.interrupt()
        recordingThread = null

        // Stop and release AudioRecord
        audioRecord?.let { record ->
            try {
                // Unregister session ID
                ourAudioSessionIds.remove(record.audioSessionId)

                record.stop()
                record.release()
            } catch (e: Exception) {
                Bridge.log("MIC: Error cleaning up AudioRecord: ${e.message}")
            }
        }
        audioRecord = null
    }

    private fun setupPhoneCallDetection() {
        // Check for phone state permission
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
                        PackageManager.PERMISSION_GRANTED
        ) {
            Bridge.log("MIC: READ_PHONE_STATE permission not granted, skipping call detection")
            return
        }

        telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager

        phoneStateListener =
                object : PhoneStateListener() {
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        val wasCallActive = isPhoneCallActive
                        isPhoneCallActive = (state != TelephonyManager.CALL_STATE_IDLE)

                        if (wasCallActive != isPhoneCallActive) {
                            if (isPhoneCallActive) {
                                Bridge.log("MIC: Phone call started - stopping recording")
                                if (isRecording.get()) {
                                    // Notify CoreManager BEFORE stopping - allows switch to glasses
                                    // mic
                                    notifyCoreManager("phone_call_interruption", emptyList())
                                    // Give CoreManager time to switch to glasses mic
                                    mainHandler.postDelayed(
                                            { stopRecording() },
                                            MIC_SWITCH_DELAY_MS
                                    )
                                } else {
                                    // Not currently recording, but still notify about
                                    // unavailability
                                    notifyCoreManager("phone_call_interruption", emptyList())
                                }
                            } else {
                                Bridge.log("MIC: Phone call ended")
                                notifyCoreManager(
                                        "phone_call_ended",
                                        getAvailableInputDevices().values.toList()
                                )
                            }
                        }
                    }
                }

        telephonyManager?.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
    }

    private fun setupAudioFocusListener() {
        audioFocusListener =
                AudioManager.OnAudioFocusChangeListener { focusChange ->
                    when (focusChange) {
                        AudioManager.AUDIOFOCUS_LOSS -> {
                            Bridge.log("MIC: Permanent audio focus loss - mode: $currentMicMode")
                            hasAudioFocus = false

                            // For phone internal mic, ignore AUDIOFOCUS_LOSS to prevent routing changes
                            // This allows media apps (YouTube, Spotify) to play normally
                            if (currentMicMode == MicTypes.PHONE_INTERNAL) {
                                Bridge.log("MIC: Ignoring AUDIOFOCUS_LOSS for phone internal mic (allows media playback)")
                            } else {
                                // For other modes (BT, etc), respect audio focus loss
                                if (isRecording.get()) {
                                    notifyCoreManager("audio_focus_lost", emptyList())
                                    stopRecording()
                                }
                            }
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                            Bridge.log("MIC: Transient audio focus loss - mode: $currentMicMode, isExternalAudioActive: $isExternalAudioActive")
                            hasAudioFocus = false

                            // For phone internal mic, only stop if we know an external app is actually recording
                            // AUDIOFOCUS_LOSS_TRANSIENT fires for many reasons (app switching, system UI, etc)
                            // AudioRecordingCallback is more reliable for detecting actual mic conflicts
                            if (currentMicMode == MicTypes.PHONE_INTERNAL && isRecording.get()) {
                                if (isExternalAudioActive) {
                                    // External app is already recording (detected by AudioRecordingCallback)
                                    Bridge.log("MIC: AUDIOFOCUS_LOSS_TRANSIENT with external app recording - stopping")
                                    notifyCoreManager("external_app_recording", emptyList())
                                    stopRecording()
                                } else {
                                    // AudioRecordingCallback might fire shortly after AUDIOFOCUS_LOSS_TRANSIENT
                                    // Wait briefly to see if an external app actually starts recording
                                    Bridge.log("MIC: AUDIOFOCUS_LOSS_TRANSIENT - waiting 150ms to check for external app")
                                    mainHandler.postDelayed({
                                        if (isRecording.get() && isExternalAudioActive) {
                                            Bridge.log("MIC: External app detected after delay - stopping")
                                            notifyCoreManager("external_app_recording", emptyList())
                                            stopRecording()
                                        } else if (isRecording.get()) {
                                            Bridge.log("MIC: No external app after delay - continuing recording")
                                        }
                                    }, 150)
                                }
                            } else if (isSamsungDevice() && isRecording.get()) {
                                // Samsung non-phone modes need special handling
                                testMicrophoneAvailabilityOnSamsung()
                            }
                        }
                        AudioManager.AUDIOFOCUS_GAIN -> {
                            Bridge.log("MIC: Regained audio focus")
                            hasAudioFocus = true

                            if (isSamsungDevice()) {
                                isExternalAudioActive = false
                            }

                            // Notify that focus is available again
                            if (!isRecording.get()) {
                                notifyCoreManager(
                                        "audio_focus_available",
                                        getAvailableInputDevices().values.toList()
                                )
                            }
                        }
                    }
                }
    }

    private fun setupAudioRecordingDetection() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            audioRecordingCallback =
                    object : AudioManager.AudioRecordingCallback() {
                        override fun onRecordingConfigChanged(
                                configs: MutableList<AudioRecordingConfiguration>?
                        ) {
                            configs ?: return

                            // Filter out our own recordings
                            val otherAppRecordings =
                                    configs.filter { config ->
                                        !ourAudioSessionIds.contains(config.clientAudioSessionId)
                                    }

                            val wasExternalActive = isExternalAudioActive
                            isExternalAudioActive = otherAppRecordings.isNotEmpty()

                            if (wasExternalActive != isExternalAudioActive) {
                                if (isExternalAudioActive) {
                                    Bridge.log("MIC: External app started recording - isRecording: ${isRecording.get()}")
                                    if (isRecording.get()) {
                                        // Notify CoreManager BEFORE stopping - allows switch to glasses mic
                                        notifyCoreManager("external_app_recording", emptyList())
                                        // Stop IMMEDIATELY to prevent audio corruption with Gboard
                                        stopRecording()
                                    } else {
                                        // Not currently recording, but still notify about
                                        // unavailability
                                        notifyCoreManager("external_app_recording", emptyList())
                                    }
                                } else {
                                    Bridge.log("MIC: External app stopped recording")
                                    // Notify CoreManager that phone mic is available again
                                    notifyCoreManager(
                                            "external_app_stopped",
                                            getAvailableInputDevices().values.toList()
                                    )
                                }
                            }
                        }
                    }

            if (audioRecordingCallback != null) {
                audioManager.registerAudioRecordingCallback(audioRecordingCallback!!, mainHandler)
            }
        }
    }

    private fun setupAudioRouteListener() {
        audioRouteReceiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        when (intent?.action) {
                            AudioManager.ACTION_AUDIO_BECOMING_NOISY -> {
                                Bridge.log("MIC: Audio becoming noisy")
                                handleAudioRouteChange()
                            }
                            AudioManager.ACTION_HEADSET_PLUG -> {
                                val state = intent.getIntExtra("state", -1)
                                if (state == 1) {
                                    Bridge.log("MIC: Headset connected")
                                } else if (state == 0) {
                                    Bridge.log("MIC: Headset disconnected")
                                }
                                handleAudioRouteChange()
                            }
                            AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED -> {
                                val state =
                                        intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)
                                when (state) {
                                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                                        Bridge.log("MIC: Bluetooth SCO connected")
                                        handleAudioRouteChange()
                                    }
                                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                                        Bridge.log("MIC: Bluetooth SCO disconnected")
                                        handleAudioRouteChange()
                                    }
                                }
                            }
                        }
                    }
                }

        val filter =
                IntentFilter().apply {
                    addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
                    addAction(AudioManager.ACTION_HEADSET_PLUG)
                    addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
                }

        context.registerReceiver(audioRouteReceiver, filter)
    }

    private fun setupBluetoothListener() {
        bluetoothReceiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) {
                        when (intent?.action) {
                            BluetoothDevice.ACTION_ACL_CONNECTED -> {
                                val device =
                                        intent.getParcelableExtra<BluetoothDevice>(
                                                BluetoothDevice.EXTRA_DEVICE
                                        )
                                Bridge.log(
                                        "MIC: Bluetooth device connected: ${device?.name ?: "Unknown"}"
                                )
                                handleAudioRouteChange()
                            }
                            BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                                val device =
                                        intent.getParcelableExtra<BluetoothDevice>(
                                                BluetoothDevice.EXTRA_DEVICE
                                        )
                                Bridge.log(
                                        "MIC: Bluetooth device disconnected: ${device?.name ?: "Unknown"}"
                                )
                                handleAudioRouteChange()
                            }
                        }
                    }
                }

        val filter =
                IntentFilter().apply {
                    addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
                    addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
                }

        context.registerReceiver(bluetoothReceiver, filter)
    }

    private fun handleAudioRouteChange() {
        val availableInputs = getAvailableInputDevices().values.toList()
        notifyCoreManager("audio_route_changed", availableInputs)
    }

    private fun requestAudioFocus(): Boolean {
        Bridge.log("MIC: Requesting audio focus with USAGE_VOICE_COMMUNICATION")
        val result =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val audioAttributes =
                            AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                    .build()

                    audioFocusRequest =
                            AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                                    .setAudioAttributes(audioAttributes)
                                    .setOnAudioFocusChangeListener(
                                            audioFocusListener!!,
                                            mainHandler
                                    )
                                    .setAcceptsDelayedFocusGain(false)
                                    .build()

                    audioManager.requestAudioFocus(audioFocusRequest!!)
                } else {
                    audioManager.requestAudioFocus(
                            audioFocusListener,
                            AudioManager.STREAM_VOICE_CALL,
                            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                    )
                }

        hasAudioFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        Bridge.log("MIC: Audio focus ${if (hasAudioFocus) "GRANTED" else "DENIED"}")
        return hasAudioFocus
    }

    private fun abandonAudioFocus() {
        if (!hasAudioFocus) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest!!)
            audioFocusRequest = null
        } else {
            audioManager.abandonAudioFocus(audioFocusListener)
        }

        hasAudioFocus = false
    }

    private fun testMicrophoneAvailabilityOnSamsung() {
        Bridge.log("MIC: Samsung - testing mic availability")

        val currentRecord = audioRecord

        // Temporarily stop recording
        cleanUpRecording()

        // Wait and try to recreate
        mainHandler.postDelayed(
                {
                    if (tryCreateTestAudioRecord()) {
                        Bridge.log("MIC: Samsung - mic available, just playback app")
                        // Restart recording
                        startRecordingInternal()
                    } else {
                        Bridge.log("MIC: Samsung - mic taken by another app")
                        isExternalAudioActive = true
                        notifyCoreManager("samsung_mic_conflict", emptyList())
                    }
                },
                SAMSUNG_MIC_TEST_DELAY_MS
        )
    }

    private fun tryCreateTestAudioRecord(): Boolean {
        var testRecorder: AudioRecord? = null
        try {
            val minBufferSize =
                    AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)

            testRecorder =
                    AudioRecord(
                            MediaRecorder.AudioSource.MIC,
                            SAMPLE_RATE,
                            CHANNEL_CONFIG,
                            AUDIO_FORMAT,
                            minBufferSize
                    )

            return testRecorder.state == AudioRecord.STATE_INITIALIZED
        } catch (e: Exception) {
            return false
        } finally {
            testRecorder?.release()
        }
    }

    private fun isSamsungDevice(): Boolean {
        return Build.MANUFACTURER.equals("samsung", ignoreCase = true)
    }

    private fun checkPermissions(): Boolean {
        return ActivityCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
    }

    private fun getAvailableInputDevices(): Map<String, String> {
        val deviceInfo = mutableMapOf<String, String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            for (device in devices) {
                val name =
                        when (device.type) {
                            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
                            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth Headset"
                            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
                            AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Headset"
                            else -> device.productName.toString()
                        }
                deviceInfo[device.id.toString()] = name
            }
        } else {
            deviceInfo["default"] = "Default Microphone"
            if (audioManager.isBluetoothScoAvailableOffCall) {
                deviceInfo["bluetooth"] = "Bluetooth Headset"
            }
            if (audioManager.isWiredHeadsetOn) {
                deviceInfo["wired"] = "Wired Headset"
            }
        }

        return deviceInfo
    }

    private fun getActiveInputDevice(): String? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioRecord?.routedDevice?.let { device ->
                when (device.type) {
                    AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth Headset"
                    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
                    AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Headset"
                    else -> device.productName.toString()
                }
            }
        } else {
            when {
                audioManager.isBluetoothScoOn -> "Bluetooth Headset"
                audioManager.isWiredHeadsetOn -> "Wired Headset"
                else -> "Built-in Microphone"
            }
        }
    }

    private fun notifyCoreManager(reason: String, availableInputs: List<String>) {
        mainHandler.post {
            CoreManager.getInstance()
                    .onRouteChange(reason = reason, availableInputs = availableInputs)
        }
    }

    fun cleanup() {
        stopRecording()

        // CRITICAL: Force reset audio mode to prevent system-wide Bluetooth audio breakage
        // This ensures that even if stopRecording() failed, we restore normal audio routing
        try {
            if (audioManager.isBluetoothScoOn) {
                Bridge.log("MIC: Force stopping Bluetooth SCO in cleanup")
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
            }

            if (audioManager.mode != AudioManager.MODE_NORMAL) {
                Bridge.log("MIC: Force resetting audio mode to NORMAL in cleanup")
                audioManager.mode = AudioManager.MODE_NORMAL
            }
        } catch (e: Exception) {
            Bridge.log("MIC: Error during audio mode cleanup: ${e.message}")
        }

        // Unregister listeners
        phoneStateListener?.let { telephonyManager?.listen(it, PhoneStateListener.LISTEN_NONE) }

        audioRecordingCallback?.let {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                audioManager.unregisterAudioRecordingCallback(it)
            }
        }

        // Unregister receivers
        try {
            audioRouteReceiver?.let { context.unregisterReceiver(it) }
            bluetoothReceiver?.let { context.unregisterReceiver(it) }
        } catch (e: Exception) {
            Bridge.log("Error unregistering receivers: ${e.message}")
        }

        // Cancel coroutines
        scope.cancel()

        Bridge.log("MIC: Cleaned up")
    }
}