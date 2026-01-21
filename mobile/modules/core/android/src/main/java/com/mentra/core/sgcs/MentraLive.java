package com.mentra.core.sgcs;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothA2dp;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.ActivityCompat;
// import androidx.preference.PreferenceManager;

// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ButtonPressEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesGalleryStatusEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchStopEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesWifiScanResultEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesWifiStatusChange;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHotspotStatusChange;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.KeepAliveAckEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.RtmpStreamStatusEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesVersionInfoEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.DownloadProgressEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.InstallationProgressEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.PairFailureEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ImuDataEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ImuGestureEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.isMicEnabledForFrontendEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.MessageChunker;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.BlePhotoUploadService;
// import com.augmentos.smartglassesmanager.cpp.L3cCpp;
// import com.augmentos.augmentos_core.audio.Lc3Player;

// Mentra
import com.mentra.core.sgcs.SGCManager;
import com.mentra.core.CoreManager;
import com.mentra.core.Bridge;
import com.mentra.core.utils.DeviceTypes;
import com.mentra.core.utils.ConnTypes;
import com.mentra.core.utils.BitmapJavaUtils;
import com.mentra.core.utils.SmartGlassesConnectionState;
import com.mentra.core.utils.K900ProtocolUtils;
import com.mentra.core.utils.MessageChunker;
import com.mentra.core.utils.audio.Lc3Player;
import com.mentra.core.utils.BlePhotoUploadService;

// old augmentos imports:
import com.mentra.lc3Lib.Lc3Cpp;
import com.mentra.core.utils.audio.Lc3Player;



import org.greenrobot.eventbus.EventBus;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;
import java.util.HashSet;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.lang.reflect.Method;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.Random;
import java.security.SecureRandom;
import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

// import io.reactivex.rxjava3.subjects.PublishSubject;

/**
 * Smart Glasses Communicator for Mentra Live (K900) glasses
 * Uses BLE to communicate with the glasses
 *
 * Note: Mentra Live glasses have no display capabilities, only camera and microphone.
 * All display-related methods are stubbed out and will log a message but not actually display anything.
 */
public class MentraLive extends SGCManager {
    private static final String TAG = "Live";
    public String savedDeviceName = "";

    // LC3 frame size for Mentra Live
    private static final int LC3_FRAME_SIZE = 40;

    // Local-only fields (not in parent SGCManager)
    private int glassesBuildNumberInt = 0; // Build number as integer for version checks
    // Note: glassesAppVersion, glassesBuildNumber, glassesDeviceModel, glassesAndroidVersion
    // are inherited from SGCManager parent class

    // Version info chunking support (for MTU workaround)
    // Glasses send version_info in 2 chunks to fit within BLE MTU limits
    private JSONObject pendingVersionInfoChunk1 = null; // Stores chunk 1 until chunk 2 arrives

    // BLE UUIDs - updated to match K900 BES2800 MCU UUIDs for compatibility with both glass types
    // CRITICAL FIX: Swapped TX and RX UUIDs to match actual usage from central device perspective
    // In BLE, characteristic names are from the perspective of the device that owns them:
    // - From peripheral's perspective: TX is for sending, RX is for receiving
    // - From central's perspective: RX is peripheral's TX, TX is peripheral's RX
    private static final UUID SERVICE_UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb");
    //000070FF-0000-1000-8000-00805f9b34fb
    private static final UUID RX_CHAR_UUID = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb"); // Central receives on peripheral's TX
    private static final UUID TX_CHAR_UUID = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb"); // Central transmits on peripheral's RX
    private static final UUID CLIENT_CHARACTERISTIC_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // BES => PHONE
    private static final UUID FILE_READ_UUID = UUID.fromString("000072FF-0000-1000-8000-00805f9b34fb");
    private static final UUID FILE_WRITE_UUID = UUID.fromString("000073FF-0000-1000-8000-00805f9b34fb");

    private static final UUID LC3_READ_UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID LC3_WRITE_UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");

    // Reconnection parameters
    private static final int BASE_RECONNECT_DELAY_MS = 500; // Start with 0.5 seconds (faster initial retry)
    private static final int MAX_RECONNECT_DELAY_MS = 20000; // Max 20 seconds (more aggressive)
    private static final int MAX_RECONNECT_ATTEMPTS = 20; // Increased from 10 for better persistence
    private static final int RECONNECT_SCAN_TIMEOUT_MS = 10000; // 10 seconds for reconnection scans (faster than 60s default)
    private int reconnectAttempts = 0;
    private boolean isReconnecting = false; // Track if we're in reconnection mode

    // Keep-alive parameters
    private static final int KEEP_ALIVE_INTERVAL_MS = 5000; // 5 seconds
    private static final int CONNECTION_TIMEOUT_MS = 10000; // 10 seconds

    // Heartbeat parameters
    private static final int HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
    private static final int BATTERY_REQUEST_EVERY_N_HEARTBEATS = 10; // Every 10 heartbeats (5 minutes)

    // Micbeat parameters - periodically enable custom audio TX
    private static final long MICBEAT_INTERVAL_MS = (1000 * 60) * 30; // micbeat every 30 minutes

    // Device settings
    private static final String PREFS_NAME = "MentraLivePrefs";
    private static final String PREF_DEVICE_NAME = "LastConnectedDeviceName";

    // Auth settings
    private static final String AUTH_PREFS_NAME = "augmentos_auth_prefs";
    private static final String KEY_CORE_TOKEN = "core_token";

    // State tracking
    private Context context;
    // private PublishSubject<JSONObject> dataObservable;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bluetoothScanner;
    private BluetoothGatt bluetoothGatt;
    private BluetoothDevice connectedDevice;
    private BluetoothGattCharacteristic txCharacteristic;
    private BluetoothGattCharacteristic rxCharacteristic;
    private BluetoothGattCharacteristic lc3ReadCharacteristic;
    private BluetoothGattCharacteristic lc3WriteCharacteristic;
    private Handler handler = new Handler(Looper.getMainLooper());
    private ScheduledExecutorService scheduler;
    private boolean isScanning = false;
    private boolean isConnecting = false;
    private boolean isKilled = false;

    // CTKD (Cross-Transport Key Derivation) support for BES devices
    private boolean isBondingReceiverRegistered = false;
    private boolean isBtClassicConnected = false;
    private BroadcastReceiver bondingReceiver;

    // A2DP profile connection for already-bonded devices
    private BluetoothA2dp a2dpProfile = null;
    private boolean isA2dpProxyRegistered = false;

    private ConcurrentLinkedQueue<byte[]> sendQueue = new ConcurrentLinkedQueue<>();
    private Runnable connectionTimeoutRunnable;
    private Handler connectionTimeoutHandler = new Handler(Looper.getMainLooper());
    private Runnable processSendQueueRunnable;
    // Current MTU size
    private int currentMtu = 23; // Default BLE MTU

    // Audio microphone state tracking
    private boolean shouldUseGlassesMic = false; // Whether to use glasses microphone for audio input
    private boolean isMicrophoneEnabled = false; // Track current microphone state

    // Rate limiting - minimum delay between BLE characteristic writes
    private static final long MIN_SEND_DELAY_MS = 160; // 160ms minimum delay (increased from 100ms)
    private long lastSendTimeMs = 0; // Timestamp of last send

    // Local state tracking (not in parent SGCManager)
    private boolean isCharging = false;  // Charging status (batteryLevel is in parent)
    private boolean isConnected = false;

    // File transfer management
    private ConcurrentHashMap<String, FileTransferSession> activeFileTransfers = new ConcurrentHashMap<>();
    private static final String FILE_SAVE_DIR = "MentraLive_Images";

    // BLE photo transfer tracking
    private Map<String, BlePhotoTransfer> blePhotoTransfers = new HashMap<>();

    // File packet reassembly buffer for handling fragmented BLE notifications
    // Android BLE stack delivers notifications in MTU-sized chunks (253 bytes with default MTU)
    // iOS CoreBluetooth delivers full packets, so this buffer is only needed on Android
    // Protocol: ## (start) + type + packSize + ... + data + verify + $$ (end)
    private byte[] filePacketBuffer = new byte[64 * 1024]; // 64KB max buffer
    private int filePacketBufferSize = 0;
    private final Object filePacketBufferLock = new Object();
    private int fileReadNotificationCount = 0; // Debug counter for FILE_READ notifications

    private static class BlePhotoTransfer {
        String bleImgId;
        String requestId;
        String webhookUrl;
        String authToken;
        FileTransferSession session;
        long phoneStartTime;  // When phone received the request
        long bleTransferStartTime;  // When BLE transfer actually started
        long glassesCompressionDurationMs;  // How long glasses took to compress

        BlePhotoTransfer(String bleImgId, String requestId, String webhookUrl) {
            this.bleImgId = bleImgId;
            this.requestId = requestId;
            this.webhookUrl = webhookUrl;
            this.authToken = "";
            this.phoneStartTime = System.currentTimeMillis();
            this.bleTransferStartTime = 0;
            this.glassesCompressionDurationMs = 0;
        }

        void setAuthToken(String authToken) {
            this.authToken = authToken != null ? authToken : "";
        }
    }

    // Inner class to track incoming file transfers
    private static class FileTransferSession {
        String fileName;
        int fileSize;           // NOTE: This may be "fake" (inflated) due to BES firmware workaround
        int actualPackSize;     // Actual pack size from first received packet (for BES lie detection)
        int totalPackets;
        int expectedNextPacket;
        ConcurrentHashMap<Integer, byte[]> receivedPackets;
        long startTime;
        boolean isComplete;
        boolean isAnnounced;

        // BES2700 firmware hardcodes FILE_PACK_SIZE=400 when calculating totalPack.
        // We "lie" about fileSize to make BES expect correct packet count.
        // This constant must match the one in asg_client's FileTransferSession.
        private static final int BES_HARDCODED_PACK_SIZE = 400;

        FileTransferSession(String fileName, int fileSize) {
            this.fileName = fileName;
            this.fileSize = fileSize;
            this.actualPackSize = 0; // Will be set on first packet
            // Initialize with max expected packets - will be recalculated on first packet
            this.totalPackets = (fileSize + K900ProtocolUtils.FILE_PACK_SIZE - 1) / K900ProtocolUtils.FILE_PACK_SIZE;
            this.expectedNextPacket = 0;
            this.receivedPackets = new ConcurrentHashMap<>();
            this.startTime = System.currentTimeMillis();
            this.isComplete = false;
            this.isAnnounced = false;
        }

        /**
         * Recalculate total packets based on actual pack size from received packet.
         * Called when first packet is received to handle variable pack sizes.
         *
         * NOTE: Due to BES firmware workaround, fileSize in header may be "fake" (inflated).
         * We detect this by checking if fileSize is a multiple of 400 (BES_HARDCODED_PACK_SIZE).
         * If so, totalPackets = fileSize / 400, regardless of actual pack size.
         */
        void recalculateTotalPackets(int actualPackSize) {
            if (actualPackSize <= 0 || actualPackSize > K900ProtocolUtils.FILE_PACK_SIZE) {
                return;
            }

            this.actualPackSize = actualPackSize;

            // Detect BES lie: if fileSize is exact multiple of 400, glasses used the lie strategy
            boolean isBesLie = (fileSize % BES_HARDCODED_PACK_SIZE == 0) && (actualPackSize != BES_HARDCODED_PACK_SIZE);

            int newTotalPackets;
            if (isBesLie) {
                // BES lie detected: totalPackets = fileSize / 400
                newTotalPackets = fileSize / BES_HARDCODED_PACK_SIZE;
                Log.i("FileTransferSession", "📦 BES Lie detected! fakeFileSize=" + fileSize +
                      ", totalPackets=" + newTotalPackets + ", actualPackSize=" + actualPackSize);
            } else {
                // Normal case: calculate based on actual pack size
                newTotalPackets = (fileSize + actualPackSize - 1) / actualPackSize;
            }

            if (newTotalPackets != totalPackets) {
                Log.i("FileTransferSession", "📦 Recalculating totalPackets: " + totalPackets + " -> " + newTotalPackets +
                      " (packSize=" + actualPackSize + ", fileSize=" + fileSize + ")");
                totalPackets = newTotalPackets;
            }
        }

        boolean addPacket(int index, byte[] data) {
            if (index >= 0 && index < totalPackets && !receivedPackets.containsKey(index)) {
                receivedPackets.put(index, data);

                // Update expected next packet if this was the one we were waiting for
                while (receivedPackets.containsKey(expectedNextPacket)) {
                    expectedNextPacket++;
                }

                // Check if complete
                isComplete = (receivedPackets.size() == totalPackets);
                return true;
            }
            return false;
        }

        // Check if this is the final packet (highest index we expect)
        boolean isFinalPacket(int index) {
            return index == (totalPackets - 1);
        }

        // Check if we should trigger completion check (either complete or final packet received)
        boolean shouldCheckCompletion(int receivedIndex) {
            return isComplete || isFinalPacket(receivedIndex);
        }

        // Get list of missing packet indices
        List<Integer> getMissingPackets() {
            List<Integer> missing = new ArrayList<>();
            for (int i = 0; i < totalPackets; i++) {
                if (!receivedPackets.containsKey(i)) {
                    missing.add(i);
                }
            }
            return missing;
        }

        /**
         * Assemble file from received packets.
         * NOTE: We calculate actual file size from received data, NOT from header fileSize,
         * because fileSize may be "fake" (inflated) due to BES firmware workaround.
         */
        byte[] assembleFile() {
            if (!isComplete) {
                return null;
            }

            // Calculate actual file size by summing all received packet sizes
            int actualFileSize = 0;
            for (int i = 0; i < totalPackets; i++) {
                byte[] packet = receivedPackets.get(i);
                if (packet != null) {
                    actualFileSize += packet.length;
                }
            }

            Log.i("FileTransferSession", "📦 Assembling file: headerFileSize=" + fileSize +
                  ", actualFileSize=" + actualFileSize + ", totalPackets=" + totalPackets);

            byte[] fileData = new byte[actualFileSize];
            int offset = 0;

            for (int i = 0; i < totalPackets; i++) {
                byte[] packet = receivedPackets.get(i);
                if (packet != null) {
                    System.arraycopy(packet, 0, fileData, offset, packet.length);
                    offset += packet.length;
                }
            }

            return fileData;
        }
    }

    // Note: WiFi state (wifiConnected, wifiSsid, wifiLocalIp) and hotspot state
    // (isHotspotEnabled, hotspotSsid, hotspotPassword, hotspotGatewayIp)
    // are inherited from SGCManager parent class

    // Heartbeat tracking
    private Handler heartbeatHandler = new Handler(Looper.getMainLooper());
    private Runnable heartbeatRunnable;
    private int heartbeatCounter = 0;
    private boolean glassesReady = false;
    private boolean rgbLedAuthorityClaimed = false; // Track if we've claimed RGB LED control from BES

    // Audio Pairing: Track readiness separately for BLE and audio (matches iOS implementation)
    private boolean glassesReadyReceived = false;
    private boolean audioConnected = false;

    // Micbeat tracking - periodically enable custom audio TX
    private Handler micBeatHandler = new Handler(Looper.getMainLooper());
    private Runnable micBeatRunnable;
    private int micBeatCount = 0;

    // Message tracking for reliable delivery
    private final ConcurrentHashMap<Long, PendingMessage> pendingMessages = new ConcurrentHashMap<>();
    private final AtomicLong messageIdCounter = new AtomicLong(1);
    private static final long ACK_TIMEOUT_MS = 2000; // 2 seconds
    private static final int MAX_RETRY_ATTEMPTS = 3;
    private static final long RETRY_DELAY_MS = 1000; // 1 second base delay

    // Esoteric message ID generation
    private final SecureRandom secureRandom = new SecureRandom();
    private final long deviceId = System.currentTimeMillis() ^ new Random().nextLong();

    private byte lastReceivedLc3Sequence = -1;
    private byte lc3SequenceNumber = 0;
    private long lc3DecoderPtr = 0;
    private Lc3Player lc3AudioPlayer;
    // Audio playback control - allows monitoring glasses microphone through phone speakers
    // Set to true to enable playback, false to disable. Independent of microphone state.
    private boolean audioPlaybackEnabled = false;
    // Rolling recording control - saves last 20 seconds of audio as M4A file every 20 seconds
    // Set to true to enable rolling recording, false to disable.
    private boolean rollingRecordingEnabled = false;

    // Periodic test message for ACK testing
    private static final int TEST_MESSAGE_INTERVAL_MS = 5000; // 5 seconds
    private Handler testMessageHandler = new Handler(Looper.getMainLooper());
    private Runnable testMessageRunnable;
    private int testMessageCounter = 0;

    // Pending message data structure
    private static class PendingMessage {
        final String messageData;
        final long timestamp;
        final int retryCount;
        final Runnable retryRunnable;

        PendingMessage(String messageData, long timestamp, int retryCount, Runnable retryRunnable) {
            this.messageData = messageData;
            this.timestamp = timestamp;
            this.retryCount = retryCount;
            this.retryRunnable = retryRunnable;
        }
    }

