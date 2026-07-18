package com.mentra.asg_client.io.bluetooth.managers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.core.BaseBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesMessageParser;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900LengthCodec;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialPortBridge;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;
import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.reporting.domains.BluetoothReporting;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.ChunkReassembler;
import com.mentra.asg_client.service.core.processors.ChunkedMessageProtocolStrategy;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.utils.WakeLockManager;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

/**
 * Implementation of IBluetoothManager for K900 devices. Uses the K900's serial port to communicate
 * with the BES2700 Bluetooth module.
 */
public class K900BluetoothManager extends BaseBluetoothManager implements SerialListener {
    private static final String TAG = "K900BluetoothManager";

    private final SerialPortBridge comManager;
    private boolean isSerialOpen = false;
    private final DebugNotificationManager notificationManager;
    // Keep normal K900 messages contiguous on the shared ASG-to-BES UART stream.
    private final Object outboundSendLock = new Object();
    private BesMessageParser messageParser;
    private final Object messageParserLock = new Object();
    private final ChunkReassembler inboundBinaryReassembler = new ChunkReassembler();
    private final ChunkedMessageProtocolStrategy inboundBinaryStrategy =
            new ChunkedMessageProtocolStrategy(inboundBinaryReassembler);
    private boolean wireV2HandshakeSent = false;
    // Message ids whose FLAG_WAKE fragment arrived and are still reassembling; on THAT
    // message's completion the wake window is granted again so follow-up work gets the
    // full window (see handleInboundBinaryFrame). Keyed by msgId because the reassembler
    // interleaves messages. Bounded: abandoned reassemblies would leak entries, so the set
    // is cleared when it exceeds a size no legitimate interleave reaches.
    private final java.util.Set<Integer> pendingBinaryWakeMsgIds = new java.util.LinkedHashSet<>();
    private volatile boolean besWireCapsK900Le = false;
    private volatile boolean besWireCapsBinary = false;
    private volatile boolean besWireCapsFilePayloadV2 = false;
    private volatile int besWireCapsProto = BesWireFormat.PROTOCOL_VERSION_V1;
    private volatile int gattFilePackSize = BesWireFormat.FILE_PACK_SIZE_DEFAULT;
    private volatile int lastNegotiatedMtu = 0;
    private volatile boolean phoneSupportsFilePayloadV2 = false;
    private volatile boolean fileTransportCoc = false;

    // Negotiated K900 STRING length endianness for the ASG<->BES UART link. Defaults to legacy
    // big-endian so unmodified BES firmware keeps working; upgraded to little-endian only when the
    // BES advertises wire_caps.k900_le or we detect little-endian frames on receive.
    private volatile K900LengthCodec.Endian uartToBesEndian = K900LengthCodec.Endian.BE;

    // File transfer state management
    private FileTransferSession currentFileTransfer = null;
    private ScheduledExecutorService fileTransferExecutor;
    private ConcurrentHashMap<Integer, FilePacketState> pendingPackets = new ConcurrentHashMap<>();
    private static final int FILE_TRANSFER_ACK_TIMEOUT_MS = 3000;
    private static final int FILE_TRANSFER_MAX_RETRIES = 5;
    private static final int PHONE_CONFIRMATION_TIMEOUT_MS = 5000; // 5 seconds
    private static final int MAX_TRANSFER_RETRIES = 3; // Max full transfer retries
    private ScheduledFuture<?> phoneConfirmationTimeout = null;

    // BES2700 BLE flow control - tracks consecutive failures for exponential backoff
    private static final int MAX_CONSECUTIVE_FAILURES =
            10; // Abort after this many state=0 in a row
    private static final int BASE_BACKOFF_MS = 150; // Base backoff delay for state=0 failures
    private static final int MAX_BACKOFF_MS = 1000; // Cap exponential backoff at 1 second
    private static final int PACING_DELAY_MS =
            75; // Delay between successful packets - BES2700 needs time to drain BLE TX
    // Push-mode streaming: keep up to this many packets in flight ahead of the highest
    // BES ack instead of ping-ponging one packet per ack round trip. The window must stay
    // small on legacy firmware: its UART RX buffer is ~2KB (~4 full packs) and blasting
    // ahead of its drain rate overruns it (observed as state=0 rejects at pack 9 with a
    // 32 window). Firmware >= 17.26.7.6 has an 8KB RX buffer and acks every 8th pack
    // (batched), which needs a window comfortably above the batch interval.
    private static final int FILE_PUSH_WINDOW = 3;
    // Firmware >=17.26.7.14 keeps its 12KB circular DMA receiver armed across
    // timeout boundaries. A 16-pack window keeps two complete eight-pack ACK
    // batches in flight while remaining well inside the BES receive ring.
    private static final int FILE_PUSH_WINDOW_BATCHED = 8;
    private static final String MIN_BES_VERSION_FOR_BATCHED_ACKS = "17.26.7.7";
    // Negotiated 800-byte CoC payloads use 832-byte UART frames. Keep exactly one complete
    // eight-packet cumulative-ACK batch in flight. Sending a partial second batch before the
    // first ACK repeatedly overran the BES parser on hardware and triggered 150 ms retries.
    private static final int FILE_PUSH_WINDOW_BIG_PACKS = 8;
    private volatile boolean besSupportsBatchedAcks = false;
    private volatile boolean besSupportsBigPacks = false;

    private int effectivePushWindow() {
        if (besSupportsBigPacks) {
            return FILE_PUSH_WINDOW_BIG_PACKS;
        }
        return besSupportsBatchedAcks ? FILE_PUSH_WINDOW_BATCHED : FILE_PUSH_WINDOW;
    }

    /**
     * Firmware 17.26.7.14 keeps circular UART DMA armed across receive timeouts, removing the
     * re-arm gap that dropped early packets during push bursts.
     */
    private static final boolean BATCHED_ACKS_ENABLED = true;

    private int effectiveUartPackSize() {
        return BesWireFormat.getFilePackSize();
    }
    private static final long SIGNIFICANT_CHUNK_TRACE_DURATION_MS = 250;
    private static final long SIGNIFICANT_CHUNK_SEND_DURATION_MS = 250;
    private static final long SIGNIFICANT_CHUNK_SPACING_MS = PACING_DELAY_MS + 150;
    private int consecutiveFailures = 0;
    private volatile int pendingFailureRetryIndex = -1;
    private volatile boolean failureRetryScheduled = false;
    private final AtomicLong bleChunkTraceSequence = new AtomicLong(1);

    // ---- Runtime UART baud switch (cs_baud / sr_baud negotiation with the BES2700) ----
    /** Log tag for the baud negotiation so it is easy to grep. */
    private static final String BAUD_TAG = "BAUD-SWITCH";

    /** Feature switch for the runtime UART baud upgrade. */
    private static final boolean UART_BAUD_SWITCH_ENABLED = true;

    /** Baud rate to upgrade the BES UART link to. 1152000 is the measured hardware
     * ceiling: 1.5M/2M/3M all negotiated fine but carried zero data (probe silent,
     * both sides auto-reverted) - without flow control the clocking above 1.152M
     * doesn't survive the wire. Tested 2026-07-05. */
    private static final int TARGET_UART_BAUD = 1152000;

    /** Minimum BES firmware version (sr_syvr "dpj" dotted string) that supports cs_baud. */
    private static final String MIN_BES_VERSION_FOR_BAUD_SWITCH = "17.26.7.5";

    /** BES switches its UART ~150ms after acking sr_baud; wait a bit longer before reopening. */
    private static final long BAUD_REOPEN_DELAY_MS = 250;

    /** How long to wait for the cs_syvr probe answer at the new baud before reverting. */
    private static final long BAUD_PROBE_TIMEOUT_MS = 3000;

    private final Object baudSwitchLock = new Object();
    private final ScheduledExecutorService baudSwitchExecutor =
            Executors.newSingleThreadScheduledExecutor();

    /** True once we have sent cs_baud. The switch is attempted at most once per boot. */
    private boolean baudSwitchAttempted = false;

    /** True between sending cs_baud and receiving sr_baud (guards spurious sr_baud). */
    private boolean baudSwitchWaitingSrBaud = false;

    private ScheduledFuture<?> baudAckTimeoutFuture = null;

    // Boot-time baud recovery: if asg restarts after a previous baud switch, the BES
    // is still at the high rate while we reopen at the 460800 default - the link is
    // silent until something hunts for the right rate. The default rate has already
    // had the initial-delay window to answer, so probe the only alternate rate once.
    // If the firmware does not implement cs_syvr, return to the default instead of
    // rotating rates forever and corrupting otherwise healthy phone traffic.
    private static final int[] BOOT_BAUD_CANDIDATES = {TARGET_UART_BAUD};
    private volatile long lastSrSyvrTime = 0;
    private int bootRecoveryAttempts = 0;
    private ScheduledFuture<?> bootRecoveryFuture;
    private int recoveryProbeGeneration = 0;

    /** True between reopening at TARGET_UART_BAUD and the sr_syvr probe answer. */
    private boolean baudProbePending = false;

    private ScheduledFuture<?> baudProbeTimeoutFuture = null;

    // Inner class to track file transfer state
    private static class FileTransferSession {
        String filePath;
        String fileName;
        byte[] fileData;
        int fileSize; // Real file size (for our internal tracking)
        int fakeFileSize; // File size written into frame headers (see ctor)
        int packSize; // Data bytes per UART pack, snapshotted for this transfer
        int totalPackets;
        int currentPacketIndex; // next packet index to SEND (may run ahead of acks)
        int highestAckedIndex = -1; // highest packet index BES has acked
        boolean isActive;
        long startTime;
        /** Wall-clock millis when the last UART/BLE packet was MCU-ACKed. */
        long packetsCompleteAtEpochMs;
        boolean waitingForPhoneConfirmation;
        int retryCount;

        // BES2700 firmware hardcodes FILE_PACK_SIZE=400 when calculating totalPack:
        //   totalPack = (fileSize + 400 - 1) / 400
        // We "lie" about fileSize so BES expects the correct number of packets.
        // This allows us to send smaller packets (221 bytes) that fit within BLE MTU.
        private static final int BES_HARDCODED_PACK_SIZE = 400;

        FileTransferSession(
                String filePath,
                String fileName,
                byte[] fileData,
                int packSize,
                boolean dynamicPayloadSupported) {
            this.filePath = filePath;
            this.fileName = fileName;
            this.fileData = fileData;
            this.fileSize = fileData.length;
            this.packSize = packSize;
            this.totalPackets = (fileSize + packSize - 1) / packSize;
            if (dynamicPayloadSupported || packSize > BES_HARDCODED_PACK_SIZE) {
                // Negotiated firmware derives packet counts from the transfer's packSize.
                this.fakeFileSize = fileSize;
            } else {
                // Legacy path: BES hardcodes totalPack = ceil(fileSize / 400); inflate
                // fileSize so its count matches ours when our packs are smaller.
                this.fakeFileSize = totalPackets * BES_HARDCODED_PACK_SIZE;
            }
            this.currentPacketIndex = 0;
            this.isActive = true;
            this.startTime = System.currentTimeMillis();
            this.waitingForPhoneConfirmation = false;
            this.retryCount = 0;

            Log.i(
                    TAG,
                    "📦 BES Lie Strategy: realSize="
                            + fileSize
                            + ", fakeSize="
                            + fakeFileSize
                            + ", totalPackets="
                            + totalPackets
                            + ", actualPackSize="
                            + packSize);
        }
    }

    // Inner class to track packet state
    private static class FilePacketState {
        int retryCount;
        long lastSendTime;

        FilePacketState() {
            this.retryCount = 0;
            this.lastSendTime = System.currentTimeMillis();
        }
    }

    /**
     * Create a new K900BluetoothManager
     *
     * @param context The application context
     */
    public K900BluetoothManager(Context context) {
        super(context);

        // Create the notification manager
        notificationManager = new DebugNotificationManager(context);
        notificationManager.showDeviceTypeNotification(true);

        // Initialize every callback dependency before the serial receive thread starts.
        messageParser = new BesMessageParser();
        fileTransferExecutor = Executors.newSingleThreadScheduledExecutor();

        // Create the communication manager
        comManager = new SerialPortBridge(context);
        comManager.registerListener(this);
        comManager.start();

        // Boot-time baud recovery: if a previous asg run switched the BES to a high
        // baud and asg restarted, we come up at 460800 against a fast BES and the
        // link is silent. Hunt candidate rates until sr_syvr answers.
        synchronized (baudSwitchLock) {
            bootRecoveryFuture =
                    baudSwitchExecutor.schedule(
                            this::bootBaudRecoveryTick,
                            AsgConstants.UART_BOOT_RECOVERY_INITIAL_DELAY_MS,
                            TimeUnit.MILLISECONDS);
        }
    }

