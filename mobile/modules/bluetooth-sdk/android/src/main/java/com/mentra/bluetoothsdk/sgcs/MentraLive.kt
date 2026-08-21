package com.mentra.bluetoothsdk.sgcs

// Mentra
// old augmentos imports:
import android.Manifest
import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ActivityCompat
import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.PhotoSize
import com.mentra.bluetoothsdk.PhotoMode
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.ObservableStore
import com.mentra.bluetoothsdk.debug.BleTraceLogger
import com.mentra.bluetoothsdk.utils.BlePhotoUploadService
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.IncidentLogBleRelayNaming
import com.mentra.bluetoothsdk.utils.IncidentLogBleUploadService
import com.mentra.bluetoothsdk.utils.BleJsonCompact
import com.mentra.bluetoothsdk.utils.BleWireProtocol
import com.mentra.bluetoothsdk.utils.K900LengthCodec
import com.mentra.bluetoothsdk.utils.K900ProtocolUtils
import com.mentra.bluetoothsdk.utils.MessageChunkReassembler
import com.mentra.bluetoothsdk.utils.MessageChunker
import com.mentra.bluetoothsdk.utils.PhoneAudioMonitor
import com.mentra.bluetoothsdk.utils.audio.Lc3Player
import com.mentra.lc3Lib.Lc3Cpp
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.ArrayList
import java.util.Arrays
import java.util.Date
import java.util.HashMap
import java.util.HashSet
import java.util.Locale
import java.util.Random
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.atomic.AtomicLong
import java.util.function.Consumer
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Smart Glasses Communicator for Mentra Live (K900) glasses Uses BLE to communicate with the
 * glasses
 *
 * Note: Mentra Live glasses have no display capabilities, only camera and microphone. All
 * display-related methods are stubbed out and will log a message but not actually display anything.
 */
class MentraLive : SGCManager() {
    private val besOtaHeartbeatGuard = BesOtaHeartbeatGuard()

    companion object {
        private const val TAG = "Live"

        // Feature Flags
        // BLOCK_AUDIO_DUPLEX: When true, suspends LC3 mic while phone is playing audio via A2DP
        // to avoid overloading the MCU. Set to false to allow simultaneous A2DP + LC3 mic.
        private const val BLOCK_AUDIO_DUPLEX = false

        // LC3 frame size for Mentra Live
        private const val LC3_FRAME_SIZE = 40
        private const val VOICE_ACTIVITY_DETECTION_SWITCH_TYPE = 8
        private const val LOUDNESS_GATE_SWITCH_TYPE = 10
        private const val BES2700_MTU_LIMIT = 509

        // L2CAP CoC fast path: new BES2700 firmware registers an LE L2CAP CoC server on this
        // PSM. When the phone opens the channel, the glasses send file packets over it instead
        // of GATT FILE_READ notifications. Phone→glasses traffic stays on GATT.
        private const val L2CAP_FILE_PSM = 0x00C9
        private const val FILE_PACKET_LOG_INTERVAL = 32

        // BLE UUIDs - updated to match K900 BES2800 MCU UUIDs for compatibility with both glass
        // types
        // CRITICAL FIX: Swapped TX and RX UUIDs to match actual usage from central device
        // perspective
        // In BLE, characteristic names are from the perspective of the device that owns them:
        // - From peripheral's perspective: TX is for sending, RX is for receiving
        // - From central's perspective: RX is peripheral's TX, TX is peripheral's RX
        private val SERVICE_UUID: UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb")
        // 000070FF-0000-1000-8000-00805f9b34fb
        private val RX_CHAR_UUID: UUID =
                UUID.fromString(
                        "000070FF-0000-1000-8000-00805f9b34fb"
                ) // Central receives on peripheral's TX
        private val TX_CHAR_UUID: UUID =
                UUID.fromString(
                        "000071FF-0000-1000-8000-00805f9b34fb"
                ) // Central transmits on peripheral's RX
        private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
                UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        // BES => PHONE
        private val FILE_READ_UUID: UUID = UUID.fromString("000072FF-0000-1000-8000-00805f9b34fb")
        private val FILE_WRITE_UUID: UUID = UUID.fromString("000073FF-0000-1000-8000-00805f9b34fb")

        private val LC3_READ_UUID: UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
        private val LC3_WRITE_UUID: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")

        // Reconnection parameters
        private const val BASE_RECONNECT_DELAY_MS =
                500 // Start with 0.5 seconds (faster initial retry)
        private const val MAX_RECONNECT_DELAY_MS = 20000 // Max 20 seconds (more aggressive)
        private const val MAX_RECONNECT_ATTEMPTS = 20 // Increased from 10 for better persistence
        private const val RECONNECT_SCAN_TIMEOUT_MS =
                10000 // 10 seconds for reconnection scans (faster than 60s default)
        private const val POST_SHUTDOWN_RECONNECT_DELAY_MS =
                10_000L // 10s before first scan after shutdown
        private const val SHUTDOWN_RECENT_MS = 45_000L // Consider "recent shutdown" for 45s

        // Keep-alive parameters
        private const val KEEP_ALIVE_INTERVAL_MS = 5000 // 5 seconds
        private const val CONNECTION_TIMEOUT_MS = 30000 // 30 seconds

        // Heartbeat parameters
        private const val HEARTBEAT_INTERVAL_MS = 30000 // 30 seconds
        // Grace period before an unanswered BLE wire v2 handshake is re-armed for retry,
        // and the per-session cap on automatic retries (see sendWireHandshake).
        private const val WIRE_HANDSHAKE_RETRY_GRACE_MS = 5000L
        private const val WIRE_HANDSHAKE_MAX_ATTEMPTS = 3
        private const val BATTERY_REQUEST_EVERY_N_HEARTBEATS = 10 // Every 10 heartbeats (5 minutes)
        private const val RSSI_READ_INTERVAL_MS = 10000L // 10 seconds

        // Micbeat parameters - periodically enable custom audio TX
        private const val MICBEAT_INTERVAL_MS = (1000L * 60) * 30 // micbeat every 30 minutes

        // Device settings
        private const val PREFS_NAME = "MentraLivePrefs"
        private const val PREF_DEVICE_NAME = "LastConnectedDeviceName"

        // Auth settings
        private const val AUTH_PREFS_NAME = "augmentos_auth_prefs"
        private const val KEY_CORE_TOKEN = "core_token"

        private const val MAX_BONDING_RETRIES = 3
        private const val BONDING_RETRY_DELAY_MS =
                1500L // Delay before retry to let user see dialog again

        private const val CORE_TOKEN_MAX_RETRIES = 3
        private const val CORE_TOKEN_RETRY_DELAY_MS = 250L

        // Rate limiting - minimum delay between BLE characteristic writes
        private const val MIN_SEND_DELAY_MS = 160L // 160ms minimum delay (increased from 100ms)
        private const val SIGNIFICANT_BLE_TRACE_DELAY_MS = 250L
        private const val SIGNIFICANT_BLE_TRACE_QUEUE_SIZE = 5

        // File transfer management
        private const val FILE_SAVE_DIR = "MentraLive_Images"

        // Glasses media volume (K900 cs_getvol / cs_vol, sr_getvol / sr_vol)
        private const val GLASSES_MEDIA_VOLUME_TIMEOUT_MS = 2000

        // Message tracking for reliable delivery
        private const val ACK_TIMEOUT_MS = 2000L // 2 seconds
        private const val MAX_RETRY_ATTEMPTS = 3
        private const val RETRY_DELAY_MS = 1000L // 1 second base delay

        // Periodic test message for ACK testing
        private const val TEST_MESSAGE_INTERVAL_MS = 5000 // 5 seconds

        private const val DEBUG_VIDEO_INTERVAL_MS = 5000 // 5 seconds

        // SOC readiness check parameters
        private const val READINESS_CHECK_INTERVAL_MS = 2500 // every 2.5 seconds

        // LC3 Audio Logging and Saving
        private const val LC3_LOGGING_ENABLED = true
        private const val LC3_SAVING_ENABLED = true
        private const val LC3_LOG_DIR = "lc3_audio_logs"

        /** Convert bytes to hex string for debugging */
        private fun bytesToHex(bytes: ByteArray): String {
            val sb = StringBuilder()
            for (b in bytes) {
                sb.append(String.format("%02X ", b))
            }
            return sb.toString()
        }
    }

    var savedDeviceName = ""

    // Local-only fields (not in parent SGCManager)
    private var buildNumberInt = 0 // Build number as integer for version checks
    private var peerWireProtocolVersion = 0
    private var useBinaryWireProtocol = false
    private var wireHandshakeQueued = false
    private var wireHandshakeAttempts = 0
    // Session generation in which the LAST outgoing v2 handshake was sent. A handshake
    // reply only activates v2 when it answers a handshake from the CURRENT epoch - a
    // stale handshake that survived in flight across an epoch reset must not flip the
    // new session to v2 before it negotiated its own build and capabilities.
    private var wireHandshakeSentGeneration = -1
    // Bumped on every BLE session reset; scheduled handshake-retry callbacks capture it
    // and no-op if the session changed, so a timer from a dead session can't poke a new one.
    private var wireSessionGeneration = 0
    // Negotiated K900 STRING length endianness for the phone<->glasses BLE link. Defaults to
    // legacy big-endian; upgraded to little-endian only when the glasses advertise wire_caps.k900_le
    // (or a v2 binary handshake succeeds, which implies wire-v2 LE).
    private var peerK900Le = false
    private var peerWireCapsBinary = false
    private var peerFilePayloadV2 = false
    // Last observed glasses process session id (`sid` in glasses_ready / version_info_1).
    // The BES keeps the BLE link alive across asg_client restarts, so transport state
    // cannot signal a restart - a CHANGED (or newly appearing) sid is the restart signal.
    // Null = no sid observed this BLE session (legacy glasses, or none seen yet).
    private var glassesSessionId: String? = null
    // True once a glasses_ready completed on THIS physical BLE session; resets only with
    // the physical connection (never on heartbeat readiness flaps), so a first-seen sid
    // after an upgrade OTA is always detected as a restart.
    private var readinessCompletedThisBleSession = false
    // Note: appVersion, buildNumber, deviceModel, androidVersion
    // are inherited from SGCManager parent class

    // Version info: Flexible parsing - glasses can send any version_info* message with any fields
    // RN accumulates fields via setGlassesInfo({...state, ...info}) - no chunking/merging needed

    private var reconnectAttempts = 0
    private var isReconnecting = false // Track if we're in reconnection mode
    /**
     * Timestamp when sr_shut (K900 shutdown) was last received; used to delay first reconnect scan
     * so glasses can reboot.
     */
    private var lastShutdownTimeMs = 0L

    // State tracking
    private var context: Context? = null
    // private PublishSubject<JSONObject> dataObservable;
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bluetoothScanner: BluetoothLeScanner? = null
    @Volatile private var bluetoothGatt: BluetoothGatt? = null
    private var connectedDevice: BluetoothDevice? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null
    private var rxCharacteristic: BluetoothGattCharacteristic? = null
    private var lc3ReadCharacteristic: BluetoothGattCharacteristic? = null
    private var lc3WriteCharacteristic: BluetoothGattCharacteristic? = null
    private var handler = Handler(Looper.getMainLooper())
    private val fileProcessingThread =
            HandlerThread("MentraLive-FileProcessing").apply { start() }
    private val fileProcessingHandler = Handler(fileProcessingThread.looper)
    private var scheduler: ScheduledExecutorService? = null
    private var isScanning = false
    private var isConnecting = false
    private var isKilled = false

    // CTKD (Cross-Transport Key Derivation) support for BES devices
    private var isBondingReceiverRegistered = false
    private var isBtClassicConnected = false
    private var bondingReceiver: BroadcastReceiver? = null
    private var bondingRetryCount = 0

    // A2DP profile connection for already-bonded devices
    private var a2dpProfile: BluetoothA2dp? = null
    private var isA2dpProxyRegistered = false

    private data class OutgoingBleCommandTraceInfo(
            val commandType: String,
            val requestId: String?,
            val appId: String?,
            val messageId: Long?
    )

    private data class BleWriteTrace(
            val sequence: Long,
            val commandType: String,
            val requestId: String?,
            val appId: String?,
            val messageId: Long?,
            val chunkId: String?,
            val chunkIndex: Int?,
            val totalChunks: Int?,
            val payloadBytes: Int?,
            val packedBytes: Int,
            val wakeup: Boolean,
            val chunked: Boolean,
            val queuedAtMs: Long
    )

    private data class QueuedBleWrite(
            val data: ByteArray,
            val trace: BleWriteTrace?,
            val sessionGeneration: Long
    )

    private var sendQueue = ConcurrentLinkedQueue<QueuedBleWrite>()
    private val bleWriteTraceSequence = AtomicLong(1)
    private var inFlightBleWriteTrace: BleWriteTrace? = null
    private var inFlightBleWriteStartedAtMs = 0L
    // Queue for serializing BLE descriptor writes (only one GATT operation at a time)
    private val pendingDescriptorWrites = ConcurrentLinkedQueue<BluetoothGattDescriptor>()
    private var isDescriptorWriteInProgress = false
    private var notificationsEnabled =
            false // Track if enableNotifications was already called this connection
    private var connectionTimeoutRunnable: Runnable? = null
    private var connectionTimeoutHandler = Handler(Looper.getMainLooper())
    private var processSendQueueRunnable: Runnable? = null
    private var coreTokenRetryCount = 0
    // Current MTU size
    private var currentMtu = 23 // Default BLE MTU

    // Audio microphone state tracking
    private var shouldUseGlassesMic = false // Whether to use glasses microphone for audio input
    private var isMicrophoneEnabled = false // Track current microphone state

    // LC3 Mic suspend/resume state machine for A2DP conflict avoidance
    // When phone plays audio via A2DP while LC3 mic is active, it overloads the MCU
    // So we temporarily suspend the LC3 mic during phone audio playback
    private var micIntentEnabled = false // User/system WANTS mic enabled
    private var micSuspendedForAudio = false // Mic temporarily suspended due to phone audio
    override val isMicSuspendedForAudio: Boolean
        get() = micSuspendedForAudio
    private var phoneAudioMonitor: PhoneAudioMonitor? = null
    private var micOnCount = 0
    private var micOffCount = 0

    private var lastSendTimeMs = 0L // Timestamp of last send

    // Local state tracking (not in parent SGCManager)
    private var isCharging = false // Charging status (batteryLevel is in parent)
    private var isConnected = false

    // File transfer management
    private var activeFileTransfers = ConcurrentHashMap<String, FileTransferSession>()

    // BLE photo transfer tracking
    private var blePhotoTransfers: MutableMap<String, BlePhotoTransfer> = ConcurrentHashMap()

    /** Expected incident log relay files from glasses (B… firmware, L… logcat). */
    private val bleIncidentLogRelays = ConcurrentHashMap<String, BleIncidentLogRelay>()

    // File packet reassembly buffer for handling fragmented BLE notifications
    // Android BLE stack delivers notifications in MTU-sized chunks (253 bytes with default MTU)
    // iOS CoreBluetooth delivers full packets, so this buffer is only needed on Android
    // Protocol: ## (start) + type + packSize + ... + data + verify + $$ (end)
    private var filePacketBuffer = ByteArray(64 * 1024) // 64KB max buffer
    private var filePacketBufferSize = 0
    private val filePacketBufferLock = Any()
    private var fileReadNotificationCount = 0 // Debug counter for FILE_READ notifications
    private val incomingChunkReassembler = MessageChunkReassembler()

    // L2CAP CoC fast path for incoming file transfers (see L2CAP_FILE_PSM).
    // The channel is read-only; all outgoing messages remain on GATT. When it can't be
    // opened (older firmware, Android < 10), GATT notifications remain the file path.
    private val enableL2capFilePath = true
    private var l2capFileChannel: MentraLiveL2capChannel? = null

    private val connectionLock = Any()

    private var glassesMediaVolumeTimeoutRunnable: Runnable? = null
    private val glassesMediaVolumeLock = Any()
    private var pendingGetGlassesVolumeSuccess: Consumer<Map<String, Any>>? = null
    private var pendingGetGlassesVolumeError: Consumer<String>? = null
    private var pendingSetGlassesVolumeSuccess: Consumer<Map<String, Any>>? = null
    private var pendingSetGlassesVolumeError: Consumer<String>? = null

    private class BlePhotoTransfer(
            var bleImgId: String,
            var requestId: String,
            var webhookUrl: String?
    ) {
        var authToken: String? = null
        var session: FileTransferSession? = null
        var phoneStartTime: Long = System.currentTimeMillis() // When phone received the request
        var bleTransferStartTime: Long = 0 // When BLE transfer actually started
        var glassesCompressionDurationMs: Long = 0 // How long glasses took to compress
    }

    private enum class BleIncidentLogKind {
        FIRMWARE,
        LOGCAT
    }

    private class BleIncidentLogRelay(
            val fileBaseKey: String,
            val incidentId: String,
            val apiBaseUrl: String,
            val kind: BleIncidentLogKind
    ) {
        var session: FileTransferSession? = null
    }

    // Inner class to track incoming file transfers
    private class FileTransferSession(var fileName: String, var fileSize: Int) {
        // NOTE: fileSize may be "fake" (inflated) due to BES firmware workaround
        var actualPackSize =
                0 // Actual pack size from first received packet (for BES lie detection)
        var totalPackets: Int
        var expectedNextPacket = 0
        var receivedPackets = ConcurrentHashMap<Int, ByteArray>()
        var startTime: Long = System.currentTimeMillis()
        var isComplete = false
        var isAnnounced = false

        companion object {
            // BES2700 firmware hardcodes FILE_PACK_SIZE=400 when calculating totalPack.
            // We "lie" about fileSize to make BES expect correct packet count.
            // This constant must match the one in asg_client's FileTransferSession.
            private const val BES_HARDCODED_PACK_SIZE = 400
        }

        init {
            // Initialize with max expected packets - will be recalculated on first packet
            totalPackets =
                    (fileSize + K900ProtocolUtils.FILE_PACK_SIZE - 1) /
                            K900ProtocolUtils.FILE_PACK_SIZE
        }

        /**
         * Recalculate total packets based on actual pack size from received packet. Called when
         * first packet is received to handle variable pack sizes.
         *
         * NOTE: Due to BES firmware workaround, fileSize in header may be "fake" (inflated). We
         * detect this by checking if fileSize is a multiple of 400 (BES_HARDCODED_PACK_SIZE). If
         * so, totalPackets = fileSize / 400, regardless of actual pack size.
         */
        fun recalculateTotalPackets(actualPackSize: Int) {
            if (actualPackSize <= 0 || actualPackSize > K900ProtocolUtils.FILE_PACK_SIZE) {
                return
            }

            this.actualPackSize = actualPackSize

            // Detect BES lie: if fileSize is exact multiple of 400, glasses used the lie strategy
            val isBesLie =
                    (fileSize % BES_HARDCODED_PACK_SIZE == 0) &&
                            (actualPackSize != BES_HARDCODED_PACK_SIZE)

            val newTotalPackets: Int
            if (isBesLie) {
                // BES lie detected: totalPackets = fileSize / 400
                newTotalPackets = fileSize / BES_HARDCODED_PACK_SIZE
                Log.i(
                        "FileTransferSession",
                        "📦 BES Lie detected! fakeFileSize=" +
                                fileSize +
                                ", totalPackets=" +
                                newTotalPackets +
                                ", actualPackSize=" +
                                actualPackSize
                )
            } else {
                // Normal case: calculate based on actual pack size
                newTotalPackets = (fileSize + actualPackSize - 1) / actualPackSize
            }

            if (newTotalPackets != totalPackets) {
                Log.i(
                        "FileTransferSession",
                        "📦 Recalculating totalPackets: " +
                                totalPackets +
                                " -> " +
                                newTotalPackets +
                                " (packSize=" +
                                actualPackSize +
                                ", fileSize=" +
                                fileSize +
                                ")"
                )
                totalPackets = newTotalPackets
            }
        }

        fun addPacket(index: Int, data: ByteArray): Boolean {
            if (index >= 0 && index < totalPackets && !receivedPackets.containsKey(index)) {
                receivedPackets[index] = data

                // Update expected next packet if this was the one we were waiting for
                while (receivedPackets.containsKey(expectedNextPacket)) {
                    expectedNextPacket++
                }

                // Check if complete
                isComplete = (receivedPackets.size == totalPackets)
                return true
            }
            return false
        }

        // Check if this is the final packet (highest index we expect)
        fun isFinalPacket(index: Int): Boolean {
            return index == (totalPackets - 1)
        }

        // Check if we should trigger completion check (either complete or final packet received)
        fun shouldCheckCompletion(receivedIndex: Int): Boolean {
            return isComplete || isFinalPacket(receivedIndex)
        }

        // Get list of missing packet indices
        fun getMissingPackets(): MutableList<Int> {
            val missing = ArrayList<Int>()
            for (i in 0 until totalPackets) {
                if (!receivedPackets.containsKey(i)) {
                    missing.add(i)
                }
            }
            return missing
        }

        /**
         * Assemble file from received packets. NOTE: We calculate actual file size from received
         * data, NOT from header fileSize, because fileSize may be "fake" (inflated) due to BES
         * firmware workaround.
         */
        fun assembleFile(): ByteArray? {
            if (!isComplete) {
                return null
            }

            // Calculate actual file size by summing all received packet sizes
            var actualFileSize = 0
            for (i in 0 until totalPackets) {
                val packet = receivedPackets[i]
                if (packet != null) {
                    actualFileSize += packet.size
                }
            }

            Log.i(
                    "FileTransferSession",
                    "📦 Assembling file: headerFileSize=" +
                            fileSize +
                            ", actualFileSize=" +
                            actualFileSize +
                            ", totalPackets=" +
                            totalPackets
            )

            val fileData = ByteArray(actualFileSize)
            var offset = 0

            for (i in 0 until totalPackets) {
                val packet = receivedPackets[i]
                if (packet != null) {
                    System.arraycopy(packet, 0, fileData, offset, packet.size)
                    offset += packet.size
                }
            }

            return fileData
        }
    }

    // Note: WiFi state (wifiConnected, wifiSsid, wifiLocalIp) and hotspot state
    // (isHotspotEnabled, hotspotSsid, hotspotPassword, hotspotGatewayIp)
    // are inherited from SGCManager parent class

    // Heartbeat tracking
    private var heartbeatHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private var heartbeatCounter = 0
    private var glassesReady = false

    // RSSI tracking
    private var rssiReadHandler = Handler(Looper.getMainLooper())
    private var rssiReadRunnable: Runnable? = null
    private var rssiReadInProgress = false

    // BES OTA progress tracking - only send to UI on 5% increments
    private var lastBesOtaProgress = -1

    // Cached OTA session context from last ota_status — used to fill in session fields for sr_adota
    private var cachedOtaSessionId: String? = null
    private var cachedOtaTotalSteps = 0
    private var cachedOtaCurrentStep = 0
    /**
     * Step type sequence (e.g. ["apk","bes"]) from last ota_status; used to compute BES weight in
     * sr_adota.
     */
    private var cachedOtaStepSequence: JSONArray? = null
    private var rgbLedAuthorityClaimed = false // Track if we've claimed RGB LED control from BES

    // Audio Pairing: Track readiness separately for BLE and audio (matches iOS implementation)
    private var glassesReadyReceived = false
    private var audioConnected = false

    // Micbeat tracking - periodically enable custom audio TX
    private var micBeatHandler = Handler(Looper.getMainLooper())
    private var micBeatRunnable: Runnable? = null
    private var micBeatCount = 0

    // Message tracking for reliable delivery
    private val pendingMessages = ConcurrentHashMap<Long, PendingMessage>()
    private val messageIdCounter = AtomicLong(1)
    private val bleSessionGeneration = AtomicLong(0)

    // Esoteric message ID generation
    private val secureRandom = SecureRandom()
    private val deviceId = System.currentTimeMillis() xor Random().nextLong()

    private var lastReceivedLc3Sequence: Byte = -1
    private var lc3SequenceNumber: Byte = 0
    private var lc3DecoderPtr = 0L
    private var lc3AudioPlayer: Lc3Player? = null
    // Audio playback control - allows monitoring glasses microphone through phone speakers
    // Set to true to enable playback, false to disable. Independent of microphone state.
    private var audioPlaybackEnabled = false
    // Rolling recording control - saves last 20 seconds of audio as M4A file every 20 seconds
    // Set to true to enable rolling recording, false to disable.
    private var rollingRecordingEnabled = false

    private var testMessageHandler = Handler(Looper.getMainLooper())
    private var testMessageRunnable: Runnable? = null
    private var testMessageCounter = 0

    // Pending message data structure
    private class PendingMessage(
            val messageData: String,
            val timestamp: Long,
            val retryCount: Int,
            val retryRunnable: Runnable,
            val sessionGeneration: Long
    )

    private var lc3AudioFileStream: FileOutputStream? = null
    private var currentLc3FileName: String? = null
    private var totalLc3PacketsReceived = 0
    private var totalLc3BytesReceived = 0
    private var firstLc3PacketTime = 0L
    private var lastLc3PacketTime = 0L
    private val lc3TimestampFormat = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US)
    private val lc3PacketTimestampFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    init {
        this.type = DeviceTypes.LIVE
        this.hasMic = true
        this.context = Bridge.getContext()

        // Initialize bluetooth adapter
        val bluetoothManager =
                context!!.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
        if (bluetoothManager != null) {
            bluetoothAdapter = bluetoothManager.adapter
        }

        // Initialize connection state
        DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)

        // Initialize CTKD bonding receiver
        initializeBondingReceiver()

        // Initialize the send queue processor
        processSendQueueRunnable = Runnable {
            processSendQueue()
            // Don't reschedule here - let processSendQueue and onCharacteristicWrite handle
            // scheduling
        }

        // Initialize heartbeat runnable
        heartbeatRunnable =
                object : Runnable {
                    override fun run() {
                        sendHeartbeat()
                        // Schedule next heartbeat
                        heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS.toLong())
                    }
                }

        rssiReadRunnable =
                object : Runnable {
                    override fun run() {
                        requestSignalStrength()
                        rssiReadHandler.postDelayed(this, RSSI_READ_INTERVAL_MS)
                    }
                }

        // Initialize test message runnable for ACK testing
        // testMessageRunnable = new Runnable() {
        //     @Override
        //     public void run() {
        //         sendTestMessage();
        //         // Schedule next test message
        //         testMessageHandler.postDelayed(this, TEST_MESSAGE_INTERVAL_MS);
        //     }
        // };

        // Initialize scheduler for keep-alive and reconnection
        scheduler = Executors.newScheduledThreadPool(1)

        // Setup LC3 player for audio monitoring
        // Initialize with frame size matching MentraLive LC3_FRAME_SIZE
        lc3AudioPlayer = Lc3Player(context, LC3_FRAME_SIZE)
        lc3AudioPlayer!!.init()

        // Enable rolling recording if configured
        if (rollingRecordingEnabled) {
            lc3AudioPlayer!!.enableRollingRecording(true)
            Bridge.log("LIVE: 🎙️ Rolling audio recording enabled (saves 20-sec files)")
        }

        // Start playback only if audioPlaybackEnabled is true
        if (audioPlaybackEnabled) {
            lc3AudioPlayer!!.startPlay()
            Bridge.log(
                    "LIVE: 🔊 LC3 audio player started (frame size: " + LC3_FRAME_SIZE + " bytes)"
            )
        } else {
            Bridge.log(
                    "LIVE: 🔊 LC3 audio player initialized but playback disabled (frame size: " +
                            LC3_FRAME_SIZE +
                            " bytes)"
            )
        }

        // setup LC3 decoder for PCM conversion
        if (lc3DecoderPtr == 0L) {
            lc3DecoderPtr = Lc3Cpp.initDecoder()
            Bridge.log("LIVE: Initialized LC3 decoder for PCM conversion: " + lc3DecoderPtr)
        }

        // Initialize phone audio monitor for LC3 mic suspend/resume (if enabled)
        // This detects when phone is playing audio and temporarily suspends LC3 mic
        // to avoid overloading the MCU when both A2DP output and LC3 mic input are active
        if (BLOCK_AUDIO_DUPLEX) {
            phoneAudioMonitor = PhoneAudioMonitor.getInstance(context!!)
            phoneAudioMonitor!!.startMonitoring(
                    object : PhoneAudioMonitor.Listener {
                        override fun onPhoneAudioStateChanged(isPlaying: Boolean) {
                            handlePhoneAudioStateChanged(isPlaying)
                        }
                    }
            )
            Bridge.log(
                    "LIVE: 🎵 Phone audio monitor started for LC3 mic suspend/resume (BLOCK_AUDIO_DUPLEX=true)"
            )
        } else {
            Bridge.log("LIVE: 🎵 Phone audio monitor disabled (BLOCK_AUDIO_DUPLEX=false)")
        }
    }

    override fun cleanup() {
        Bridge.log("LIVE: Cleaning up MentraLiveSGC")
        destroy()
    }

    /**
     * Compute the weighted overall OTA percentage for a BES progress event arriving via sr_adota.
     * Mirrors the weight table in OtaSessionManager.computeOverallPercent() / computeStepWeights().
     *
     * Weight assignments: [apk, mtk, bes] → bes base=50, weight=50 [apk, bes] → bes base=20,
     * weight=80 [mtk, bes] → bes base=40, weight=60 [bes] → bes base=0, weight=100
     *
     * Falls back to raw besProgress when step sequence is unavailable.
     */
    private fun computeBesOverallPercent(
            besProgress: Int,
            totalSteps: Int,
            stepSequence: JSONArray?
    ): Int {
        if (stepSequence == null || stepSequence.length() == 0) {
            return besProgress // no context, fall back to raw
        }
        var hasApk = false
        var hasMtk = false
        for (i in 0 until stepSequence.length()) {
            val t = stepSequence.optString(i, "")
            if ("apk" == t) hasApk = true else if ("mtk" == t) hasMtk = true
        }
        val base: Int
        val weight: Int
        if (hasApk && hasMtk) {
            base = 50
            weight = 50
        } else if (hasApk) {
            base = 20
            weight = 80
        } else if (hasMtk) {
            base = 40
            weight = 60
        } else {
            base = 0
            weight = 100
        }
        return Math.min(100, base + besProgress * weight / 100)
    }

    private fun updateConnectionState(state: String) {
        val isEqual = state == connectionState
        if (isEqual) {
            if (state == ConnTypes.DISCONNECTED) {
                resetWireNegotiationState()
                resetPendingAckState()
                // Queued writes are session-bound: transmitting them into the NEXT session
                // (e.g. a stale handshake whose reply activates v2 before the new session
                // negotiated) is the bug class this clear removes. Higher layers re-send
                // what still matters via their own ACK/retry tracking.
                sendQueue.clear()
            }
            return
        }

        if (state == ConnTypes.DISCONNECTED) {
            // Device identity is session-bound. Clear it on disconnect so a previous pair's
            // identifiers can never be associated with the next connection. Connect must NOT
            // clear them: DeviceManager.disconnect already wipes them before any new connection,
            // and clearing on CONNECTED would wipe still-valid identity mid-session when a
            // same-link glasses_ready (e.g. ASG restart) re-publishes CONNECTED.
            DeviceStore.apply("glasses", "serialNumber", "")
            DeviceStore.apply("glasses", "bluetoothMacAddress", "")
        }

        // Actually update the connection state!
        DeviceStore.apply("glasses", "connectionState", state)

        if (state == ConnTypes.CONNECTED) {
            DeviceStore.apply("glasses", "connected", true)
            if (glassesReadyReceived) {
                DeviceStore.apply("glasses", "fullyBooted", true)
            }
            // Drop cached version fields from the previous BLE session so the next version_info
            // repopulates RN. Otherwise a stale build (e.g. 38) can remain while ASG is still 36,
            // and the phone-side OTA manifest check will compare against the wrong build.
            DeviceStore.apply("glasses", "buildNumber", "")
            DeviceStore.apply("glasses", "appVersion", "")
            DeviceStore.apply("glasses", "besFirmwareVersion", "")
            DeviceStore.apply("glasses", "mtkFirmwareVersion", "")
            // Modern ASG builds omit ota_version_url entirely (the phone owns manifest
            // selection), and the chunked parser only writes present fields — clear it here so
            // a URL reported by a previous build cannot leak into this session.
            DeviceStore.apply("glasses", "otaVersionUrl", "")
            Bridge.log("LIVE: Cleared cached version_info fields for fresh session")
        }

        if (state == ConnTypes.DISCONNECTED) {
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
            DeviceStore.apply("glasses", "signalStrength", -1)
            DeviceStore.apply("glasses", "signalStrengthUpdatedAt", 0L)
            resetWireNegotiationState()
            resetPendingAckState()
            sendQueue.clear() // see the disconnect reset above: stale writes die with the session

            // Drop OTA caches when fully disconnected — avoids leaking session/step state
            // from a previous pairing into the next one.
            resetOtaCache()
        }
    }

    /**
     * Drops cached OTA session context. Called on disconnect and when a new session id arrives —
     * without this, stale fields from a previous session would leak into sr_adota progress messages
     * (wrong totalSteps, wrong stepSequence, stale lastBesOtaProgress that swallows the first few
     * percent of the new install).
     */
    private fun resetOtaCache() {
        cachedOtaSessionId = null
        cachedOtaTotalSteps = 0
        cachedOtaCurrentStep = 0
        cachedOtaStepSequence = null
        lastBesOtaProgress = -1
        // The bounded UART-ownership lease is transport state, not session-cache state. Keep it
        // through a BLE reconnect so heartbeats cannot resume while BES still owns the UART.
    }

    private fun updateBesOtaHeartbeatGuard(stepType: String, phase: String, status: String) {
        besOtaHeartbeatGuard.observeOtaStatus(
            stepType,
            phase,
            status,
            SystemClock.elapsedRealtime(),
        )
    }

    protected fun setFontSizes() {
        // LARGE_FONT = 3;
        // MEDIUM_FONT = 2;
        // SMALL_FONT = 1;
    }

    /** Starts BLE scanning for Mentra Live glasses */
    private fun startScan() {
        if (bluetoothAdapter == null || isScanning) {
            return
        }

        bluetoothScanner = bluetoothAdapter!!.bluetoothLeScanner
        if (bluetoothScanner == null) {
            Log.e(TAG, "BLE scanner not available")
            return
        }

        // Configure scan settings
        val settings =
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()

        // Set up filters for both standard "Xy_A" and K900 "XyBLE_" device names
        val filters = ArrayList<ScanFilter>()

        // Standard glasses filter
        val standardFilter =
                ScanFilter.Builder()
                        .setDeviceName("Xy_A") // Name for standard glasses BLE peripheral
                        .build()
        // filters.add(standardFilter);

        // K900/Mentra Live glasses filter
        val k900Filter =
                ScanFilter.Builder()
                        .setDeviceName("XyBLE_") // Name for K900/Mentra Live glasses
                        .build()
        // filters.add(k900Filter);

        // Start scanning
        try {
            // Use different timeout based on whether we're reconnecting
            val scanTimeout = if (isReconnecting) RECONNECT_SCAN_TIMEOUT_MS.toLong() else 60000L

            if (isReconnecting) {
                Log.i(
                        TAG,
                        "🔌 ⚡ FAST RECONNECT SCAN - timeout: " +
                                scanTimeout +
                                "ms (attempt #" +
                                reconnectAttempts +
                                ")"
                )
                Bridge.log(
                        "LIVE: Starting FAST BLE scan for reconnection (timeout: " +
                                scanTimeout +
                                "ms)"
                )
            } else {
                Bridge.log(
                        "LIVE: Starting BLE scan for Mentra Live glasses (timeout: " +
                                scanTimeout +
                                "ms)"
                )
            }

            isScanning = true
            bluetoothScanner!!.startScan(filters, settings, scanCallback)

            // Set a timeout to stop scanning
            handler.postDelayed(
                    object : Runnable {
                        override fun run() {
                            if (isScanning) {
                                stopScan()
                                emitStopScanEvent()

                                if (isReconnecting) {
                                    synchronized(connectionLock) {
                                        // If scanCallback already claimed a connection, don't start
                                        // another reconnect cycle
                                        if (isConnecting || isConnected) {
                                            Log.i(
                                                    TAG,
                                                    "🔌 Scan timeout fired but connection already in progress, skipping reconnect"
                                            )
                                            return
                                        }
                                    }
                                    // Clear the reconnection latch before scheduling the next
                                    // attempt.
                                    // Otherwise handleReconnection() immediately aborts with
                                    // "already reconnecting".
                                    isReconnecting = false
                                    Log.i(
                                            TAG,
                                            "🔌 ⏰ Reconnect scan timed out - scheduling next reconnect attempt"
                                    )
                                    Bridge.log(
                                            "LIVE: 🔌 ⏰ Reconnect scan timed out - scheduling next reconnect attempt"
                                    )
                                    handleReconnection()
                                }
                            }
                        }
                    },
                    scanTimeout
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error starting BLE scan", e)
            isScanning = false
        }
    }

    /** Stops BLE scanning */
    override fun stopScan() {
        if (bluetoothAdapter == null || bluetoothScanner == null || !isScanning) {
            return
        }

        try {
            bluetoothScanner!!.stopScan(scanCallback)
            isScanning = false
            DeviceStore.apply("bluetooth", "searching", false)
            Bridge.log("LIVE: BLE scan stopped")

            // Post event only if we haven't been destroyed
            // if (smartGlassesDevice != null) {
            // EventBus.getDefault().post(new
            // GlassesBluetoothSearchStopEvent(smartGlassesDevice.deviceModelName));
            // }
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping BLE scan", e)
            // Ensure isScanning is false even if stop failed
            isScanning = false
        }
    }

    private fun emitStopScanEvent() {
        val body = HashMap<String, Any>()
        body["deviceModel"] = DeviceTypes.LIVE
        Bridge.sendTypedMessage("compatible_glasses_search_stop", body)
    }

    var seenDevices: MutableSet<String> = HashSet()

    /** BLE Scan callback */
    private val scanCallback: ScanCallback =
            object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    // Check if the object has been destroyed to prevent NPE
                    if (context == null || isKilled) {
                        Bridge.log("LIVE: Ignoring scan result - object destroyed or killed")
                        return
                    }

                    val device = result.device
                    if (device == null) {
                        return
                    }

                    var deviceName: String? = null
                    try {
                        deviceName = device.name
                    } catch (e: SecurityException) {
                        Bridge.log("LIVE: Missing permission to read BLE device name: " + e.message)
                    }
                    if (deviceName == null && result.scanRecord != null) {
                        deviceName = result.scanRecord!!.deviceName
                    }
                    if (deviceName == null) {
                        return
                    }

                    val deviceAddress = device.address

                    // String device = deviceName + deviceAddress;
                    // if (!seenDevices.contains(device)) {
                    //     seenDevices.add(device);
                    //     Bridge.log("LIVE: Found BLE device: " + deviceName + " (" + deviceAddress
                    // + ")");
                    // }

                    // Check if this device matches the saved device name
                    // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME,
                    // Context.MODE_PRIVATE);
                    // String savedDeviceName = prefs.getString(PREF_DEVICE_NAME, null);

                    // Post the discovered device to the event bus ONLY
                    // Don't automatically connect - wait for explicit connect request from UI
                    if (deviceName == "Xy_A" ||
                                    deviceName.startsWith("XyBLE_") ||
                                    deviceName.startsWith("MENTRA_LIVE_BLE") ||
                                    deviceName.startsWith("MENTRA_LIVE_BT") ||
                                    deviceName.lowercase().startsWith("mentra_live")
                    ) {
                        val glassType = if (deviceName == "Xy_A") "Standard" else "K900"
                        Bridge.log(
                                "LIVE: Found compatible " +
                                        glassType +
                                        " glasses device: " +
                                        deviceName
                        )
                        // EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(
                        // smartGlassesDevice.deviceModelName, deviceName));
                        Bridge.sendDiscoveredDevice(
                                DeviceTypes.LIVE,
                                deviceName,
                                deviceAddress,
                                result.rssi
                        )

                        // If this is the specific device we want to connect to by name, connect to
                        // it
                        if (savedDeviceName != null && savedDeviceName == deviceName) {
                            Log.i(
                                    TAG,
                                    "🔌 🎯 RECONNECT TARGET FOUND - Device: " +
                                            deviceName +
                                            " (Attempt #" +
                                            reconnectAttempts +
                                            ")"
                            )
                            Bridge.log(
                                    "LIVE: 🔌 🎯 Found our remembered device by name, connecting: " +
                                            deviceName +
                                            " (Reconnect attempt #" +
                                            reconnectAttempts +
                                            ")"
                            )
                            synchronized(connectionLock) {
                                if (isConnected || isConnecting) {
                                    return
                                }
                                isConnecting = true
                            }
                            stopScan()
                            emitStopScanEvent()
                            isReconnecting = false
                            connectToDevice(device)
                        }
                    }
                }

                override fun onScanFailed(errorCode: Int) {
                    Log.e(TAG, "BLE scan failed with error: " + errorCode)
                    isScanning = false
                    if (isReconnecting && !isKilled) {
                        isReconnecting = false
                        Bridge.log(
                                "LIVE: 🔌 ❌ Reconnect scan failed - scheduling next reconnect attempt"
                        )
                        handleReconnection()
                    }
                }
            }

    /**
     * device.getName() requires BLUETOOTH_CONNECT on Android 12+ and throws SecurityException when
     * not granted. Auto-reconnect paths fire before permissions are requested in some flows
     * (MENTRA-OS-21Y).
     */
    private fun safeDeviceName(device: BluetoothDevice?): String {
        if (device == null) return ""
        try {
            val name = device.name
            return if (name != null) name else ""
        } catch (e: SecurityException) {
            return ""
        } catch (e: Exception) {
            return ""
        }
    }

    /**
     * Safely tear down the GATT reference. Avoids NPE / races with gatt callbacks disconnecting on
     * a binder thread while a queued teardown runnable fires. Pass disconnect=true to call
     * disconnect() before close().
     */
    @Synchronized
    private fun closeGattQuietly(disconnect: Boolean) {
        val gatt = bluetoothGatt
        bluetoothGatt = null
        if (gatt == null) {
            return
        }
        try {
            if (disconnect) {
                gatt.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "🔌 closeGattQuietly: disconnect threw " + e)
        }
        try {
            gatt.close()
        } catch (e: Exception) {
            Log.w(TAG, "🔌 closeGattQuietly: close threw " + e)
        }
    }

    /**
     * Reject callbacks delivered by a GATT object from an earlier connection attempt. Without
     * this identity check, a late disconnect can tear down the active connection and clear its
     * session-bound send state.
     */
    private fun isCurrentGattCallback(gatt: BluetoothGatt): Boolean {
        if (gatt === bluetoothGatt) {
            return true
        }

        Log.w(TAG, "🔌 Ignoring callback from stale BluetoothGatt")
        Bridge.log("LIVE: 🔌 Ignoring callback from stale BluetoothGatt session")
        try {
            gatt.close()
        } catch (e: Exception) {
            Log.w(TAG, "🔌 Failed to close stale BluetoothGatt: " + e)
        }
        return false
    }

    /** Connect to a specific BLE device */
    private fun connectToDevice(device: BluetoothDevice?) {
        if (device == null) {
            return
        }

        // Cancel any previous connection timeouts
        if (connectionTimeoutRunnable != null) {
            connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable!!)
        }

        // Set connection timeout
        connectionTimeoutRunnable = Runnable {
            if (isConnecting && !isConnected) {
                Log.w(
                        TAG,
                        "🔌 ⏰ CONNECTION TIMEOUT after " +
                                CONNECTION_TIMEOUT_MS +
                                "ms - Reconnect attempt #" +
                                reconnectAttempts +
                                " TIMED OUT"
                )
                Bridge.log("LIVE: 🔌 ⏰ Connection timeout - closing GATT connection and retrying")
                isConnecting = false

                closeGattQuietly(true)

                // Try to reconnect with exponential backoff
                Log.i(TAG, "🔌 🔄 Scheduling next reconnection attempt after timeout...")
                handleReconnection()
            }
        }

        connectionTimeoutHandler.postDelayed(
                connectionTimeoutRunnable!!,
                CONNECTION_TIMEOUT_MS.toLong()
        )

        // Update connection state
        isConnecting = true
        updateConnectionState(ConnTypes.CONNECTING)
        Log.i(
                TAG,
                "🔌 🔗 ATTEMPTING CONNECTION to device: " +
                        device.address +
                        " (" +
                        safeDeviceName(device) +
                        ") - Reconnect attempt #" +
                        reconnectAttempts
        )
        Bridge.log(
                "LIVE: 🔌 🔗 Connecting to device: " +
                        device.address +
                        " (Attempt #" +
                        reconnectAttempts +
                        ")"
        )

        // Connect to the device
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                bluetoothGatt =
                        device.connectGatt(
                                context,
                                false,
                                gattCallback,
                                BluetoothDevice.TRANSPORT_LE
                        )
                Log.d(TAG, "🔌 GATT connection initiated with TRANSPORT_LE (Android M+)")
            } else {
                bluetoothGatt = device.connectGatt(context, false, gattCallback)
                Log.d(TAG, "🔌 GATT connection initiated (legacy Android)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "🔌 ❌ ERROR connecting to GATT server - Exception: " + e.message, e)
            Bridge.log("LIVE: 🔌 ❌ Failed to connect to GATT server: " + e.message)
            isConnecting = false
            // connectionEvent(SmartGlassesConnectionState.DISCONNECTED);
        }
    }

    /**
     * Try to reconnect to the last known device by starting a scan and looking for the saved name
     */
    // private void reconnectToLastKnownDevice() {
    // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    // String lastDeviceName = prefs.getString(PREF_DEVICE_NAME, null);

    // if (lastDeviceName != null && bluetoothAdapter != null) {
    //     Bridge.log("LIVE: Attempting to reconnect to last known device by name: " +
    // lastDeviceName);

    //     // We can't directly connect by name, we need to scan to find the device first
    //     Bridge.log("LIVE: Starting scan to find device with name: " + lastDeviceName);
    //     startScan();

    //     // The scan callback will automatically connect when it finds a device with this name
    // } else {
    //     // No last device to connect to, start scanning
    //     Bridge.log("LIVE: No last known device name, starting scan");
    //     startScan();
    // }
    // }

    /** Handle reconnection with exponential backoff */
    private fun handleReconnection() {
        // Don't attempt reconnection if we've been killed/forgotten
        if (isKilled) {
            Bridge.log("LIVE: 🔌 RECONNECT ABORTED - device has been killed/forgotten")
            isReconnecting = false
            return
        }

        if (isReconnecting) {
            Bridge.log("LIVE: 🔌 RECONNECT ABORTED - already reconnecting")
            return
        }

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            // Keep retrying in cycles until user explicitly forgets/kills the device.
            Log.w(TAG, "🔌 ♻️ Max reconnect attempts reached - restarting retry cycle")
            Bridge.log("LIVE: 🔌 ♻️ Max reconnect attempts reached - continuing reconnection cycle")
            reconnectAttempts = 0
        }

        // Set reconnecting flag for faster scan timeout
        isReconnecting = true

        reconnectAttempts++
        // RN home UI keys off core.searching for "connecting"; auto-reconnect does not set that.
        // Publish CONNECTING so the app shows reconnecting during backoff (e.g. post-shutdown
        // delay).
        updateConnectionState(ConnTypes.CONNECTING)
        // Calculate delay with exponential backoff
        var delay =
                Math.min(
                        BASE_RECONNECT_DELAY_MS * (1L shl reconnectAttempts),
                        MAX_RECONNECT_DELAY_MS.toLong()
                )
        // After K900 shutdown, glasses need time to power cycle before they advertise again
        if (reconnectAttempts == 1 &&
                        lastShutdownTimeMs > 0 &&
                        (System.currentTimeMillis() - lastShutdownTimeMs) < SHUTDOWN_RECENT_MS
        ) {
            delay = Math.max(delay, POST_SHUTDOWN_RECONNECT_DELAY_MS)
            Log.i(
                    TAG,
                    "🔌 ⏳ Post-shutdown: waiting " +
                            (POST_SHUTDOWN_RECONNECT_DELAY_MS / 1000) +
                            "s before first reconnect scan"
            )
            Bridge.log(
                    "LIVE: 🔌 ⏳ Post-shutdown: waiting for glasses to reboot before first reconnect scan"
            )
        }

        Log.i(
                TAG,
                "🔌 📅 SCHEDULING RECONNECT #" +
                        reconnectAttempts +
                        "/" +
                        MAX_RECONNECT_ATTEMPTS +
                        " in " +
                        delay +
                        "ms (base=" +
                        BASE_RECONNECT_DELAY_MS +
                        "ms, max=" +
                        MAX_RECONNECT_DELAY_MS +
                        "ms, scan_timeout=" +
                        RECONNECT_SCAN_TIMEOUT_MS +
                        "ms)"
        )
        Bridge.log(
                "LIVE: 🔌 📅 Scheduling reconnection attempt " +
                        reconnectAttempts +
                        "/" +
                        MAX_RECONNECT_ATTEMPTS +
                        " in " +
                        delay +
                        "ms (fast scan: " +
                        RECONNECT_SCAN_TIMEOUT_MS +
                        "ms)"
        )

        // Schedule reconnection attempt
        handler.postDelayed(
                object : Runnable {
                    override fun run() {
                        if (!isConnected && !isConnecting && !isKilled) {
                            // Prefer saved MAC for direct GATT connect (faster and more reliable
                            // than scanning).
                            // Falls back to name-based scan if no address is saved.
                            val lastDeviceAddress =
                                    DeviceStore.get("bluetooth", "device_address") as String?
                            if (lastDeviceAddress != null &&
                                            !lastDeviceAddress.isEmpty() &&
                                            bluetoothAdapter != null
                            ) {
                                try {
                                    val device =
                                            bluetoothAdapter!!.getRemoteDevice(lastDeviceAddress)
                                    Log.i(
                                            TAG,
                                            "🔌 🔁 RECONNECT #" +
                                                    reconnectAttempts +
                                                    "/" +
                                                    MAX_RECONNECT_ATTEMPTS +
                                                    " - Direct GATT to saved address " +
                                                    lastDeviceAddress
                                    )
                                    Bridge.log(
                                            "LIVE: 🔌 🔁 Reconnection attempt " +
                                                    reconnectAttempts +
                                                    "/" +
                                                    MAX_RECONNECT_ATTEMPTS +
                                                    " - connecting to saved BLE address: " +
                                                    lastDeviceAddress
                                    )
                                    // Release latch so connect timeout / GATT error can call
                                    // handleReconnection() again
                                    isReconnecting = false
                                    connectToDevice(device)
                                    return
                                } catch (e: IllegalArgumentException) {
                                    Log.w(
                                            TAG,
                                            "🔌 ⚠️ Invalid saved BLE address, falling back to scan: " +
                                                    lastDeviceAddress,
                                            e
                                    )
                                    Bridge.log(
                                            "LIVE: 🔌 ⚠️ Invalid saved BLE address, using scan fallback"
                                    )
                                }
                            }

                            if (savedDeviceName != null &&
                                            !savedDeviceName.isEmpty() &&
                                            bluetoothAdapter != null
                            ) {
                                Log.i(
                                        TAG,
                                        "🔌 🔍 STARTING RECONNECT #" +
                                                reconnectAttempts +
                                                "/" +
                                                MAX_RECONNECT_ATTEMPTS +
                                                " - Fast scan (" +
                                                RECONNECT_SCAN_TIMEOUT_MS +
                                                "ms) for device: " +
                                                savedDeviceName
                                )
                                Bridge.log(
                                        "LIVE: 🔌 🔍 Reconnection attempt " +
                                                reconnectAttempts +
                                                "/" +
                                                MAX_RECONNECT_ATTEMPTS +
                                                " - Starting FAST BLE scan for: " +
                                                savedDeviceName
                                )
                                startScan()
                            } else {
                                Log.w(
                                        TAG,
                                        "🔌 ⚠️ RECONNECT #" +
                                                reconnectAttempts +
                                                " SKIPPED - No saved address or device id"
                                )
                                Bridge.log(
                                        "LIVE: 🔌 ⚠️ Reconnection attempt " +
                                                reconnectAttempts +
                                                " - No saved BLE address or device id, scheduling next attempt"
                                )
                                handleReconnection()
                            }
                        } else if (isConnected) {
                            Log.i(
                                    TAG,
                                    "🔌 🔗 Reconnect attempt skipped - BLE link already connected (attempt " +
                                            reconnectAttempts +
                                            ")"
                            )
                            Bridge.log(
                                    "LIVE: 🔌 🔗 Reconnect attempt skipped - BLE link already connected"
                            )
                            reconnectAttempts = 0
                            isReconnecting = false
                        } else {
                            Log.d(
                                    TAG,
                                    "🔌 ⏭️ RECONNECT SKIPPED - State changed (connected=" +
                                            isConnected +
                                            ", connecting=" +
                                            isConnecting +
                                            ", killed=" +
                                            isKilled +
                                            ")"
                            )
                            isReconnecting = false
                        }
                    }
                },
                delay
        )
    }

    private fun phyLabel(phy: Int): String {
        return when (phy) {
            BluetoothDevice.PHY_LE_1M -> "1M"
            BluetoothDevice.PHY_LE_2M -> "2M"
            BluetoothDevice.PHY_LE_CODED -> "coded"
            else -> "unknown($phy)"
        }
    }

    /** GATT callback for BLE operations */
    private val gattCallback: BluetoothGattCallback =
            object : BluetoothGattCallback() {
                override fun onConnectionStateChange(
                        gatt: BluetoothGatt,
                        status: Int,
                        newState: Int
                ) {
                    if (!isCurrentGattCallback(gatt)) {
                        return
                    }

                    // Cancel the connection timeout
                    if (connectionTimeoutRunnable != null) {
                        connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable!!)
                        connectionTimeoutRunnable = null
                    }

                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            Bridge.log(
                                    "LIVE: 🔌 🔗 BLE GATT link connected - validating services/characteristics..."
                            )
                            isConnecting = false
                            isConnected = true
                            connectedDevice = gatt.device

                            DeviceStore.apply("glasses", "bluetoothName", connectedDevice!!.name)
                            // Persist MAC so reconnection can use direct GATT instead of scanning
                            if (connectedDevice!!.address != null) {
                                DeviceStore.apply(
                                        "bluetooth",
                                        "device_address",
                                        connectedDevice!!.address
                                )
                            }

                            // Save the connected device name for future reconnections
                            // no longer needed as we now save it immediately in connectToDevice()
                            // if (connectedDevice != null && connectedDevice.getName() != null) {
                            //     SharedPreferences prefs =
                            // context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                            //     prefs.edit().putString(PREF_DEVICE_NAME,
                            // connectedDevice.getName()).apply();
                            //     Log.i(TAG, "🔌 💾 Saved device name for future reconnection: " +
                            // connectedDevice.getName());
                            //     Bridge.log("LIVE: Saved device name for future reconnection: " +
                            // connectedDevice.getName());
                            // }

                            // CTKD Implementation: Register bonding receiver and create bond for BT
                            // Classic
                            registerBondingReceiver()
                            bondingRetryCount = 0 // Reset retry counter for new connection
                            Bridge.log(
                                    "LIVE: CTKD: BLE connection established, initiating CTKD bonding for BT Classic"
                            )

                            // Check if device is already bonded before attempting to create bond
                            if (connectedDevice!!.bondState == BluetoothDevice.BOND_BONDED) {
                                Bridge.log(
                                        "LIVE: CTKD: Device is already bonded - connecting A2DP audio profile"
                                )
                                // Device is bonded but we need to explicitly connect the A2DP audio
                                // profile
                                // Just being bonded doesn't mean the audio profile is connected
                                connectA2dpProfile(connectedDevice!!)
                                // Note: audioConnected will be set to true once A2DP profile
                                // connects
                            } else {
                                createBond(connectedDevice!!)
                            }

                            // Discover services
                            gatt.discoverServices()

                            // Reset reconnect attempts on successful connection
                            val previousAttempts = reconnectAttempts
                            reconnectAttempts = 0
                            isReconnecting = false // Clear reconnection mode
                            Log.i(
                                    TAG,
                                    "🔌 ✅ Reconnection counter reset (was at " +
                                            previousAttempts +
                                            " attempts)"
                            )
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            Log.w(
                                    TAG,
                                    "🔌 ⚠️ DISCONNECTED from GATT server - Initiating reconnection sequence"
                            )
                            Bridge.log(
                                    "LIVE: 🔌 ⚠️ Disconnected from GATT server - Will attempt reconnection"
                            )
                            isConnected = false
                            isConnecting = false

                            connectedDevice = null
                            glassesReady = false // Reset ready state on disconnect
                            glassesSessionId = null // Fresh BLE session starts with no sid known
                            readinessCompletedThisBleSession = false

                            // Reset audio pairing flags
                            glassesReadyReceived = false
                            audioConnected = false

                            notificationsEnabled = false

                            // Notify frontend and backend of disconnection
                            updateConnectionState(ConnTypes.DISCONNECTED)

                            handler.removeCallbacks(processSendQueueRunnable!!)

                            // Stop the readiness check loop
                            stopReadinessCheckLoop()

                            // Stop heartbeat mechanism
                            stopHeartbeat()

                            // Stop RSSI polling
                            stopSignalStrengthPolling()

                            // Stop micbeat mechanism
                            stopMicBeat()

                            // Close the L2CAP file channel (if the fast path was open)
                            closeL2capFileChannel()
                            fileProcessingHandler.removeCallbacksAndMessages(null)
                            clearFilePacketBuffer()

                            // Clean up GATT resources
                            closeGattQuietly(false)

                            // Attempt reconnection if not killed
                            if (!isKilled) {
                                Log.i(TAG, "🔌 🔄 Starting automatic reconnection procedure...")
                                handleReconnection()
                            }

                            // Close LC3 audio logging
                            closeLc3Logging()

                            // stop LC3 player
                            if (lc3AudioPlayer != null) {
                                lc3AudioPlayer!!.stopPlay()
                            }
                        }
                    } else {
                        // Connection error
                        Log.e(
                                TAG,
                                "🔌 ❌ GATT connection error: status=" +
                                        status +
                                        " - Reconnect attempt #" +
                                        reconnectAttempts +
                                        " FAILED"
                        )
                        Bridge.log(
                                "LIVE: 🔌 ❌ GATT connection error (status=" +
                                        status +
                                        ") - Will retry reconnection"
                        )
                        isConnected = false
                        isConnecting = false
                        glassesReady = false
                        glassesSessionId = null
                        readinessCompletedThisBleSession = false
                        glassesReadyReceived = false
                        audioConnected = false

                        notificationsEnabled = false

                        // Notify frontend and backend of disconnection
                        updateConnectionState(ConnTypes.DISCONNECTED)

                        // Stop heartbeat mechanism
                        stopHeartbeat()

                        // Stop RSSI polling
                        stopSignalStrengthPolling()

                        // Stop micbeat mechanism
                        stopMicBeat()

                        // Close the L2CAP file channel (if the fast path was open)
                        closeL2capFileChannel()
                        fileProcessingHandler.removeCallbacksAndMessages(null)
                        clearFilePacketBuffer()

                        // Clean up resources
                        closeGattQuietly(false)

                        // Attempt reconnection if not killed
                        if (!isKilled) {
                            Log.i(TAG, "🔌 🔄 Retrying after GATT error...")
                            handleReconnection()
                        }
                    }
                }

                override fun onPhyUpdate(
                        gatt: BluetoothGatt,
                        txPhy: Int,
                        rxPhy: Int,
                        status: Int
                ) {
                    Bridge.log(
                            "LIVE: PHY update tx=" +
                                    phyLabel(txPhy) +
                                    ", rx=" +
                                    phyLabel(rxPhy) +
                                    ", status=" +
                                    status
                    )
                }

                override fun onPhyRead(
                        gatt: BluetoothGatt,
                        txPhy: Int,
                        rxPhy: Int,
                        status: Int
                ) {
                    Bridge.log(
                            "LIVE: PHY read tx=" +
                                    phyLabel(txPhy) +
                                    ", rx=" +
                                    phyLabel(rxPhy) +
                                    ", status=" +
                                    status
                    )
                }

                override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        Bridge.log("LIVE: GATT services discovered")

                        // Find our service and characteristics
                        val service = gatt.getService(SERVICE_UUID)
                        if (service != null) {
                            txCharacteristic = service.getCharacteristic(TX_CHAR_UUID)
                            rxCharacteristic = service.getCharacteristic(RX_CHAR_UUID)

                            // Get LC3 characteristics (always supported)
                            lc3ReadCharacteristic = service.getCharacteristic(LC3_READ_UUID)
                            lc3WriteCharacteristic = service.getCharacteristic(LC3_WRITE_UUID)

                            // Check if we have required characteristics
                            val hasRequiredCharacteristics =
                                    (rxCharacteristic != null && txCharacteristic != null) &&
                                            (lc3ReadCharacteristic != null &&
                                                    lc3WriteCharacteristic != null)

                            if (hasRequiredCharacteristics) {
                                // BLE connection established, but we still need to wait for glasses
                                // SOC
                                Bridge.log(
                                        "LIVE: 🔌 ✅ BLE reconnection fully ready (Core TX/RX + LC3 TX/RX characteristics verified)"
                                )
                                Bridge.log("LIVE: 🔄 Waiting for glasses SOC to become ready...")

                                // Don't set connected=true here - wait for SOC to be ready
                                // (fullyBooted=true)
                                // DeviceStore handles connected state based on fullyBooted

                                // Keep the state as CONNECTING until the glasses SOC responds
                                // connectionEvent(SmartGlassesConnectionState.CONNECTING);

                                // Request MTU first, then enable notifications from onMtuChanged,
                                // then start data flow after all descriptors are written.
                                // This ensures no concurrent GATT operations on older Android BLE
                                // stacks.
                                if (checkPermission()) {
                                    val mtuRequested = gatt.requestMtu(512)
                                    Bridge.log(
                                            "LIVE: 🔄 Requested MTU size 512, success: " +
                                                    mtuRequested
                                    )
                                    if (!mtuRequested) {
                                        // MTU request failed to even start, enable notifications
                                        // directly
                                        enableNotifications()
                                    }
                                    // Otherwise, enableNotifications() will be called from
                                    // onMtuChanged
                                } else {
                                    enableNotifications()
                                }

                                // NOTE: Send queue and readiness loop are started AFTER descriptor
                                // writes complete (in writeNextDescriptor when queue is empty) to
                                // avoid writeCharacteristic conflicting with writeDescriptor on
                                // older Android BLE stacks that don't support concurrent GATT ops.
                            } else {
                                Log.e(TAG, "Required BLE characteristics not found")
                                if (rxCharacteristic == null) {
                                    Log.e(TAG, "RX characteristic (peripheral's TX) not found")
                                }
                                if (txCharacteristic == null) {
                                    Log.e(TAG, "TX characteristic (peripheral's RX) not found")
                                }
                                // Log LC3 characteristic errors
                                if (lc3ReadCharacteristic == null) {
                                    Log.e(TAG, "LC3_READ characteristic not found")
                                }
                                if (lc3WriteCharacteristic == null) {
                                    Log.e(TAG, "LC3_WRITE characteristic not found")
                                }
                                gatt.disconnect()
                            }
                        } else {
                            Log.e(TAG, "Required BLE service not found: " + SERVICE_UUID)
                            gatt.disconnect()
                        }
                    } else {
                        Log.e(TAG, "Service discovery failed with status: " + status)
                        gatt.disconnect()
                    }
                }

                override fun onCharacteristicRead(
                        gatt: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic,
                        status: Int
                ) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        Bridge.log("LIVE: Characteristic read successful")
                        // Process the read data if needed
                    } else {
                        Log.e(TAG, "Characteristic read failed with status: " + status)
                    }
                }

                override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
                    rssiReadInProgress = false
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        if (isConnected && bluetoothGatt != null && gatt === bluetoothGatt) {
                            updateSignalStrength(rssi)
                        }
                    } else {
                        Log.e(TAG, "RSSI read failed with status: " + status)
                    }
                }

                override fun onCharacteristicWrite(
                        gatt: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic,
                        status: Int
                ) {
                    val trace = inFlightBleWriteTrace
                    val callbackAtMs = System.currentTimeMillis()
                    val callbackDelayMs =
                            if (inFlightBleWriteStartedAtMs > 0L)
                                    callbackAtMs - inFlightBleWriteStartedAtMs
                            else null
                    inFlightBleWriteTrace = null
                    inFlightBleWriteStartedAtMs = 0L

                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        // Bridge.log("LIVE: Characteristic write successful");

                        // Calculate time since last send to enforce rate limiting
                        val currentTimeMs = callbackAtMs
                        val timeSinceLastSendMs = currentTimeMs - lastSendTimeMs
                        val nextProcessDelayMs: Long

                        if (timeSinceLastSendMs < MIN_SEND_DELAY_MS) {
                            // Not enough time has elapsed, enforce minimum delay
                            nextProcessDelayMs = MIN_SEND_DELAY_MS - timeSinceLastSendMs
                            // Bridge.log("LIVE: Rate limiting: Next queue processing in " +
                            // nextProcessDelayMs + "ms");
                        } else {
                            // Enough time has already passed
                            nextProcessDelayMs = 0
                        }

                        // Schedule the next queue processing with appropriate delay
                        logBleWriteTrace(
                                "write_callback",
                                trace,
                                mapOf(
                                        "status" to status,
                                        "success" to true,
                                        "callbackDelayMs" to callbackDelayMs,
                                        "timeSinceLastSendMs" to timeSinceLastSendMs,
                                        "nextProcessDelayMs" to nextProcessDelayMs,
                                        "queueSize" to sendQueue.size,
                                        "characteristicUuid" to characteristic.uuid.toString()
                                )
                        )
                        handler.postDelayed(processSendQueueRunnable!!, nextProcessDelayMs)
                    } else {
                        Log.e(TAG, "Characteristic write failed with status: " + status)
                        logBleWriteTrace(
                                "write_callback",
                                trace,
                                mapOf(
                                        "status" to status,
                                        "success" to false,
                                        "callbackDelayMs" to callbackDelayMs,
                                        "retryDelayMs" to 500L,
                                        "queueSize" to sendQueue.size,
                                        "characteristicUuid" to characteristic.uuid.toString()
                                )
                        )
                        // If write fails, try again with a longer delay
                        handler.postDelayed(processSendQueueRunnable!!, 500L)
                    }
                }

                override fun onCharacteristicChanged(
                        gatt: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic
                ) {
                    // Get thread ID for tracking thread issues
                    val threadId = Thread.currentThread().id
                    val uuid = characteristic.uuid

                    val data = characteristic.value
                    if (data == null || data.isEmpty()) {
                        return
                    }

                    // FILE_READ characteristic (72FF) needs special handling for packet reassembly
                    // Android BLE fragments notifications larger than MTU into multiple callbacks
                    val isFileReadCharacteristic = uuid == FILE_READ_UUID
                    if (isFileReadCharacteristic) {
                        fileReadNotificationCount++
                        Bridge.log(
                                "LIVE: 📁 FILE_READ #" +
                                        fileReadNotificationCount +
                                        " (" +
                                        data.size +
                                        " bytes), currentMtu=" +
                                        currentMtu
                        )
                        processFilePacketData(data)
                        return // File data handled separately with reassembly buffer
                    }

                    val isRxCharacteristic = uuid == RX_CHAR_UUID
                    val isTxCharacteristic = uuid == TX_CHAR_UUID
                    val isLc3ReadCharacteristic = uuid == LC3_READ_UUID
                    val isLc3WriteCharacteristic = uuid == LC3_WRITE_UUID

                    if (isRxCharacteristic) {
                        Bridge.log("LIVE: Received data on RX characteristic")
                        // #region agent log [810da2] Hypothesis A+C: capture data.length vs
                        // negotiated MTU
                        Bridge.log(
                                "LIVE: [DEBUG-810da2-HypAC] RX dataLen=" +
                                        data.size +
                                        " mtu=" +
                                        currentMtu +
                                        " firstByte=0x" +
                                        String.format("%02X", data[0]) +
                                        " second=0x" +
                                        (if (data.size > 1) String.format("%02X", data[1])
                                        else "??")
                        )
                        // #endregion
                    } else if (isTxCharacteristic) {
                        Bridge.log("LIVE: Received data on TX characteristic")
                    } else if (isLc3ReadCharacteristic) {
                        // Bridge.log("LIVE: Received data on LC3_READ characteristic");
                        processLc3AudioPacket(data)
                        return // LC3 audio handled separately
                    } else if (isLc3WriteCharacteristic) {
                        Bridge.log("LIVE: Received data on LC3_WRITE characteristic")
                    } else {
                        Log.w(TAG, "Received data on unknown characteristic: " + uuid)
                    }

                    // Process command/JSON data on RX/TX characteristics
                    processReceivedData(data, data.size)
                }

                override fun onDescriptorWrite(
                        gatt: BluetoothGatt,
                        descriptor: BluetoothGattDescriptor,
                        status: Int
                ) {
                    val threadId = Thread.currentThread().id

                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        Log.e(
                                TAG,
                                "Thread-" +
                                        threadId +
                                        ": ✅ Descriptor write successful for " +
                                        descriptor.characteristic.uuid
                        )
                    } else {
                        Log.e(
                                TAG,
                                "Thread-" +
                                        threadId +
                                        ": ℹ️ Descriptor write failed with status: " +
                                        status +
                                        " for " +
                                        descriptor.characteristic.uuid
                        )
                    }

                    // Process next queued descriptor write (serialized to avoid BLE stack
                    // contention)
                    writeNextDescriptor()
                }

                override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        Bridge.log(
                                "LIVE: 🔵 MTU negotiation successful - changed to " + mtu + " bytes"
                        )
                        val effectivePayload = mtu - 3
                        Bridge.log(
                                "LIVE:    Effective payload size: " + effectivePayload + " bytes"
                        )

                        // Store the new MTU value
                        currentMtu = mtu

                        // If the negotiated MTU is sufficient for LC3 audio packets (typically
                        // 40-60 bytes)
                        if (mtu >= 64) {
                            Bridge.log("LIVE: ✅ MTU size is sufficient for LC3 audio data packets")
                        } else {
                            Log.w(TAG, "⚠️ MTU size may be too small for LC3 audio data packets")
                            Bridge.log(
                                    "LIVE: 📊 Effective MTU payload: " + effectivePayload + " bytes"
                            )
                        }
                    } else {
                        Log.e(TAG, "❌ MTU change failed with status: " + status)
                        Log.w(TAG, "   Will continue with default MTU (23 bytes, 20 byte payload)")
                    }

                    // Now that MTU operation is complete, enable notifications
                    // (descriptor writes are GATT operations and can't overlap with MTU request)
                    if (!notificationsEnabled) {
                        notificationsEnabled = true
                        enableNotifications()
                    }
                }
            }

    /**
     * Write the next queued descriptor, or mark the queue as idle. Must be called after each
     * onDescriptorWrite callback to serialize BLE GATT operations. On older Android devices,
     * issuing multiple writeDescriptor() calls without waiting for onDescriptorWrite() causes the
     * subsequent writes to silently fail.
     */
    private fun writeNextDescriptor() {
        val next = pendingDescriptorWrites.poll()
        if (next == null) {
            isDescriptorWriteInProgress = false
            val threadId = Thread.currentThread().id
            Log.e(TAG, "Thread-" + threadId + ": ✅ All descriptor writes completed")
            Bridge.log("LIVE: All BLE notification descriptors written successfully")

            // Now that all GATT setup operations are complete, start data flow
            Bridge.log("LIVE: Starting send queue and readiness check loop")
            startSignalStrengthPolling()
            handler.post(processSendQueueRunnable!!)
            startReadinessCheckLoop()
            return
        }

        if (bluetoothGatt == null) {
            isDescriptorWriteInProgress = false
            return
        }

        try {
            val writeSuccess = bluetoothGatt!!.writeDescriptor(next)
            val threadId = Thread.currentThread().id
            val uuid = next.characteristic.uuid
            Log.e(
                    TAG,
                    "Thread-" + threadId + ": 📱 Write descriptor for " + uuid + ": " + writeSuccess
            )

            if (!writeSuccess) {
                // If writeDescriptor returns false, onDescriptorWrite won't be called,
                // so we need to continue the queue ourselves
                Log.e(
                        TAG,
                        "Thread-" +
                                threadId +
                                ": ⚠️ writeDescriptor returned false for " +
                                uuid +
                                ", continuing queue"
                )
                handler.postDelayed(this::writeNextDescriptor, 50L)
            }
        } catch (e: Exception) {
            val threadId = Thread.currentThread().id
            Log.e(TAG, "Thread-" + threadId + ": ⚠️ Error writing descriptor: " + e.message)
            handler.postDelayed(this::writeNextDescriptor, 50L)
        }
    }

    /**
     * Enable notifications for all characteristics to ensure we catch data from any endpoint.
     * Descriptor writes are queued and serialized to work reliably on older Android BLE stacks that
     * don't support concurrent GATT operations.
     */
    private fun enableNotifications() {
        val threadId = Thread.currentThread().id
        Log.e(TAG, "Thread-" + threadId + ": 🔵 enableNotifications() called")

        if (bluetoothGatt == null) {
            Log.e(
                    TAG,
                    "Thread-" + threadId + ": ❌ Cannot enable notifications - bluetoothGatt is null"
            )
            return
        }

        if (!hasPermissions()) {
            Log.e(
                    TAG,
                    "Thread-" + threadId + ": ❌ Cannot enable notifications - missing permissions"
            )
            return
        }

        // Find our service
        val service = bluetoothGatt!!.getService(SERVICE_UUID)
        if (service == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Service not found: " + SERVICE_UUID)
            return
        }

        // Get all characteristics
        val characteristics = service.characteristics
        Bridge.log(
                "LIVE: Thread-" +
                        threadId +
                        ": Found " +
                        characteristics.size +
                        " characteristics in service " +
                        SERVICE_UUID
        )

        var notificationSuccess = false

        // Clear any stale queued writes
        pendingDescriptorWrites.clear()
        isDescriptorWriteInProgress = false

        // Enable notifications for each characteristic
        for (characteristic in characteristics) {
            val uuid = characteristic.uuid

            // Log if this is one of the file transfer characteristics
            if (uuid == FILE_READ_UUID) {
                Log.e(TAG, "Thread-" + threadId + ": 📁 Found FILE_READ characteristic (72FF)!")
            } else if (uuid == FILE_WRITE_UUID) {
                Log.e(TAG, "Thread-" + threadId + ": 📁 Found FILE_WRITE characteristic (73FF)!")
            }

            val properties = characteristic.properties
            val hasNotify = (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
            val hasIndicate = (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
            val hasRead = (properties and BluetoothGattCharacteristic.PROPERTY_READ) != 0
            val hasWrite = (properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
            val hasWriteNoResponse =
                    (properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0

            Bridge.log(
                    "LIVE: Thread-" +
                            threadId +
                            ": Characteristic " +
                            uuid +
                            " properties: " +
                            (if (hasNotify) "NOTIFY " else "") +
                            (if (hasIndicate) "INDICATE " else "") +
                            (if (hasRead) "READ " else "") +
                            (if (hasWrite) "WRITE " else "") +
                            (if (hasWriteNoResponse) "WRITE_NO_RESPONSE " else "")
            )

            // Store references to our main characteristics
            if (uuid == RX_CHAR_UUID) {
                rxCharacteristic = characteristic
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored RX characteristic")
            } else if (uuid == TX_CHAR_UUID) {
                txCharacteristic = characteristic
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored TX characteristic")
            } else if (uuid == LC3_READ_UUID) {
                lc3ReadCharacteristic = characteristic
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored LC3_READ characteristic")
            } else if (uuid == LC3_WRITE_UUID) {
                lc3WriteCharacteristic = characteristic
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored LC3_WRITE characteristic")
            }

            // Enable notifications for any characteristic that supports it
            if (hasNotify || hasIndicate) {
                try {
                    // Enable local notifications (this is synchronous and can be done for all at
                    // once)
                    val success =
                            bluetoothGatt!!.setCharacteristicNotification(characteristic, true)
                    Log.e(
                            TAG,
                            "Thread-" +
                                    threadId +
                                    ": 📱 Set local notification for " +
                                    uuid +
                                    ": " +
                                    success
                    )
                    notificationSuccess = notificationSuccess || success

                    // Queue the remote descriptor write (must be serialized on older Android BLE
                    // stacks)
                    val descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID)

                    if (descriptor != null) {
                        val value: ByteArray
                        if (hasNotify) {
                            value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        } else {
                            value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                        }
                        descriptor.value = value
                        pendingDescriptorWrites.add(descriptor)
                    } else {
                        Log.e(
                                TAG,
                                "Thread-" +
                                        threadId +
                                        ": ⚠️ No notification descriptor found for " +
                                        uuid
                        )
                    }
                } catch (e: Exception) {
                    Log.e(
                            TAG,
                            "Thread-" +
                                    threadId +
                                    ": ❌ Exception enabling notifications for " +
                                    uuid +
                                    ": " +
                                    e.message
                    )
                }
            }
        }

        // Log notification status
        if (notificationSuccess) {
            Bridge.log(
                    "LIVE: Thread-" +
                            threadId +
                            ": Local notification registration SUCCESS for at least one characteristic"
            )
            Log.e(
                    TAG,
                    "Thread-" +
                            threadId +
                            ": 🔔 Ready to receive data via onCharacteristicChanged()"
            )
        } else {
            Log.e(
                    TAG,
                    "Thread-" +
                            threadId +
                            ": ❌ Failed to enable notifications on any characteristic"
            )
        }

        // Kick off the serialized descriptor write queue
        if (!pendingDescriptorWrites.isEmpty()) {
            isDescriptorWriteInProgress = true
            val queueSize = pendingDescriptorWrites.size
            Bridge.log(
                    "LIVE: Queued " +
                            queueSize +
                            " descriptor writes, starting serialized write sequence"
            )
            writeNextDescriptor()
        } else {
            // No descriptors to write, start data flow immediately
            Bridge.log(
                    "LIVE: No descriptor writes needed, starting send queue and readiness check loop"
            )
            startSignalStrengthPolling()
            handler.post(processSendQueueRunnable!!)
            startReadinessCheckLoop()
        }
    }

    /** Process the send queue with rate limiting */
    private fun processSendQueue() {
        if (!isConnected || bluetoothGatt == null || txCharacteristic == null) {
            return
        }

        // Check if we need to enforce rate limiting
        val currentTimeMs = System.currentTimeMillis()
        val timeSinceLastSendMs = currentTimeMs - lastSendTimeMs

        if (timeSinceLastSendMs < MIN_SEND_DELAY_MS) {
            // Not enough time has elapsed since last send
            // Reschedule processing after the remaining delay
            val remainingDelayMs = MIN_SEND_DELAY_MS - timeSinceLastSendMs
            Bridge.log(
                    "LIVE: Rate limiting: Waiting " + remainingDelayMs + "ms before next BLE send"
            )
            logBleWriteTrace(
                    "rate_limited",
                    sendQueue.peek()?.trace,
                    mapOf(
                            "remainingDelayMs" to remainingDelayMs,
                            "timeSinceLastSendMs" to timeSinceLastSendMs,
                            "queueSize" to sendQueue.size
                    )
            )
            handler.postDelayed(processSendQueueRunnable!!, remainingDelayMs)
            return
        }

        // Send the next item from this BLE session. A retry can race disconnect teardown and land
        // after sendQueue.clear(); the generation check is the deterministic backstop.
        var queuedWrite = sendQueue.poll()
        val currentGeneration = bleSessionGeneration.get()
        while (queuedWrite != null && queuedWrite.sessionGeneration != currentGeneration) {
            Bridge.log(
                    "LIVE: Dropping stale queued write from BLE session " +
                            queuedWrite.sessionGeneration +
                            " (current: " +
                            currentGeneration +
                            ")"
            )
            queuedWrite = sendQueue.poll()
        }
        if (queuedWrite != null) {
            // Update last send time before sending
            lastSendTimeMs = currentTimeMs
            Bridge.log(
                    "LIVE: 📤 Sending queued data - Queue size: " +
                            sendQueue.size +
                            ", Time since last send: " +
                            timeSinceLastSendMs +
                            "ms"
            )
            logBleWriteTrace(
                    "dequeued",
                    queuedWrite.trace,
                    mapOf(
                            "queueDelayMs" to
                                    (queuedWrite.trace?.let { currentTimeMs - it.queuedAtMs }),
                            "timeSinceLastSendMs" to timeSinceLastSendMs,
                            "queueSizeAfterPoll" to sendQueue.size
                    )
            )
            sendDataInternal(queuedWrite)
        }
    }

    /** Send data through BLE */
    private fun sendDataInternal(write: QueuedBleWrite?) {
        if (!isConnected || write == null) {
            return
        }
        if (write.sessionGeneration != bleSessionGeneration.get()) {
            Bridge.log("LIVE: Dropping stale BLE write before GATT transmission")
            return
        }

        val gatt = bluetoothGatt
        val characteristic = txCharacteristic
        if (gatt == null || characteristic == null) {
            return
        }

        try {
            val writeStartedAtMs = System.currentTimeMillis()
            characteristic.value = write.data
            inFlightBleWriteTrace = write.trace
            inFlightBleWriteStartedAtMs = writeStartedAtMs
            val writeAccepted = gatt.writeCharacteristic(characteristic)
            logBleWriteTrace(
                    "write_call",
                    write.trace,
                    mapOf(
                            "writeAccepted" to writeAccepted,
                            "currentMtu" to currentMtu,
                            "writeType" to characteristic.writeType,
                            "queueSize" to sendQueue.size,
                            "characteristicUuid" to characteristic.uuid.toString()
                    )
            )
            if (!writeAccepted) {
                inFlightBleWriteTrace = null
                inFlightBleWriteStartedAtMs = 0L
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error sending data via BLE", e)
            logBleWriteTrace(
                    "write_exception",
                    write.trace,
                    mapOf(
                            "errorClass" to e.javaClass.simpleName,
                            "errorMessage" to (e.message ?: "unknown")
                    )
            )
            inFlightBleWriteTrace = null
            inFlightBleWriteStartedAtMs = 0L
        }
    }

    /** Queue data to be sent */
    private fun queueData(
            data: ByteArray?,
            trace: BleWriteTrace? = null,
            sessionGeneration: Long = bleSessionGeneration.get()
    ) {
        if (data != null) {
            val queuedTrace =
                    trace?.copy(
                            queuedAtMs =
                                    if (trace.queuedAtMs > 0L)
                                            trace.queuedAtMs
                                    else System.currentTimeMillis()
                    )
            sendQueue.add(QueuedBleWrite(data, queuedTrace, sessionGeneration))
            logBleChunkTrace(
                    "queued",
                    queuedTrace,
                    mapOf("queueSizeAfterAdd" to sendQueue.size)
            )
            // Bridge.log("LIVE: 📋 Added " + data.length + " to send queue - New queue size: " +
            // sendQueue.size());

            // Log all outgoing bytes for testing
            val hexBytes = StringBuilder()
            for (b in data) {
                hexBytes.append(String.format("%02X ", b))
            }
            // Bridge.log("LIVE: 🔍 Outgoing bytes: " + hexBytes.toString().trim());

            // Trigger queue processing if not already running
            handler.removeCallbacks(processSendQueueRunnable!!)
            handler.post(processSendQueueRunnable!!)
        }
    }

    /**
     * Generate an esoteric message ID using timestamp, device ID, and random values
     * @return A unique, unpredictable message ID
     */
    private fun generateEsotericMessageId(): Long {
        val timestamp = System.currentTimeMillis()
        val randomComponent = secureRandom.nextLong()
        val counter = messageIdCounter.getAndIncrement()

        // Combine timestamp, device ID, random value, and counter in a non-obvious way
        var messageId = timestamp xor deviceId xor randomComponent xor (counter shl 32)

        // Ensure it's positive (clear the sign bit)
        messageId = Math.abs(messageId)

        return messageId
    }

    /** Send a JSON object to the glasses with message ID and ACK tracking */
    private fun sendJson(json: JSONObject?, wakeup: Boolean) {
        if (json != null) {
            try {
                val sessionGeneration = bleSessionGeneration.get()
                if (buildNumberInt < 5) {
                    val jsonStr = json.toString()
                    // Bridge.log("LIVE: 📤 Sending JSON with esoteric message ID: " + jsonStr);
                    if ("take_photo" == json.optString("type", "")) {
                        Bridge.log(
                                "LIVE: PHOTO PIPELINE [4/4] sendJson(build<5) -> sendDataToGlasses — " +
                                        summarizeOutgoingMessage(jsonStr)
                        )
                    }
                    BleTraceLogger.logJson(
                            "phone_to_glasses",
                            "sdk_ble_command",
                            json,
                            jsonStr.length
                    )
                    sendDataToGlasses(jsonStr, wakeup, sessionGeneration)
                } else {
                    // Add esoteric message ID to the JSON
                    val messageId = generateEsotericMessageId()
                    json.put("mId", messageId)

                    val jsonStr = json.toString()
                    // Bridge.log("LIVE: 📤 Sending JSON with esoteric message ID " + messageId + ":
                    // " + jsonStr);

                    // Check if this message will be chunked to determine timeout
                    var ackTimeout = ACK_TIMEOUT_MS
                    try {
                        // Create a test C-wrapped version to check size
                        val testWrapper = JSONObject()
                        testWrapper.put("C", jsonStr)
                        if (wakeup) {
                            testWrapper.put("W", 1)
                        }
                        val testWrappedJson = testWrapper.toString()

                        if (MessageChunker.needsChunking(testWrappedJson)) {
                            // Calculate dynamic timeout for chunked message
                            val estimatedChunks = Math.ceil(jsonStr.length / 300.0).toInt()
                            ackTimeout = ACK_TIMEOUT_MS + (estimatedChunks * 50L) + 2000L
                            Bridge.log(
                                    "LIVE: Message will be chunked into ~" +
                                            estimatedChunks +
                                            " chunks, using dynamic timeout: " +
                                            ackTimeout +
                                            "ms"
                            )
                        }
                    } catch (e: JSONException) {
                        // If we can't determine, use default timeout
                        Log.w(
                                TAG,
                                "Could not determine if message needs chunking, using default timeout"
                        )
                    }

                    // Track the message for ACK with appropriate timeout
                    trackMessageForAck(messageId, jsonStr, ackTimeout, sessionGeneration)

                    // Send the data
                    if ("take_photo" == json.optString("type", "")) {
                        Bridge.log(
                                "LIVE: PHOTO PIPELINE [4/4] sendJson -> sendDataToGlasses (mId=" +
                                        messageId +
                                        ", ackTimeoutMs=" +
                                        ackTimeout +
                                        ") — " +
                                        summarizeOutgoingMessage(jsonStr)
                        )
                    }
                    BleTraceLogger.logJson(
                            "phone_to_glasses",
                            "sdk_ble_command",
                            json,
                            jsonStr.length
                    )
                    sendDataToGlasses(jsonStr, wakeup, sessionGeneration)
                }
            } catch (e: JSONException) {
                Log.e(TAG, "Error adding message ID to JSON", e)
            }
        } else {
            Bridge.log("LIVE: Cannot send JSON to ASG, JSON is null")
        }
    }

    private fun sendJson(json: JSONObject?) {
        sendJson(json, false)
    }

    fun sendJson(jsonOriginal: Map<String, Any>, wakeUp: Boolean) {}

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    /** Track a message for ACK response with custom timeout */
    private fun trackMessageForAck(
            messageId: Long,
            messageData: String,
            timeoutMs: Long,
            sessionGeneration: Long
    ) {
        if (!isConnected || sessionGeneration != bleSessionGeneration.get()) {
            Bridge.log("LIVE: Not connected, skipping ACK tracking for message " + messageId)
            return
        }

        // Skip ACK tracking for glasses with build number < 5 (older firmware)
        if (buildNumberInt < 5) {
            Bridge.log(
                    "LIVE: Glasses build number (" +
                            buildNumberInt +
                            ") < 5, skipping ACK tracking for message " +
                            messageId
            )
            return
        }

        // Create retry runnable
        val retryRunnable = Runnable { retryMessage(messageId, sessionGeneration) }

        // Create pending message
        val pendingMessage =
                PendingMessage(
                        messageData,
                        System.currentTimeMillis(),
                        0,
                        retryRunnable,
                        sessionGeneration
                )
        pendingMessages[messageId] = pendingMessage

        // Schedule ACK timeout with custom timeout
        handler.postDelayed({ checkMessageAck(messageId, sessionGeneration) }, timeoutMs)

        Bridge.log(
                "LIVE: 📋 Tracking message " + messageId + " for ACK (timeout: " + timeoutMs + "ms)"
        )
    }

    /**
     * Ends the current BLE send session before clearing its ACK state. Scheduled callbacks capture
     * the old generation, and queued retries retain it, so a retry racing this clear cannot become
     * valid in the next session.
     */
    private fun resetPendingAckState() {
        val nextGeneration = bleSessionGeneration.incrementAndGet()
        val pendingCount = pendingMessages.size
        pendingMessages.clear()
        if (pendingCount > 0) {
            Bridge.log(
                    "LIVE: Cleared $pendingCount pending ACK message(s); BLE session is now $nextGeneration"
            )
        }
    }

    /** Check if a message has been acknowledged */
    private fun checkMessageAck(messageId: Long, sessionGeneration: Long) {
        val pendingMessage = pendingMessages[messageId]
        if (pendingMessage != null &&
                        pendingMessage.sessionGeneration == sessionGeneration &&
                        sessionGeneration == bleSessionGeneration.get()
        ) {
            Log.w(
                    TAG,
                    "⏰ ACK timeout for message " +
                            messageId +
                            " (attempt " +
                            pendingMessage.retryCount +
                            ")"
            )

            if (pendingMessage.retryCount < MAX_RETRY_ATTEMPTS) {
                // Retry the message
                Bridge.log(
                        "LIVE: 🔄 Retrying message " +
                                messageId +
                                " (attempt " +
                                (pendingMessage.retryCount + 1) +
                                "/" +
                                MAX_RETRY_ATTEMPTS +
                                ")"
                )
                retryMessage(messageId, sessionGeneration)
            } else {
                // Max retries reached
                Log.e(
                        TAG,
                        "❌ Message " +
                                messageId +
                                " failed after " +
                                MAX_RETRY_ATTEMPTS +
                                " attempts"
                )
                pendingMessages.remove(messageId, pendingMessage)
            }
        } else if (pendingMessage != null && pendingMessage.sessionGeneration == sessionGeneration) {
            pendingMessages.remove(messageId, pendingMessage)
        }
    }

    /** Retry a message */
    private fun retryMessage(messageId: Long, sessionGeneration: Long) {
        val pendingMessage = pendingMessages[messageId]
        if (pendingMessage == null) {
            Log.w(TAG, "Message " + messageId + " no longer tracked for retry")
            return
        }
        if (pendingMessage.sessionGeneration != sessionGeneration ||
                        sessionGeneration != bleSessionGeneration.get()
        ) {
            pendingMessages.remove(messageId, pendingMessage)
            Bridge.log("LIVE: Dropping stale ACK retry for message $messageId")
            return
        }

        if (pendingMessage.retryCount >= MAX_RETRY_ATTEMPTS) {
            Log.e(TAG, "Max retries reached for message " + messageId)
            pendingMessages.remove(messageId, pendingMessage)
            return
        }

        // Create new pending message with incremented retry count
        val retryMessage =
                PendingMessage(
                        pendingMessage.messageData,
                        System.currentTimeMillis(),
                        pendingMessage.retryCount + 1,
                        pendingMessage.retryRunnable,
                        sessionGeneration
                )

        // Replace only the entry inspected above. An ACK or disconnect may have removed it.
        if (!pendingMessages.replace(messageId, pendingMessage, retryMessage)) {
            return
        }
        if (sessionGeneration != bleSessionGeneration.get()) {
            pendingMessages.remove(messageId, retryMessage)
            return
        }

        // Send the message again
        Bridge.log(
                "LIVE: 📤 Retrying message " +
                        messageId +
                        " (attempt " +
                        retryMessage.retryCount +
                        ")"
        )
        sendDataToGlasses(pendingMessage.messageData, false, sessionGeneration)

        // Schedule next ACK check
        handler.postDelayed({ checkMessageAck(messageId, sessionGeneration) }, ACK_TIMEOUT_MS)
    }

    /** Process ACK response from glasses */
    private fun processAckResponse(messageId: Long) {
        val pendingMessage = pendingMessages.remove(messageId)
        if (pendingMessage != null) {
            Bridge.log(
                    "LIVE: ✅ Received ACK for message " +
                            messageId +
                            " (attempts: " +
                            pendingMessage.retryCount +
                            ")"
            )
        } else {
            Log.w(TAG, "⚠️ Received ACK for untracked message " + messageId)
        }
    }

    /**
     * Process file packet data with reassembly buffer for fragmented BLE notifications. Android BLE
     * delivers notifications larger than MTU in multiple onCharacteristicChanged callbacks. This
     * method buffers fragments until a complete K900 file packet is received.
     *
     * K900 file packet format: ## (2) + type (1) + packSize (2) + packIndex (2) + fileSize (4) +
     * fileName (16) + flags (2) + data (packSize) + verify (1) + $$ (2)
     */
    private fun processFilePacketData(data: ByteArray?) {
        if (data == null || data.isEmpty()) {
            return
        }

        synchronized(filePacketBufferLock) {
            // Check for buffer overflow
            if (filePacketBufferSize + data.size > filePacketBuffer.size) {
                Log.e(TAG, "File packet buffer overflow, clearing buffer")
                filePacketBufferSize = 0
                return
            }

            // Append new data to buffer
            System.arraycopy(data, 0, filePacketBuffer, filePacketBufferSize, data.size)
            filePacketBufferSize += data.size

            // Try to extract complete packets from buffer
            extractCompleteFilePackets()
        }
    }

    /**
     * Extract and process complete file packets from the reassembly buffer. Must be called within
     * synchronized(filePacketBufferLock) block.
     */
    private fun extractCompleteFilePackets() {
        var pos = 0
        var iterations = 0
        val MAX_ITERATIONS = 100

        while (pos < filePacketBufferSize && iterations++ < MAX_ITERATIONS) {
            // Find start marker ## (0x23 0x23)
            var startPos = -1
            for (i in pos until filePacketBufferSize - 1) {
                if (filePacketBuffer[i] == 0x23.toByte() && filePacketBuffer[i + 1] == 0x23.toByte()
                ) {
                    startPos = i
                    break
                }
            }

            if (startPos < 0) {
                // No start marker found, clear buffer
                Bridge.log(
                        "LIVE: 📦 No start marker found in " +
                                filePacketBufferSize +
                                " bytes, clearing buffer"
                )
                filePacketBufferSize = 0
                return
            }

            // Skip any garbage before start marker
            if (startPos > pos) {
                Bridge.log(
                        "LIVE: 📦 Skipping " +
                                (startPos - pos) +
                                " bytes of garbage before start marker"
                )
                pos = startPos
            }

            // Need at least 5 bytes to read type and packSize: ## (2) + type (1) + packSize (2)
            if (filePacketBufferSize - pos < 5) {
                break
            }

            // Read packSize from header (bytes 3-4, big-endian)
            val packSizeOffset = pos + 3 // Skip ## and type
            val packSize =
                    ((filePacketBuffer[packSizeOffset].toInt() and 0xFF) shl 8) or
                            (filePacketBuffer[packSizeOffset + 1].toInt() and 0xFF)

            // Validate packSize
            if (packSize < 0 || packSize > K900ProtocolUtils.FILE_PACK_SIZE) {
                Log.w(TAG, "Invalid packSize $packSize, skipping start marker")
                pos = startPos + 1
                continue
            }

            // Calculate expected total packet size
            // ## (2) + type (1) + packSize (2) + packIndex (2) + fileSize (4) + fileName (16) +
            // flags (2) + data (packSize) + verify (1) + $$ (2)
            val expectedPacketSize = 2 + 1 + 2 + 2 + 4 + 16 + 2 + packSize + 1 + 2

            // Check if we have the complete packet
            val availableBytes = filePacketBufferSize - pos
            if (availableBytes < expectedPacketSize) {
                break
            }

            // Verify end marker $$ at expected position
            val endMarkerPos = pos + expectedPacketSize - 2
            val endByte1 = filePacketBuffer[endMarkerPos]
            val endByte2 = filePacketBuffer[endMarkerPos + 1]

            if (endByte1 != 0x24.toByte() || endByte2 != 0x24.toByte()) {
                // End marker not found - could be corrupted packet or wrong packSize interpretation
                Log.w(
                        TAG,
                        "End marker $$ not found at pos " +
                                endMarkerPos +
                                " (found 0x" +
                                String.format("%02X%02X", endByte1, endByte2) +
                                "), packSize=" +
                                packSize +
                                ", expectedPacketSize=" +
                                expectedPacketSize +
                                ", bufferSize=" +
                                filePacketBufferSize +
                                ", skipping start marker"
                )
                pos = startPos + 1
                continue
            }

            // Extract complete packet
            val completePacket = ByteArray(expectedPacketSize)
            System.arraycopy(filePacketBuffer, pos, completePacket, 0, expectedPacketSize)

            // Process the complete packet
            val packetInfo = K900ProtocolUtils.extractFilePacket(completePacket)
            if (packetInfo != null && packetInfo.isValid) {
                enqueueFilePacket(packetInfo)
            } else {
                Log.e(TAG, "Failed to extract/validate reassembled file packet")
            }

            pos += expectedPacketSize
        }

        // Remove processed data from buffer
        if (pos > 0 && pos < filePacketBufferSize) {
            val remaining = filePacketBufferSize - pos
            System.arraycopy(filePacketBuffer, pos, filePacketBuffer, 0, remaining)
            filePacketBufferSize = remaining
        } else if (pos >= filePacketBufferSize) {
            filePacketBufferSize = 0
        }

        if (iterations >= MAX_ITERATIONS) {
            Log.e(TAG, "extractCompleteFilePackets: max iterations reached, clearing buffer")
            filePacketBufferSize = 0
        }
    }

    /** Clear the file packet reassembly buffer (call on disconnect) */
    private fun clearFilePacketBuffer() {
        synchronized(filePacketBufferLock) { filePacketBufferSize = 0 }
    }

    /**
     * Open the L2CAP CoC fast path for incoming file transfers (PSM 0x00C9).
     *
     * New BES2700 firmware registers an LE L2CAP CoC server; when the phone opens the channel,
     * the glasses send K900 file packets over it instead of GATT FILE_READ notifications.
     * Complete frames from the channel are fed into processFilePacketData — the exact same entry
     * point used by GATT FILE_READ notifications — so downstream reassembly (FileTransferSession,
     * transfer_complete) is unchanged. On any failure to open we stay on GATT notifications.
     */
    private fun openL2capFileChannel() {
        if (!enableL2capFilePath) {
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // createInsecureL2capChannel requires API 29
            Bridge.log("LIVE: L2CAP: unavailable, staying on GATT (requires Android 10+)")
            return
        }
        if (l2capFileChannel != null) {
            // Already open (or connecting) for this connection — e.g. repeated glasses_ready
            return
        }
        val device = connectedDevice
        if (device == null) {
            Log.w(TAG, "L2CAP: no connected device, staying on GATT")
            return
        }
        val channel =
                MentraLiveL2capChannel(L2CAP_FILE_PSM) { frame ->
                    // Same code path as a GATT FILE_READ notification carrying this frame
                    processFilePacketData(frame)
                }
        l2capFileChannel = channel
        channel.open(device)
    }

    /** Close the L2CAP file channel if open (call on disconnect). */
    private fun closeL2capFileChannel() {
        val channel = l2capFileChannel ?: return
        l2capFileChannel = null
        channel.close()
    }

    /** Process data received from the glasses */
    private fun processReceivedData(data: ByteArray?, size: Int) {
        // Bridge.log("LIVE: Processing received data: " + bytesToHex(data));

        // Check if we have enough data
        if (data == null || size < 1) {
            Log.w(TAG, "Received empty or invalid data packet")
            return
        }

        // Log the first few bytes to help with debugging
        val hexData = StringBuilder()
        for (i in 0 until Math.min(size, 16)) {
            hexData.append(String.format("%02X ", data[i]))
        }
        // Bridge.log("LIVE: Processing data packet, first " + Math.min(size, 16) + " bytes: " +
        // hexData.toString());

        // Get thread ID for consistent logging
        val threadId = Thread.currentThread().id

        // First check if this looks like a K900 protocol formatted message (starts with ##)
        if (size >= 7 && data[0] == 0x23.toByte() && data[1] == 0x23.toByte()) {
            Bridge.log(
                    "LIVE: Thread-" + threadId + ": 🔍 DETECTED K900 PROTOCOL FORMAT (## prefix)"
            )

            // Check the command type byte
            val cmdType = data[2]

            // Check if this is a file transfer packet
            if (cmdType == K900ProtocolUtils.CMD_TYPE_PHOTO ||
                            cmdType == K900ProtocolUtils.CMD_TYPE_VIDEO ||
                            cmdType == K900ProtocolUtils.CMD_TYPE_AUDIO ||
                            cmdType == K900ProtocolUtils.CMD_TYPE_DATA
            ) {

                Bridge.log(
                        "LIVE: Thread-" +
                                threadId +
                                ": 📦 DETECTED FILE TRANSFER PACKET (type: 0x" +
                                String.format("%02X", cmdType) +
                                ")"
                )

                // Debug: Log the raw data
                val hexDump = StringBuilder()
                for (i in 0 until Math.min(data.size, 64)) {
                    hexDump.append(String.format("%02X ", data[i]))
                }
                // Bridge.log("LIVE: Thread-" + threadId + ": 📦 Raw file packet data length=" +
                // data.length +
                //       ", first 64 bytes: " + hexDump.toString());

                // The data IS the file packet - it starts with ## and contains the full file packet
                // structure
                val packetInfo = K900ProtocolUtils.extractFilePacket(data)
                if (packetInfo != null && packetInfo.isValid) {
                    enqueueFilePacket(packetInfo)
                } else {
                    Log.e(TAG, "Thread-" + threadId + ": Failed to extract or validate file packet")
                    // BES chip handles ACKs automatically
                }

                return // Exit after processing file packet
            }

            if (cmdType == K900ProtocolUtils.CMD_TYPE_BINARY_MSG) {
                processBinaryWireFrame(data)
                return
            }

            // Learn the glasses' K900 length endianness from the frame we just received so future
            // outbound frames match. Guards against a peer that never advertises wire_caps.
            K900LengthCodec.detectLength(data)?.let { detected ->
                peerK900Le = detected.endian == K900LengthCodec.Endian.LE
            }

            // Otherwise it's a normal JSON message
            val json = K900ProtocolUtils.processReceivedBytesToJson(data)
            if (json != null) {
                val expanded = expandCompactWireJson(json)
                if (expanded == null) {
                    Log.w(TAG, "Thread-$threadId: Rejected unsupported compact wire form")
                    return
                }
                processJsonMessage(expanded)
            } else {
                Log.w(TAG, "Thread-" + threadId + ": Failed to parse K900 protocol data")
                // #region agent log [810da2] Hypothesis A+B: log header-declared length vs actual
                // data length
                val declaredPayloadLen =
                        if (data.size >= 5)
                                (((data[3].toInt() and 0xFF) shl 8) or (data[4].toInt() and 0xFF))
                        else -1
                Bridge.log(
                        "LIVE: [DEBUG-810da2-HypAB] K900 PARSE FAILED thread=" +
                                threadId +
                                " dataLen=" +
                                data.size +
                                " mtu=" +
                                currentMtu +
                                " declaredPayloadLen=" +
                                declaredPayloadLen +
                                " expectedTotal=" +
                                (declaredPayloadLen + 7)
                )
                // #endregion
            }

            return // Exit after processing K900 protocol format
        }

        // Check the first byte to determine the packet type for non-protocol formatted data
        val commandByte = data[0]
        // Bridge.log("LIVE: Command byte: 0x" + String.format("%02X", commandByte) + " (" +
        // (int)(commandByte & 0xFF) + ")");

        // NOTE: LC3 audio (0xA0) is now processed exclusively via the dedicated LC3_READ
        // characteristic
        // This prevents duplicate audio processing and follows the proper BLE characteristic
        // separation

        // Process non-audio data based on command byte
        when (commandByte) {
            '{'.code.toByte() -> { // Likely a JSON message (starts with '{')
                try {
                    val jsonStr = String(data, 0, size, StandardCharsets.UTF_8)
                    if (jsonStr.startsWith("{") && jsonStr.endsWith("}")) {
                        val json = JSONObject(jsonStr)
                        processJsonMessage(json)
                    } else {
                        Log.w(TAG, "Received data that starts with '{' but is not valid JSON")
                    }
                } catch (e: JSONException) {
                    Log.e(TAG, "Error parsing received JSON data", e)
                }
            }
            else -> {
                // Unknown packet type (LC3 audio 0xA0 is handled via dedicated characteristic)
                // Log.w(TAG, "Received unknown packet type: " + String.format("0x%02X",
                // commandByte));
                if (size > 10) {
                    // Bridge.log("LIVE: First 10 bytes: " + bytesToHex(Arrays.copyOfRange(data, 0,
                    // 10)));
                } else {
                    Bridge.log("LIVE: Data: " + bytesToHex(data))
                }
            }
        }
    }

    /** Process a JSON message */
    private fun processJsonMessage(json: JSONObject) {
        // Demoted from INFO (Bridge.log) to DEBUG: per-type handlers below already log
        // the messages that matter, and full payloads can leak PII (wifi SSID, bt_mac,
        // OTA URLs) into the persisted file logger when they arrive every ~50ms during OTA.
        // Re-enable on a debugging device via: adb shell setprop log.tag.MentraLive DEBUG
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            Log.d(TAG, "LIVE: Got some JSON from glasses: " + json.toString())
        }
        BleTraceLogger.logJson("glasses_to_phone", "sdk_ble_event", json, null)

        if (MessageChunker.isChunkedMessage(json)) {
            processChunkedJsonMessage(json)
            return
        }

        // Check if this is an ACK response
        val type = json.optString("type", "")
        if ("msg_ack" == type) {
            val messageId = json.optLong("mId", -1)
            if (messageId != -1L) {
                processAckResponse(messageId)
                return
            }
        }

        // Check if this is a K900 command format (has "C" field instead of "type")
        if (json.has("C")) {
            processK900JsonMessage(json)
            return
        }

        when (type) {
            "file_announce" -> handleFileTransferAnnouncement(json)
            "transfer_timeout" -> handleTransferTimeout(json)
            "transfer_failed" -> handleTransferFailed(json)
            "ble_photo_ready" -> processBlePhotoReady(json)
            "photo_status" ->
                    try {
                        Bridge.sendPhotoStatus(jsonObjectToMap(json))
                    } catch (e: JSONException) {
                        Log.e(TAG, "Error converting photo status to Map", e)
                    }
            "camera_status" ->
                    try {
                        Bridge.sendCameraStatus(jsonObjectToMap(json))
                    } catch (e: JSONException) {
                        Log.e(TAG, "Error converting camera status to Map", e)
                    }
            "stream_status" -> {
                // Process streaming status update from ASG client
                Bridge.log("LIVE: Received stream status update from glasses: " + json.toString())

                // Check if this is an error status
                val status = json.optString("status", "")
                if ("error" == status) {
                    val errorDetails = json.optString("errorDetails", "")
                    Log.e(TAG, "🚨🚨🚨 RTMP STREAM ERROR DETECTED 🚨🚨🚨")
                    Log.e(TAG, "📄 Error details: " + errorDetails)
                    Log.e(TAG, "⏱️ Timestamp: " + System.currentTimeMillis())

                    // Check if it's the timeout error we're investigating
                    if (errorDetails.contains("Stream timed out") ||
                                    errorDetails.contains("no keep-alive")
                    ) {
                        Log.e(TAG, "🔍 RTMP TIMEOUT ERROR - Dumping diagnostic info:")
                        Log.e(TAG, "💓 Last heartbeat counter: " + heartbeatCounter)
                        Log.e(TAG, "⏱️ Current timestamp: " + System.currentTimeMillis())

                        // Dump thread states for debugging
                        dumpThreadStates()

                        // Log BLE connection state
                        Log.e(TAG, "🔌 BLE Connection state:")
                        Log.e(TAG, "   - isConnected: " + isConnected)
                        Log.e(
                                TAG,
                                "   - bluetoothGatt: " +
                                        (if (bluetoothGatt != null) "NOT NULL" else "NULL")
                        )
                        Log.e(
                                TAG,
                                "   - txCharacteristic: " +
                                        (if (txCharacteristic != null) "NOT NULL" else "NULL")
                        )
                        Log.e(
                                TAG,
                                "   - rxCharacteristic: " +
                                        (if (rxCharacteristic != null) "NOT NULL" else "NULL")
                        )
                        Log.e(TAG, "   - connectionState: " + connectionState)
                        Log.e(TAG, "   - glassesReady: " + glassesReady)
                    }
                }

                // Forward to websocket system via Bridge (matches iOS emitRtmpStreamStatus)
                try {
                    Bridge.sendStreamStatus(jsonObjectToMap(json))
                } catch (e: JSONException) {
                    Log.e(TAG, "Error converting RTMP status to Map", e)
                }
            }
            "video_recording_status" -> emitVideoRecordingStatus(json)
            "media_success", "media_error" -> {
                try {
                    Bridge.sendMediaUploadEvent(type, jsonObjectToMap(json))
                } catch (e: JSONException) {
                    Log.e(TAG, "Error converting media upload event to Map", e)
                }
            }
            "voice_activity_detection_status" ->
                    handleVoiceActivityDetectionStatus(
                            json.optBoolean(
                                    "voiceActivityDetectionEnabled",
                                    BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
                            )
                    )
            "speaking_status" -> handleSpeakingStatus(json.optBoolean("speaking", false))
            "battery_status" -> {
                // Percent only. battery_status derives from hm_batv, which carries no charge
                // bit — older glasses fabricate `charging` from a voltage threshold (>3.9V)
                // that reads "charging" for most of a discharging pack's range. Charging
                // state comes exclusively from the PMU charg bit in the sr_hrt heartbeat.
                val percent = json.optInt("percent", batteryLevel)
                updateBatteryStatus(percent, isCharging)
            }
            "pong" ->
                    // Process heartbeat pong response
                    Bridge.log("LIVE: Received pong response - connection healthy")
            "imu_response",
            "imu_stream_response",
            "imu_gesture_response",
            "imu_gesture_subscribed",
            "imu_ack",
            "imu_error" ->
                    // Handle IMU-related responses
                    handleImuResponse(json)
            "wifi_status" -> {
                // Process WiFi status information
                val wifiConnectedStatus = json.optBoolean("connected", false)
                val ssid = json.optString("ssid", "")
                val localIp = json.optString("local_ip", "")

                // Provisioning failure reason (e.g. connect_timeout). Sticky: routine
                // error-less status updates (link-state debounce, request_wifi_status)
                // must not clear a failure nothing recovered from — only a newer error
                // or a successful connection overwrites it.
                val wifiError = json.optString("error", "")
                if (wifiError.isNotEmpty()) {
                    Bridge.log("LIVE: 🌐 WiFi provisioning error from glasses: $wifiError")
                    DeviceStore.apply("glasses", "wifiError", wifiError)
                } else if (wifiConnectedStatus) {
                    DeviceStore.apply("glasses", "wifiError", "")
                }

                updateWifiStatus(
                        wifiConnectedStatus,
                        ssid,
                        localIp,
                        wifiError.takeIf { it.isNotEmpty() }
                )
            }
            "hotspot_status_update" -> {
                // Process hotspot status information (same pattern as "wifi_status")
                val hotspotEnabled = json.optBoolean("hotspot_enabled", false)
                val hotspotSsid = json.optString("hotspot_ssid", "")
                val hotspotPassword = json.optString("hotspot_password", "")
                val hotspotGatewayIp = json.optString("hotspot_gateway_ip", "")

                updateHotspotStatus(hotspotEnabled, hotspotSsid, hotspotPassword, hotspotGatewayIp)
            }
            "hotspot_error" -> {
                // Process hotspot error
                val errorMessage = json.optString("error_message", "Unknown hotspot error")
                val timestamp = json.optLong("timestamp", System.currentTimeMillis())

                handleHotspotError(errorMessage, timestamp)
            }
            "photo_response" -> {
                // Process photo response (success or failure)
                val requestId = json.optString("requestId", "")
                val appId = json.optString("appId", "")
                val photoState = json.optString("state", "")
                val photoSuccess = "success" == photoState || json.optBoolean("success", false)

                try {
                    Bridge.sendPhotoResponse(jsonObjectToMap(json))
                } catch (e: JSONException) {
                    Log.e(TAG, "Error converting photo response to Map", e)
                }

                if (!photoSuccess) {
                    // Handle failed photo response
                    val errorMsg =
                            json.optString("errorMessage", json.optString("error", "Unknown error"))
                    Bridge.log(
                            "LIVE: Photo request failed - requestId: " +
                                    requestId +
                                    ", appId: " +
                                    appId +
                                    ", error: " +
                                    errorMsg
                    )
                } else {
                    // Handle successful photo (in future implementation)
                    Bridge.log("LIVE: Photo request succeeded - requestId: " + requestId)
                }
            }
            "ble_photo_complete" -> {
                // Process BLE photo transfer completion
                val bleRequestId = json.optString("requestId", "")
                val bleBleImgId = json.optString("bleImgId", "")
                val bleSuccess = json.optBoolean("success", false)

                Bridge.log(
                        "LIVE: BLE photo transfer complete - requestId: " +
                                bleRequestId +
                                ", bleImgId: " +
                                bleBleImgId +
                                ", success: " +
                                bleSuccess
                )

                // Send completion notification back to glasses
                if (bleSuccess) {
                    sendBleTransferComplete(bleRequestId, bleBleImgId, true)
                } else {
                    Log.e(TAG, "BLE photo transfer failed for requestId: " + bleRequestId)
                }
            }
            "wifi_scan_result" -> {
                // Process WiFi scan results
                val networks: MutableList<Map<String, Any>> = ArrayList()

                if (json.has("networks_neo")) {
                    try {
                        val networksNeoArray = json.getJSONArray("networks_neo")

                        for (i in 0 until networksNeoArray.length()) {
                            val networkInfo = networksNeoArray.getJSONObject(i)

                            // Convert JSONObject to Map
                            val networkMap = HashMap<String, Any>()
                            val keys = networkInfo.keys()
                            while (keys.hasNext()) {
                                val key = keys.next()
                                networkMap[key] = networkInfo.get(key)
                            }
                            networks.add(networkMap)
                        }

                        Bridge.log(
                                "Received enhanced WiFi scan results: " +
                                        networks.size +
                                        " networks with security info"
                        )
                    } catch (e: JSONException) {
                        Log.e(TAG, "Error parsing networks_neo", e)
                    }
                }

                val scanComplete =
                        json.optBoolean("scan_complete", json.optBoolean("scanComplete", false))
                val scanId = json.optString("scanId", "").ifEmpty { null }
                Bridge.updateWifiScanResults(networks, scanComplete, scanId)
            }
            "token_status" -> {
                // Process coreToken acknowledgment
                val success = json.optBoolean("success", false)
                Bridge.log(
                        "LIVE: Received token status from ASG client: " +
                                (if (success) "SUCCESS" else "FAILED")
                )
            }
            "ota_start_ack" -> {
                // Glasses acknowledged receipt of ota_start — phone can cancel its retry timer
                Bridge.log("LIVE: 📱 Received ota_start_ack from glasses")
                Bridge.sendOtaStartAck()
            }
            "ota_status" -> {
                val osSessionId = json.optString("sid", json.optString("session_id", ""))
                val osTotalSteps = json.optInt("ts", json.optInt("total_steps", 0))
                val osCurrentStep = json.optInt("cs", json.optInt("current_step", 0))
                val osStepType = json.optString("st", json.optString("step_type", "apk"))
                val osPhase = json.optString("phase", "download")
                val osStepPercent = json.optInt("sp", json.optInt("step_percent", 0))
                val osOverallPercent = json.optInt("op", json.optInt("overall_percent", 0))
                val osStatus = json.optString("status", "idle")
                val osErrorMessage: String? =
                        json.optString("err", json.optString("error_message", null))

                // If the glasses started a new session, drop any leftover state from the
                // old one before caching the new values. Without this, lastBesOtaProgress
                // would stay at e.g. 95 from the previous session and cause us to silently
                // skip the first few percent of the new BES install.
                if (!osSessionId.isEmpty() &&
                                cachedOtaSessionId != null &&
                                cachedOtaSessionId != osSessionId
                ) {
                    resetOtaCache()
                }

                cachedOtaSessionId = osSessionId
                cachedOtaTotalSteps = osTotalSteps
                cachedOtaCurrentStep = osCurrentStep
                var osStepSequence = json.optJSONArray("sq")
                if (osStepSequence == null) osStepSequence = json.optJSONArray("step_sequence")
                if (osStepSequence != null && osStepSequence.length() > 0) {
                    cachedOtaStepSequence = osStepSequence
                }
                updateBesOtaHeartbeatGuard(osStepType, osPhase, osStatus)

                Bridge.log(
                        "LIVE: 📱 OTA status - step " +
                                osCurrentStep +
                                "/" +
                                osTotalSteps +
                                " " +
                                osPhase +
                                " " +
                                osStatus +
                                " " +
                                osOverallPercent +
                                "%"
                )

                val glassesTimeMs = json.optLong("glasses_time_ms", 0)
                Bridge.sendOtaStatus(
                        osSessionId,
                        osTotalSteps,
                        osCurrentStep,
                        osStepType,
                        osPhase,
                        osStepPercent,
                        osOverallPercent,
                        osStatus,
                        osErrorMessage,
                        if (glassesTimeMs > 0) glassesTimeMs else null
                )
            }
            "ota_progress" -> {
                // Legacy glasses firmware: map to unified ota_status so JS has a single path
                // (Mantle / progress UI).
                run {
                    val legacyStage = json.optString("stage", "download")
                    val legacyStatus = json.optString("status", "PROGRESS")
                    val legacyProgress = json.optInt("progress", 0)
                    val currentUpdate = json.optString("current_update", "apk")
                    var err: String? = json.optString("error_message", null)
                    if (err != null && err.isEmpty()) {
                        err = null
                    }
                    val legacyPhase = if ("install" == legacyStage) "install" else "download"
                    val unified: String
                    if ("FAILED" == legacyStatus) {
                        unified = "failed"
                    } else if ("FINISHED" == legacyStatus) {
                        unified = "complete"
                    } else {
                        unified = "in_progress"
                    }
                    updateBesOtaHeartbeatGuard(currentUpdate, legacyPhase, unified)
                    Bridge.log(
                            "LIVE: 📱 Legacy ota_progress → ota_status: " +
                                    legacyStage +
                                    " " +
                                    legacyStatus +
                                    " " +
                                    legacyProgress +
                                    "%"
                    )
                    Bridge.sendOtaStatus(
                            "",
                            1,
                            1,
                            currentUpdate,
                            legacyPhase,
                            legacyProgress,
                            legacyProgress,
                            unified,
                            err
                    )
                }
            }
            "button_press" -> {
                // Process button press event
                val buttonId = json.optString("buttonId", "unknown")
                val pressType = json.optString("pressType", "short")

                Bridge.log(
                        "LIVE: Received button press - buttonId: " +
                                buttonId +
                                ", pressType: " +
                                pressType
                )

                Bridge.sendButtonPressEvent(buttonId, pressType)
            }
            "gallery_status" -> {
                // Process gallery status response
                val photoCount = json.optInt("photos", 0)
                val videoCount = json.optInt("videos", 0)
                val totalCount = json.optInt("total", 0)
                val totalSize = json.optLong("total_size", 0)
                val hasContent = json.optBoolean("has_content", false)
                val cameraBusyValue = json.opt("camera_busy")
                var cameraBusy = json.optBoolean("cameraBusy", false)
                var cameraBusyReason: String? = json.optString("cameraBusyReason", null)
                if (cameraBusyValue is Boolean) {
                    cameraBusy = cameraBusy || cameraBusyValue
                } else if (cameraBusyValue is String) {
                    val busyReason = cameraBusyValue.trim()
                    if (!busyReason.isEmpty() && !"false".equals(busyReason, ignoreCase = true)) {
                        cameraBusy = true
                        cameraBusyReason = busyReason
                    }
                }

                Bridge.log(
                        "LIVE: 📸 Received gallery status: " +
                                photoCount +
                                " photos, " +
                                videoCount +
                                " videos, total size: " +
                                totalSize +
                                " bytes"
                )

                // Send gallery status to React Native frontend (matches iOS pattern)
                Bridge.sendGalleryStatus(
                        photoCount,
                        videoCount,
                        totalCount,
                        totalSize,
                        hasContent,
                        cameraBusy,
                        cameraBusyReason
                )
            }
            "settings_ack" -> emitSettingsAck(json)

            // case "touch_event":
            //     // Process touch event from glasses (swipes, taps, long press)
            //     String gestureName = json.optString("gesture_name", "unknown");
            //     long touchTimestamp = json.optLong("timestamp", System.currentTimeMillis());
            //     String touchDeviceModel = json.optString("device_model", getDeviceModel());

            //     Log.d(TAG, "👆 Received touch event - Gesture: " + gestureName);

            //     // Send touch event to React Native
            //     // Bridge.sendTouchEvent(touchDeviceModel, gestureName, touchTimestamp);
            //     break;

            "sr_tpevt" -> {
                // K900 touchpad event - convert to touch_event for frontend
                try {
                    val bodyObj = json.optJSONObject("B")
                    if (bodyObj != null) {
                        val gestureType = bodyObj.optInt("type", -1)
                        val gestureName = mapK900GestureType(gestureType)

                        if (gestureName != null) {
                            Bridge.log(
                                    "LIVE: 👆 K900 touchpad event - Type: " +
                                            gestureType +
                                            " -> " +
                                            gestureName
                            )
                            Bridge.sendTouchEvent(
                                    deviceModel,
                                    gestureName,
                                    System.currentTimeMillis()
                            )
                        } else {
                            Log.d(TAG, "Unknown K900 gesture type: " + gestureType)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_tpevt", e)
                }
            }
            "swipe_volume_status" -> {
                // Process swipe volume control status from glasses
                val swipeVolumeEnabled = json.optBoolean("enabled", false)
                val swipeTimestamp = json.optLong("timestamp", System.currentTimeMillis())

                Log.d(TAG, "🔊 Received swipe volume status - Enabled: " + swipeVolumeEnabled)

                // Send swipe volume status to React Native
                Bridge.sendSwipeVolumeStatus(swipeVolumeEnabled, swipeTimestamp)
            }
            "switch_status" -> {
                // Process switch status report from glasses
                val switchType =
                        if (json.has("switch_type")) json.optInt("switch_type", -1)
                        else json.optInt("switchType", -1)
                val switchValue =
                        if (json.has("switch_value")) json.optInt("switch_value", -1)
                        else json.optInt("switchValue", -1)
                val switchTimestamp = json.optLong("timestamp", System.currentTimeMillis())

                Log.d(
                        TAG,
                        "🔘 Received switch status - Type: " +
                                switchType +
                                ", Value: " +
                                switchValue
                )

                handleSwitchStatus(switchType, switchValue, switchTimestamp)
            }
            "sensor_data" -> {
                // Process sensor data
                // ...
            }
            "glasses_ready" -> {
                // Glasses SOC has booted and is ready for communication
                Bridge.log("LIVE: 🎉 Received glasses_ready message - SOC is booted and ready!")

                // glasses_ready is a REMOTE wire-session reset: the glasses ran
                // onTransportReset() before sending it, so their side is back on legacy
                // framing regardless of what this side negotiated earlier. Start a fresh
                // wire epoch (clears v2-active state that would otherwise gate the
                // handshake off), then negotiate from the caps this message advertises.
                resetWireNegotiationState()
                parsePeerWireCaps(json)
                maybeSendWireHandshake()
                // Record the session id BEFORE marking ready: an unsolicited glasses_ready
                // already runs this full remote-reset flow, so recording (not re-triggering)
                // is correct here; version_info detection covers the restart case.
                json.optString("sid", "").takeIf { it.isNotEmpty() }?.let { glassesSessionId = it }
                readinessCompletedThisBleSession = true

                // Set the ready flag to stop any future readiness checks
                glassesReady = true
                glassesReadyReceived = true
                // NOTE: Don't set fullyBooted here - it will be set when BOTH glasses_ready
                // AND audioConnected are true (see below). This ensures BT Classic pairing
                // is complete before the device is considered "paired" in MentraOS.

                // Stop the readiness check loop since we got confirmation
                stopReadinessCheckLoop()
                advertiseFilePayloadCapabilityToBes()

                // Try to open the L2CAP CoC fast path for file transfers. No-op when the
                // firmware doesn't support it — GATT notifications remain the default path.
                try {
                    openL2capFileChannel()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: openL2capFileChannel threw: " + t)
                }

                // Send BLE MTU config to glasses so they can adjust file packet sizes.
            // Use the minimum of negotiated MTU and BES2700's datapath limit (509).
                val effectiveMtu = Math.min(currentMtu, BES2700_MTU_LIMIT)
                Bridge.log(
                        "LIVE: 📦 Sending BLE MTU config: negotiated=" +
                                currentMtu +
                                ", BES2700 limit=" +
                                BES2700_MTU_LIMIT +
                                ", effective=" +
                                effectiveMtu
                )
                try {
                    sendBleMtuConfig(effectiveMtu)
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: sendBleMtuConfig threw: " + t)
                }

                // Now we can perform all SOC-dependent initialization
                Bridge.log("LIVE: 🔄 Requesting battery and WiFi status from glasses")
                try {
                    requestBatteryStatus()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: requestBatteryStatus threw: " + t)
                }
                try {
                    requestWifiStatus()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: requestWifiStatus threw: " + t)
                }

                // Request version info from ASG client
                Bridge.log("LIVE: 🔄 Requesting version info from ASG client")
                try {
                    val versionRequest = JSONObject()
                    versionRequest.put("type", "request_version")
                    sendJson(versionRequest)
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: request_version threw: " + t)
                }

                Bridge.log("LIVE: 🔄 Sending coreToken to ASG client")
                try {
                    sendCoreTokenToAsgClient()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: sendCoreTokenToAsgClient threw: " + t)
                }

                // Send stored user email for crash reporting
                try {
                    sendStoredUserEmailToAsgClient()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: sendStoredUserEmailToAsgClient threw: " + t)
                }

                // startDebugVideoCommandLoop();

                // Start the heartbeat mechanism now that glasses are ready
                try {
                    startHeartbeat()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: startHeartbeat threw: " + t)
                }

                // Start the micbeat mechanism now that glasses are ready
                // startMicBeat();

                // Send user settings to glasses
                try {
                    sendUserSettings()
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: sendUserSettings threw: " + t)
                }

                // Claim RGB LED control authority
                // DISABLED: MentraLive is not supposed to send this command
                // sendRgbLedControlAuthority(true);

                // Initialize LC3 audio logging now that glasses are ready
                try {
                    initializeLc3Logging()
                    Bridge.log("LIVE: ✅ LC3 audio logging initialized for device")
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: initializeLc3Logging threw: " + t)
                }

                // Restore mic state if it was enabled before reconnect
                try {
                    if (micIntentEnabled) {
                        if (BLOCK_AUDIO_DUPLEX &&
                                        phoneAudioMonitor != null &&
                                        phoneAudioMonitor!!.isPlaying()
                        ) {
                            micSuspendedForAudio = true
                            Bridge.log(
                                    "LIVE: 🎤 Restoring mic intent after reconnect, but phone audio is playing - suspending"
                            )
                        } else {
                            micSuspendedForAudio = false
                            Bridge.log("LIVE: 🎤 Restoring mic state after reconnect")
                            startMicBeat()
                        }
                    }
                } catch (t: Throwable) {
                    Bridge.log("LIVE: ⚠️ glasses_ready: mic restore threw: " + t)
                }

                // Audio Pairing: Only mark as fully connected if audio is also ready
                // On Android, CTKD automatically pairs BT Classic when BLE bonds, so audio is
                // always ready
                // This check maintains platform parity with iOS
                if (audioConnected) {
                    Bridge.log(
                            "LIVE: Audio: Both glasses_ready and audio connected - marking as fully connected"
                    )
                    DeviceStore.apply("glasses", "fullyBooted", true)
                    updateConnectionState(ConnTypes.CONNECTED)
                } else {
                    Bridge.log(
                            "LIVE: Audio: Waiting for CTKD audio bonding before marking as fully connected"
                    )
                }
            }
            "keep_alive_ack" -> {
                // Process keep-alive ACK from ASG client
                Bridge.log("LIVE: Received keep-alive ACK from glasses: " + json.toString())

                // Forward to websocket system via Bridge (matches iOS emitKeepAliveAck)
                try {
                    Bridge.sendKeepAliveAck(jsonObjectToMap(json))
                } catch (e: JSONException) {
                    Log.e(TAG, "Error converting keep_alive_ack to Map", e)
                }
            }

            // Removed: version_info_1 and version_info_2 cases
            // Now handled by flexible parsing in default case below

            "version_info" -> {
                // Process version information from ASG client (legacy single-message format)
                Bridge.log("LIVE: Received version info from ASG client")

                // Extract version information
                val appVersionLegacy = json.optString("app_version", "")
                val buildNumberLegacy = json.optString("build_number", "")
                val deviceModelLegacy = json.optString("device_model", "")
                val androidVersionLegacy = json.optString("android_version", "")
                val otaVersionUrlLegacy: String? = json.optString("ota_version_url", null)
                val firmwareVersionLegacy = json.optString("firmware_version", "")
                val btMacAddressLegacy = json.optString("bt_mac_address", "")
                val serialNumberLegacy = json.optString("serial_number", "")

                // Update parent SGCManager fields
                DeviceStore.apply("glasses", "appVersion", appVersionLegacy)
                DeviceStore.apply("glasses", "buildNumber", buildNumberLegacy)
                DeviceStore.apply("glasses", "deviceModel", deviceModelLegacy)
                DeviceStore.apply("glasses", "androidVersion", androidVersionLegacy)
                DeviceStore.apply(
                        "glasses",
                        "otaVersionUrl",
                        if (otaVersionUrlLegacy != null) otaVersionUrlLegacy else ""
                )
                DeviceStore.apply("glasses", "firmwareVersion", firmwareVersionLegacy)
                btMacAddressLegacy.trim().takeIf { it.isNotEmpty() }?.let {
                    DeviceStore.apply("glasses", "bluetoothMacAddress", it)
                }
                serialNumberLegacy.trim().takeIf { it.isNotEmpty() }?.let {
                    DeviceStore.apply("glasses", "serialNumber", it)
                }

                val versionInfoLegacy = HashMap<String, Any>()
                versionInfoLegacy["appVersion"] = appVersionLegacy
                versionInfoLegacy["buildNumber"] = buildNumberLegacy
                versionInfoLegacy["deviceModel"] = deviceModelLegacy
                versionInfoLegacy["androidVersion"] = androidVersionLegacy
                versionInfoLegacy["otaVersionUrl"] =
                        if (otaVersionUrlLegacy != null) otaVersionUrlLegacy else ""
                versionInfoLegacy["firmwareVersion"] = firmwareVersionLegacy
                Bridge.sendVersionInfo(versionInfoLegacy)

                // Parse build number as integer for version checks (local field)
                try {
                    buildNumberInt = Integer.parseInt(buildNumberLegacy)
                    Bridge.log("LIVE: Parsed build number as integer: " + buildNumberInt)
                } catch (e: NumberFormatException) {
                    buildNumberInt = 0
                    Log.e(TAG, "Failed to parse build number as integer: " + buildNumberLegacy)
                }
                parsePeerWireCaps(json)
                maybeSendWireHandshake()
            }
            "ota_download_progress" -> {
                // Process OTA download progress from ASG client
                Bridge.log(
                        "LIVE: 📥 Received OTA download progress from ASG client: " +
                                json.toString()
                )

                // Extract download progress information
                val downloadStatus = json.optString("status", "")
                val downloadProgress = json.optInt("progress", 0)
                val bytesDownloaded = json.optLong("bytes_downloaded", 0)
                val totalBytes = json.optLong("total_bytes", 0)
                val downloadErrorMessage: String? = json.optString("error_message", null)
                val downloadTimestamp = json.optLong("timestamp", System.currentTimeMillis())

                Bridge.log(
                        "LIVE: 📥 OTA Download Progress - Status: " +
                                downloadStatus +
                                ", Progress: " +
                                downloadProgress +
                                "%" +
                                ", Bytes: " +
                                bytesDownloaded +
                                "/" +
                                totalBytes +
                                (if (downloadErrorMessage != null)
                                        ", Error: " + downloadErrorMessage
                                else "")
                )

                // Emit EventBus event for AugmentosService on main thread
                try {
                    // DownloadProgressEvent.DownloadStatus downloadEventStatus;
                    // final DownloadProgressEvent event;
                    when (downloadStatus) {
                        "STARTED" -> {
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.STARTED;
                            // event = new DownloadProgressEvent(downloadEventStatus, totalBytes);
                        }
                        "PROGRESS" -> {
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.PROGRESS;
                            // event = new DownloadProgressEvent(downloadEventStatus,
                            // downloadProgress, bytesDownloaded, totalBytes);
                        }
                        "FINISHED" -> {
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.FINISHED;
                            // event = new DownloadProgressEvent(downloadEventStatus, totalBytes,
                            // true);
                        }
                        "FAILED" -> {
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.FAILED;
                            // event = new DownloadProgressEvent(downloadEventStatus,
                            // downloadErrorMessage);
                        }
                        else -> {
                            Log.w(TAG, "Unknown download status: " + downloadStatus)
                            return
                        }
                    }

                    // Post event on main thread to ensure proper delivery
                    handler.post {
                        // Bridge.log("LIVE: 📡 Posting download progress event on main thread: " +
                        // downloadEventStatus);
                        // EventBus.getDefault().post(event);
                        // Bridge.
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error creating download progress event", e)
                }

                // Forward to data observable for cloud communication
                // if (dataObservable != null) {
                // dataObservable.onNext(json);
                // }
            }
            "ota_installation_progress" -> {
                // Process OTA installation progress from ASG client
                Bridge.log(
                        "LIVE: 🔧 Received OTA installation progress from ASG client: " +
                                json.toString()
                )

                // Extract installation progress information
                val installationStatus = json.optString("status", "")
                val apkPath = json.optString("apk_path", "")
                val installationErrorMessage: String? = json.optString("error_message", null)
                val installationTimestamp = json.optLong("timestamp", System.currentTimeMillis())

                Bridge.log(
                        "LIVE: 🔧 OTA Installation Progress - Status: " +
                                installationStatus +
                                ", APK: " +
                                apkPath +
                                (if (installationErrorMessage != null)
                                        ", Error: " + installationErrorMessage
                                else "")
                )

                // Emit EventBus event for AugmentosService on main thread
                try {
                    // InstallationProgressEvent.InstallationStatus installationEventStatus;
                    // final InstallationProgressEvent event;
                    when (installationStatus) {
                        "STARTED" -> {
                            // installationEventStatus =
                            // InstallationProgressEvent.InstallationStatus.STARTED;
                            // event = new InstallationProgressEvent(installationEventStatus,
                            // apkPath);
                        }
                        "FINISHED" -> {
                            // installationEventStatus =
                            // InstallationProgressEvent.InstallationStatus.FINISHED;
                            // event = new InstallationProgressEvent(installationEventStatus,
                            // apkPath);
                        }
                        "FAILED" -> {
                            // installationEventStatus =
                            // InstallationProgressEvent.InstallationStatus.FAILED;
                            // event = new InstallationProgressEvent(installationEventStatus,
                            // apkPath, installationErrorMessage);
                        }
                        else -> {
                            // Log.w(TAG, "Unknown installation status: " + installationStatus);
                            return
                        }
                    }

                    // Post event on main thread to ensure proper delivery
                    handler.post {
                        // Bridge.log("LIVE: 📡 Posting installation progress event on main thread:
                        // " + installationEventStatus);
                        // EventBus.getDefault().post(event);
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error creating installation progress event", e)
                }

                // Forward to data observable for cloud communication
                // if (dataObservable != null) {
                // dataObservable.onNext(json);
                // }
            }
            "mtk_update_complete" -> {
                // Process MTK firmware update complete notification from ASG client
                Bridge.log("LIVE: 🔄 Received MTK update complete from ASG client")

                val updateMessage =
                        json.optString("message", "MTK firmware updated. Please restart glasses.")
                val updateTimestamp = json.optLong("timestamp", System.currentTimeMillis())

                Bridge.log("LIVE: 🔄 MTK Update Message: " + updateMessage)

                // Send to React Native via Bridge on main thread
                handler.post { Bridge.sendMtkUpdateComplete(updateMessage) }
            }
            else -> {
                // Flexible version_info parsing - handle any version_info* message
                if (type.startsWith("version_info")) {
                    Bridge.log("LIVE: Received " + type)

                    // Extract all fields from JSON (except "type")
                    val fields = HashMap<String, Any>()
                    val keys = json.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        if (key != "type") {
                            val v = json.opt(key)
                            if (v != null) {
                                fields[key] = v
                            }
                        }
                    }

                    // Update DeviceStore for any fields we recognize
                    if (fields.containsKey("app_version")) {
                        DeviceStore.apply("glasses", "appVersion", fields["app_version"] as String)
                    }
                    if (fields.containsKey("build_number")) {
                        val buildNum = fields["build_number"] as String
                        DeviceStore.apply("glasses", "buildNumber", buildNum)
                        // Parse build number as integer for version checks
                        try {
                            val buildNumInt = Integer.parseInt(buildNum)
                            buildNumberInt = buildNumInt
                            Bridge.log("LIVE: Parsed build number as integer: " + buildNumInt)
                        } catch (e: NumberFormatException) {
                            buildNumberInt = 0
                            Log.e(TAG, "Failed to parse build number as integer: " + buildNum)
                        }
                    }
                    if (fields.containsKey("device_model")) {
                        val deviceModel = fields["device_model"] as String
                        DeviceStore.apply("glasses", "deviceModel", deviceModel)
                        // Determine LC3 audio support: base K900 doesn't support LC3, variants do
                        val supportsLC3Audio = "K900" != deviceModel
                        Bridge.log(
                                "LIVE: 📱 LC3 audio support: " +
                                        supportsLC3Audio +
                                        " (device: " +
                                        deviceModel +
                                        ")"
                        )
                    }
                    if (fields.containsKey("android_version")) {
                        DeviceStore.apply(
                                "glasses",
                                "androidVersion",
                                fields["android_version"] as String
                        )
                    }
                    if (fields.containsKey("ota_version_url")) {
                        DeviceStore.apply(
                                "glasses",
                                "otaVersionUrl",
                                fields["ota_version_url"] as String
                        )
                    }
                    if (fields.containsKey("firmware_version")) {
                        DeviceStore.apply(
                                "glasses",
                                "firmwareVersion",
                                fields["firmware_version"] as String
                        )
                    }
                    if (fields.containsKey("bes_fw_version")) {
                        DeviceStore.apply(
                                "glasses",
                                "besFirmwareVersion",
                                fields["bes_fw_version"] as String
                        )
                    }
                    if (fields.containsKey("mtk_fw_version")) {
                        DeviceStore.apply(
                                "glasses",
                                "mtkFirmwareVersion",
                                fields["mtk_fw_version"] as String
                        )
                    }
                    (fields["bt_mac_address"] as? String)?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        DeviceStore.apply("glasses", "bluetoothMacAddress", it)
                    }
                    (fields["serial_number"] as? String)?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        DeviceStore.apply("glasses", "serialNumber", it)
                    }
                    if (fields.containsKey("system_time_ms")) {
                        val v = fields["system_time_ms"]
                        if (v is Number) {
                            DeviceStore.apply("glasses", "systemTimeMs", v.toLong())
                        }
                    }
                    if (fields.containsKey("hotspot_ota_version")) {
                        val version = fields["hotspot_ota_version"]
                        if (version is Number) {
                            DeviceStore.apply("glasses", "hotspotOtaVersion", version.toInt())
                        }
                    }

                    // Negotiate wire caps from ANY version_info chunk, not only the one
                    // carrying build_number: the glasses put wire_caps in version_info_3
                    // (firmware chunk) while build_number travels in version_info_1, so
                    // gating negotiation on build_number silently discards the caps.
                    // parsePeerWireCaps no-ops without a wire_caps key and
                    // maybeSendWireHandshake gates on caps + build + not-yet-queued, so
                    // running them per chunk is safe.
                    parsePeerWireCaps(json)
                    maybeSendWireHandshake()
                    handleGlassesSessionId(json)

                    Bridge.log("LIVE: Processed version_info fields and sent to RN")
                    Bridge.sendVersionInfo(fields)
                } else {
                    Log.d(TAG, "📦 Unknown message type: " + type)
                }
            }
        }
    }

    private fun emitSettingsAck(json: JSONObject) {
        try {
            val body = jsonObjectToMap(json)
            if (body.containsKey("request_id") && !body.containsKey("requestId")) {
                body["requestId"] = body["request_id"]!!
            }
            if (body.containsKey("roi_position") && !body.containsKey("roiPosition")) {
                body["roiPosition"] = body["roi_position"]!!
            }
            if (body.containsKey("error_code") && !body.containsKey("errorCode")) {
                body["errorCode"] = body["error_code"]!!
            }
            if (body.containsKey("error_message") && !body.containsKey("errorMessage")) {
                body["errorMessage"] = body["error_message"]!!
            }
            if (body.containsKey("hardware_applied") && !body.containsKey("hardwareApplied")) {
                body["hardwareApplied"] = body["hardware_applied"]!!
            }
            body.remove("request_id")
            body.remove("roi_position")
            body.remove("error_code")
            body.remove("error_message")
            body.remove("hardware_applied")
            if (!body.containsKey("timestamp")) {
                body["timestamp"] = System.currentTimeMillis()
            }
            Bridge.sendSettingsAck(body)
        } catch (e: JSONException) {
            Log.e(TAG, "Error converting settings_ack to Map", e)
        }
    }

    private fun emitVideoRecordingStatus(json: JSONObject) {
        try {
            val body = jsonObjectToMap(json)
            if (body.containsKey("request_id") && !body.containsKey("requestId")) {
                body["requestId"] = body["request_id"]!!
            }
            if (body.containsKey("error_details") && !body.containsKey("details")) {
                body["details"] = body["error_details"]!!
            }
            body.remove("request_id")
            body.remove("error_details")
            if (!body.containsKey("timestamp")) {
                body["timestamp"] = System.currentTimeMillis()
            }
            Bridge.sendVideoRecordingStatus(body)
        } catch (e: JSONException) {
            Log.e(TAG, "Error converting video_recording_status to Map", e)
        }
    }

    @Throws(JSONException::class)
    private fun jsonObjectToMap(json: JSONObject): MutableMap<String, Any> {
        val map = HashMap<String, Any>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = json.get(key)
            if (value === JSONObject.NULL) {
                continue
            }
            map[key] = jsonValueToBridgeValue(value)
        }
        return map
    }

    @Throws(JSONException::class)
    private fun jsonValueToBridgeValue(value: Any): Any {
        if (value is JSONObject) {
            return jsonObjectToMap(value)
        }
        if (value is JSONArray) {
            val array = value
            val list = ArrayList<Any>()
            for (i in 0 until array.length()) {
                val item = array.get(i)
                if (item !== JSONObject.NULL) {
                    list.add(jsonValueToBridgeValue(item))
                }
            }
            return list
        }
        return value
    }

    private fun processChunkedJsonMessage(json: JSONObject) {
        try {
            val chunkInfo = MessageChunker.getChunkInfo(json)
            if (chunkInfo == null) {
                Log.w(TAG, "LIVE: Received malformed chunked message: " + json)
                return
            }
            if (chunkInfo.chunkId == null ||
                            chunkInfo.chunkId.isEmpty() ||
                            chunkInfo.totalChunks <= 0 ||
                            chunkInfo.chunkIndex < 0 ||
                            chunkInfo.chunkIndex >= chunkInfo.totalChunks ||
                            chunkInfo.data == null
            ) {
                Log.w(TAG, "LIVE: Received invalid chunk metadata: " + json)
                return
            }

            val reassembled =
                    incomingChunkReassembler.addChunk(
                            chunkInfo.chunkId,
                            chunkInfo.chunkIndex,
                            chunkInfo.totalChunks,
                            chunkInfo.data
                    )
            if (reassembled == null) {
                return
            }

            val reassembledJson = JSONObject(reassembled)
            processJsonMessage(reassembledJson)
        } catch (e: Exception) {
            Log.e(TAG, "Error processing chunked JSON message", e)
        }
    }
    /** Process K900 command format JSON messages (messages with "C" field) */
    /** Process BLE photo ready notification from glasses */
    private fun processBlePhotoReady(json: JSONObject) {
        try {
            val bleImgId = json.optString("bleImgId", "")
            val requestId = json.optString("requestId", "")
            val compressionDurationMs = json.optLong("compressionDurationMs", 0)

            Bridge.log(
                    "LIVE: 📸 BLE photo ready notification: bleImgId=" +
                            bleImgId +
                            ", requestId=" +
                            requestId
            )

            // Update the transfer with glasses compression duration
            val transfer = blePhotoTransfers[bleImgId]
            if (transfer != null) {
                transfer.glassesCompressionDurationMs = compressionDurationMs
                transfer.bleTransferStartTime =
                        System.currentTimeMillis() // BLE transfer starts now
                Bridge.log("LIVE: ⏱️ Glasses compression took: " + compressionDurationMs + "ms")
            } else {
                Log.w(TAG, "Received ble_photo_ready for unknown transfer: " + bleImgId)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error processing ble_photo_ready", e)
        }
    }

    /** Handle transfer timeout notification from glasses */
    private fun handleTransferTimeout(json: JSONObject) {
        try {
            val fileName = json.optString("fileName", "")

            Log.e(TAG, "⏰ Transfer timeout notification received for: " + fileName)

            if (!fileName.isEmpty()) {
                // Clean up any active transfer for this file
                val session = activeFileTransfers.remove(fileName)
                if (session != null) {
                    Bridge.log("LIVE: 🧹 Cleaned up timed out transfer session for: " + fileName)
                    Bridge.log(
                            "LIVE: 📊 Transfer stats - Received: " +
                                    session.receivedPackets.size +
                                    "/" +
                                    session.totalPackets +
                                    " packets"
                    )
                }

                // Clean up any BLE photo transfer
                var bleImgId = fileName
                val dotIndex = bleImgId.lastIndexOf('.')
                if (dotIndex > 0) {
                    bleImgId = bleImgId.substring(0, dotIndex)
                }
                val photoTransfer = blePhotoTransfers.remove(bleImgId)
                if (photoTransfer != null) {
                    Bridge.log("LIVE: 🧹 Cleaned up timed out BLE photo transfer for: " + bleImgId)
                    Bridge.sendPhotoError(
                            photoTransfer.requestId,
                            "TRANSFER_TIMEOUT",
                            "Transfer timed out for: " + fileName
                    )
                }

                // Reset stale session on incident log relay so a retry starts fresh.
                // Keep the relay entry itself — glasses will retry after receiving
                // transfer_complete:false.
                val incidentRelay = bleIncidentLogRelays[bleImgId]
                if (incidentRelay != null) {
                    incidentRelay.session = null
                    Bridge.log(
                            "LIVE: 🧹 Reset timed out BLE incident log relay session for: " +
                                    bleImgId
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "⏰ Error processing transfer timeout notification", e)
        }
    }

    /**
     * Handle transfer failed notification from glasses Matches iOS MentraLive.swift
     * handleTransferFailed pattern
     */
    private fun handleTransferFailed(json: JSONObject) {
        try {
            val fileName = json.optString("fileName", "")
            val reason = json.optString("reason", "unknown")
            val requestId = json.optString("requestId", "")

            if (fileName.isEmpty()) {
                Log.e(TAG, "❌ Transfer failed notification missing fileName: " + json.toString())
                Bridge.sendPhotoError(
                        requestId,
                        "FILE_NAME_MISSING",
                        "Transfer failed notification missing fileName"
                )
                return
            }

            var bleImgId = fileName
            val dotIndex = bleImgId.lastIndexOf('.')
            if (dotIndex > 0) {
                bleImgId = bleImgId.substring(0, dotIndex)
            }
            var photoTransfer = blePhotoTransfers[bleImgId]
            var effectiveRequestId = requestId
            if (effectiveRequestId.isEmpty() && photoTransfer != null) {
                effectiveRequestId = photoTransfer.requestId
            }

            Log.e(TAG, "❌ Transfer failed for: " + fileName + " (reason: " + reason + ")")
            Bridge.sendPhotoError(
                    effectiveRequestId,
                    "TRANSFER_FAILED",
                    "Transfer failed for: " + fileName + " (reason: " + reason + ")"
            )

            // Clean up any active transfer for this file
            val session = activeFileTransfers.remove(fileName)
            if (session != null) {
                Bridge.log(
                        "LIVE: 📊 Transfer stats - Received: " +
                                session.receivedPackets.size +
                                "/" +
                                session.totalPackets +
                                " packets"
                )
            }

            // Clean up any BLE photo transfer
            photoTransfer = blePhotoTransfers.remove(bleImgId)
            if (photoTransfer != null) {
                Bridge.log(
                        "LIVE: 🧹 Cleaned up failed BLE photo transfer for: " +
                                bleImgId +
                                " (requestId: " +
                                photoTransfer.requestId +
                                ")"
                )
            }

            if (bleIncidentLogRelays.remove(bleImgId) != null) {
                Bridge.log("LIVE: 🧹 Cleaned up failed BLE incident log relay for: " + bleImgId)
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error processing transfer failed notification", e)
        }
    }

    /** Handle file transfer announcement from glasses */
    private fun handleFileTransferAnnouncement(json: JSONObject) {
        try {
            // Extract data directly from JSON (same format as version_info)
            val fileName = json.optString("fileName", "")
            val totalPackets = json.optInt("totalPackets", 0)
            val fileSize = json.optInt("fileSize", 0)

            Bridge.log(
                    "LIVE: 📢 File transfer announcement: " +
                            fileName +
                            ", " +
                            totalPackets +
                            " packets, " +
                            fileSize +
                            " bytes"
            )

            if (fileName.isEmpty() || totalPackets <= 0) {
                Log.w(TAG, "📢 Invalid file transfer announcement")
                return
            }

            // Create announced file transfer session
            val session = FileTransferSession(fileName, fileSize)
            // Override calculated packet count with announced count for accuracy
            session.totalPackets = totalPackets
            activeFileTransfers[fileName] = session

            Bridge.log("LIVE: 📢 Prepared to receive " + totalPackets + " packets for " + fileName)
        } catch (e: Exception) {
            Log.e(TAG, "📢 Error processing file transfer announcement", e)
        }
    }

    private fun processK900JsonMessage(json: JSONObject) {
        val command = json.optString("C", "")
        // Bridge.log("LIVE: Processing K900 command: " + command);

        when (command) {
            "sr_hrt" -> {
                try {
                    val bodyObj = json.optJSONObject("B")
                    if (bodyObj != null) {

                        val batteryPercentage = bodyObj.optInt("pt", -1)
                        val ready = bodyObj.optInt("ready", 0)
                        if (ready == 0) {
                            Bridge.log("LIVE: K900 SOC not ready (ready=0)")
                            DeviceStore.apply("glasses", "fullyBooted", false)
                            Bridge.sendTypedMessage("glasses_not_ready", HashMap<String, Any>())
                            if (batteryPercentage > 0 && batteryPercentage <= 20) {
                                Bridge.log("LIVE: K900 battery percentage: " + batteryPercentage)
                                Bridge.sendPairFailureEvent("errors:pairingBatteryTooLow")
                                return
                            }
                            return
                        }
                        if (ready == 1) {
                            Bridge.log("LIVE: K900 SOC ready")
                            // Only send phone_ready if we haven't already established connection
                            // This prevents re-initialization on every heartbeat after initial
                            // connection
                            // The glassesReady flag is reset on disconnect/reconnect, so this won't
                            // prevent proper reconnection
                            if (!glassesReady) {
                                sendPhoneReady("SOC ready")
                            } else {
                                Bridge.log(
                                        "LIVE: ✅ Glasses already marked as ready, skipping phone_ready"
                                )
                            }
                        }
                        val charg = bodyObj.optInt("charg", -1)
                        if (batteryPercentage != -1 && charg != -1)
                                updateBatteryStatus(batteryPercentage, charg == 1)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_hrt response", e)
                }
            }
            "sr_batv" -> {
                // K900 battery voltage response
                try {
                    val bodyObj = json.optJSONObject("B")
                    if (bodyObj != null) {
                        val voltageMillivolts = bodyObj.optInt("vt", 0)
                        val batteryPercentage = bodyObj.optInt("pt", 0)

                        // Convert to volts for logging
                        val voltageVolts = voltageMillivolts / 1000.0

                        Bridge.log(
                                "LIVE: 🔋 K900 Battery Status - Voltage: " +
                                        voltageVolts +
                                        "V (" +
                                        voltageMillivolts +
                                        "mV), Level: " +
                                        batteryPercentage +
                                        "%"
                        )

                        // Percent only. sr_batv carries just voltage+percent; inferring
                        // charging from voltage (>4.0V) reads "not charging" for most of a
                        // genuinely-charging pack's range. Charging state comes exclusively
                        // from the PMU charg bit in the sr_hrt heartbeat.
                        updateBatteryStatus(batteryPercentage, isCharging)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_batv response", e)
                }
            }
            "sr_getvol" -> handleSrGetvol(json)
            "sr_vol" -> handleSrVol(json)
            "sr_vad" -> {
                try {
                    val bodyObj = optK900Body(json)
                    if (bodyObj != null) {
                        val on = bodyObj.optInt("on", -1)
                        if (on == 0 || on == 1) {
                            handleSpeakingStatus(on == 1)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_vad response", e)
                }
            }
            "sr_swit" -> {
                try {
                    val bodyObj = optK900Body(json)
                    if (bodyObj != null) {
                        val type = bodyObj.optInt("type", -1)
                        val value = bodyObj.optInt("switch", -1)
                        handleSwitchStatus(type, value, System.currentTimeMillis())
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_swit response", e)
                }
            }
            "sr_shut" -> {
                Bridge.log("LIVE: K900 shutdown command received - glasses shutting down")
                lastShutdownTimeMs = System.currentTimeMillis()
                reconnectAttempts = 0 // Fresh reconnection budget after power cycle
                // Notify the system that glasses are intentionally disconnected
                updateConnectionState(ConnTypes.DISCONNECTED)
                glassesReady = false
                glassesReadyReceived = false
                glassesSessionId = null
                readinessCompletedThisBleSession = false
            }
            "sr_adota" -> {
                // BES chip OTA progress — K900 path (serial busy during BES flash). Emit ota_status
                // only.
                try {
                    val bodyObj = json.optJSONObject("B")
                    if (bodyObj != null) {
                        val type = bodyObj.optString("type", "")
                        val rawProgress = bodyObj.optInt("progress", 0)

                        // Round to nearest 5% for cleaner UI updates
                        var progress = ((rawProgress + 2) / 5) * 5
                        if (progress > 100) progress = 100

                        val mapping =
                            mapBesOtaProgress(
                                type,
                                rawProgress,
                                bodyObj.optString("message", "BES update failed"),
                            )
                        val besOtaStatus = mapping.status
                        val besOtaProgressVal = mapping.progress
                        val besOtaErrorMessage = mapping.errorMessage

                        if ("FINISHED" == besOtaStatus || "FAILED" == besOtaStatus) {
                            besOtaHeartbeatGuard.clear()
                        } else {
                            // Refresh before progress de-duplication: raw progress proves the BES
                            // transfer is active even when the rounded UI value is unchanged.
                            besOtaHeartbeatGuard.refresh(SystemClock.elapsedRealtime())
                        }

                        // Only send if nonterminal display progress changed to a new 5% increment.
                        if ("PROGRESS" == besOtaStatus && besOtaProgressVal == lastBesOtaProgress) {
                            return
                        }

                        Bridge.log(
                                "LIVE: 📱 BES OTA progress via sr_adota - type: " +
                                        type +
                                        ", raw: " +
                                        rawProgress +
                                        "%, rounded: " +
                                        progress +
                                        "%, display: " +
                                        besOtaProgressVal +
                                        "%"
                        )

                        if ("FINISHED" == besOtaStatus || "FAILED" == besOtaStatus) {
                            lastBesOtaProgress = -1 // Reset for next OTA
                        } else {
                            lastBesOtaProgress = besOtaProgressVal
                        }

                        val syntheticStatus = when (besOtaStatus) {
                            "FINISHED" -> "step_complete"
                            "FAILED" -> "failed"
                            else -> "in_progress"
                        }
                        val sid = if (cachedOtaSessionId != null) cachedOtaSessionId!! else ""
                        val totalSteps = if (cachedOtaTotalSteps > 0) cachedOtaTotalSteps else 1
                        val currentStep = if (cachedOtaCurrentStep > 0) cachedOtaCurrentStep else 1
                        val besOverallPercent =
                                computeBesOverallPercent(
                                        besOtaProgressVal,
                                        totalSteps,
                                        cachedOtaStepSequence
                                )
                        Bridge.sendOtaStatus(
                                sid,
                                totalSteps,
                                currentStep,
                                "bes",
                                "install",
                                besOtaProgressVal,
                                besOverallPercent,
                                syntheticStatus,
                                besOtaErrorMessage
                        )
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing sr_adota BES OTA progress", e)
                }
            }
            "sr_tpevt" -> {
                // K900 touchpad event - convert to touch_event for frontend
                try {
                    val bodyObj = json.optJSONObject("B")
                    if (bodyObj != null) {
                        val gestureType = bodyObj.optInt("type", -1)
                        val gestureName = mapK900GestureType(gestureType)

                        if (gestureName != null) {
                            Bridge.log(
                                    "LIVE: 👆 K900 touchpad event - Type: " +
                                            gestureType +
                                            " -> " +
                                            gestureName
                            )
                            Bridge.sendTouchEvent(
                                    deviceModel,
                                    gestureName,
                                    System.currentTimeMillis()
                            )
                        } else {
                            Log.d(TAG, "Unknown K900 gesture type: " + gestureType)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing sr_tpevt", e)
                }
            }
            else -> {
                Log.d(TAG, "Unknown K900 command: " + command)

                // Check if this is a C-wrapped standard JSON message (not a true K900 command)
                // This happens when ASG Client sends standard JSON messages through
                // K900BluetoothManager
                // which automatically C-wraps them
                try {
                    // Try to parse the "C" field as JSON
                    val innerJson = JSONObject(command)

                    // If it has a "type" field or chunk envelope, it's a standard message that got
                    // C-wrapped
                    if (innerJson.has("type") || MessageChunker.isChunkedMessage(innerJson)) {
                        val messageType = innerJson.optString("type", "")
                        Log.d(
                                TAG,
                                "📦 Detected C-wrapped standard JSON message with type: " +
                                        messageType
                        )
                        Log.d(TAG, "🔓 Unwrapping and processing through standard message handler")

                        // Process through the standard message handler
                        processJsonMessage(innerJson)
                        return // Exit after processing
                    }
                } catch (e: JSONException) {
                    // Not valid JSON or doesn't have type field - treat as unknown K900 command
                    Log.d(
                            TAG,
                            "Command is not a C-wrapped JSON message, passing to data observable"
                    )
                }

                // Pass to data observable for custom processing
                // if (dataObservable != null) {
                // dataObservable.onNext(json);
                // }
            }
        }
    }

    /**
     * Map K900 sr_tpevt gesture type codes to gesture names. These match the gesture_name values
     * sent by ASG Client in touch_event messages.
     */
    private fun mapK900GestureType(type: Int): String? {
        when (type) {
            0 -> return "single_tap"
            1 -> return "double_tap"
            2 -> return "triple_tap"
            3 -> return "long_press"
            4 -> return "forward_swipe"
            5 -> return "backward_swipe"
            6 -> return "up_swipe"
            7 -> return "down_swipe"
            else -> return null
        }
    }

    /**
     * Send the coreToken to the ASG client for direct backend authentication. Retries a few times
     * with delay if token is empty (bridge may not have applied BluetoothSdkModule.update yet when
     * glasses_ready runs).
     */
    private fun sendCoreTokenToAsgClient() {
        Bridge.log("LIVE: Preparing to send coreToken to ASG client")

        val coreToken = getCoreToken()

        if (coreToken == null || coreToken.isEmpty()) {
            if (coreTokenRetryCount < CORE_TOKEN_MAX_RETRIES - 1) {
                coreTokenRetryCount++
                Log.d(
                        TAG,
                        "getCoreToken empty, retrying in " +
                                CORE_TOKEN_RETRY_DELAY_MS +
                                "ms (attempt " +
                                (coreTokenRetryCount + 1) +
                                "/" +
                                CORE_TOKEN_MAX_RETRIES +
                                ")"
                )
                handler.postDelayed(this::sendCoreTokenToAsgClient, CORE_TOKEN_RETRY_DELAY_MS)
                return
            }
            Log.e(
                    TAG,
                    "No coreToken available to send to ASG client after " +
                            CORE_TOKEN_MAX_RETRIES +
                            " attempts"
            )
            coreTokenRetryCount = 0
            return
        }

        coreTokenRetryCount = 0
        try {
            val tokenMsg = JSONObject()
            tokenMsg.put("type", "auth_token")
            tokenMsg.put("coreToken", coreToken)
            tokenMsg.put("timestamp", System.currentTimeMillis())

            Bridge.log("LIVE: Sending coreToken to ASG client")
            sendJson(tokenMsg)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating coreToken JSON message", e)
        }
    }

    /** Send stored user email to the ASG client for Sentry crash reporting */
    private fun sendStoredUserEmailToAsgClient() {
        val emailObj = DeviceStore.get("bluetooth", "auth_email")
        val storedEmail = if (emailObj is String) emailObj else ""

        if (storedEmail == null || storedEmail.isEmpty()) {
            Bridge.log("LIVE: No stored user email to send to ASG client")
            return
        }

        Bridge.log("LIVE: Sending stored user email to ASG client")
        sendUserEmailToGlasses(storedEmail)
    }

    /** Request battery status from the glasses */
    private fun requestBatteryStatus() {
        // JSONObject json = new JSONObject();
        // json.put("type", "request_battery_state");
        // sendDataToGlasses(json.toString());

        requestBatteryK900()
    }

    /**
     * Update battery status and notify listeners Matches iOS MentraLive.swift updateBatteryStatus
     * pattern
     */
    private fun updateBatteryStatus(level: Int, isCharging: Boolean) {
        // Keep the field in sync: percent-only messages (battery_status/sr_batv) re-pass
        // it as the last-known charging state, so a stale field would clobber the value
        // the sr_hrt PMU charg bit established.
        this.isCharging = isCharging

        // Update parent SGCManager fields
        DeviceStore.apply("glasses", "batteryLevel", level)
        DeviceStore.apply("glasses", "charging", isCharging)

        if (level >= 0) {
            Bridge.sendBatteryStatus(level, isCharging)
        }
    }

    private fun handleVoiceActivityDetectionStatus(enabled: Boolean) {
        Bridge.log("LIVE: Voice Activity Detection " + (if (enabled) "enabled" else "disabled"))
        Bridge.sendVoiceActivityDetectionStatus(enabled)
    }

    private fun handleSpeakingStatus(speaking: Boolean) {
        if (!isVoiceActivityDetectionEnabled()) {
            Bridge.log(
                    "LIVE: Ignoring speaking status because Voice Activity Detection is disabled"
            )
            return
        }
        Bridge.log("LIVE: Speaking status " + (if (speaking) "speaking" else "not speaking"))
        Bridge.sendSpeakingStatus(speaking)
    }

    private fun isVoiceActivityDetectionEnabled(): Boolean {
        val value = DeviceStore.get("bluetooth", "voice_activity_detection_enabled")
        return !(value is Boolean) || value
    }

    private fun handleSwitchStatus(switchType: Int, switchValue: Int, timestamp: Long) {
        Bridge.sendSwitchStatus(switchType, switchValue, timestamp)
        if (switchType == VOICE_ACTIVITY_DETECTION_SWITCH_TYPE &&
                        (switchValue == 0 || switchValue == 1)
        ) {
            handleVoiceActivityDetectionStatus(switchValue == 1)
        }
    }

    /**
     * Update WiFi status and notify listeners Matches iOS MentraLive.swift updateWifiStatus pattern
     */
    private fun updateWifiStatus(
            connected: Boolean,
            ssid: String,
            localIp: String,
            error: String? = null
    ) {
        Bridge.log("LIVE: 🌐 Updating WiFi status - connected: " + connected + ", SSID: " + ssid)

        // Update parent SGCManager fields
        DeviceStore.apply("glasses", "wifiConnected", connected)
        DeviceStore.apply("glasses", "wifiSsid", ssid)
        DeviceStore.apply("glasses", "wifiLocalIp", localIp)

        // Send event to bridge for cloud communication
        Bridge.sendWifiStatusChange(connected, ssid, localIp, error)
    }

    /**
     * Update hotspot status and notify listeners Matches iOS MentraLive.swift updateHotspotStatus
     * pattern
     */
    private fun updateHotspotStatus(
            enabled: Boolean,
            ssid: String,
            password: String,
            gatewayIp: String
    ) {
        Bridge.log("LIVE: 🔥 Updating hotspot status - enabled: " + enabled + ", SSID: " + ssid)

        // Update parent SGCManager fields
        DeviceStore.apply("glasses", "hotspotEnabled", enabled)
        DeviceStore.apply("glasses", "hotspotSsid", ssid)
        DeviceStore.apply("glasses", "hotspotPassword", password)
        DeviceStore.apply("glasses", "hotspotGatewayIp", gatewayIp)

        // Send hotspot status change event (matches iOS emitHotspotStatusChange)
        Bridge.sendHotspotStatusChange(enabled, ssid, password, gatewayIp)
    }

    /** Handle hotspot error and notify React Native */
    private fun handleHotspotError(errorMessage: String, timestamp: Long) {
        Bridge.log("LIVE: 🔥 ❌ Hotspot error: " + errorMessage)

        // Send hotspot error event to React Native
        Bridge.sendHotspotError(errorMessage, timestamp)
    }

    /** Send battery status to connected phone via BLE */
    private fun sendBatteryStatusOverBle(level: Int, charging: Boolean) {
        if (isConnected && bluetoothGatt != null) {
            try {
                val batteryStatus = JSONObject()
                batteryStatus.put("type", "battery_status")
                batteryStatus.put("level", level)
                batteryStatus.put("charging", charging)
                batteryStatus.put("timestamp", System.currentTimeMillis())

                // Convert to string and send via BLE
                val jsonString = batteryStatus.toString()
                Bridge.log(
                        "LIVE: 🔋 Sending battery status via BLE: " +
                                level +
                                "% " +
                                (if (charging) "(charging)" else "(not charging)")
                )
                sendDataToGlasses(jsonString, false)
            } catch (e: JSONException) {
                Log.e(TAG, "Error creating battery status JSON", e)
            }
        } else {
            Bridge.log("LIVE: Cannot send battery status - not connected to BLE device")
        }
    }

    /** Request WiFi status from the glasses */
    private fun requestWifiStatus() {
        try {
            val json = JSONObject()
            json.put("type", "request_wifi_status")
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating WiFi status request", e)
        }
    }

    /**
     * Request WiFi scan from the glasses This will ask the glasses to scan for available networks
     */
    override fun requestWifiScan(scanId: String?) {
        try {
            val json = JSONObject()
            json.put("type", "request_wifi_scan")
            if (!scanId.isNullOrEmpty()) {
                json.put("scanId", scanId)
            }
            sendJson(json, true)
            Bridge.log("LIVE: Sending WiFi scan request to glasses")
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating WiFi scan request", e)
        }
    }

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {
        try {
            var base = if (apiBaseUrl != null) apiBaseUrl.trim() else ""
            if (base.isEmpty()) {
                base = "https://api.mentra.glass"
            }
            val bKey = IncidentLogBleRelayNaming.bleFileBaseName(incidentId, 'B')
            val lKey = IncidentLogBleRelayNaming.bleFileBaseName(incidentId, 'L')
            bleIncidentLogRelays[bKey] =
                    BleIncidentLogRelay(bKey, incidentId, base, BleIncidentLogKind.FIRMWARE)
            bleIncidentLogRelays[lKey] =
                    BleIncidentLogRelay(lKey, incidentId, base, BleIncidentLogKind.LOGCAT)

            val json = JSONObject()
            json.put("type", "upload_incident_logs")
            json.put("incidentId", incidentId)
            json.put("apiBaseUrl", base)
            sendJson(json, true)
            Bridge.log(
                    "LIVE: Sent incidentId to glasses for log upload: " +
                            incidentId +
                            " (BLE relay keys " +
                            bKey +
                            ", " +
                            lKey +
                            ")"
            )
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating upload_incident_logs command", e)
        }
    }

    /** Query gallery status from the glasses */
    override fun queryGalleryStatus() {
        try {
            val json = JSONObject()
            json.put("type", "query_gallery_status")
            sendJson(json, true)
            Bridge.log("LIVE: 📸 Sending gallery status query to glasses")
        } catch (e: JSONException) {
            Log.e(TAG, "📸 Error creating gallery status query", e)
        }
    }

    /**
     * Send OTA start command to glasses. Called when user approves an update (onboarding or
     * background mode). Triggers glasses to begin download and installation.
     *
     * When [otaVersionUrl] is non-null it is sent as the `ota_version_url` field so the glasses
     * download from that manifest; asg_client's OtaCommandHandler reads and validates that field
     * (it must be an http(s) URL). A null url omits the field, leaving the glasses to fall back to
     * their default version manifest.
     */
    fun sendOtaStart(otaVersionUrl: String? = null, otaTransport: String? = null) {
        try {
            val json = JSONObject()
            json.put("type", "ota_start")
            if (otaVersionUrl != null) {
                json.put("ota_version_url", otaVersionUrl)
            }
            if (!otaTransport.isNullOrBlank()) {
                json.put("ota_transport", otaTransport)
            }
            json.put("timestamp", System.currentTimeMillis())
            sendJson(json, true)
            Bridge.log("LIVE: 📱 Sending ota_start command to glasses")
        } catch (e: JSONException) {
            Log.e(TAG, "📱 Error creating ota_start command", e)
        }
    }

    fun sendOtaQueryStatus() {
        try {
            val json = JSONObject()
            json.put("type", "ota_query_status")
            json.put("timestamp", System.currentTimeMillis())
            sendJson(json, true)
            Bridge.log("LIVE: 📱 Sending ota_query_status command to glasses")
        } catch (e: JSONException) {
            Log.e(TAG, "📱 Error creating ota_query_status command", e)
        }
    }

    /**
     * Request version info from glasses. Glasses will respond with version_info message containing
     * build number, firmware version, etc.
     */
    override fun requestVersionInfo() {
        try {
            val json = JSONObject()
            json.put("type", "request_version")
            sendJson(json, false)
            Bridge.log("LIVE: 📱 Requesting version info from glasses")
        } catch (e: JSONException) {
            Log.e(TAG, "📱 Error creating request_version command", e)
        }
    }

    override fun sendGalleryMode() {
        val active = DeviceStore.get("bluetooth", "gallery_mode") as Boolean
        sendGalleryMode(null, active)
    }

    fun sendGalleryMode(requestId: String?, active: Boolean) {
        Bridge.log("LIVE: 📸 Sending gallery mode active to glasses: " + active)
        try {
            val json = JSONObject()
            json.put("type", "save_in_gallery_mode")
            if (requestId != null && !requestId.isEmpty()) {
                json.put("request_id", requestId)
            }
            json.put("active", active)
            json.put("timestamp", System.currentTimeMillis())
            sendJson(json, true)
            Bridge.log("LIVE: 📸 ✅ Gallery mode command sent successfully")
        } catch (e: JSONException) {
            Log.e(TAG, "📸 💥 Error creating gallery mode JSON", e)
        }
    }

    /** Send heartbeat ping to glasses and handle periodic battery requests */
    private fun sendHeartbeat() {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            Bridge.log("LIVE: Skipping heartbeat - glasses not ready or not connected")
            return
        }
        if (besOtaHeartbeatGuard.shouldSuppress(SystemClock.elapsedRealtime())) {
            Bridge.log("LIVE: Skipping heartbeat while BES OTA owns the UART")
            return
        }

        try {
            // Send ping message (no ACK needed for heartbeats)
            val pingMsg = JSONObject()
            pingMsg.put("type", "ping")
            sendJsonWithoutAck(pingMsg)

            // Send custom audio TX command
            // sendEnableCustomAudioTxMessage(shouldUseGlassesMic);

            // Increment heartbeat counter
            heartbeatCounter++
            Bridge.log("LIVE: 💓 Heartbeat #" + heartbeatCounter + " sent")

            // Request battery status every N heartbeats
            if (heartbeatCounter % BATTERY_REQUEST_EVERY_N_HEARTBEATS == 0) {
                Bridge.log(
                        "LIVE: 🔋 Requesting battery status (heartbeat #" + heartbeatCounter + ")"
                )
                requestBatteryStatus()
            }
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating heartbeat message", e)
        }
    }

    /** Start the heartbeat mechanism */
    private fun startHeartbeat() {
        // Bridge.log("LIVE: 💓 Starting heartbeat mechanism");
        heartbeatCounter = 0
        heartbeatHandler.removeCallbacks(heartbeatRunnable!!) // Remove any existing callbacks
        heartbeatHandler.postDelayed(heartbeatRunnable!!, HEARTBEAT_INTERVAL_MS.toLong())

        // Also start test messages for ACK verification
        // startTestMessages();
    }

    /** Stop the heartbeat mechanism */
    private fun stopHeartbeat() {
        Bridge.log("LIVE: 💓 Stopping heartbeat mechanism")
        heartbeatHandler.removeCallbacks(heartbeatRunnable!!)
        heartbeatCounter = 0

        // Also stop test messages
        // stopTestMessages();
    }

    private fun startSignalStrengthPolling() {
        Bridge.log("LIVE: 📶 Starting RSSI polling")
        rssiReadHandler.removeCallbacks(rssiReadRunnable!!)
        requestSignalStrength()
        rssiReadHandler.postDelayed(rssiReadRunnable!!, RSSI_READ_INTERVAL_MS)
    }

    private fun stopSignalStrengthPolling() {
        Bridge.log("LIVE: 📶 Stopping RSSI polling")
        rssiReadHandler.removeCallbacks(rssiReadRunnable!!)
        rssiReadInProgress = false
    }

    private fun requestSignalStrength() {
        if (!isConnected || bluetoothGatt == null) {
            return
        }

        if (!hasPermissions()) {
            Bridge.log("LIVE: 📶 Cannot read RSSI - missing Bluetooth permission")
            return
        }

        if (rssiReadInProgress) {
            Bridge.log("LIVE: 📶 Skipping RSSI read - previous read still pending")
            return
        }

        val started = bluetoothGatt!!.readRemoteRssi()
        rssiReadInProgress = started
        if (!started) {
            Bridge.log("LIVE: 📶 RSSI read did not start")
        }
    }

    private fun updateSignalStrength(rssi: Int) {
        val now = System.currentTimeMillis()
        DeviceStore.apply("glasses", "signalStrength", rssi)
        DeviceStore.apply("glasses", "signalStrengthUpdatedAt", now)
        Bridge.log("LIVE: 📶 RSSI: " + rssi + " dBm")
    }

    /** Start the micbeat mechanism - periodically enable custom audio TX */
    private fun startMicBeat() {
        micOnCount++
        Bridge.log("LIVE: 🎤 Mic ON/OFF count: " + micOnCount + " on, " + micOffCount + " off")
        micBeatCount = 0

        // Initialize custom audio TX immediately
        sendEnableCustomAudioTxMessage(shouldUseGlassesMic)

        micBeatRunnable =
                object : Runnable {
                    override fun run() {
                        Bridge.log("LIVE: 🎤 Sending micbeat - enabling custom audio TX")

                        sendEnableCustomAudioTxMessage(true)
                        micBeatCount++

                        // Schedule next micbeat
                        micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS)
                    }
                }

        micBeatHandler.removeCallbacks(micBeatRunnable!!) // Remove any existing callbacks
        micBeatHandler.postDelayed(micBeatRunnable!!, MICBEAT_INTERVAL_MS)
    }

    /** Stop the micbeat mechanism */
    private fun stopMicBeat() {
        micOffCount++
        Bridge.log("LIVE: 🎤 Mic ON/OFF count: " + micOnCount + " on, " + micOffCount + " off")
        sendEnableCustomAudioTxMessage(false)
        if (micBeatRunnable != null) {
            micBeatHandler.removeCallbacks(micBeatRunnable!!)
        }
        micBeatCount = 0
    }

    /** Send a periodic test message to verify ACK system */
    private fun sendTestMessage() {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            Bridge.log("LIVE: Skipping test message - glasses not ready or not connected")
            return
        }

        try {
            testMessageCounter++
            val testMsg = JSONObject()
            testMsg.put("type", "test_message")
            testMsg.put("counter", testMessageCounter)
            testMsg.put("timestamp", System.currentTimeMillis())
            testMsg.put("message", "ACK test message #" + testMessageCounter)
            testMsg.put("deviceId", deviceId) // Include device ID for debugging

            Bridge.log(
                    "LIVE: 🧪 Sending test message #" + testMessageCounter + " for ACK verification"
            )
            sendJson(testMsg, true) // This will include esoteric mId and ACK tracking
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating test message", e)
        }
    }

    /** Start the periodic test message system */
    private fun startTestMessages() {
        Bridge.log(
                "LIVE: 🧪 Starting periodic test message system (every " +
                        TEST_MESSAGE_INTERVAL_MS +
                        "ms)"
        )
        testMessageCounter = 0
        if (testMessageRunnable != null) {
            testMessageHandler.removeCallbacks(
                    testMessageRunnable!!
            ) // Remove any existing callbacks
            testMessageHandler.postDelayed(testMessageRunnable!!, TEST_MESSAGE_INTERVAL_MS.toLong())
        }
    }

    /** Stop the periodic test message system */
    private fun stopTestMessages() {
        Bridge.log("LIVE: 🧪 Stopping periodic test message system")
        if (testMessageRunnable != null) {
            testMessageHandler.removeCallbacks(testMessageRunnable!!)
        }
        testMessageCounter = 0
    }

    /** Dump all thread states for debugging BLE failures */
    private fun dumpThreadStates() {
        Log.e(TAG, "📸 THREAD STATE DUMP - START")
        try {
            val allThreads = Thread.getAllStackTraces()
            for ((thread, stack) in allThreads) {
                Log.e(
                        TAG,
                        "📌 Thread: " +
                                thread.name +
                                " (ID: " +
                                thread.id +
                                ", State: " +
                                thread.state +
                                ", Priority: " +
                                thread.priority +
                                ")"
                )

                // Only print first 5 stack frames to avoid log spam
                for (i in 0 until Math.min(5, stack.size)) {
                    Log.e(TAG, "    at " + stack[i].toString())
                }
                if (stack.size > 5) {
                    Log.e(TAG, "    ... " + (stack.size - 5) + " more frames")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error dumping thread states", e)
        }
        Log.e(TAG, "📸 THREAD STATE DUMP - END")
    }

    /** Check if we have the necessary permissions */
    private fun hasPermissions(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(
                    context!!,
                    Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            return ActivityCompat.checkSelfPermission(context!!, Manifest.permission.BLUETOOTH) ==
                    PackageManager.PERMISSION_GRANTED
        }
    }

    // Helper method for permission checking when needed in different contexts
    private fun checkPermission(): Boolean {
        return hasPermissions()
    }

    // SmartGlassesCommunicator interface implementation

    override fun findCompatibleDevices() {
        Bridge.log("LIVE: Finding compatible Mentra Live glasses")

        // Clear reconnection mode when user manually scans
        isReconnecting = false

        if (bluetoothAdapter == null) {
            Log.e(TAG, "Bluetooth not available")
            return
        }

        if (!bluetoothAdapter!!.isEnabled()) {
            Log.e(TAG, "Bluetooth is not enabled")
            return
        }

        // Start scanning for BLE devices
        startScan()
    }

    override fun connectById(id: String) {
        Bridge.log("LIVE: Connecting to Mentra Live glasses by ID: " + id)
        savedDeviceName = id
        // // Persist immediately so reconnection logic can find it in case this connection fails
        // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // prefs.edit().putString(PREF_DEVICE_NAME, id).apply();
        // Log.i(TAG, "🔌 💾 Saved device name for future reconnection: " +
        // connectedDevice.getName());
        // Bridge.log("LIVE: Saved device name for future reconnection: " +
        // connectedDevice.getName());
        connectToSmartGlasses()
    }

    override fun forget() {
        Bridge.log("LIVE: Forgetting Mentra Live glasses")

        // Clear saved device name to prevent reconnection to this device
        // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // prefs.edit().remove(PREF_DEVICE_NAME).apply();
        // Bridge.log("LIVE: Cleared saved device name");

        // Reset reconnection state
        reconnectAttempts = 0
        isReconnecting = false

        // Remove BT Classic bond - this is the ONLY place where we unbond,
        // ensuring bond is only removed when user explicitly unpairs
        if (connectedDevice != null) {
            Bridge.log("LIVE: CTKD: Removing BT bond on explicit unpair")
            removeBond(connectedDevice!!)
        }

        if (isScanning) {
            stopScan()
            emitStopScanEvent()
        }
        disconnect()
    }

    override fun disconnect() {
        Bridge.log("LIVE: Disconnecting from Mentra Live glasses")
        destroy()
    }

    override fun exit() {
        Bridge.log("LIVE: [STUB]")
    }

    override fun setSilentMode(enabled: Boolean) {}

    override fun getBatteryStatus() {}

    override fun setHeadUpAngle(angle: Int) {}

    override fun setDashboardPosition(height: Int, depth: Int) {}

    override fun showDashboard() {}

    override fun ping() {
        Bridge.log("LIVE: ping()")
        keepAwake()
    }

    override fun dbg1() {}
    override fun dbg2() {}

    override fun displayBitmap(
            base64ImageData: String,
            x: Int?,
            y: Int?,
            width: Int?,
            height: Int?
    ): Boolean {
        return false
    }

    fun connectToSmartGlasses() {
        Bridge.log("LIVE: Connecting to Mentra Live glasses")
        updateConnectionState(ConnTypes.CONNECTING)

        // Clear reconnection mode when user manually initiates connection
        isReconnecting = false

        if (isConnected) {
            Bridge.log("LIVE: #@32 Already connected to Mentra Live glasses")
            updateConnectionState(ConnTypes.CONNECTED)
            return
        }

        if (bluetoothAdapter == null) {
            Bridge.log("LIVE: Bluetooth not available")
            updateConnectionState(ConnTypes.DISCONNECTED)
            return
        }

        if (!bluetoothAdapter!!.isEnabled()) {
            Bridge.log("LIVE: Bluetooth is not enabled")
            updateConnectionState(ConnTypes.DISCONNECTED)
            return
        }

        // Get last known device address
        // var context = Bridge.getContext();
        // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // String lastDeviceAddress = prefs.getString(PREF_DEVICE_NAME, null);
        val lastDeviceAddress = DeviceStore.get("bluetooth", "device_address") as String?

        if (lastDeviceAddress != null && lastDeviceAddress.length > 0) {
            // Connect to last known device if available
            Bridge.log("LIVE: Attempting to connect to last known device: " + lastDeviceAddress)
            try {
                val device = bluetoothAdapter!!.getRemoteDevice(lastDeviceAddress)
                if (device != null) {
                    Bridge.log(
                            "LIVE: Found saved device, connecting directly: " + lastDeviceAddress
                    )
                    connectToDevice(device)
                } else {
                    Bridge.log(
                            "LIVE: ERROR: Could not create device from address: " +
                                    lastDeviceAddress
                    )
                    updateConnectionState(ConnTypes.DISCONNECTED)
                    startScan() // Fallback to scanning
                }
            } catch (e: Exception) {
                Bridge.log("LIVE: ERROR: Error connecting to saved device: " + e.message)
                updateConnectionState(ConnTypes.DISCONNECTED)
                startScan() // Fallback to scanning
            }
        } else {
            // If no last known device, start scanning for devices
            Bridge.log("LIVE: No last known device, starting scan")
            startScan()
        }
    }

    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("LIVE: 🎤 Microphone state change requested: " + enabled)

        // Update the microphone state tracker
        isMicrophoneEnabled = enabled

        DeviceStore.apply("glasses", "micEnabled", enabled)

        // Update the shouldUseGlassesMic flag to reflect the current state
        this.shouldUseGlassesMic = enabled

        // Update the intent state for the suspend/resume state machine
        micIntentEnabled = enabled

        if (enabled) {
            // User wants mic ON
            // Check if we should suspend due to phone audio (only if BLOCK_AUDIO_DUPLEX is enabled)
            if (BLOCK_AUDIO_DUPLEX && phoneAudioMonitor != null && phoneAudioMonitor!!.isPlaying()
            ) {
                // Phone is currently playing audio - don't start mic yet, mark as suspended
                micSuspendedForAudio = true
                Bridge.log(
                        "LIVE: 🎤 Mic requested but phone audio is playing - suspending until audio stops"
                )
            } else {
                // Safe to start mic
                micSuspendedForAudio = false
                Bridge.log("LIVE: 🎤 Microphone enabled, starting audio input handling")
                startMicBeat()
            }
        } else {
            // User wants mic OFF - clear suspended state and stop
            micSuspendedForAudio = false
            Bridge.log("LIVE: 🎤 Microphone disabled, stopping audio input handling")
            stopMicBeat()
        }
    }

    /**
     * Handle phone audio playback state changes Called by PhoneAudioMonitor when phone starts/stops
     * playing audio
     *
     * State machine logic:
     * - When phone starts playing audio: suspend LC3 mic if it was running
     * - When phone stops playing audio: resume LC3 mic if it was suspended
     */
    private fun handlePhoneAudioStateChanged(isPlaying: Boolean) {
        Bridge.log(
                "LIVE: 🎵 Phone audio state changed: " + (if (isPlaying) "PLAYING" else "STOPPED")
        )

        if (isPlaying) {
            // Phone started playing audio - suspend mic if it was running
            if (micIntentEnabled && !micSuspendedForAudio) {
                Bridge.log(
                        "LIVE: 🎤 Phone audio started - suspending LC3 mic to avoid MCU overload"
                )
                stopMicBeat()
                micSuspendedForAudio = true
            }
        } else {
            // Phone stopped playing audio - resume mic if it was suspended
            if (micIntentEnabled && micSuspendedForAudio) {
                Bridge.log("LIVE: 🎤 Phone audio stopped - resuming LC3 mic")
                micSuspendedForAudio = false
                startMicBeat()
            }
        }
    }

    override fun requestPhoto(request: PhotoRequest) {
        val requestId = request.requestId
        val size = request.size.value
        val mode = request.mode.value
        val webhookUrl = request.webhookUrl
        val authToken = request.authToken
        val compress = request.compress.value
        val save = request.save
        val sound = request.sound
        val exposureTimeNs = request.exposureTimeNs
        val iso = request.iso
        val hasAuthToken = authToken != null && !authToken.isEmpty()
        Bridge.log(
                "LIVE: Requesting photo: " +
                        requestId +
                        " with size: " +
                        size +
                        ", mode=" +
                        mode +
                        ", webhookUrl: " +
                        webhookUrl +
                        ", authToken: " +
                        (if (hasAuthToken) "***" else "none") +
                        ", compress=" +
                        compress +
                        ", save=" +
                        save +
                        ", sound=" +
                        sound +
                        ", exposureTimeNs=" +
                        exposureTimeNs +
                        ", iso=" +
                        iso +
                        ", aeDivisor=" +
                        request.aeExposureDivisor +
                        ", isoCap=" +
                        request.isoCap
        )
        Bridge.log(
                "LIVE: PHOTO PIPELINE [5/6] requestPhoto() entry — requestId=" +
                        requestId
        )

        try {
            val json = JSONObject()
            json.put("type", "take_photo")
            json.put("requestId", requestId)
            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                json.put("webhookUrl", webhookUrl)
            }
            if (hasAuthToken) {
                json.put("authToken", authToken)
            }
            if (size != null && !size.isEmpty()) {
                json.put("size", size)
            }
            json.put("mode", mode)
            if (compress != null && !compress.isEmpty()) {
                json.put("compress", compress)
            } else {
                json.put("compress", "none")
            }
            json.put("save", save)
            json.put("sound", sound)
            if (exposureTimeNs != null && exposureTimeNs > 0L) {
                Bridge.log(
                        "LIVE: Using manual exposure time for photo request " +
                                requestId +
                                ": " +
                                exposureTimeNs +
                                " ns"
                )
                json.put("exposureTimeNs", exposureTimeNs)
            }
            if (iso != null && iso > 0) {
                Bridge.log("LIVE: Using manual ISO for photo request " + requestId + ": ISO " + iso)
                json.put("iso", iso)
            }
            PhotoRequest.appendScanFields(json, request)

            // Always generate BLE ID for potential fallback
            val bleImgId = "I" + String.format("%09d", System.currentTimeMillis() % 1000000000)
            json.put("bleImgId", bleImgId)

            // Miniapps may explicitly skip direct Wi-Fi upload and force the
            // phone-relayed BLE path. Auto remains the default.
            json.put("transferMethod", request.transferMethod)

            // Always prepare for potential BLE transfer
            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                // Store the transfer info for BLE route - include authToken
                val transfer = BlePhotoTransfer(bleImgId, requestId, webhookUrl)
                transfer.authToken = authToken // Store authToken for BLE transfer
                blePhotoTransfers[bleImgId] = transfer
            }

            Bridge.log("LIVE: Using " + request.transferMethod + " transfer mode with BLE fallback ID: " + bleImgId)
            Bridge.log(
                    "LIVE: PHOTO PIPELINE [5b/6] JSON ready mode=" +
                            mode +
                            " — " +
                            summarizeOutgoingMessage(json.toString()) +
                            ", wakeup=true"
            )
            Bridge.log("LIVE: PHOTO PIPELINE [6/6] Dispatching take_photo to sendJson()")

            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating photo request JSON", e)
        }
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
        Bridge.log(
                "LIVE: warmUpCamera() entry — requestId=" +
                        requestId +
                        ", size=" +
                        size.value +
                        ", mode=" +
                        mode.value +
                        ", durationMs=" +
                        durationMs
        )

        try {
            val json = JSONObject()
            json.put("type", "camera_warm_up")
            json.put("requestId", requestId)
            val sizeValue = size.value
            json.put("size", if (sizeValue.isNotEmpty()) sizeValue else "medium")
            json.put("mode", mode.value)
            if (exposureTimeNs != null && exposureTimeNs > 0L) {
                json.put("exposureTimeNs", exposureTimeNs)
            }
            if (mfnr != null) {
                json.put("mfnr", mfnr)
            }
            if (zsl != null) {
                json.put("zsl", zsl)
            }
            json.put("durationMs", if (durationMs > 0) durationMs else 15000)
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating camera warm up JSON", e)
        }
    }

    fun stopCameraWarmUp(requestId: String) {
        if (!isConnected) {
            throw IllegalStateException("not_connected")
        }
        val json = JSONObject()
        json.put("type", "camera_warm_up_stop")
        json.put("requestId", requestId)
        sendJson(json, true)
    }

    override fun startStream(message: MutableMap<String, Any>) {
        Bridge.log("LIVE: Starting RTMP stream")

        try {
            val json = JSONObject(message as Map<*, *>)
            // Remove timestamp as iOS does
            json.remove("timestamp")
            sendJson(json, true)
        } catch (e: Exception) {
            Log.e(TAG, "Error creating RTMP stream start JSON", e)
        }
    }

    override fun stopStream() {
        Bridge.log("LIVE: Requesting to stop RTMP stream")
        try {
            val json = JSONObject()
            json.put("type", "stop_stream")

            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating RTMP stream stop JSON", e)
        }
    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {
        Bridge.log("LIVE: Sending RTMP stream keep alive")

        try {
            val json = JSONObject(message as Map<*, *>)
            sendJson(json)
        } catch (e: Exception) {
            Log.e(TAG, "Error sending RTMP stream keep alive", e)
        }
    }

    /** Track a BLE photo transfer request */
    private fun trackBlePhotoTransfer(bleImgId: String, requestId: String, webhookUrl: String?) {
        val transfer = BlePhotoTransfer(bleImgId, requestId, webhookUrl)
        blePhotoTransfers[bleImgId] = transfer
        Bridge.log(
                "LIVE: Tracking BLE photo transfer - bleImgId: " +
                        bleImgId +
                        ", requestId: " +
                        requestId
        )
    }

    /**
     * Check if the ASG client is connected to WiFi
     * @return true if connected to WiFi, false otherwise
     */
    fun isGlassesWifiConnected(): Boolean {
        return wifiConnected // Using parent SGCManager getter
    }

    /**
     * Get the SSID of the WiFi network the ASG client is connected to
     * @return SSID string, or empty string if not connected
     */
    fun getGlassesWifiSsid(): String {
        return wifiSsid
    }

    /** Manually request a WiFi status update from the ASG client */
    fun refreshGlassesWifiStatus() {
        if (isConnected) {
            requestWifiStatus()
        }
    }

    override fun getConnectedBluetoothName(): String {
        val name = connectedDevice?.name
        if (name != null) {
            return name
        }
        return ""
    }

    // Debug video command loop vars
    private var debugVideoCommandRunnable: Runnable? = null
    private var debugCommandCounter = 0

    // SOC readiness check parameters
    private var readinessCheckRunnable: Runnable? = null
    private var readinessCheckCounter = 0
    // private boolean glassesReady = false; // Track if glasses have confirmed they're ready

    /**
     * Starts the glasses SOC readiness check loop This sends a "phone_ready" message every 5
     * seconds until we receive a "glasses_ready" response, indicating the SOC is booted
     */
    private fun startReadinessCheckLoop() {
        // Stop any existing readiness check
        stopReadinessCheckLoop()

        // Reset counter and ready flag
        readinessCheckCounter = 0
        glassesReady = false

        Bridge.log("LIVE: 🔄 Starting glasses SOC readiness check loop")

        readinessCheckRunnable =
                object : Runnable {
                    override fun run() {
                        if (isConnected && !isKilled && !glassesReady) {
                            readinessCheckCounter++

                            Bridge.log(
                                    "LIVE: 🔄 Readiness check #" +
                                            readinessCheckCounter +
                                            ": waiting for glasses SOC to boot"
                            )
                            requestReadyK900()

                            // Schedule next check only if glasses are still not ready
                            if (!glassesReady) {
                                handler.postDelayed(this, READINESS_CHECK_INTERVAL_MS.toLong())
                            }
                        } else {
                            Bridge.log(
                                    "LIVE: 🔄 Readiness check loop stopping - connected: " +
                                            isConnected +
                                            ", killed: " +
                                            isKilled +
                                            ", glassesReady: " +
                                            glassesReady
                            )
                        }
                    }
                }

        // Start the loop
        handler.post(readinessCheckRunnable!!)
    }

    /** Stops the glasses SOC readiness check loop */
    private fun stopReadinessCheckLoop() {
        if (readinessCheckRunnable != null) {
            handler.removeCallbacks(readinessCheckRunnable!!)
            readinessCheckRunnable = null
            Bridge.log("LIVE: 🔄 Stopped glasses SOC readiness check loop")
        }
    }

    // ============================================================================
    // CTKD (Cross-Transport Key Derivation) Implementation for BES Devices
    // ============================================================================

    /** Initialize the bonding receiver for CTKD support */
    private fun initializeBondingReceiver() {
        bondingReceiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        val action = intent.action
                        if (BluetoothDevice.ACTION_BOND_STATE_CHANGED == action) {
                            val device =
                                    intent.getParcelableExtra<BluetoothDevice>(
                                            BluetoothDevice.EXTRA_DEVICE
                                    )
                            val bondState =
                                    intent.getIntExtra(
                                            BluetoothDevice.EXTRA_BOND_STATE,
                                            BluetoothDevice.ERROR
                                    )
                            val previousBondState =
                                    intent.getIntExtra(
                                            BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE,
                                            BluetoothDevice.ERROR
                                    )
                            // Hidden SystemApi extras — string keys are stable across Android
                            // versions.
                            // EXTRA_REASON / EXTRA_UNBOND_REASON expose why the OS rejected/cleared
                            // a bond
                            // (auth_failed, repeated_attempts, remote_auth_canceled,
                            // remote_device_down, etc.).
                            val reason =
                                    intent.getIntExtra("android.bluetooth.device.extra.REASON", -1)
                            val unbondReason =
                                    intent.getIntExtra(
                                            "android.bluetooth.device.extra.UNBOND_REASON",
                                            -1
                                    )

                            if (device != null &&
                                            connectedDevice != null &&
                                            device.address == connectedDevice!!.address
                            ) {

                                Bridge.log(
                                        "LIVE: CTKD: Bond state changed for device " +
                                                device.name +
                                                " - Current: " +
                                                bondState +
                                                ", Previous: " +
                                                previousBondState +
                                                ", reason=" +
                                                reason +
                                                ", unbondReason=" +
                                                unbondReason
                                )

                                when (bondState) {
                                    BluetoothDevice.BOND_BONDED ->
                                            run {
                                                Bridge.log(
                                                        "LIVE: CTKD: ✅ Successfully bonded with device - BT Classic connection established"
                                                )
                                                if (isKilled) {
                                                    Bridge.log(
                                                            "LIVE: CTKD: Ignoring bond complete — SGC destroyed"
                                                    )
                                                    return@run
                                                }
                                                isBtClassicConnected = true
                                                audioConnected = true
                                                bondingRetryCount =
                                                        0 // Reset retry counter on success
                                                // Both BLE and BT Classic are now connected via
                                                // CTKD

                                                // If glasses_ready was already received, now we're
                                                // fully ready
                                                if (glassesReadyReceived) {
                                                    Bridge.log(
                                                            "LIVE: Audio: Both audio and glasses_ready confirmed - marking as fully connected"
                                                    )
                                                    DeviceStore.apply(
                                                            "glasses",
                                                            "fullyBooted",
                                                            true
                                                    )
                                                    updateConnectionState(ConnTypes.CONNECTED)
                                                }

                                                // Send audio connected event for platform parity
                                                // with iOS
                                                Bridge.sendAudioConnected(device.name)
                                            }
                                    BluetoothDevice.BOND_NONE -> {
                                        Bridge.log(
                                                "LIVE: CTKD: ❌ Bonding failed or removed for device"
                                        )
                                        isBtClassicConnected = false
                                        audioConnected = false
                                        if (previousBondState == BluetoothDevice.BOND_BONDING) {
                                            // User cancelled or bonding failed - retry up to
                                            // MAX_BONDING_RETRIES times
                                            bondingRetryCount++
                                            Bridge.log(
                                                    "LIVE: CTKD: Bonding process failed (attempt " +
                                                            bondingRetryCount +
                                                            "/" +
                                                            MAX_BONDING_RETRIES +
                                                            ")"
                                            )

                                            if (bondingRetryCount < MAX_BONDING_RETRIES &&
                                                            connectedDevice != null
                                            ) {
                                                Bridge.log(
                                                        "LIVE: CTKD: 🔄 Retrying bonding in " +
                                                                BONDING_RETRY_DELAY_MS +
                                                                "ms..."
                                                )
                                                handler.postDelayed(
                                                        Runnable {
                                                            if (isKilled) {
                                                                return@Runnable
                                                            }
                                                            if (connectedDevice != null &&
                                                                            connectedDevice!!
                                                                                    .bondState !=
                                                                                    BluetoothDevice
                                                                                            .BOND_BONDED
                                                            ) {
                                                                Bridge.log(
                                                                        "LIVE: CTKD: 🔄 Initiating bonding retry #" +
                                                                                bondingRetryCount
                                                                )
                                                                createBond(connectedDevice!!)
                                                            }
                                                        },
                                                        BONDING_RETRY_DELAY_MS
                                                )
                                            } else {
                                                Bridge.log(
                                                        "LIVE: CTKD: ❌ Max bonding retries reached - disconnecting device"
                                                )
                                                // Bridge.sendError("bt_classic_pairing_required",
                                                // "Bluetooth Classic pairing is required. Please
                                                // accept the pairing dialog to use your glasses.");
                                                // Disconnect since we can't proceed without BT
                                                // Classic
                                                // disconnect();
                                            }
                                        } else if (previousBondState == BluetoothDevice.BOND_BONDED
                                        ) {
                                            // Send audio disconnected event for platform parity
                                            // with iOS
                                            Bridge.sendAudioDisconnected()
                                        }
                                    }
                                    BluetoothDevice.BOND_BONDING ->
                                            Bridge.log(
                                                    "LIVE: CTKD: 🔄 Bonding in progress with device"
                                            )
                                    else ->
                                            Bridge.log(
                                                    "LIVE: CTKD: Unknown bond state: " + bondState
                                            )
                                }
                            }
                        }
                    }
                }
    }

    /** Register the bonding receiver for CTKD monitoring */
    private fun registerBondingReceiver() {
        if (!isBondingReceiverRegistered && bondingReceiver != null) {
            val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            context!!.registerReceiver(bondingReceiver, filter)
            isBondingReceiverRegistered = true
            Bridge.log("LIVE: CTKD: Bonding receiver registered")
        }
    }

    /** Unregister the bonding receiver */
    private fun unregisterBondingReceiver() {
        if (isBondingReceiverRegistered && bondingReceiver != null) {
            try {
                context!!.unregisterReceiver(bondingReceiver)
                isBondingReceiverRegistered = false
                Bridge.log("LIVE: CTKD: Bonding receiver unregistered")
            } catch (e: Exception) {
                Bridge.log("LIVE: CTKD: Error unregistering bonding receiver: " + e.message)
            }
        }
    }

    /**
     * Create bond with device for CTKD (Cross-Transport Key Derivation) This will establish both
     * BLE and BT Classic connections automatically
     */
    private fun createBond(device: BluetoothDevice?): Boolean {
        try {
            if (device == null) {
                Bridge.log("LIVE: CTKD: Cannot create bond - device is null")
                return false
            }

            Bridge.log("LIVE: CTKD: Creating bond with device " + device.name + " for CTKD")
            val method = device.javaClass.getMethod("createBond")
            val result = method.invoke(device) as Boolean
            Bridge.log("LIVE: CTKD: Bond creation initiated, result: " + result)
            return result
        } catch (e: Exception) {
            Bridge.log("LIVE: CTKD: Error creating bond: " + e.message)
            return false
        }
    }

    /** Remove bond with device to disconnect BT Classic */
    private fun removeBond(device: BluetoothDevice?): Boolean {
        try {
            if (device == null) {
                Bridge.log("LIVE: CTKD: Cannot remove bond - device is null")
                return false
            }

            Bridge.log("LIVE: CTKD: Removing bond with device " + device.name)
            val method = device.javaClass.getMethod("removeBond")
            val result = method.invoke(device) as Boolean
            Bridge.log("LIVE: CTKD: Bond removal initiated, result: " + result)
            isBtClassicConnected = false
            return result
        } catch (e: Exception) {
            Bridge.log("LIVE: CTKD: Error removing bond: " + e.message)
            return false
        }
    }

    /** Check if BT Classic is connected via CTKD */
    fun isBtClassicConnected(): Boolean {
        return isBtClassicConnected
    }

    /** A2DP profile service listener for connecting to already-bonded devices */
    private val a2dpServiceListener: BluetoothProfile.ServiceListener =
            object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                    if (profile == BluetoothProfile.A2DP) {
                        if (isKilled) {
                            Bridge.log(
                                    "LIVE: A2DP: Ignoring onServiceConnected — SGC destroyed (stale profile callback)"
                            )
                            try {
                                if (bluetoothAdapter != null && proxy != null) {
                                    bluetoothAdapter!!.closeProfileProxy(
                                            BluetoothProfile.A2DP,
                                            proxy
                                    )
                                }
                            } catch (e: Exception) {
                                Bridge.log("LIVE: A2DP: Error closing stale proxy: " + e.message)
                            }
                            return
                        }
                        a2dpProfile = proxy as BluetoothA2dp
                        Bridge.log("LIVE: A2DP: Profile proxy obtained")

                        // Now connect to the device if we have one pending
                        if (connectedDevice != null &&
                                        connectedDevice!!.bondState == BluetoothDevice.BOND_BONDED
                        ) {
                            connectA2dpWithProxy(connectedDevice!!)
                        }
                    }
                }

                override fun onServiceDisconnected(profile: Int) {
                    if (profile == BluetoothProfile.A2DP) {
                        Bridge.log("LIVE: A2DP: Profile proxy disconnected")
                        a2dpProfile = null
                        isA2dpProxyRegistered = false // Reset so we can request a new proxy
                    }
                }
            }

    /** Helper to connect A2DP using the proxy - called from service listener or directly */
    private fun connectA2dpWithProxy(device: BluetoothDevice?) {
        if (isKilled) {
            Bridge.log("LIVE: A2DP: Skipping connectA2dpWithProxy — SGC destroyed")
            return
        }
        if (a2dpProfile == null || device == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - proxy or device is null")
            return
        }

        try {
            val state = a2dpProfile!!.getConnectionState(device)
            Bridge.log("LIVE: A2DP: Current connection state: " + state)

            if (state == BluetoothProfile.STATE_CONNECTED) {
                Bridge.log("LIVE: A2DP: Already connected to " + device.name)
                markAudioConnected(device.name)
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                Bridge.log("LIVE: A2DP: Connecting to " + device.name)
                // Use reflection to call connect() as it's a hidden API
                val connectMethod =
                        BluetoothA2dp::class.java.getMethod("connect", BluetoothDevice::class.java)
                val result = connectMethod.invoke(a2dpProfile, device) as Boolean
                Bridge.log("LIVE: A2DP: Connect initiated, result: " + result)

                // Note: connect() is async. We mark as connected optimistically because:
                // 1. The device is already bonded, so connection should succeed
                // 2. Android will handle the actual A2DP connection in the background
                // 3. If it fails, the user can still use BLE audio (LC3)
                markAudioConnected(device.name)
            } else if (state == BluetoothProfile.STATE_CONNECTING) {
                Bridge.log("LIVE: A2DP: Already connecting, marking audio as connected")
                markAudioConnected(device.name)
            } else {
                // STATE_DISCONNECTING - wait and retry
                Bridge.log("LIVE: A2DP: Device disconnecting, will retry in 500ms")
                handler.postDelayed(
                        Runnable {
                            if (isKilled) {
                                return@Runnable
                            }
                            if (connectedDevice != null && a2dpProfile != null) {
                                connectA2dpWithProxy(connectedDevice)
                            }
                        },
                        500
                )
            }
        } catch (e: Exception) {
            Bridge.log("LIVE: A2DP: Error connecting: " + e.message)
            // Still mark as connected - device is bonded and BLE audio (LC3) will work
            markAudioConnected(device.name)
        }
    }

    /** Helper to mark audio as connected and notify */
    private fun markAudioConnected(deviceName: String?) {
        if (isKilled) {
            Bridge.log(
                    "LIVE: A2DP: Ignoring markAudioConnected — SGC destroyed (would confuse DeviceManager)"
            )
            return
        }
        isBtClassicConnected = true
        audioConnected = true
        Bridge.sendAudioConnected(deviceName!!)
        if (glassesReadyReceived) {
            Bridge.log(
                    "LIVE: A2DP: Both audio and glasses_ready confirmed - marking as fully connected"
            )
            DeviceStore.apply("glasses", "fullyBooted", true)
            updateConnectionState(ConnTypes.CONNECTED)
        }
    }

    /**
     * Connect to A2DP audio profile for an already-bonded device This is needed because being
     * bonded doesn't automatically connect the audio profile
     */
    private fun connectA2dpProfile(device: BluetoothDevice?) {
        if (isKilled) {
            Bridge.log("LIVE: A2DP: Skipping connectA2dpProfile — SGC destroyed")
            return
        }
        if (device == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - device is null")
            return
        }

        if (bluetoothAdapter == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - BluetoothAdapter is null")
            return
        }

        Bridge.log("LIVE: A2DP: Requesting A2DP profile proxy for " + device.name)

        // If we already have the proxy, try to connect directly
        if (a2dpProfile != null) {
            connectA2dpWithProxy(device)
            return
        }

        // Get the A2DP profile proxy
        if (!isA2dpProxyRegistered) {
            val result =
                    bluetoothAdapter!!.getProfileProxy(
                            context,
                            a2dpServiceListener,
                            BluetoothProfile.A2DP
                    )
            if (result) {
                isA2dpProxyRegistered = true
                Bridge.log("LIVE: A2DP: Profile proxy request successful, waiting for callback")
            } else {
                Bridge.log(
                        "LIVE: A2DP: Failed to get profile proxy, marking audio connected anyway"
                )
                // Still mark as connected - device is bonded and BLE audio (LC3) will work
                markAudioConnected(device.name)
            }
        } else {
            Bridge.log("LIVE: A2DP: Proxy already registered, waiting for callback")
        }
    }

    /** Close the A2DP profile proxy */
    private fun closeA2dpProxy() {
        if (a2dpProfile != null && bluetoothAdapter != null) {
            Bridge.log("LIVE: A2DP: Closing profile proxy")
            bluetoothAdapter!!.closeProfileProxy(BluetoothProfile.A2DP, a2dpProfile)
            a2dpProfile = null
        }
        isA2dpProxyRegistered = false
    }

    fun destroy() {
        Bridge.log("LIVE: Destroying MentraLiveSGC")

        // Mark as killed to prevent reconnection attempts
        isKilled = true

        // Stop scanning if in progress
        if (isScanning) {
            stopScan()
            emitStopScanEvent()
        }

        // CTKD Implementation: Unregister bonding receiver
        unregisterBondingReceiver()

        // Close A2DP profile proxy
        closeA2dpProxy()

        // Stop readiness check loop
        stopReadinessCheckLoop()

        // Stop heartbeat mechanism
        stopHeartbeat()

        // Stop RSSI polling
        stopSignalStrengthPolling()

        // Stop micbeat mechanism
        stopMicBeat()

        // Stop phone audio monitor
        if (phoneAudioMonitor != null) {
            phoneAudioMonitor!!.stopMonitoring()
            Bridge.log("LIVE: 🎵 Phone audio monitor stopped")
        }

        // Clear pending descriptor writes
        pendingDescriptorWrites.clear()
        isDescriptorWriteInProgress = false
        notificationsEnabled = false

        // Cancel connection timeout
        if (connectionTimeoutRunnable != null) {
            connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable!!)
        }

        // Cancel any pending handlers
        handler.removeCallbacksAndMessages(null)
        fileProcessingHandler.removeCallbacksAndMessages(null)
        heartbeatHandler.removeCallbacksAndMessages(null)
        rssiReadHandler.removeCallbacksAndMessages(null)
        micBeatHandler.removeCallbacksAndMessages(null)
        connectionTimeoutHandler.removeCallbacksAndMessages(null)
        testMessageHandler.removeCallbacksAndMessages(null)

        // Clean up message tracking
        pendingMessages.clear()
        incomingChunkReassembler.clear()
        Bridge.log("LIVE: Cleared pending message tracking")

        // Release RGB LED control authority before disconnecting
        // DISABLED: MentraLive is not supposed to send this command
        // if (rgbLedAuthorityClaimed) {
        //     sendRgbLedControlAuthority(false);
        // }

        // Close the L2CAP file channel (if the fast path was open)
        closeL2capFileChannel()

        // Disconnect from GATT if connected
        closeGattQuietly(true)

        isConnected = false
        isConnecting = false

        // Clear the send queue
        sendQueue.clear()

        // Clear file packet reassembly buffer
        clearFilePacketBuffer()
        fileProcessingThread.quitSafely()

        // Reset state variables
        reconnectAttempts = 0
        isReconnecting = false
        glassesReady = false
        DeviceStore.apply("glasses", "fullyBooted", false)
        updateConnectionState(ConnTypes.DISCONNECTED)

        // Note: We don't null context here to prevent race conditions with BLE callbacks
        // The isKilled flag above serves as our destruction indicator
        // dataObservable = null;

        // Set connection state to disconnected
        // connectionEvent(SmartGlassesConnectionState.DISCONNECTED);

        // Clean up LC3 audio player
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer!!.stopPlay()
        }

        // Clean up LC3 decoder
        if (lc3DecoderPtr != 0L) {
            Lc3Cpp.freeDecoder(lc3DecoderPtr)
            lc3DecoderPtr = 0
            Bridge.log("LIVE: Freed LC3 decoder resources")
        }
    }

    // Display methods - all stub implementations since Mentra Live has no display

    // @Override
    // public void setFontSize(SmartGlassesFontSize fontSize) {
    //     Bridge.log("LIVE: [STUB] Device has no display. Cannot set font size: " + fontSize);
    // }

    fun sendButtonPhotoSettings(size: String?) {
        sendButtonPhotoSettings(null, size)
    }

    fun sendButtonPhotoSettings(requestId: String?, size: String?) {
        sendButtonPhotoSettings(
            requestId,
            size,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            false,
        )
    }

    fun sendButtonPhotoSettings(
        requestId: String?,
        size: String?,
        mfnr: Boolean?,
        zsl: Boolean?,
        noiseReduction: Boolean?,
        edgeEnhancement: Boolean?,
        ispDigitalGain: Int?,
        ispAnalogGain: String?,
        aeExposureDivisor: Int?,
        isoCap: Int?,
        compress: String?,
        sound: Boolean?,
        resetCaptureTuning: Boolean,
    ) {
        val command = JSONObject()
        try {
            command.put("type", "button_photo_setting")
            if (requestId != null && !requestId.isEmpty()) {
                command.put("request_id", requestId)
            }
            if (size != null) {
                command.put("size", size)
            }
            if (mfnr != null) {
                command.put("mfnr", mfnr)
            }
            if (zsl != null) {
                command.put("zsl", zsl)
            }
            if (noiseReduction != null) {
                command.put("noiseReduction", noiseReduction)
            }
            if (edgeEnhancement != null) {
                command.put("edgeEnhancement", edgeEnhancement)
            }
            if (ispDigitalGain != null) {
                command.put("ispDigitalGain", ispDigitalGain)
            }
            if (!ispAnalogGain.isNullOrEmpty()) {
                command.put("ispAnalogGain", ispAnalogGain)
            }
            if (aeExposureDivisor != null && aeExposureDivisor > 1) {
                command.put("aeExposureDivisor", aeExposureDivisor)
            }
            if (isoCap != null && isoCap > 0) {
                command.put("isoCap", isoCap)
            }
            if (!compress.isNullOrEmpty()) {
                command.put("compress", compress)
            }
            if (sound != null) {
                command.put("sound", sound)
            }
            if (resetCaptureTuning) {
                command.put("resetCaptureTuning", true)
            }
            sendJson(command, true)
        } catch (e: Exception) {
            Log.e(TAG, "Error sending button photo settings", e)
        }
    }

    override fun sendButtonVideoRecordingSettings() {
        try {
            val videoSettingsObj = DeviceStore.get("bluetooth", "button_video_settings")
            var videoWidth = 1920 // defaults
            var videoHeight = 1080
            var videoFps = 30

            if (videoSettingsObj is Map<*, *>) {
                @Suppress("UNCHECKED_CAST") val videoSettings = videoSettingsObj as Map<String, Any>
                videoWidth = (videoSettings.getOrDefault("width", videoWidth) as Number).toInt()
                videoHeight = (videoSettings.getOrDefault("height", videoHeight) as Number).toInt()
                videoFps = (videoSettings.getOrDefault("fps", videoFps) as Number).toInt()
            } else {
                val width = DeviceStore.get("bluetooth", "button_video_width")
                val height = DeviceStore.get("bluetooth", "button_video_height")
                val fps = DeviceStore.get("bluetooth", "button_video_fps")
                if (width is Number) {
                    videoWidth = width.toInt()
                }
                if (height is Number) {
                    videoHeight = height.toInt()
                }
                if (fps is Number) {
                    videoFps = fps.toInt()
                }
            }
            sendButtonVideoRecordingSettings(null, videoWidth, videoHeight, videoFps)
        } catch (e: Exception) {
            Log.e(TAG, "❌ [SETTINGS_SYNC] Error sending button video recording settings", e)
        }
    }

    fun sendButtonVideoRecordingSettings(
            requestId: String?,
            videoWidth: Int,
            videoHeight: Int,
            videoFps: Int
    ) {
        try {
            Bridge.log(
                    "LIVE: 🎥 [SETTINGS_SYNC] Sending button video recording settings: " +
                            videoWidth +
                            "x" +
                            videoHeight +
                            "@" +
                            videoFps +
                            "fps"
            )

            val json = JSONObject()
            json.put("type", "button_video_recording_setting")
            if (requestId != null && !requestId.isEmpty()) {
                json.put("request_id", requestId)
            }
            val settings = JSONObject()
            settings.put("width", videoWidth)
            settings.put("height", videoHeight)
            settings.put("fps", videoFps)
            json.put("params", settings)
            Bridge.log("LIVE: 📤 [SETTINGS_SYNC] BLE packet prepared: " + json.toString())
            sendJson(json)
            Bridge.log("LIVE: ✅ [SETTINGS_SYNC] Video settings transmitted via BLE")
        } catch (e: JSONException) {
            Log.e(TAG, "❌ [SETTINGS_SYNC] Error sending button video recording settings", e)
        }
    }

    override fun sendText(text: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Text would show: " + text)
    }

    override fun sendTextWall(text: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Text wall would show: " + text)
    }

    fun displayBitmap(bitmap: Bitmap) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display bitmap.")
    }

    fun displayTextLine(text: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Text line would show: " + text)
    }

    fun displayReferenceCardSimple(title: String, body: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Reference card would show: " + title)
    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot set brightness: " + level)
    }

    fun showHomeScreen() {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot show home screen.")
    }

    fun blankScreen() {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot blank screen.")
    }

    fun displayRowsCard(rowStrings: Array<String>) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Cannot display rows card with " +
                        rowStrings.size +
                        " rows"
        )
    }

    fun showNaturalLanguageCommandScreen(prompt: String, naturalLanguageArgs: String) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Cannot show natural language command screen: " +
                        prompt
        )
    }

    fun updateNaturalLanguageCommandScreen(naturalLanguageArgs: String) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Cannot update natural language command screen"
        )
    }

    fun scrollingTextViewIntermediateText(text: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display scrolling text: " + text)
    }

    fun displayPromptView(title: String, options: Array<String>) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display prompt view: " + title)
    }

    fun displayCustomContent(json: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display custom content")
    }

    override fun clearDisplay() {
        Log.w(TAG, "MentraLiveSGC does not support clearDisplay")
    }

    fun displayReferenceCardImage(title: String, body: String, imgUrl: String) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Reference card with image would show: " + title
        )
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Double text wall would show: " +
                        top +
                        " / " +
                        bottom
        )
    }

    fun displayBulletList(title: String, bullets: Array<String>) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Bullet list would show: " +
                        title +
                        " with " +
                        bullets.size +
                        " items"
        )
    }

    fun startScrollingTextViewMode(title: String) {
        Bridge.log(
                "LIVE: [STUB] Device has no display. Scrolling text view would start with: " + title
        )
    }

    fun scrollingTextViewFinalText(text: String) {
        Bridge.log("LIVE: [STUB] Device has no display. Scrolling text view would show: " + text)
    }

    fun stopScrollingTextViewMode() {
        // Not supported on Mentra Live
    }

    /**
     * Enable or disable receiving custom GATT audio from the glasses microphone.
     * @param enable True to enable, false to disable.
     */
    fun sendEnableCustomAudioTxMessage(enable: Boolean) {
        try {
            val cmd = JSONObject()
            cmd.put("C", "enable_custom_audio_tx")
            val enableObj = JSONObject()
            enableObj.put("enable", enable)
            cmd.put("B", enableObj.toString())

            val jsonStr = cmd.toString()
            Bridge.log("LIVE: Sending hrt command: " + jsonStr)
            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            jsonStr.toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )

            queueData(packedData)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating enable_custom_audio_tx command", e)
        }
    }

    /**
     * Enable or disable sending custom GATT audio to the glasses speaker.
     * @param enable True to enable, false to disable.
     */
    fun enableCustomAudioRx(enable: Boolean) {
        try {
            val cmd = JSONObject()
            cmd.put("C", "enable_custom_audio_rx")
            cmd.put("B", enable)
            sendJson(cmd)
            Bridge.log("LIVE: Setting custom audio RX (speaker) to: " + enable)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating enable_custom_audio_rx command", e)
        }
    }

    /**
     * Enable or disable the standard HFP audio service on the glasses.
     * @param enable True to enable, false to disable.
     */
    fun enableHfpAudioServer(enable: Boolean) {
        try {
            val cmd = JSONObject()
            cmd.put("C", "enable_hfp_audio_server")
            cmd.put("B", enable)
            sendJson(cmd)
            Bridge.log("LIVE: Setting HFP audio server to: " + enable)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating enable_hfp_audio_server command", e)
        }
    }

    /**
     * Enable or disable audio playback through phone speakers when receiving LC3 audio from
     * glasses. This allows you to hear what the glasses microphone is picking up in real-time.
     * @param enable True to enable audio playback, false to disable.
     */
    fun enableAudioPlayback(enable: Boolean) {
        audioPlaybackEnabled = enable
        if (enable) {
            Bridge.log("LIVE: 🔊 Audio playback enabled")
            if (lc3AudioPlayer != null) {
                lc3AudioPlayer!!.startPlay()
                Bridge.log("LIVE: 🔊 LC3 audio player started")
            } else {
                Bridge.log("LIVE: ⚠️ LC3 audio player is null - playback not available")
            }
        } else {
            Bridge.log("LIVE: 🔊 Audio playback disabled")
            if (lc3AudioPlayer != null) {
                lc3AudioPlayer!!.stopPlay()
                Bridge.log("LIVE: 🔊 LC3 audio player stopped")
            }
        }
    }

    /**
     * Check if audio playback is currently enabled.
     * @return True if audio playback is enabled, false otherwise.
     */
    fun isAudioPlaybackEnabled(): Boolean {
        return audioPlaybackEnabled
    }

    /**
     * Set the volume for audio playback.
     * @param volume Volume level from 0.0f (muted) to 1.0f (full volume).
     */
    fun setAudioPlaybackVolume(volume: Float) {
        if (lc3AudioPlayer != null) {
            // Clamp volume to valid range
            val clampedVolume = Math.max(0.0f, Math.min(1.0f, volume))
            // Note: LC3Player doesn't have setVolume method, using system volume
            Bridge.log(
                    "LIVE: Audio playback volume request: " +
                            clampedVolume +
                            " (handled by system volume)"
            )
        }
    }

    /**
     * Get the current audio playback volume.
     * @return Current volume level from 0.0f to 1.0f.
     */
    fun getAudioPlaybackVolume(): Float {
        // Note: LC3Player doesn't have a getVolume method, so we'll return a default
        // In a real implementation, you might want to track this separately
        return 1.0f // Default to full volume
    }

    /** Stop any currently playing audio immediately. */
    fun stopAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer!!.stopPlay()
            Bridge.log("LIVE: Audio playback stopped")
        }
    }

    /**
     * Check if audio is currently playing.
     * @return True if audio is currently playing, false otherwise.
     */
    fun isAudioPlaying(): Boolean {
        return lc3AudioPlayer != null && audioPlaybackEnabled
    }

    /** Pause audio playback. */
    fun pauseAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer!!.stopPlay()
            Bridge.log("LIVE: Audio playback paused")
        }
    }

    /** Resume audio playback. */
    fun resumeAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer!!.startPlay()
            Bridge.log("LIVE: Audio playback resumed")
        }
    }

    /**
     * Get audio playback statistics and status information.
     * @return JSONObject containing audio playback information.
     */
    fun getAudioPlaybackStatus(): JSONObject {
        val status = JSONObject()
        try {
            status.put("enabled", audioPlaybackEnabled)
            status.put("playing", isAudioPlaying())
            status.put("volume", getAudioPlaybackVolume())
            status.put("initialized", lc3AudioPlayer != null)
            status.put("playerType", "LC3Player")
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating audio playback status JSON", e)
        }
        return status
    }

    /**
     * Enable or disable rolling audio recording When enabled, saves the last 20 seconds of audio as
     * M4A file every 20 seconds
     * @param enable True to enable rolling recording, false to disable
     */
    fun enableRollingRecording(enable: Boolean) {
        rollingRecordingEnabled = enable
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer!!.enableRollingRecording(enable)
            Bridge.log("LIVE: 🎙️ Rolling recording " + (if (enable) "ENABLED" else "DISABLED"))
        } else {
            Bridge.log("LIVE: ⚠️ Cannot enable rolling recording - LC3 player not initialized")
        }
    }

    /**
     * Check if rolling recording is currently enabled.
     * @return True if rolling recording is enabled, false otherwise.
     */
    fun isRollingRecordingEnabled(): Boolean {
        return rollingRecordingEnabled
    }

    fun requestReadyK900() {
        try {
            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_hrt") // Video command
            // cmdObject.put("W", 1);        // Wake up MTK system
            cmdObject.put("B", "") // Add the body
            val jsonStr = cmdObject.toString()
            Bridge.log("LIVE: Sending hrt command: " + jsonStr)
            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            jsonStr.toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            queueData(packedData)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating video command", e)
        }
    }

    fun keepAwake() {
        try {
            val json = JSONObject()
            json.put("type", "keep_awake")
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating keep_awake command", e)
        }
    }

    fun requestBatteryK900() {
        try {
            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_batv") // Video command
            cmdObject.put("V", 1) // Version is always 1
            cmdObject.put("B", "") // Add the body
            val jsonStr = cmdObject.toString()
            Bridge.log("LIVE: Sending hotspot command: " + jsonStr)
            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            jsonStr.toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            queueData(packedData)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating video command", e)
        }
    }

    private fun optK900Body(json: JSONObject?): JSONObject? {
        if (json == null || !json.has("B")) {
            return null
        }
        try {
            val b = json.get("B")
            if (b is JSONObject) {
                return b
            }
            if (b is String) {
                return JSONObject(b)
            }
        } catch (e: Exception) {
            Log.e(TAG, "optK900Body parse error", e)
        }
        return null
    }

    private fun cancelGlassesMediaVolumeTimeoutLocked() {
        if (glassesMediaVolumeTimeoutRunnable != null) {
            handler.removeCallbacks(glassesMediaVolumeTimeoutRunnable!!)
            glassesMediaVolumeTimeoutRunnable = null
        }
    }

    private fun scheduleGlassesMediaVolumeTimeoutLocked() {
        cancelGlassesMediaVolumeTimeoutLocked()
        glassesMediaVolumeTimeoutRunnable = Runnable {
            var gOk: Consumer<Map<String, Any>>? = null
            var gErr: Consumer<String>? = null
            var sOk: Consumer<Map<String, Any>>? = null
            var sErr: Consumer<String>? = null
            synchronized(glassesMediaVolumeLock) {
                gOk = pendingGetGlassesVolumeSuccess
                gErr = pendingGetGlassesVolumeError
                sOk = pendingSetGlassesVolumeSuccess
                sErr = pendingSetGlassesVolumeError
                pendingGetGlassesVolumeSuccess = null
                pendingGetGlassesVolumeError = null
                pendingSetGlassesVolumeSuccess = null
                pendingSetGlassesVolumeError = null
                cancelGlassesMediaVolumeTimeoutLocked()
            }
            if (gErr != null) {
                handler.post { gErr!!.accept("glasses_volume_timeout") }
            }
            if (sErr != null) {
                handler.post { sErr!!.accept("glasses_volume_timeout") }
            }
        }
        handler.postDelayed(
                glassesMediaVolumeTimeoutRunnable!!,
                GLASSES_MEDIA_VOLUME_TIMEOUT_MS.toLong()
        )
    }

    private fun sendGlassesMediaVolumeGetCommand(): Boolean {
        try {
            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_getvol")
            cmdObject.put("V", 1)
            cmdObject.put("B", "")
            val jsonStr = cmdObject.toString()
            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            jsonStr.toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            Bridge.log("LIVE: AUDIO: Sending cs_getvol command: " + jsonStr)
            queueData(packedData)
            return true
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating cs_getvol", e)
            return false
        }
    }

    private fun sendGlassesMediaVolumeSetCommand(level: Int): Boolean {
        val clamped = Math.max(0, Math.min(15, level))
        try {
            val bData = JSONObject()
            bData.put("vol", clamped)
            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_vol")
            cmdObject.put("V", 1)
            cmdObject.put("B", bData.toString())
            val jsonStr = cmdObject.toString()
            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            jsonStr.toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            queueData(packedData)
            return true
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating cs_vol", e)
            return false
        }
    }

    private fun handleSrGetvol(json: JSONObject) {
        val body = optK900Body(json)
        val vol = if (body != null) body.optInt("vol", -1) else -1
        var status = json.optInt("S", -1)
        if (status < 0 && body != null) {
            status = body.optInt("S", -1)
        }

        var ok: Consumer<Map<String, Any>>? = null
        var err: Consumer<String>? = null
        synchronized(glassesMediaVolumeLock) {
            if (pendingGetGlassesVolumeSuccess == null) {
                Bridge.log(
                        "LIVE: sr_getvol with no pending request (status=" +
                                status +
                                ", vol=" +
                                vol +
                                ")"
                )
                return
            }
            ok = pendingGetGlassesVolumeSuccess
            err = pendingGetGlassesVolumeError
            pendingGetGlassesVolumeSuccess = null
            pendingGetGlassesVolumeError = null
            cancelGlassesMediaVolumeTimeoutLocked()
        }

        if (vol < 0 || vol > 15) {
            Bridge.log("LIVE: sr_getvol invalid vol=" + vol)
            if (err != null) {
                handler.post { err!!.accept("glasses_volume_invalid_response") }
            }
            return
        }

        val map = HashMap<String, Any>()
        map["level"] = vol
        map["statusCode"] = status
        Bridge.log("LIVE: sr_getvol received vol=" + vol + " (0-15), statusCode=" + status)
        if (ok != null) {
            handler.post { ok!!.accept(map) }
        }
    }

    private fun handleSrVol(json: JSONObject) {
        val status = json.optInt("S", -1)

        var ok: Consumer<Map<String, Any>>? = null
        synchronized(glassesMediaVolumeLock) {
            if (pendingSetGlassesVolumeSuccess == null) {
                Bridge.log("LIVE: sr_vol with no pending request (status=" + status + ")")
                return
            }
            ok = pendingSetGlassesVolumeSuccess
            pendingSetGlassesVolumeSuccess = null
            pendingSetGlassesVolumeError = null
            cancelGlassesMediaVolumeTimeoutLocked()
        }

        val map = HashMap<String, Any>()
        map["statusCode"] = status
        if (ok != null) {
            handler.post { ok!!.accept(map) }
        }
    }

    /** Read glasses media step volume (0–15) via K900 cs_getvol / sr_getvol. */
    fun getGlassesMediaVolume(onSuccess: Consumer<Map<String, Any>>, onError: Consumer<String>) {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            handler.post { onError.accept("glasses_not_ready") }
            return
        }
        synchronized(glassesMediaVolumeLock) {
            if (pendingGetGlassesVolumeSuccess != null || pendingSetGlassesVolumeSuccess != null) {
                handler.post { onError.accept("glasses_volume_busy") }
                return
            }
            pendingGetGlassesVolumeSuccess = onSuccess
            pendingGetGlassesVolumeError = onError
            scheduleGlassesMediaVolumeTimeoutLocked()
        }
        if (!sendGlassesMediaVolumeGetCommand()) {
            synchronized(glassesMediaVolumeLock) {
                pendingGetGlassesVolumeSuccess = null
                pendingGetGlassesVolumeError = null
                cancelGlassesMediaVolumeTimeoutLocked()
            }
            handler.post { onError.accept("glasses_volume_send_failed") }
        }
    }

    /** Set glasses media step volume (0–15) via K900 cs_vol / sr_vol. */
    fun setGlassesMediaVolume(
            level: Int,
            onSuccess: Consumer<Map<String, Any>>,
            onError: Consumer<String>
    ) {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            handler.post { onError.accept("glasses_not_ready") }
            return
        }
        synchronized(glassesMediaVolumeLock) {
            if (pendingGetGlassesVolumeSuccess != null || pendingSetGlassesVolumeSuccess != null) {
                handler.post { onError.accept("glasses_volume_busy") }
                return
            }
            pendingSetGlassesVolumeSuccess = onSuccess
            pendingSetGlassesVolumeError = onError
            scheduleGlassesMediaVolumeTimeoutLocked()
        }
        if (!sendGlassesMediaVolumeSetCommand(level)) {
            synchronized(glassesMediaVolumeLock) {
                pendingSetGlassesVolumeSuccess = null
                pendingSetGlassesVolumeError = null
                cancelGlassesMediaVolumeTimeoutLocked()
            }
            handler.post { onError.accept("glasses_volume_send_failed") }
        }
    }

    // ---------------------------------------
    // Power Control Methods
    // ---------------------------------------

    /**
     * Send shutdown command to the glasses. This will initiate a graceful shutdown of the device.
     */
    override fun sendShutdown() {
        Bridge.log("LIVE: 🔌 Sending shutdown command to glasses")
        try {
            val json = JSONObject()
            json.put("type", "shutdown")
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating shutdown command", e)
        }
    }

    /** Send reboot command to the glasses. This will initiate a reboot of the device. */
    override fun sendReboot() {
        Bridge.log("LIVE: 🔄 Sending reboot command to glasses")
        try {
            val json = JSONObject()
            json.put("type", "reboot")
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating reboot command", e)
        }
    }

    // ---------------------------------------
    // IMU Methods
    // ---------------------------------------

    /**
     * Request a single IMU reading from the glasses Power-optimized: sensors turn on briefly then
     * off
     */
    fun requestImuSingle() {
        Bridge.log("LIVE: Requesting single IMU reading")
        try {
            val json = JSONObject()
            json.put("type", "imu_single")
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating IMU single request", e)
        }
    }

    /**
     * Start IMU streaming from the glasses
     * @param rateHz Sampling rate in Hz (1-100)
     * @param batchMs Batching period in milliseconds (0-1000)
     */
    fun startImuStream(rateHz: Int, batchMs: Long) {
        Bridge.log("LIVE: Starting IMU stream: " + rateHz + "Hz, batch: " + batchMs + "ms")
        try {
            val json = JSONObject()
            json.put("type", "imu_stream_start")
            json.put("rate_hz", rateHz)
            json.put("batch_ms", batchMs)
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating IMU stream start request", e)
        }
    }

    /** Stop IMU streaming from the glasses */
    fun stopImuStream() {
        Bridge.log("LIVE: Stopping IMU stream")
        try {
            val json = JSONObject()
            json.put("type", "imu_stream_stop")
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating IMU stream stop request", e)
        }
    }

    /**
     * Subscribe to gesture detection on the glasses Power-optimized: uses accelerometer-only at low
     * rate
     * @param gestures List of gestures to detect ("head_up", "head_down", "nod_yes", "shake_no")
     */
    fun subscribeToImuGestures(gestures: List<String>) {
        Bridge.log("LIVE: Subscribing to IMU gestures: " + gestures)
        try {
            val json = JSONObject()
            json.put("type", "imu_subscribe_gesture")
            json.put("gestures", JSONArray(gestures))
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating IMU gesture subscription", e)
        }
    }

    /** Unsubscribe from all gesture detection */
    fun unsubscribeFromImuGestures() {
        Bridge.log("LIVE: Unsubscribing from IMU gestures")
        try {
            val json = JSONObject()
            json.put("type", "imu_unsubscribe_gesture")
            sendJson(json, false)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating IMU gesture unsubscription", e)
        }
    }

    /** Handle IMU response from glasses */
    private fun handleImuResponse(json: JSONObject) {
        try {
            val type = json.getString("type")

            when (type) {
                "imu_response" ->
                        // Single IMU reading
                        handleSingleImuData(json)
                "imu_stream_response" ->
                        // Stream of IMU readings
                        handleStreamImuData(json)
                "imu_gesture_response" ->
                        // Gesture detected
                        handleImuGesture(json)
                "imu_gesture_subscribed" ->
                        // Gesture subscription confirmed
                        Bridge.log(
                                "LIVE: IMU gesture subscription confirmed: " +
                                        json.optJSONArray("gestures")
                        )
                "imu_ack" ->
                        // Command acknowledgment
                        Bridge.log("LIVE: IMU command acknowledged: " + json.optString("message"))
                "imu_error" ->
                        // Error response
                        Log.e(TAG, "IMU error: " + json.optString("error"))
                else -> Log.w(TAG, "Unknown IMU response type: " + type)
            }
        } catch (e: JSONException) {
            Log.e(TAG, "Error handling IMU response", e)
        }
    }

    private fun handleSingleImuData(json: JSONObject) {
        try {
            // Extract IMU data
            val accel = json.getJSONArray("accel")
            val gyro = json.getJSONArray("gyro")
            val mag = json.getJSONArray("mag")
            val quat = json.getJSONArray("quat")
            val euler = json.getJSONArray("euler")

            Log.d(
                    TAG,
                    String.format(
                            "IMU Single Reading - Accel: [%.2f, %.2f, %.2f], Euler: [%.1f°, %.1f°, %.1f°]",
                            accel.getDouble(0),
                            accel.getDouble(1),
                            accel.getDouble(2),
                            euler.getDouble(0),
                            euler.getDouble(1),
                            euler.getDouble(2)
                    )
            )

            // Send IMU data event via Bridge (matches iOS emitImuDataEvent)
            val accelArray =
                    doubleArrayOf(accel.getDouble(0), accel.getDouble(1), accel.getDouble(2))
            val gyroArray = doubleArrayOf(gyro.getDouble(0), gyro.getDouble(1), gyro.getDouble(2))
            val magArray = doubleArrayOf(mag.getDouble(0), mag.getDouble(1), mag.getDouble(2))
            val quatArray =
                    doubleArrayOf(
                            quat.getDouble(0),
                            quat.getDouble(1),
                            quat.getDouble(2),
                            quat.getDouble(3)
                    )
            val eulerArray =
                    doubleArrayOf(euler.getDouble(0), euler.getDouble(1), euler.getDouble(2))

            Bridge.sendImuDataEvent(
                    accelArray,
                    gyroArray,
                    magArray,
                    quatArray,
                    eulerArray,
                    System.currentTimeMillis()
            )
        } catch (e: JSONException) {
            Log.e(TAG, "Error parsing single IMU data", e)
        }
    }

    private fun jsonArrayToDoubleArray(source: JSONArray?, expectedLength: Int): DoubleArray {
        if (source == null) {
            return DoubleArray(0)
        }
        val length = Math.min(expectedLength, source.length())
        val out = DoubleArray(length)
        for (i in 0 until length) {
            out[i] = source.optDouble(i, 0.0)
        }
        return out
    }

    private fun handleStreamImuData(json: JSONObject) {
        try {
            val readings = json.getJSONArray("readings")

            for (i in 0 until readings.length()) {
                val reading = readings.getJSONObject(i)
                handleSingleImuData(reading)
            }
        } catch (e: JSONException) {
            Log.e(TAG, "Error parsing stream IMU data", e)
        }
    }

    private fun handleImuGesture(json: JSONObject) {
        try {
            val gesture = json.getString("gesture")
            val timestamp = json.optLong("timestamp", System.currentTimeMillis())

            Bridge.log("LIVE: IMU Gesture detected: " + gesture)

            // Send IMU gesture event via Bridge (matches iOS emitImuGestureEvent)
            Bridge.sendImuGestureEvent(gesture, timestamp)
        } catch (e: JSONException) {
            Log.e(TAG, "Error parsing IMU gesture", e)
        }
    }

    /** Negotiated K900 STRING length endianness for outbound frames to the glasses. */
    private fun k900LengthEndian(): K900LengthCodec.Endian =
            if (peerK900Le) K900LengthCodec.Endian.LE else K900LengthCodec.Endian.BE

    /**
     * Parse a {@code wire_caps} object from a version_info/glasses_ready message and update the
     * negotiated per-link endianness and binary support. Missing wire_caps leaves the legacy
     * defaults (BE, no binary) untouched so older glasses keep working.
     */
    /**
     * Drop every negotiated wire-session artifact and bump the session generation so
     * scheduled callbacks from the old session stand down. Called on BLE disconnect and on
     * glasses_ready: the glasses run onTransportReset() before sending glasses_ready, so a
     * mid-link ASG restart (no BLE disconnect) resets THEIR side to legacy framing - the
     * phone must treat every glasses_ready as a new wire epoch and renegotiate (bounded by
     * the per-session handshake attempt cap) instead of trusting stale v2-active state.
     */
    private fun resetWireNegotiationState() {
        incomingChunkReassembler.clear()
        peerWireProtocolVersion = 0
        useBinaryWireProtocol = false
        wireHandshakeQueued = false
        wireHandshakeAttempts = 0
        wireSessionGeneration++
        peerK900Le = false
        peerWireCapsBinary = false
        peerFilePayloadV2 = false
        BleJsonCompact.resetSession()
        wireHandshakeSentGeneration = -1
    }

    /** Sends phone_ready to (re)start the glasses-driven readiness flow. */
    private fun sendPhoneReady(reason: String) {
        Bridge.log("LIVE: 📱 Sending phone_ready to glasses ($reason) - waiting for glasses_ready response")
        val readyMsg = JSONObject()
        readyMsg.put("type", "phone_ready")
        readyMsg.put("timestamp", System.currentTimeMillis())
        sendJson(readyMsg, true)
    }

    /**
     * Tracks the glasses process session id (`sid`) and re-runs the phone-driven readiness
     * flow when it changes under a live BLE link. The BES holds the link across asg_client
     * restarts (APK OTA, crash recovery), so a restarted glasses process is invisible to
     * transport state; the sid is the explicit protocol signal.
     *
     * Tri-state by design (retro-compat with pre-sid glasses builds):
     * - no `sid` key: legacy glasses - do nothing, today's behavior;
     * - sid appears where none was known on an ESTABLISHED session: the glasses just
     *   updated from a pre-sid build and restarted - treat as a restart (this is the
     *   upgrade OTA itself);
     * - sid differs from the recorded one: the glasses restarted - treat as a restart;
     * - same sid: same process, no action.
     *
     * A restart is handled as a LOGICAL session reset: send phone_ready immediately
     * (instead of waiting for the next sr_hrt heartbeat, and bypassing its stale
     * glassesReady suppression); the returning glasses_ready runs the full existing
     * remote-wire-reset flow. glassesReady/fullyBooted are deliberately left untouched -
     * the physical link never dropped, so the connection UI must not flap. The RN layer
     * is notified so the OTA coordinator can treat it as its reconnect edge.
     */
    private fun handleGlassesSessionId(json: JSONObject) {
        val sid = json.optString("sid", "")
        if (sid.isEmpty()) return
        val previous = glassesSessionId
        if (sid == previous) return
        glassesSessionId = sid
        if (previous == null && !readinessCompletedThisBleSession) {
            // First sid of a fresh BLE session before readiness completes: the normal
            // pairing/readiness flow is already running - just record it.
            return
        }
        Bridge.log(
                "LIVE: 🔁 Glasses session changed (${previous ?: "<pre-sid build>"} -> $sid) - " +
                        "asg restarted under a live link, re-running readiness"
        )
        sendPhoneReady("glasses session changed")
        try {
            val payload = HashMap<String, Any>()
            payload["previous_sid"] = previous ?: ""
            payload["sid"] = sid
            Bridge.sendTypedMessage("glasses_session_changed", payload)
        } catch (e: Exception) {
            Log.e(TAG, "Error emitting glasses_session_changed", e)
        }
    }

    private fun parsePeerWireCaps(json: JSONObject) {
        val caps = json.optJSONObject("wire_caps") ?: return
        if (caps.optBoolean("k900_le", false)) {
            if (!peerK900Le) {
                peerK900Le = true
                Bridge.log("LIVE: wire_caps negotiated k900 endian=LE")
            }
        }
        if (caps.has("binary")) {
            peerWireCapsBinary = caps.optBoolean("binary", false)
        }
        if (caps.has("file_payload_v2")) {
            peerFilePayloadV2 = caps.optBoolean("file_payload_v2", false)
        }
    }

    private fun advertiseFilePayloadCapabilityToBes() {
        if (!peerFilePayloadV2) return
        try {
            val command = JSONObject()
            command.put("C", "cs_file_payload")
            command.put("B", "{\"max\":" + K900ProtocolUtils.FILE_PACK_SIZE + "}")
            val packed =
                    K900ProtocolUtils.packDataToK900(
                            command.toString().toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            queueData(packed)
            Bridge.log(
                    "LIVE: 📦 Advertised file payload ceiling " +
                            K900ProtocolUtils.FILE_PACK_SIZE +
                            " to BES"
            )
        } catch (e: JSONException) {
            Log.e(TAG, "Failed to advertise file payload capability", e)
        }
    }

    private fun maybeSendWireHandshake() {
        // Only attempt the v2 binary handshake once the glasses have advertised binary support via
        // wire_caps. Older builds that report build>=5 but lack wire_caps stay on the legacy path.
        if (buildNumberInt < 5 ||
                        !peerWireCapsBinary ||
                        wireHandshakeQueued ||
                        peerWireProtocolVersion >= BleWireProtocol.PROTOCOL_V2
        ) {
            return
        }
        sendWireHandshake()
    }

    private fun sendWireHandshake() {
        if (buildNumberInt < 5) {
            return
        }
        try {
            val payload = BleWireProtocol.HANDSHAKE_PAYLOAD_V2.toByteArray(StandardCharsets.UTF_8)
            var flags = BleWireProtocol.BLE_WIRE_FLAG_HANDSHAKE.toInt()
            flags = flags or BleWireProtocol.BLE_WIRE_FLAG_FIRST_FRAG.toInt()
            flags = flags or BleWireProtocol.BLE_WIRE_FLAG_LAST_FRAG.toInt()
            val packed =
                    K900ProtocolUtils.packBinaryFragment(
                            flags.toByte(),
                            0,
                            0,
                            1,
                            payload
                    )
            Bridge.log("LIVE: Sending BLE wire v2 handshake")
            wireHandshakeQueued = true
            wireHandshakeSentGeneration = wireSessionGeneration
            queueData(packed, null)
            // The handshake and its reply are fire-and-forget binary frames with no ACK
            // tracking; if either is lost, wireHandshakeQueued would block every future
            // attempt and the session would silently stay on the legacy string wire.
            // Re-arm after a grace period so negotiation can retry, bounded per session
            // so a peer that advertises binary but never answers doesn't get pinged
            // forever (later caps/version triggers may still retry explicitly).
            wireHandshakeAttempts++
            val scheduledGeneration = wireSessionGeneration
            handler.postDelayed(
                    {
                        if (scheduledGeneration == wireSessionGeneration &&
                                        wireHandshakeQueued &&
                                        peerWireProtocolVersion < BleWireProtocol.PROTOCOL_V2
                        ) {
                            Bridge.log(
                                    "LIVE: BLE wire v2 handshake unanswered after " +
                                            WIRE_HANDSHAKE_RETRY_GRACE_MS +
                                            "ms (attempt " +
                                            wireHandshakeAttempts +
                                            "/" +
                                            WIRE_HANDSHAKE_MAX_ATTEMPTS +
                                            ") - re-arming"
                            )
                            wireHandshakeQueued = false
                            if (wireHandshakeAttempts < WIRE_HANDSHAKE_MAX_ATTEMPTS) {
                                maybeSendWireHandshake()
                            }
                        }
                    },
                    WIRE_HANDSHAKE_RETRY_GRACE_MS
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send wire handshake", e)
        }
    }

    private fun activateBinaryWireV2Session(logMessage: String) {
        peerWireProtocolVersion = BleWireProtocol.PROTOCOL_V2
        useBinaryWireProtocol = true
        wireHandshakeQueued = false
        wireHandshakeAttempts = 0
        peerK900Le = true
        BleJsonCompact.markSessionConnected(System.currentTimeMillis())
        Bridge.log(logMessage)
    }

    private fun handlePeerWireHandshake() {
        if (wireHandshakeSentGeneration != wireSessionGeneration) {
            Bridge.log("LIVE: Ignoring wire v2 handshake reply from a previous session epoch")
            return
        }
        activateBinaryWireV2Session("LIVE: Peer confirmed BLE wire protocol v2")
    }

    private fun processBinaryWireFrame(data: ByteArray) {
        val info = K900ProtocolUtils.extractBinaryFragmentInfo(data) ?: run {
            Log.w(TAG, "Failed to parse binary wire frame")
            return
        }

        if (BleWireProtocol.isHandshakeV2(info)) {
            handlePeerWireHandshake()
            return
        }

        if (!useBinaryWireProtocol && buildNumberInt >= 5) {
            activateBinaryWireV2Session(
                    "LIVE: Auto-enabled BLE wire v2 from incoming binary frame"
            )
        }

        val reassembled =
                incomingChunkReassembler.addBinaryFragment(
                        info.msgId,
                        info.fragIdx,
                        info.fragCount,
                        info.payload
                )
                ?: return

        try {
            val jsonStr = String(reassembled, StandardCharsets.UTF_8)
            val json = expandCompactWireJson(JSONObject(jsonStr))
            if (json == null) {
                Log.w(TAG, "Rejected unsupported compact reassembled wire form")
                return
            }
            logWireMetrics(
                    reassembled.size,
                    data.size,
                    info.fragCount,
                    BleWireProtocol.PROTOCOL_V2,
                    "glasses_to_phone"
            )
            processJsonMessage(json)
        } catch (e: JSONException) {
            Log.e(TAG, "Failed to parse reassembled binary wire JSON", e)
        }
    }

    private fun compactWireJson(json: JSONObject): JSONObject {
        if (!useBinaryWireProtocol || buildNumberInt < 5) {
            return json
        }
        return try {
            BleJsonCompact.encode(json)
        } catch (_: JSONException) {
            json
        }
    }

    private fun expandCompactWireJson(json: JSONObject): JSONObject? {
        if (!useBinaryWireProtocol || buildNumberInt < 5) {
            return json
        }
        return try {
            BleJsonCompact.decodeIfSupported(json)
        } catch (_: JSONException) {
            json
        }
    }

    private fun logWireMetrics(
            payloadBytes: Int,
            wireBytes: Int,
            packetCount: Int,
            protocolVersion: Int,
            direction: String
    ) {
        Bridge.log(
                "BLE_TRACE direction=" +
                        direction +
                        " proto=v" +
                        protocolVersion +
                        " payload=" +
                        payloadBytes +
                        " wire=" +
                        wireBytes +
                        " packets=" +
                        packetCount
        )
    }

    /**
     * Send data directly to the glasses using the K900 protocol utility. This method uses
     * K900ProtocolUtils.packJsonToK900 to handle C-wrapping and protocol formatting. Large messages
     * are automatically chunked if they exceed the 400-byte threshold.
     *
     * @param data The string data to be sent to the glasses
     */
    fun sendDataToGlasses(data: String?, wakeup: Boolean) {
        sendDataToGlasses(data, wakeup, bleSessionGeneration.get())
    }

    private fun sendDataToGlasses(
            data: String?,
            wakeup: Boolean,
            sessionGeneration: Long
    ) {
        if (data == null || data.isEmpty()) {
            Log.e(TAG, "Cannot send empty data to glasses")
            return
        }
        if (sessionGeneration != bleSessionGeneration.get()) {
            Bridge.log("LIVE: Dropping send request from stale BLE session $sessionGeneration")
            return
        }

        val wireData =
                try {
                    if (useBinaryWireProtocol && buildNumberInt >= 5) {
                        compactWireJson(JSONObject(data)).toString()
                    } else {
                        data
                    }
                } catch (_: JSONException) {
                    data
                }

        try {
            val outgoingSummary = summarizeOutgoingMessage(wireData)
            val commandTraceInfo = parseOutgoingBleCommandTraceInfo(data)
            val isPhotoRequest = outgoingSummary.contains("type=take_photo")
            if (isPhotoRequest) {
                Bridge.log(
                        "LIVE: PHOTO PIPELINE BLE handoff — sendDataToGlasses() start, wakeup=" +
                                wakeup +
                                ", " +
                                outgoingSummary
                )
            }

            if (useBinaryWireProtocol && buildNumberInt >= 5) {
                sendDataToGlassesBinary(
                        wireData,
                        wakeup,
                        commandTraceInfo,
                        isPhotoRequest,
                        sessionGeneration
                )
                return
            }

            // First check if the message needs chunking
            // Create a test C-wrapped version to check size
            val testWrapper = JSONObject()
            testWrapper.put("C", wireData)
            if (wakeup) {
                testWrapper.put("W", 1)
            }
            val testWrappedJson = testWrapper.toString()

            // Check if chunking is needed
            if (MessageChunker.needsChunking(testWrappedJson)) {
                Bridge.log("LIVE: Message exceeds threshold, chunking required")
                if (isPhotoRequest) {
                    Bridge.log(
                            "LIVE: PHOTO PIPELINE BLE handoff — chunking enabled for request payload"
                    )
                }

                // Extract message ID if present for ACK tracking
                var messageId = -1L
                try {
                    val originalJson = JSONObject(wireData)
                    messageId = originalJson.optLong("mId", -1)
                } catch (e: JSONException) {
                    // Not a JSON message or no mId, that's okay
                }

                // Create chunks
                val chunks = MessageChunker.createChunks(wireData, messageId, wakeup)
                Bridge.log("LIVE: Sending " + chunks.size + " chunks")
                if (isPhotoRequest) {
                    Bridge.log(
                            "LIVE: PHOTO PIPELINE BLE handoff — created " +
                                    chunks.size +
                                    " chunks for transmission"
                    )
                }

                // Send each chunk
                for (i in 0 until chunks.size) {
                    val chunk = chunks[i]
                    val chunkStr = chunk.toString()

                    // Pack each chunk using the normal K900 protocol with the negotiated endianness
                    val packedData =
                            K900ProtocolUtils.packJsonToK900(
                                    chunkStr,
                                            wakeup && i == 0,
                                            k900LengthEndian()
                                    ) // Only wakeup on first chunk

                    val trace =
                            createBleWriteTrace(
                                    commandTraceInfo,
                                    chunk.optString("id", "").takeIf { it.isNotBlank() },
                                    chunk.optInt("c", i),
                                    chunk.optInt("n", chunks.size),
                                    chunk.optString("d", "")
                                            .toByteArray(StandardCharsets.UTF_8)
                                            .size,
                                    packedData.size,
                                    wakeup && i == 0,
                                    true
                            )
                    logBleChunkTrace(
                            "created",
                            trace,
                            mapOf(
                                    "chunkJsonBytes" to
                                            chunkStr.toByteArray(StandardCharsets.UTF_8).size,
                                    "messageBytes" to wireData.toByteArray(StandardCharsets.UTF_8).size
                            )
                    )

                    // Queue the chunk for sending
                    queueData(packedData, trace, sessionGeneration)

                    // Add small delay between chunks to avoid overwhelming the connection
                    if (i < chunks.size - 1) {
                        try {
                            Thread.sleep(50) // 50ms delay between chunks
                        } catch (e: InterruptedException) {
                            Log.w(TAG, "Interrupted during chunk delay")
                        }
                    }
                }

                Bridge.log("LIVE: All chunks queued for transmission")
                if (isPhotoRequest) {
                    Bridge.log("LIVE: PHOTO PIPELINE BLE handoff — all photo chunks queued")
                }
            } else {
                // Normal single message transmission
                Bridge.log("LIVE: Sending data to glasses: " + wireData)

                // Pack the data using the centralized utility with the negotiated endianness
                val packedData =
                        K900ProtocolUtils.packJsonToK900(wireData, wakeup, k900LengthEndian())
                val trace =
                        createBleWriteTrace(
                                commandTraceInfo,
                                null,
                                null,
                                null,
                                wireData.toByteArray(StandardCharsets.UTF_8).size,
                                packedData.size,
                                wakeup,
                                false
                        )
                logBleChunkTrace(
                        "created",
                        trace,
                        mapOf("messageBytes" to wireData.toByteArray(StandardCharsets.UTF_8).size)
                )

                // Queue the data for sending
                queueData(packedData, trace, sessionGeneration)
                if (isPhotoRequest) {
                    Bridge.log(
                            "LIVE: PHOTO PIPELINE BLE handoff — packedLen=" +
                                    packedData.size +
                                    " bytes queued"
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error creating data JSON", e)
        }
    }

    private fun sendDataToGlassesBinary(
            data: String,
            wakeup: Boolean,
            commandTraceInfo: OutgoingBleCommandTraceInfo,
            isPhotoRequest: Boolean,
            sessionGeneration: Long
    ) {
        val payloadBytes = data.toByteArray(StandardCharsets.UTF_8)
        var messageId = 0
        var ackRequested = false
        try {
            val originalJson = JSONObject(data)
            messageId = (originalJson.optLong("mId", 0L) and 0xFFFFL).toInt()
            ackRequested = originalJson.has("mId")
        } catch (_: JSONException) {
            // Raw non-JSON payloads are still sent as a single binary fragment.
        }

        val fragments =
                MessageChunker.createBinaryFragments(
                        payloadBytes,
                        messageId,
                        wakeup,
                        ackRequested
                )
        var totalWireBytes = 0
        for (i in fragments.indices) {
            val fragment = fragments[i]
            val packedData =
                    K900ProtocolUtils.packBinaryFragment(
                            fragment.flags,
                            fragment.msgId,
                            fragment.fragIdx,
                            fragment.fragCount,
                            fragment.payload
                    )
            totalWireBytes += packedData.size

            val trace =
                    createBleWriteTrace(
                            commandTraceInfo,
                            null,
                            fragment.fragIdx,
                            fragment.fragCount,
                            fragment.payload.size,
                            packedData.size,
                            wakeup && i == 0,
                            fragments.size > 1
                    )
            logBleChunkTrace(
                    "created",
                    trace,
                    mapOf(
                            "messageBytes" to payloadBytes.size,
                            "wireProtocol" to "v2"
                    )
            )
            queueData(packedData, trace, sessionGeneration)

            if (i < fragments.size - 1) {
                try {
                    Thread.sleep(50)
                } catch (e: InterruptedException) {
                    Log.w(TAG, "Interrupted during binary fragment delay")
                }
            }
        }

        logWireMetrics(
                payloadBytes.size,
                totalWireBytes,
                fragments.size,
                BleWireProtocol.PROTOCOL_V2,
                "phone_to_glasses"
        )

        if (isPhotoRequest) {
            Bridge.log(
                    "LIVE: PHOTO PIPELINE BLE handoff — binary v2 queued " +
                            fragments.size +
                            " fragments, wireBytes=" +
                            totalWireBytes
            )
        }
    }

    private fun parseOutgoingBleCommandTraceInfo(payload: String): OutgoingBleCommandTraceInfo {
        return try {
            val obj = JSONObject(payload)
            OutgoingBleCommandTraceInfo(
                    commandType = obj.optString("type", "unknown"),
                    requestId = optNonBlankString(obj, "requestId"),
                    appId = optNonBlankString(obj, "appId"),
                    messageId = if (obj.has("mId")) obj.optLong("mId") else null
            )
        } catch (_: Exception) {
            OutgoingBleCommandTraceInfo(
                    commandType = "unknown",
                    requestId = null,
                    appId = null,
                    messageId = null
            )
        }
    }

    private fun createBleWriteTrace(
            commandInfo: OutgoingBleCommandTraceInfo,
            chunkId: String?,
            chunkIndex: Int?,
            totalChunks: Int?,
            payloadBytes: Int?,
            packedBytes: Int,
            wakeup: Boolean,
            chunked: Boolean
    ): BleWriteTrace {
        return BleWriteTrace(
                sequence = bleWriteTraceSequence.getAndIncrement(),
                commandType = commandInfo.commandType,
                requestId = commandInfo.requestId,
                appId = commandInfo.appId,
                messageId = commandInfo.messageId,
                chunkId = chunkId,
                chunkIndex = chunkIndex,
                totalChunks = totalChunks,
                payloadBytes = payloadBytes,
                packedBytes = packedBytes,
                wakeup = wakeup,
                chunked = chunked,
                queuedAtMs = System.currentTimeMillis()
        )
    }

    private fun optNonBlankString(obj: JSONObject, key: String): String? {
        return obj.optString(key, "").takeIf { it.isNotBlank() }
    }

    private fun logBleChunkTrace(
            stage: String,
            trace: BleWriteTrace?,
            extra: Map<String, Any?> = emptyMap()
    ) {
        logBleTrace("sdk_ble_chunk", stage, trace, extra)
    }

    private fun logBleWriteTrace(
            stage: String,
            trace: BleWriteTrace?,
            extra: Map<String, Any?> = emptyMap()
    ) {
        logBleTrace("sdk_ble_write", stage, trace, extra)
    }

    private fun logBleTrace(
            layer: String,
            stage: String,
            trace: BleWriteTrace?,
            extra: Map<String, Any?> = emptyMap()
    ) {
        if (trace == null) {
            return
        }

        val warningReason = bleTraceWarningReason(stage, extra)
        if (warningReason == null) {
            return
        }

        try {
            val payload = mutableMapOf<String, Any>(
                    "level" to "warning",
                    "warningReason" to warningReason,
                    "stage" to stage,
                    "sequence" to trace.sequence,
                    "commandType" to trace.commandType,
                    "packedBytes" to trace.packedBytes,
                    "wakeup" to trace.wakeup,
                    "chunked" to trace.chunked,
                    "queuedAtMs" to trace.queuedAtMs
            )
            trace.requestId?.let { payload["requestId"] = it }
            trace.appId?.let { payload["appId"] = it }
            trace.messageId?.let { payload["messageId"] = it }
            trace.chunkId?.let { payload["chunkId"] = it }
            trace.chunkIndex?.let {
                payload["chunkIndex"] = it
                payload["chunkNumber"] = it + 1
            }
            trace.totalChunks?.let { payload["totalChunks"] = it }
            trace.payloadBytes?.let { payload["payloadBytes"] = it }
            extra.forEach { (key, value) ->
                if (value != null) {
                    payload[key] = value
                }
            }

            BleTraceLogger.logMap("phone_to_glasses", layer, trace.commandType, payload)
        } catch (e: Exception) {
            Log.d(TAG, "BLE trace logging failed for $layer/$stage", e)
        }
    }

    private fun bleTraceWarningReason(stage: String, extra: Map<String, Any?>): String? {
        if (extra["errorClass"] != null || extra["errorMessage"] != null) {
            return "ble_write_error"
        }
        if (extra["success"] == false) {
            return "ble_write_failed"
        }
        if (extra["writeAccepted"] == false) {
            return "ble_write_rejected"
        }

        if (traceLongAtLeast(extra["queueDelayMs"], SIGNIFICANT_BLE_TRACE_DELAY_MS)) {
            return "queue_delay"
        }
        if (traceLongAtLeast(extra["callbackDelayMs"], SIGNIFICANT_BLE_TRACE_DELAY_MS)) {
            return "write_callback_delay"
        }
        if (traceLongAtLeast(extra["remainingDelayMs"], SIGNIFICANT_BLE_TRACE_DELAY_MS)) {
            return "rate_limit_delay"
        }
        if (traceLongAtLeast(extra["nextProcessDelayMs"], SIGNIFICANT_BLE_TRACE_DELAY_MS)) {
            return "next_process_delay"
        }
        if (extra["retryDelayMs"].asTraceLong() != null) {
            return "write_retry"
        }
        if (stage == "queued" &&
                        traceIntAtLeast(extra["queueSizeAfterAdd"], SIGNIFICANT_BLE_TRACE_QUEUE_SIZE)
        ) {
            return "queue_depth"
        }
        return null
    }

    private fun traceLongAtLeast(value: Any?, threshold: Long): Boolean {
        return (value.asTraceLong() ?: Long.MIN_VALUE) >= threshold
    }

    private fun traceIntAtLeast(value: Any?, threshold: Int): Boolean {
        return (value.asTraceInt() ?: Int.MIN_VALUE) >= threshold
    }

    private fun Any?.asTraceLong(): Long? {
        return when (this) {
            is Number -> this.toLong()
            is String -> this.toLongOrNull()
            else -> null
        }
    }

    private fun Any?.asTraceInt(): Int? {
        return when (this) {
            is Number -> this.toInt()
            is String -> this.toIntOrNull()
            else -> null
        }
    }

    private fun summarizeOutgoingMessage(payload: String?): String {
        if (payload == null || payload.isEmpty()) {
            return "type=unknown, requestId=none, appId=none, mode=none, transferMethod=none, bleImgId=none, exposureTimeNs=none, iso=none, mId=none"
        }
        try {
            val obj = JSONObject(payload)
            val type = obj.optString("type", "unknown")
            val requestId = obj.optString("requestId", "none")
            val appId = obj.optString("appId", "none")
            val transferMethod = obj.optString("transferMethod", "none")
            val bleImgId = obj.optString("bleImgId", "none")
            val mode = if (obj.has("mode")) obj.optString("mode", "photo") else "none"
            val exposure =
                    if (obj.has("exposureTimeNs")) obj.optLong("exposureTimeNs").toString()
                    else "none"
            val iso = if (obj.has("iso")) obj.optInt("iso").toString() else "none"
            val mId = if (obj.has("mId")) obj.optLong("mId").toString() else "none"
            return "type=" +
                    type +
                    ", requestId=" +
                    requestId +
                    ", appId=" +
                    appId +
                    ", transferMethod=" +
                    transferMethod +
                    ", bleImgId=" +
                    bleImgId +
                    ", mode=" +
                    mode +
                    ", exposureTimeNs=" +
                    exposure +
                    ", iso=" +
                    iso +
                    ", mId=" +
                    mId
        } catch (ignored: JSONException) {
            return "type=non_json, payloadLen=" + payload.length
        }
    }

    fun sendStartVideoStream() {
        try {
            val command = JSONObject()
            command.put("type", "start_video_stream")
            sendJson(command, true)
        } catch (e: JSONException) {
            throw RuntimeException(e)
        }
    }

    fun sendStopVideoStream() {
        try {
            val command = JSONObject()
            command.put("type", "stop_video_stream")
            sendJson(command, true)
        } catch (e: JSONException) {
            throw RuntimeException(e)
        }
    }

    /**
     * Sends WiFi credentials to the smart glasses
     *
     * @param ssid The WiFi network name
     * @param password The WiFi password
     */
    override fun sendWifiCredentials(ssid: String, password: String) {
        Bridge.log("LIVE: 432432 Sending WiFi credentials to glasses - SSID: " + ssid)

        // Validate inputs
        if (ssid == null || ssid.isEmpty()) {
            Log.e(TAG, "Cannot set WiFi credentials - SSID is empty")
            return
        }

        try {
            // Send WiFi credentials to the ASG client
            val wifiCommand = JSONObject()
            wifiCommand.put("type", "set_wifi_credentials")
            wifiCommand.put("ssid", ssid)
            wifiCommand.put("password", if (password != null) password else "")
            sendJson(wifiCommand, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating WiFi credentials JSON", e)
        }
    }

    /** Disconnect from WiFi on the glasses */
    fun disconnectFromWifi() {
        Bridge.log("LIVE: 📶 Sending WiFi disconnect command to glasses")

        try {
            // Send WiFi disconnect command to the ASG client
            val wifiCommand = JSONObject()
            wifiCommand.put("type", "disconnect_wifi")
            sendJson(wifiCommand, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating WiFi disconnect JSON", e)
        }
    }

    /**
     * Forget a WiFi network on the glasses - removes cached credentials This sends the SSID so the
     * K900 SystemUI can properly clear the cached credentials
     */
    override fun forgetWifiNetwork(ssid: String) {
        Bridge.log("LIVE: 📶 Sending WiFi forget command for SSID: " + ssid)

        try {
            val wifiCommand = JSONObject()
            wifiCommand.put("type", "forget_wifi")
            wifiCommand.put("ssid", ssid)
            sendJson(wifiCommand, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating WiFi forget JSON", e)
        }
    }

    override fun sendHotspotState(enabled: Boolean) {
        Bridge.log("LIVE: 🔥 Sending hotspot state to glasses - enabled: " + enabled)
        try {
            // Send hotspot state command to the ASG client
            val hotspotCommand = JSONObject()
            hotspotCommand.put("type", "set_hotspot_state")
            hotspotCommand.put("enabled", enabled)
            sendJson(hotspotCommand, true)
            Bridge.log("LIVE: 🔥 ✅ Hotspot state command sent successfully")
        } catch (e: JSONException) {
            Log.e(TAG, "🔥 💥 Error creating hotspot state JSON", e)
        }
    }

    override fun sendWifiAdbState(enabled: Boolean) {
        Bridge.log("LIVE: 🔧 Sending Wi-Fi ADB state to glasses - enabled: " + enabled)
        try {
            val command = JSONObject()
            command.put("type", "set_wifi_adb_state")
            command.put("enabled", enabled)
            sendJson(command, true)
            Bridge.log("LIVE: 🔧 ✅ Wi-Fi ADB state command sent successfully")
        } catch (e: JSONException) {
            Log.e(TAG, "🔧 💥 Error creating Wi-Fi ADB state JSON", e)
        }
    }

    override fun sendSetSystemTime(timestampMs: Long) {
        Bridge.log("LIVE: ⏰ Sending set_system_time to glasses: " + timestampMs)
        try {
            val command = JSONObject()
            command.put("type", "set_system_time")
            command.put("timestamp_ms", timestampMs)
            sendJson(command, true)
        } catch (e: JSONException) {
            Log.e(TAG, "⏰ Error creating set_system_time JSON", e)
        }
    }

    /**
     * Sends user email to glasses for crash reporting identification
     *
     * @param email The user's email address
     */
    override fun sendUserEmailToGlasses(email: String) {
        Bridge.log("LIVE: Sending user email to glasses for crash reporting")

        if (email == null || email.isEmpty()) {
            Log.w(TAG, "Cannot send user email - email is empty")
            return
        }

        try {
            val emailCommand = JSONObject()
            emailCommand.put("type", "user_email")
            emailCommand.put("email", email)
            sendJson(emailCommand, true)
            Log.d(TAG, "User email sent to glasses successfully")
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating user email JSON", e)
        }
    }

    fun sendCustomCommand(commandJson: String) {
        Bridge.log("LIVE: Received custom command: " + commandJson)

        try {
            val json = JSONObject(commandJson)
            val type = json.optString("type", "")

            when (type) {
                "request_wifi_scan" -> requestWifiScan(null)
                "rgb_led_control_on", "rgb_led_control_off" -> {
                    // Forward LED control commands directly to glasses via BLE
                    Log.d(TAG, "💡 Forwarding LED control command to glasses: " + type)
                    sendJson(json, true)
                }
                else -> {
                    Log.w(
                            TAG,
                            "Unknown custom command type: " +
                                    type +
                                    " - attempting to forward to glasses"
                    )
                    // Forward unknown commands to glasses - they might handle them
                    sendJson(json, true)
                }
            }
        } catch (e: JSONException) {
            Log.e(TAG, "Error parsing custom command JSON", e)
        }
    }

    /** Send a JSON object to the glasses without ACK tracking (for non-critical messages) */
    private fun sendJsonWithoutAck(json: JSONObject?, wakeup: Boolean) {
        if (json != null) {
            val jsonStr = json.toString()
            Bridge.log("LIVE: 📤 Sending JSON without ACK tracking: " + jsonStr)
            sendDataToGlasses(jsonStr, wakeup)
        } else {
            Bridge.log("LIVE: Cannot send JSON to ASG, JSON is null")
        }
    }

    private fun sendJsonWithoutAck(json: JSONObject?) {
        sendJsonWithoutAck(json, false)
    }

    /**
     * Claim or release RGB LED control authority from BES chipset
     * @param claimControl true to claim control, false to release
     */
    private fun sendRgbLedControlAuthority(claimControl: Boolean) {
        try {
            val bodyData = JSONObject()
            bodyData.put("on", claimControl)

            val command = JSONObject()
            command.put("C", "android_control_led")
            command.put("V", 1)
            command.put("B", bodyData.toString())

            Bridge.log(
                    "LIVE: " +
                            (if (claimControl) "📍 Claiming" else "📍 Releasing") +
                            " RGB LED control authority"
            )
            sendJson(command, false)
            rgbLedAuthorityClaimed = claimControl
        } catch (e: JSONException) {
            Log.e(TAG, "Error building RGB LED authority command", e)
        }
    }

    /**
     * Send RGB LED control command to glasses Matches iOS implementation for cross-platform
     * consistency
     */
    override fun sendRgbLedControl(
            requestId: String,
            packageName: String?,
            action: String,
            color: String?,
            onDurationMs: Int,
            offDurationMs: Int,
            count: Int
    ) {
        if (!isConnected || !glassesReady) {
            Bridge.log("LIVE: Cannot handle RGB LED control - glasses not connected")
            Bridge.sendRgbLedControlResponse(requestId, false, "glasses_not_connected")
            return
        }

        if (!rgbLedAuthorityClaimed) {
            sendRgbLedControlAuthority(true)
        }

        try {
            val command = JSONObject()
            command.put("requestId", requestId)

            if (packageName != null && !packageName.isEmpty()) {
                command.put("packageName", packageName)
            }

            when (action) {
                "on" -> {
                    val ledIndex = ledIndexForColor(color)
                    command.put("type", "rgb_led_control_on")
                    command.put("led", ledIndex)
                    command.put("ontime", onDurationMs)
                    command.put("offtime", offDurationMs)
                    command.put("count", count)
                }
                "off" -> command.put("type", "rgb_led_control_off")
                else -> {
                    Bridge.log("LIVE: Unsupported RGB LED action: " + action)
                    Bridge.sendRgbLedControlResponse(requestId, false, "unsupported_action")
                    return
                }
            }

            Bridge.log("LIVE: 💡 Forwarding RGB LED command to glasses: " + command.toString())
            sendJson(command, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error building RGB LED command", e)
            Bridge.sendRgbLedControlResponse(requestId, false, "json_error")
        }
    }

    /** Convert color string to LED index Matches iOS implementation */
    private fun ledIndexForColor(color: String?): Int {
        if (color == null) return 0

        when (color.lowercase()) {
            "red" -> return 0
            "green" -> return 1
            "blue" -> return 2
            "orange" -> return 3
            "white" -> return 4
            else -> return 0
        }
    }

    /**
     * Get statistics about the message tracking system
     * @return String with tracking statistics
     */
    fun getMessageTrackingStats(): String {
        val stats = StringBuilder()
        stats.append("Message Tracking Stats:\n")
        stats.append("- Pending messages: ").append(pendingMessages.size).append("\n")
        stats.append("- Next message ID: ").append(messageIdCounter.get()).append("\n")
        stats.append("- ACK timeout: ").append(ACK_TIMEOUT_MS).append("ms\n")
        stats.append("- Max retries: ").append(MAX_RETRY_ATTEMPTS).append("\n")

        if (!pendingMessages.isEmpty()) {
            stats.append("- Pending message IDs: ")
            for (messageId in pendingMessages.keys) {
                val msg = pendingMessages[messageId]
                if (msg != null) {
                    stats.append(messageId).append("(retry:").append(msg.retryCount).append(") ")
                }
            }
        }

        return stats.toString()
    }

    // ---------------------------------------
    // File Transfer Methods
    // ---------------------------------------

    /** Keep file assembly ordered without blocking BLE callbacks or the Android main looper. */
    private fun enqueueFilePacket(packetInfo: K900ProtocolUtils.FilePacketInfo) {
        fileProcessingHandler.post { processFilePacket(packetInfo) }
    }

    /** Process a received file packet */
    private fun processFilePacket(packetInfo: K900ProtocolUtils.FilePacketInfo) {
        // Calculate total packets based on actual pack size (not hardcoded FILE_PACK_SIZE)
        val totalPackets =
                if (packetInfo.packSize > 0)
                        (packetInfo.fileSize + packetInfo.packSize - 1) / packetInfo.packSize
                else 1
        if (packetInfo.packIndex % FILE_PACKET_LOG_INTERVAL == 0 ||
                        packetInfo.packIndex == totalPackets - 1
        ) {
            Log.d(
                    TAG,
                    "File transfer ${packetInfo.fileName}: " +
                            "${packetInfo.packIndex + 1}/$totalPackets packets"
            )
        }

        // Check if this is a BLE photo transfer we're tracking
        // The filename might have an extension (.avif or .jpg), but we track by ID only
        var bleImgId = packetInfo.fileName
        val dotIndex = bleImgId.lastIndexOf('.')
        if (dotIndex > 0) {
            bleImgId = bleImgId.substring(0, dotIndex)
        }

        val incidentRelay = bleIncidentLogRelays[bleImgId]
        if (incidentRelay != null) {
            Bridge.log("LIVE: 📦 BLE incident log relay packet for: " + bleImgId)

            if (incidentRelay.session == null) {
                activeFileTransfers.remove(packetInfo.fileName)
                incidentRelay.session =
                        FileTransferSession(packetInfo.fileName, packetInfo.fileSize)
                incidentRelay.session!!.recalculateTotalPackets(packetInfo.packSize)
                Bridge.log(
                        "LIVE: 📦 Started BLE incident log transfer: " +
                                packetInfo.fileName +
                                " (" +
                                packetInfo.fileSize +
                                " bytes, " +
                                incidentRelay.session!!.totalPackets +
                                " packets, packSize=" +
                                packetInfo.packSize +
                                ")"
                )
            }

            val added = incidentRelay.session!!.addPacket(packetInfo.packIndex, packetInfo.data)

            if (added && incidentRelay.session!!.shouldCheckCompletion(packetInfo.packIndex)) {
                if (incidentRelay.session!!.isComplete) {
                    val payload = incidentRelay.session!!.assembleFile()
                    if (payload != null) {
                        uploadBleIncidentLogPayload(incidentRelay, packetInfo.fileName, payload)
                    } else {
                        sendTransferCompleteConfirmation(packetInfo.fileName, false)
                        // Keep relay entry so glasses can retry after transfer_complete:false.
                        incidentRelay.session = null
                    }
                } else {
                    val missingPackets = incidentRelay.session!!.getMissingPackets()
                    Log.e(
                            TAG,
                            "❌ BLE incident log transfer incomplete. Missing " +
                                    missingPackets.size +
                                    " packets: " +
                                    missingPackets
                    )
                    sendTransferCompleteConfirmation(packetInfo.fileName, false)
                    // Keep relay entry so glasses can retry after transfer_complete:false.
                    incidentRelay.session = null
                }
            }

            return
        }

        val photoTransfer = blePhotoTransfers[bleImgId]
        if (photoTransfer != null) {
            // This is a BLE photo transfer
            // Get or create session for this transfer
            if (photoTransfer.session == null) {
                photoTransfer.session =
                        FileTransferSession(packetInfo.fileName, packetInfo.fileSize)
                // Recalculate total packets based on actual pack size (handles variable MTU)
                photoTransfer.session!!.recalculateTotalPackets(packetInfo.packSize)
                Bridge.log(
                        "LIVE: 📦 Started BLE photo transfer: " +
                                packetInfo.fileName +
                                " (" +
                                packetInfo.fileSize +
                                " bytes, " +
                                photoTransfer.session!!.totalPackets +
                                " packets, packSize=" +
                                packetInfo.packSize +
                                ")"
                )
            }

            // Add packet to session
            val added = photoTransfer.session!!.addPacket(packetInfo.packIndex, packetInfo.data)

            // Check completion when final packet arrives or transfer is complete
            if (added && photoTransfer.session!!.shouldCheckCompletion(packetInfo.packIndex)) {
                if (photoTransfer.session!!.isComplete) {
                    // Transfer is complete - process successfully
                    val transferEndTime = System.currentTimeMillis()
                    val totalDuration = transferEndTime - photoTransfer.phoneStartTime
                    val bleTransferDuration =
                            if (photoTransfer.bleTransferStartTime > 0)
                                    (transferEndTime - photoTransfer.bleTransferStartTime)
                            else 0

                    Bridge.log("LIVE: ✅ BLE photo transfer complete: " + packetInfo.fileName)
                    Bridge.log(
                            "LIVE: ⏱️ Total duration (request to complete): " + totalDuration + "ms"
                    )
                    Bridge.log(
                            "LIVE: ⏱️ Glasses compression: " +
                                    photoTransfer.glassesCompressionDurationMs +
                                    "ms"
                    )
                    if (bleTransferDuration > 0) {
                        Bridge.log("LIVE: ⏱️ BLE transfer duration: " + bleTransferDuration + "ms")
                        Bridge.log(
                                "LIVE: 📊 Transfer rate: " +
                                        (packetInfo.fileSize * 1000 / bleTransferDuration) +
                                        " bytes/sec"
                        )
                    }

                    // Get complete image data (AVIF or JPEG)
                    val imageData = photoTransfer.session!!.assembleFile()
                    if (imageData != null) {
                        // Process and upload the photo
                        processAndUploadBlePhoto(photoTransfer, imageData)
                    }

                    // Send completion confirmation to glasses
                    sendTransferCompleteConfirmation(packetInfo.fileName, true)

                    // Clean up - use the bleImgId without extension
                    blePhotoTransfers.remove(bleImgId)
                } else {
                    // Final packet received but transfer incomplete - tell glasses to retry
                    val missingPackets = photoTransfer.session!!.getMissingPackets()
                    Log.e(
                            TAG,
                            "❌ BLE photo transfer incomplete after final packet. Missing " +
                                    missingPackets.size +
                                    " packets: " +
                                    missingPackets
                    )
                    Log.e(TAG, "❌ Telling glasses to retry entire transfer")

                    // Tell glasses transfer failed, they will retry. Keep the photo transfer
                    // entry so the retry still maps back to the original requestId.
                    sendTransferCompleteConfirmation(packetInfo.fileName, false)
                    photoTransfer.session = null
                }
            }

            return // Exit after handling BLE photo
        }

        // Regular file transfer (not a BLE photo)
        var session = activeFileTransfers[packetInfo.fileName]
        if (session == null) {
            // New file transfer
            session = FileTransferSession(packetInfo.fileName, packetInfo.fileSize)
            // Recalculate total packets based on actual pack size (handles variable MTU)
            session.recalculateTotalPackets(packetInfo.packSize)
            activeFileTransfers[packetInfo.fileName] = session

            Bridge.log(
                    "LIVE: 📦 Started new file transfer: " +
                            packetInfo.fileName +
                            " (" +
                            packetInfo.fileSize +
                            " bytes, " +
                            session.totalPackets +
                            " packets, packSize=" +
                            packetInfo.packSize +
                            ")"
            )
        }

        // Add packet to session
        val added = session.addPacket(packetInfo.packIndex, packetInfo.data)

        if (added) {
            // Check completion when final packet arrives or transfer is complete
            if (session.shouldCheckCompletion(packetInfo.packIndex)) {
                if (session.isComplete) {
                    // Transfer is complete - process successfully
                    Bridge.log("LIVE: 📦 File transfer complete: " + packetInfo.fileName)

                    // Assemble and save the file
                    val fileData = session.assembleFile()
                    if (fileData != null) {
                        saveReceivedFile(packetInfo.fileName, fileData, packetInfo.fileType)
                    }

                    // Send completion confirmation to glasses
                    sendTransferCompleteConfirmation(packetInfo.fileName, true)

                    // Remove from active transfers
                    activeFileTransfers.remove(packetInfo.fileName)
                } else {
                    // Final packet received but transfer incomplete - tell glasses to retry
                    val missingPackets = session.getMissingPackets()
                    Log.e(
                            TAG,
                            "❌ File transfer incomplete after final packet. Missing " +
                                    missingPackets.size +
                                    " packets: " +
                                    missingPackets
                    )
                    Log.e(
                            TAG,
                            "❌ Expected " +
                                    session.totalPackets +
                                    " packets, received FILE_READ notifications: " +
                                    fileReadNotificationCount
                    )
                    Log.e(TAG, "❌ Telling glasses to retry entire transfer")

                    // Tell glasses transfer failed, they will retry
                    sendTransferCompleteConfirmation(packetInfo.fileName, false)
                    activeFileTransfers.remove(packetInfo.fileName)
                }
            }
        } else {
            // Packet already received or invalid index
            Log.w(TAG, "📦 Duplicate or invalid packet: " + packetInfo.packIndex)
            // BES chip handles ACKs automatically
        }
    }

    /** Request missing packets from glasses */
    private fun requestMissingPackets(fileName: String, missingPackets: List<Int>) {
        if (missingPackets.isEmpty()) {
            Bridge.log(
                    "LIVE: ✅ No missing packets for " + fileName + " - should not have been called"
            )
            return
        }

        // Check if too many packets are missing (>50% = likely failure)
        val session = activeFileTransfers[fileName]
        if (session != null && missingPackets.size > session.totalPackets / 2) {
            Log.e(
                    TAG,
                    "❌ Too many missing packets (" +
                            missingPackets.size +
                            "/" +
                            session.totalPackets +
                            ") for " +
                            fileName +
                            " - treating as failed transfer"
            )

            // Send failure confirmation to glasses
            sendTransferCompleteConfirmation(fileName, false)

            // Clean up the failed session
            activeFileTransfers.remove(fileName)
            return
        }

        Bridge.log(
                "LIVE: 🔍 Requesting retransmission of " +
                        missingPackets.size +
                        " missing packets for " +
                        fileName +
                        ": " +
                        missingPackets
        )

        try {
            // Send missing packets request to glasses
            val request = JSONObject()
            request.put("type", "request_missing_packets")
            request.put("fileName", fileName)

            val missingArray = JSONArray()
            for (packetIndex in missingPackets) {
                missingArray.put(packetIndex)
            }
            request.put("missingPackets", missingArray)

            sendJson(request, true) // Wake up glasses for this request
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating missing packets request", e)
        }
    }

    /** Send transfer completion confirmation to glasses */
    private fun sendTransferCompleteConfirmation(fileName: String, success: Boolean) {
        try {
            val confirmation = JSONObject()
            confirmation.put("type", "transfer_complete")
            confirmation.put("fileName", fileName)
            confirmation.put("success", success)
            confirmation.put("timestamp", System.currentTimeMillis())

            Log.d(
                    TAG,
                    (if (success) "✅" else "❌") +
                            " Sending transfer completion confirmation for: " +
                            fileName +
                            " (success: " +
                            success +
                            ")"
            )
            sendJson(confirmation, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating transfer completion confirmation", e)
        }
    }

    /** Save received file to storage */
    private fun saveReceivedFile(fileName: String, fileData: ByteArray, fileType: Byte) {
        try {
            // Get or create the directory for saving files
            val dir = File(context!!.getExternalFilesDir(null), FILE_SAVE_DIR)
            if (!dir.exists()) {
                dir.mkdirs()
            }

            // Generate unique filename with timestamp
            val sdf = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
            val timestamp = sdf.format(Date())

            // Determine file extension based on type
            var extension = ""
            when (fileType) {
                K900ProtocolUtils.CMD_TYPE_PHOTO -> {
                    // For photos, try to preserve the original extension
                    val photoExtIndex = fileName.lastIndexOf('.')
                    if (photoExtIndex > 0) {
                        extension = fileName.substring(photoExtIndex)
                    } else {
                        extension = ".jpg" // Default to JPEG if no extension
                    }
                }
                K900ProtocolUtils.CMD_TYPE_VIDEO -> extension = ".mp4"
                K900ProtocolUtils.CMD_TYPE_AUDIO -> extension = ".wav"
                else -> {
                    // Try to get extension from original filename
                    val dotIndex = fileName.lastIndexOf('.')
                    if (dotIndex > 0) {
                        extension = fileName.substring(dotIndex)
                    }
                }
            }

            // Create unique filename
            var baseFileName = fileName
            if (baseFileName.contains(".")) {
                baseFileName = baseFileName.substring(0, baseFileName.lastIndexOf('.'))
            }
            val uniqueFileName = baseFileName + "_" + timestamp + extension

            // Save the file
            val file = File(dir, uniqueFileName)
            FileOutputStream(file).use { fos ->
                fos.write(fileData)
                fos.flush()

                Bridge.log("LIVE: 💾 Saved file: " + file.absolutePath)

                // Notify about the received file
                notifyFileReceived(file.absolutePath, fileType)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error saving received file: " + fileName, e)
        }
    }

    /** Notify listeners about received file */
    private fun notifyFileReceived(filePath: String, fileType: Byte) {
        // Create event based on file type
        val event = JSONObject()
        try {
            event.put("type", "file_received")
            event.put("filePath", filePath)
            event.put("fileType", String.format("0x%02X", fileType))
            event.put("timestamp", System.currentTimeMillis())

            // Emit event through data observable
            // if (dataObservable != null) {
            // dataObservable.onNext(event);
            // }

            // You could also post an EventBus event here if needed
            // EventBus.getDefault().post(new FileReceivedEvent(filePath, fileType));

        } catch (e: JSONException) {
            Log.e(TAG, "Error creating file received event", e)
        }
    }

    private fun uploadBleIncidentLogPayload(
            relay: BleIncidentLogRelay,
            fileName: String,
            jsonUtf8: ByteArray
    ) {
        val token = getCoreToken()
        IncidentLogBleUploadService.upload(relay.apiBaseUrl, relay.incidentId, token, jsonUtf8) {
                success,
                message ->
            Handler(Looper.getMainLooper()).post {
                if (success) {
                    Bridge.log(
                            "LIVE: ✅ Incident log BLE relay uploaded (" +
                                    relay.kind +
                                    "): " +
                                    relay.incidentId
                    )
                    bleIncidentLogRelays.remove(relay.fileBaseKey)
                } else {
                    Log.e(
                            TAG,
                            "❌ Incident log BLE relay upload failed (" +
                                    relay.kind +
                                    "): " +
                                    message
                    )
                    // Keep relay entry so glasses can retry after transfer_complete:false.
                    relay.session = null
                }
                sendTransferCompleteConfirmation(fileName, success)
            }
        }
    }

    /** Process and upload a BLE photo transfer */
    private fun processAndUploadBlePhoto(transfer: BlePhotoTransfer, imageData: ByteArray) {
        Bridge.log("LIVE: Processing BLE photo for upload. RequestId: " + transfer.requestId)
        val uploadStartTime = System.currentTimeMillis()

        // Save BLE photo locally for debugging/backup
        try {
            val dir = File(context!!.getExternalFilesDir(null), FILE_SAVE_DIR)
            if (!dir.exists()) {
                dir.mkdirs()
            }

            // BLE photos are ALWAYS AVIF format
            val fileName = "BLE_" + transfer.bleImgId + "_" + System.currentTimeMillis() + ".avif"
            val file = File(dir, fileName)

            FileOutputStream(file).use { fos ->
                fos.write(imageData)
                Bridge.log("LIVE: 💾 Saved BLE photo locally: " + file.absolutePath)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error saving BLE photo locally", e)
        }

        // Use BlePhotoUploadService to handle decoding and upload
        BlePhotoUploadService.processAndUploadPhoto(
                imageData,
                transfer.requestId,
                transfer.webhookUrl,
                transfer.authToken,
                object : BlePhotoUploadService.UploadCallback {
                    override fun onSuccess(requestId: String, responseBody: String?) {
                        val uploadDuration = System.currentTimeMillis() - uploadStartTime
                        val totalDuration = System.currentTimeMillis() - transfer.phoneStartTime

                        Bridge.log(
                                "LIVE: ✅ BLE photo uploaded successfully via phone relay for requestId: " +
                                        requestId
                        )
                        Bridge.log("LIVE: ⏱️ Upload duration: " + uploadDuration + "ms")
                        Bridge.log("LIVE: ⏱️ Total end-to-end duration: " + totalDuration + "ms")
                        sendPhotoTerminalSuccessResponse(
                                requestId,
                                transfer.webhookUrl,
                                responseBody
                        )
                    }

                    override fun onError(requestId: String, error: String?) {
                        val uploadDuration = System.currentTimeMillis() - uploadStartTime
                        Log.e(
                                TAG,
                                "❌ BLE photo upload failed for requestId: " +
                                        requestId +
                                        ", error: " +
                                        error
                        )
                        Log.e(TAG, "⏱️ Failed after: " + uploadDuration + "ms")
                        Bridge.sendPhotoError(
                                requestId,
                                "PHONE_UPLOAD_FAILED",
                                "BLE photo upload failed: " + error
                        )
                    }
                }
        )
    }

    private fun sendPhotoTerminalSuccessResponse(
            requestId: String,
            uploadUrl: String?,
            responseBody: String?
    ) {
        val event = HashMap<String, Any>()
        event["type"] = "photo_response"
        event["state"] = "success"
        event["success"] = true
        event["requestId"] = requestId
        event["uploadUrl"] = if (uploadUrl != null) uploadUrl else ""
        event["timestamp"] = System.currentTimeMillis()
        copyPhotoUploadResponseMetadata(event, responseBody)
        Bridge.sendPhotoResponse(event)
    }

    private fun copyPhotoUploadResponseMetadata(
            event: MutableMap<String, Any>,
            responseBody: String?
    ) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return
        }
        try {
            val response = JSONObject(responseBody)
            copyJsonField(event, response, "photoUrl")
            copyJsonField(event, response, "statusUrl")
            copyJsonField(event, response, "mimeType")
            copyJsonField(event, response, "contentType")
            copyJsonField(event, response, "bytes")
            copyJsonField(event, response, "size")
        } catch (e: JSONException) {
            Bridge.log("LIVE: BLE upload response body was not JSON metadata")
        }
    }

    @Throws(JSONException::class)
    private fun copyJsonField(event: MutableMap<String, Any>, response: JSONObject, key: String) {
        if (response.has(key) && !response.isNull(key)) {
            event[key] = response.get(key)
        }
    }

    /** Send photo upload success notification to glasses */
    private fun sendPhotoUploadSuccess(requestId: String) {
        try {
            val json = JSONObject()
            json.put("type", "photo_upload_result")
            json.put("requestId", requestId)
            json.put("success", true)

            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating photo upload success message", e)
        }
    }

    /** Send photo upload error notification to glasses */
    private fun sendPhotoUploadError(requestId: String, error: String) {
        try {
            val json = JSONObject()
            json.put("type", "photo_upload_result")
            json.put("requestId", requestId)
            json.put("success", false)
            json.put("error", error)

            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating photo upload error message", e)
        }
    }

    /**
     * Get the core authentication token. Reads from DeviceStore first (synced from JS via
     * BluetoothSdkModule.update), then falls back to SharedPreferences for backward compatibility.
     */
    private fun getCoreToken(): String {
        val fromStore = DeviceStore.get("bluetooth", "core_token")
        if (fromStore is String) {
            val token = fromStore
            if (token != null && !token.isEmpty()) {
                return token
            }
        }
        val prefs = context!!.getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE)
        val fromPrefs = prefs.getString(KEY_CORE_TOKEN, "")
        return if (fromPrefs != null) fromPrefs else ""
    }

    /** Send BLE transfer completion notification */
    private fun sendBleTransferComplete(requestId: String, bleImgId: String, success: Boolean) {
        try {
            val json = JSONObject()
            json.put("type", "ble_photo_transfer_complete")
            json.put("requestId", requestId)
            json.put("bleImgId", bleImgId)
            json.put("success", success)

            sendJson(json, true)
            Bridge.log("LIVE: Sent BLE transfer complete notification: " + json.toString())
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating BLE transfer complete message", e)
        }
    }

    /**
     * Send BLE MTU config to glasses so they can adjust file packet sizes. The BES2700 chip on the
     * glasses truncates packets to 253 bytes (256 MTU - 3 ATT header) regardless of negotiated MTU.
     * By sending the actual MTU, glasses can use smaller packet sizes that fit within this limit.
     */
    private fun sendBleMtuConfig(mtu: Int) {
        try {
            val json = JSONObject()
            json.put("type", "set_ble_mtu")
            json.put("mtu", mtu)

            sendJson(json, false)
            Bridge.log("LIVE: 📦 Sent BLE MTU config to glasses: " + mtu)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating BLE MTU config message", e)
        }
    }

    /** Send user settings to glasses after connection is established */
    private fun sendUserSettings() {
        Bridge.log("LIVE: [VIDEO_SYNC] Sending user settings to glasses on connection")

        // Send button video recording settings
        sendButtonVideoRecordingSettings()

        // Send button max recording time
        sendButtonMaxRecordingTime()

        // Send button photo settings
        sendButtonPhotoSettings()

        // Send camera FOV setting (K900 / Mentra Live)
        sendCameraFovSetting()

        // Send gallery mode state (camera app running status)
        sendGalleryMode()

        // Send glasses-side Voice Activity Detection setting.
        sendVoiceActivityDetectionSetting()

        // Send glasses-side loudness / Barrier gate setting.
        sendLoudnessGateSetting()
    }

    override fun sendVoiceActivityDetectionSetting() {
        val value = DeviceStore.get("bluetooth", "voice_activity_detection_enabled")
        val enabled =
                if (value is Boolean) value
                else BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED

        Bridge.log("LIVE: 🎤 Sending Voice Activity Detection setting to glasses: " + enabled)

        if (!isConnected) {
            Bridge.log("LIVE: Cannot send Voice Activity Detection setting - not connected")
            return
        }

        try {
            val body = JSONObject()
            body.put("type", VOICE_ACTIVITY_DETECTION_SWITCH_TYPE)
            body.put("switch", if (enabled) 1 else 0)

            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_swit")
            cmdObject.put("V", 1)
            cmdObject.put("B", body.toString())

            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            cmdObject.toString().toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            if (packedData == null) {
                Bridge.log("LIVE: Failed to pack Voice Activity Detection setting command")
                return
            }
            queueData(packedData)
            Bridge.sendVoiceActivityDetectionStatus(enabled)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating Voice Activity Detection setting command", e)
        }
    }

    override fun sendLoudnessGateSetting() {
        val value = DeviceStore.get("bluetooth", "loudness_gate_enabled")
        val enabled =
                if (value is Boolean) value
                else BluetoothSdkDefaults.LOUDNESS_GATE_ENABLED

        Bridge.log("LIVE: 🎚️ Sending loudness/Barrier gate setting to glasses: " + enabled)

        if (!isConnected) {
            Bridge.log("LIVE: Cannot send loudness gate setting - not connected")
            return
        }

        try {
            val body = JSONObject()
            body.put("type", LOUDNESS_GATE_SWITCH_TYPE)
            body.put("switch", if (enabled) 1 else 0)

            val cmdObject = JSONObject()
            cmdObject.put("C", "cs_swit")
            cmdObject.put("V", 1)
            cmdObject.put("B", body.toString())

            val packedData =
                    K900ProtocolUtils.packDataToK900(
                            cmdObject.toString().toByteArray(StandardCharsets.UTF_8),
                            K900ProtocolUtils.CMD_TYPE_STRING,
                            k900LengthEndian()
                    )
            if (packedData == null) {
                Bridge.log("LIVE: Failed to pack loudness gate setting command")
                return
            }
            queueData(packedData)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating loudness gate setting command", e)
        }
    }

    /** Send button photo settings to glasses, replaying all stored scan-tuning fields. */
    override fun sendButtonPhotoSettings() {
        val legacyZslMfnr =
            DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_zsl_mfnr") as Boolean?
        val size = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_size") as String?
        val mfnr =
            (DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_mfnr") as Boolean?)
                ?: legacyZslMfnr
        val zsl =
            (DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_zsl") as Boolean?)
                ?: legacyZslMfnr
        val noiseReduction = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_noise_reduction") as Boolean?
        val edgeEnhancement = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_edge_enhancement") as Boolean?
        val ispDigitalGain = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_isp_digital_gain") as Int?
        val ispAnalogGain = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_isp_analog_gain") as String?
        val aeExposureDivisor = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_ae_exposure_divisor") as Int?
        val isoCap = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_iso_cap") as Int?
        val compress = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_compress") as String?
        val sound = DeviceStore.get(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_sound") as Boolean?
        sendButtonPhotoSettings(
            null, size, mfnr, zsl, noiseReduction, edgeEnhancement,
            ispDigitalGain, ispAnalogGain, aeExposureDivisor, isoCap, compress, sound, false,
        )
    }

    /** Send camera FOV setting to glasses (K900 / Mentra Live). */
    override fun sendCameraFovSetting() {
        var fov = 118
        var roiPosition = 0
        try {
            val raw = DeviceStore.get("bluetooth", "camera_fov")
            if (raw is Map<*, *>) {
                @Suppress("UNCHECKED_CAST") val map = raw as Map<String, Any>
                val f = map["fov"]
                val r = map["roi_position"]
                if (f is Number) fov = f.toInt()
                if (r is Number) roiPosition = r.toInt()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read camera_fov from store, using defaults", e)
        }

        sendCameraFovSetting(null, fov, roiPosition)
    }

    fun sendCameraFovSetting(requestId: String?, fov: Int, roiPosition: Int) {
        Bridge.log("LIVE: Sending camera FOV setting: fov=" + fov + ", roiPosition=" + roiPosition)

        if (!isConnected) {
            Log.w(TAG, "Cannot send camera FOV setting - not connected")
            return
        }

        try {
            val json = JSONObject()
            json.put("type", "camera_fov_setting")
            if (requestId != null && !requestId.isEmpty()) {
                json.put("request_id", requestId)
            }
            val params = JSONObject()
            params.put("fov", fov)
            params.put("roi_position", roiPosition)
            json.put("params", params)
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating camera FOV setting message", e)
        }
    }

    fun sendCameraFovOverride(
        requestId: String,
        leaseId: String,
        fov: Int,
        roiPosition: Int,
        ttlMs: Int,
    ) {
        val json = JSONObject()
        json.put("type", "camera_fov_override")
        json.put("request_id", requestId)
        json.put(
            "params",
            JSONObject()
                .put("lease_id", leaseId)
                .put("fov", fov)
                .put("roi_position", roiPosition)
                .put("ttl_ms", ttlMs),
        )
        sendJson(json, true)
    }

    fun releaseCameraFovOverride(requestId: String, leaseId: String) {
        val json = JSONObject()
        json.put("type", "camera_fov_override_release")
        json.put("request_id", requestId)
        json.put("params", JSONObject().put("lease_id", leaseId))
        sendJson(json, true)
    }

    /**
     * Send camera tuning config (ANR / gain) to the glasses via the {@code camera_tuning_config}
     * command. The ASG client relays this as a {@code camconfig} broadcast to the camera HAL.
     *
     * @param requestId optional request ID echoed in the settings_ack response
     * @param anrOn     {@code true} = ANR enabled, {@code false} = ANR disabled
     * @param gainOn    {@code true} = stock gain params, {@code false} = pixsmart gain-off params
     */
    fun sendCameraTuningConfig(requestId: String?, anrOn: Boolean, gainOn: Boolean) {
        Bridge.log("LIVE: Sending camera tuning config: anr=$anrOn, gain=$gainOn")

        if (!isConnected) {
            Log.w(TAG, "Cannot send camera tuning config - not connected")
            return
        }

        try {
            val json = JSONObject()
            json.put("type", "camera_tuning_config")
            if (!requestId.isNullOrEmpty()) {
                json.put("request_id", requestId)
            }
            json.put("anr", anrOn)
            json.put("gain", gainOn)
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating camera tuning config message", e)
        }
    }

    /**
     * Send button max recording time to glasses Matches iOS MentraLive.swift
     * sendButtonMaxRecordingTime pattern
     */
    override fun sendButtonMaxRecordingTime() {
        val rawMinutes = DeviceStore.get("bluetooth", "button_max_recording_time")
        val minutes = if (rawMinutes is Number) rawMinutes.toInt() else 10
        sendButtonMaxRecordingTime(null, minutes)
    }

    fun sendButtonMaxRecordingTime(requestId: String?, minutes: Int) {
        Bridge.log("LIVE: Sending button max recording time")

        if (!isConnected) {
            Bridge.log("LIVE: Cannot send button max recording time - not connected")
            return
        }

        try {
            val json = JSONObject()
            json.put("type", "button_max_recording_time")
            if (requestId != null && !requestId.isEmpty()) {
                json.put("request_id", requestId)
            }
            json.put("minutes", minutes)
            sendJson(json, true)
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating button max recording time message", e)
        }
    }

    override fun startVideoRecording(
            requestId: String,
            save: Boolean,
            sound: Boolean
    ) {
        startVideoRecording(requestId, save, sound, 0, 0, 0, 0) // Use defaults
    }

    /**
     * Start video recording with optional resolution settings
     * @param requestId Request ID for tracking
     * @param save Whether to save the video
     * @param sound Whether to enable start/stop sounds
     * @param width Video width (0 for default)
     * @param height Video height (0 for default)
     * @param fps Video frame rate (0 for default)
     * @param maxRecordingTimeMinutes Auto-stop timer in minutes (0 = record until stopped)
     */
    override fun startVideoRecording(
            requestId: String,
            save: Boolean,
            sound: Boolean,
            width: Int,
            height: Int,
            fps: Int,
            maxRecordingTimeMinutes: Int
    ) {
        Bridge.log(
                "LIVE: Starting video recording: requestId=" +
                        requestId +
                        ", save=" +
                        save +
                        ", sound=" +
                        sound +
                        ", resolution=" +
                        width +
                        "x" +
                        height +
                        "@" +
                        fps +
                        "fps" +
                        ", maxRecordingTimeMinutes=" +
                        maxRecordingTimeMinutes
        )

        if (!isConnected) {
            Log.w(TAG, "Cannot start video recording - not connected")
            return
        }

        try {
            val json = JSONObject()
            json.put("type", "start_video_recording")
            json.put("requestId", requestId)
            json.put("save", save)
            json.put("sound", sound)

            // Auto-stop timer; only sent when set (> 0). 0 = record until stopped.
            if (maxRecordingTimeMinutes > 0) {
                json.put("maxRecordingTimeMinutes", maxRecordingTimeMinutes)
            }

            // Add video settings when any field is overridden. Each field is sent
            // only when > 0; the glasses merge the missing fields onto their saved
            // button-video defaults, so a partial override (e.g. fps-only) still
            // takes effect instead of being dropped here.
            if (width > 0 || height > 0 || fps > 0) {
                val settings = JSONObject()
                if (width > 0) settings.put("width", width)
                if (height > 0) settings.put("height", height)
                if (fps > 0) settings.put("fps", fps)
                json.put("settings", settings)
            }

            sendJson(json, true) // Wake up glasses for this command
        } catch (e: JSONException) {
            Log.e(TAG, "Failed to create start video recording command", e)
        }
    }

    override fun stopVideoRecording(requestId: String) {
        stopVideoRecording(requestId, null, null)
    }

    override fun stopVideoRecording(requestId: String, webhookUrl: String?, authToken: String?) {
        Bridge.log(
                "LIVE: Stopping video recording: requestId=" +
                        requestId +
                        ", webhook=" +
                        (if (webhookUrl.isNullOrEmpty()) "none" else "set")
        )

        if (!isConnected) {
            Log.w(TAG, "Cannot stop video recording - not connected")
            return
        }

        try {
            val json = JSONObject()
            json.put("type", "stop_video_recording")
            json.put("requestId", requestId)
            // Webhook upload target, supplied at stop so the token is fresh.
            // Only sent when present; empty webhook = keep video on device.
            if (!webhookUrl.isNullOrEmpty()) {
                json.put("webhookUrl", webhookUrl)
            }
            if (!authToken.isNullOrEmpty()) {
                json.put("authToken", authToken)
            }
            sendJson(json, true) // Wake up glasses for this command
        } catch (e: JSONException) {
            Log.e(TAG, "Failed to create stop video recording command", e)
        }
    }

    /**
     * Process incoming LC3 audio packet from the glasses. Packet Structure: Byte 0: 0xF1 (Audio
     * data identifier) Byte 1: Sequence number (0-255) Bytes 2-401: LC3 encoded audio data (400
     * bytes - 10 frames × 40 bytes per frame)
     */
    private fun processLc3AudioPacket(data: ByteArray?) {
        // Bridge.log("LIVE: Processing LC3 audio packet: " + data.length + " bytes");

        if (data == null || data.size < 2) {
            Log.w(TAG, "Invalid LC3 audio packet received: too short")
            return
        }

        // Check for audio packet header
        if (data[0] == 0xF1.toByte()) {
            // Bridge.log("LIVE: Valid LC3 audio packet received");
            val sequenceNumber = data[1]
            val receiveTime = System.currentTimeMillis()

            // Basic sequence validation
            if (lastReceivedLc3Sequence != (-1).toByte() &&
                            (lastReceivedLc3Sequence + 1).toByte() != sequenceNumber
            ) {
                Log.w(
                        TAG,
                        "LC3 packet sequence mismatch. Expected: " +
                                (lastReceivedLc3Sequence + 1) +
                                ", Got: " +
                                sequenceNumber
                )
            }
            lastReceivedLc3Sequence = sequenceNumber

            val lc3Data = Arrays.copyOfRange(data, 2, data.size)

            // Enhanced LC3 packet logging and saving
            logLc3PacketDetails(lc3Data, sequenceNumber, receiveTime)
            // saveLc3AudioPacket(lc3Data, sequenceNumber);

            // Bridge.log("LIVE: Received LC3 audio packet seq=" + sequenceNumber + ", size=" +
            // lc3Data.length);

            // Forward raw LC3 to DeviceManager (matches iOS behavior)
            // MentraLive uses 40-byte LC3 frames
            DeviceManager.getInstance().handleGlassesMicData(lc3Data, LC3_FRAME_SIZE)

            // Bridge.log("LIVE: 🔊 Audio playback enabled: " + audioPlaybackEnabled);
            // } else {
            // Log.w(TAG, "No audio processing callback registered - audio data will not be
            // processed");
            // }

            // Play LC3 audio directly through LC3 player if enabled
            // This allows monitoring of the glasses microphone in real-time
            if (audioPlaybackEnabled && lc3AudioPlayer != null) {
                // log 1/50th of the time:
                if (Math.random() < 0.02) {
                    Bridge.log(
                            "LIVE: 🔊 Playing LC3 audio through phone speakers: " +
                                    data.size +
                                    " bytes"
                    )
                }
                // The data array already contains the full packet with F1 header and sequence
                // Just pass it directly to the LC3 player
                lc3AudioPlayer!!.write(data, 0, data.size)
                // Bridge.log("LIVE: 🔊 Playing LC3 audio through phone speakers: " + data.length +
                // " bytes");
            } else if (!audioPlaybackEnabled) {
                // Audio playback is disabled - only processing for PCM conversion
                // Bridge.log("LIVE: 🔇 Audio playback disabled - processing for PCM only");
            }
        } else {
            Bridge.log("LIVE: ⚠️ Received non-audio packet on LC3 characteristic.")
        }
    }

    /**
     * Sends an LC3 audio packet to the glasses.
     * @param lc3Data The raw LC3 encoded audio data (e.g., 400 bytes - 10 frames × 40 bytes per
     * frame).
     */
    fun sendLc3AudioPacket(lc3Data: ByteArray?) {
        if (lc3WriteCharacteristic == null) {
            Log.w(TAG, "Cannot send LC3 audio packet, characteristic not available.")
            return
        }
        if (lc3Data == null || lc3Data.isEmpty()) {
            Log.w(TAG, "Cannot send empty LC3 data.")
            return
        }

        // Packet Structure: Header (1) + Sequence (1) + Data (N)
        val packet = ByteArray(lc3Data.size + 2)
        packet[0] = 0xF1.toByte() // Audio data identifier
        packet[1] = lc3SequenceNumber++ // Sequence number

        System.arraycopy(lc3Data, 0, packet, 2, lc3Data.size)

        // We use queueData to handle rate-limiting and sending
        queueData(packet)
    }

    /** Initialize LC3 audio logging and file saving */
    private fun initializeLc3Logging() {
        if (!LC3_LOGGING_ENABLED) {
            return
        }

        try {
            // Create logs directory
            val logsDir = File(context!!.getExternalFilesDir(null), LC3_LOG_DIR)
            Bridge.log("LIVE: 🎯 Attempting to create LC3 logs directory: " + logsDir.absolutePath)

            if (!logsDir.exists()) {
                val created = logsDir.mkdirs()
                if (created) {
                    Log.i(TAG, "✅ Successfully created LC3 logs directory: " + logsDir.absolutePath)
                } else {
                    Log.e(TAG, "❌ Failed to create LC3 logs directory: " + logsDir.absolutePath)
                    // Try to get more info about why it failed
                    val parentDir = logsDir.parentFile
                    if (parentDir != null) {
                        Log.e(
                                TAG,
                                "📁 Parent directory exists: " +
                                        parentDir.exists() +
                                        ", writable: " +
                                        parentDir.canWrite()
                        )
                    }
                    return // Exit early if directory creation fails
                }
            } else {
                Log.i(TAG, "✅ LC3 logs directory already exists: " + logsDir.absolutePath)
            }

            // Create new audio file with timestamp
            val timestamp = lc3TimestampFormat.format(Date())
            currentLc3FileName = "lc3_audio_" + timestamp + ".raw"
            val audioFile = File(logsDir, currentLc3FileName)

            lc3AudioFileStream = FileOutputStream(audioFile)

            // Reset statistics
            totalLc3PacketsReceived = 0
            totalLc3BytesReceived = 0
            firstLc3PacketTime = System.currentTimeMillis()
            lastLc3PacketTime = firstLc3PacketTime

            Log.i(TAG, "🎵 LC3 Audio logging initialized - File: " + currentLc3FileName)
            Log.i(TAG, "📁 LC3 logs directory: " + logsDir.absolutePath)
        } catch (e: Exception) {
            Log.e(TAG, "❌ Failed to initialize LC3 audio logging", e)
        }
    }

    /** Save LC3 audio packet to file */
    private fun saveLc3AudioPacket(lc3Data: ByteArray, sequenceNumber: Byte) {
        Bridge.log("LIVE: 🎵 Saving LC3 audio packet to file: " + lc3Data.size + " bytes")
        if (!LC3_SAVING_ENABLED || lc3AudioFileStream == null) {
            Bridge.log("LIVE: 🎵 LC3 audio saving disabled or file stream not initialized")
            return
        }

        // Log the current file path for debugging
        if (currentLc3FileName != null) {
            val logsDir = File(context!!.getExternalFilesDir(null), LC3_LOG_DIR)
            val fullPath = File(logsDir, currentLc3FileName).absolutePath
            Log.i(TAG, "📁 LC3 Audio file path #####: " + fullPath)
        } else {
            Log.i(TAG, "📁 LC3 Audio file path for saving failed %%%%%%%: " + currentLc3FileName)
        }

        try {
            // Write packet header: [timestamp][sequence][length][data]
            val timestamp = System.currentTimeMillis()
            val timeStr = lc3PacketTimestampFormat.format(Date(timestamp))

            // Write timestamp and metadata
            val header =
                    String.format("[%s] SEQ:%d LEN:%d\n", timeStr, sequenceNumber, lc3Data.size)
            lc3AudioFileStream!!.write(header.toByteArray(StandardCharsets.UTF_8))

            // Write raw LC3 data
            lc3AudioFileStream!!.write(lc3Data)
            lc3AudioFileStream!!.write('\n'.code) // Newline separator

            lc3AudioFileStream!!.flush()
        } catch (e: Exception) {
            Log.e(TAG, "❌ Failed to save LC3 audio packet", e)
        }
    }

    /** Log detailed LC3 packet information */
    private fun logLc3PacketDetails(data: ByteArray, sequenceNumber: Byte, receiveTime: Long) {
        if (!LC3_LOGGING_ENABLED) {
            return
        }

        // Update statistics
        totalLc3PacketsReceived++
        totalLc3BytesReceived += data.size
        lastLc3PacketTime = receiveTime

        if (firstLc3PacketTime == 0L) {
            firstLc3PacketTime = receiveTime
        }

        // Calculate packet timing
        val timeSinceFirst = receiveTime - firstLc3PacketTime
        val timeSinceLast = receiveTime - lastLc3PacketTime

        // Log detailed packet information
        // Log.i(TAG, String.format("🎵 LC3 PACKET #%d RECEIVED:", sequenceNumber));
        // Log.i(TAG, String.format("   📊 Size: %d bytes", data.length));
        // Log.i(TAG, String.format("   ⏰ Time: %s", lc3PacketTimestampFormat.format(new
        // Date(receiveTime))));
        // Log.i(TAG, String.format("   ⏱️  Since first: +%dms", timeSinceFirst));
        // Log.i(TAG, String.format("   ⏱️  Since last: +%dms", timeSinceLast));
        // Log.i(TAG, String.format("   📈 Total packets: %d", totalLc3PacketsReceived));
        // Log.i(TAG, String.format("   📈 Total bytes: %d", totalLc3BytesReceived));

        // Log first few bytes for debugging
        if (data.isNotEmpty()) {
            val hexDump = StringBuilder("   🔍 First 16 bytes: ")
            for (i in 0 until Math.min(16, data.size)) {
                hexDump.append(String.format("%02X ", data[i].toInt() and 0xFF))
            }
            // Log.d(TAG, hexDump.toString());
        }

        // Log packet statistics every 10 packets
        if (totalLc3PacketsReceived % 10 == 0) {
            val duration = lastLc3PacketTime - firstLc3PacketTime
            val packetsPerSecond =
                    if (duration > 0) (totalLc3PacketsReceived * 1000.0) / duration else 0.0
            val bytesPerSecond =
                    if (duration > 0) (totalLc3BytesReceived * 1000.0) / duration else 0.0

            // Log.i(TAG, String.format("📊 LC3 STATS UPDATE:"));
            // Log.i(TAG, String.format("   🎯 Packets/sec: %.2f", packetsPerSecond));
            // Log.i(TAG, String.format("   🎯 Bytes/sec: %.2f", bytesPerSecond));
            // Log.i(TAG, String.format("   🎯 Average packet size: %.1f bytes",
            //     totalLc3PacketsReceived > 0 ? (double) totalLc3BytesReceived /
            // totalLc3PacketsReceived : 0));
        }
    }

    /** Close LC3 audio logging and save final statistics */
    private fun closeLc3Logging() {
        if (lc3AudioFileStream != null) {
            try {
                // Write final statistics to file
                if (totalLc3PacketsReceived > 0) {
                    val duration = lastLc3PacketTime - firstLc3PacketTime
                    val packetsPerSecond =
                            if (duration > 0) (totalLc3PacketsReceived * 1000.0) / duration else 0.0
                    val bytesPerSecond =
                            if (duration > 0) (totalLc3BytesReceived * 1000.0) / duration else 0.0

                    var stats = String.format("\n=== LC3 AUDIO SESSION STATISTICS ===\n")
                    stats += String.format("Total packets received: %d\n", totalLc3PacketsReceived)
                    stats += String.format("Total bytes received: %d\n", totalLc3BytesReceived)
                    stats += String.format("Session duration: %d ms\n", duration)
                    stats += String.format("Average packets/sec: %.2f\n", packetsPerSecond)
                    stats += String.format("Average bytes/sec: %.2f\n", bytesPerSecond)
                    stats +=
                            String.format(
                                    "Average packet size: %.1f bytes\n",
                                    totalLc3BytesReceived.toDouble() / totalLc3PacketsReceived
                            )
                    stats += String.format("Session ended: %s\n", lc3TimestampFormat.format(Date()))
                    stats += "==========================================\n"

                    lc3AudioFileStream!!.write(stats.toByteArray(StandardCharsets.UTF_8))
                }

                lc3AudioFileStream!!.close()
                lc3AudioFileStream = null

                Log.i(
                        TAG,
                        "🎵 LC3 Audio logging closed - Final stats written to: " +
                                currentLc3FileName
                )
                Log.i(
                        TAG,
                        String.format(
                                "📊 Final Statistics: %d packets, %d bytes, %.2f packets/sec",
                                totalLc3PacketsReceived,
                                totalLc3BytesReceived,
                                if (totalLc3PacketsReceived > 0)
                                        (totalLc3PacketsReceived * 1000.0) /
                                                (lastLc3PacketTime - firstLc3PacketTime)
                                else 0.0
                        )
                )
            } catch (e: Exception) {
                Log.e(TAG, "❌ Error closing LC3 audio logging", e)
            }
        }
    }

    /** Public method to manually initialize LC3 logging (for testing/debugging) */
    fun manualInitializeLc3Logging() {
        Log.i(TAG, "🔧 Manual LC3 logging initialization requested")
        initializeLc3Logging()
    }

    /** Get current LC3 logging statistics */
    fun getLc3LoggingStats(): String {
        if (totalLc3PacketsReceived == 0) {
            return "No LC3 packets received yet"
        }

        val duration = lastLc3PacketTime - firstLc3PacketTime
        val packetsPerSecond =
                if (duration > 0) (totalLc3PacketsReceived * 1000.0) / duration else 0.0
        val bytesPerSecond = if (duration > 0) (totalLc3BytesReceived * 1000.0) / duration else 0.0

        return String.format(
                "LC3 Stats: %d packets, %d bytes, %.2f packets/sec, %.2f bytes/sec, avg size: %.1f bytes",
                totalLc3PacketsReceived,
                totalLc3BytesReceived,
                packetsPerSecond,
                bytesPerSecond,
                totalLc3BytesReceived.toDouble() / totalLc3PacketsReceived
        )
    }

    /** Get the current LC3 log file path */
    fun getCurrentLc3LogFilePath(): String {
        if (currentLc3FileName == null) {
            return "No LC3 log file active"
        }
        val logsDir = File(context!!.getExternalFilesDir(null), LC3_LOG_DIR)
        return File(logsDir, currentLc3FileName).absolutePath
    }

    /** List all LC3 log files with their sizes */
    fun listAllLc3LogFiles(): String {
        try {
            val logsDir = File(context!!.getExternalFilesDir(null), LC3_LOG_DIR)
            if (!logsDir.exists()) {
                return "LC3 logs directory does not exist"
            }

            val files = logsDir.listFiles { dir, name -> name.endsWith(".raw") }
            if (files == null || files.isEmpty()) {
                return "No LC3 log files found"
            }

            val result = StringBuilder("LC3 Log Files:\n")
            for (file in files) {
                val sizeKB = file.length() / 1024
                result.append(String.format("  📄 %s (%d KB)\n", file.name, sizeKB))
            }
            return result.toString()
        } catch (e: Exception) {
            return "Error listing LC3 log files: " + e.message
        }
    }
}