    // LC3 Audio Logging and Saving
    private static final boolean LC3_LOGGING_ENABLED = true;
    private static final boolean LC3_SAVING_ENABLED = true;
    private static final String LC3_LOG_DIR = "lc3_audio_logs";
    private FileOutputStream lc3AudioFileStream;
    private String currentLc3FileName;
    private int totalLc3PacketsReceived = 0;
    private int totalLc3BytesReceived = 0;
    private long firstLc3PacketTime = 0;
    private long lastLc3PacketTime = 0;
    private final SimpleDateFormat lc3TimestampFormat = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US);
    private final SimpleDateFormat lc3PacketTimestampFormat = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);

    public MentraLive() {
        super();
        this.type = DeviceTypes.LIVE;
        this.hasMic = true;
        this.context = Bridge.getContext();

        // Initialize bluetooth adapter
        BluetoothManager bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager != null) {
            bluetoothAdapter = bluetoothManager.getAdapter();
        }

        // Initialize connection state
        connectionState = ConnTypes.DISCONNECTED;

        // Initialize CTKD bonding receiver
        initializeBondingReceiver();

        // Initialize the send queue processor
        processSendQueueRunnable = new Runnable() {
            @Override
            public void run() {
                processSendQueue();
                // Don't reschedule here - let processSendQueue and onCharacteristicWrite handle scheduling
            }
        };

        // Initialize heartbeat runnable
        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                sendHeartbeat();
                // Schedule next heartbeat
                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
            }
        };

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
        scheduler = Executors.newScheduledThreadPool(1);

        // Setup LC3 player for audio monitoring
        // Initialize with frame size matching MentraLive LC3_FRAME_SIZE
        lc3AudioPlayer = new Lc3Player(context, LC3_FRAME_SIZE);
        lc3AudioPlayer.init();
        
        // Enable rolling recording if configured
        if (rollingRecordingEnabled) {
            lc3AudioPlayer.enableRollingRecording(true);
            Bridge.log("LIVE: 🎙️ Rolling audio recording enabled (saves 20-sec files)");
        }
        
        // Start playback only if audioPlaybackEnabled is true
        if (audioPlaybackEnabled) {
            lc3AudioPlayer.startPlay();
            Bridge.log("LIVE: 🔊 LC3 audio player started (frame size: " + LC3_FRAME_SIZE + " bytes)");
        } else {
            Bridge.log("LIVE: 🔊 LC3 audio player initialized but playback disabled (frame size: " + LC3_FRAME_SIZE + " bytes)");
        }

        //setup LC3 decoder for PCM conversion
        if (lc3DecoderPtr == 0) {
            lc3DecoderPtr = Lc3Cpp.initDecoder();
            Bridge.log("LIVE: Initialized LC3 decoder for PCM conversion: " + lc3DecoderPtr);
        }
    }

    public void cleanup() {
        Bridge.log("LIVE: Cleaning up MentraLiveSGC");
        destroy();
    }

    private void updateConnectionState(String state) {
        boolean isEqual = state.equals(connectionState);
        if (isEqual) {
            return;
        }

        // Actually update the connection state!
        connectionState = state;

        if (state.equals(ConnTypes.CONNECTED)) {
            ready = true;
            CoreManager.getInstance().handleConnectionStateChanged();
        } else if (state.equals(ConnTypes.DISCONNECTED)) {
            ready = false;
            CoreManager.getInstance().handleConnectionStateChanged();
        }
    }

    protected void setFontSizes() {
        // LARGE_FONT = 3;
        // MEDIUM_FONT = 2;
        // SMALL_FONT = 1;
    }

    /**
     * Starts BLE scanning for Mentra Live glasses
     */
    private void startScan() {
        if (bluetoothAdapter == null || isScanning) {
            return;
        }

        bluetoothScanner = bluetoothAdapter.getBluetoothLeScanner();
        if (bluetoothScanner == null) {
            Log.e(TAG, "BLE scanner not available");
            return;
        }

        // Configure scan settings
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        // Set up filters for both standard "Xy_A" and K900 "XyBLE_" device names
        List<ScanFilter> filters = new ArrayList<>();

        // Standard glasses filter
        ScanFilter standardFilter = new ScanFilter.Builder()
                .setDeviceName("Xy_A") // Name for standard glasses BLE peripheral
                .build();
       // filters.add(standardFilter);

        // K900/Mentra Live glasses filter
        ScanFilter k900Filter = new ScanFilter.Builder()
                .setDeviceName("XyBLE_") // Name for K900/Mentra Live glasses
                .build();
       // filters.add(k900Filter);

        // Start scanning
        try {
            // Use different timeout based on whether we're reconnecting
            long scanTimeout = isReconnecting ? RECONNECT_SCAN_TIMEOUT_MS : 60000;
            
            if (isReconnecting) {
                Log.i(TAG, "🔌 ⚡ FAST RECONNECT SCAN - timeout: " + scanTimeout + "ms (attempt #" + reconnectAttempts + ")");
                Bridge.log("LIVE: Starting FAST BLE scan for reconnection (timeout: " + scanTimeout + "ms)");
            } else {
                Bridge.log("LIVE: Starting BLE scan for Mentra Live glasses (timeout: " + scanTimeout + "ms)");
            }
            
            isScanning = true;
            bluetoothScanner.startScan(filters, settings, scanCallback);

            // Set a timeout to stop scanning
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (isScanning) {
                        if (isReconnecting) {
                            Log.w(TAG, "🔌 ⏰ RECONNECT SCAN TIMEOUT after " + scanTimeout + "ms - Device not found (attempt #" + reconnectAttempts + ")");
                            Bridge.log("LIVE: 🔌 ⏰ Reconnect scan timeout - device not found, will retry");
                        } else {
                            Bridge.log("LIVE: Scan timeout reached - stopping BLE scan");
                        }
                        stopScan();
                        
                        // If reconnecting and scan timed out, trigger next reconnection attempt
                        if (isReconnecting) {
                            Log.i(TAG, "🔌 🔄 Scan timeout - scheduling next reconnection attempt...");
                            handleReconnection();
                        }
                    }
                }
            }, scanTimeout);
        } catch (Exception e) {
            Log.e(TAG, "Error starting BLE scan", e);
            isScanning = false;
        }
    }

    /**
     * Stops BLE scanning
     */
    private void stopScan() {
        if (bluetoothAdapter == null || bluetoothScanner == null || !isScanning) {
            return;
        }

        try {
            bluetoothScanner.stopScan(scanCallback);
            isScanning = false;
            Bridge.log("LIVE: BLE scan stopped");

            // Post event only if we haven't been destroyed
            // if (smartGlassesDevice != null) {
                // EventBus.getDefault().post(new GlassesBluetoothSearchStopEvent(smartGlassesDevice.deviceModelName));
            // }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping BLE scan", e);
            // Ensure isScanning is false even if stop failed
            isScanning = false;
        }
    }

    Set<String> seenDevices = new HashSet<>();

    /**
     * BLE Scan callback
     */
    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            // Check if the object has been destroyed to prevent NPE
            if (context == null || isKilled) {
                Bridge.log("LIVE: Ignoring scan result - object destroyed or killed");
                return;
            }

            if (result.getDevice() == null || result.getDevice().getName() == null) {
                return;
            }

            String deviceName = result.getDevice().getName();
            String deviceAddress = result.getDevice().getAddress();

            // String device = deviceName + deviceAddress;
            // if (!seenDevices.contains(device)) {
            //     seenDevices.add(device);
            //     Bridge.log("LIVE: Found BLE device: " + deviceName + " (" + deviceAddress + ")");
            // }

            // Check if this device matches the saved device name
            // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            // String savedDeviceName = prefs.getString(PREF_DEVICE_NAME, null);

            // Post the discovered device to the event bus ONLY
            // Don't automatically connect - wait for explicit connect request from UI
            if (deviceName.equals("Xy_A") || deviceName.startsWith("XyBLE_") || deviceName.startsWith("MENTRA_LIVE_BLE") || deviceName.startsWith("MENTRA_LIVE_BT") || deviceName.toLowerCase().startsWith("mentra_live")) {
                String glassType = deviceName.equals("Xy_A") ? "Standard" : "K900";
                Bridge.log("LIVE: Found compatible " + glassType + " glasses device: " + deviceName);
                // EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(
                        // smartGlassesDevice.deviceModelName, deviceName));
                Bridge.sendDiscoveredDevice(DeviceTypes.LIVE, deviceName);

                // If already connecting or connected, don't start another connection
                if (isConnected || isConnecting) {
                    return;
                }

                // If this is the specific device we want to connect to by name, connect to it
                if (savedDeviceName != null && savedDeviceName.equals(deviceName)) {
                    Log.i(TAG, "🔌 🎯 RECONNECT TARGET FOUND - Device: " + deviceName + " (Attempt #" + reconnectAttempts + ")");
                    Bridge.log("LIVE: 🔌 🎯 Found our remembered device by name, connecting: " + deviceName + 
                              " (Reconnect attempt #" + reconnectAttempts + ")");
                    stopScan();
                    connectToDevice(result.getDevice());
                }
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.e(TAG, "BLE scan failed with error: " + errorCode);
            isScanning = false;
        }
    };

    /**
     * Connect to a specific BLE device
     */
    private void connectToDevice(BluetoothDevice device) {
        if (device == null) {
            return;
        }

        // Cancel any previous connection timeouts
        if (connectionTimeoutRunnable != null) {
            connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable);
        }

        // Set connection timeout
        connectionTimeoutRunnable = new Runnable() {
            @Override
            public void run() {
                if (isConnecting && !isConnected) {
                    Log.w(TAG, "🔌 ⏰ CONNECTION TIMEOUT after " + CONNECTION_TIMEOUT_MS + "ms - Reconnect attempt #" + reconnectAttempts + " TIMED OUT");
                    Bridge.log("LIVE: 🔌 ⏰ Connection timeout - closing GATT connection and retrying");
                    isConnecting = false;

                    if (bluetoothGatt != null) {
                        bluetoothGatt.disconnect();
                        bluetoothGatt.close();
                        bluetoothGatt = null;
                    }

                    // Try to reconnect with exponential backoff
                    Log.i(TAG, "🔌 🔄 Scheduling next reconnection attempt after timeout...");
                    handleReconnection();
                }
            }
        };

        connectionTimeoutHandler.postDelayed(connectionTimeoutRunnable, CONNECTION_TIMEOUT_MS);

        // Update connection state
        isConnecting = true;
        updateConnectionState(ConnTypes.CONNECTING);
        Log.i(TAG, "🔌 🔗 ATTEMPTING CONNECTION to device: " + device.getAddress() + " (" + device.getName() + ") - Reconnect attempt #" + reconnectAttempts);
        Bridge.log("LIVE: 🔌 🔗 Connecting to device: " + device.getAddress() + " (Attempt #" + reconnectAttempts + ")");

        // Connect to the device
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                bluetoothGatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
                Log.d(TAG, "🔌 GATT connection initiated with TRANSPORT_LE (Android M+)");
            } else {
                bluetoothGatt = device.connectGatt(context, false, gattCallback);
                Log.d(TAG, "🔌 GATT connection initiated (legacy Android)");
            }
        } catch (Exception e) {
            Log.e(TAG, "🔌 ❌ ERROR connecting to GATT server - Exception: " + e.getMessage(), e);
            Bridge.log("LIVE: 🔌 ❌ Failed to connect to GATT server: " + e.getMessage());
            isConnecting = false;
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
        //     Bridge.log("LIVE: Attempting to reconnect to last known device by name: " + lastDeviceName);

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

    /**
     * Handle reconnection with exponential backoff
     */
    private void handleReconnection() {
        // Don't attempt reconnection if we've been killed/forgotten
        if (isKilled) {
            Bridge.log("LIVE: 🔌 RECONNECT ABORTED - device has been killed/forgotten");
            isReconnecting = false;
            return;
        }

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            Log.e(TAG, "🔌 ❌ RECONNECTION FAILED - Maximum attempts reached (" + MAX_RECONNECT_ATTEMPTS + ")");
            Bridge.log("LIVE: 🔌 ❌ RECONNECTION FAILED - Gave up after " + MAX_RECONNECT_ATTEMPTS + " attempts");
            reconnectAttempts = 0;
            isReconnecting = false;
            return;
        }

        // Set reconnecting flag for faster scan timeout
        isReconnecting = true;

        // Calculate delay with exponential backoff
        long delay = Math.min(BASE_RECONNECT_DELAY_MS * (1L << reconnectAttempts), MAX_RECONNECT_DELAY_MS);
        reconnectAttempts++;

        Log.i(TAG, "🔌 📅 SCHEDULING RECONNECT #" + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + 
              " in " + delay + "ms (base=" + BASE_RECONNECT_DELAY_MS + "ms, max=" + MAX_RECONNECT_DELAY_MS + "ms, scan_timeout=" + RECONNECT_SCAN_TIMEOUT_MS + "ms)");
        Bridge.log("LIVE: 🔌 📅 Scheduling reconnection attempt " + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS +
              " in " + delay + "ms (fast scan: " + RECONNECT_SCAN_TIMEOUT_MS + "ms)");

        // Schedule reconnection attempt
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isConnected && !isConnecting && !isKilled) {
                    // Check for last known device name to start scan
                    SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    String lastDeviceName = prefs.getString(PREF_DEVICE_NAME, null);

                    if (lastDeviceName != null && bluetoothAdapter != null) {
                        Log.i(TAG, "🔌 🔍 STARTING RECONNECT #" + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + 
                              " - Fast scan (" + RECONNECT_SCAN_TIMEOUT_MS + "ms) for device: " + lastDeviceName);
                        Bridge.log("LIVE: 🔌 🔍 Reconnection attempt " + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + 
                              " - Starting FAST BLE scan for: " + lastDeviceName);
                        // Start scan to find this device (will use fast timeout)
                        startScan();
                        // The scan will automatically connect if it finds a device with the saved name
                    } else {
                        Log.w(TAG, "🔌 ⚠️ RECONNECT #" + reconnectAttempts + " SKIPPED - No saved device name available");
                        Bridge.log("LIVE: 🔌 ⚠️ Reconnection attempt " + reconnectAttempts + 
                              " - No last device name available, scheduling next attempt");
                        // Schedule another reconnection attempt - maybe the name will be available later
                        handleReconnection();
                    }
                } else if (isConnected) {
                    Log.i(TAG, "🔌 ✅ RECONNECTION SUCCESSFUL - Already connected (attempt " + reconnectAttempts + ")");
                    Bridge.log("LIVE: 🔌 ✅ Reconnection successful - Already connected");
                    reconnectAttempts = 0;
                    isReconnecting = false;
                } else {
                    Log.d(TAG, "🔌 ⏭️ RECONNECT SKIPPED - State changed (connected=" + isConnected + 
                          ", connecting=" + isConnecting + ", killed=" + isKilled + ")");
                    isReconnecting = false;
                }
            }
        }, delay);
    }

    /**
     * GATT callback for BLE operations
     */
    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            // Cancel the connection timeout
            if (connectionTimeoutRunnable != null) {
                connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable);
                connectionTimeoutRunnable = null;
            }

            if (status == BluetoothGatt.GATT_SUCCESS) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Bridge.log("LIVE: 🔌 ✅ RECONNECTION SUCCESSFUL - Connected to GATT server, discovering services...");
                    isConnecting = false;
                    isConnected = true;
                    connectedDevice = gatt.getDevice();

                    // Save the connected device name for future reconnections
                    if (connectedDevice != null && connectedDevice.getName() != null) {
                        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                        prefs.edit().putString(PREF_DEVICE_NAME, connectedDevice.getName()).apply();
                        Log.i(TAG, "🔌 💾 Saved device name for future reconnection: " + connectedDevice.getName());
                        Bridge.log("LIVE: Saved device name for future reconnection: " + connectedDevice.getName());
                    }

                    // CTKD Implementation: Register bonding receiver and create bond for BT Classic
                    registerBondingReceiver();
                    Bridge.log("LIVE: CTKD: BLE connection established, initiating CTKD bonding for BT Classic");

                    // Check if device is already bonded before attempting to create bond
                    if (connectedDevice.getBondState() == BluetoothDevice.BOND_BONDED) {
                        Bridge.log("LIVE: CTKD: Device is already bonded - connecting A2DP audio profile");
                        // Device is bonded but we need to explicitly connect the A2DP audio profile
                        // Just being bonded doesn't mean the audio profile is connected
                        connectA2dpProfile(connectedDevice);
                        // Note: audioConnected will be set to true once A2DP profile connects
                    } else {
                        createBond(connectedDevice);
                    }

                    // Discover services
                    gatt.discoverServices();

                    // Reset reconnect attempts on successful connection
                    int previousAttempts = reconnectAttempts;
                    reconnectAttempts = 0;
                    isReconnecting = false; // Clear reconnection mode
                    Log.i(TAG, "🔌 ✅ Reconnection counter reset (was at " + previousAttempts + " attempts)");
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Log.w(TAG, "🔌 ⚠️ DISCONNECTED from GATT server - Initiating reconnection sequence");
                    Bridge.log("LIVE: 🔌 ⚠️ Disconnected from GATT server - Will attempt reconnection");
                    isConnected = false;
                    isConnecting = false;

                    // CTKD Implementation: Disconnect BT per documentation
                    if (connectedDevice != null) {
                        Bridge.log("LIVE: CTKD: Disconnecting BT via removeBond per documentation");
                        removeBond(connectedDevice);
                    }

                    connectedDevice = null;
                    glassesReady = false; // Reset ready state on disconnect

                    // Reset audio pairing flags
                    glassesReadyReceived = false;
                    audioConnected = false;

                    // Notify frontend and backend of disconnection
                    updateConnectionState(ConnTypes.DISCONNECTED);

                    handler.removeCallbacks(processSendQueueRunnable);

                    // Stop the readiness check loop
                    stopReadinessCheckLoop();

                    // Stop heartbeat mechanism
                    stopHeartbeat();

                    // Stop micbeat mechanism
                    stopMicBeat();

                    // Clean up GATT resources
                    if (bluetoothGatt != null) {
                        bluetoothGatt.close();
                        bluetoothGatt = null;
                    }

                    // Attempt reconnection
                    Log.i(TAG, "🔌 🔄 Starting automatic reconnection procedure...");
                    handleReconnection();

                    // Close LC3 audio logging
                    closeLc3Logging();

                    //stop LC3 player
                    if (lc3AudioPlayer != null) {
                        lc3AudioPlayer.stopPlay();
                    }
                }
            } else {
                // Connection error
                Log.e(TAG, "🔌 ❌ GATT connection error: status=" + status + " - Reconnect attempt #" + reconnectAttempts + " FAILED");
                Bridge.log("LIVE: 🔌 ❌ GATT connection error (status=" + status + ") - Will retry reconnection");
                isConnected = false;
                isConnecting = false;
                glassesReady = false;
                glassesReadyReceived = false;
                audioConnected = false;

                // Notify frontend and backend of disconnection
                updateConnectionState(ConnTypes.DISCONNECTED);

                // Stop heartbeat mechanism
                stopHeartbeat();

                // Stop micbeat mechanism
                stopMicBeat();

                // Clean up resources
                if (bluetoothGatt != null) {
                    bluetoothGatt.close();
                    bluetoothGatt = null;
                }

                // Attempt reconnection
                Log.i(TAG, "🔌 🔄 Retrying after GATT error...");
                handleReconnection();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Bridge.log("LIVE: GATT services discovered");

                // Find our service and characteristics
                BluetoothGattService service = gatt.getService(SERVICE_UUID);
                if (service != null) {
                    txCharacteristic = service.getCharacteristic(TX_CHAR_UUID);
                    rxCharacteristic = service.getCharacteristic(RX_CHAR_UUID);

                    // Get LC3 characteristics (always supported)
                    lc3ReadCharacteristic = service.getCharacteristic(LC3_READ_UUID);
                    lc3WriteCharacteristic = service.getCharacteristic(LC3_WRITE_UUID);

                    // Check if we have required characteristics
                    boolean hasRequiredCharacteristics = (rxCharacteristic != null && txCharacteristic != null) &&
                                                       (lc3ReadCharacteristic != null && lc3WriteCharacteristic != null);

                    if (hasRequiredCharacteristics) {
                        // BLE connection established, but we still need to wait for glasses SOC
                        Bridge.log("LIVE: ✅ Core TX/RX and LC3 TX/RX characteristics found - BLE connection ready");
                        Bridge.log("LIVE: 🔄 Waiting for glasses SOC to become ready...");

                        // Keep the state as CONNECTING until the glasses SOC responds
                        // connectionEvent(SmartGlassesConnectionState.CONNECTING);

                        // CRITICAL FIX: Request MTU size ONCE - don't schedule delayed retries
                        // This avoids BLE operations during active data flow
                        if (checkPermission()) {
                            boolean mtuRequested = gatt.requestMtu(512);
                            Bridge.log("LIVE: 🔄 Requested MTU size 512, success: " + mtuRequested);
                        }

                        // Enable notifications AFTER BLE connection is established
                        enableNotifications();

                        // Start queue processing for sending data
                        handler.post(processSendQueueRunnable);

                        //openhotspot(); //TODO: REMOVE AFTER DONE DEVELOPING
                        // Start SOC readiness check loop - this will keep trying until
                        // the glasses SOC boots and responds with a "glasses_ready" message
                        // All other initialization will happen after receiving glasses_ready
                        startReadinessCheckLoop();
                    } else {
                        Log.e(TAG, "Required BLE characteristics not found");
                        if (rxCharacteristic == null) {
                            Log.e(TAG, "RX characteristic (peripheral's TX) not found");
                        }
                        if (txCharacteristic == null) {
                            Log.e(TAG, "TX characteristic (peripheral's RX) not found");
                        }
                        // Log LC3 characteristic errors
                        if (lc3ReadCharacteristic == null) {
                            Log.e(TAG, "LC3_READ characteristic not found");
                        }
                        if (lc3WriteCharacteristic == null) {
                            Log.e(TAG, "LC3_WRITE characteristic not found");
                        }
                        gatt.disconnect();
                    }
                } else {
                    Log.e(TAG, "Required BLE service not found: " + SERVICE_UUID);
                    gatt.disconnect();
                }
            } else {
                Log.e(TAG, "Service discovery failed with status: " + status);
                gatt.disconnect();
            }
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Bridge.log("LIVE: Characteristic read successful");
                // Process the read data if needed
            } else {
                Log.e(TAG, "Characteristic read failed with status: " + status);
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                //Bridge.log("LIVE: Characteristic write successful");

                // Calculate time since last send to enforce rate limiting
                long currentTimeMs = System.currentTimeMillis();
                long timeSinceLastSendMs = currentTimeMs - lastSendTimeMs;
                long nextProcessDelayMs;

                if (timeSinceLastSendMs < MIN_SEND_DELAY_MS) {
                    // Not enough time has elapsed, enforce minimum delay
                    nextProcessDelayMs = MIN_SEND_DELAY_MS - timeSinceLastSendMs;
                    //Bridge.log("LIVE: Rate limiting: Next queue processing in " + nextProcessDelayMs + "ms");
                } else {
                    // Enough time has already passed
                    nextProcessDelayMs = 0;
                }

                // Schedule the next queue processing with appropriate delay
                handler.postDelayed(processSendQueueRunnable, nextProcessDelayMs);
            } else {
                Log.e(TAG, "Characteristic write failed with status: " + status);
                // If write fails, try again with a longer delay
                handler.postDelayed(processSendQueueRunnable, 500);
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            // Get thread ID for tracking thread issues
            long threadId = Thread.currentThread().getId();
            UUID uuid = characteristic.getUuid();

            byte[] data = characteristic.getValue();
            if (data == null || data.length == 0) {
                return;
            }

            // FILE_READ characteristic (72FF) needs special handling for packet reassembly
            // Android BLE fragments notifications larger than MTU into multiple callbacks
            boolean isFileReadCharacteristic = uuid.equals(FILE_READ_UUID);
            if (isFileReadCharacteristic) {
                fileReadNotificationCount++;
                Bridge.log("LIVE: 📁 FILE_READ #" + fileReadNotificationCount + " (" + data.length + " bytes), currentMtu=" + currentMtu);
                processFilePacketData(data);
                return; // File data handled separately with reassembly buffer
            }

            boolean isRxCharacteristic = uuid.equals(RX_CHAR_UUID);
            boolean isTxCharacteristic = uuid.equals(TX_CHAR_UUID);
            boolean isLc3ReadCharacteristic = uuid.equals(LC3_READ_UUID);
            boolean isLc3WriteCharacteristic = uuid.equals(LC3_WRITE_UUID);

            if (isRxCharacteristic) {
                Bridge.log("LIVE: Received data on RX characteristic");
            } else if (isTxCharacteristic) {
                Bridge.log("LIVE: Received data on TX characteristic");
            } else if (isLc3ReadCharacteristic) {
                // Bridge.log("LIVE: Received data on LC3_READ characteristic");
                processLc3AudioPacket(data);
                return; // LC3 audio handled separately
            } else if (isLc3WriteCharacteristic) {
                Bridge.log("LIVE: Received data on LC3_WRITE characteristic");
            } else {
                Log.w(TAG, "Received data on unknown characteristic: " + uuid);
            }

            // Process command/JSON data on RX/TX characteristics
            processReceivedData(data, data.length);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            long threadId = Thread.currentThread().getId();

            // CRITICAL FIX: Just log the result but take NO ACTION regardless of status
            // This prevents descriptor write failures from crashing the connection
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "Thread-" + threadId + ": ✅ Descriptor write successful");
            } else {
                // Just log the error without taking ANY action
                Log.e(TAG, "Thread-" + threadId + ": ℹ️ Descriptor write failed with status: " + status + " - IGNORING");
                // DO NOT add any other operations or logging as they might cause issues
            }

            // DO NOT:
            // - Schedule any operations
            // - Try to retry anything
            // - Create any new BLE operations
            // - Post any handlers
            // - Do any validation or checking

            // Any of these could cause thread conflicts that would kill the connection
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                Bridge.log("LIVE: 🔵 MTU negotiation successful - changed to " + mtu + " bytes");
                int effectivePayload = mtu - 3;
                Bridge.log("LIVE:    Effective payload size: " + effectivePayload + " bytes");

                // Store the new MTU value
                currentMtu = mtu;

                // NOTE: MTU config will be sent to glasses after glasses_ready is received.
                // BES2700 chip ignores negotiated MTU and uses 256 for BLE notifications,
                // so we'll tell glasses to use 256 to fit packets in 253 bytes.

                // If the negotiated MTU is sufficient for LC3 audio packets (typically 40-60 bytes)
                if (mtu >= 64) {
                    Bridge.log("LIVE: ✅ MTU size is sufficient for LC3 audio data packets");
                } else {
                    Log.w(TAG, "⚠️ MTU size may be too small for LC3 audio data packets");

                    // Log the effective MTU payload directly
                    Bridge.log("LIVE: 📊 Effective MTU payload: " + effectivePayload + " bytes");

                    // Check if it's sufficient for LC3 audio
                    if (effectivePayload < 60) {
                        Log.e(TAG, "❌ CRITICAL: Effective MTU too small for LC3 audio!");
                        Log.e(TAG, "   This will likely cause issues with LC3 audio transmission");
                    }

                    // If we still have a small MTU, try requesting again
                    if (mtu < 64 && gatt != null && checkPermission()) {
                        handler.postDelayed(() -> {
                            if (isConnected && gatt != null) {
                                Bridge.log("LIVE: 🔄 Re-attempting MTU increase after initial small MTU");
                                boolean retryMtuRequest = gatt.requestMtu(512);
                                Bridge.log("LIVE:    MTU increase retry requested: " + retryMtuRequest);
                            }
                        }, 1000); // Wait 1 second before retry
                    }
                }
            } else {
                Log.e(TAG, "❌ MTU change failed with status: " + status);
                Log.w(TAG, "   Will continue with default MTU (23 bytes, 20 byte payload)");

                // Try again if the MTU request failed
                if (gatt != null && checkPermission()) {
                    handler.postDelayed(() -> {
                        if (isConnected && gatt != null) {
                            Bridge.log("LIVE: 🔄 Re-attempting MTU increase after previous failure");
                            boolean retryMtuRequest = gatt.requestMtu(512);
                            Bridge.log("LIVE:    MTU increase retry requested: " + retryMtuRequest);
                        }
                    }, 1500); // Wait 1.5 seconds before retry
                }
            }
        }
    };

    /**
     * Enable notifications for all characteristics to ensure we catch data from any endpoint
     */
    private void enableNotifications() {
        long threadId = Thread.currentThread().getId();
        Log.e(TAG, "Thread-" + threadId + ": 🔵 enableNotifications() called");

        if (bluetoothGatt == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot enable notifications - bluetoothGatt is null");
            return;
        }

        if (!hasPermissions()) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot enable notifications - missing permissions");
            return;
        }

        // Find our service
        BluetoothGattService service = bluetoothGatt.getService(SERVICE_UUID);
        if (service == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Service not found: " + SERVICE_UUID);
            return;
        }

        // Get all characteristics
        List<BluetoothGattCharacteristic> characteristics = service.getCharacteristics();
        Bridge.log("LIVE: Thread-" + threadId + ": Found " + characteristics.size() + " characteristics in service " + SERVICE_UUID);

        boolean notificationSuccess = false;

        // Enable notifications for each characteristic
        for (BluetoothGattCharacteristic characteristic : characteristics) {
            UUID uuid = characteristic.getUuid();
            Bridge.log("LIVE: Thread-" + threadId + ": Examining characteristic: " + uuid);

            // Log if this is one of the file transfer characteristics
            if (uuid.equals(FILE_READ_UUID)) {
                Log.e(TAG, "Thread-" + threadId + ": 📁 Found FILE_READ characteristic (72FF)!");
            } else if (uuid.equals(FILE_WRITE_UUID)) {
                Log.e(TAG, "Thread-" + threadId + ": 📁 Found FILE_WRITE characteristic (73FF)!");
            }

            int properties = characteristic.getProperties();
            boolean hasNotify = (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0;
            boolean hasIndicate = (properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0;
            boolean hasRead = (properties & BluetoothGattCharacteristic.PROPERTY_READ) != 0;
            boolean hasWrite = (properties & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0;
            boolean hasWriteNoResponse = (properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0;

            Bridge.log("LIVE: Thread-" + threadId + ": Characteristic " + uuid + " properties: " +
                   (hasNotify ? "NOTIFY " : "") +
                   (hasIndicate ? "INDICATE " : "") +
                   (hasRead ? "READ " : "") +
                   (hasWrite ? "WRITE " : "") +
                   (hasWriteNoResponse ? "WRITE_NO_RESPONSE " : ""));

            // Store references to our main characteristics
            if (uuid.equals(RX_CHAR_UUID)) {
                rxCharacteristic = characteristic;
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored RX characteristic");
            } else if (uuid.equals(TX_CHAR_UUID)) {
                txCharacteristic = characteristic;
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored TX characteristic");
            } else if (uuid.equals(LC3_READ_UUID)) {
                lc3ReadCharacteristic = characteristic;
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored LC3_READ characteristic");
            } else if (uuid.equals(LC3_WRITE_UUID)) {
                lc3WriteCharacteristic = characteristic;
                Log.e(TAG, "Thread-" + threadId + ": ✅ Found and stored LC3_WRITE characteristic");
            }

            // Enable notifications for any characteristic that supports it
            if (hasNotify || hasIndicate) {
                try {
                    // Enable local notifications
                    boolean success = bluetoothGatt.setCharacteristicNotification(characteristic, true);
                    Log.e(TAG, "Thread-" + threadId + ": 📱 Set local notification for " + uuid + ": " + success);
                    notificationSuccess = notificationSuccess || success;

                    // Try to enable remote notifications by writing to descriptor
                    // We'll do this despite previous issues, since it's required for some devices
                    BluetoothGattDescriptor descriptor = characteristic.getDescriptor(
                        CLIENT_CHARACTERISTIC_CONFIG_UUID);

                    if (descriptor != null) {
                        try {
                            byte[] value;
                            if (hasNotify) {
                                value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
                            } else {
                                value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
                            }

                            descriptor.setValue(value);
                            boolean writeSuccess = bluetoothGatt.writeDescriptor(descriptor);
                            Log.e(TAG, "Thread-" + threadId + ": 📱 Write descriptor for " + uuid + ": " + writeSuccess);
                        } catch (Exception e) {
                            // Just log the error and continue - doesn't stop us from trying other characteristics
                            Log.e(TAG, "Thread-" + threadId + ": ⚠️ Error writing descriptor for " + uuid + ": " + e.getMessage());
                        }
                    } else {
                        Log.e(TAG, "Thread-" + threadId + ": ⚠️ No notification descriptor found for " + uuid);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Thread-" + threadId + ": ❌ Exception enabling notifications for " + uuid + ": " + e.getMessage());
                }
            }
        }

        // Log notification status but AVOID any delayed operations!
        if (notificationSuccess) {
            Bridge.log("LIVE: Thread-" + threadId + ": Local notification registration SUCCESS for at least one characteristic");
            Log.e(TAG, "Thread-" + threadId + ": 🔔 Ready to receive data via onCharacteristicChanged()");
        } else {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Failed to enable notifications on any characteristic");
        }
    }

    /**
     * Process the send queue with rate limiting
     */
    private void processSendQueue() {
        if (!isConnected || bluetoothGatt == null || txCharacteristic == null) {
            return;
        }

        // Check if we need to enforce rate limiting
        long currentTimeMs = System.currentTimeMillis();
        long timeSinceLastSendMs = currentTimeMs - lastSendTimeMs;

        if (timeSinceLastSendMs < MIN_SEND_DELAY_MS) {
            // Not enough time has elapsed since last send
            // Reschedule processing after the remaining delay
            long remainingDelayMs = MIN_SEND_DELAY_MS - timeSinceLastSendMs;
            Bridge.log("LIVE: Rate limiting: Waiting " + remainingDelayMs + "ms before next BLE send");
            handler.postDelayed(processSendQueueRunnable, remainingDelayMs);
            return;
        }

        // Send the next item from the queue
        byte[] data = sendQueue.poll();
        if (data != null) {
            // Update last send time before sending
            lastSendTimeMs = currentTimeMs;
            Bridge.log("LIVE: 📤 Sending queued data - Queue size: " + sendQueue.size() +
                  ", Time since last send: " + timeSinceLastSendMs + "ms");
            sendDataInternal(data);
        }
    }

    /**
     * Send data through BLE
     */
    private void sendDataInternal(byte[] data) {
        if (!isConnected || bluetoothGatt == null || txCharacteristic == null || data == null) {
            return;
        }

        try {
            txCharacteristic.setValue(data);
            bluetoothGatt.writeCharacteristic(txCharacteristic);
        } catch (Exception e) {
            Log.e(TAG, "Error sending data via BLE", e);
        }
    }

    /**
     * Queue data to be sent
     */
    private void queueData(byte[] data) {
        if (data != null) {
            sendQueue.add(data);
            Bridge.log("LIVE: 📋 Added " + data.length + " to send queue - New queue size: " + sendQueue.size());

            // Log all outgoing bytes for testing
            StringBuilder hexBytes = new StringBuilder();
            for (byte b : data) {
                hexBytes.append(String.format("%02X ", b));
            }
            // Bridge.log("LIVE: 🔍 Outgoing bytes: " + hexBytes.toString().trim());

            // Trigger queue processing if not already running
            handler.removeCallbacks(processSendQueueRunnable);
            handler.post(processSendQueueRunnable);
        }
    }

    /**
     * Generate an esoteric message ID using timestamp, device ID, and random values
     * @return A unique, unpredictable message ID
     */
    private long generateEsotericMessageId() {
        long timestamp = System.currentTimeMillis();
        long randomComponent = secureRandom.nextLong();
        long counter = messageIdCounter.getAndIncrement();

        // Combine timestamp, device ID, random value, and counter in a non-obvious way
        long messageId = timestamp ^ deviceId ^ randomComponent ^ (counter << 32);

        // Ensure it's positive (clear the sign bit)
        messageId = Math.abs(messageId);

        return messageId;
    }

    /**
     * Send a JSON object to the glasses with message ID and ACK tracking
     */
    private void sendJson(JSONObject json, boolean wakeup) {
        if (json != null) {
            try {
                if (glassesBuildNumberInt < 5) {
                    String jsonStr = json.toString();
                    Bridge.log("LIVE: 📤 Sending JSON with esoteric message ID: " + jsonStr);
                    sendDataToGlasses(jsonStr, wakeup);
                } else {
                    // Add esoteric message ID to the JSON
                    long messageId = generateEsotericMessageId();
                    json.put("mId", messageId);

                    String jsonStr = json.toString();
                    Bridge.log("LIVE: 📤 Sending JSON with esoteric message ID " + messageId + ": " + jsonStr);

                    // Check if this message will be chunked to determine timeout
                    long ackTimeout = ACK_TIMEOUT_MS;
                    try {
                        // Create a test C-wrapped version to check size
                        JSONObject testWrapper = new JSONObject();
                        testWrapper.put("C", jsonStr);
                        if (wakeup) {
                            testWrapper.put("W", 1);
                        }
                        String testWrappedJson = testWrapper.toString();

                        if (MessageChunker.needsChunking(testWrappedJson)) {
                            // Calculate dynamic timeout for chunked message
                            int estimatedChunks = (int) Math.ceil(jsonStr.length() / 300.0);
                            ackTimeout = ACK_TIMEOUT_MS + (estimatedChunks * 50L) + 2000L;
                            Bridge.log("LIVE: Message will be chunked into ~" + estimatedChunks + " chunks, using dynamic timeout: " + ackTimeout + "ms");
                        }
                    } catch (JSONException e) {
                        // If we can't determine, use default timeout
                        Log.w(TAG, "Could not determine if message needs chunking, using default timeout");
                    }

                    // Track the message for ACK with appropriate timeout
                    trackMessageForAck(messageId, jsonStr, ackTimeout);

                    // Send the data
                    sendDataToGlasses(jsonStr, wakeup);
                }
            } catch (JSONException e) {
                Log.e(TAG, "Error adding message ID to JSON", e);
            }
        } else {
            Bridge.log("LIVE: Cannot send JSON to ASG, JSON is null");
        }
    }

    private void sendJson(JSONObject json){
        sendJson(json, false);
    }

    public void sendJson(Map<String, Object> jsonOriginal, boolean wakeUp) {

    }

    @Override
    public List<String> sortMicRanking(List<String> list) {
        return list;
    }

    /**
     * Track a message for ACK response
     */
    private void trackMessageForAck(long messageId, String messageData) {
        trackMessageForAck(messageId, messageData, ACK_TIMEOUT_MS);
    }

    /**
     * Track a message for ACK response with custom timeout
     */
    private void trackMessageForAck(long messageId, String messageData, long timeoutMs) {
        if (!isConnected) {
            Bridge.log("LIVE: Not connected, skipping ACK tracking for message " + messageId);
            return;
        }

        // Skip ACK tracking for glasses with build number < 5 (older firmware)
        if (glassesBuildNumberInt < 5) {
            Bridge.log("LIVE: Glasses build number (" + glassesBuildNumberInt + ") < 5, skipping ACK tracking for message " + messageId);
            return;
        }

        // Create retry runnable
        Runnable retryRunnable = new Runnable() {
            @Override
            public void run() {
                retryMessage(messageId);
            }
        };

        // Create pending message
        PendingMessage pendingMessage = new PendingMessage(messageData, System.currentTimeMillis(), 0, retryRunnable);
        pendingMessages.put(messageId, pendingMessage);

        // Schedule ACK timeout with custom timeout
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                checkMessageAck(messageId);
            }
        }, timeoutMs);

        Bridge.log("LIVE: 📋 Tracking message " + messageId + " for ACK (timeout: " + timeoutMs + "ms)");
    }

    /**
     * Check if a message has been acknowledged
     */
    private void checkMessageAck(long messageId) {
        PendingMessage pendingMessage = pendingMessages.get(messageId);
        if (pendingMessage != null) {
            Log.w(TAG, "⏰ ACK timeout for message " + messageId + " (attempt " + pendingMessage.retryCount + ")");

            if (pendingMessage.retryCount < MAX_RETRY_ATTEMPTS) {
                // Retry the message
                Bridge.log("LIVE: 🔄 Retrying message " + messageId + " (attempt " + (pendingMessage.retryCount + 1) + "/" + MAX_RETRY_ATTEMPTS + ")");
                retryMessage(messageId);
            } else {
                // Max retries reached
                Log.e(TAG, "❌ Message " + messageId + " failed after " + MAX_RETRY_ATTEMPTS + " attempts");
                pendingMessages.remove(messageId);
            }
        }
    }

    /**
     * Retry a message
     */
    private void retryMessage(long messageId) {
        PendingMessage pendingMessage = pendingMessages.get(messageId);
        if (pendingMessage == null) {
            Log.w(TAG, "Message " + messageId + " no longer tracked for retry");
            return;
        }

        if (pendingMessage.retryCount >= MAX_RETRY_ATTEMPTS) {
            Log.e(TAG, "Max retries reached for message " + messageId);
            pendingMessages.remove(messageId);
            return;
        }

        // Create new pending message with incremented retry count
        PendingMessage retryMessage = new PendingMessage(
            pendingMessage.messageData,
            System.currentTimeMillis(),
            pendingMessage.retryCount + 1,
            pendingMessage.retryRunnable
        );

        // Update the tracked message
        pendingMessages.put(messageId, retryMessage);

        // Send the message again
        Bridge.log("LIVE: 📤 Retrying message " + messageId + " (attempt " + retryMessage.retryCount + ")");
        sendDataToGlasses(pendingMessage.messageData, false);

        // Schedule next ACK check
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                checkMessageAck(messageId);
            }
        }, ACK_TIMEOUT_MS);
    }

    /**
     * Process ACK response from glasses
     */
    private void processAckResponse(long messageId) {
        PendingMessage pendingMessage = pendingMessages.remove(messageId);
        if (pendingMessage != null) {
            Bridge.log("LIVE: ✅ Received ACK for message " + messageId + " (attempts: " + pendingMessage.retryCount + ")");
        } else {
            Log.w(TAG, "⚠️ Received ACK for untracked message " + messageId);
        }
    }

    /**
     * Process file packet data with reassembly buffer for fragmented BLE notifications.
     * Android BLE delivers notifications larger than MTU in multiple onCharacteristicChanged callbacks.
     * This method buffers fragments until a complete K900 file packet is received.
     *
     * K900 file packet format:
     * ## (2) + type (1) + packSize (2) + packIndex (2) + fileSize (4) + fileName (16) + flags (2) + data (packSize) + verify (1) + $$ (2)
     */
    private void processFilePacketData(byte[] data) {
        if (data == null || data.length == 0) {
            return;
        }

        synchronized (filePacketBufferLock) {
            // Check for buffer overflow
            if (filePacketBufferSize + data.length > filePacketBuffer.length) {
                Log.e(TAG, "File packet buffer overflow, clearing buffer");
                filePacketBufferSize = 0;
                return;
            }

            // Append new data to buffer
            System.arraycopy(data, 0, filePacketBuffer, filePacketBufferSize, data.length);
            filePacketBufferSize += data.length;

            // Try to extract complete packets from buffer
            extractCompleteFilePackets();
        }
    }

    /**
     * Extract and process complete file packets from the reassembly buffer.
     * Must be called within synchronized(filePacketBufferLock) block.
     */
    private void extractCompleteFilePackets() {
        int pos = 0;
        int iterations = 0;
        final int MAX_ITERATIONS = 100;

        // Debug: Log hex dump of first 40 bytes
        StringBuilder hexFirst = new StringBuilder();
        for (int i = 0; i < Math.min(40, filePacketBufferSize); i++) {
            hexFirst.append(String.format("%02X ", filePacketBuffer[i]));
        }
        Bridge.log("LIVE: 📦 extractCompleteFilePackets: buffer has " + filePacketBufferSize +
                  " bytes, first 40: " + hexFirst.toString());

        while (pos < filePacketBufferSize && iterations++ < MAX_ITERATIONS) {
            // Find start marker ## (0x23 0x23)
            int startPos = -1;
            for (int i = pos; i < filePacketBufferSize - 1; i++) {
                if (filePacketBuffer[i] == 0x23 && filePacketBuffer[i + 1] == 0x23) {
                    startPos = i;
                    break;
                }
            }

            if (startPos < 0) {
                // No start marker found, clear buffer
                Bridge.log("LIVE: 📦 No start marker found in " + filePacketBufferSize + " bytes, clearing buffer");
                filePacketBufferSize = 0;
                return;
            }

            // Skip any garbage before start marker
            if (startPos > pos) {
                Bridge.log("LIVE: 📦 Skipping " + (startPos - pos) + " bytes of garbage before start marker");
                pos = startPos;
            }

            // Need at least 5 bytes to read type and packSize: ## (2) + type (1) + packSize (2)
            if (filePacketBufferSize - pos < 5) {
                Bridge.log("LIVE: 📦 Not enough data for header, have " + (filePacketBufferSize - pos) + " bytes, need 5");
                break;
            }

            // Read packSize from header (bytes 3-4, big-endian)
            int packSizeOffset = pos + 3; // Skip ## and type
            int packSize = ((filePacketBuffer[packSizeOffset] & 0xFF) << 8) |
                          (filePacketBuffer[packSizeOffset + 1] & 0xFF);

            // Also try little-endian for comparison
            int packSizeLE = (filePacketBuffer[packSizeOffset] & 0xFF) |
                            ((filePacketBuffer[packSizeOffset + 1] & 0xFF) << 8);
            Bridge.log("LIVE: 📦 Header bytes 3-4: 0x" +
                      String.format("%02X%02X", filePacketBuffer[packSizeOffset], filePacketBuffer[packSizeOffset + 1]) +
                      " -> packSize BE=" + packSize + ", LE=" + packSizeLE);

            // Validate packSize
            if (packSize < 0 || packSize > K900ProtocolUtils.FILE_PACK_SIZE) {
                Log.w(TAG, "Invalid packSize " + packSize + " (LE would be " + packSizeLE + "), skipping start marker");
                pos = startPos + 1;
                continue;
            }

            // Calculate expected total packet size
            // ## (2) + type (1) + packSize (2) + packIndex (2) + fileSize (4) + fileName (16) + flags (2) + data (packSize) + verify (1) + $$ (2)
            int expectedPacketSize = 2 + 1 + 2 + 2 + 4 + 16 + 2 + packSize + 1 + 2;

            // Check if we have the complete packet
            int availableBytes = filePacketBufferSize - pos;
            if (availableBytes < expectedPacketSize) {
                // Not enough data yet, wait for more fragments
                Bridge.log("LIVE: 📦 Waiting for more data: have " + availableBytes +
                          " of " + expectedPacketSize + " bytes (packSize=" + packSize + ")");
                break; // IMPORTANT: break here, don't continue looking for end marker
            }

            // Verify end marker $$ at expected position
            int endMarkerPos = pos + expectedPacketSize - 2;
            byte endByte1 = filePacketBuffer[endMarkerPos];
            byte endByte2 = filePacketBuffer[endMarkerPos + 1];

            // Debug: Show bytes around expected end marker position
            StringBuilder endContext = new StringBuilder();
            for (int i = Math.max(0, endMarkerPos - 5); i <= Math.min(filePacketBufferSize - 1, endMarkerPos + 5); i++) {
                if (i == endMarkerPos) endContext.append("[");
                endContext.append(String.format("%02X", filePacketBuffer[i]));
                if (i == endMarkerPos + 1) endContext.append("]");
                endContext.append(" ");
            }
            Bridge.log("LIVE: 📦 End marker check at pos " + endMarkerPos + ": " + endContext.toString());

            if (endByte1 != 0x24 || endByte2 != 0x24) {
                // End marker not found - could be corrupted packet or wrong packSize interpretation
                Log.w(TAG, "End marker $$ not found at pos " + endMarkerPos +
                      " (found 0x" + String.format("%02X%02X", endByte1, endByte2) +
                      "), packSize=" + packSize + ", expectedPacketSize=" + expectedPacketSize +
                      ", bufferSize=" + filePacketBufferSize + ", skipping start marker");
                pos = startPos + 1;
                continue;
            }

            // Extract complete packet
            byte[] completePacket = new byte[expectedPacketSize];
            System.arraycopy(filePacketBuffer, pos, completePacket, 0, expectedPacketSize);

            Bridge.log("LIVE: 📦 ✅ Complete file packet reassembled: " + expectedPacketSize + " bytes");

            // Process the complete packet
            K900ProtocolUtils.FilePacketInfo packetInfo = K900ProtocolUtils.extractFilePacket(completePacket);
            if (packetInfo != null && packetInfo.isValid) {
                Bridge.log("LIVE: 📦 ✅ Packet validated: index=" + packetInfo.packIndex +
                          ", fileName=" + packetInfo.fileName);
                // Post to handler to process outside the lock
                final K900ProtocolUtils.FilePacketInfo finalPacketInfo = packetInfo;
                handler.post(() -> processFilePacket(finalPacketInfo));
            } else {
                Log.e(TAG, "Failed to extract/validate reassembled file packet");
            }

            pos += expectedPacketSize;
        }

        // Remove processed data from buffer
        if (pos > 0 && pos < filePacketBufferSize) {
            int remaining = filePacketBufferSize - pos;
            System.arraycopy(filePacketBuffer, pos, filePacketBuffer, 0, remaining);
            filePacketBufferSize = remaining;
            Bridge.log("LIVE: 📦 Removed " + pos + " bytes, " + remaining + " bytes remaining in buffer");
        } else if (pos >= filePacketBufferSize) {
            filePacketBufferSize = 0;
        }

        if (iterations >= MAX_ITERATIONS) {
            Log.e(TAG, "extractCompleteFilePackets: max iterations reached, clearing buffer");
            filePacketBufferSize = 0;
        }
    }

    /**
     * Clear the file packet reassembly buffer (call on disconnect)
     */
    private void clearFilePacketBuffer() {
        synchronized (filePacketBufferLock) {
            filePacketBufferSize = 0;
        }
    }

    /**
     * Process data received from the glasses
     */
    private void processReceivedData(byte[] data, int size) {
        // Bridge.log("LIVE: Processing received data: " + bytesToHex(data));

        // Check if we have enough data
        if (data == null || size < 1) {
            Log.w(TAG, "Received empty or invalid data packet");
            return;
        }

        // Log the first few bytes to help with debugging
        StringBuilder hexData = new StringBuilder();
        for (int i = 0; i < Math.min(size, 16); i++) {
            hexData.append(String.format("%02X ", data[i]));
        }
        // Bridge.log("LIVE: Processing data packet, first " + Math.min(size, 16) + " bytes: " + hexData.toString());

        // Get thread ID for consistent logging
        long threadId = Thread.currentThread().getId();

        // First check if this looks like a K900 protocol formatted message (starts with ##)
        if (size >= 7 && data[0] == 0x23 && data[1] == 0x23) {
            Bridge.log("LIVE: Thread-" + threadId + ": 🔍 DETECTED K900 PROTOCOL FORMAT (## prefix)");

            // Check the command type byte
            byte cmdType = data[2];

            // Check if this is a file transfer packet
            if (cmdType == K900ProtocolUtils.CMD_TYPE_PHOTO ||
                cmdType == K900ProtocolUtils.CMD_TYPE_VIDEO ||
                cmdType == K900ProtocolUtils.CMD_TYPE_AUDIO ||
                cmdType == K900ProtocolUtils.CMD_TYPE_DATA) {

                Bridge.log("LIVE: Thread-" + threadId + ": 📦 DETECTED FILE TRANSFER PACKET (type: 0x" +
                      String.format("%02X", cmdType) + ")");

                // Debug: Log the raw data
                StringBuilder hexDump = new StringBuilder();
                for (int i = 0; i < Math.min(data.length, 64); i++) {
                    hexDump.append(String.format("%02X ", data[i]));
                }
                Bridge.log("LIVE: Thread-" + threadId + ": 📦 Raw file packet data length=" + data.length +
                      ", first 64 bytes: " + hexDump.toString());

                // The data IS the file packet - it starts with ## and contains the full file packet structure
                K900ProtocolUtils.FilePacketInfo packetInfo = K900ProtocolUtils.extractFilePacket(data);
                if (packetInfo != null && packetInfo.isValid) {
                    processFilePacket(packetInfo);
                } else {
                    Log.e(TAG, "Thread-" + threadId + ": Failed to extract or validate file packet");
                    // BES chip handles ACKs automatically
                }

                return; // Exit after processing file packet
            }

            // Otherwise it's a normal JSON message
            JSONObject json = K900ProtocolUtils.processReceivedBytesToJson(data);
            if (json != null) {
                processJsonMessage(json);
            } else {
                Log.w(TAG, "Thread-" + threadId + ": Failed to parse K900 protocol data");
            }

            return; // Exit after processing K900 protocol format
        }

        // Check the first byte to determine the packet type for non-protocol formatted data
        byte commandByte = data[0];
        // Bridge.log("LIVE: Command byte: 0x" + String.format("%02X", commandByte) + " (" + (int)(commandByte & 0xFF) + ")");

        // NOTE: LC3 audio (0xA0) is now processed exclusively via the dedicated LC3_READ characteristic
        // This prevents duplicate audio processing and follows the proper BLE characteristic separation

        // Process non-audio data based on command byte
        switch (commandByte) {
            case '{': // Likely a JSON message (starts with '{')
                try {
                    String jsonStr = new String(data, 0, size, StandardCharsets.UTF_8);
                    if (jsonStr.startsWith("{") && jsonStr.endsWith("}")) {
                        JSONObject json = new JSONObject(jsonStr);
                        processJsonMessage(json);
                    } else {
                        Log.w(TAG, "Received data that starts with '{' but is not valid JSON");
                    }
                } catch (JSONException e) {
                    Log.e(TAG, "Error parsing received JSON data", e);
                }
                break;

            default:
                // Unknown packet type (LC3 audio 0xA0 is handled via dedicated characteristic)
                // Log.w(TAG, "Received unknown packet type: " + String.format("0x%02X", commandByte));
                if (size > 10) {
                    // Bridge.log("LIVE: First 10 bytes: " + bytesToHex(Arrays.copyOfRange(data, 0, 10)));
                } else {
                    Bridge.log("LIVE: Data: " + bytesToHex(data));
                }
                break;
        }
    }

    /**
     * Process a JSON message
     */
    private void processJsonMessage(JSONObject json) {
        Bridge.log("LIVE: Got some JSON from glasses: " + json.toString());

        // Check if this is an ACK response
        String type = json.optString("type", "");
        if ("msg_ack".equals(type)) {
            long messageId = json.optLong("mId", -1);
            if (messageId != -1) {
                processAckResponse(messageId);
                return;
            }
        }

        // Check if this is a K900 command format (has "C" field instead of "type")
        if (json.has("C")) {
            processK900JsonMessage(json);
            return;
        }

        switch (type) {
            case "file_announce":
                handleFileTransferAnnouncement(json);
                break;
            case "transfer_timeout":
                handleTransferTimeout(json);
                break;
            case "transfer_failed":
                handleTransferFailed(json);
                break;
            case "ble_photo_ready":
                processBlePhotoReady(json);
                break;
            case "rtmp_stream_status":
                // Process RTMP streaming status update from ASG client
                Bridge.log("LIVE: Received RTMP status update from glasses: " + json.toString());

                // Check if this is an error status
                String status = json.optString("status", "");
                if ("error".equals(status)) {
                    String errorDetails = json.optString("errorDetails", "");
                    Log.e(TAG, "🚨🚨🚨 RTMP STREAM ERROR DETECTED 🚨🚨🚨");
                    Log.e(TAG, "📄 Error details: " + errorDetails);
                    Log.e(TAG, "⏱️ Timestamp: " + System.currentTimeMillis());

                    // Check if it's the timeout error we're investigating
                    if (errorDetails.contains("Stream timed out") || errorDetails.contains("no keep-alive")) {
                        Log.e(TAG, "🔍 RTMP TIMEOUT ERROR - Dumping diagnostic info:");
                        Log.e(TAG, "💓 Last heartbeat counter: " + heartbeatCounter);
                        Log.e(TAG, "⏱️ Current timestamp: " + System.currentTimeMillis());

                        // Dump thread states for debugging
                        dumpThreadStates();

                        // Log BLE connection state
                        Log.e(TAG, "🔌 BLE Connection state:");
                        Log.e(TAG, "   - isConnected: " + isConnected);
                        Log.e(TAG, "   - bluetoothGatt: " + (bluetoothGatt != null ? "NOT NULL" : "NULL"));
                        Log.e(TAG, "   - txCharacteristic: " + (txCharacteristic != null ? "NOT NULL" : "NULL"));
                        Log.e(TAG, "   - rxCharacteristic: " + (rxCharacteristic != null ? "NOT NULL" : "NULL"));
                        Log.e(TAG, "   - connectionState: " + connectionState);
                        Log.e(TAG, "   - glassesReady: " + glassesReady);
                    }
                }

                // Forward to websocket system via Bridge (matches iOS emitRtmpStreamStatus)
                try {
                    Map<String, Object> rtmpMap = new HashMap<>();
                    Iterator<String> keys = json.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        rtmpMap.put(key, json.get(key));
                    }
                    Bridge.sendRtmpStreamStatus(rtmpMap);
                } catch (JSONException e) {
                    Log.e(TAG, "Error converting RTMP status to Map", e);
                }
                break;

            case "battery_status":
                // Process battery status
                int percent = json.optInt("percent", batteryLevel);
                boolean charging = json.optBoolean("charging", isCharging);
                updateBatteryStatus(percent, charging);
                break;

            case "pong":
                // Process heartbeat pong response
                Bridge.log("LIVE: Received pong response - connection healthy");
                break;

            case "imu_response":
            case "imu_stream_response":
            case "imu_gesture_response":
            case "imu_gesture_subscribed":
            case "imu_ack":
            case "imu_error":
                // Handle IMU-related responses
                handleImuResponse(json);
                break;

            case "wifi_status":
                // Process WiFi status information
                boolean wifiConnectedStatus = json.optBoolean("connected", false);
                String ssid = json.optString("ssid", "");
                String localIp = json.optString("local_ip", "");

                updateWifiStatus(wifiConnectedStatus, ssid, localIp);
                break;

            case "hotspot_status_update":
                // Process hotspot status information (same pattern as "wifi_status")
                boolean hotspotEnabled = json.optBoolean("hotspot_enabled", false);
                String hotspotSsid = json.optString("hotspot_ssid", "");
                String hotspotPassword = json.optString("hotspot_password", "");
                String hotspotGatewayIp = json.optString("hotspot_gateway_ip", "");

                updateHotspotStatus(hotspotEnabled, hotspotSsid, hotspotPassword, hotspotGatewayIp);
                break;

            case "hotspot_error":
                // Process hotspot error
                String errorMessage = json.optString("error_message", "Unknown hotspot error");
                long timestamp = json.optLong("timestamp", System.currentTimeMillis());

                handleHotspotError(errorMessage, timestamp);
                break;

            case "photo_response":
                // Process photo response (success or failure)
                String requestId = json.optString("requestId", "");
                String appId = json.optString("appId", "");
                boolean photoSuccess = json.optBoolean("success", false);

                if (!photoSuccess) {
                    // Handle failed photo response
                    String errorMsg = json.optString("error", "Unknown error");
                    Bridge.log("LIVE: Photo request failed - requestId: " + requestId +
                          ", appId: " + appId + ", error: " + errorMsg);
                } else {
                    // Handle successful photo (in future implementation)
                    Bridge.log("LIVE: Photo request succeeded - requestId: " + requestId);
                }
                break;

            case "ble_photo_complete":
                // Process BLE photo transfer completion
                String bleRequestId = json.optString("requestId", "");
                String bleBleImgId = json.optString("bleImgId", "");
                boolean bleSuccess = json.optBoolean("success", false);

                Bridge.log("LIVE: BLE photo transfer complete - requestId: " + bleRequestId +
                     ", bleImgId: " + bleBleImgId + ", success: " + bleSuccess);

                // Send completion notification back to glasses
                if (bleSuccess) {
                    sendBleTransferComplete(bleRequestId, bleBleImgId, true);
                } else {
                    Log.e(TAG, "BLE photo transfer failed for requestId: " + bleRequestId);
                }
                break;

            case "wifi_scan_result":
                // Process WiFi scan results
                List<Map<String, Object>> networks = new ArrayList<>();

                if (json.has("networks_neo")) {
                        try {
                            JSONArray networksNeoArray = json.getJSONArray("networks_neo");

                            for (int i = 0; i < networksNeoArray.length(); i++) {
                                JSONObject networkInfo = networksNeoArray.getJSONObject(i);

                                // Convert JSONObject to Map
                                Map<String, Object> networkMap = new HashMap<>();
                                Iterator<String> keys = networkInfo.keys();
                                while (keys.hasNext()) {
                                    String key = keys.next();
                                    networkMap.put(key, networkInfo.get(key));
                                }
                                networks.add(networkMap);
                            }

                            Bridge.log(
                                "Received enhanced WiFi scan results: " + networks.size() +
                                " networks with security info"
                            );
                        } catch (JSONException e) {
                            Log.e(TAG, "Error parsing networks_neo", e);
                        }
                }

                Bridge.sendWifiScanResults(networks);
                break;

            case "token_status":
                // Process coreToken acknowledgment
                boolean success = json.optBoolean("success", false);
                Bridge.log("LIVE: Received token status from ASG client: " + (success ? "SUCCESS" : "FAILED"));
                break;

            case "ota_update_available":
                // Process OTA update available notification from glasses (background mode)
                Bridge.log("LIVE: 📱 Received ota_update_available from glasses");
                try {
                    long otaVersionCode = json.optLong("version_code", 0);
                    String otaVersionName = json.optString("version_name", "");
                    long otaTotalSize = json.optLong("total_size", 0);

                    // Parse updates array
                    List<String> updates = new ArrayList<>();
                    if (json.has("updates")) {
                        JSONArray updatesArray = json.getJSONArray("updates");
                        for (int i = 0; i < updatesArray.length(); i++) {
                            updates.add(updatesArray.getString(i));
                        }
                    }

                    Bridge.log("LIVE: 📱 OTA available - version: " + otaVersionName +
                          " (" + otaVersionCode + "), updates: " + updates +
                          ", size: " + otaTotalSize + " bytes");

                    // Send to React Native
                    Bridge.sendOtaUpdateAvailable(otaVersionCode, otaVersionName, updates, otaTotalSize);
                } catch (JSONException e) {
                    Log.e(TAG, "Error parsing ota_update_available", e);
                }
                break;

            case "ota_progress":
                // Process OTA progress update from glasses
                String otaStage = json.optString("stage", "download");
                String otaStatus = json.optString("status", "PROGRESS");
                int otaProgress = json.optInt("progress", 0);
                long otaBytesDownloaded = json.optLong("bytes_downloaded", 0);
                long otaTotalBytes = json.optLong("total_bytes", 0);
                String otaCurrentUpdate = json.optString("current_update", "apk");
                String otaErrorMessage = json.optString("error_message", null);

                Bridge.log("LIVE: 📱 OTA progress - " + otaStage + " " + otaStatus +
                      " " + otaProgress + "% (" + otaCurrentUpdate + ")");

                // Send to React Native
                Bridge.sendOtaProgress(otaStage, otaStatus, otaProgress,
                    otaBytesDownloaded, otaTotalBytes, otaCurrentUpdate, otaErrorMessage);
                break;

            case "button_press":
                // Process button press event
                String buttonId = json.optString("buttonId", "unknown");
                String pressType = json.optString("pressType", "short");

                Bridge.log("LIVE: Received button press - buttonId: " + buttonId + ", pressType: " + pressType);

                Bridge.sendButtonPressEvent(buttonId, pressType);
                break;

            case "gallery_status":
                // Process gallery status response
                int photoCount = json.optInt("photos", 0);
                int videoCount = json.optInt("videos", 0);
                int totalCount = json.optInt("total", 0);
                long totalSize = json.optLong("total_size", 0);
                boolean hasContent = json.optBoolean("has_content", false);

                Bridge.log("LIVE: 📸 Received gallery status: " + photoCount + " photos, " +
                      videoCount + " videos, total size: " + totalSize + " bytes");

                // Send gallery status to React Native frontend (matches iOS pattern)
                Bridge.sendGalleryStatus(photoCount, videoCount, totalCount, totalSize, hasContent);
                break;

            case "touch_event":
                // Process touch event from glasses (swipes, taps, long press)
                String gestureName = json.optString("gesture_name", "unknown");
                long touchTimestamp = json.optLong("timestamp", System.currentTimeMillis());
                String touchDeviceModel = json.optString("device_model", glassesDeviceModel);

                Log.d(TAG, "👆 Received touch event - Gesture: " + gestureName);

                // Send touch event to React Native
                Bridge.sendTouchEvent(touchDeviceModel, gestureName, touchTimestamp);
                break;

            case "swipe_volume_status":
                // Process swipe volume control status from glasses
                boolean swipeVolumeEnabled = json.optBoolean("enabled", false);
                long swipeTimestamp = json.optLong("timestamp", System.currentTimeMillis());

                Log.d(TAG, "🔊 Received swipe volume status - Enabled: " + swipeVolumeEnabled);

                // Send swipe volume status to React Native
                Bridge.sendSwipeVolumeStatus(swipeVolumeEnabled, swipeTimestamp);
                break;

            case "switch_status":
                // Process switch status report from glasses
                int switchType = json.optInt("switch_type", -1);
                int switchValue = json.optInt("switch_value", -1);
                long switchTimestamp = json.optLong("timestamp", System.currentTimeMillis());

                Log.d(TAG, "🔘 Received switch status - Type: " + switchType +
                      ", Value: " + switchValue);

                // Send switch status to React Native
                Bridge.sendSwitchStatus(switchType, switchValue, switchTimestamp);
                break;

            case "sensor_data":
                // Process sensor data
                // ...
                break;

            case "glasses_ready":
                // Glasses SOC has booted and is ready for communication
                Bridge.log("LIVE: 🎉 Received glasses_ready message - SOC is booted and ready!");

                // Set the ready flag to stop any future readiness checks
                glassesReady = true;
                glassesReadyReceived = true;

                // Stop the readiness check loop since we got confirmation
                stopReadinessCheckLoop();

                // Send BLE MTU config to glasses so they can adjust file packet sizes.
                // Use the minimum of negotiated MTU and BES2700's known limit (256).
                // BES2700 chip often ignores higher negotiated MTUs and truncates to 253 bytes,
                // but we should respect the actual negotiated value if it's lower.
                final int BES2700_MTU_LIMIT = 256; // BES2700's known notification size limit
                final int effectiveMtu = Math.min(currentMtu, BES2700_MTU_LIMIT);
                Bridge.log("LIVE: 📦 Sending BLE MTU config: negotiated=" + currentMtu + ", BES2700 limit=" + BES2700_MTU_LIMIT + ", effective=" + effectiveMtu);
                sendBleMtuConfig(effectiveMtu);

                // Now we can perform all SOC-dependent initialization
                Bridge.log("LIVE: 🔄 Requesting battery and WiFi status from glasses");
                requestBatteryStatus();
                requestWifiStatus();

                // Request version info from ASG client
                Bridge.log("LIVE: 🔄 Requesting version info from ASG client");
                try {
                    JSONObject versionRequest = new JSONObject();
                    versionRequest.put("type", "request_version");
                    sendJson(versionRequest);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating version request", e);
                }

                Bridge.log("LIVE: 🔄 Sending coreToken to ASG client");
                sendCoreTokenToAsgClient();

                // Send stored user email for crash reporting
                sendStoredUserEmailToAsgClient();

                //startDebugVideoCommandLoop();

                // Start the heartbeat mechanism now that glasses are ready
                startHeartbeat();

                // Start the micbeat mechanism now that glasses are ready
                // startMicBeat();

                // Send user settings to glasses
                sendUserSettings();

                // Claim RGB LED control authority
                // DISABLED: MentraLive is not supposed to send this command
                // sendRgbLedControlAuthority(true);

                // Initialize LC3 audio logging now that glasses are ready
                initializeLc3Logging();
                Bridge.log("LIVE: ✅ LC3 audio logging initialized for device");

                // Audio Pairing: Only mark as fully connected if audio is also ready
                // On Android, CTKD automatically pairs BT Classic when BLE bonds, so audio is always ready
                // This check maintains platform parity with iOS
                if (audioConnected) {
                    Bridge.log("LIVE: Audio: Both glasses_ready and audio connected - marking as fully connected");
                    updateConnectionState(ConnTypes.CONNECTED);
                } else {
                    Bridge.log("LIVE: Audio: Waiting for CTKD audio bonding before marking as fully connected");
                }
                break;

            case "keep_alive_ack":
                // Process keep-alive ACK from ASG client
                Bridge.log("LIVE: Received keep-alive ACK from glasses: " + json.toString());

                // Forward to websocket system via Bridge (matches iOS emitKeepAliveAck)
                try {
                    Map<String, Object> ackMap = new HashMap<>();
                    Iterator<String> keys = json.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        ackMap.put(key, json.get(key));
                    }
                    Bridge.sendKeepAliveAck(ackMap);
                } catch (JSONException e) {
                    Log.e(TAG, "Error converting keep_alive_ack to Map", e);
                }
                break;

            case "version_info_1":
                // Chunk 1 of version info (MTU workaround) - contains basic device info
                Bridge.log("LIVE: Received version_info_1 (chunk 1/2): " + json.toString());
                pendingVersionInfoChunk1 = json;
                // Wait for chunk 2 to arrive before processing
                break;

            case "version_info_2":
                // Chunk 2 of version info (MTU workaround) - contains URLs and identifiers
                Bridge.log("LIVE: Received version_info_2 (chunk 2/2): " + json.toString());

                if (pendingVersionInfoChunk1 != null) {
                    // Merge both chunks and process as complete version_info
                    String appVersionChunked = pendingVersionInfoChunk1.optString("app_version", "");
                    String buildNumberChunked = pendingVersionInfoChunk1.optString("build_number", "");
                    String deviceModelChunked = pendingVersionInfoChunk1.optString("device_model", "");
                    String androidVersionChunked = pendingVersionInfoChunk1.optString("android_version", "");
                    String otaVersionUrlChunked = json.optString("ota_version_url", null);
                    String firmwareVersionChunked = json.optString("firmware_version", "");
                    String btMacAddressChunked = json.optString("bt_mac_address", "");

                    // Update parent SGCManager fields
                    glassesAppVersion = appVersionChunked;
                    glassesBuildNumber = buildNumberChunked;
                    glassesDeviceModel = deviceModelChunked;
                    glassesAndroidVersion = androidVersionChunked;
                    glassesOtaVersionUrl = otaVersionUrlChunked != null ? otaVersionUrlChunked : "";
                    glassesFirmwareVersion = firmwareVersionChunked;
                    glassesBtMacAddress = btMacAddressChunked;

                    // Parse build number as integer for version checks (local field)
                    try {
                        glassesBuildNumberInt = Integer.parseInt(buildNumberChunked);
                        Bridge.log("LIVE: Parsed build number as integer: " + glassesBuildNumberInt);
                    } catch (NumberFormatException e) {
                        glassesBuildNumberInt = 0;
                        Log.e(TAG, "Failed to parse build number as integer: " + buildNumberChunked);
                    }

                    // Determine LC3 audio support: base K900 doesn't support LC3, variants do
                    boolean supportsLC3Audio = !"K900".equals(deviceModelChunked);
                    Bridge.log("LIVE: 📱 LC3 audio support: " + supportsLC3Audio + " (device: " + deviceModelChunked + ")");

                    Bridge.log("LIVE: Glasses Version (from chunks) - App: " + appVersionChunked +
                          ", Build: " + buildNumberChunked +
                          ", Device: " + deviceModelChunked +
                          ", Android: " + androidVersionChunked +
                          ", Firmware: " + firmwareVersionChunked +
                          ", BT MAC: " + btMacAddressChunked +
                          ", OTA URL: " + otaVersionUrlChunked);

                    // Send version info event (matches iOS emitVersionInfo)
                    Bridge.sendVersionInfo(appVersionChunked, buildNumberChunked, deviceModelChunked, androidVersionChunked,
                          otaVersionUrlChunked != null ? otaVersionUrlChunked : "", firmwareVersionChunked, btMacAddressChunked);

                    // Notify CoreManager to update status and send to frontend
                    CoreManager.getInstance().getStatus();

                    // Clear the pending chunk
                    pendingVersionInfoChunk1 = null;
                } else {
                    Bridge.log("LIVE: ⚠️ Received version_info_2 without version_info_1 - ignoring");
                }
                break;

            case "version_info":
                // Process version information from ASG client (legacy single-message format)
                Bridge.log("LIVE: Received version info from ASG client: " + json.toString());

                // Extract version information
                String appVersion = json.optString("app_version", "");
                String buildNumber = json.optString("build_number", "");
                String deviceModel = json.optString("device_model", "");
                String androidVersion = json.optString("android_version", "");
                String otaVersionUrl = json.optString("ota_version_url", null);
                String firmwareVersion = json.optString("firmware_version", "");
                String btMacAddress = json.optString("bt_mac_address", "");

                // Update parent SGCManager fields
                glassesAppVersion = appVersion;
                glassesBuildNumber = buildNumber;
                glassesDeviceModel = deviceModel;
                glassesAndroidVersion = androidVersion;
                glassesOtaVersionUrl = otaVersionUrl != null ? otaVersionUrl : "";
                glassesFirmwareVersion = firmwareVersion;
                glassesBtMacAddress = btMacAddress;

                // Parse build number as integer for version checks (local field)
                try {
                    glassesBuildNumberInt = Integer.parseInt(buildNumber);
                    Bridge.log("LIVE: Parsed build number as integer: " + glassesBuildNumberInt);
                } catch (NumberFormatException e) {
                    glassesBuildNumberInt = 0;
                    Log.e(TAG, "Failed to parse build number as integer: " + buildNumber);
                }

                Bridge.log("LIVE: Glasses Version - App: " + appVersion +
                      ", Build: " + buildNumber +
                      ", Device: " + deviceModel +
                      ", Android: " + androidVersion +
                      ", Firmware: " + firmwareVersion +
                      ", BT MAC: " + btMacAddress +
                      ", OTA URL: " + otaVersionUrl);

                // Send version info event (matches iOS emitVersionInfo)
                Bridge.sendVersionInfo(appVersion, buildNumber, deviceModel, androidVersion,
                      otaVersionUrl != null ? otaVersionUrl : "", firmwareVersion, btMacAddress);

                // Notify CoreManager to update status and send to frontend
                CoreManager.getInstance().getStatus();
                break;

            case "ota_download_progress":
                // Process OTA download progress from ASG client
                Bridge.log("LIVE: 📥 Received OTA download progress from ASG client: " + json.toString());

                // Extract download progress information
                String downloadStatus = json.optString("status", "");
                int downloadProgress = json.optInt("progress", 0);
                long bytesDownloaded = json.optLong("bytes_downloaded", 0);
                long totalBytes = json.optLong("total_bytes", 0);
                String downloadErrorMessage = json.optString("error_message", null);
                long downloadTimestamp = json.optLong("timestamp", System.currentTimeMillis());

                Bridge.log("LIVE: 📥 OTA Download Progress - Status: " + downloadStatus +
                      ", Progress: " + downloadProgress + "%" +
                      ", Bytes: " + bytesDownloaded + "/" + totalBytes +
                      (downloadErrorMessage != null ? ", Error: " + downloadErrorMessage : ""));

                // Emit EventBus event for AugmentosService on main thread
                try {
                    // DownloadProgressEvent.DownloadStatus downloadEventStatus;
                    // final DownloadProgressEvent event;
                    switch (downloadStatus) {
                        case "STARTED":
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.STARTED;
                            // event = new DownloadProgressEvent(downloadEventStatus, totalBytes);
                            break;
                        case "PROGRESS":
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.PROGRESS;
                            // event = new DownloadProgressEvent(downloadEventStatus, downloadProgress, bytesDownloaded, totalBytes);
                            break;
                        case "FINISHED":
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.FINISHED;
                            // event = new DownloadProgressEvent(downloadEventStatus, totalBytes, true);
                            break;
                        case "FAILED":
                            // downloadEventStatus = DownloadProgressEvent.DownloadStatus.FAILED;
                            // event = new DownloadProgressEvent(downloadEventStatus, downloadErrorMessage);
                            break;
                        default:
                            Log.w(TAG, "Unknown download status: " + downloadStatus);
                            return;
                    }

                    // Post event on main thread to ensure proper delivery
                    handler.post(() -> {
                        // Bridge.log("LIVE: 📡 Posting download progress event on main thread: " + downloadEventStatus);
                        // EventBus.getDefault().post(event);
                        // Bridge.
                    });
                } catch (Exception e) {
                    Log.e(TAG, "Error creating download progress event", e);
                }

                // Forward to data observable for cloud communication
                // if (dataObservable != null) {
                    // dataObservable.onNext(json);
                // }
                break;

            case "ota_installation_progress":
                // Process OTA installation progress from ASG client
                Bridge.log("LIVE: 🔧 Received OTA installation progress from ASG client: " + json.toString());

                // Extract installation progress information
                String installationStatus = json.optString("status", "");
                String apkPath = json.optString("apk_path", "");
                String installationErrorMessage = json.optString("error_message", null);
                long installationTimestamp = json.optLong("timestamp", System.currentTimeMillis());

                Bridge.log("LIVE: 🔧 OTA Installation Progress - Status: " + installationStatus +
                      ", APK: " + apkPath +
                      (installationErrorMessage != null ? ", Error: " + installationErrorMessage : ""));

                // Emit EventBus event for AugmentosService on main thread
                try {
                    // InstallationProgressEvent.InstallationStatus installationEventStatus;
                    // final InstallationProgressEvent event;
                    switch (installationStatus) {
                        case "STARTED":
                            // installationEventStatus = InstallationProgressEvent.InstallationStatus.STARTED;
                            // event = new InstallationProgressEvent(installationEventStatus, apkPath);
                            break;
                        case "FINISHED":
                            // installationEventStatus = InstallationProgressEvent.InstallationStatus.FINISHED;
                            // event = new InstallationProgressEvent(installationEventStatus, apkPath);
                            break;
                        case "FAILED":
                            // installationEventStatus = InstallationProgressEvent.InstallationStatus.FAILED;
                            // event = new InstallationProgressEvent(installationEventStatus, apkPath, installationErrorMessage);
                            break;
                        default:
                            // Log.w(TAG, "Unknown installation status: " + installationStatus);
                            return;
                    }

                    // Post event on main thread to ensure proper delivery
                    handler.post(() -> {
                        // Bridge.log("LIVE: 📡 Posting installation progress event on main thread: " + installationEventStatus);
                        // EventBus.getDefault().post(event);
                    });
                } catch (Exception e) {
                    Log.e(TAG, "Error creating installation progress event", e);
                }

                // Forward to data observable for cloud communication
                // if (dataObservable != null) {
                    // dataObservable.onNext(json);
                // }
                break;

            case "mtk_update_complete":
                // Process MTK firmware update complete notification from ASG client
                Bridge.log("LIVE: 🔄 Received MTK update complete from ASG client");

                String updateMessage = json.optString("message", "MTK firmware updated. Please restart glasses.");
                long updateTimestamp = json.optLong("timestamp", System.currentTimeMillis());

                Bridge.log("LIVE: 🔄 MTK Update Message: " + updateMessage);

                // Send to React Native via Bridge on main thread
                handler.post(() -> {
                    Bridge.sendMtkUpdateComplete(updateMessage);
                });
                break;

            default:
                Log.d(TAG, "📦 Unknown message type: " + type);
                // Pass the data to the subscriber for custom processing
                // if (dataObservable != null) {
                    // dataObservable.onNext(json);
                // }
                break;
        }
    }

    /**
     * Process K900 command format JSON messages (messages with "C" field)
     */
    /**
     * Process BLE photo ready notification from glasses
     */
    private void processBlePhotoReady(JSONObject json) {
        try {
            String bleImgId = json.optString("bleImgId", "");
            String requestId = json.optString("requestId", "");
            long compressionDurationMs = json.optLong("compressionDurationMs", 0);

            Bridge.log("LIVE: 📸 BLE photo ready notification: bleImgId=" + bleImgId + ", requestId=" + requestId);

            // Update the transfer with glasses compression duration
            BlePhotoTransfer transfer = blePhotoTransfers.get(bleImgId);
            if (transfer != null) {
                transfer.glassesCompressionDurationMs = compressionDurationMs;
                transfer.bleTransferStartTime = System.currentTimeMillis();  // BLE transfer starts now
                Bridge.log("LIVE: ⏱️ Glasses compression took: " + compressionDurationMs + "ms");
            } else {
                Log.w(TAG, "Received ble_photo_ready for unknown transfer: " + bleImgId);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error processing ble_photo_ready", e);
        }
    }

    /**
     * Handle transfer timeout notification from glasses
     */
    private void handleTransferTimeout(JSONObject json) {
        try {
            String fileName = json.optString("fileName", "");

            Log.e(TAG, "⏰ Transfer timeout notification received for: " + fileName);

            if (!fileName.isEmpty()) {
                // Clean up any active transfer for this file
                FileTransferSession session = activeFileTransfers.remove(fileName);
                if (session != null) {
                    Bridge.log("LIVE: 🧹 Cleaned up timed out transfer session for: " + fileName);
                    Bridge.log("LIVE: 📊 Transfer stats - Received: " + session.receivedPackets.size() + "/" + session.totalPackets + " packets");
                }

                // Clean up any BLE photo transfer
                String bleImgId = fileName;
                int dotIndex = bleImgId.lastIndexOf('.');
                if (dotIndex > 0) {
                    bleImgId = bleImgId.substring(0, dotIndex);
                }
                BlePhotoTransfer photoTransfer = blePhotoTransfers.remove(bleImgId);
                if (photoTransfer != null) {
                    Bridge.log("LIVE: 🧹 Cleaned up timed out BLE photo transfer for: " + bleImgId);
                }
            }

        } catch (Exception e) {
            Log.e(TAG, "⏰ Error processing transfer timeout notification", e);
        }
    }

    /**
     * Handle transfer failed notification from glasses
     * Matches iOS MentraLive.swift handleTransferFailed pattern
     */
    private void handleTransferFailed(JSONObject json) {
        try {
            String fileName = json.optString("fileName", "");
            String reason = json.optString("reason", "unknown");

            if (fileName.isEmpty()) {
                Log.e(TAG, "❌ Transfer failed notification missing fileName: " + json.toString());
                return;
            }

            Log.e(TAG, "❌ Transfer failed for: " + fileName + " (reason: " + reason + ")");

            // Clean up any active transfer for this file
            FileTransferSession session = activeFileTransfers.remove(fileName);
            if (session != null) {
                Bridge.log("LIVE: 📊 Transfer stats - Received: " + session.receivedPackets.size() + "/" + session.totalPackets + " packets");
            }

            // Clean up any BLE photo transfer
            String bleImgId = fileName;
            int dotIndex = bleImgId.lastIndexOf('.');
            if (dotIndex > 0) {
                bleImgId = bleImgId.substring(0, dotIndex);
            }
            BlePhotoTransfer photoTransfer = blePhotoTransfers.remove(bleImgId);
            if (photoTransfer != null) {
                Bridge.log("LIVE: 🧹 Cleaned up failed BLE photo transfer for: " + bleImgId + " (requestId: " + photoTransfer.requestId + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "❌ Error processing transfer failed notification", e);
        }
    }

    /**
     * Handle file transfer announcement from glasses
     */
    private void handleFileTransferAnnouncement(JSONObject json) {
        try {
            // Extract data directly from JSON (same format as version_info)
            String fileName = json.optString("fileName", "");
            int totalPackets = json.optInt("totalPackets", 0);
            int fileSize = json.optInt("fileSize", 0);

            Bridge.log("LIVE: 📢 File transfer announcement: " + fileName + ", " + totalPackets + " packets, " + fileSize + " bytes");

            if (fileName.isEmpty() || totalPackets <= 0) {
                Log.w(TAG, "📢 Invalid file transfer announcement");
                return;
            }

            // Create announced file transfer session
            FileTransferSession session = new FileTransferSession(fileName, fileSize);
            // Override calculated packet count with announced count for accuracy
            session.totalPackets = totalPackets;
            activeFileTransfers.put(fileName, session);

            Bridge.log("LIVE: 📢 Prepared to receive " + totalPackets + " packets for " + fileName);

        } catch (Exception e) {
            Log.e(TAG, "📢 Error processing file transfer announcement", e);
        }
    }

    private void processK900JsonMessage(JSONObject json) {
        String command = json.optString("C", "");
        Bridge.log("LIVE: Processing K900 command: " + command);

        switch (command) {
            case "sr_hrt":
                try {
                    JSONObject bodyObj = json.optJSONObject("B");
                    if (bodyObj != null) {

                        int batteryPercentage = bodyObj.optInt("pt", -1);
                        int ready = bodyObj.optInt("ready", 0);
                        if (ready == 0 && batteryPercentage > 0 && batteryPercentage <= 20) {
                            Bridge.log("LIVE: K900 battery percentage: " + batteryPercentage);
                            Bridge.sendPairFailureEvent("errors:pairingBatteryTooLow");
                            return;
                        }
                        if (ready == 1) {
                            Bridge.log("LIVE: K900 SOC ready");
                            // Only send phone_ready if we haven't already established connection
                            // This prevents re-initialization on every heartbeat after initial connection
                            // The glassesReady flag is reset on disconnect/reconnect, so this won't prevent proper reconnection
                            if (!glassesReady) {
                                Bridge.log("LIVE: 📱 Sending phone_ready to glasses - waiting for glasses_ready response");
                                JSONObject readyMsg = new JSONObject();
                                readyMsg.put("type", "phone_ready");
                                readyMsg.put("timestamp", System.currentTimeMillis());

                                // Send it through our data channel
                                sendJson(readyMsg, true);
                            } else {
                                Bridge.log("LIVE: ✅ Glasses already marked as ready, skipping phone_ready");
                            }
                        }
                        int charg = bodyObj.optInt("charg", -1);
                        if (batteryPercentage != -1 && charg != -1)
                            updateBatteryStatus(batteryPercentage, charg == 1);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error parsing sr_hrt response", e);
                }
                break;
            case "sr_batv":
                // K900 battery voltage response
                try {
                    JSONObject bodyObj = json.optJSONObject("B");
                    if (bodyObj != null) {
                        int voltageMillivolts = bodyObj.optInt("vt", 0);
                        int batteryPercentage = bodyObj.optInt("pt", 0);

                        // Convert to volts for logging
                        double voltageVolts = voltageMillivolts / 1000.0;

                        Bridge.log("LIVE: 🔋 K900 Battery Status - Voltage: " + voltageVolts + "V (" + voltageMillivolts + "mV), Level: " + batteryPercentage + "%");

                        // Determine charging status based on voltage (K900 typical charging voltage is >4.0V)
                        boolean isCharging = voltageMillivolts > 4000;

                        // Update battery status using the existing method
                        updateBatteryStatus(batteryPercentage, isCharging);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error parsing sr_batv response", e);
                }
                break;

            case "sr_shut":
                Bridge.log("LIVE: K900 shutdown command received - glasses shutting down");
                // // Mark as killed to prevent reconnection attempts
                // isKilled = true;
                // // Clean disconnect without reconnection
                // if (bluetoothGatt != null) {
                //     Bridge.log("LIVE: Disconnecting from glasses due to shutdown");
                //     bluetoothGatt.disconnect();
                // }
                // Notify the system that glasses are intentionally disconnected
                updateConnectionState(ConnTypes.DISCONNECTED);
                break;

            default:
                Log.d(TAG, "Unknown K900 command: " + command);

                // Check if this is a C-wrapped standard JSON message (not a true K900 command)
                // This happens when ASG Client sends standard JSON messages through K900BluetoothManager
                // which automatically C-wraps them
                try {
                    // Try to parse the "C" field as JSON
                    JSONObject innerJson = new JSONObject(command);

                    // If it has a "type" field, it's a standard message that got C-wrapped
                    if (innerJson.has("type")) {
                        String messageType = innerJson.optString("type", "");
                        Log.d(TAG, "📦 Detected C-wrapped standard JSON message with type: " + messageType);
                        Log.d(TAG, "🔓 Unwrapping and processing through standard message handler");

                        // Process through the standard message handler
                        processJsonMessage(innerJson);
                        return; // Exit after processing
                    }
                } catch (JSONException e) {
                    // Not valid JSON or doesn't have type field - treat as unknown K900 command
                    Log.d(TAG, "Command is not a C-wrapped JSON message, passing to data observable");
                }

                // Pass to data observable for custom processing
                // if (dataObservable != null) {
                    // dataObservable.onNext(json);
                // }
                break;
        }
    }

    /**
     * Send the coreToken to the ASG client for direct backend authentication
     */
    private void sendCoreTokenToAsgClient() {
        Bridge.log("LIVE: Preparing to send coreToken to ASG client");

        // Get the coreToken from SharedPreferences
        SharedPreferences prefs = context.getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE);
        String coreToken = prefs.getString(KEY_CORE_TOKEN, null);

        if (coreToken == null || coreToken.isEmpty()) {
            Log.e(TAG, "No coreToken available to send to ASG client");
            return;
        }

        try {
            // Create a JSON object with the token
            JSONObject tokenMsg = new JSONObject();
            tokenMsg.put("type", "auth_token");
            tokenMsg.put("coreToken", coreToken);
            tokenMsg.put("timestamp", System.currentTimeMillis());

            // Send the JSON object
            Bridge.log("LIVE: Sending coreToken to ASG client");
            sendJson(tokenMsg);

        } catch (JSONException e) {
            Log.e(TAG, "Error creating coreToken JSON message", e);
        }
    }

    /**
     * Send stored user email to the ASG client for Sentry crash reporting
     */
    private void sendStoredUserEmailToAsgClient() {
        String storedEmail = CoreManager.Companion.getInstance().getStoredUserEmail();

        if (storedEmail == null || storedEmail.isEmpty()) {
            Bridge.log("LIVE: No stored user email to send to ASG client");
            return;
        }

        Bridge.log("LIVE: Sending stored user email to ASG client");
        sendUserEmailToGlasses(storedEmail);
    }

    /**
     * Convert bytes to hex string for debugging
     */
    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X ", b));
        }
        return sb.toString();
    }

    /**
     * Request battery status from the glasses
     */
    private void requestBatteryStatus() {
        //JSONObject json = new JSONObject();
        //json.put("type", "request_battery_state");
        //sendDataToGlasses(json.toString());

        requestBatteryK900();
    }

    /**
     * Update battery status and notify listeners
     * Matches iOS MentraLive.swift updateBatteryStatus pattern
     */
    private void updateBatteryStatus(int level, boolean charging) {
        // Update parent SGCManager fields
        batteryLevel = level;  // Parent class field
        isCharging = charging;  // Local field

        // Notify CoreManager to update status and send to frontend
        CoreManager.getInstance().getStatus();
    }

    /**
     * Update WiFi status and notify listeners
     * Matches iOS MentraLive.swift updateWifiStatus pattern
     */
    private void updateWifiStatus(boolean connected, String ssid, String localIp) {
        Bridge.log("LIVE: 🌐 Updating WiFi status - connected: " + connected + ", SSID: " + ssid);

        // Update parent SGCManager fields
        wifiConnected = connected;
        wifiSsid = ssid;
        wifiLocalIp = localIp;

        // Send event to bridge for cloud communication
        Bridge.sendWifiStatusChange(connected, ssid, localIp);
    }

    /**
     * Update hotspot status and notify listeners
     * Matches iOS MentraLive.swift updateHotspotStatus pattern
     */
    private void updateHotspotStatus(boolean enabled, String ssid, String password, String gatewayIp) {
        Bridge.log("LIVE: 🔥 Updating hotspot status - enabled: " + enabled + ", SSID: " + ssid);

        // Update parent SGCManager fields
        isHotspotEnabled = enabled;
        hotspotSsid = ssid;
        hotspotPassword = password;
        hotspotGatewayIp = gatewayIp;

        // Send hotspot status change event (matches iOS emitHotspotStatusChange)
        Bridge.sendHotspotStatusChange(enabled, ssid, password, gatewayIp);

        // Trigger a full status update so React Native gets the updated glasses_info
        CoreManager.getInstance().getStatus();
    }

    /**
     * Handle hotspot error and notify React Native
     */
    private void handleHotspotError(String errorMessage, long timestamp) {
        Bridge.log("LIVE: 🔥 ❌ Hotspot error: " + errorMessage);

        // Send hotspot error event to React Native
        Bridge.sendHotspotError(errorMessage, timestamp);
    }

    /**
     * Send battery status to connected phone via BLE
     */
    private void sendBatteryStatusOverBle(int level, boolean charging) {
        if (isConnected && bluetoothGatt != null) {
            try {
                JSONObject batteryStatus = new JSONObject();
                batteryStatus.put("type", "battery_status");
                batteryStatus.put("level", level);
                batteryStatus.put("charging", charging);
                batteryStatus.put("timestamp", System.currentTimeMillis());

                // Convert to string and send via BLE
                String jsonString = batteryStatus.toString();
                Bridge.log("LIVE: 🔋 Sending battery status via BLE: " + level + "% " + (charging ? "(charging)" : "(not charging)"));
                sendDataToGlasses(jsonString, false);

            } catch (JSONException e) {
                Log.e(TAG, "Error creating battery status JSON", e);
            }
        } else {
            Bridge.log("LIVE: Cannot send battery status - not connected to BLE device");
        }
    }

    /**
     * Request WiFi status from the glasses
     */
    private void requestWifiStatus() {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "request_wifi_status");
            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi status request", e);
        }
    }

    /**
     * Request WiFi scan from the glasses
     * This will ask the glasses to scan for available networks
     */
    @Override
    public void requestWifiScan() {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "request_wifi_scan");
            sendJson(json, true);
            Bridge.log("LIVE: Sending WiFi scan request to glasses");
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi scan request", e);
        }
    }

    /**
     * Query gallery status from the glasses
     */
    @Override
    public void queryGalleryStatus() {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "query_gallery_status");
            sendJson(json, true);
            Bridge.log("LIVE: 📸 Sending gallery status query to glasses");
        } catch (JSONException e) {
            Log.e(TAG, "📸 Error creating gallery status query", e);
        }
    }

    /**
     * Send OTA start command to glasses.
     * Called when user approves an update (onboarding or background mode).
     * Triggers glasses to begin download and installation.
     */
    public void sendOtaStart() {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "ota_start");
            json.put("timestamp", System.currentTimeMillis());
            sendJson(json, true);
            Bridge.log("LIVE: 📱 Sending ota_start command to glasses");
        } catch (JSONException e) {
            Log.e(TAG, "📱 Error creating ota_start command", e);
        }
    }

    @Override
    public void sendGalleryMode() {
        boolean active = CoreManager.getInstance().getGalleryMode();
        Bridge.log("LIVE: 📸 Sending gallery mode active to glasses: " + active);
        try {
            JSONObject json = new JSONObject();
            json.put("type", "save_in_gallery_mode");
            json.put("active", active);
            json.put("timestamp", System.currentTimeMillis());
            sendJson(json, true);
            Bridge.log("LIVE: 📸 ✅ Gallery mode command sent successfully");
        } catch (JSONException e) {
            Log.e(TAG, "📸 💥 Error creating gallery mode JSON", e);
        }
    }

    /**
     * Send heartbeat ping to glasses and handle periodic battery requests
     */
    private void sendHeartbeat() {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            Bridge.log("LIVE: Skipping heartbeat - glasses not ready or not connected");
            return;
        }

        try {
            // Send ping message (no ACK needed for heartbeats)
            JSONObject pingMsg = new JSONObject();
            pingMsg.put("type", "ping");
            sendJsonWithoutAck(pingMsg);

            // Send custom audio TX command
            // sendEnableCustomAudioTxMessage(shouldUseGlassesMic);

            // Increment heartbeat counter
            heartbeatCounter++;
            Bridge.log("LIVE: 💓 Heartbeat #" + heartbeatCounter + " sent");

            // Request battery status every N heartbeats
            if (heartbeatCounter % BATTERY_REQUEST_EVERY_N_HEARTBEATS == 0) {
                Bridge.log("LIVE: 🔋 Requesting battery status (heartbeat #" + heartbeatCounter + ")");
                requestBatteryStatus();
            }

        } catch (JSONException e) {
            Log.e(TAG, "Error creating heartbeat message", e);
        }
    }

    /**
     * Start the heartbeat mechanism
     */
    private void startHeartbeat() {
        // Bridge.log("LIVE: 💓 Starting heartbeat mechanism");
        heartbeatCounter = 0;
        heartbeatHandler.removeCallbacks(heartbeatRunnable); // Remove any existing callbacks
        heartbeatHandler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS);

        // Also start test messages for ACK verification
        // startTestMessages();
    }

    /**
     * Stop the heartbeat mechanism
     */
    private void stopHeartbeat() {
        Bridge.log("LIVE: 💓 Stopping heartbeat mechanism");
        heartbeatHandler.removeCallbacks(heartbeatRunnable);
        heartbeatCounter = 0;

        // Also stop test messages
        // stopTestMessages();
    }

    /**
     * Start the micbeat mechanism - periodically enable custom audio TX
     */
    private void startMicBeat() {
        // Bridge.log("LIVE: 🎤 Starting micbeat mechanism");
        micBeatCount = 0;

        // Initialize custom audio TX immediately
        sendEnableCustomAudioTxMessage(shouldUseGlassesMic);

        micBeatRunnable = new Runnable() {
            @Override
            public void run() {
                Bridge.log("LIVE: 🎤 Sending micbeat - enabling custom audio TX");
                
                
                sendEnableCustomAudioTxMessage(true);
                micBeatCount++;

                // Schedule next micbeat
                micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS);
            }
        };

        micBeatHandler.removeCallbacks(micBeatRunnable); // Remove any existing callbacks
        micBeatHandler.postDelayed(micBeatRunnable, MICBEAT_INTERVAL_MS);
    }

    /**
     * Stop the micbeat mechanism
     */
    private void stopMicBeat() {
        // Bridge.log("LIVE: 🎤 Stopping micbeat mechanism");
        sendEnableCustomAudioTxMessage(false);
        micBeatHandler.removeCallbacks(micBeatRunnable);
        micBeatCount = 0;
    }

    /**
     * Send a periodic test message to verify ACK system
     */
    private void sendTestMessage() {
        if (!glassesReady || connectionState != ConnTypes.CONNECTED) {
            Bridge.log("LIVE: Skipping test message - glasses not ready or not connected");
            return;
        }

        try {
            testMessageCounter++;
            JSONObject testMsg = new JSONObject();
            testMsg.put("type", "test_message");
            testMsg.put("counter", testMessageCounter);
            testMsg.put("timestamp", System.currentTimeMillis());
            testMsg.put("message", "ACK test message #" + testMessageCounter);
            testMsg.put("deviceId", deviceId); // Include device ID for debugging

            Bridge.log("LIVE: 🧪 Sending test message #" + testMessageCounter + " for ACK verification");
            sendJson(testMsg, true); // This will include esoteric mId and ACK tracking

        } catch (JSONException e) {
            Log.e(TAG, "Error creating test message", e);
        }
    }

    /**
     * Start the periodic test message system
     */
    private void startTestMessages() {
        Bridge.log("LIVE: 🧪 Starting periodic test message system (every " + TEST_MESSAGE_INTERVAL_MS + "ms)");
        testMessageCounter = 0;
        testMessageHandler.removeCallbacks(testMessageRunnable); // Remove any existing callbacks
        testMessageHandler.postDelayed(testMessageRunnable, TEST_MESSAGE_INTERVAL_MS);
    }

    /**
     * Stop the periodic test message system
     */
    private void stopTestMessages() {
        Bridge.log("LIVE: 🧪 Stopping periodic test message system");
        testMessageHandler.removeCallbacks(testMessageRunnable);
        testMessageCounter = 0;
    }

    /**
     * Dump all thread states for debugging BLE failures
     */
    private void dumpThreadStates() {
        Log.e(TAG, "📸 THREAD STATE DUMP - START");
        try {
            Map<Thread, StackTraceElement[]> allThreads = Thread.getAllStackTraces();
            for (Map.Entry<Thread, StackTraceElement[]> entry : allThreads.entrySet()) {
                Thread thread = entry.getKey();
                StackTraceElement[] stack = entry.getValue();

                Log.e(TAG, "📌 Thread: " + thread.getName() +
                      " (ID: " + thread.getId() +
                      ", State: " + thread.getState() +
                      ", Priority: " + thread.getPriority() + ")");

                // Only print first 5 stack frames to avoid log spam
                for (int i = 0; i < Math.min(5, stack.length); i++) {
                    Log.e(TAG, "    at " + stack[i].toString());
                }
                if (stack.length > 5) {
                    Log.e(TAG, "    ... " + (stack.length - 5) + " more frames");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error dumping thread states", e);
        }
        Log.e(TAG, "📸 THREAD STATE DUMP - END");
    }

    /**
     * Check if we have the necessary permissions
     */
    private boolean hasPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
                   PackageManager.PERMISSION_GRANTED;
        } else {
            return ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH) ==
                   PackageManager.PERMISSION_GRANTED;
        }
    }

    // Helper method for permission checking when needed in different contexts
    private boolean checkPermission() {
        return hasPermissions();
    }

    // SmartGlassesCommunicator interface implementation

    @Override
    public void findCompatibleDevices() {
        Bridge.log("LIVE: Finding compatible Mentra Live glasses");
        
        // Clear reconnection mode when user manually scans
        isReconnecting = false;

        if (bluetoothAdapter == null) {
            Log.e(TAG, "Bluetooth not available");
            return;
        }

        if (!bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Bluetooth is not enabled");
            return;
        }

        // Start scanning for BLE devices
        startScan();
    }

    public void connectById(String id) {
        Bridge.log("LIVE: Connecting to Mentra Live glasses by ID: " + id);
        savedDeviceName = id;
        connectToSmartGlasses();
    }

    public void forget() {
        Bridge.log("LIVE: Forgetting Mentra Live glasses");

        // Clear saved device name to prevent reconnection to this device
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().remove(PREF_DEVICE_NAME).apply();
        Bridge.log("LIVE: Cleared saved device name");

        // Reset reconnection state
        reconnectAttempts = 0;
        isReconnecting = false;

        stopScan();
        disconnect();
    }

    public void disconnect() {
        Bridge.log("LIVE: Disconnecting from Mentra Live glasses");
        destroy();
    }

    public void exit() {
        Bridge.log("LIVE: [STUB]");
    }

    public void setSilentMode(boolean enabled) {

    }

    public void getBatteryStatus() {

    }

    public void setHeadUpAngle(int angle) {

    }

    public void setDashboardPosition(int height, int depth) {

    }

    public void showDashboard() {

    }

    public boolean displayBitmap(String base64) {
        return false;
    }

    public void connectToSmartGlasses() {
        Bridge.log("LIVE: Connecting to Mentra Live glasses");
        updateConnectionState(ConnTypes.CONNECTING);
        
        // Clear reconnection mode when user manually initiates connection
        isReconnecting = false;

        if (isConnected) {
            Bridge.log("LIVE: #@32 Already connected to Mentra Live glasses");
            updateConnectionState(ConnTypes.CONNECTED);
            return;
        }

        if (bluetoothAdapter == null) {
            Bridge.log("LIVE: Bluetooth not available");
            updateConnectionState(ConnTypes.DISCONNECTED);
            return;
        }

        if (!bluetoothAdapter.isEnabled()) {
            Bridge.log("LIVE: Bluetooth is not enabled");
            updateConnectionState(ConnTypes.DISCONNECTED);
            return;
        }

        // Get last known device address
        // var context = Bridge.getContext();
        // SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        // String lastDeviceAddress = prefs.getString(PREF_DEVICE_NAME, null);
        String lastDeviceAddress = CoreManager.getInstance().getDeviceAddress();

        if (lastDeviceAddress != null && lastDeviceAddress.length() > 0) {
            // Connect to last known device if available
            Bridge.log("LIVE: Attempting to connect to last known device: " + lastDeviceAddress);
            try {
                BluetoothDevice device = bluetoothAdapter.getRemoteDevice(lastDeviceAddress);
                if (device != null) {
                    Bridge.log("LIVE: Found saved device, connecting directly: " + lastDeviceAddress);
                    connectToDevice(device);
                } else {
                    Bridge.log("LIVE: ERROR: Could not create device from address: " + lastDeviceAddress);
                    updateConnectionState(ConnTypes.DISCONNECTED);
                    startScan(); // Fallback to scanning
                }
            } catch (Exception e) {
                Bridge.log("LIVE: ERROR: Error connecting to saved device: " + e.getMessage());
                updateConnectionState(ConnTypes.DISCONNECTED);
                startScan(); // Fallback to scanning
            }
        } else {
            // If no last known device, start scanning for devices
            Bridge.log("LIVE: No last known device, starting scan");
            startScan();
        }
    }

    public void setMicEnabled(boolean enable) {
        Bridge.log("LIVE: 🎤 Microphone state changed: " + enable);

        // Update the microphone state tracker
        isMicrophoneEnabled = enable;
        
        micEnabled = enable;

        // Post event for frontend notification
        // EventBus.getDefault().post(new isMicEnabledForFrontendEvent(enable));

        // Update the shouldUseGlassesMic flag to reflect the current state
        var m = CoreManager.getInstance();
        this.shouldUseGlassesMic = enable;
        Bridge.log("LIVE: 🎤 Updated shouldUseGlassesMic to: " + shouldUseGlassesMic);

        if (this.shouldUseGlassesMic) {
            Bridge.log("LIVE: 🎤 Microphone enabled, starting audio input handling");
            startMicBeat();
        } else {
            Bridge.log("LIVE: 🎤 Microphone disabled, stopping audio input handling");
            stopMicBeat();
        }
    }

    /**
     * Returns whether the microphone is currently enabled
     * @return true if microphone is enabled, false otherwise
     */
    public boolean isMicrophoneEnabled() {
        return isMicrophoneEnabled;
    }

    public void requestPhoto(String requestId, String appId, String size, String webhookUrl, String authToken, String compress, boolean silent) {
        Bridge.log("LIVE: Requesting photo: " + requestId + " for app: " + appId + " with size: " + size + ", webhookUrl: " + webhookUrl + ", authToken: " + (authToken.isEmpty() ? "none" : "***") + ", compress=" + compress + ", silent=" + silent);

        try {
            JSONObject json = new JSONObject();
            json.put("type", "take_photo");
            json.put("requestId", requestId);
            json.put("appId", appId);
            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                json.put("webhookUrl", webhookUrl);
            }
            if (authToken != null && !authToken.isEmpty()) {
                json.put("authToken", authToken);
            }
            if (size != null && !size.isEmpty()) {
                json.put("size", size);
            }
            if (compress != null && !compress.isEmpty()) {
                json.put("compress", compress);
            } else {
                json.put("compress", "none");
            }
            // silent mode: disables shutter sound and privacy LED
            json.put("silent", silent);

            // Always generate BLE ID for potential fallback
            String bleImgId = "I" + String.format("%09d", System.currentTimeMillis() % 1000000000);
            json.put("bleImgId", bleImgId);

            // Use auto mode by default - glasses will decide based on connectivity
            json.put("transferMethod", "auto");

            // Always prepare for potential BLE transfer
            if (webhookUrl != null && !webhookUrl.isEmpty()) {
                // Store the transfer info for BLE route - include authToken
                BlePhotoTransfer transfer = new BlePhotoTransfer(bleImgId, requestId, webhookUrl);
                transfer.setAuthToken(authToken); // Store authToken for BLE transfer
                blePhotoTransfers.put(bleImgId, transfer);
            }

            Bridge.log("LIVE: Using auto transfer mode with BLE fallback ID: " + bleImgId);

            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo request JSON", e);
        }
    }

    @Override
    public void startRtmpStream(Map<String, Object> message) {
        Bridge.log("LIVE: Starting RTMP stream");

        try {
            JSONObject json = new JSONObject(message);
            // Remove timestamp as iOS does
            json.remove("timestamp");
            sendJson(json, true);
        } catch (Exception e) {
            Log.e(TAG, "Error creating RTMP stream start JSON", e);
        }
    }

    public void stopRtmpStream() {
        Bridge.log("LIVE: Requesting to stop RTMP stream");
        try {
            JSONObject json = new JSONObject();
            json.put("type", "stop_rtmp_stream");

            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating RTMP stream stop JSON", e);
        }
    }

    @Override
    public void sendRtmpKeepAlive(Map<String, Object> message) {
        Bridge.log("LIVE: Sending RTMP stream keep alive");

        try {
            JSONObject json = new JSONObject(message);
            sendJson(json);
        } catch (Exception e) {
            Log.e(TAG, "Error sending RTMP stream keep alive", e);
        }
    }

    /**
     * Track a BLE photo transfer request
     */
    private void trackBlePhotoTransfer(String bleImgId, String requestId, String webhookUrl) {
        BlePhotoTransfer transfer = new BlePhotoTransfer(bleImgId, requestId, webhookUrl);
        blePhotoTransfers.put(bleImgId, transfer);
        Bridge.log("LIVE: Tracking BLE photo transfer - bleImgId: " + bleImgId + ", requestId: " + requestId);
    }

    /**
     * Check if the ASG client is connected to WiFi
     * @return true if connected to WiFi, false otherwise
     */
    public boolean isGlassesWifiConnected() {
        return wifiConnected;  // Using parent SGCManager field
    }

    /**
     * Get the SSID of the WiFi network the ASG client is connected to
     * @return SSID string, or empty string if not connected
     */
    public String getGlassesWifiSsid() {
        return wifiSsid;
    }

    /**
     * Manually request a WiFi status update from the ASG client
     */
    public void refreshGlassesWifiStatus() {
        if (isConnected) {
            requestWifiStatus();
        }
    }

    @Override
    public String getConnectedBluetoothName() {
        if (connectedDevice != null && connectedDevice.getName() != null) {
            return connectedDevice.getName();
        }
        return "";
    }

    // Debug video command loop vars
    private Runnable debugVideoCommandRunnable;
    private int debugCommandCounter = 0;
    private static final int DEBUG_VIDEO_INTERVAL_MS = 5000; // 5 seconds

    // SOC readiness check parameters
    private static final int READINESS_CHECK_INTERVAL_MS = 2500; // every 2.5 seconds
    private Runnable readinessCheckRunnable;
    private int readinessCheckCounter = 0;
    //private boolean glassesReady = false; // Track if glasses have confirmed they're ready

    /**
     * Starts the glasses SOC readiness check loop
     * This sends a "phone_ready" message every 5 seconds until
     * we receive a "glasses_ready" response, indicating the SOC is booted
     */
    private void startReadinessCheckLoop() {
        // Stop any existing readiness check
        stopReadinessCheckLoop();

        // Reset counter and ready flag
        readinessCheckCounter = 0;
        glassesReady = false;

        Bridge.log("LIVE: 🔄 Starting glasses SOC readiness check loop");

        readinessCheckRunnable = new Runnable() {
            @Override
            public void run() {
                if (isConnected && !isKilled && !glassesReady) {
                    readinessCheckCounter++;

                    Bridge.log("LIVE: 🔄 Readiness check #" + readinessCheckCounter + ": waiting for glasses SOC to boot");
                    requestReadyK900();


                    // Schedule next check only if glasses are still not ready
                    if (!glassesReady) {
                        handler.postDelayed(this, READINESS_CHECK_INTERVAL_MS);
                    }
                } else {
                    Bridge.log("LIVE: 🔄 Readiness check loop stopping - connected: " + isConnected +
                          ", killed: " + isKilled + ", glassesReady: " + glassesReady);
                }
            }
        };

        // Start the loop
        handler.post(readinessCheckRunnable);
    }

    /**
     * Stops the glasses SOC readiness check loop
     */
    private void stopReadinessCheckLoop() {
        if (readinessCheckRunnable != null) {
            handler.removeCallbacks(readinessCheckRunnable);
            readinessCheckRunnable = null;
            Bridge.log("LIVE: 🔄 Stopped glasses SOC readiness check loop");
        }
    }

    // ============================================================================
    // CTKD (Cross-Transport Key Derivation) Implementation for BES Devices
    // ============================================================================

    /**
     * Initialize the bonding receiver for CTKD support
     */
    private void initializeBondingReceiver() {
        bondingReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) {
                    BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    int bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR);
                    int previousBondState = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.ERROR);

                    if (device != null && connectedDevice != null &&
                        device.getAddress().equals(connectedDevice.getAddress())) {

                        Bridge.log("LIVE: CTKD: Bond state changed for device " + device.getName() +
                              " - Current: " + bondState + ", Previous: " + previousBondState);

                        switch (bondState) {
                            case BluetoothDevice.BOND_BONDED:
                                Bridge.log("LIVE: CTKD: ✅ Successfully bonded with device - BT Classic connection established");
                                isBtClassicConnected = true;
                                audioConnected = true;
                                // Both BLE and BT Classic are now connected via CTKD

                                // If glasses_ready was already received, now we're fully ready
                                if (glassesReadyReceived) {
                                    Bridge.log("LIVE: Audio: Both audio and glasses_ready confirmed - marking as fully connected");
                                    updateConnectionState(ConnTypes.CONNECTED);
                                }

                                // Send audio connected event for platform parity with iOS
                                Bridge.sendAudioConnected(device.getName());
                                break;

                            case BluetoothDevice.BOND_NONE:
                                Bridge.log("LIVE: CTKD: ❌ Bonding failed or removed for device");
                                isBtClassicConnected = false;
                                audioConnected = false;
                                if (previousBondState == BluetoothDevice.BOND_BONDING) {
                                    Bridge.log("LIVE: CTKD: Bonding process failed");
                                } else if (previousBondState == BluetoothDevice.BOND_BONDED) {
                                    // Send audio disconnected event for platform parity with iOS
                                    Bridge.sendAudioDisconnected();
                                }
                                break;

                            case BluetoothDevice.BOND_BONDING:
                                Bridge.log("LIVE: CTKD: 🔄 Bonding in progress with device");
                                break;

                            default:
                                Bridge.log("LIVE: CTKD: Unknown bond state: " + bondState);
                                break;
                        }
                    }
                }
            }
        };
    }

    /**
     * Register the bonding receiver for CTKD monitoring
     */
    private void registerBondingReceiver() {
        if (!isBondingReceiverRegistered && bondingReceiver != null) {
            IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            context.registerReceiver(bondingReceiver, filter);
            isBondingReceiverRegistered = true;
            Bridge.log("LIVE: CTKD: Bonding receiver registered");
        }
    }

    /**
     * Unregister the bonding receiver
     */
    private void unregisterBondingReceiver() {
        if (isBondingReceiverRegistered && bondingReceiver != null) {
            try {
                context.unregisterReceiver(bondingReceiver);
                isBondingReceiverRegistered = false;
                Bridge.log("LIVE: CTKD: Bonding receiver unregistered");
            } catch (Exception e) {
                Bridge.log("LIVE: CTKD: Error unregistering bonding receiver: " + e.getMessage());
            }
        }
    }

    /**
     * Create bond with device for CTKD (Cross-Transport Key Derivation)
     * This will establish both BLE and BT Classic connections automatically
     */
    private boolean createBond(BluetoothDevice device) {
        try {
            if (device == null) {
                Bridge.log("LIVE: CTKD: Cannot create bond - device is null");
                return false;
            }

            Bridge.log("LIVE: CTKD: Creating bond with device " + device.getName() + " for CTKD");
            Method method = device.getClass().getMethod("createBond");
            boolean result = (Boolean) method.invoke(device);
            Bridge.log("LIVE: CTKD: Bond creation initiated, result: " + result);
            return result;
        } catch (Exception e) {
            Bridge.log("LIVE: CTKD: Error creating bond: " + e.getMessage());
            return false;
        }
    }

    /**
     * Remove bond with device to disconnect BT Classic
     */
    private boolean removeBond(BluetoothDevice device) {
        try {
            if (device == null) {
                Bridge.log("LIVE: CTKD: Cannot remove bond - device is null");
                return false;
            }

            Bridge.log("LIVE: CTKD: Removing bond with device " + device.getName());
            Method method = device.getClass().getMethod("removeBond");
            boolean result = (Boolean) method.invoke(device);
            Bridge.log("LIVE: CTKD: Bond removal initiated, result: " + result);
            isBtClassicConnected = false;
            return result;
        } catch (Exception e) {
            Bridge.log("LIVE: CTKD: Error removing bond: " + e.getMessage());
            return false;
        }
    }

    /**
     * Check if BT Classic is connected via CTKD
     */
    public boolean isBtClassicConnected() {
        return isBtClassicConnected;
    }

    /**
     * A2DP profile service listener for connecting to already-bonded devices
     */
    private final BluetoothProfile.ServiceListener a2dpServiceListener = new BluetoothProfile.ServiceListener() {
        @Override
        public void onServiceConnected(int profile, BluetoothProfile proxy) {
            if (profile == BluetoothProfile.A2DP) {
                a2dpProfile = (BluetoothA2dp) proxy;
                Bridge.log("LIVE: A2DP: Profile proxy obtained");

                // Now connect to the device if we have one pending
                if (connectedDevice != null && connectedDevice.getBondState() == BluetoothDevice.BOND_BONDED) {
                    connectA2dpWithProxy(connectedDevice);
                }
            }
        }

        @Override
        public void onServiceDisconnected(int profile) {
            if (profile == BluetoothProfile.A2DP) {
                Bridge.log("LIVE: A2DP: Profile proxy disconnected");
                a2dpProfile = null;
                isA2dpProxyRegistered = false;  // Reset so we can request a new proxy
            }
        }
    };

    /**
     * Helper to connect A2DP using the proxy - called from service listener or directly
     */
    private void connectA2dpWithProxy(BluetoothDevice device) {
        if (a2dpProfile == null || device == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - proxy or device is null");
            return;
        }

        try {
            int state = a2dpProfile.getConnectionState(device);
            Bridge.log("LIVE: A2DP: Current connection state: " + state);

            if (state == BluetoothProfile.STATE_CONNECTED) {
                Bridge.log("LIVE: A2DP: Already connected to " + device.getName());
                markAudioConnected(device.getName());
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                Bridge.log("LIVE: A2DP: Connecting to " + device.getName());
                // Use reflection to call connect() as it's a hidden API
                Method connectMethod = BluetoothA2dp.class.getMethod("connect", BluetoothDevice.class);
                boolean result = (Boolean) connectMethod.invoke(a2dpProfile, device);
                Bridge.log("LIVE: A2DP: Connect initiated, result: " + result);

                // Note: connect() is async. We mark as connected optimistically because:
                // 1. The device is already bonded, so connection should succeed
                // 2. Android will handle the actual A2DP connection in the background
                // 3. If it fails, the user can still use BLE audio (LC3)
                markAudioConnected(device.getName());
            } else if (state == BluetoothProfile.STATE_CONNECTING) {
                Bridge.log("LIVE: A2DP: Already connecting, marking audio as connected");
                markAudioConnected(device.getName());
            } else {
                // STATE_DISCONNECTING - wait and retry
                Bridge.log("LIVE: A2DP: Device disconnecting, will retry in 500ms");
                handler.postDelayed(() -> {
                    if (connectedDevice != null && a2dpProfile != null) {
                        connectA2dpWithProxy(connectedDevice);
                    }
                }, 500);
            }
        } catch (Exception e) {
            Bridge.log("LIVE: A2DP: Error connecting: " + e.getMessage());
            // Still mark as connected - device is bonded and BLE audio (LC3) will work
            markAudioConnected(device.getName());
        }
    }

    /**
     * Helper to mark audio as connected and notify
     */
    private void markAudioConnected(String deviceName) {
        isBtClassicConnected = true;
        audioConnected = true;
        Bridge.sendAudioConnected(deviceName);
        if (glassesReadyReceived) {
            Bridge.log("LIVE: A2DP: Both audio and glasses_ready confirmed - marking as fully connected");
            updateConnectionState(ConnTypes.CONNECTED);
        }
    }

    /**
     * Connect to A2DP audio profile for an already-bonded device
     * This is needed because being bonded doesn't automatically connect the audio profile
     */
    private void connectA2dpProfile(BluetoothDevice device) {
        if (device == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - device is null");
            return;
        }

        if (bluetoothAdapter == null) {
            Bridge.log("LIVE: A2DP: Cannot connect - BluetoothAdapter is null");
            return;
        }

        Bridge.log("LIVE: A2DP: Requesting A2DP profile proxy for " + device.getName());

        // If we already have the proxy, try to connect directly
        if (a2dpProfile != null) {
            connectA2dpWithProxy(device);
            return;
        }

        // Get the A2DP profile proxy
        if (!isA2dpProxyRegistered) {
            boolean result = bluetoothAdapter.getProfileProxy(context, a2dpServiceListener, BluetoothProfile.A2DP);
            if (result) {
                isA2dpProxyRegistered = true;
                Bridge.log("LIVE: A2DP: Profile proxy request successful, waiting for callback");
            } else {
                Bridge.log("LIVE: A2DP: Failed to get profile proxy, marking audio connected anyway");
                // Still mark as connected - device is bonded and BLE audio (LC3) will work
                markAudioConnected(device.getName());
            }
        } else {
            Bridge.log("LIVE: A2DP: Proxy already registered, waiting for callback");
        }
    }

    /**
     * Close the A2DP profile proxy
     */
    private void closeA2dpProxy() {
        if (a2dpProfile != null && bluetoothAdapter != null) {
            Bridge.log("LIVE: A2DP: Closing profile proxy");
            bluetoothAdapter.closeProfileProxy(BluetoothProfile.A2DP, a2dpProfile);
            a2dpProfile = null;
        }
        isA2dpProxyRegistered = false;
    }

    public void destroy() {
        Bridge.log("LIVE: Destroying MentraLiveSGC");

        // Mark as killed to prevent reconnection attempts
        boolean wasKilled = isKilled;
        isKilled = true;

        // Stop scanning if in progress
        if (isScanning) {
            stopScan();
        }

        // CTKD Implementation: Unregister bonding receiver
        unregisterBondingReceiver();

        // Close A2DP profile proxy
        closeA2dpProxy();

        // CTKD Implementation: Disconnect BT per documentation
        if (connectedDevice != null) {
            Bridge.log("LIVE: CTKD: Destroy - disconnecting BT via removeBond per documentation");
            removeBond(connectedDevice);
        }

        // Stop readiness check loop
        stopReadinessCheckLoop();

        // Stop heartbeat mechanism
        stopHeartbeat();

        // Stop micbeat mechanism
        stopMicBeat();

        // Cancel connection timeout
        if (connectionTimeoutRunnable != null) {
            connectionTimeoutHandler.removeCallbacks(connectionTimeoutRunnable);
        }

        // Cancel any pending handlers
        handler.removeCallbacksAndMessages(null);
        heartbeatHandler.removeCallbacksAndMessages(null);
        micBeatHandler.removeCallbacksAndMessages(null);
        connectionTimeoutHandler.removeCallbacksAndMessages(null);
        testMessageHandler.removeCallbacksAndMessages(null);

        // Clean up message tracking
        pendingMessages.clear();
        Bridge.log("LIVE: Cleared pending message tracking");

        // Release RGB LED control authority before disconnecting
        // DISABLED: MentraLive is not supposed to send this command
        // if (rgbLedAuthorityClaimed) {
        //     sendRgbLedControlAuthority(false);
        // }

        // Disconnect from GATT if connected
        if (bluetoothGatt != null) {
            bluetoothGatt.disconnect();
            bluetoothGatt.close();
            bluetoothGatt = null;
        }

        isConnected = false;
        isConnecting = false;

        // Clear the send queue
        sendQueue.clear();

        // Clear file packet reassembly buffer
        clearFilePacketBuffer();

        // Reset state variables
        reconnectAttempts = 0;
        isReconnecting = false;
        glassesReady = false;
        ready = false;
        updateConnectionState(ConnTypes.DISCONNECTED);

        // Note: We don't null context here to prevent race conditions with BLE callbacks
        // The isKilled flag above serves as our destruction indicator
        // dataObservable = null;

        // Set connection state to disconnected
        // connectionEvent(SmartGlassesConnectionState.DISCONNECTED);

        // Clean up LC3 audio player
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer.stopPlay();
        }

        // Clean up LC3 decoder
        if (lc3DecoderPtr != 0) {
            Lc3Cpp.freeDecoder(lc3DecoderPtr);
            lc3DecoderPtr = 0;
            Bridge.log("LIVE: Freed LC3 decoder resources");
        }
    }

    // Display methods - all stub implementations since Mentra Live has no display

    // @Override
    // public void setFontSize(SmartGlassesFontSize fontSize) {
    //     Bridge.log("LIVE: [STUB] Device has no display. Cannot set font size: " + fontSize);
    // }

    public void sendButtonPhotoSettings(String size) {
        // Send photo size settings to glasses
        JSONObject command = new JSONObject();
        try {
            command.put("type", "button_photo_setting");
            command.put("size", size);
            sendJson(command, true);
        } catch (Exception e) {
            Log.e(TAG, "Error sending button photo settings", e);
        }
    }

    @Override
    public void sendButtonVideoRecordingSettings() {
        var m = CoreManager.getInstance();
        int videoWidth = m.getButtonVideoWidth();
        int videoHeight = m.getButtonVideoHeight();
        int videoFps = m.getButtonVideoFps();

        Bridge.log("LIVE: 🎥 [SETTINGS_SYNC] Sending button video recording settings: " + videoWidth + "x" + videoHeight + "@" + videoFps + "fps");

        try {
            JSONObject json = new JSONObject();
            json.put("type", "button_video_recording_setting");
            JSONObject settings = new JSONObject();
            settings.put("width", videoWidth);
            settings.put("height", videoHeight);
            settings.put("fps", videoFps);
            json.put("params", settings);
            Bridge.log("LIVE: 📤 [SETTINGS_SYNC] BLE packet prepared: " + json.toString());
            sendJson(json);
            Bridge.log("LIVE: ✅ [SETTINGS_SYNC] Video settings transmitted via BLE");
        } catch (JSONException e) {
            Log.e(TAG, "❌ [SETTINGS_SYNC] Error creating button video recording settings message", e);
        }
    }

    public void sendButtonCameraLedSetting(boolean enabled) {
        // Send LED setting to glasses
        JSONObject command = new JSONObject();
        try {
            command.put("type", "button_camera_led");
            command.put("enabled", enabled);
            sendJson(command, true);
        } catch (Exception e) {
            Log.e(TAG, "Error sending button camera LED setting", e);
        }
    }

    @Override
    public void sendTextWall(String text) {
        Bridge.log("LIVE: [STUB] Device has no display. Text wall would show: " + text);
    }

    public void displayBitmap(Bitmap bitmap) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display bitmap.");
    }

    public void displayTextLine(String text) {
        Bridge.log("LIVE: [STUB] Device has no display. Text line would show: " + text);
    }

    public void displayReferenceCardSimple(String title, String body) {
        Bridge.log("LIVE: [STUB] Device has no display. Reference card would show: " + title);
    }

    @Override
    public void setBrightness(int level, boolean autoMode) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot set brightness: " + level);
    }

    public void showHomeScreen() {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot show home screen.");
    }

    public void blankScreen() {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot blank screen.");
    }

    public void displayRowsCard(String[] rowStrings) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display rows card with " + rowStrings.length + " rows");
    }

    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageArgs) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot show natural language command screen: " + prompt);
    }

    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot update natural language command screen");
    }

    public void scrollingTextViewIntermediateText(String text) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display scrolling text: " + text);
    }

    public void displayPromptView(String title, String[] options) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display prompt view: " + title);
    }

    public void displayCustomContent(String json) {
        Bridge.log("LIVE: [STUB] Device has no display. Cannot display custom content");
    }

    @Override
    public void clearDisplay() {
        Log.w(TAG, "MentraLiveSGC does not support clearDisplay");
    }

    public void displayReferenceCardImage(String title, String body, String imgUrl) {
        Bridge.log("LIVE: [STUB] Device has no display. Reference card with image would show: " + title);
    }

    @Override
    public void sendDoubleTextWall(String textTop, String textBottom) {
        Bridge.log("LIVE: [STUB] Device has no display. Double text wall would show: " + textTop + " / " + textBottom);
    }

    public void displayBulletList(String title, String[] bullets) {
        Bridge.log("LIVE: [STUB] Device has no display. Bullet list would show: " + title + " with " + bullets.length + " items");
    }

    public void startScrollingTextViewMode(String title) {
        Bridge.log("LIVE: [STUB] Device has no display. Scrolling text view would start with: " + title);
    }

    public void scrollingTextViewFinalText(String text) {
        Bridge.log("LIVE: [STUB] Device has no display. Scrolling text view would show: " + text);
    }

    public void stopScrollingTextViewMode() {
        // Not supported on Mentra Live
    }

    /**
     * Enable or disable receiving custom GATT audio from the glasses microphone.
     * @param enable True to enable, false to disable.
     */
    public void sendEnableCustomAudioTxMessage(boolean enable) {
        try {
            JSONObject cmd = new JSONObject();
            cmd.put("C", "enable_custom_audio_tx");
            JSONObject enableObj = new JSONObject();
            enableObj.put("enable", enable);
            cmd.put("B", enableObj.toString());

            String jsonStr = cmd.toString();
            Bridge.log("LIVE: Sending hrt command: " + jsonStr);
            byte[] packedData = K900ProtocolUtils.packDataToK900(jsonStr.getBytes(StandardCharsets.UTF_8), K900ProtocolUtils.CMD_TYPE_STRING);
            
            // Send this 3 times to ensure this gets through, since we don't get ACK from BES.
            // Kind of hacky but works for now.
            queueData(packedData);
            queueData(packedData);
            queueData(packedData);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating enable_custom_audio_tx command", e);
        }
    }

    /**
     * Enable or disable sending custom GATT audio to the glasses speaker.
     * @param enable True to enable, false to disable.
     */
    public void enableCustomAudioRx(boolean enable) {
        try {
            JSONObject cmd = new JSONObject();
            cmd.put("C", "enable_custom_audio_rx");
            cmd.put("B", enable);
            sendJson(cmd);
            Bridge.log("LIVE: Setting custom audio RX (speaker) to: " + enable);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating enable_custom_audio_rx command", e);
        }
    }

    /**
     * Enable or disable the standard HFP audio service on the glasses.
     * @param enable True to enable, false to disable.
     */
    public void enableHfpAudioServer(boolean enable) {
        try {
            JSONObject cmd = new JSONObject();
            cmd.put("C", "enable_hfp_audio_server");
            cmd.put("B", enable);
            sendJson(cmd);
            Bridge.log("LIVE: Setting HFP audio server to: " + enable);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating enable_hfp_audio_server command", e);
        }
    }

    /**
     * Enable or disable audio playback through phone speakers when receiving LC3 audio from glasses.
     * This allows you to hear what the glasses microphone is picking up in real-time.
     * @param enable True to enable audio playback, false to disable.
     */
    public void enableAudioPlayback(boolean enable) {
        audioPlaybackEnabled = enable;
        if (enable) {
            Bridge.log("LIVE: 🔊 Audio playback enabled");
            if (lc3AudioPlayer != null) {
                lc3AudioPlayer.startPlay();
                Bridge.log("LIVE: 🔊 LC3 audio player started");
            } else {
                Bridge.log("LIVE: ⚠️ LC3 audio player is null - playback not available");
            }
        } else {
            Bridge.log("LIVE: 🔊 Audio playback disabled");
            if (lc3AudioPlayer != null) {
                lc3AudioPlayer.stopPlay();
                Bridge.log("LIVE: 🔊 LC3 audio player stopped");
            }
        }
    }

    /**
     * Check if audio playback is currently enabled.
     * @return True if audio playback is enabled, false otherwise.
     */
    public boolean isAudioPlaybackEnabled() {
        return audioPlaybackEnabled;
    }

    /**
     * Set the volume for audio playback.
     * @param volume Volume level from 0.0f (muted) to 1.0f (full volume).
     */
    public void setAudioPlaybackVolume(float volume) {
        if (lc3AudioPlayer != null) {
            // Clamp volume to valid range
            float clampedVolume = Math.max(0.0f, Math.min(1.0f, volume));
            // Note: LC3Player doesn't have setVolume method, using system volume
            Bridge.log("LIVE: Audio playback volume request: " + clampedVolume + " (handled by system volume)");
        }
    }

    /**
     * Get the current audio playback volume.
     * @return Current volume level from 0.0f to 1.0f.
     */
    public float getAudioPlaybackVolume() {
        // Note: LC3Player doesn't have a getVolume method, so we'll return a default
        // In a real implementation, you might want to track this separately
        return 1.0f; // Default to full volume
    }

    /**
     * Stop any currently playing audio immediately.
     */
    public void stopAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer.stopPlay();
            Bridge.log("LIVE: Audio playback stopped");
        }
    }

    /**
     * Check if audio is currently playing.
     * @return True if audio is currently playing, false otherwise.
     */
    public boolean isAudioPlaying() {
        return lc3AudioPlayer != null && audioPlaybackEnabled;
    }

    /**
     * Pause audio playback.
     */
    public void pauseAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer.stopPlay();
            Bridge.log("LIVE: Audio playback paused");
        }
    }

    /**
     * Resume audio playback.
     */
    public void resumeAudioPlayback() {
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer.startPlay();
            Bridge.log("LIVE: Audio playback resumed");
        }
    }

    /**
     * Get audio playback statistics and status information.
     * @return JSONObject containing audio playback information.
     */
    public JSONObject getAudioPlaybackStatus() {
        JSONObject status = new JSONObject();
        try {
            status.put("enabled", audioPlaybackEnabled);
            status.put("playing", isAudioPlaying());
            status.put("volume", getAudioPlaybackVolume());
            status.put("initialized", lc3AudioPlayer != null);
            status.put("playerType", "LC3Player");
        } catch (JSONException e) {
            Log.e(TAG, "Error creating audio playback status JSON", e);
        }
        return status;
    }
    
    /**
     * Enable or disable rolling audio recording
     * When enabled, saves the last 20 seconds of audio as M4A file every 20 seconds
     * @param enable True to enable rolling recording, false to disable
     */
    public void enableRollingRecording(boolean enable) {
        rollingRecordingEnabled = enable;
        if (lc3AudioPlayer != null) {
            lc3AudioPlayer.enableRollingRecording(enable);
            Bridge.log("LIVE: 🎙️ Rolling recording " + (enable ? "ENABLED" : "DISABLED"));
        } else {
            Bridge.log("LIVE: ⚠️ Cannot enable rolling recording - LC3 player not initialized");
        }
    }

    /**
     * Check if rolling recording is currently enabled.
     * @return True if rolling recording is enabled, false otherwise.
     */
    public boolean isRollingRecordingEnabled() {
        return rollingRecordingEnabled;
    }

    public void requestReadyK900(){
        try{
            JSONObject cmdObject = new JSONObject();
            cmdObject.put("C", "cs_hrt"); // Video command
            // cmdObject.put("W", 1);        // Wake up MTK system
            cmdObject.put("B", "");       // Add the body
            String jsonStr = cmdObject.toString();
            Bridge.log("LIVE: Sending hrt command: " + jsonStr);
            byte[] packedData = K900ProtocolUtils.packDataToK900(jsonStr.getBytes(StandardCharsets.UTF_8), K900ProtocolUtils.CMD_TYPE_STRING);
            queueData(packedData);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating video command", e);
        }
    }

    public void requestBatteryK900() {
        try {
            JSONObject cmdObject = new JSONObject();
            cmdObject.put("C", "cs_batv"); // Video command
            cmdObject.put("V", 1);        // Version is always 1
            cmdObject.put("B", "");     // Add the body
            String jsonStr = cmdObject.toString();
            Bridge.log("LIVE: Sending hotspot command: " + jsonStr);
            byte[] packedData = K900ProtocolUtils.packDataToK900(jsonStr.getBytes(StandardCharsets.UTF_8), K900ProtocolUtils.CMD_TYPE_STRING);
            queueData(packedData);

        } catch (JSONException e) {
            Log.e(TAG, "Error creating video command", e);
        }
    }


    //---------------------------------------
    // IMU Methods
    //---------------------------------------

    /**
     * Request a single IMU reading from the glasses
     * Power-optimized: sensors turn on briefly then off
     */
    public void requestImuSingle() {
        Bridge.log("LIVE: Requesting single IMU reading");
        try {
            JSONObject json = new JSONObject();
            json.put("type", "imu_single");
            sendJson(json, false);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating IMU single request", e);
        }
    }

    /**
     * Start IMU streaming from the glasses
     * @param rateHz Sampling rate in Hz (1-100)
     * @param batchMs Batching period in milliseconds (0-1000)
     */
    public void startImuStream(int rateHz, long batchMs) {
        Bridge.log("LIVE: Starting IMU stream: " + rateHz + "Hz, batch: " + batchMs + "ms");
        try {
            JSONObject json = new JSONObject();
            json.put("type", "imu_stream_start");
            json.put("rate_hz", rateHz);
            json.put("batch_ms", batchMs);
            sendJson(json, false);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating IMU stream start request", e);
        }
    }

    /**
     * Stop IMU streaming from the glasses
     */
    public void stopImuStream() {
        Bridge.log("LIVE: Stopping IMU stream");
        try {
            JSONObject json = new JSONObject();
            json.put("type", "imu_stream_stop");
            sendJson(json, false);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating IMU stream stop request", e);
        }
    }

    /**
     * Subscribe to gesture detection on the glasses
     * Power-optimized: uses accelerometer-only at low rate
     * @param gestures List of gestures to detect ("head_up", "head_down", "nod_yes", "shake_no")
     */
    public void subscribeToImuGestures(List<String> gestures) {
        Bridge.log("LIVE: Subscribing to IMU gestures: " + gestures);
        try {
            JSONObject json = new JSONObject();
            json.put("type", "imu_subscribe_gesture");
            json.put("gestures", new JSONArray(gestures));
            sendJson(json, false);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating IMU gesture subscription", e);
        }
    }

    /**
     * Unsubscribe from all gesture detection
     */
    public void unsubscribeFromImuGestures() {
        Bridge.log("LIVE: Unsubscribing from IMU gestures");
        try {
            JSONObject json = new JSONObject();
            json.put("type", "imu_unsubscribe_gesture");
            sendJson(json, false);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating IMU gesture unsubscription", e);
        }
    }

    /**
     * Handle IMU response from glasses
     */
    private void handleImuResponse(JSONObject json) {
        try {
            String type = json.getString("type");

            switch(type) {
                case "imu_response":
                    // Single IMU reading
                    handleSingleImuData(json);
                    break;

                case "imu_stream_response":
                    // Stream of IMU readings
                    handleStreamImuData(json);
                    break;

                case "imu_gesture_response":
                    // Gesture detected
                    handleImuGesture(json);
                    break;

                case "imu_gesture_subscribed":
                    // Gesture subscription confirmed
                    Bridge.log("LIVE: IMU gesture subscription confirmed: " + json.optJSONArray("gestures"));
                    break;

                case "imu_ack":
                    // Command acknowledgment
                    Bridge.log("LIVE: IMU command acknowledged: " + json.optString("message"));
                    break;

                case "imu_error":
                    // Error response
                    Log.e(TAG, "IMU error: " + json.optString("error"));
                    break;

                default:
                    Log.w(TAG, "Unknown IMU response type: " + type);
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error handling IMU response", e);
        }
    }

    private void handleSingleImuData(JSONObject json) {
        try {
            // Extract IMU data
            JSONArray accel = json.getJSONArray("accel");
            JSONArray gyro = json.getJSONArray("gyro");
            JSONArray mag = json.getJSONArray("mag");
            JSONArray quat = json.getJSONArray("quat");
            JSONArray euler = json.getJSONArray("euler");

            Log.d(TAG, String.format("IMU Single Reading - Accel: [%.2f, %.2f, %.2f], Euler: [%.1f°, %.1f°, %.1f°]",
                accel.getDouble(0), accel.getDouble(1), accel.getDouble(2),
                euler.getDouble(0), euler.getDouble(1), euler.getDouble(2)));

            // Send IMU data event via Bridge (matches iOS emitImuDataEvent)
            double[] accelArray = new double[]{accel.getDouble(0), accel.getDouble(1), accel.getDouble(2)};
            double[] gyroArray = new double[]{gyro.getDouble(0), gyro.getDouble(1), gyro.getDouble(2)};
            double[] magArray = new double[]{mag.getDouble(0), mag.getDouble(1), mag.getDouble(2)};
            double[] quatArray = new double[]{quat.getDouble(0), quat.getDouble(1), quat.getDouble(2), quat.getDouble(3)};
            double[] eulerArray = new double[]{euler.getDouble(0), euler.getDouble(1), euler.getDouble(2)};

            Bridge.sendImuDataEvent(accelArray, gyroArray, magArray, quatArray, eulerArray, System.currentTimeMillis());
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing single IMU data", e);
        }
    }

    private void handleStreamImuData(JSONObject json) {
        try {
            JSONArray readings = json.getJSONArray("readings");

            for (int i = 0; i < readings.length(); i++) {
                JSONObject reading = readings.getJSONObject(i);
                handleSingleImuData(reading);
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing stream IMU data", e);
        }
    }

    private void handleImuGesture(JSONObject json) {
        try {
            String gesture = json.getString("gesture");
            long timestamp = json.optLong("timestamp", System.currentTimeMillis());

            Bridge.log("LIVE: IMU Gesture detected: " + gesture);

            // Send IMU gesture event via Bridge (matches iOS emitImuGestureEvent)
            Bridge.sendImuGestureEvent(gesture, timestamp);
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing IMU gesture", e);
        }
    }

    /**
     * Send data directly to the glasses using the K900 protocol utility.
     * This method uses K900ProtocolUtils.packJsonToK900 to handle C-wrapping and protocol formatting.
     * Large messages are automatically chunked if they exceed the 400-byte threshold.
     *
     * @param data The string data to be sent to the glasses
     */
    public void sendDataToGlasses(String data, boolean wakeup) {
        if (data == null || data.isEmpty()) {
            Log.e(TAG, "Cannot send empty data to glasses");
            return;
        }

        try {
            // First check if the message needs chunking
            // Create a test C-wrapped version to check size
            JSONObject testWrapper = new JSONObject();
            testWrapper.put("C", data);
            if (wakeup) {
                testWrapper.put("W", 1);
            }
            String testWrappedJson = testWrapper.toString();

            // Check if chunking is needed
            if (MessageChunker.needsChunking(testWrappedJson)) {
                Bridge.log("LIVE: Message exceeds threshold, chunking required");

                // Extract message ID if present for ACK tracking
                long messageId = -1;
                try {
                    JSONObject originalJson = new JSONObject(data);
                    messageId = originalJson.optLong("mId", -1);
                } catch (JSONException e) {
                    // Not a JSON message or no mId, that's okay
                }

                // Create chunks
                List<JSONObject> chunks = MessageChunker.createChunks(data, messageId);
                Bridge.log("LIVE: Sending " + chunks.size() + " chunks");

                // Send each chunk
                for (int i = 0; i < chunks.size(); i++) {
                    JSONObject chunk = chunks.get(i);
                    String chunkStr = chunk.toString();

                    // Pack each chunk using the normal K900 protocol
                    byte[] packedData = K900ProtocolUtils.packJsonToK900(chunkStr, wakeup && i == 0); // Only wakeup on first chunk

                    // Queue the chunk for sending
                    queueData(packedData);

                    // Add small delay between chunks to avoid overwhelming the connection
                    if (i < chunks.size() - 1) {
                        try {
                            Thread.sleep(50); // 50ms delay between chunks
                        } catch (InterruptedException e) {
                            Log.w(TAG, "Interrupted during chunk delay");
                        }
                    }
                }

                Bridge.log("LIVE: All chunks queued for transmission");
            } else {
                // Normal single message transmission
                Bridge.log("LIVE: Sending data to glasses: " + data);

                // Pack the data using the centralized utility
                byte[] packedData = K900ProtocolUtils.packJsonToK900(data, wakeup);

                // Queue the data for sending
                queueData(packedData);
            }

        } catch (Exception e) {
            Log.e(TAG, "Error creating data JSON", e);
        }
    }

    public void sendStartVideoStream(){
        try {
            JSONObject command = new JSONObject();
            command.put("type", "start_video_stream");
            sendJson(command, true);
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }
    }

    public void sendStopVideoStream(){
        try {
            JSONObject command = new JSONObject();
            command.put("type", "stop_video_stream");
            sendJson(command, true);
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * Sends WiFi credentials to the smart glasses
     *
     * @param ssid The WiFi network name
     * @param password The WiFi password
     */
    public void sendWifiCredentials(String ssid, String password) {
        Bridge.log("LIVE: 432432 Sending WiFi credentials to glasses - SSID: " + ssid);

        // Validate inputs
        if (ssid == null || ssid.isEmpty()) {
            Log.e(TAG, "Cannot set WiFi credentials - SSID is empty");
            return;
        }

        try {
            // Send WiFi credentials to the ASG client
            JSONObject wifiCommand = new JSONObject();
            wifiCommand.put("type", "set_wifi_credentials");
            wifiCommand.put("ssid", ssid);
            wifiCommand.put("password", password != null ? password : "");
            sendJson(wifiCommand, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi credentials JSON", e);
        }
    }

    /**
     * Disconnect from WiFi on the glasses
     */
    public void disconnectFromWifi() {
        Bridge.log("LIVE: 📶 Sending WiFi disconnect command to glasses");

        try {
            // Send WiFi disconnect command to the ASG client
            JSONObject wifiCommand = new JSONObject();
            wifiCommand.put("type", "disconnect_wifi");
            sendJson(wifiCommand, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi disconnect JSON", e);
        }
    }

    /**
     * Forget a WiFi network on the glasses - removes cached credentials
     * This sends the SSID so the K900 SystemUI can properly clear the cached credentials
     */
    @Override
    public void forgetWifiNetwork(String ssid) {
        Bridge.log("LIVE: 📶 Sending WiFi forget command for SSID: " + ssid);

        try {
            JSONObject wifiCommand = new JSONObject();
            wifiCommand.put("type", "forget_wifi");
            wifiCommand.put("ssid", ssid);
            sendJson(wifiCommand, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi forget JSON", e);
        }
    }

    public void sendHotspotState(boolean enabled) {
        Bridge.log("LIVE: 🔥 Sending hotspot state to glasses - enabled: " + enabled);
        try {
            // Send hotspot state command to the ASG client
            JSONObject hotspotCommand = new JSONObject();
            hotspotCommand.put("type", "set_hotspot_state");
            hotspotCommand.put("enabled", enabled);
            sendJson(hotspotCommand, true);
            Bridge.log("LIVE: 🔥 ✅ Hotspot state command sent successfully");
        } catch (JSONException e) {
            Log.e(TAG, "🔥 💥 Error creating hotspot state JSON", e);
        }
    }

    /**
     * Sends user email to glasses for crash reporting identification
     *
     * @param email The user's email address
     */
    @Override
    public void sendUserEmailToGlasses(String email) {
        Bridge.log("LIVE: Sending user email to glasses for crash reporting");

        if (email == null || email.isEmpty()) {
            Log.w(TAG, "Cannot send user email - email is empty");
            return;
        }

        try {
            JSONObject emailCommand = new JSONObject();
            emailCommand.put("type", "user_email");
            emailCommand.put("email", email);
            sendJson(emailCommand, true);
            Log.d(TAG, "User email sent to glasses successfully");
        } catch (JSONException e) {
            Log.e(TAG, "Error creating user email JSON", e);
        }
    }

    public void sendCustomCommand(String commandJson) {
        Bridge.log("LIVE: Received custom command: " + commandJson);

        try {
            JSONObject json = new JSONObject(commandJson);
            String type = json.optString("type", "");

            switch (type) {
                case "request_wifi_scan":
                    requestWifiScan();
                    break;
                case "rgb_led_control_on":
                case "rgb_led_control_off":
                    // Forward LED control commands directly to glasses via BLE
                    Log.d(TAG, "💡 Forwarding LED control command to glasses: " + type);
                    sendJson(json, true);
                    break;
                default:
                    Log.w(TAG, "Unknown custom command type: " + type + " - attempting to forward to glasses");
                    // Forward unknown commands to glasses - they might handle them
                    sendJson(json, true);
                    break;
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing custom command JSON", e);
        }
    }

    /**
     * Send a JSON object to the glasses without ACK tracking (for non-critical messages)
     */
    private void sendJsonWithoutAck(JSONObject json, boolean wakeup) {
        if (json != null) {
            String jsonStr = json.toString();
            Bridge.log("LIVE: 📤 Sending JSON without ACK tracking: " + jsonStr);
            sendDataToGlasses(jsonStr, wakeup);
        } else {
            Bridge.log("LIVE: Cannot send JSON to ASG, JSON is null");
        }
    }

    private void sendJsonWithoutAck(JSONObject json){
        sendJsonWithoutAck(json, false);
    }

    /**
     * Claim or release RGB LED control authority from BES chipset
     * @param claimControl true to claim control, false to release
     */
    private void sendRgbLedControlAuthority(boolean claimControl) {
        try {
            JSONObject bodyData = new JSONObject();
            bodyData.put("on", claimControl);

            JSONObject command = new JSONObject();
            command.put("C", "android_control_led");
            command.put("V", 1);
            command.put("B", bodyData.toString());

            Bridge.log("LIVE: " + (claimControl ? "📍 Claiming" : "📍 Releasing") + " RGB LED control authority");
            sendJson(command, false);
            rgbLedAuthorityClaimed = claimControl;
        } catch (JSONException e) {
            Log.e(TAG, "Error building RGB LED authority command", e);
        }
    }

    /**
     * Send RGB LED control command to glasses
     * Matches iOS implementation for cross-platform consistency
     */
    public void sendRgbLedControl(String requestId,
                                   String packageName,
                                   String action,
                                   String color,
                                   int ontime,
                                   int offtime,
                                   int count) {
        if (!isConnected || !glassesReady) {
            Bridge.log("LIVE: Cannot handle RGB LED control - glasses not connected");
            Bridge.sendRgbLedControlResponse(requestId, false, "glasses_not_connected");
            return;
        }

        if (!rgbLedAuthorityClaimed) {
            sendRgbLedControlAuthority(true);
        }

        try {
            JSONObject command = new JSONObject();
            command.put("requestId", requestId);

            if (packageName != null && !packageName.isEmpty()) {
                command.put("packageName", packageName);
            }

            switch (action) {
                case "on":
                    int ledIndex = ledIndexForColor(color);
                    command.put("type", "rgb_led_control_on");
                    command.put("led", ledIndex);
                    command.put("ontime", ontime);
                    command.put("offtime", offtime);
                    command.put("count", count);
                    break;
                case "off":
                    command.put("type", "rgb_led_control_off");
                    break;
                default:
                    Bridge.log("LIVE: Unsupported RGB LED action: " + action);
                    Bridge.sendRgbLedControlResponse(requestId, false, "unsupported_action");
                    return;
            }

            Bridge.log("LIVE: 💡 Forwarding RGB LED command to glasses: " + command.toString());
            sendJson(command, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error building RGB LED command", e);
            Bridge.sendRgbLedControlResponse(requestId, false, "json_error");
        }
    }

    /**
     * Convert color string to LED index
     * Matches iOS implementation
     */
    private int ledIndexForColor(String color) {
        if (color == null) return 0;

        switch (color.toLowerCase()) {
            case "red":
                return 0;
            case "green":
                return 1;
            case "blue":
                return 2;
            case "orange":
                return 3;
            case "white":
                return 4;
            default:
                return 0;
        }
    }

    /**
     * Get statistics about the message tracking system
     * @return String with tracking statistics
     */
    public String getMessageTrackingStats() {
        StringBuilder stats = new StringBuilder();
        stats.append("Message Tracking Stats:\n");
        stats.append("- Pending messages: ").append(pendingMessages.size()).append("\n");
        stats.append("- Next message ID: ").append(messageIdCounter.get()).append("\n");
        stats.append("- ACK timeout: ").append(ACK_TIMEOUT_MS).append("ms\n");
        stats.append("- Max retries: ").append(MAX_RETRY_ATTEMPTS).append("\n");

        if (!pendingMessages.isEmpty()) {
            stats.append("- Pending message IDs: ");
            for (Long messageId : pendingMessages.keySet()) {
                PendingMessage msg = pendingMessages.get(messageId);
                if (msg != null) {
                    stats.append(messageId).append("(retry:").append(msg.retryCount).append(") ");
                }
            }
        }

        return stats.toString();
    }

    //---------------------------------------
    // File Transfer Methods
    //---------------------------------------

    /**
     * Process a received file packet
     */
    private void processFilePacket(K900ProtocolUtils.FilePacketInfo packetInfo) {
        // Calculate total packets based on actual pack size (not hardcoded FILE_PACK_SIZE)
        int totalPackets = packetInfo.packSize > 0 ?
            (packetInfo.fileSize + packetInfo.packSize - 1) / packetInfo.packSize : 1;
        Bridge.log("LIVE: 📦 Processing file packet: " + packetInfo.fileName +
              " [" + packetInfo.packIndex + "/" + (totalPackets - 1) + "]" +
              " (" + packetInfo.packSize + " bytes)");

        // Check if this is a BLE photo transfer we're tracking
        // The filename might have an extension (.avif or .jpg), but we track by ID only
        String bleImgId = packetInfo.fileName;
        int dotIndex = bleImgId.lastIndexOf('.');
        if (dotIndex > 0) {
            bleImgId = bleImgId.substring(0, dotIndex);
        }

        Bridge.log("LIVE: 📦 BLE photo transfer packet for requestId: " + bleImgId);

        BlePhotoTransfer photoTransfer = blePhotoTransfers.get(bleImgId);
        Bridge.log("LIVE: 📦 BLE photo transfer for requestId: " + bleImgId + " found: " + (photoTransfer != null));
        if (photoTransfer != null) {
            // This is a BLE photo transfer
            Bridge.log("LIVE: 📦 BLE photo transfer packet for requestId: " + photoTransfer.requestId);

            // Get or create session for this transfer
            if (photoTransfer.session == null) {
                photoTransfer.session = new FileTransferSession(packetInfo.fileName, packetInfo.fileSize);
                // Recalculate total packets based on actual pack size (handles variable MTU)
                photoTransfer.session.recalculateTotalPackets(packetInfo.packSize);
                Bridge.log("LIVE: 📦 Started BLE photo transfer: " + packetInfo.fileName +
                      " (" + packetInfo.fileSize + " bytes, " + photoTransfer.session.totalPackets + " packets, packSize=" + packetInfo.packSize + ")");
            }

            // Add packet to session
            boolean added = photoTransfer.session.addPacket(packetInfo.packIndex, packetInfo.data);

            // Check completion when final packet arrives or transfer is complete
            if (added && photoTransfer.session.shouldCheckCompletion(packetInfo.packIndex)) {
                if (photoTransfer.session.isComplete) {
                    // Transfer is complete - process successfully
                    long transferEndTime = System.currentTimeMillis();
                    long totalDuration = transferEndTime - photoTransfer.phoneStartTime;
                    long bleTransferDuration = photoTransfer.bleTransferStartTime > 0 ?
                        (transferEndTime - photoTransfer.bleTransferStartTime) : 0;

                    Bridge.log("LIVE: ✅ BLE photo transfer complete: " + packetInfo.fileName);
                    Bridge.log("LIVE: ⏱️ Total duration (request to complete): " + totalDuration + "ms");
                    Bridge.log("LIVE: ⏱️ Glasses compression: " + photoTransfer.glassesCompressionDurationMs + "ms");
                    if (bleTransferDuration > 0) {
                        Bridge.log("LIVE: ⏱️ BLE transfer duration: " + bleTransferDuration + "ms");
                        Bridge.log("LIVE: 📊 Transfer rate: " + (packetInfo.fileSize * 1000 / bleTransferDuration) + " bytes/sec");
                    }

                    // Get complete image data (AVIF or JPEG)
                    byte[] imageData = photoTransfer.session.assembleFile();
                    if (imageData != null) {
                        // Process and upload the photo
                        processAndUploadBlePhoto(photoTransfer, imageData);
                    }

                    // Send completion confirmation to glasses
                    sendTransferCompleteConfirmation(packetInfo.fileName, true);

                    // Clean up - use the bleImgId without extension
                    blePhotoTransfers.remove(bleImgId);
                } else {
                    // Final packet received but transfer incomplete - tell glasses to retry
                    List<Integer> missingPackets = photoTransfer.session.getMissingPackets();
                    Log.e(TAG, "❌ BLE photo transfer incomplete after final packet. Missing " + missingPackets.size() + " packets: " + missingPackets);
                    Log.e(TAG, "❌ Telling glasses to retry entire transfer");

                    // Tell glasses transfer failed, they will retry
                    sendTransferCompleteConfirmation(packetInfo.fileName, false);
                    blePhotoTransfers.remove(bleImgId);
                }
            }

            return; // Exit after handling BLE photo
        }

        // Regular file transfer (not a BLE photo)
        FileTransferSession session = activeFileTransfers.get(packetInfo.fileName);
        if (session == null) {
            // New file transfer
            session = new FileTransferSession(packetInfo.fileName, packetInfo.fileSize);
            // Recalculate total packets based on actual pack size (handles variable MTU)
            session.recalculateTotalPackets(packetInfo.packSize);
            activeFileTransfers.put(packetInfo.fileName, session);

            Bridge.log("LIVE: 📦 Started new file transfer: " + packetInfo.fileName +
                  " (" + packetInfo.fileSize + " bytes, " + session.totalPackets + " packets, packSize=" + packetInfo.packSize + ")");
        }

            // Add packet to session
            boolean added = session.addPacket(packetInfo.packIndex, packetInfo.data);

            if (added) {
                // BES chip handles ACKs automatically
                Bridge.log("LIVE: 📦 Packet " + packetInfo.packIndex + " received successfully (BES will auto-ACK)");

                // Check completion when final packet arrives or transfer is complete
                if (session.shouldCheckCompletion(packetInfo.packIndex)) {
                    if (session.isComplete) {
                        // Transfer is complete - process successfully
                        Bridge.log("LIVE: 📦 File transfer complete: " + packetInfo.fileName);

                        // Assemble and save the file
                        byte[] fileData = session.assembleFile();
                        if (fileData != null) {
                            saveReceivedFile(packetInfo.fileName, fileData, packetInfo.fileType);
                        }

                        // Send completion confirmation to glasses
                        sendTransferCompleteConfirmation(packetInfo.fileName, true);

                        // Remove from active transfers
                        activeFileTransfers.remove(packetInfo.fileName);
                    } else {
                        // Final packet received but transfer incomplete - tell glasses to retry
                        List<Integer> missingPackets = session.getMissingPackets();
                        Log.e(TAG, "❌ File transfer incomplete after final packet. Missing " + missingPackets.size() + " packets: " + missingPackets);
                        Log.e(TAG, "❌ Expected " + session.totalPackets + " packets, received FILE_READ notifications: " + fileReadNotificationCount);
                        Log.e(TAG, "❌ Telling glasses to retry entire transfer");

                        // Tell glasses transfer failed, they will retry
                        sendTransferCompleteConfirmation(packetInfo.fileName, false);
                        activeFileTransfers.remove(packetInfo.fileName);
                    }
                }
            } else {
                // Packet already received or invalid index
                Log.w(TAG, "📦 Duplicate or invalid packet: " + packetInfo.packIndex);
                // BES chip handles ACKs automatically
            }
    }

    /**
     * Request missing packets from glasses
     */
    private void requestMissingPackets(String fileName, List<Integer> missingPackets) {
        if (missingPackets.isEmpty()) {
            Bridge.log("LIVE: ✅ No missing packets for " + fileName + " - should not have been called");
            return;
        }

        // Check if too many packets are missing (>50% = likely failure)
        FileTransferSession session = activeFileTransfers.get(fileName);
        if (session != null && missingPackets.size() > session.totalPackets / 2) {
            Log.e(TAG, "❌ Too many missing packets (" + missingPackets.size() + "/" + session.totalPackets + ") for " + fileName + " - treating as failed transfer");

            // Send failure confirmation to glasses
            sendTransferCompleteConfirmation(fileName, false);

            // Clean up the failed session
            activeFileTransfers.remove(fileName);
            return;
        }

        Bridge.log("LIVE: 🔍 Requesting retransmission of " + missingPackets.size() + " missing packets for " + fileName + ": " + missingPackets);

        try {
            // Send missing packets request to glasses
            JSONObject request = new JSONObject();
            request.put("type", "request_missing_packets");
            request.put("fileName", fileName);

            JSONArray missingArray = new JSONArray();
            for (Integer packetIndex : missingPackets) {
                missingArray.put(packetIndex);
            }
            request.put("missingPackets", missingArray);

            sendJson(request, true); // Wake up glasses for this request

        } catch (JSONException e) {
            Log.e(TAG, "Error creating missing packets request", e);
        }
    }

    /**
     * Send transfer completion confirmation to glasses
     */
    private void sendTransferCompleteConfirmation(String fileName, boolean success) {
        try {
            JSONObject confirmation = new JSONObject();
            confirmation.put("type", "transfer_complete");
            confirmation.put("fileName", fileName);
            confirmation.put("success", success);
            confirmation.put("timestamp", System.currentTimeMillis());

            Log.d(TAG, (success ? "✅" : "❌") + " Sending transfer completion confirmation for: " + fileName + " (success: " + success + ")");
            sendJson(confirmation, true);

        } catch (JSONException e) {
            Log.e(TAG, "Error creating transfer completion confirmation", e);
        }
    }

    /**
     * Save received file to storage
     */
    private void saveReceivedFile(String fileName, byte[] fileData, byte fileType) {
        try {
            // Get or create the directory for saving files
            File dir = new File(context.getExternalFilesDir(null), FILE_SAVE_DIR);
            if (!dir.exists()) {
                dir.mkdirs();
            }

            // Generate unique filename with timestamp
            SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US);
            String timestamp = sdf.format(new Date());

            // Determine file extension based on type
            String extension = "";
            switch (fileType) {
                case K900ProtocolUtils.CMD_TYPE_PHOTO:
                    // For photos, try to preserve the original extension
                    int photoExtIndex = fileName.lastIndexOf('.');
                    if (photoExtIndex > 0) {
                        extension = fileName.substring(photoExtIndex);
                    } else {
                        extension = ".jpg"; // Default to JPEG if no extension
                    }
                    break;
                case K900ProtocolUtils.CMD_TYPE_VIDEO:
                    extension = ".mp4";
                    break;
                case K900ProtocolUtils.CMD_TYPE_AUDIO:
                    extension = ".wav";
                    break;
                default:
                    // Try to get extension from original filename
                    int dotIndex = fileName.lastIndexOf('.');
                    if (dotIndex > 0) {
                        extension = fileName.substring(dotIndex);
                    }
                    break;
            }

            // Create unique filename
            String baseFileName = fileName;
            if (baseFileName.contains(".")) {
                baseFileName = baseFileName.substring(0, baseFileName.lastIndexOf('.'));
            }
            String uniqueFileName = baseFileName + "_" + timestamp + extension;

            // Save the file
            File file = new File(dir, uniqueFileName);
            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(fileData);
                fos.flush();

                Bridge.log("LIVE: 💾 Saved file: " + file.getAbsolutePath());

                // Notify about the received file
                notifyFileReceived(file.getAbsolutePath(), fileType);
            }

        } catch (Exception e) {
            Log.e(TAG, "Error saving received file: " + fileName, e);
        }
    }

    /**
     * Notify listeners about received file
     */
    private void notifyFileReceived(String filePath, byte fileType) {
        // Create event based on file type
        JSONObject event = new JSONObject();
        try {
            event.put("type", "file_received");
            event.put("filePath", filePath);
            event.put("fileType", String.format("0x%02X", fileType));
            event.put("timestamp", System.currentTimeMillis());

            // Emit event through data observable
            // if (dataObservable != null) {
                // dataObservable.onNext(event);
            // }

            // You could also post an EventBus event here if needed
            // EventBus.getDefault().post(new FileReceivedEvent(filePath, fileType));

        } catch (JSONException e) {
            Log.e(TAG, "Error creating file received event", e);
        }
    }

    /**
     * Process and upload a BLE photo transfer
     */
    private void processAndUploadBlePhoto(BlePhotoTransfer transfer, byte[] imageData) {
        Bridge.log("LIVE: Processing BLE photo for upload. RequestId: " + transfer.requestId);
        long uploadStartTime = System.currentTimeMillis();

        // Save BLE photo locally for debugging/backup
        try {
            File dir = new File(context.getExternalFilesDir(null), FILE_SAVE_DIR);
            if (!dir.exists()) {
                dir.mkdirs();
            }

            // BLE photos are ALWAYS AVIF format
            String fileName = "BLE_" + transfer.bleImgId + "_" + System.currentTimeMillis() + ".avif";
            File file = new File(dir, fileName);

            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(imageData);
                Bridge.log("LIVE: 💾 Saved BLE photo locally: " + file.getAbsolutePath());
            }
        } catch (Exception e) {
            Log.e(TAG, "Error saving BLE photo locally", e);
        }

        // Get core token for authentication
        String coreToken = getCoreToken();

        // Use BlePhotoUploadService to handle decoding and upload
        BlePhotoUploadService.processAndUploadPhoto(
            imageData,
            transfer.requestId,
            transfer.webhookUrl,
            coreToken,
            new BlePhotoUploadService.UploadCallback() {
                @Override
                public void onSuccess(String requestId) {
                    long uploadDuration = System.currentTimeMillis() - uploadStartTime;
                    long totalDuration = System.currentTimeMillis() - transfer.phoneStartTime;

                    Bridge.log("LIVE: ✅ BLE photo uploaded successfully via phone relay for requestId: " + requestId);
                    Bridge.log("LIVE: ⏱️ Upload duration: " + uploadDuration + "ms");
                    Bridge.log("LIVE: ⏱️ Total end-to-end duration: " + totalDuration + "ms");
                    //sendPhotoUploadSuccess(requestId);
                }

                @Override
                public void onError(String requestId, String error) {
                    long uploadDuration = System.currentTimeMillis() - uploadStartTime;
                    Log.e(TAG, "❌ BLE photo upload failed for requestId: " + requestId + ", error: " + error);
                    Log.e(TAG, "⏱️ Failed after: " + uploadDuration + "ms");
                    //sendPhotoUploadError(requestId, error);
                }
            }
        );
    }

    /**
     * Send photo upload success notification to glasses
     */
    private void sendPhotoUploadSuccess(String requestId) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_upload_result");
            json.put("requestId", requestId);
            json.put("success", true);

            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo upload success message", e);
        }
    }

    /**
     * Send photo upload error notification to glasses
     */
    private void sendPhotoUploadError(String requestId, String error) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "photo_upload_result");
            json.put("requestId", requestId);
            json.put("success", false);
            json.put("error", error);

            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo upload error message", e);
        }
    }

    /**
     * Get the core authentication token
     */
    private String getCoreToken() {
        SharedPreferences prefs = context.getSharedPreferences(AUTH_PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getString(KEY_CORE_TOKEN, "");
    }

    /**
     * Send BLE transfer completion notification
     */
    private void sendBleTransferComplete(String requestId, String bleImgId, boolean success) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "ble_photo_transfer_complete");
            json.put("requestId", requestId);
            json.put("bleImgId", bleImgId);
            json.put("success", success);

            sendJson(json, true);
            Bridge.log("LIVE: Sent BLE transfer complete notification: " + json.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating BLE transfer complete message", e);
        }
    }

    /**
     * Send BLE MTU config to glasses so they can adjust file packet sizes.
     * The BES2700 chip on the glasses truncates packets to 253 bytes (256 MTU - 3 ATT header)
     * regardless of negotiated MTU. By sending the actual MTU, glasses can use smaller
     * packet sizes that fit within this limit.
     */
    private void sendBleMtuConfig(int mtu) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", "set_ble_mtu");
            json.put("mtu", mtu);

            sendJson(json, false);
            Bridge.log("LIVE: 📦 Sent BLE MTU config to glasses: " + mtu);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating BLE MTU config message", e);
        }
    }

    /**
     * Send button mode setting to the smart glasses
     *
     * @param mode The button mode (photo, apps, both)
     */
    @Override
    public void sendButtonModeSetting() {
        Bridge.log("LIVE: Sending button mode setting to glasses");

        if (!isConnected) {
            Log.w(TAG, "Cannot send button mode - not connected");
            return;
        }

        var m = CoreManager.getInstance();
        String mode = m.getButtonPressMode();

        try {
            JSONObject json = new JSONObject();
            json.put("type", "button_mode_setting");
            json.put("mode", mode);
            sendJson(json);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating button mode message", e);
        }
    }

    /**
     * Start buffer recording on glasses
     */
    @Override
    public void startBufferRecording() {
        Bridge.log("LIVE: Starting buffer recording on glasses");

        if (!isConnected) {
            Log.w(TAG, "Cannot start buffer recording - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "start_buffer_recording");
            sendJson(json, true); // Wake up glasses for this command
        } catch (JSONException e) {
            Log.e(TAG, "Error creating start buffer recording message", e);
        }
    }

    /**
     * Stop buffer recording on glasses
     */
    @Override
    public void stopBufferRecording() {
        Bridge.log("LIVE: Stopping buffer recording on glasses");

        if (!isConnected) {
            Log.w(TAG, "Cannot stop buffer recording - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "stop_buffer_recording");
            sendJson(json, true); // Wake up glasses for this command
        } catch (JSONException e) {
            Log.e(TAG, "Error creating stop buffer recording message", e);
        }
    }

    /**
     * Save buffer video from glasses
     */
    @Override
    public void saveBufferVideo(String requestId, int durationSeconds) {
        Bridge.log("LIVE: Saving buffer video: requestId=" + requestId + ", duration=" + durationSeconds + " seconds");

        if (!isConnected) {
            Log.w(TAG, "Cannot save buffer video - not connected");
            return;
        }

        // Validate duration
        if (durationSeconds < 1 || durationSeconds > 30) {
            Log.e(TAG, "Invalid duration: " + durationSeconds + " (must be 1-30 seconds)");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "save_buffer_video");
            json.put("requestId", requestId);
            json.put("duration", durationSeconds);
            sendJson(json, true); // Wake up glasses for this command
        } catch (JSONException e) {
            Log.e(TAG, "Error creating save buffer video message", e);
        }
    }

    /**
     * Send user settings to glasses after connection is established
     */
    private void sendUserSettings() {
        Bridge.log("LIVE: [VIDEO_SYNC] Sending user settings to glasses on connection");

        // Send button mode setting
        sendButtonModeSetting();

        // Send button video recording settings
        sendButtonVideoRecordingSettings();

        // Send button max recording time
        sendButtonMaxRecordingTime();

        // Send button photo settings
        sendButtonPhotoSettings();

        // Send button camera LED setting
        sendButtonCameraLedSetting();

        // Send gallery mode state (camera app running status)
        sendGalleryMode();
    }

    /**
     * Send button photo settings to glasses
     */
    public void sendButtonPhotoSettings() {
        var m = CoreManager.getInstance();
        String size = m.getButtonPhotoSize();

        Bridge.log("LIVE: Sending button photo setting: " + size);

        if (!isConnected) {
            Log.w(TAG, "Cannot send button photo settings - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "button_photo_setting");
            json.put("size", size);
            sendJson(json);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating button photo settings message", e);
        }
    }

    /**
     * Send button camera LED setting to glasses
     */
    @Override
    public void sendButtonCameraLedSetting() {
        var m = CoreManager.getInstance();
        boolean enabled = m.getButtonCameraLed();

        Bridge.log("LIVE: Sending button camera LED setting: " + enabled);

        if (!isConnected) {
            Log.w(TAG, "Cannot send button camera LED setting - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "button_camera_led");
            json.put("enabled", enabled);
            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating button camera LED setting message", e);
        }
    }

    /**
     * Send button max recording time to glasses
     * Matches iOS MentraLive.swift sendButtonMaxRecordingTime pattern
     */
    @Override
    public void sendButtonMaxRecordingTime() {
        Bridge.log("LIVE: Sending button max recording time");

        if (!isConnected) {
            Bridge.log("LIVE: Cannot send button max recording time - not connected");
            return;
        }

        int minutes = CoreManager.getInstance().getButtonMaxRecordingTime();

        try {
            JSONObject json = new JSONObject();
            json.put("type", "button_max_recording_time");
            json.put("minutes", minutes);
            sendJson(json, true);
        } catch (JSONException e) {
            Log.e(TAG, "Error creating button max recording time message", e);
        }
    }

    @Override
    public void startVideoRecording(String requestId, boolean save, boolean silent) {
        startVideoRecording(requestId, save, silent, 0, 0, 0); // Use defaults
    }

    /**
     * Start video recording with optional resolution settings
     * @param requestId Request ID for tracking
     * @param save Whether to save the video
     * @param silent Whether to disable sound and privacy LED
     * @param width Video width (0 for default)
     * @param height Video height (0 for default)
     * @param fps Video frame rate (0 for default)
     */
    public void startVideoRecording(String requestId, boolean save, boolean silent, int width, int height, int fps) {
        Bridge.log("LIVE: Starting video recording: requestId=" + requestId + ", save=" + save +
                   ", silent=" + silent + ", resolution=" + width + "x" + height + "@" + fps + "fps");

        if (!isConnected) {
            Log.w(TAG, "Cannot start video recording - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "start_video_recording");
            json.put("requestId", requestId);
            json.put("save", save);
            json.put("silent", silent);

            // Add video settings if provided
            if (width > 0 && height > 0) {
                JSONObject settings = new JSONObject();
                settings.put("width", width);
                settings.put("height", height);
                settings.put("fps", fps > 0 ? fps : 30);
                json.put("settings", settings);
            }

            sendJson(json, true); // Wake up glasses for this command
        } catch (JSONException e) {
            Log.e(TAG, "Failed to create start video recording command", e);
        }
    }

    @Override
    public void stopVideoRecording(String requestId) {
        Bridge.log("LIVE: Stopping video recording: requestId=" + requestId);

        if (!isConnected) {
            Log.w(TAG, "Cannot stop video recording - not connected");
            return;
        }

        try {
            JSONObject json = new JSONObject();
            json.put("type", "stop_video_recording");
            json.put("requestId", requestId);
            sendJson(json, true); // Wake up glasses for this command
        } catch (JSONException e) {
            Log.e(TAG, "Failed to create stop video recording command", e);
        }
    }

    /**
     * Process incoming LC3 audio packet from the glasses.
     * Packet Structure:
     * Byte 0: 0xF1 (Audio data identifier)
     * Byte 1: Sequence number (0-255)
     * Bytes 2-401: LC3 encoded audio data (400 bytes - 10 frames × 40 bytes per frame)
     */
    private void processLc3AudioPacket(byte[] data) {
        // Bridge.log("LIVE: Processing LC3 audio packet: " + data.length + " bytes");

        if (data == null || data.length < 2) {
            Log.w(TAG, "Invalid LC3 audio packet received: too short");
            return;
        }

        // Check for audio packet header
        if (data[0] == (byte) 0xF1) {
            // Bridge.log("LIVE: Valid LC3 audio packet received");
            byte sequenceNumber = data[1];
            long receiveTime = System.currentTimeMillis();

            // Basic sequence validation
            if (lastReceivedLc3Sequence != -1 && (byte)(lastReceivedLc3Sequence + 1) != sequenceNumber) {
                Log.w(TAG, "LC3 packet sequence mismatch. Expected: " + (lastReceivedLc3Sequence + 1) + ", Got: " + sequenceNumber);
            }
            lastReceivedLc3Sequence = sequenceNumber;

            byte[] lc3Data = Arrays.copyOfRange(data, 2, data.length);

            // Enhanced LC3 packet logging and saving
            logLc3PacketDetails(lc3Data, sequenceNumber, receiveTime);
            // saveLc3AudioPacket(lc3Data, sequenceNumber);

            // Bridge.log("LIVE: Received LC3 audio packet seq=" + sequenceNumber + ", size=" + lc3Data.length);

            // Forward raw LC3 to CoreManager (matches iOS behavior)
            // MentraLive uses 40-byte LC3 frames
            CoreManager.getInstance().handleGlassesMicData(lc3Data, LC3_FRAME_SIZE);

            // Bridge.log("LIVE: 🔊 Audio playback enabled: " + audioPlaybackEnabled);
        // } else {
            // Log.w(TAG, "No audio processing callback registered - audio data will not be processed");
        // }

            // Play LC3 audio directly through LC3 player if enabled
            // This allows monitoring of the glasses microphone in real-time
            if (audioPlaybackEnabled && lc3AudioPlayer != null) {
                // log 1/50th of the time:
                if (Math.random() < 0.02) {
                    Bridge.log("LIVE: 🔊 Playing LC3 audio through phone speakers: " + data.length + " bytes");
                }
                // The data array already contains the full packet with F1 header and sequence
                // Just pass it directly to the LC3 player
                lc3AudioPlayer.write(data, 0, data.length);
                // Bridge.log("LIVE: 🔊 Playing LC3 audio through phone speakers: " + data.length + " bytes");
            } else if (!audioPlaybackEnabled) {
                // Audio playback is disabled - only processing for PCM conversion
                // Bridge.log("LIVE: 🔇 Audio playback disabled - processing for PCM only");
            }

        } else {
            Bridge.log("LIVE: ⚠️ Received non-audio packet on LC3 characteristic.");
        }
    }

    /**
     * Sends an LC3 audio packet to the glasses.
     * @param lc3Data The raw LC3 encoded audio data (e.g., 400 bytes - 10 frames × 40 bytes per frame).
     */
    public void sendLc3AudioPacket(byte[] lc3Data) {
        if (lc3WriteCharacteristic == null) {
            Log.w(TAG, "Cannot send LC3 audio packet, characteristic not available.");
            return;
        }
        if (lc3Data == null || lc3Data.length == 0) {
            Log.w(TAG, "Cannot send empty LC3 data.");
            return;
        }

        // Packet Structure: Header (1) + Sequence (1) + Data (N)
        byte[] packet = new byte[lc3Data.length + 2];
        packet[0] = (byte) 0xF1; // Audio data identifier
        packet[1] = lc3SequenceNumber++; // Sequence number

        System.arraycopy(lc3Data, 0, packet, 2, lc3Data.length);

        // We use queueData to handle rate-limiting and sending
        queueData(packet);
    }

    /**
     * Initialize LC3 audio logging and file saving
     */
    private void initializeLc3Logging() {
        if (!LC3_LOGGING_ENABLED) {
            return;
        }

        try {
            // Create logs directory
            File logsDir = new File(context.getExternalFilesDir(null), LC3_LOG_DIR);
            Bridge.log("LIVE: 🎯 Attempting to create LC3 logs directory: " + logsDir.getAbsolutePath());

            if (!logsDir.exists()) {
                boolean created = logsDir.mkdirs();
                if (created) {
                    Log.i(TAG, "✅ Successfully created LC3 logs directory: " + logsDir.getAbsolutePath());
                } else {
                    Log.e(TAG, "❌ Failed to create LC3 logs directory: " + logsDir.getAbsolutePath());
                    // Try to get more info about why it failed
                    File parentDir = logsDir.getParentFile();
                    if (parentDir != null) {
                        Log.e(TAG, "📁 Parent directory exists: " + parentDir.exists() + ", writable: " + parentDir.canWrite());
                    }
                    return; // Exit early if directory creation fails
                }
            } else {
                Log.i(TAG, "✅ LC3 logs directory already exists: " + logsDir.getAbsolutePath());
            }

            // Create new audio file with timestamp
            String timestamp = lc3TimestampFormat.format(new Date());
            currentLc3FileName = "lc3_audio_" + timestamp + ".raw";
            File audioFile = new File(logsDir, currentLc3FileName);

            lc3AudioFileStream = new FileOutputStream(audioFile);

            // Reset statistics
            totalLc3PacketsReceived = 0;
            totalLc3BytesReceived = 0;
            firstLc3PacketTime = System.currentTimeMillis();
            lastLc3PacketTime = firstLc3PacketTime;

            Log.i(TAG, "🎵 LC3 Audio logging initialized - File: " + currentLc3FileName);
            Log.i(TAG, "📁 LC3 logs directory: " + logsDir.getAbsolutePath());

        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to initialize LC3 audio logging", e);
        }
    }

    /**
     * Save LC3 audio packet to file
     */
    private void saveLc3AudioPacket(byte[] lc3Data, byte sequenceNumber) {
        Bridge.log("LIVE: 🎵 Saving LC3 audio packet to file: " + lc3Data.length + " bytes");
        if (!LC3_SAVING_ENABLED || lc3AudioFileStream == null) {
            Bridge.log("LIVE: 🎵 LC3 audio saving disabled or file stream not initialized");
            return;
        }

        // Log the current file path for debugging
        if (currentLc3FileName != null) {
            File logsDir = new File(context.getExternalFilesDir(null), LC3_LOG_DIR);
            String fullPath = new File(logsDir, currentLc3FileName).getAbsolutePath();
            Log.i(TAG, "📁 LC3 Audio file path #####: " + fullPath);
        } else {
            Log.i(TAG, "📁 LC3 Audio file path for saving failed %%%%%%%: " + currentLc3FileName);
        }


        try {
            // Write packet header: [timestamp][sequence][length][data]
            long timestamp = System.currentTimeMillis();
            String timeStr = lc3PacketTimestampFormat.format(new Date(timestamp));

            // Write timestamp and metadata
            String header = String.format("[%s] SEQ:%d LEN:%d\n", timeStr, sequenceNumber, lc3Data.length);
            lc3AudioFileStream.write(header.getBytes(StandardCharsets.UTF_8));

            // Write raw LC3 data
            lc3AudioFileStream.write(lc3Data);
            lc3AudioFileStream.write('\n'); // Newline separator

            lc3AudioFileStream.flush();

        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to save LC3 audio packet", e);
        }
    }

    /**
     * Log detailed LC3 packet information
     */
    private void logLc3PacketDetails(byte[] data, byte sequenceNumber, long receiveTime) {
        if (!LC3_LOGGING_ENABLED) {
            return;
        }

        // Update statistics
        totalLc3PacketsReceived++;
        totalLc3BytesReceived += data.length;
        lastLc3PacketTime = receiveTime;

        if (firstLc3PacketTime == 0) {
            firstLc3PacketTime = receiveTime;
        }

        // Calculate packet timing
        long timeSinceFirst = receiveTime - firstLc3PacketTime;
        long timeSinceLast = receiveTime - lastLc3PacketTime;

        // Log detailed packet information
        // Log.i(TAG, String.format("🎵 LC3 PACKET #%d RECEIVED:", sequenceNumber));
        // Log.i(TAG, String.format("   📊 Size: %d bytes", data.length));
        // Log.i(TAG, String.format("   ⏰ Time: %s", lc3PacketTimestampFormat.format(new Date(receiveTime))));
        // Log.i(TAG, String.format("   ⏱️  Since first: +%dms", timeSinceFirst));
        // Log.i(TAG, String.format("   ⏱️  Since last: +%dms", timeSinceLast));
        // Log.i(TAG, String.format("   📈 Total packets: %d", totalLc3PacketsReceived));
        // Log.i(TAG, String.format("   📈 Total bytes: %d", totalLc3BytesReceived));

        // Log first few bytes for debugging
        if (data.length > 0) {
            StringBuilder hexDump = new StringBuilder("   🔍 First 16 bytes: ");
            for (int i = 0; i < Math.min(16, data.length); i++) {
                hexDump.append(String.format("%02X ", data[i] & 0xFF));
            }
            // Log.d(TAG, hexDump.toString());
        }

        // Log packet statistics every 10 packets
        if (totalLc3PacketsReceived % 10 == 0) {
            long duration = lastLc3PacketTime - firstLc3PacketTime;
            double packetsPerSecond = duration > 0 ? (totalLc3PacketsReceived * 1000.0) / duration : 0;
            double bytesPerSecond = duration > 0 ? (totalLc3BytesReceived * 1000.0) / duration : 0;

            // Log.i(TAG, String.format("📊 LC3 STATS UPDATE:"));
            // Log.i(TAG, String.format("   🎯 Packets/sec: %.2f", packetsPerSecond));
            // Log.i(TAG, String.format("   🎯 Bytes/sec: %.2f", bytesPerSecond));
            // Log.i(TAG, String.format("   🎯 Average packet size: %.1f bytes",
            //     totalLc3PacketsReceived > 0 ? (double) totalLc3BytesReceived / totalLc3PacketsReceived : 0));
        }
    }

    /**
     * Close LC3 audio logging and save final statistics
     */
    private void closeLc3Logging() {
        if (lc3AudioFileStream != null) {
            try {
                // Write final statistics to file
                if (totalLc3PacketsReceived > 0) {
                    long duration = lastLc3PacketTime - firstLc3PacketTime;
                    double packetsPerSecond = duration > 0 ? (totalLc3PacketsReceived * 1000.0) / duration : 0;
                    double bytesPerSecond = duration > 0 ? (totalLc3BytesReceived * 1000.0) / duration : 0;

                    String stats = String.format("\n=== LC3 AUDIO SESSION STATISTICS ===\n");
                    stats += String.format("Total packets received: %d\n", totalLc3PacketsReceived);
                    stats += String.format("Total bytes received: %d\n", totalLc3BytesReceived);
                    stats += String.format("Session duration: %d ms\n", duration);
                    stats += String.format("Average packets/sec: %.2f\n", packetsPerSecond);
                    stats += String.format("Average bytes/sec: %.2f\n", bytesPerSecond);
                    stats += String.format("Average packet size: %.1f bytes\n",
                        (double) totalLc3BytesReceived / totalLc3PacketsReceived);
                    stats += String.format("Session ended: %s\n",
                        lc3TimestampFormat.format(new Date()));
                    stats += "==========================================\n";

                    lc3AudioFileStream.write(stats.getBytes(StandardCharsets.UTF_8));
                }

                lc3AudioFileStream.close();
                lc3AudioFileStream = null;

                Log.i(TAG, "🎵 LC3 Audio logging closed - Final stats written to: " + currentLc3FileName);
                Log.i(TAG, String.format("📊 Final Statistics: %d packets, %d bytes, %.2f packets/sec",
                    totalLc3PacketsReceived, totalLc3BytesReceived,
                    totalLc3PacketsReceived > 0 ? (totalLc3PacketsReceived * 1000.0) / (lastLc3PacketTime - firstLc3PacketTime) : 0));

            } catch (Exception e) {
                Log.e(TAG, "❌ Error closing LC3 audio logging", e);
            }
        }
    }

    /**
     * Public method to manually initialize LC3 logging (for testing/debugging)
     */
    public void manualInitializeLc3Logging() {
        Log.i(TAG, "🔧 Manual LC3 logging initialization requested");
        initializeLc3Logging();
    }

    /**
     * Get current LC3 logging statistics
     */
    public String getLc3LoggingStats() {
        if (totalLc3PacketsReceived == 0) {
            return "No LC3 packets received yet";
        }

        long duration = lastLc3PacketTime - firstLc3PacketTime;
        double packetsPerSecond = duration > 0 ? (totalLc3PacketsReceived * 1000.0) / duration : 0;
        double bytesPerSecond = duration > 0 ? (totalLc3BytesReceived * 1000.0) / duration : 0;

        return String.format("LC3 Stats: %d packets, %d bytes, %.2f packets/sec, %.2f bytes/sec, avg size: %.1f bytes",
            totalLc3PacketsReceived, totalLc3BytesReceived, packetsPerSecond, bytesPerSecond,
            (double) totalLc3BytesReceived / totalLc3PacketsReceived);
    }

    /**
     * Get the current LC3 log file path
     */
    public String getCurrentLc3LogFilePath() {
        if (currentLc3FileName == null) {
            return "No LC3 log file active";
        }
        File logsDir = new File(context.getExternalFilesDir(null), LC3_LOG_DIR);
                 return new File(logsDir, currentLc3FileName).getAbsolutePath();
     }

     /**
      * List all LC3 log files with their sizes
      */
     public String listAllLc3LogFiles() {
         try {
             File logsDir = new File(context.getExternalFilesDir(null), LC3_LOG_DIR);
             if (!logsDir.exists()) {
                 return "LC3 logs directory does not exist";
             }

             File[] files = logsDir.listFiles((dir, name) -> name.endsWith(".raw"));
             if (files == null || files.length == 0) {
                 return "No LC3 log files found";
             }

             StringBuilder result = new StringBuilder("LC3 Log Files:\n");
             for (File file : files) {
                 long sizeKB = file.length() / 1024;
                 result.append(String.format("  📄 %s (%d KB)\n", file.getName(), sizeKB));
             }
             return result.toString();

         } catch (Exception e) {
             return "Error listing LC3 log files: " + e.getMessage();
         }
     }
}