    /** No sr_syvr since boot: probe alternate bauds once, then settle at the default. */
    private void bootBaudRecoveryTick() {
        if (lastSrSyvrTime > 0) {
            return; // Link is alive; nothing to recover.
        }
        Integer candidate = null;
        boolean settleAtDefault = false;
        synchronized (baudSwitchLock) {
            if (baudProbePending || baudSwitchWaitingSrBaud || comManager.isOtaUpdating()) {
                scheduleBootRecoveryLocked(AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS);
                return; // A switch/OTA is mid-flight; retry after it releases UART.
            }
            if (!cachedBesSupportsBaudSwitch()) {
                bootRecoveryFuture = null;
                Log.i(
                        BAUD_TAG,
                        "Boot recovery: no cached high-baud-capable BES; staying at rendezvous "
                                + SerialPortBridge.DEFAULT_BAUDRATE);
                return;
            }
            if (bootRecoveryAttempts >= BOOT_BAUD_CANDIDATES.length) {
                bootRecoveryFuture = null;
                settleAtDefault = true;
            } else {
                candidate = BOOT_BAUD_CANDIDATES[bootRecoveryAttempts++];
            }
        }
        if (settleAtDefault) {
            settleBootRecoveryAtDefaultBaud();
            return;
        }
        Log.w(
                BAUD_TAG,
                "Boot recovery: no sr_syvr yet - trying "
                        + candidate
                        + " baud (candidate "
                        + bootRecoveryAttempts
                        + "/"
                        + BOOT_BAUD_CANDIDATES.length
                        + ")");
        try {
            clearMessageParser();
            boolean reopened = comManager.reopen(candidate);
            if (reopened) {
                int generation;
                synchronized (baudSwitchLock) {
                    generation = ++recoveryProbeGeneration;
                }
                scheduleVersionProbeBurst(
                        candidate,
                        generation,
                        () -> lastSrSyvrTime == 0,
                        "boot_recovery");
            }
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Boot recovery reopen failed at " + candidate, e);
        }
        synchronized (baudSwitchLock) {
            if (lastSrSyvrTime == 0) {
                scheduleBootRecoveryLocked(AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS);
            }
        }
    }

    /** The alternate-rate boot probe is safe only after this installation saw capable firmware. */
    private boolean cachedBesSupportsBaudSwitch() {
        try {
            String cachedVersion = new AsgSettings(context).getBesFirmwareVersion();
            return shouldProbeAlternateBaud(cachedVersion);
        } catch (Exception e) {
            Log.w(BAUD_TAG, "Could not read cached BES version; staying at rendezvous baud", e);
            return false;
        }
    }

    /** Pure compatibility gate for the boot-only alternate-baud probe. */
    static boolean shouldProbeAlternateBaud(String cachedVersion) {
        return cachedVersion != null
                && !cachedVersion.trim().isEmpty()
                && compareDottedVersions(
                                cachedVersion.trim(), MIN_BES_VERSION_FOR_BAUD_SWITCH)
                        >= 0;
    }

    /** Must be called with baudSwitchLock held. */
    private void scheduleBootRecoveryLocked(long delayMs) {
        if (bootRecoveryFuture != null) {
            bootRecoveryFuture.cancel(false);
        }
        bootRecoveryFuture =
                baudSwitchExecutor.schedule(this::bootBaudRecoveryTick, delayMs, TimeUnit.MILLISECONDS);
    }

    /** Finish a failed boot probe at the known-safe baud without scheduling another hunt. */
    private void settleBootRecoveryAtDefaultBaud() {
        if (lastSrSyvrTime > 0) {
            return;
        }
        int defaultBaud = SerialPortBridge.DEFAULT_BAUDRATE;
        if (comManager.getCurrentBaud() == defaultBaud) {
            Log.w(BAUD_TAG, "Boot recovery exhausted; remaining at " + defaultBaud + " baud");
            return;
        }
        try {
            clearMessageParser();
            boolean reopened = comManager.reopen(defaultBaud);
            if (reopened) {
                Log.w(
                        BAUD_TAG,
                        "Boot recovery exhausted without sr_syvr; settled at "
                                + defaultBaud
                                + " baud and stopped probing");
            } else {
                Log.e(
                        BAUD_TAG,
                        "Boot recovery could not reopen the default " + defaultBaud + " baud");
            }
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Boot recovery failed to restore default " + defaultBaud + " baud", e);
        }
    }

    @Override
    protected boolean sendMessageInternal(byte[] data) {
        synchronized (outboundSendLock) {
            return sendMessageInternalLocked(data);
        }
    }

    private boolean sendMessageInternalLocked(byte[] data) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 K900 BLUETOOTH SEND DATA");
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 Data length: " + (data != null ? data.length : 0) + " bytes");

        if (data == null || data.length == 0) {
            Log.w(TAG, "📡 ❌ Attempted to send null or empty data");
            return false;
        }

        if (!isSerialOpen) {
            Log.w(TAG, "📡 ❌ Cannot send data - serial port not open");
            notificationManager.showDebugNotification(
                    "Bluetooth Error", "Cannot send data - serial port not open");
            return false;
        }

        Log.d(TAG, "📡 🔍 Checking if data is already in K900 protocol format...");
        // First check if it 's already in protocol format
        if (!BesWireFormat.isK900ProtocolFormat(data)) {
            Log.d(TAG, "📡 📝 Data not in protocol format, processing...");
            // Try to interpret as a JSON string that needs C-wrapping and protocol formatting
            try {
                // Convert to string for processing
                String originalData = new String(data, "UTF-8");
                Log.d(
                        TAG,
                        "📡 📄 Original data as string: "
                                + originalData.substring(0, Math.min(originalData.length(), 100))
                                + "...");

                // If looks like JSON but not C-wrapped, use the full formatting function
                if (originalData.startsWith("{") && !BesWireFormat.isCWrappedJson(originalData)) {
                    Log.d(
                            TAG,
                            "📡 🔧 JSON data detected, applying C-wrapping and protocol"
                                    + " formatting...");
                    Log.d(TAG, "📡 📦 JSON DATA BEFORE C-WRAPPING: " + originalData);

                    if (BesWireFormat.isBinaryProtocolActive()) {
                        if (MessageChunker.needsChunking(originalData)) {
                            return sendBinaryFragmentedJson(originalData);
                        }
                        data = BesWireFormat.formatBinaryMessageForTransmission(originalData);
                        logOutboundWireMetrics(originalData, data, 1);
                    } else {
                        String wrappedJson =
                                BesWireFormat.createTransmissionWrapperJson(originalData);
                        if (MessageChunker.needsChunking(wrappedJson)) {
                            return sendChunkedJson(originalData);
                        }
                        data =
                                BesWireFormat.formatMessageForTransmission(
                                        originalData, uartToBesEndian);
                    }

                    // Log the first 50 bytes of the hex representation
                    StringBuilder hexDump = new StringBuilder();
                    for (int i = 0; i < Math.min(data.length, 50); i++) {
                        hexDump.append(String.format("%02X ", data[i]));
                    }
                    Log.d(
                            TAG,
                            "📡 📦 AFTER C-WRAPPING & PROTOCOL FORMATTING (first 50 bytes): "
                                    + hexDump.toString());
                    Log.d(TAG, "📡 📦 Total formatted length: " + data.length + " bytes");
                } else {
                    // Otherwise just apply protocol formatting
                    Log.d(TAG, "📡 📝 Data already C-wrapped or not JSON: " + originalData);
                    Log.d(TAG, "📡 🔧 Formatting data with K900 protocol (adding ##...)");
                    data =
                            BesWireFormat.packDataCommand(
                                    data, BesWireFormat.CMD_TYPE_STRING, uartToBesEndian);
                }
            } catch (Exception e) {
                // If we can't interpret as string, just apply protocol formatting to raw bytes
                Log.d(TAG, "📡 🔧 Applying protocol format to raw bytes");
                data =
                        BesWireFormat.packDataCommand(
                                data, BesWireFormat.CMD_TYPE_STRING, uartToBesEndian);
            }
        } else {
            Log.d(TAG, "📡 ✅ Data already in K900 protocol format");
        }

        Log.d(TAG, "📡 📤 Sending " + data.length + " bytes via K900 serial");
        BleTraceLogger.logK900Frame("asg_to_bes", "asg_uart_output", data);

        // Send the data via the serial port
        boolean sent = comManager.send(data);
        Log.d(
                TAG,
                "📡 "
                        + (sent
                                ? "✅ Data sent successfully via serial port"
                                : "❌ Failed to send data via serial port"));

        // Only show notification for larger data packets to avoid spam
        if (data.length > 10) {
            notificationManager.showDebugNotification(
                    "Bluetooth Data", "Sent " + data.length + " bytes via serial port");
        }

        return sent;
    }

    /** Reset phone-facing wire protocol state on a new phone connection. */
    public void resetPhoneWireProtocolState() {
        BesWireFormat.resetBinaryProtocol();
        inboundBinaryReassembler.clear();
        // Pending wake grants die with the reassemblies they belong to: a new session
        // reusing an old msgId must not inherit a stale completion-time wake grant.
        pendingBinaryWakeMsgIds.clear();
        wireV2HandshakeSent = false;
    }

    /** Reset all negotiated wire protocol state when the BES UART link is closed. */
    public void resetWireProtocolState() {
        resetPhoneWireProtocolState();
        besWireCapsK900Le = false;
        besWireCapsBinary = false;
        besWireCapsFilePayloadV2 = false;
        besSupportsBigPacks = false;
        besWireCapsProto = BesWireFormat.PROTOCOL_VERSION_V1;
        uartToBesEndian = K900LengthCodec.Endian.BE;
    }

    /** Send BLE Wire v2 handshake frame (payload "v2"). */
    public boolean sendWireV2Handshake() {
        if (!isSerialOpen) {
            return false;
        }
        if (!besWireCapsBinary) {
            Log.i(TAG, "📡 Skipping BLE wire v2 handshake; BES has not advertised binary relay");
            return false;
        }
        byte[] frame = BesWireFormat.packV2HandshakeFrame();
        boolean sent = comManager.send(frame);
        if (sent) {
            wireV2HandshakeSent = true;
            BesWireFormat.setBinaryProtocolActive(true);
            BleTraceLogger.logWireMetrics(
                    "glasses_to_phone",
                    "sdk_ble_handshake",
                    "wire_v2",
                    BesWireFormat.HANDSHAKE_PAYLOAD_V2.length(),
                    frame.length,
                    1,
                    0,
                    BesWireFormat.PROTOCOL_VERSION_V2);
        }
        return sent;
    }

    private boolean sendBinaryFragmentedJson(String originalJson) {
        try {
            OutgoingJsonTraceInfo traceInfo = parseOutgoingJsonTraceInfo(originalJson);
            int msgId = BesWireFormat.allocateBinaryMsgId();
            List<byte[]> frames = MessageChunker.createBinaryFragments(originalJson, msgId);
            Log.d(TAG, "📡 🧩 Sending binary JSON as " + frames.size() + " fragments");

            boolean allSent = true;
            long startedAtMs = System.currentTimeMillis();
            int totalWireBytes = 0;
            for (int i = 0; i < frames.size(); i++) {
                byte[] frame = frames.get(i);
                totalWireBytes += frame.length;
                boolean sent = comManager.send(frame);
                allSent = allSent && sent;
                if (!sent) {
                    Log.w(TAG, "📡 ❌ Binary fragment " + (i + 1) + "/" + frames.size() + " failed");
                    break;
                }
                if (i < frames.size() - 1) {
                    try {
                        Thread.sleep(PACING_DELAY_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                }
            }

            logOutboundWireMetrics(
                    originalJson,
                    null,
                    frames.size(),
                    totalWireBytes,
                    System.currentTimeMillis() - startedAtMs,
                    traceInfo);
            return allSent;
        } catch (Exception e) {
            Log.e(TAG, "Error sending binary fragmented JSON", e);
            return false;
        }
    }

    private void logOutboundWireMetrics(String originalJson, byte[] singleFrame, int packetCount) {
        logOutboundWireMetrics(
                originalJson,
                singleFrame,
                packetCount,
                singleFrame != null ? singleFrame.length : 0,
                0,
                null);
    }

    private void logOutboundWireMetrics(
            String originalJson,
            byte[] singleFrame,
            int packetCount,
            int totalWireBytes,
            long latencyMs,
            OutgoingJsonTraceInfo traceInfo) {
        int payloadBytes = utf8ByteCount(originalJson);
        int wireBytes = singleFrame != null ? singleFrame.length : totalWireBytes;
        String messageType =
                traceInfo != null && traceInfo.commandType != null
                        ? traceInfo.commandType
                        : "binary";
        BleTraceLogger.logWireMetrics(
                "glasses_to_phone",
                "sdk_ble_wire",
                messageType,
                payloadBytes,
                wireBytes,
                packetCount,
                latencyMs,
                BesWireFormat.getActiveProtocolVersion());
    }

    private boolean handleInboundBinaryFrame(byte[] message) {
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(message);
        if (!header.valid) {
            return false;
        }
        besWireCapsBinary = true;
        if (besWireCapsProto < BesWireFormat.PROTOCOL_VERSION_V2) {
            besWireCapsProto = BesWireFormat.PROTOCOL_VERSION_V2;
        }

        if ((header.flags & BesWireFormat.FLAG_HANDSHAKE) != 0) {
            if (BesWireFormat.isV2HandshakePayload(header.payload)) {
                Log.i(TAG, "📡 Received BLE wire v2 handshake from peer");
                BesWireFormat.setBinaryProtocolActive(true);
                BleTraceLogger.logWireMetrics(
                        "phone_to_glasses",
                        "sdk_ble_handshake",
                        "wire_v2",
                        header.payloadLen,
                        message.length,
                        1,
                        0,
                        BesWireFormat.PROTOCOL_VERSION_V2);
                if (!wireV2HandshakeSent) {
                    sendWireV2Handshake();
                }
            }
            return true;
        }

        // Wake-flagged frame: grant a fresh awake window (see AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS —
        // the BES power-key pulse never extends a window already in progress). The string-frame
        // path gets the same grant from CommandProcessor via the "W":1 wrapper field, which
        // binary frames do not carry. FLAG_WAKE rides only the FIRST fragment of a message,
        // so remember it and grant AGAIN when reassembly completes: the command's follow-up
        // work needs its full window from completion, not from the first fragment (a slow
        // multi-fragment reassembly must not eat into it). Extend-only merges the grants.
        if ((header.flags & BesWireFormat.FLAG_WAKE) != 0) {
            if (pendingBinaryWakeMsgIds.size() > 16) {
                // Evict only the OLDEST entry (insertion order): it belongs to the most
                // stale abandoned reassembly, while newer in-flight wake messages keep
                // their completion-time grant.
                java.util.Iterator<Integer> eldest = pendingBinaryWakeMsgIds.iterator();
                eldest.next();
                eldest.remove();
            }
            pendingBinaryWakeMsgIds.add(header.msgId);
            WakeLockManager.acquireCpu(
                    context, WakeLockManager.WakeOwner.PHONE_COMMAND, AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS);
        }

        byte[] reassembled = inboundBinaryStrategy.processBinaryWireFrame(message);
        if (reassembled == null) {
            return true;
        }

        if (pendingBinaryWakeMsgIds.remove(header.msgId)) {
            WakeLockManager.acquireCpu(
                    context, WakeLockManager.WakeOwner.PHONE_COMMAND, AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS);
        }

        BleTraceLogger.logWireMetrics(
                "phone_to_glasses",
                "sdk_ble_wire",
                "binary_reassembled",
                reassembled.length,
                message.length,
                1,
                0,
                BesWireFormat.getActiveProtocolVersion());

        if (!handleSrSyvrResponse(reassembled) && !handleFileTransportResponse(reassembled)) {
            notifyDataReceived(reassembled);
        }
        return true;
    }

    /**
     * Advertise only the wire capabilities that the BES has already proven. Old BES firmware never
     * reports these caps, so phone SDKs stay on legacy K900 STRING and OTA authorization remains
     * reachable.
     */
    public void addPhoneWireCapsIfSupported(JSONObject response) {
        if (response == null
                || (!besWireCapsK900Le && !besWireCapsBinary && !besWireCapsFilePayloadV2)) {
            return;
        }
        try {
            JSONObject caps = new JSONObject();
            if (besWireCapsK900Le) {
                caps.put("k900_le", true);
            }
            if (besWireCapsBinary) {
                caps.put("binary", true);
                caps.put("proto", Math.max(besWireCapsProto, BesWireFormat.PROTOCOL_VERSION_V2));
            }
            if (besWireCapsFilePayloadV2) {
                caps.put("file_payload_v2", true);
                caps.put("file_payload_gatt_max", BesWireFormat.FILE_PACK_SIZE_GATT_MAX);
                caps.put("file_payload_coc_max", BesWireFormat.FILE_PACK_SIZE_COC_MAX);
            }
            response.put("wire_caps", caps);
        } catch (Exception e) {
            Log.w(TAG, "Failed to attach phone wire capabilities", e);
        }
    }

    public boolean isBesBinaryRelaySupported() {
        return besWireCapsBinary;
    }

    /** Queues an internal command without broadcasting it as a phone-facing command response. */
    public boolean sendCommandToGlasses(byte[] data) {
        return sendInternalCommand(data);
    }

    private boolean sendChunkedJson(String originalJson) {
        try {
            OutgoingJsonTraceInfo traceInfo = parseOutgoingJsonTraceInfo(originalJson);

            List<JSONObject> chunks =
                    MessageChunker.createChunks(originalJson, traceInfo.messageId);
            Log.d(TAG, "📡 🧩 Sending chunked JSON as " + chunks.size() + " chunks");

            boolean allSent = true;
            long previousSendAtMs = -1;
            long chunkedSendStartedAtMs = System.currentTimeMillis();
            long maxChunkSendDurationMs = 0;
            long maxChunkSpacingMs = 0;
            for (int i = 0; i < chunks.size(); i++) {
                JSONObject chunk = chunks.get(i);
                String chunkJson = chunk.toString();
                byte[] chunkData =
                        BesWireFormat.formatMessageForTransmission(chunkJson, uartToBesEndian);
                long sequence = bleChunkTraceSequence.getAndIncrement();
                logOutgoingBleChunk(
                        "created", traceInfo, chunk, sequence, chunkData, chunkJson, null, null,
                        null, null);
                Log.d(
                        TAG,
                        "📡 🧩 Sending chunk "
                                + (i + 1)
                                + "/"
                                + chunks.size()
                                + " ("
                                + chunkData.length
                                + " bytes packed)");
                long sendStartedAtMs = System.currentTimeMillis();
                boolean sent = comManager.send(chunkData);
                long sendFinishedAtMs = System.currentTimeMillis();
                long sendDurationMs = sendFinishedAtMs - sendStartedAtMs;
                maxChunkSendDurationMs = Math.max(maxChunkSendDurationMs, sendDurationMs);
                Long timeSincePreviousChunkSendMs =
                        previousSendAtMs >= 0 ? sendStartedAtMs - previousSendAtMs : null;
                if (timeSincePreviousChunkSendMs != null) {
                    maxChunkSpacingMs =
                            Math.max(maxChunkSpacingMs, timeSincePreviousChunkSendMs.longValue());
                }
                previousSendAtMs = sendStartedAtMs;
                logOutgoingBleChunk(
                        "send_result",
                        traceInfo,
                        chunk,
                        sequence,
                        chunkData,
                        chunkJson,
                        sent,
                        sendDurationMs,
                        timeSincePreviousChunkSendMs,
                        i < chunks.size() - 1 ? PACING_DELAY_MS : null);
                allSent = allSent && sent;
                if (!sent) {
                    Log.w(
                            TAG,
                            "📡 ❌ Chunk "
                                    + (i + 1)
                                    + "/"
                                    + chunks.size()
                                    + " failed to send; phone will drop the incomplete message");
                }

                if (i < chunks.size() - 1) {
                    try {
                        Thread.sleep(PACING_DELAY_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        Log.w(TAG, "Interrupted while pacing chunked JSON send");
                        return false;
                    }
                }
            }

            logOutgoingBleChunkSummary(
                    traceInfo,
                    chunks.size(),
                    System.currentTimeMillis() - chunkedSendStartedAtMs,
                    maxChunkSendDurationMs,
                    maxChunkSpacingMs,
                    allSent);
            return allSent;
        } catch (Exception e) {
            Log.e(TAG, "Error chunking JSON for K900 transmission", e);
            return false;
        }
    }

    private OutgoingJsonTraceInfo parseOutgoingJsonTraceInfo(String originalJson) {
        int messageBytes = utf8ByteCount(originalJson);
        try {
            JSONObject original = new JSONObject(originalJson);
            return new OutgoingJsonTraceInfo(
                    nonEmptyString(original, "type"),
                    nonEmptyString(original, "requestId"),
                    nonEmptyString(original, "appId"),
                    original.optLong("mId", -1),
                    messageBytes);
        } catch (Exception ignored) {
            // Chunking also supports non-JSON/ACK-less messages; keep trace logging best-effort.
            return new OutgoingJsonTraceInfo(null, null, null, -1, messageBytes);
        }
    }

    private void logOutgoingBleChunk(
            String stage,
            OutgoingJsonTraceInfo traceInfo,
            JSONObject chunk,
            long sequence,
            byte[] packedData,
            String chunkJson,
            Boolean success,
            Long sendDurationMs,
            Long timeSincePreviousChunkSendMs,
            Integer pacingDelayMs) {
        String warningReason =
                outgoingChunkWarningReason(success, sendDurationMs, timeSincePreviousChunkSendMs);
        if (warningReason == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            int chunkIndex = optIntFallback(chunk, "chunk", "c", -1);
            int totalChunks = optIntFallback(chunk, "total", "n", -1);
            String chunkData = optStringFallback(chunk, "data", "d");
            String chunkId = optStringFallback(chunk, "chunkId", "id");

            payload.put("level", "warning");
            payload.put("warningReason", warningReason);
            payload.put("stage", stage);
            payload.put("sequence", sequence);
            payload.put("chunked", true);
            putIfPresent(payload, "commandType", traceInfo.commandType);
            putIfPresent(payload, "requestId", traceInfo.requestId);
            putIfPresent(payload, "appId", traceInfo.appId);
            if (traceInfo.messageId != -1) {
                payload.put("messageId", traceInfo.messageId);
            }
            putIfPresent(payload, "chunkId", chunkId);
            if (chunkIndex >= 0) {
                payload.put("chunkIndex", chunkIndex);
                payload.put("chunkNumber", chunkIndex + 1);
            }
            if (totalChunks > 0) {
                payload.put("totalChunks", totalChunks);
            }
            payload.put("packedBytes", packedData != null ? packedData.length : 0);
            payload.put("payloadBytes", utf8ByteCount(chunkData));
            payload.put("chunkJsonBytes", utf8ByteCount(chunkJson));
            payload.put("messageBytes", traceInfo.messageBytes);
            if (success != null) {
                payload.put("success", success.booleanValue());
            }
            if (sendDurationMs != null) {
                payload.put("sendDurationMs", sendDurationMs.longValue());
            }
            if (timeSincePreviousChunkSendMs != null) {
                payload.put(
                        "timeSincePreviousChunkSendMs", timeSincePreviousChunkSendMs.longValue());
            }
            if (pacingDelayMs != null) {
                payload.put("pacingDelayMs", pacingDelayMs.intValue());
            }
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }

        BleTraceLogger.logEvent(
                "glasses_to_phone",
                "sdk_ble_chunk",
                traceInfo.commandType != null ? traceInfo.commandType : "chunked",
                payload);
    }

    private void logOutgoingBleChunkSummary(
            OutgoingJsonTraceInfo traceInfo,
            int totalChunks,
            long durationMs,
            long maxChunkSendDurationMs,
            long maxChunkSpacingMs,
            boolean success) {
        String warningReason =
                outgoingChunkSummaryWarningReason(
                        success, durationMs, maxChunkSendDurationMs, maxChunkSpacingMs);
        if (warningReason == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("level", "warning");
            payload.put("warningReason", warningReason);
            payload.put("stage", "summary");
            payload.put("sequence", bleChunkTraceSequence.getAndIncrement());
            payload.put("chunked", true);
            putIfPresent(payload, "commandType", traceInfo.commandType);
            putIfPresent(payload, "requestId", traceInfo.requestId);
            putIfPresent(payload, "appId", traceInfo.appId);
            if (traceInfo.messageId != -1) {
                payload.put("messageId", traceInfo.messageId);
            }
            payload.put("totalChunks", totalChunks);
            payload.put("messageBytes", traceInfo.messageBytes);
            payload.put("durationMs", durationMs);
            payload.put("maxChunkSendDurationMs", maxChunkSendDurationMs);
            payload.put("maxChunkSpacingMs", maxChunkSpacingMs);
            payload.put("pacingDelayMs", PACING_DELAY_MS);
            payload.put("success", success);
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }

        BleTraceLogger.logEvent(
                "glasses_to_phone",
                "sdk_ble_chunk",
                traceInfo.commandType != null ? traceInfo.commandType : "chunked",
                payload);
    }

    private static String outgoingChunkWarningReason(
            Boolean success, Long sendDurationMs, Long timeSincePreviousChunkSendMs) {
        if (Boolean.FALSE.equals(success)) {
            return "chunk_send_failed";
        }
        if (sendDurationMs != null && sendDurationMs >= SIGNIFICANT_CHUNK_SEND_DURATION_MS) {
            return "chunk_send_duration";
        }
        if (timeSincePreviousChunkSendMs != null
                && timeSincePreviousChunkSendMs >= SIGNIFICANT_CHUNK_SPACING_MS) {
            return "chunk_spacing";
        }
        return null;
    }

    private static String outgoingChunkSummaryWarningReason(
            boolean success, long durationMs, long maxChunkSendDurationMs, long maxChunkSpacingMs) {
        if (!success) {
            return "chunked_message_failed";
        }
        if (durationMs >= SIGNIFICANT_CHUNK_TRACE_DURATION_MS) {
            return "chunked_message_duration";
        }
        if (maxChunkSendDurationMs >= SIGNIFICANT_CHUNK_SEND_DURATION_MS) {
            return "chunk_send_duration";
        }
        if (maxChunkSpacingMs >= SIGNIFICANT_CHUNK_SPACING_MS) {
            return "chunk_spacing";
        }
        return null;
    }

    private static String optStringFallback(JSONObject json, String fullKey, String compactKey) {
        if (json == null) {
            return null;
        }
        if (json.has(fullKey)) {
            return json.optString(fullKey, null);
        }
        if (json.has(compactKey)) {
            return json.optString(compactKey, null);
        }
        return null;
    }

    private static int optIntFallback(
            JSONObject json, String fullKey, String compactKey, int defaultValue) {
        if (json == null) {
            return defaultValue;
        }
        if (json.has(fullKey)) {
            return json.optInt(fullKey, defaultValue);
        }
        return json.optInt(compactKey, defaultValue);
    }

    private static String nonEmptyString(JSONObject json, String key) {
        String value = json.optString(key, "");
        return value.isEmpty() ? null : value;
    }

    private static void putIfPresent(JSONObject payload, String key, String value) {
        if (value == null || value.isEmpty()) {
            return;
        }
        try {
            payload.put(key, value);
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }
    }

    private static int utf8ByteCount(String value) {
        return value != null ? value.getBytes(StandardCharsets.UTF_8).length : 0;
    }

    private static class OutgoingJsonTraceInfo {
        final String commandType;
        final String requestId;
        final String appId;
        final long messageId;
        final int messageBytes;

        OutgoingJsonTraceInfo(
                String commandType,
                String requestId,
                String appId,
                long messageId,
                int messageBytes) {
            this.commandType = commandType;
            this.requestId = requestId;
            this.appId = appId;
            this.messageId = messageId;
            this.messageBytes = messageBytes;
        }
    }

    @Override
    public void disconnect() {
        // For K900, we don't directly disconnect BLE
        Log.d(TAG, "K900 manages BT connections at the hardware level");
        notificationManager.showDebugNotification(
                "Bluetooth", "K900 manages BT connections at the hardware level");

        // But we update the state for our listeners
        if (isConnected()) {
            notifyConnectionStateChanged(false);
            notificationManager.showBluetoothStateNotification(false);
        }
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down K900BluetoothManager");

        // Cancel any active file transfer
        if (currentFileTransfer != null && currentFileTransfer.isActive) {
            Log.d(TAG, "Cancelling active file transfer");
            currentFileTransfer.isActive = false;
            comManager.setFastMode(false);
        }

        // Clear pending packets
        pendingPackets.clear();

        // Shutdown file transfer executor
        if (fileTransferExecutor != null) {
            fileTransferExecutor.shutdownNow();
        }

        // Shutdown the baud switch executor (cancels any pending reopen/probe timers)
        synchronized (baudSwitchLock) {
            recoveryProbeGeneration++;
            baudSwitchWaitingSrBaud = false;
            baudProbePending = false;
            cancelBaudAckTimeoutLocked();
            cancelBaudProbeTimeoutLocked();
            if (bootRecoveryFuture != null) {
                bootRecoveryFuture.cancel(false);
                bootRecoveryFuture = null;
            }
        }
        baudSwitchExecutor.shutdownNow();

        // Stop the SerialPortBridge
        if (comManager != null) {
            comManager.stop();
        }

        // Call parent shutdown
        super.shutdown();

        Log.d(TAG, "K900BluetoothManager shut down");
    }

    /**
     * Get the SerialPortBridge instance for BES OTA integration
     *
     * @return SerialPortBridge instance, or null if not initialized
     */
    public SerialPortBridge getSerialPortBridge() {
        return comManager;
    }

    /**
     * Request BES firmware version and MAC address from BES chipset via UART. Sends cs_syvr command
     * to BES, which responds with sr_syvr containing: - version: BES firmware version (e.g.,
     * "17.26.1.14") - btaddr: Bluetooth MAC address - bleaddr: BLE MAC address
     *
     * <p>This is called when serial port is ready, ensuring version info is cached before phone
     * connects, making it available for OTA patch matching.
     */
    public void requestBesSystemVersion() {
        Log.i(TAG, "🔧 Requesting BES system version (cs_syvr) via UART");

        try {
            String commandStr = buildBesSystemVersionCommand();
            Log.d(TAG, "📤 Sending cs_syvr request: " + commandStr);

            // Send via sendMessage() which handles protocol formatting and isSerialOpen check
            boolean sent =
                    sendMessage(commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ BES system version request (cs_syvr) sent successfully via UART");
            } else {
                Log.e(TAG, "❌ Failed to send BES system version request via UART");
            }
        } catch (org.json.JSONException e) {
            Log.e(TAG, "💥 Failed to build cs_syvr request", e);
        }
    }

    /** Build the legacy-compatible system-version request used for discovery and recovery. */
    private static String buildBesSystemVersionCommand() throws org.json.JSONException {
        org.json.JSONObject k900Command = new org.json.JSONObject();
        k900Command.put("C", "cs_syvr");
        k900Command.put("V", 1);
        k900Command.put("B", "");
        return k900Command.toString();
    }

    /** Queue spaced version probes, dropping stale work immediately before the UART write. */
    private void scheduleVersionProbeBurst(
            int expectedBaud,
            int generation,
            BooleanSupplier remainsNeeded,
            String reason) {
        for (int i = 0; i < AsgConstants.UART_RECOVERY_PROBES_PER_BURST; i++) {
            baudSwitchExecutor.schedule(
                    () -> queueGuardedVersionProbe(expectedBaud, generation, remainsNeeded, reason),
                    i * AsgConstants.UART_RECOVERY_PROBE_SPACING_MS,
                    TimeUnit.MILLISECONDS);
        }
    }

    private void queueGuardedVersionProbe(
            int expectedBaud,
            int generation,
            BooleanSupplier remainsNeeded,
            String reason) {
        try {
            byte[] command = buildBesSystemVersionCommand().getBytes(StandardCharsets.UTF_8);
            sendMessage(
                    command,
                    success -> {
                        if (!success) {
                            Log.w(BAUD_TAG, "Version probe did not send (reason=" + reason + ")");
                        }
                    },
                    new SendMessageGate() {
                        @Override
                        public boolean shouldSend() {
                            return generation == recoveryProbeGeneration
                                    && remainsNeeded.getAsBoolean()
                                    && !comManager.isOtaUpdating()
                                    && comManager.getCurrentBaud() == expectedBaud;
                        }

                        @Override
                        public Object lock() {
                            return baudSwitchLock;
                        }
                    });
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Could not queue version probe (reason=" + reason + ")", e);
        }
    }

    /**
     * Handle sr_syvr response from BES chipset. This is called early in the serial read pipeline to
     * avoid timing issues with CommandProcessor initialization.
     *
     * @param payload The JSON payload bytes
     * @return true if this was a sr_syvr response and was handled, false otherwise
     */
    private boolean handleSrSyvrResponse(byte[] payload) {
        try {
            String jsonStr = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject json = new org.json.JSONObject(jsonStr);

            String command = json.optString("C", "");
            if (!"sr_syvr".equals(command)) {
                return false; // Not a sr_syvr response
            }

            Log.i(TAG, "📋 Handling sr_syvr response directly in K900BluetoothManager");

            // Negotiate UART length endianness from the BES's advertised wire_caps.
            applyBesWireCaps(json);

            // Parse the B field: prefer "version" (matches factory / hs_syvr) then "dpj"
            String bFieldStr = json.optString("B", "");
            org.json.JSONObject bData;
            if (bFieldStr.isEmpty()) {
                bData = json.optJSONObject("B");
            } else {
                bData = new org.json.JSONObject(bFieldStr);
            }
            cacheBesVersionFromSyvrBField(bData);

            // Runtime UART baud switch: sr_syvr either confirms our post-reopen probe or,
            // if the firmware is new enough, kicks off the cs_baud negotiation.
            onSrSyvrForBaudSwitch(bData);

            return true; // Handled
        } catch (Exception e) {
            Log.e(TAG, "💥 Error parsing sr_syvr response", e);
            return false; // Let it fall through to normal processing
        }
    }

    /**
     * Inspect a message from the BES for a {@code wire_caps} object and upgrade the UART link to
     * little-endian K900 STRING lengths when the firmware advertises it. {@code wire_caps} may sit
     * at the top level or inside the {@code B} body.
     */
    private void applyBesWireCaps(JSONObject json) {
        if (json == null) {
            return;
        }
        JSONObject caps = json.optJSONObject("wire_caps");
        if (caps == null) {
            JSONObject bData = json.optJSONObject("B");
            if (bData != null) {
                caps = bData.optJSONObject("wire_caps");
            } else {
                String bFieldStr = json.optString("B", "");
                if (!bFieldStr.isEmpty()) {
                    try {
                        caps = new JSONObject(bFieldStr).optJSONObject("wire_caps");
                    } catch (Exception e) {
                        Log.w(TAG, "Could not parse B field for wire_caps", e);
                    }
                }
            }
        }
        if (caps != null && caps.optBoolean("k900_le", false)) {
            besWireCapsK900Le = true;
            if (uartToBesEndian != K900LengthCodec.Endian.LE) {
                uartToBesEndian = K900LengthCodec.Endian.LE;
                Log.i(TAG, "🔤 UART K900 endian negotiated to LE via wire_caps");
            }
        }
        if (caps != null && caps.optBoolean("binary", false)) {
            besWireCapsBinary = true;
            besWireCapsProto = caps.optInt("proto", BesWireFormat.PROTOCOL_VERSION_V2);
            Log.i(TAG, "📡 BES wire_caps advertised binary relay proto=" + besWireCapsProto);
        }
        if (caps != null && caps.optBoolean("file_payload_v2", false)) {
            besWireCapsFilePayloadV2 = true;
            besSupportsBigPacks = true;
            Log.i(TAG, "📦 BES wire_caps advertised negotiated file payloads");
        }
    }

    /** Apply the transport-specific payload selected by BES from the actual CoC peer MTU. */
    private boolean handleFileTransportResponse(byte[] payload) {
        try {
            JSONObject json =
                    new JSONObject(new String(payload, java.nio.charset.StandardCharsets.UTF_8));
            if (!"sr_file_transport".equals(json.optString("C", ""))) {
                return false;
            }
            JSONObject body = json.optJSONObject("B");
            if (body == null) {
                String bodyString = json.optString("B", "");
                body = bodyString.isEmpty() ? new JSONObject() : new JSONObject(bodyString);
            }
            String transport = body.optString("transport", "gatt");
            int payloadSize = body.optInt("payload_size", BesWireFormat.FILE_PACK_SIZE_LEGACY);
            if (payloadSize > BesWireFormat.FILE_PACK_SIZE_LEGACY) {
                phoneSupportsFilePayloadV2 = true;
            }
            if ("coc".equals(transport)
                    && besWireCapsFilePayloadV2
                    && phoneSupportsFilePayloadV2) {
                if (fileTransportCoc
                        && currentFileTransfer != null
                        && currentFileTransfer.packSize > payloadSize) {
                    Log.w(TAG, "CoC MTU shrank during a large-payload transfer; aborting safely");
                    notifyTransferFailedToPhone("coc_mtu_changed");
                    comManager.setFastMode(false);
                    currentFileTransfer = null;
                    pendingPackets.clear();
                }
                BesWireFormat.setFilePackSize(payloadSize);
                fileTransportCoc = true;
            } else {
                int previousGATTSize = gattFilePackSize;
                if (lastNegotiatedMtu > 0) {
                    BesWireFormat.setFilePackSizeFromMtu(
                            lastNegotiatedMtu,
                            besWireCapsFilePayloadV2 && phoneSupportsFilePayloadV2);
                    gattFilePackSize = BesWireFormat.getFilePackSize();
                } else {
                    BesWireFormat.setFilePackSize(gattFilePackSize);
                }
                if (fileTransportCoc
                        && currentFileTransfer != null
                        && currentFileTransfer.packSize > gattFilePackSize) {
                    Log.w(TAG, "CoC closed during a large-payload transfer; aborting safely");
                    notifyTransferFailedToPhone("coc_closed");
                    comManager.setFastMode(false);
                    currentFileTransfer = null;
                    pendingPackets.clear();
                }
                fileTransportCoc = false;
                if (previousGATTSize != gattFilePackSize) {
                    Log.i(
                            TAG,
                            "📦 GATT file payload updated "
                                    + previousGATTSize
                                    + " -> "
                                    + gattFilePackSize);
                }
            }
            Log.i(
                    TAG,
                    "📦 File transport="
                            + transport
                            + " payload="
                            + BesWireFormat.getFilePackSize());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse sr_file_transport", e);
            return false;
        }
    }

    /**
     * Picks the display BES string from sr_syvr B payload: same semantics as {@code hs_syvr} when
     * possible.
     */
    private void cacheBesVersionFromSyvrBField(JSONObject bData) {
        if (bData == null) {
            return;
        }
        String v = bData.optString("version", "");
        if (v.isEmpty()) {
            v = bData.optString("dpj", "");
        }
        if (!v.isEmpty()) {
            cacheBesFirmwareVersion(v);
        }
    }

    // ------------------------------------------------------------------
    // Runtime UART baud switch (BAUD-SWITCH)
    //
    // Flow:
    //  1. On sr_syvr: if BES firmware >= MIN_BES_VERSION_FOR_BAUD_SWITCH and the port is
    //     still at 460800, send {"C":"cs_baud","V":1,"B":{"baud":1152000}}. Once per boot.
    //  2. BES acks with {"C":"sr_baud","S":0,"B":{"ok":1,"baud":1152000}} at the OLD baud,
    //     then switches its own UART ~150ms later.
    //  3. On sr_baud ok=1: wait BAUD_REOPEN_DELAY_MS, reopen /dev/ttyS1 at the new baud and
    //     send cs_syvr as a probe. The sr_syvr answer confirms the link.
    //  4. If no sr_syvr arrives within BAUD_PROBE_TIMEOUT_MS: reopen at 460800 and never
    //     retry this boot. (The BES also self-reverts to 460800 after 10s of silence.)
    //
    // Any exception anywhere leaves/returns the link at 460800.
    // ------------------------------------------------------------------

    /**
     * Handle an sr_syvr response for the baud switch: either confirm a pending post-reopen probe,
     * or evaluate whether to start the cs_baud negotiation.
     *
     * @param bData The parsed sr_syvr B payload (may be null)
     */
    private void onSrSyvrForBaudSwitch(org.json.JSONObject bData) {
        try {
            // Any sr_syvr proves the UART link is alive at the current baud.
            lastSrSyvrTime = System.currentTimeMillis();
            synchronized (baudSwitchLock) {
                if (bootRecoveryFuture != null) {
                    bootRecoveryFuture.cancel(false);
                    bootRecoveryFuture = null;
                }
                if (baudProbePending) {
                    // sr_syvr answered at the new baud - the switch is confirmed.
                    baudProbePending = false;
                    cancelBaudProbeTimeoutLocked();
                    Log.i(
                            BAUD_TAG,
                            "✅ sr_syvr probe answered - UART link confirmed at "
                                    + comManager.getCurrentBaud()
                                    + " baud");
                    return;
                }

                if (!UART_BAUD_SWITCH_ENABLED) {
                    return;
                }
                if (baudSwitchAttempted) {
                    return; // Only attempt the switch once per boot.
                }
                if (comManager.getCurrentBaud() == TARGET_UART_BAUD) {
                    return; // Already at the target (e.g., boot recovery landed there).
                }
                if (comManager.isOtaUpdating()) {
                    Log.i(BAUD_TAG, "BES OTA in progress - skipping baud switch");
                    return;
                }

                String version = extractBaudSwitchVersion(bData);
                if (version.isEmpty()) {
                    Log.d(BAUD_TAG, "sr_syvr carried no dpj/version string - staying at 460800");
                    return;
                }
                if (compareDottedVersions(version, MIN_BES_VERSION_FOR_BAUD_SWITCH) < 0) {
                    Log.i(
                            BAUD_TAG,
                            "BES fw "
                                    + version
                                    + " < "
                                    + MIN_BES_VERSION_FOR_BAUD_SWITCH
                                    + " - no cs_baud support, staying at 460800");
                    return;
                }

                baudSwitchAttempted = true;
                baudSwitchWaitingSrBaud = true;
                Log.i(
                        BAUD_TAG,
                        "BES fw "
                                + version
                                + " supports cs_baud - requesting switch to "
                                + TARGET_UART_BAUD);
            }

            sendCsBaudRequest();
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Error evaluating baud switch eligibility - staying at 460800", e);
        }
    }

    /** Extract the dotted firmware version for the baud gate: prefer "dpj", then "version". */
    private static String extractBaudSwitchVersion(org.json.JSONObject bData) {
        if (bData == null) {
            return "";
        }
        String v = bData.optString("dpj", "");
        if (v.isEmpty()) {
            v = bData.optString("version", "");
        }
        return v.trim();
    }

    /**
     * Compare two dotted version strings numerically, component by component. Missing components
     * count as 0. Each component is read as its leading numeric prefix so hotfix-suffixed
     * firmware strings (e.g. "17.26.7.5-fix1") compare as their base version instead of
     * throwing and silently disabling the transport feature gates.
     *
     * @return negative if a &lt; b, 0 if equal, positive if a &gt; b
     */
    static int compareDottedVersions(String a, String b) {
        String[] as = a.split("\\.");
        String[] bs = b.split("\\.");
        int n = Math.max(as.length, bs.length);
        for (int i = 0; i < n; i++) {
            int av = i < as.length ? leadingInt(as[i]) : 0;
            int bv = i < bs.length ? leadingInt(bs[i]) : 0;
            if (av != bv) {
                return av - bv;
            }
        }
        return 0;
    }

    /** Numeric prefix of a version component ("5-fix1" -> 5); 0 if there is none. */
    private static int leadingInt(String component) {
        String s = component.trim();
        int end = 0;
        while (end < s.length() && Character.isDigit(s.charAt(end))) {
            end++;
        }
        if (end == 0) {
            return 0;
        }
        try {
            return Integer.parseInt(s.substring(0, end));
        } catch (NumberFormatException e) {
            return 0; // digit run longer than Integer range - treat as unknown
        }
    }

    /** Send {"C":"cs_baud","V":1,"B":"{\"baud\":N}"} to the BES over UART. */
    private void sendCsBaudRequest() {
        try {
            org.json.JSONObject body = new org.json.JSONObject();
            body.put("baud", TARGET_UART_BAUD);

            org.json.JSONObject k900Command = new org.json.JSONObject();
            k900Command.put("C", "cs_baud");
            k900Command.put("V", 1);
            // K900 convention: B is a STRING of JSON (cs_ledon etc.) - the BES
            // reads body->valuestring, which is NULL for a nested object.
            k900Command.put("B", body.toString());

            String commandStr = k900Command.toString();
            Log.i(BAUD_TAG, "📤 Sending cs_baud request: " + commandStr);

            boolean sent =
                    sendMessage(
                            commandStr.getBytes(StandardCharsets.UTF_8),
                            success -> {
                                synchronized (baudSwitchLock) {
                                    if (!baudSwitchWaitingSrBaud) {
                                        return;
                                    }
                                    if (!success) {
                                        baudSwitchWaitingSrBaud = false;
                                        cancelBaudAckTimeoutLocked();
                                        Log.e(
                                                BAUD_TAG,
                                                "Failed to write cs_baud - staying at rendezvous");
                                        return;
                                    }
                                    cancelBaudAckTimeoutLocked();
                                    baudAckTimeoutFuture =
                                            baudSwitchExecutor.schedule(
                                                    this::onBaudAckTimeout,
                                                    AsgConstants.UART_BAUD_ACK_TIMEOUT_MS,
                                                    TimeUnit.MILLISECONDS);
                                }
                            });
            if (!sent) {
                Log.e(BAUD_TAG, "Failed to send cs_baud - staying at 460800");
                synchronized (baudSwitchLock) {
                    baudSwitchWaitingSrBaud = false;
                    cancelBaudAckTimeoutLocked();
                }
            }
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Error building/sending cs_baud - staying at 460800", e);
            synchronized (baudSwitchLock) {
                baudSwitchWaitingSrBaud = false;
                cancelBaudAckTimeoutLocked();
            }
        }
    }

    /** A lost old-baud ack is ambiguous: BES may already have switched, so verify target once. */
    private void onBaudAckTimeout() {
        synchronized (baudSwitchLock) {
            if (!baudSwitchWaitingSrBaud) {
                return;
            }
            baudSwitchWaitingSrBaud = false;
            baudAckTimeoutFuture = null;
        }
        Log.w(BAUD_TAG, "No sr_baud acknowledgement; probing the requested target baud");
        reopenAtTargetBaudAndProbe();
    }

    /**
     * Handle sr_baud response from the BES. Called early in the serial read pipeline (same place
     * as sr_syvr) since the negotiation lives entirely in this class.
     *
     * @param payload The JSON payload bytes
     * @return true if this was an sr_baud response and was consumed, false otherwise
     */
    private boolean handleSrBaudResponse(byte[] payload) {
        try {
            String jsonStr = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject json = new org.json.JSONObject(jsonStr);
            if (!"sr_baud".equals(json.optString("C", ""))) {
                return false; // Not an sr_baud response
            }

            Log.i(BAUD_TAG, "📥 Received sr_baud: " + jsonStr);

            synchronized (baudSwitchLock) {
                if (!baudSwitchWaitingSrBaud) {
                    Log.w(BAUD_TAG, "Unexpected sr_baud (no cs_baud pending) - ignoring");
                    return true;
                }
                baudSwitchWaitingSrBaud = false;
                cancelBaudAckTimeoutLocked();
            }

            String bFieldStr = json.optString("B", "");
            org.json.JSONObject bData;
            if (bFieldStr.isEmpty()) {
                bData = json.optJSONObject("B");
            } else {
                bData = new org.json.JSONObject(bFieldStr);
            }

            // Success is the standard K900 status field: {"C":"sr_baud","S":0,"B":{"baud":N}}
            // (S=0 is RC_SUCCESS; there is no "ok" field in the firmware reply).
            int status = json.optInt("S", -1);
            int ackedBaud = bData != null ? bData.optInt("baud", -1) : -1;

            if (status != 0) {
                Log.w(BAUD_TAG, "BES rejected baud switch (S=" + status + ") - staying at 460800");
                return true;
            }
            if (ackedBaud != TARGET_UART_BAUD) {
                Log.e(
                        BAUD_TAG,
                        "BES acked unexpected baud "
                                + ackedBaud
                                + " (wanted "
                                + TARGET_UART_BAUD
                                + ") - aborting, staying at 460800");
                return true;
            }

            Log.i(
                    BAUD_TAG,
                    "BES accepted "
                            + TARGET_UART_BAUD
                            + " - reopening UART in "
                            + BAUD_REOPEN_DELAY_MS
                            + "ms");
            baudSwitchExecutor.schedule(
                    this::reopenAtTargetBaudAndProbe,
                    BAUD_REOPEN_DELAY_MS,
                    TimeUnit.MILLISECONDS);
            return true;
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Error parsing sr_baud response", e);
            return false; // Let it fall through to normal processing
        }
    }

    /**
     * Runs on the baud switch executor ~250ms after sr_baud ok=1: reopen the serial port at
     * TARGET_UART_BAUD and probe the BES with cs_syvr. Reverts to 460800 on any failure.
     */
    private void reopenAtTargetBaudAndProbe() {
        try {
            clearMessageParser();
            boolean reopened = comManager.reopen(TARGET_UART_BAUD);
            if (!reopened) {
                Log.e(
                        BAUD_TAG,
                        "‼️ Reopen at " + TARGET_UART_BAUD + " FAILED - reverting to 460800");
                revertToDefaultBaud("reopen_failed");
                return;
            }

            synchronized (baudSwitchLock) {
                baudProbePending = true;
                recoveryProbeGeneration++;
                cancelBaudProbeTimeoutLocked();
                baudProbeTimeoutFuture =
                        baudSwitchExecutor.schedule(
                                this::onBaudProbeTimeout,
                                BAUD_PROBE_TIMEOUT_MS,
                                TimeUnit.MILLISECONDS);
            }

            Log.i(BAUD_TAG, "UART reopened at " + TARGET_UART_BAUD + " - probing with cs_syvr");
            int generation;
            synchronized (baudSwitchLock) {
                generation = recoveryProbeGeneration;
            }
            scheduleVersionProbeBurst(
                    TARGET_UART_BAUD,
                    generation,
                    () -> baudProbePending,
                    "baud_verification");
        } catch (Exception e) {
            Log.e(BAUD_TAG, "‼️ Exception during baud reopen - reverting to 460800", e);
            revertToDefaultBaud("reopen_exception");
        }
    }

    /** Fires when no sr_syvr arrived within BAUD_PROBE_TIMEOUT_MS of the post-reopen probe. */
    private void onBaudProbeTimeout() {
        synchronized (baudSwitchLock) {
            if (!baudProbePending) {
                return; // Probe already confirmed.
            }
            baudProbePending = false;
            baudProbeTimeoutFuture = null;
        }
        Log.e(
                BAUD_TAG,
                "‼️ NO sr_syvr within "
                        + BAUD_PROBE_TIMEOUT_MS
                        + "ms at "
                        + TARGET_UART_BAUD
                        + " baud - REVERTING to 460800 and will NOT retry this boot");
        revertToDefaultBaud("probe_timeout");
    }

    /** Reopen the UART at the default 460800 baud. Never retries the switch afterwards. */
    private void revertToDefaultBaud(String reason) {
        synchronized (baudSwitchLock) {
            baudProbePending = false;
            cancelBaudProbeTimeoutLocked();
        }
        try {
            clearMessageParser();
            boolean ok = comManager.reopen(SerialPortBridge.DEFAULT_BAUDRATE);
            Log.e(
                    BAUD_TAG,
                    "Revert to "
                            + SerialPortBridge.DEFAULT_BAUDRATE
                            + " (reason="
                            + reason
                            + ") "
                            + (ok ? "succeeded" : "FAILED - UART may be down"));
        } catch (Exception e) {
            Log.e(BAUD_TAG, "‼️ Exception reverting to 460800 (reason=" + reason + ")", e);
        }
    }

    /** Must be called with baudSwitchLock held. */
    private void cancelBaudProbeTimeoutLocked() {
        if (baudProbeTimeoutFuture != null) {
            baudProbeTimeoutFuture.cancel(false);
            baudProbeTimeoutFuture = null;
        }
    }

    /** Must be called with baudSwitchLock held. */
    private void cancelBaudAckTimeoutLocked() {
        if (baudAckTimeoutFuture != null) {
            baudAckTimeoutFuture.cancel(false);
            baudAckTimeoutFuture = null;
        }
    }

    /**
     * Cache BES firmware version to SharedPreferences. Uses the same storage as AsgSettings for
     * compatibility.
     */
    private void cacheBesFirmwareVersion(String version) {
        if (version == null || version.isEmpty()) {
            Log.w(TAG, "⚠️ Attempted to cache empty BES firmware version");
            return;
        }

        Log.i(TAG, "📋 Caching BES firmware version: " + version);

        try {
            besSupportsBatchedAcks =
                    BATCHED_ACKS_ENABLED
                            && compareDottedVersions(version, MIN_BES_VERSION_FOR_BATCHED_ACKS)
                                    >= 0;
            Log.i(
                    TAG,
                    "📦 Batched-ack push mode "
                            + (besSupportsBatchedAcks ? "ENABLED" : "disabled")
                            + ", big packs "
                            + (besSupportsBigPacks ? "ENABLED" : "disabled")
                            + " (fw " + version + ", window " + effectivePushWindow()
                            + ", packSize " + effectiveUartPackSize() + ")");
        } catch (Exception e) {
            besSupportsBatchedAcks = false;
        }

        try {
            android.content.SharedPreferences prefs =
                    context.getSharedPreferences(
                            "asg_settings", android.content.Context.MODE_PRIVATE);
            prefs.edit().putString("mcu_firmware_version", version).commit();
            Log.i(TAG, "✅ BES firmware version cached successfully: " + version);

            // Re-send version chunks so phone/OTA get fresh BES (onCreate may have run before UART
            // was up).
            android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
            main.post(
                    () -> {
                        AsgClientService svc = AsgClientService.getInstance();
                        if (svc != null) {
                            Log.i(
                                    TAG,
                                    "📋 BES version updated from UART — re-sending version info to"
                                            + " phone");
                            svc.sendVersionInfo();
                        }
                    });
        } catch (Exception e) {
            Log.e(TAG, "💥 Failed to cache BES firmware version", e);
        }
    }

    @Override
    public void stopAdvertising() {
        // K900 doesn't need to stop advertising manually
        Log.d(TAG, "K900 BT module handles advertising automatically");
    }

    @Override
    public boolean isConnected() {
        // For K900, we consider the device connected if the serial port is open
        return isSerialOpen && super.isConnected();
    }

    @Override
    public void startAdvertising() {
        // K900 doesn't need to advertise manually, as BES2700 handles this
        Log.d(TAG, "K900 BT module handles advertising automatically");
        notificationManager.showDebugNotification(
                "Bluetooth", "K900 BT module handles advertising automatically");
    }

    @Override
    public void onSerialClose(String serialPath) {
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 K900 SERIAL CLOSE");
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 Serial path: " + serialPath);

        isSerialOpen = false;
        resetWireProtocolState();
        Log.d(TAG, "🔌 ✅ Serial port marked as closed");

        // When the serial port closes, we consider ourselves disconnected
        Log.d(TAG, "🔌 📡 Notifying connection state changed to false...");
        notifyConnectionStateChanged(false);
        Log.d(TAG, "🔌 ✅ Connection state notification sent");

        notificationManager.showBluetoothStateNotification(false);
        notificationManager.showDebugNotification(
                "Serial Closed", "Serial port closed: " + serialPath);
        Log.d(TAG, "🔌 ✅ Bluetooth state notifications sent");
    }

    @Override
    public void onSerialRead(String serialPath, byte[] data, int size) {
        // Log serial reads for debugging (especially for hs_syvr response)
        Log.d(TAG, "📥 K900 SERIAL READ - " + size + " bytes");

        if (data != null && size > 0) {
            // Copy the data to avoid issues with buffer reuse
            byte[] dataCopy = new byte[size];
            System.arraycopy(data, 0, dataCopy, 0, size);

            // Hex dump suppressed to prevent logcat overflow
            // Enable only when debugging specific issues

            boolean parserAcceptedData = false;
            List<byte[]> completeMessages = null;
            synchronized (messageParserLock) {
                if (messageParser != null) {
                    parserAcceptedData = messageParser.addData(dataCopy, size);
                    if (parserAcceptedData) {
                        completeMessages = messageParser.parseMessages();
                    }
                }
            }

            if (!parserAcceptedData) {
                // If parser is not available or data couldn't be added, send raw data
                Log.d(TAG, "📥 📤 Parser unavailable, notifying listeners of raw data...");
                notifyDataReceived(dataCopy);
            } else if (completeMessages == null || completeMessages.isEmpty()) {
                // No complete messages yet, just accumulating data
                Log.d(TAG, "📥 Data added to parser, waiting for complete message");
            } else {
                Log.d(TAG, "📥 Extracted " + completeMessages.size() + " complete messages");
                // Process each complete message outside the parser lock.
                for (byte[] message : completeMessages) {
                    BleTraceLogger.logK900Frame("bes_to_asg", "asg_uart_input", message);

                    // Check for file transfer acknowledgments first
                    processReceivedMessage(message);

                    // Extract payload from K900 protocol message for listeners
                    if (BesWireFormat.isBinaryWireFrame(message)) {
                        handleInboundBinaryFrame(message);
                    } else if (BesWireFormat.isK900ProtocolFormat(message)) {
                        // Auto-detect the length endianness so we parse frames from both legacy
                        // big-endian and wire-v2 little-endian BES firmware (fixes the
                        // "Extracted length=9472" misframe against old firmware).
                        K900LengthCodec.Detected detected = K900LengthCodec.detectLength(message);
                        if (detected != null) {
                            uartToBesEndian = detected.endian;
                        }
                        byte[] payload = BesWireFormat.extractPayloadAuto(message);

                        if (payload != null && payload.length > 0) {
                            // Notify listeners with the clean payload (JSON data without markers)
                            String payloadPreview =
                                    new String(payload, 0, Math.min(payload.length, 200));
                            Log.d(
                                    TAG,
                                    "📥 Extracted K900 payload ("
                                            + payload.length
                                            + " bytes): "
                                            + payloadPreview);

                            // Check if this is a sr_syvr response (BES system version)
                            // or an sr_baud response (UART baud switch ack).
                            // Handle them directly here to avoid timing issues with
                            // CommandProcessor initialization
                            if (!handleSrSyvrResponse(payload)
                                    && !handleSrBaudResponse(payload)
                                    && !handleFileTransportResponse(payload)) {
                                // Not a sr_syvr/sr_baud response, forward to listeners
                                notifyDataReceived(payload);
                            }
                        } else {
                            Log.w(TAG, "📥 Failed to extract payload from K900 message");
                        }
                    } else {
                        // Not a K900 protocol message, pass as-is
                        Log.d(TAG, "📥 Non-K900 message, passing as-is");
                        notifyDataReceived(message);
                    }
                }
            }
            // Data processing complete
        } else {
            Log.w(TAG, "📥 ❌ Invalid data received - null or empty");
        }
    }

    @Override
    public void onSerialReady(String serialPath) {
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 K900 SERIAL READY");
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 Serial path: " + serialPath);

        isSerialOpen = true;
        Log.d(TAG, "🔌 ✅ Serial port marked as open");

        // For K900, when the serial port is ready, we consider ourselves "connected"
        // to the BT module
        Log.d(TAG, "🔌 📡 Notifying connection state changed to true...");
        notifyConnectionStateChanged(true);
        Log.d(TAG, "🔌 ✅ Connection state notification sent");

        notificationManager.showBluetoothStateNotification(true);
        notificationManager.showDebugNotification(
                "Serial Ready", "Serial port ready: " + serialPath);
        Log.d(TAG, "🔌 ✅ Bluetooth state notifications sent");

        Log.d(TAG, "🔌 📋 Requesting BES system version via UART");
        requestBesSystemVersion();
    }

    @Override
    public void onBesOtaApplied() {
        Log.i(BAUD_TAG, "BES OTA applied; scheduling reconnect at rendezvous baud");
        int generation;
        synchronized (baudSwitchLock) {
            generation = ++recoveryProbeGeneration;
            lastSrSyvrTime = 0;
            baudSwitchAttempted = false;
            baudSwitchWaitingSrBaud = false;
            baudProbePending = false;
            cancelBaudAckTimeoutLocked();
            cancelBaudProbeTimeoutLocked();
            if (bootRecoveryFuture != null) {
                bootRecoveryFuture.cancel(false);
                bootRecoveryFuture = null;
            }
        }
        scheduleBesOtaReconnect(
                generation,
                1,
                AsgConstants.BES_OTA_RECONNECT_DELAY_MS,
                "initial reboot wait");
    }

    private void scheduleBesOtaReconnect(
            int generation, int attempt, long delayMs, String reason) {
        baudSwitchExecutor.schedule(
                () -> reconnectAfterBesOta(generation, attempt, reason),
                delayMs,
                TimeUnit.MILLISECONDS);
    }

    /** BES reboots at 460800 after OTA; rediscover there and negotiate again if supported. */
    private void reconnectAfterBesOta(int generation, int attempt, String previousReason) {
        synchronized (baudSwitchLock) {
            if (generation != recoveryProbeGeneration || lastSrSyvrTime > 0) {
                return;
            }
        }
        if (attempt > AsgConstants.BES_OTA_RECONNECT_ATTEMPTS) {
            Log.e(
                    BAUD_TAG,
                    "BES OTA reconnect exhausted after "
                            + AsgConstants.BES_OTA_RECONNECT_ATTEMPTS
                            + " attempts (last reason="
                            + previousReason
                            + ")");
            return;
        }
        if (comManager.isOtaUpdating()) {
            scheduleBesOtaReconnect(
                    generation,
                    attempt + 1,
                    AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS,
                    "OTA still owns UART");
            return;
        }
        try {
            clearMessageParser();
            boolean reopened = comManager.reopen(SerialPortBridge.DEFAULT_BAUDRATE);
            if (!reopened) {
                scheduleBesOtaReconnect(
                        generation,
                        attempt + 1,
                        AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS,
                        "rendezvous reopen failed");
                return;
            }
            scheduleVersionProbeBurst(
                    SerialPortBridge.DEFAULT_BAUDRATE,
                    generation,
                    () -> lastSrSyvrTime == 0,
                    "bes_ota_reconnect");
            scheduleBesOtaReconnect(
                    generation,
                    attempt + 1,
                    AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS,
                    "no version response");
        } catch (Exception e) {
            Log.e(BAUD_TAG, "Failed to reconnect after BES OTA", e);
            scheduleBesOtaReconnect(
                    generation,
                    attempt + 1,
                    AsgConstants.UART_BOOT_RECOVERY_RETRY_DELAY_MS,
                    "reconnect exception");
        }
    }

    private void clearMessageParser() {
        synchronized (messageParserLock) {
            if (messageParser != null) {
                messageParser.clear();
            }
        }
    }

    @Override
    public void onSerialOpen(boolean bSucc, int code, String serialPath, String msg) {
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 K900 SERIAL OPEN");
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 Success: " + bSucc);
        Log.d(TAG, "🔌 Code: " + code);
        Log.d(TAG, "🔌 Serial path: " + serialPath);
        Log.d(TAG, "🔌 Message: " + msg);

        isSerialOpen = bSucc;
        Log.d(TAG, "🔌 Serial port open state set to: " + bSucc);

        if (bSucc) {
            Log.d(TAG, "🔌 ✅ Serial port opened successfully");
            notificationManager.showDebugNotification(
                    "Serial Open", "Serial port opened successfully: " + serialPath);
        } else {
            Log.d(TAG, "🔌 ❌ Failed to open serial port");
            notificationManager.showDebugNotification(
                    "Serial Error", "Failed to open serial port: " + serialPath + " - " + msg);
        }
    }

    /**
     * Check if a file transfer is currently in progress
     *
     * @return true if a transfer is active, false otherwise
     */
    public boolean isFileTransferInProgress() {
        return currentFileTransfer != null && currentFileTransfer.isActive;
    }

    /**
     * Send an image file over the K900 Bluetooth connection
     *
     * @param filePath Path to the image file to send
     * @return true if transfer started successfully
     */
    @Override
    protected boolean sendFileInternal(String filePath) {
        if (!isSerialOpen) {
            Log.e(TAG, "Cannot send file - serial port not open");

            // Report file transfer failure
            BluetoothReporting.reportFileTransferFailure(
                    context, filePath, "send_file", "serial_port_not_open", null);
            return false;
        }

        if (currentFileTransfer != null && currentFileTransfer.isActive) {
            Log.e(TAG, "File transfer already in progress");

            // Report file transfer failure
            BluetoothReporting.reportFileTransferFailure(
                    context, filePath, "send_file", "transfer_already_in_progress", null);
            return false;
        }

        File file = new File(filePath);
        if (!file.exists() || !file.isFile()) {
            Log.e(TAG, "File not found: " + filePath);

            // Report file transfer failure
            BluetoothReporting.reportFileTransferFailure(
                    context, filePath, "send_file", "file_not_found", null);
            return false;
        }

        // Read the file data
        byte[] fileData;
        try (FileInputStream fis = new FileInputStream(file)) {
            fileData = new byte[(int) file.length()];
            int bytesRead = fis.read(fileData);
            if (bytesRead != fileData.length) {
                Log.e(TAG, "Failed to read complete file");

                // Report file transfer failure
                BluetoothReporting.reportFileTransferFailure(
                        context, filePath, "send_file", "incomplete_file_read", null);
                return false;
            }
        } catch (IOException e) {
            Log.e(TAG, "Error reading file: " + filePath, e);

            // Report file transfer failure with exception
            BluetoothReporting.reportFileTransferFailure(
                    context, filePath, "send_file", "io_exception", e);
            return false;
        }

        return startFileTransferSession(filePath, file.getName(), fileData);
    }

    /**
     * Send an in-memory payload over the K900 file-transfer protocol without a backing file.
     * Everything after session creation (packet pump, acks, retries) already operates on the
     * in-memory {@code fileData} buffer, so no disk artifact is required.
     *
     * @param data payload bytes
     * @param fileName wire name for the transfer (truncated to the 16-char protocol cap)
     * @return true if transfer started successfully
     */
    @Override
    protected boolean sendFileInternal(byte[] data, String fileName) {
        if (!isSerialOpen) {
            Log.e(TAG, "Cannot send in-memory file - serial port not open");
            BluetoothReporting.reportFileTransferFailure(
                    context, memoryReportPath(fileName), "send_file", "serial_port_not_open", null);
            return false;
        }

        if (currentFileTransfer != null && currentFileTransfer.isActive) {
            Log.e(TAG, "File transfer already in progress");
            BluetoothReporting.reportFileTransferFailure(
                    context,
                    memoryReportPath(fileName),
                    "send_file",
                    "transfer_already_in_progress",
                    null);
            return false;
        }

        return startFileTransferSession(null, fileName, data);
    }

    /** Synthetic identifier for Sentry reports on transfers that never touch disk. */
    private static String memoryReportPath(String fileName) {
        return "mem:" + fileName;
    }

    /**
     * Create the transfer session and start the packet pump. {@code filePath} is {@code null} for
     * in-memory transfers; it is only used for post-transfer cleanup and failure reporting.
     */
    private boolean startFileTransferSession(String filePath, String fileName, byte[] fileData) {
        if (fileName.length() > 16) {
            fileName = fileName.substring(0, 16); // Truncate to 16 chars max
        }

        currentFileTransfer =
                new FileTransferSession(
                        filePath,
                        fileName,
                        fileData,
                        effectiveUartPackSize(),
                        besWireCapsFilePayloadV2);
        pendingPackets.clear();
        consecutiveFailures = 0; // Reset failure counter for new transfer
        pendingFailureRetryIndex = -1;
        failureRetryScheduled = false;

        Log.d(
                TAG,
                "Starting file transfer: "
                        + fileName
                        + " ("
                        + fileData.length
                        + " bytes, "
                        + currentFileTransfer.totalPackets
                        + " packets, "
                        + (filePath != null ? "disk-backed" : "in-memory")
                        + ")");

        notificationManager.showDebugNotification(
                "File Transfer",
                "Starting transfer of "
                        + fileName
                        + " ("
                        + currentFileTransfer.totalPackets
                        + " packets)");

        // Enable fast mode for file transfer
        comManager.setFastMode(true);

        // Send the first packet
        sendNextFilePacket();

        return true;
    }

    /**
     * Pump file packets in push mode: stream up to FILE_PUSH_WINDOW packets ahead of the
     * highest BES ack instead of waiting one ack round trip per packet. Completion fires
     * once the acks (not the sends) have covered every packet.
     */
    private void sendNextFilePacket() {
        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        if (currentFileTransfer.highestAckedIndex + 1 >= currentFileTransfer.totalPackets) {
            // All packets sent and ACKed by MCU
            long now = System.currentTimeMillis();
            long transferDuration = now - currentFileTransfer.startTime;
            currentFileTransfer.packetsCompleteAtEpochMs = now;
            BlePhotoTimingLog.recordUartTransfer(
                    currentFileTransfer.fileName,
                    currentFileTransfer.fileSize,
                    transferDuration);
            int rateKbps =
                    transferDuration > 0
                            ? (int) (currentFileTransfer.fileSize * 1000L / transferDuration / 1024)
                            : 0;
            BlePhotoTimingLog.event(
                    "TRANSFER",
                    "all UART/BLE packets sent and ACKed by glasses MCU (BES) | file="
                            + currentFileTransfer.fileName
                            + " | uart_tx="
                            + transferDuration
                            + "ms | size="
                            + String.format("%.1f", currentFileTransfer.fileSize / 1024.0)
                            + "KB | ~"
                            + rateKbps
                            + "KB/s — now waiting for phone transfer_complete");
            Log.d(TAG, "📤 All packets sent and ACKed by MCU: " + currentFileTransfer.fileName);
            Log.d(
                    TAG,
                    "⏱️ Transfer took: "
                            + transferDuration
                            + "ms for "
                            + currentFileTransfer.fileSize
                            + " bytes");
            Log.d(
                    TAG,
                    "📊 Transfer rate: "
                            + (currentFileTransfer.fileSize * 1000 / transferDuration)
                            + " bytes/sec");
            Log.d(TAG, "⏳ Waiting for phone confirmation before cleanup...");

            notificationManager.showDebugNotification(
                    "Waiting for Phone Confirmation",
                    currentFileTransfer.fileName + " - " + transferDuration + "ms");

            // Set state to waiting for phone confirmation
            currentFileTransfer.waitingForPhoneConfirmation = true;

            // Start timeout for phone confirmation (5 seconds)
            schedulePhoneConfirmationTimeout();

            // DO NOT delete file yet!
            // DO NOT clear state yet!
            // Keep everything in memory for potential retry
            return;
        }

        // Push-mode pump: send until the window ahead of the acks is full. The UART
        // write blocks on the tty buffer, so the loop self-paces at the line rate.
        while (currentFileTransfer != null
                && currentFileTransfer.isActive
                && currentFileTransfer.currentPacketIndex < currentFileTransfer.totalPackets
                && currentFileTransfer.currentPacketIndex - currentFileTransfer.highestAckedIndex
                        <= effectivePushWindow()) {
            if (!sendFilePacketAt(currentFileTransfer.currentPacketIndex)) {
                return;
            }
            currentFileTransfer.currentPacketIndex++;
        }
    }

    /** Send one file packet. Returns false if the transfer was aborted. */
    private boolean sendFilePacketAt(int packetIndex) {
        long methodStartTime = System.currentTimeMillis();

        // Calculate packet data
        int offset = packetIndex * currentFileTransfer.packSize;
        int packSize =
                Math.min(currentFileTransfer.packSize, currentFileTransfer.fileSize - offset);

        // Extract packet data
        byte[] packetData = new byte[packSize];
        System.arraycopy(currentFileTransfer.fileData, offset, packetData, 0, packSize);

        // Pack the file packet
        // NOTE: We use fakeFileSize to lie to BES firmware about total file size.
        // BES hardcodes 400-byte pack size when calculating totalPack, so we inflate
        // fileSize to make BES expect the correct number of our smaller packets.
        // Advertise push-mode/batched-ack support to firmware that understands it
        // (bit 0 of the flags field; older firmware never reads flags).
        int flags = besSupportsBatchedAcks ? BesWireFormat.FILE_FLAG_PUSH_BATCH_ACK : 0;
        if (besWireCapsFilePayloadV2) {
            flags |= BesWireFormat.FILE_FLAG_DYNAMIC_PAYLOAD;
        }
        byte[] packet =
                BesWireFormat.packFilePacket(
                        packetData,
                        packetIndex,
                        packSize,
                        currentFileTransfer.fakeFileSize,
                        currentFileTransfer.fileName,
                        flags,
                        BesWireFormat.CMD_TYPE_PHOTO);

        if (packet == null) {
            Log.e(TAG, "Failed to pack file packet " + packetIndex);
            notifyTransferFailedToPhone("packet_pack_failed");
            currentFileTransfer = null;
            return false;
        }

        // Send the packet using sendFile (no logging)
        long sendStartTime = System.currentTimeMillis();
        boolean sent = comManager.sendFile(packet);
        long sendEndTime = System.currentTimeMillis();
        if (!sent) {
            Log.e(TAG, "Failed to write file packet " + packetIndex + " to UART");
            BluetoothReporting.reportFileTransferFailure(
                    context, transferReportPath(), "send_file", "uart_write_failed", null);
            notificationManager.showDebugNotification(
                    "File Transfer Failed", "UART write failed at packet " + packetIndex);
            notifyTransferFailedToPhone("uart_write_failed");
            comManager.setFastMode(false);
            currentFileTransfer.isActive = false;
            currentFileTransfer = null;
            pendingPackets.clear();
            consecutiveFailures = 0;
            return false;
        }

        // Track packet state for acknowledgment (preserve retry count if resending)
        FilePacketState existingState = pendingPackets.get(packetIndex);
        if (existingState == null) {
            pendingPackets.put(packetIndex, new FilePacketState());
        } else {
            // Update timestamp but preserve retry count
            existingState.lastSendTime = System.currentTimeMillis();
        }

        long totalMethodTime = System.currentTimeMillis() - methodStartTime;
        Log.d(
                TAG,
                "📊 Sent file packet "
                        + packetIndex
                        + "/"
                        + (currentFileTransfer.totalPackets - 1)
                        + " ("
                        + packSize
                        + " bytes) - UART send took "
                        + (sendEndTime - sendStartTime)
                        + "ms, total method time: "
                        + totalMethodTime
                        + "ms");

        // Schedule acknowledgment timeout check
        fileTransferExecutor.schedule(
                () -> checkFilePacketAck(packetIndex),
                FILE_TRANSFER_ACK_TIMEOUT_MS,
                TimeUnit.MILLISECONDS);
        return true;
    }

    /** Check if file packet acknowledgment was received */
    private void checkFilePacketAck(int packetIndex) {
        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        FilePacketState packetState = pendingPackets.get(packetIndex);
        if (packetState == null) {
            // Packet was acknowledged and removed
            return;
        }

        long timeSinceLastSend = System.currentTimeMillis() - packetState.lastSendTime;
        if (timeSinceLastSend >= FILE_TRANSFER_ACK_TIMEOUT_MS) {
            packetState.retryCount++;

            if (packetState.retryCount >= FILE_TRANSFER_MAX_RETRIES) {
                Log.e(
                        TAG,
                        "File packet "
                                + packetIndex
                                + " failed after "
                                + FILE_TRANSFER_MAX_RETRIES
                                + " retries");

                // Report file transfer failure
                BluetoothReporting.reportFileTransferFailure(
                        context, transferReportPath(), "send_file", "packet_timeout", null);

                notificationManager.showDebugNotification(
                        "File Transfer Failed", "Packet " + packetIndex + " timeout");

                notifyTransferFailedToPhone("packet_timeout");

                // Cancel transfer
                comManager.setFastMode(false);
                currentFileTransfer = null;
                pendingPackets.clear();
            } else {
                Log.w(
                        TAG,
                        "File packet "
                                + packetIndex
                                + " timeout, retrying (attempt "
                                + (packetState.retryCount + 1)
                                + "/"
                                + FILE_TRANSFER_MAX_RETRIES
                                + ")");

                // Resend just this packet; the push window keeps streaming around it
                sendFilePacketAt(packetIndex);
            }
        }
    }

    // ========================================
    // ICompanionTransport transport-level hooks
    // ========================================

    @Override
    public void onMtuNegotiated(int mtu) {
        lastNegotiatedMtu = mtu;
        int cocFilePackSize = fileTransportCoc ? BesWireFormat.getFilePackSize() : 0;
        BesWireFormat.setFilePackSizeFromMtu(
                mtu, besWireCapsFilePayloadV2 && phoneSupportsFilePayloadV2);
        gattFilePackSize = BesWireFormat.getFilePackSize();
        if (fileTransportCoc) {
            BesWireFormat.setFilePackSize(cocFilePackSize);
            return;
        }
        Log.i(
                TAG,
                "📦 MTU negotiated ("
                        + mtu
                        + ") - file pack size now "
                        + BesWireFormat.getFilePackSize());
    }

    @Override
    public void onTransportReset() {
        BesWireFormat.resetFilePackSize();
        gattFilePackSize = BesWireFormat.FILE_PACK_SIZE_DEFAULT;
        lastNegotiatedMtu = 0;
        phoneSupportsFilePayloadV2 = false;
        fileTransportCoc = false;
        resetPhoneWireProtocolState();
        Log.i(TAG, "📦 Transport reset - file pack size and wire protocol state restored to defaults");
    }

    @Override
    public void onFileTransferConfirmation(String fileName, boolean success) {
        handlePhoneConfirmation(fileName, success);
    }

    @Override
    public void onFileTransferAck(int state, int index) {
        handleFileTransferAck(state, index);
    }

    /**
     * Handle file transfer acknowledgment Made public so K900CommandHandler can call it when ACK is
     * received as JSON
     */
    public void handleFileTransferAck(int state, int index) {
        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        // BES response indices are intentionally asymmetric. A success is a cumulative
        // "next expected" index, so index=16 acknowledges packets 0..15. A failure is the exact
        // zero-based packet BES still expects, so state=0/index=16 must resend packet 16.
        int ackedPacketIndex = BesWireFormat.fileAckPacketIndex(1, index);
        int retryPacketIndex = BesWireFormat.fileAckPacketIndex(0, index);
        int trackedPacketIndex = state == 1 ? ackedPacketIndex : retryPacketIndex;

        // Calculate time since packet was sent
        FilePacketState packetState = pendingPackets.get(trackedPacketIndex);
        long ackDelay =
                packetState != null ? (System.currentTimeMillis() - packetState.lastSendTime) : -1;

        Log.d(
                TAG,
                "📊 File transfer ACK: state="
                        + state
                        + ", index="
                        + index
                        + " (tracked: "
                        + trackedPacketIndex
                        + "), ACK received after "
                        + ackDelay
                        + "ms"
                        + ", consecutiveFailures="
                        + consecutiveFailures
                        + ", currentPacketIndex="
                        + currentFileTransfer.currentPacketIndex);

        if (state == 1) { // Success (K900 uses state=1 for success)
            // Ignore true duplicates (acks at or below the high-water mark)
            if (ackedPacketIndex <= currentFileTransfer.highestAckedIndex) {
                Log.w(
                        TAG,
                        "⚠️ Ignoring duplicate ACK for already-acked packet "
                                + ackedPacketIndex
                                + " (highestAcked="
                                + currentFileTransfer.highestAckedIndex
                                + ")");
                return;
            }

            // Reset consecutive failure counter on success
            consecutiveFailures = 0;
            if (pendingFailureRetryIndex >= 0
                    && ackedPacketIndex >= pendingFailureRetryIndex) {
                pendingFailureRetryIndex = -1;
                failureRetryScheduled = false;
            }

            // Advance the ack high-water mark and prune everything at or below it
            // (BES acks are sequential, so a higher ack implies the earlier packets landed)
            for (int i = currentFileTransfer.highestAckedIndex + 1; i <= ackedPacketIndex; i++) {
                pendingPackets.remove(i);
            }
            currentFileTransfer.highestAckedIndex = ackedPacketIndex;

            // Refill the push window (and fire completion once acks cover all packets)
            sendNextFilePacket();
        } else {
            // Error - BES2700 buffer likely full, need to backoff before retry
            // state=0 means BES couldn't process the packet (flow control)

            // Ignore failures for packets BES has already acked (stale ACKs)
            if (retryPacketIndex <= currentFileTransfer.highestAckedIndex) {
                Log.w(
                        TAG,
                        "⚠️ Ignoring stale failure ACK for packet "
                                + retryPacketIndex
                                + " (highestAcked="
                                + currentFileTransfer.highestAckedIndex
                                + ")");
                return;
            }

            // One missing packet can make every later packet in the pushed window receive the
            // same NAK. Coalesce that burst into one recovery so we do not hit the failure limit
            // before the first retry has even run.
            if (retryPacketIndex == pendingFailureRetryIndex && failureRetryScheduled) {
                Log.d(TAG, "Coalescing duplicate failure ACK for packet " + retryPacketIndex);
                return;
            }

            pendingFailureRetryIndex = retryPacketIndex;
            failureRetryScheduled = true;
            consecutiveFailures++;

            // Check if we've hit the failure limit - BLE TX may be permanently stuck
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                Log.e(
                        TAG,
                        "❌💥 File transfer ABORTED: "
                                + consecutiveFailures
                                + " consecutive failures - BES2700 BLE TX likely stuck");

                // Report the failure
                BluetoothReporting.reportFileTransferFailure(
                        context,
                        transferReportPath(),
                        "send_file",
                        "ble_tx_stuck_consecutive_failures",
                        null);

                notificationManager.showDebugNotification(
                        "Transfer Failed",
                        "BLE TX stuck after "
                                + consecutiveFailures
                                + " failures at packet "
                                + retryPacketIndex);

                notifyTransferFailedToPhone("ble_tx_stuck_consecutive_failures");

                // Abort the transfer
                comManager.setFastMode(false);
                currentFileTransfer.isActive = false;
                currentFileTransfer = null;
                pendingPackets.clear();
                consecutiveFailures = 0;
                pendingFailureRetryIndex = -1;
                failureRetryScheduled = false;
                return;
            }

            // Calculate exponential backoff: BASE_BACKOFF_MS * 2^(failures-1), capped at
            // MAX_BACKOFF_MS
            int backoffMs =
                    Math.min(BASE_BACKOFF_MS * (1 << (consecutiveFailures - 1)), MAX_BACKOFF_MS);

            Log.w(
                    TAG,
                    "⚠️ File packet "
                            + retryPacketIndex
                            + " failed (state="
                            + state
                            + "), consecutive failures: "
                            + consecutiveFailures
                            + ", backoff: "
                            + backoffMs
                            + "ms");

            currentFileTransfer.currentPacketIndex = retryPacketIndex;
            for (Integer pendingIndex : pendingPackets.keySet()) {
                if (pendingIndex >= retryPacketIndex) {
                    pendingPackets.remove(pendingIndex);
                }
            }

            // Add exponential backoff delay to let BES2700 drain its buffers
            fileTransferExecutor.schedule(
                    () -> {
                        if (currentFileTransfer != null
                                && currentFileTransfer.isActive
                                && pendingFailureRetryIndex == retryPacketIndex) {
                            failureRetryScheduled = false;
                            Log.d(
                                    TAG,
                                    "📦 Retrying packet "
                                            + retryPacketIndex
                                            + " after "
                                            + backoffMs
                                            + "ms backoff");
                            sendNextFilePacket();
                        }
                    },
                    backoffMs,
                    java.util.concurrent.TimeUnit.MILLISECONDS);
        }
    }

    /** Process received message for file transfer acknowledgments */
    private void processReceivedMessage(byte[] message) {
        if (message == null || message.length < 4) {
            return;
        }

        // Check if this is a file transfer acknowledgment
        // Format: [CMD_TYPE][STATE][INDEX_HIGH][INDEX_LOW]...
        if (message[0] == BesWireFormat.CMD_TYPE_PHOTO && message.length >= 4) {
            int state = message[1] & 0xFF;
            int index = ((message[2] & 0xFF) << 8) | (message[3] & 0xFF);
            handleFileTransferAck(state, index);
        }
    }

    /**
     * Handle phone confirmation for transfer completion Called by K900CommandHandler when
     * transfer_complete message is received from phone
     *
     * @param fileName The file name
     * @param success True if phone confirmed success, false if phone wants retry
     */
    public void handlePhoneConfirmation(String fileName, boolean success) {
        if (currentFileTransfer == null) {
            Log.w(TAG, "⚠️ Received phone confirmation but no active transfer for: " + fileName);
            return;
        }

        // Accept confirmation if:
        // 1. We're explicitly waiting for it (waitingForPhoneConfirmation == true), OR
        // 2. Transfer is active and all packets have been sent (race condition: phone responded
        // faster than expected)
        boolean allPacketsSent =
                currentFileTransfer.currentPacketIndex >= currentFileTransfer.totalPackets;
        if (!currentFileTransfer.waitingForPhoneConfirmation && !allPacketsSent) {
            Log.w(
                    TAG,
                    "⚠️ Received phone confirmation too early for: "
                            + fileName
                            + " (currentPacket="
                            + currentFileTransfer.currentPacketIndex
                            + "/"
                            + currentFileTransfer.totalPackets
                            + ")");
            return;
        }

        // If phone responded before we entered waiting state, log it
        if (!currentFileTransfer.waitingForPhoneConfirmation && allPacketsSent) {
            Log.i(
                    TAG,
                    "📱 Phone responded before waiting state - accepting early confirmation for: "
                            + fileName);
            currentFileTransfer.waitingForPhoneConfirmation =
                    true; // Set it now to avoid timeout firing
        }

        if (!currentFileTransfer.fileName.equals(fileName)) {
            Log.w(
                    TAG,
                    "⚠️ Phone confirmation for wrong file. Expected: "
                            + currentFileTransfer.fileName
                            + ", Got: "
                            + fileName);
            return;
        }

        // Cancel timeout
        cancelPhoneConfirmationTimeout();

        if (success) {
            // SUCCESS! Clean up and delete file
            long now = System.currentTimeMillis();
            long transferDuration = now - currentFileTransfer.startTime;
            long lastPacketToPhoneAckMs =
                    currentFileTransfer.packetsCompleteAtEpochMs > 0
                            ? now - currentFileTransfer.packetsCompleteAtEpochMs
                            : -1L;
            BlePhotoTimingLog.event(
                    "TRANSFER",
                    "phone confirmed transfer_complete (photo received on phone) | file="
                            + fileName
                            + " | full_ble_round_trip="
                            + transferDuration
                            + "ms"
                            + (lastPacketToPhoneAckMs >= 0
                                    ? " | last_packet_to_phone_ack="
                                            + lastPacketToPhoneAckMs
                                            + "ms"
                                    : ""));
            Log.i(
                    TAG,
                    "✅ Phone confirmed success - cleaning up"
                            + (lastPacketToPhoneAckMs >= 0
                                    ? " (last MCU-acked packet → phone ack: "
                                            + lastPacketToPhoneAckMs
                                            + "ms)"
                                    : ""));

            notificationManager.showDebugNotification(
                    "Transfer Success!", currentFileTransfer.fileName + " confirmed by phone");

            deleteFileAfterSuccess();
            comManager.setFastMode(false);
            currentFileTransfer = null;
            pendingPackets.clear();
        } else {
            // FAILURE! Retry transfer
            Log.w(TAG, "❌ Phone reported failure - need to retry transfer");
            currentFileTransfer.retryCount++;

            if (currentFileTransfer.retryCount < MAX_TRANSFER_RETRIES) {
                Log.d(
                        TAG,
                        "🔄 Retry attempt "
                                + currentFileTransfer.retryCount
                                + "/"
                                + MAX_TRANSFER_RETRIES);

                notificationManager.showDebugNotification(
                        "Retrying Transfer",
                        "Attempt "
                                + (currentFileTransfer.retryCount + 1)
                                + "/"
                                + (MAX_TRANSFER_RETRIES + 1));

                // Reset for retry. highestAckedIndex must rewind too: completion keys
                // off the ack high-water mark, and the failed attempt already acked
                // every packet - without the reset sendNextFilePacket() would declare
                // the retry complete without resending a byte.
                currentFileTransfer.currentPacketIndex = 0;
                currentFileTransfer.highestAckedIndex = -1;
                currentFileTransfer.startTime = System.currentTimeMillis();
                currentFileTransfer.packetsCompleteAtEpochMs = 0L;
                currentFileTransfer.waitingForPhoneConfirmation = false;
                pendingPackets.clear();

                // Restart transfer from packet 0
                Log.d(TAG, "🔄 Restarting transfer from packet 0");
                sendNextFilePacket();
            } else {
                Log.e(
                        TAG,
                        "❌ Max retries exceeded ("
                                + MAX_TRANSFER_RETRIES
                                + ") - giving up on transfer");

                notificationManager.showDebugNotification(
                        "Transfer Failed",
                        "Max retries exceeded for " + currentFileTransfer.fileName);

                // Clean up but DON'T delete file (might be useful for debugging)
                notifyTransferFailedToPhone("max_transfer_retries_exceeded");
                comManager.setFastMode(false);
                currentFileTransfer = null;
                pendingPackets.clear();
            }
        }
    }

    /** Schedule timeout for phone confirmation */
    private void schedulePhoneConfirmationTimeout() {
        // Cancel any existing timeout
        cancelPhoneConfirmationTimeout();

        // Schedule new timeout
        phoneConfirmationTimeout =
                fileTransferExecutor.schedule(
                        () -> {
                            handlePhoneConfirmationTimeout();
                        },
                        PHONE_CONFIRMATION_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS);

        Log.d(
                TAG,
                "⏱️ Scheduled phone confirmation timeout: " + PHONE_CONFIRMATION_TIMEOUT_MS + "ms");
    }

    /** Cancel phone confirmation timeout */
    private void cancelPhoneConfirmationTimeout() {
        if (phoneConfirmationTimeout != null && !phoneConfirmationTimeout.isDone()) {
            phoneConfirmationTimeout.cancel(false);
            Log.d(TAG, "⏱️ Cancelled phone confirmation timeout");
        }
        phoneConfirmationTimeout = null;
    }

    /** Handle phone confirmation timeout */
    private void handlePhoneConfirmationTimeout() {
        FileTransferSession transfer = currentFileTransfer;
        if (transfer != null && transfer.waitingForPhoneConfirmation) {
            String fileName = transfer.fileName;
            Log.e(TAG, "⏰ Phone confirmation timeout for: " + fileName);
            Log.e(TAG, "⏰ Phone did not respond within " + PHONE_CONFIRMATION_TIMEOUT_MS + "ms");

            notificationManager.showDebugNotification(
                    "Phone Timeout", "No confirmation received - retrying");

            // Treat timeout as failure (phone might have crashed or disconnected)
            handlePhoneConfirmation(fileName, false);
        }
    }

    private void notifyTransferFailedToPhone(String reason) {
        FileTransferSession transfer = currentFileTransfer;
        if (transfer == null) {
            return;
        }
        String fileName = transfer.fileName;

        try {
            JSONObject json = new JSONObject();
            json.put("type", "transfer_failed");
            json.put("fileName", fileName);
            json.put("reason", reason);
            json.put("timestamp", System.currentTimeMillis());

            boolean sent = sendMessage(json.toString().getBytes(StandardCharsets.UTF_8));
            Log.i(
                    TAG,
                    "📤 transfer_failed sent to phone for "
                            + fileName
                            + " (reason="
                            + reason
                            + ", sent="
                            + sent
                            + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed to notify phone about transfer failure", e);
        }
    }

    /** Identifier for failure reports on the active transfer (synthetic for in-memory sends). */
    private String transferReportPath() {
        if (currentFileTransfer == null) {
            return "mem:unknown";
        }
        return currentFileTransfer.filePath != null
                ? currentFileTransfer.filePath
                : memoryReportPath(currentFileTransfer.fileName);
    }

    /** Delete file after successful transfer */
    private void deleteFileAfterSuccess() {
        if (currentFileTransfer == null) {
            return;
        }
        if (currentFileTransfer.filePath == null) {
            // In-memory transfer - nothing was ever written to disk.
            return;
        }

        try {
            File file = new File(currentFileTransfer.filePath);
            if (file.exists() && file.delete()) {
                Log.d(
                        TAG,
                        "🗑️ Deleted file after confirmed success: "
                                + currentFileTransfer.filePath);
            } else {
                Log.w(TAG, "⚠️ Failed to delete file: " + currentFileTransfer.filePath);
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error deleting file after transfer", e);
        }
    }
}
