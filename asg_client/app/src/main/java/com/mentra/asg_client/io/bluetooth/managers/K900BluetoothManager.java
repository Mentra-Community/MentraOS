package com.mentra.asg_client.io.bluetooth.managers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.BesOtaStateStore;
import com.mentra.asg_client.io.bes.BesOtaUartListener;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.bluetooth.core.BaseBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesMessageParser;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.CsFltsAckPayload;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900LengthCodec;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialPortBridge;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialSession;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;
import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.reporting.domains.BluetoothReporting;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.ChunkReassembler;
import com.mentra.asg_client.service.core.processors.ChunkedMessageProtocolStrategy;
import com.mentra.asg_client.service.utils.SysProp;
import com.mentra.asg_client.settings.AsgSettings;
import com.mentra.asg_client.utils.WakeLockManager;

import org.greenrobot.eventbus.EventBus;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Implementation of IBluetoothManager for K900 devices. Uses the K900's serial port to communicate
 * with the BES2700 Bluetooth module.
 */
public class K900BluetoothManager extends BaseBluetoothManager implements SerialListener {
    private static final String TAG = "K900BluetoothManager";

    private final SerialPortBridge comManager;
    private final BesUartTransportCoordinator transportCoordinator;
    private final BesOtaStateStore besOtaStateStore;
    private final String currentBootId;
    private volatile String liveBesOtaOwner = "";
    private volatile boolean framedPathProven;
    private volatile BesOtaUartListener besOtaUartListener;

    public interface BesOtaAuthorizationCallback {
        /** Called on the outbound worker before the authorization request is written. */
        boolean onLeaseAcquired(BesUartTransportCoordinator.OperationLease lease);

        /** Reports whether submission was attempted separately from the local write result. */
        void onWriteComplete(boolean attempted, boolean success);
    }

    // Single owner of the transport-side link facts (serial open, link proven at current baud,
    // negotiated BES wire caps). The legacy isSerialOpen/besWireCaps* booleans are derived from it
    // through thin getters so external call sites keep their existing surface.
    private final LinkStateMachine linkState = new LinkStateMachine();
    private final DebugNotificationManager notificationManager;
    private BesMessageParser messageParser;
    private final Object messageParserLock = new Object();
    private final ChunkReassembler inboundBinaryReassembler = new ChunkReassembler();
    private final ChunkedMessageProtocolStrategy inboundBinaryStrategy =
            new ChunkedMessageProtocolStrategy(inboundBinaryReassembler);
    private final Object phoneWireProtocolLock = new Object();
    private boolean wireV2HandshakeSent = false;
    private boolean wireV2HandshakePending = false;
    private long phoneWireProtocolGeneration = 0;
    // Message ids whose FLAG_WAKE fragment arrived and are still reassembling; on THAT
    // message's completion the wake window is granted again so follow-up work gets the
    // full window (see handleInboundBinaryFrame). Keyed by msgId because the reassembler
    // interleaves messages. Bounded: abandoned reassemblies would leak entries, so the set
    // is cleared when it exceeds a size no legitimate interleave reaches.
    private final java.util.Set<Integer> pendingBinaryWakeMsgIds = new java.util.LinkedHashSet<>();
    private volatile int gattFilePackSize = BesWireFormat.FILE_PACK_SIZE_DEFAULT;
    private volatile int lastNegotiatedMtu = 0;
    private volatile boolean phoneSupportsFilePayloadV2 = false;
    private volatile boolean fileTransportCoc = false;

    // Negotiated K900 STRING length endianness for the ASG<->BES UART link. Defaults to legacy
    // big-endian so unmodified BES firmware keeps working; upgraded to little-endian only when the
    // BES advertises wire_caps.k900_le or we detect little-endian frames on receive.
    private volatile K900LengthCodec.Endian uartToBesEndian = K900LengthCodec.Endian.BE;

    // File transfer state management
    private volatile FileTransferSession currentFileTransfer = null;
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

    private int effectivePushWindow() {
        if (linkState.getNegotiatedCaps().bigPacks) {
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

    // Inner class to track file transfer state
    private static class FileTransferSession {
        final BesUartTransportCoordinator.OperationLease transportLease;
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
                BesUartTransportCoordinator.OperationLease transportLease,
                String filePath,
                String fileName,
                byte[] fileData,
                int packSize,
                boolean dynamicPayloadSupported) {
            this.transportLease = transportLease;
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

        besOtaStateStore = new BesOtaStateStore(context);
        currentBootId = besOtaStateStore.currentBootId();
        BesOtaStateStore.StartupDecision startupDecision =
                besOtaStateStore.reconcileStartup(currentBootId);
        Log.i(TAG, "BES OTA startup reconciliation: " + startupDecision);

        // Create the notification manager
        notificationManager = new DebugNotificationManager(context);
        notificationManager.showDeviceTypeNotification(true);

        // Initialize every callback dependency before the serial receive thread starts.
        messageParser = new BesMessageParser();
        fileTransferExecutor = Executors.newSingleThreadScheduledExecutor();

        // Create the communication manager
        comManager = new SerialPortBridge(context);
        transportCoordinator =
                new BesUartTransportCoordinator(
                        new UartCoordinatorHost(),
                        new BesUartTransportCoordinator.SafetyState() {
                            @Override
                            public BesUartTransportCoordinator.SafetyPolicy currentPolicy() {
                                return currentBesOtaSafetyPolicy();
                            }

                            @Override
                            public void onRawOtaModeProven() {
                                onBesRawOtaModeProvenAfterRestart();
                            }

                            @Override
                            public void onRecoveryFailed() {
                                onBesRecoveryFailed();
                            }
                        });
        comManager.registerListener(this);
        comManager.start();
    }

    private final class UartCoordinatorHost implements BesUartTransportCoordinator.Host {
        @Override
        public int currentBaud() {
            return comManager.getCurrentBaud();
        }

        @Override
        public boolean isSerialOpen() {
            return comManager.isOpen();
        }

        @Override
        public SerialSession openAtBaud(int baud) {
            boolean wasOpen = comManager.isOpen();
            SerialSession session = comManager.openAtBaud(baud);
            if (session == null) {
                linkState.serialUnavailable();
                return null;
            } else if (!wasOpen) {
                linkState.serialReady();
            }
            return session;
        }

        @Override
        public boolean startReader(SerialSession session) {
            return comManager.startReader(session);
        }

        @Override
        public void closeSession(SerialSession session) {
            boolean closingCurrent = session != null && session == comManager.getCurrentSession();
            comManager.closeSession(session);
            if (closingCurrent) {
                linkState.serialUnavailable();
            }
        }

        @Override
        public void invalidateLinkProof() {
            framedPathProven = false;
            linkState.streamDiscontinuity();
        }

        @Override
        public void resetParser() {
            synchronized (messageParserLock) {
                if (messageParser != null) {
                    messageParser.clear();
                }
            }
        }

        @Override
        public boolean writeControlCommand(byte[] json) {
            return sendMessageInternalLocked(json);
        }

        @Override
        public boolean writeRawBytes(byte[] data) {
            return comManager.write(data);
        }

        @Override
        public void setFastReceive(boolean enabled) {
            comManager.setFastMode(enabled);
        }

        @Override
        public boolean supportsFastBaud(String firmwareVersion) {
            return compareDottedVersions(
                            firmwareVersion, AsgConstants.UART_FAST_BAUD_MIN_BES_VERSION)
                    >= 0;
        }

        @Override
        public boolean queueAfterOutboundWrites(Runnable action) {
            return queueOutboundAction(action);
        }
    }

    @Override
    protected boolean sendMessageInternal(byte[] data) {
        return transportCoordinator.runNormalWrite(() -> sendMessageInternalLocked(data));
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

        if (!linkState.isSerialOpen()) {
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
                        // Use one exact framing path for both one-frame and fragmented v2
                        // messages. Every complete frame must fit the same BES notification
                        // budget; phone-side reassembly does not make an oversized fragment safe.
                        return sendBinaryFragmentedJson(originalData);
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
        boolean sent = comManager.write(data);
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
        synchronized (phoneWireProtocolLock) {
            phoneWireProtocolGeneration++;
            wireV2HandshakeSent = false;
            wireV2HandshakePending = false;
            BesWireFormat.resetBinaryProtocol();
        }
        inboundBinaryReassembler.clear();
        // Pending wake grants die with the reassemblies they belong to: a new session
        // reusing an old msgId must not inherit a stale completion-time wake grant.
        pendingBinaryWakeMsgIds.clear();
    }

    /**
     * Reset the remaining wire protocol state when the BES UART link is closed. The negotiated BES
     * caps are cleared by {@code linkState.serialClosed()}; this covers the phone-facing state and
     * the UART length endianness, which live outside the link state machine.
     */
    public void resetWireProtocolState() {
        resetPhoneWireProtocolState();
        uartToBesEndian = K900LengthCodec.Endian.BE;
    }

    /** Queue a BLE Wire v2 handshake frame (payload "v2") on the outbound worker. */
    public boolean sendWireV2Handshake() {
        if (!linkState.isSerialOpen()) {
            return false;
        }
        if (!linkState.getNegotiatedCaps().binary) {
            Log.i(TAG, "📡 Skipping BLE wire v2 handshake; BES has not advertised binary relay");
            return false;
        }
        byte[] frame = BesWireFormat.packV2HandshakeFrame();
        long generation;
        synchronized (phoneWireProtocolLock) {
            if (wireV2HandshakeSent || wireV2HandshakePending) {
                return true;
            }
            wireV2HandshakePending = true;
            generation = phoneWireProtocolGeneration;
        }

        boolean queued =
                queueOutboundAction(() -> sendWireV2HandshakeOnOutboundWorker(frame, generation));
        if (!queued) {
            synchronized (phoneWireProtocolLock) {
                if (generation == phoneWireProtocolGeneration) {
                    wireV2HandshakePending = false;
                }
            }
        }
        return queued;
    }

    private void sendWireV2HandshakeOnOutboundWorker(byte[] frame, long generation) {
        boolean sent =
                transportCoordinator.runNormalWrite(
                        () -> {
                            synchronized (phoneWireProtocolLock) {
                                // This action may have waited behind an exclusive UART lease.
                                if (generation != phoneWireProtocolGeneration
                                        || !wireV2HandshakePending) {
                                    return false;
                                }
                                return comManager.write(frame);
                            }
                        });

        synchronized (phoneWireProtocolLock) {
            if (generation != phoneWireProtocolGeneration) {
                return;
            }
            wireV2HandshakePending = false;
            if (!sent) {
                return;
            }
            wireV2HandshakeSent = true;
            BesWireFormat.setBinaryProtocolActive(true);
        }
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
                boolean sent = comManager.write(frame);
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

    private boolean handleInboundBinaryFrame(byte[] message, SerialSession receiveSession) {
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(message);
        if (!header.valid) {
            return false;
        }
        // A valid binary frame proves binary relay support even without a wire_caps advert.
        linkState.binaryRelayObserved();

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
                sendWireV2Handshake();
            }
            return true;
        }

        // Wake-flagged frame: grant a fresh awake window (see
        // AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS
        // —
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
                    context,
                    WakeLockManager.WakeOwner.PHONE_COMMAND,
                    AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS);
        }

        byte[] reassembled = inboundBinaryStrategy.processBinaryWireFrame(message);
        if (reassembled == null) {
            return true;
        }

        if (pendingBinaryWakeMsgIds.remove(header.msgId)) {
            WakeLockManager.acquireCpu(
                    context,
                    WakeLockManager.WakeOwner.PHONE_COMMAND,
                    AsgConstants.PHONE_WAKE_COMMAND_WINDOW_MS);
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

        if (!handleSrSyvrResponse(reassembled, receiveSession)
                && !handleSrPhbleResponse(reassembled, receiveSession)
                && !handleFileTransportResponse(reassembled)) {
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
        LinkStateMachine.BesCaps besCaps = linkState.getNegotiatedCaps();
        if (response == null || (!besCaps.k900Le && !besCaps.binary && !besCaps.filePayloadV2)) {
            return;
        }
        try {
            JSONObject caps = new JSONObject();
            if (besCaps.k900Le) {
                caps.put("k900_le", true);
            }
            if (besCaps.binary) {
                caps.put("binary", true);
                caps.put("proto", Math.max(besCaps.proto, BesWireFormat.PROTOCOL_VERSION_V2));
            }
            if (besCaps.filePayloadV2) {
                caps.put("file_payload_v2", true);
                caps.put("file_payload_gatt_max", BesWireFormat.FILE_PACK_SIZE_GATT_MAX);
                caps.put("file_payload_coc_max", BesWireFormat.FILE_PACK_SIZE_COC_MAX);
            }
            response.put("wire_caps", caps);
        } catch (Exception e) {
            Log.w(TAG, "Failed to attach phone wire capabilities", e);
        }
    }

    /** Whether the BES has proven binary relay support (wire_caps advert or an observed frame). */
    public boolean isBesBinaryRelaySupported() {
        return linkState.getNegotiatedCaps().binary;
    }

    /**
     * Observable transport link state (serial open, link proven, negotiated BES caps). New
     * consumers should subscribe here: {@code addListener} replays the current state synchronously,
     * so subscribing late cannot miss the only edge.
     */
    public LinkStateMachine getLinkStateMachine() {
        return linkState;
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
                boolean sent = comManager.write(chunkData);
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

        // Publish terminal transport state before releasing an operation lease. Otherwise file
        // cleanup can resume a deferred baud transition while the serial port is going down.
        transportCoordinator.shutdown();

        // Cancel any active file transfer
        if (currentFileTransfer != null && currentFileTransfer.isActive) {
            Log.d(TAG, "Cancelling active file transfer");
            clearFileTransferSession();
        }

        // Clear pending packets
        pendingPackets.clear();

        // Shutdown file transfer executor
        if (fileTransferExecutor != null) {
            fileTransferExecutor.shutdownNow();
        }

        // Stop the SerialPortBridge
        if (comManager != null) {
            comManager.stop();
        }

        // Call parent shutdown
        super.shutdown();

        Log.d(TAG, "K900BluetoothManager shut down");
    }

    /** Register the raw BES OTA parser; routing remains owned by the transport coordinator. */
    public void registerBesOtaListener(BesOtaUartListener listener) {
        besOtaUartListener = listener;
        if (listener != null) {
            transportCoordinator.startSafetyRecovery();
        }
    }

    /** Coordinator that owns every UART transition and long-lived transport operation. */
    public BesUartTransportCoordinator getTransportCoordinator() {
        return transportCoordinator;
    }

    public BesOtaStateStore getBesOtaStateStore() {
        return besOtaStateStore;
    }

    public void setLiveBesOtaOwner(String ownerSessionId) {
        liveBesOtaOwner = ownerSessionId == null ? "" : ownerSessionId.trim();
    }

    public boolean isFramedPathProven() {
        return framedPathProven;
    }

    private BesUartTransportCoordinator.SafetyPolicy currentBesOtaSafetyPolicy() {
        BesOtaStateStore.UartPolicy policy =
                besOtaStateStore.uartPolicy(currentBootId, framedPathProven, liveBesOtaOwner);
        switch (policy) {
            case NORMAL:
                return BesUartTransportCoordinator.SafetyPolicy.NORMAL;
            case OTA_OWNER_ONLY:
                return BesUartTransportCoordinator.SafetyPolicy.OTA_OWNER_ONLY;
            case RECOVERY_PROBE_ONLY:
                return BesUartTransportCoordinator.SafetyPolicy.RECOVERY_PROBE_ONLY;
            case VERSION_PROBE_ONLY:
                return BesUartTransportCoordinator.SafetyPolicy.VERSION_PROBE_ONLY;
            case QUARANTINED:
            default:
                return BesUartTransportCoordinator.SafetyPolicy.QUARANTINED;
        }
    }

    private void onBesRawOtaModeProvenAfterRestart() {
        BesOtaStateStore.Snapshot snapshot = besOtaStateStore.read();
        if (snapshot.isValid() && snapshot.getState() != BesOtaStateStore.State.TERMINAL) {
            BesOtaStateStore.TransitionResult result =
                    besOtaStateStore.fail(snapshot.getOwnerSessionId(), "raw_mode_after_restart");
            Log.e(TAG, "BES raw-mode recovery result: " + result);
        }
        EventBus.getDefault().post(BesOtaProgressEvent.createFailed("raw_mode_after_restart"));
    }

    private void onBesRecoveryFailed() {
        BesOtaStateStore.Snapshot snapshot = besOtaStateStore.read();
        if (snapshot.isValid() && snapshot.getState() == BesOtaStateStore.State.APPLY_PENDING) {
            BesOtaStateStore.TransitionResult result =
                    besOtaStateStore.fail(snapshot.getOwnerSessionId(), "verification_timeout");
            Log.e(TAG, "BES post-apply recovery timed out: " + result);
            EventBus.getDefault().post(BesOtaProgressEvent.createFailed("verification_timeout"));
        }
    }

    /**
     * Queue BES OTA authorization at one exact point in the normal outbound FIFO. Earlier messages
     * drain before the lease is acquired; later messages cannot enter the exclusive OTA lifetime.
     */
    public boolean queueBesOtaAuthorization(byte[] data, BesOtaAuthorizationCallback callback) {
        if (data == null || data.length == 0 || callback == null) {
            return false;
        }
        byte[] payload = Arrays.copyOf(data, data.length);
        return queueOutboundAction(
                () -> {
                    BesUartTransportCoordinator.OperationLease lease =
                            transportCoordinator.beginOtaAuthorization();
                    if (lease == null) {
                        callback.onWriteComplete(false, false);
                        return;
                    }
                    if (!callback.onLeaseAcquired(lease)) {
                        transportCoordinator.endOta(lease);
                        callback.onWriteComplete(false, false);
                        return;
                    }

                    publishOutboundMessage(payload, true);
                    boolean attempted = true;
                    boolean sent =
                            transportCoordinator.runOtaAuthorizationWrite(
                                    lease, () -> sendMessageInternalLocked(payload));
                    // Once the durable reservation exists, a false local result is ambiguous and
                    // the lease must remain exclusive while the manager waits for hm_ota/raw
                    // reconciliation. Never release it here and never resend mh_ota.
                    callback.onWriteComplete(attempted, sent);
                });
    }

    /**
     * Handle sr_syvr response from BES chipset. This is called early in the serial read pipeline to
     * avoid timing issues with CommandProcessor initialization.
     *
     * @param payload The JSON payload bytes
     * @return true if this was a sr_syvr response and was handled, false otherwise
     */
    private boolean handleSrSyvrResponse(byte[] payload, SerialSession receiveSession) {
        try {
            String jsonStr = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject json = new org.json.JSONObject(jsonStr);

            String command = json.optString("C", "");
            if (!"sr_syvr".equals(command)) {
                return false; // Not a sr_syvr response
            }

            Log.i(TAG, "📋 Handling sr_syvr response directly in K900BluetoothManager");

            // Parse the B field: prefer "version" (matches factory / hs_syvr) then "dpj"
            String bFieldStr = json.optString("B", "");
            org.json.JSONObject bData;
            if (bFieldStr.isEmpty()) {
                bData = json.optJSONObject("B");
            } else {
                bData = new org.json.JSONObject(bFieldStr);
            }

            BesUartTransportCoordinator.SystemVersionResult result =
                    transportCoordinator.onSystemVersion(
                            extractBaudSwitchVersion(bData),
                            receiveSession,
                            () -> {
                                framedPathProven = true;
                                reconcileBesOtaVersionProof(extractDisplayBesVersion(bData));
                                // Presence must precede caps: the edge invalidates the previous
                                // phone session's notify_cap, then this reply installs the current
                                // session's measured value. The coordinator session check makes
                                // both mutations atomic with the baud-state transition.
                                applyPhonePresenceFromSyvr(bData);
                                linkState.capsAdvertised(applyBesWireCaps(json));
                            });
            if (result == BesUartTransportCoordinator.SystemVersionResult.IGNORED) {
                Log.i(TAG, "Ignoring sr_syvr from a retired UART session");
                return true;
            }

            cacheBesBaudSwitchVersion(bData);
            cacheBesVersionFromSyvrBField(bData);

            if (result == BesUartTransportCoordinator.SystemVersionResult.READY) {
                linkState.srSyvrParsed(null);
                requestBtMacAddressIfMissing();
            }

            return true; // Handled
        } catch (Exception e) {
            Log.e(TAG, "💥 Error parsing sr_syvr response", e);
            return false; // Let it fall through to normal processing
        }
    }

    /**
     * Request the BES Bluetooth address only after {@code sr_syvr} has proven the UART link.
     *
     * <p>The service's startup request can run while the transport is still discovering its baud,
     * in which case normal writes are intentionally rejected. Retrying on the ready edge ensures
     * the BES-sourced identity reaches {@code sr_btaddr} and can be reported to the phone.
     */
    private void requestBtMacAddressIfMissing() {
        if (!SysProp.getBesBtMac(context).isEmpty()) {
            return;
        }

        try {
            JSONObject command = new JSONObject();
            command.put("C", "cs_btaddr");
            command.put("V", 1);
            command.put("B", "");

            boolean sent = sendMessage(command.toString().getBytes(StandardCharsets.UTF_8));
            if (sent) {
                Log.i(TAG, "Requested BES Bluetooth address after UART link became ready");
            } else {
                Log.w(TAG, "Could not request BES Bluetooth address after UART link became ready");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to request BES Bluetooth address after UART link became ready", e);
        }
    }

    /**
     * Inspect an sr_syvr message from the BES for a {@code wire_caps} object, record the
     * advertisement in the link state machine (any sr_syvr also proves the link at the current
     * baud), and upgrade the UART link to little-endian K900 STRING lengths when the firmware
     * advertises it. {@code wire_caps} may sit at the top level or inside the {@code B} body.
     */
    private LinkStateMachine.BesCaps applyBesWireCaps(JSONObject json) {
        if (json == null) {
            return null;
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
        LinkStateMachine.BesCaps advertised = null;
        if (caps != null) {
            boolean filePayloadV2 = caps.optBoolean("file_payload_v2", false);
            advertised =
                    new LinkStateMachine.BesCaps(
                            caps.optBoolean("k900_le", false),
                            caps.optBoolean("binary", false),
                            filePayloadV2,
                            // Big-pack support ships with the file_payload_v2 advertisement.
                            filePayloadV2,
                            caps.optInt("proto", BesWireFormat.PROTOCOL_VERSION_V2),
                            caps.optInt("notify_cap", 0));
        }
        if (advertised != null && advertised.k900Le) {
            if (uartToBesEndian != K900LengthCodec.Endian.LE) {
                uartToBesEndian = K900LengthCodec.Endian.LE;
                Log.i(TAG, "🔤 UART K900 endian negotiated to LE via wire_caps");
            }
        }
        if (advertised != null && advertised.binary) {
            Log.i(TAG, "📡 BES wire_caps advertised binary relay proto=" + advertised.proto);
        }
        if (advertised != null && advertised.filePayloadV2) {
            Log.i(TAG, "📦 BES wire_caps advertised negotiated file payloads");
        }
        if (advertised != null && advertised.notifyCap > 0) {
            // MessageChunker's link-state listener applies this guarantee to both v1 and v2
            // complete frames without allowing old advertisements to raise the proven ceiling.
            Log.i(TAG, "📏 BES wire_caps advertised notify_cap=" + advertised.notifyCap);
        }
        return advertised;
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
                    && linkState.getNegotiatedCaps().filePayloadV2
                    && phoneSupportsFilePayloadV2) {
                if (fileTransportCoc
                        && currentFileTransfer != null
                        && currentFileTransfer.packSize > payloadSize) {
                    Log.w(TAG, "CoC MTU shrank during a large-payload transfer; aborting safely");
                    failFileTransfer("coc_mtu_changed");
                    pendingPackets.clear();
                }
                BesWireFormat.setFilePackSize(payloadSize);
                fileTransportCoc = true;
            } else {
                int previousGATTSize = gattFilePackSize;
                if (lastNegotiatedMtu > 0) {
                    BesWireFormat.setFilePackSizeFromMtu(
                            lastNegotiatedMtu,
                            linkState.getNegotiatedCaps().filePayloadV2
                                    && phoneSupportsFilePayloadV2);
                    gattFilePackSize = BesWireFormat.getFilePackSize();
                } else {
                    BesWireFormat.setFilePackSize(gattFilePackSize);
                }
                if (fileTransportCoc
                        && currentFileTransfer != null
                        && currentFileTransfer.packSize > gattFilePackSize) {
                    Log.w(TAG, "CoC closed during a large-payload transfer; aborting safely");
                    failFileTransfer("coc_closed");
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
     * Sync phone BLE presence from the {@code phone_ble} field the BES adds to its sr_syvr reply
     * body (firmware >= 17.26.7.23). This is the boot/wake/recovery sync for the initial value;
     * live edges arrive as spontaneous {@code sr_phble} commands. Old firmware omits the key, so
     * presence stays in whatever tri-state it already had (UNKNOWN until a signal ever arrives).
     */
    private void applyPhonePresenceFromSyvr(JSONObject bData) {
        if (bData == null || !bData.has("phone_ble")) {
            return;
        }
        linkState.phonePresenceReported(bData.optInt("phone_ble", 0) == 1);
    }

    /**
     * Handle a spontaneous {@code sr_phble} phone-presence edge from the BES (firmware >=
     * 17.26.7.23): {@code {"C":"sr_phble","S":0,"B":{"on":1}}} on phone BLE connect (first CCC
     * enable) and {@code {"on":0}} on disconnect. Handled directly here, like sr_syvr, so the
     * presence fact lands in the link state machine before any CommandProcessor timing concerns.
     *
     * @param payload The JSON payload bytes
     * @return true if this was an sr_phble command and was consumed, false otherwise
     */
    private boolean handleSrPhbleResponse(byte[] payload, SerialSession receiveSession) {
        try {
            String jsonStr = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject json = new org.json.JSONObject(jsonStr);
            if (!"sr_phble".equals(json.optString("C", ""))) {
                return false;
            }

            org.json.JSONObject bData = json.optJSONObject("B");
            if (bData == null) {
                String bFieldStr = json.optString("B", "");
                if (!bFieldStr.isEmpty()) {
                    bData = new org.json.JSONObject(bFieldStr);
                }
            }
            if (bData == null || !bData.has("on")) {
                Log.w(TAG, "📱 sr_phble without an 'on' field - ignoring");
                return true; // Still consumed: a malformed edge must not reach CommandProcessor.
            }

            boolean present = bData.optInt("on", 0) == 1;
            Log.i(
                    TAG,
                    "📱 BES reported phone BLE "
                            + (present ? "connected" : "disconnected")
                            + " (sr_phble)");
            transportCoordinator.runForCurrentSerialSession(
                    receiveSession, () -> linkState.phonePresenceReported(present));
            return true;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error parsing sr_phble", e);
            return false; // Let it fall through to normal processing
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

    private static String extractDisplayBesVersion(JSONObject bData) {
        if (bData == null) {
            return "";
        }
        String version = bData.optString("version", "").trim();
        return version.isEmpty() ? bData.optString("dpj", "").trim() : version;
    }

    private void reconcileBesOtaVersionProof(String actualVersion) {
        BesOtaStateStore.Snapshot snapshot = besOtaStateStore.read();
        if (!snapshot.isValid()
                || snapshot.getState() != BesOtaStateStore.State.APPLY_PENDING
                || currentBootId == null
                || currentBootId.equals(snapshot.getAuthorizationBootId())) {
            return;
        }
        BesOtaStateStore.VerificationDecision verification =
                besOtaStateStore.claimOrResumeVerificationBoot(currentBootId);
        if (verification != BesOtaStateStore.VerificationDecision.CLAIMED
                && verification != BesOtaStateStore.VerificationDecision.RESUME) {
            Log.e(TAG, "BES post-apply verification boot rejected: " + verification);
            return;
        }
        BesOtaStateStore.TransitionResult completed =
                besOtaStateStore.completeVerified(
                        snapshot.getOwnerSessionId(), currentBootId, actualVersion);
        if (completed != BesOtaStateStore.TransitionResult.APPLIED) {
            Log.e(TAG, "Could not commit BES post-apply version proof: " + completed);
            return;
        }
        BesOtaStateStore.Snapshot terminal = besOtaStateStore.read();
        if (terminal.getTerminalStatus() == BesOtaStateStore.TerminalStatus.SUCCESS) {
            Log.i(TAG, "BES target version verified after reboot: " + actualVersion);
            EventBus.getDefault().post(BesOtaProgressEvent.createFinished());
        } else {
            Log.e(
                    TAG,
                    "BES version mismatch after reboot expected="
                            + terminal.getTargetVersion()
                            + " actual="
                            + actualVersion);
            EventBus.getDefault().post(BesOtaProgressEvent.createFailed("version_mismatch"));
        }
    }

    private void cacheBesBaudSwitchVersion(JSONObject bData) {
        String version = extractBaudSwitchVersion(bData);
        if (!version.isEmpty()) {
            new AsgSettings(context).setBesBaudSwitchVersion(version);
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
     * count as 0. Each component is read as its leading numeric prefix so hotfix-suffixed firmware
     * strings (e.g. "17.26.7.5-fix1") compare as their base version instead of throwing and
     * silently disabling the transport feature gates.
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

    /**
     * Handle sr_baud response from the BES. Called early in the serial read pipeline (same place as
     * sr_syvr) since the negotiation lives entirely in this class.
     *
     * @param payload The JSON payload bytes
     * @return true if this was an sr_baud response and was consumed, false otherwise
     */
    private boolean handleSrBaudResponse(byte[] payload, SerialSession receiveSession) {
        try {
            String jsonStr = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
            org.json.JSONObject json = new org.json.JSONObject(jsonStr);
            if (!"sr_baud".equals(json.optString("C", ""))) {
                return false; // Not an sr_baud response
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

            if (transportCoordinator.onBaudResponse(status, ackedBaud, receiveSession)
                    && transportCoordinator.isReady()) {
                // A rejected switch leaves the already-proven rendezvous stream stable. Accepted
                // switches remain unproven until sr_syvr arrives after the fast reopen.
                linkState.srSyvrParsed(null);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error parsing sr_baud response", e);
            return false; // Let it fall through to normal processing
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
                            + (linkState.getNegotiatedCaps().bigPacks ? "ENABLED" : "disabled")
                            + " (fw "
                            + version
                            + ", window "
                            + effectivePushWindow()
                            + ", packSize "
                            + effectiveUartPackSize()
                            + ")");
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
        // Preserve the public physical-connection meaning. The transport coordinator separately
        // gates every UART write until the current baud has been proven.
        return linkState.isSerialOpen() && super.isConnected();
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

        // Close transport state before releasing the file lease so cleanup cannot resume a
        // deferred baud transition on a port that is already going down.
        framedPathProven = false;
        linkState.serialClosed();
        transportCoordinator.onSerialClosed();
        if (currentFileTransfer != null && currentFileTransfer.isActive) {
            Log.w(TAG, "Serial closed during file transfer; cancelling the active session");
            clearFileTransferSession();
            pendingPackets.clear();
        }
        // serialClosed() also clears the negotiated BES caps (the legacy resetWireProtocolState
        // caps reset); resetWireProtocolState() covers the phone-facing state and UART endianness.
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
    public void onSerialRead(
            String serialPath, byte[] data, int size, SerialSession receiveSession) {
        if (data != null && size > 0) {
            // Copy the data before the serial reader reuses its buffer.
            byte[] dataCopy = new byte[size];
            System.arraycopy(data, 0, dataCopy, 0, size);

            BesUartTransportCoordinator.InboundRoute route =
                    transportCoordinator.inboundRoute(receiveSession);
            if (route == BesUartTransportCoordinator.InboundRoute.REJECTED) {
                Log.w(TAG, "Ignoring data from retired UART session " + receiveSession);
                return;
            }
            if (route == BesUartTransportCoordinator.InboundRoute.OTA) {
                BesOtaUartListener listener = besOtaUartListener;
                if (listener == null) {
                    Log.w(TAG, "Dropping BES OTA bytes because no OTA listener is registered");
                } else {
                    listener.onOtaRecv(dataCopy, size);
                }
                return;
            }

            boolean fileTransferActive = isFileTransferInProgress();
            if (!fileTransferActive) {
                Log.d(TAG, "📥 K900 SERIAL READ - " + size + " bytes");
            }

            // Hex dump suppressed to prevent logcat overflow
            // Enable only when debugging specific issues

            SerialParseResult parseResult = new SerialParseResult();
            boolean currentReader =
                    transportCoordinator.runForCurrentSerialSession(
                            receiveSession,
                            () -> {
                                synchronized (messageParserLock) {
                                    if (messageParser != null) {
                                        parseResult.accepted =
                                                messageParser.addData(dataCopy, size);
                                        if (parseResult.accepted) {
                                            parseResult.messages = messageParser.parseMessages();
                                            parseResult.discardedBytes =
                                                    messageParser.consumeDiscardedByteCount();
                                        }
                                    }
                                }
                            });
            if (!currentReader) {
                Log.w(TAG, "Ignoring data from retired UART session " + receiveSession);
                return;
            }

            boolean parserAcceptedData = parseResult.accepted;
            List<byte[]> completeMessages = parseResult.messages;
            long discardedBytes = parseResult.discardedBytes;

            if (!parserAcceptedData) {
                // If parser is not available or data couldn't be added, send raw data
                Log.d(TAG, "📥 📤 Parser unavailable, notifying listeners of raw data...");
                if (transportCoordinator.isCurrentSerialSession(receiveSession)) {
                    notifyDataReceived(dataCopy);
                }
            } else if (completeMessages == null || completeMessages.isEmpty()) {
                if (discardedBytes > 0) {
                    onUartBytesDiscarded(discardedBytes, receiveSession);
                }
                // No complete messages yet, just accumulating data
                Log.d(TAG, "📥 Data added to parser, waiting for complete message");
            } else {
                Log.d(TAG, "📥 Extracted " + completeMessages.size() + " complete messages");
                // Process each complete message outside the parser lock.
                for (byte[] message : completeMessages) {
                    if (!transportCoordinator.isCurrentSerialSession(receiveSession)) {
                        break;
                    }
                    BleTraceLogger.logK900Frame("bes_to_asg", "asg_uart_input", message);

                    // Check for file transfer acknowledgments first
                    processReceivedMessage(message);

                    // Extract payload from K900 protocol message for listeners
                    if (BesWireFormat.isBinaryWireFrame(message)) {
                        BesWireFormat.BinaryHeader header =
                                BesWireFormat.parseBinaryHeader(message);
                        if (header.valid) {
                            handleInboundBinaryFrame(message, receiveSession);
                            if (BesWireFormat.isValidLinkHealthFrame(message)) {
                                onValidUartFrame(receiveSession);
                            }
                        }
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
                            boolean validLinkHealthFrame =
                                    BesWireFormat.isValidLinkHealthFrame(message);
                            // Fast path: cs_flts ACKs — skip BleTrace + CommandProcessor spam
                            // that otherwise runs dozens of Log calls per packet window.
                            if (handleCsFltsAckPayload(payload)) {
                                if (validLinkHealthFrame) {
                                    onValidUartFrame(receiveSession);
                                }
                                continue;
                            }

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
                            if (!handleSrSyvrResponse(payload, receiveSession)
                                    && !handleSrBaudResponse(payload, receiveSession)
                                    && !handleSrPhbleResponse(payload, receiveSession)
                                    && !handleFileTransportResponse(payload)) {
                                // Not a BES-owned sr_* response, forward to listeners
                                notifyDataReceived(payload);
                            }
                            if (validLinkHealthFrame) {
                                onValidUartFrame(receiveSession);
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

    private static final class SerialParseResult {
        boolean accepted;
        List<byte[]> messages;
        long discardedBytes;
    }

    private void onValidUartFrame(SerialSession receiveSession) {
        transportCoordinator.onValidFrame(receiveSession);
    }

    private void onUartBytesDiscarded(long discardedBytes, SerialSession receiveSession) {
        transportCoordinator.onDiscardedBytes(discardedBytes, receiveSession);
    }

    /**
     * Handle BES {@code cs_flts} file-transfer ACKs without routing through CommandProcessor /
     * BleTrace / AsgClientService receive logging (those paths dominate logcat I/O during TX).
     *
     * @return true if the payload was a cs_flts ACK and was consumed
     */
    private boolean handleCsFltsAckPayload(byte[] payload) {
        CsFltsAckPayload parsed = CsFltsAckPayload.parse(payload);
        if (parsed.kind == CsFltsAckPayload.Kind.NOT_CS_FLTS) {
            return false;
        }
        if (parsed.kind == CsFltsAckPayload.Kind.ACK) {
            handleFileTransferAck(parsed.state, parsed.index);
        }
        // MALFORMED and ACK both consume the payload so CommandProcessor is not spammed.
        return true;
    }

    @Override
    public void onSerialReady(String serialPath, SerialSession session) {
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 K900 SERIAL READY");
        Log.d(TAG, "🔌 =========================================");
        Log.d(TAG, "🔌 Serial path: " + serialPath);

        // A proof belongs to one exact SerialSession. Never let an sr_syvr from the
        // previous file descriptor authorize traffic on a newly adopted session.
        framedPathProven = false;
        linkState.serialReady();
        transportCoordinator.onSerialReady(session);
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
    }

    public void onBesOtaApplied() {
        linkState.streamDiscontinuity();
        linkState.phonePresenceInvalidated();
        transportCoordinator.onBesOtaApplied();
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

        if (bSucc) {
            linkState.serialReady();
        } else {
            framedPathProven = false;
            linkState.serialClosed();
            transportCoordinator.onSerialClosed();
        }
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
        if (!linkState.isSerialOpen()) {
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

        return startFileTransferSession(filePath, file.getName(), fileData, null);
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
        return sendFileInternal(data, fileName, null);
    }

    @Override
    protected boolean sendFileInternal(byte[] data, String fileName, byte[] prelude) {
        if (!linkState.isSerialOpen()) {
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

        return startFileTransferSession(null, fileName, data, prelude);
    }

    /** Synthetic identifier for Sentry reports on transfers that never touch disk. */
    private static String memoryReportPath(String fileName) {
        return "mem:" + fileName;
    }

    /** End the active file session and release its exclusive UART operation lease. */
    private void clearFileTransferSession() {
        FileTransferSession transfer = detachFileTransferSession();
        if (transfer != null) {
            transportCoordinator.endFileTransfer(transfer.transportLease);
        }
    }

    private FileTransferSession detachFileTransferSession() {
        FileTransferSession session = currentFileTransfer;
        currentFileTransfer = null;
        if (session != null) {
            session.isActive = false;
        }
        return session;
    }

    /**
     * Create the transfer session and start the packet pump. {@code filePath} is {@code null} for
     * in-memory transfers; it is only used for post-transfer cleanup and failure reporting.
     */
    private boolean startFileTransferSession(
            String filePath, String fileName, byte[] fileData, byte[] prelude) {
        if (fileName.length() > 16) {
            fileName = fileName.substring(0, 16); // Truncate to 16 chars max
        }

        BesUartTransportCoordinator.OperationLease transportLease =
                transportCoordinator.beginFileTransfer();
        if (transportLease == null) {
            Log.w(TAG, "Cannot start file transfer while BES UART is unavailable or busy");
            return false;
        }
        if (prelude != null && prelude.length > 0) {
            publishOutboundMessage(prelude, true);
            if (!transportCoordinator.runFileWrite(
                    transportLease, () -> sendMessageInternalLocked(prelude))) {
                transportCoordinator.endFileTransfer(transportLease);
                return false;
            }
        }
        try {
            currentFileTransfer =
                    new FileTransferSession(
                            transportLease,
                            filePath,
                            fileName,
                            fileData,
                            effectiveUartPackSize(),
                            linkState.getNegotiatedCaps().filePayloadV2);
        } catch (RuntimeException e) {
            transportCoordinator.endFileTransfer(transportLease);
            throw e;
        }
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

        // Send the first packet
        sendNextFilePacket();

        return true;
    }

    /**
     * Pump file packets in push mode: stream up to FILE_PUSH_WINDOW packets ahead of the highest
     * BES ack instead of waiting one ack round trip per packet. Completion fires once the acks (not
     * the sends) have covered every packet.
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
                    currentFileTransfer.fileName, currentFileTransfer.fileSize, transferDuration);
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
        if (linkState.getNegotiatedCaps().filePayloadV2) {
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
            failFileTransfer("packet_pack_failed");
            return false;
        }

        // File packets share the same serialized UART writer without verbose payload logging.
        boolean sent =
                transportCoordinator.runFileWrite(
                        currentFileTransfer.transportLease, () -> comManager.write(packet));
        if (!sent) {
            Log.e(TAG, "Failed to write file packet " + packetIndex + " to UART");
            BluetoothReporting.reportFileTransferFailure(
                    context, transferReportPath(), "send_file", "uart_write_failed", null);
            notificationManager.showDebugNotification(
                    "File Transfer Failed", "UART write failed at packet " + packetIndex);
            failFileTransfer("uart_write_failed");
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

        if (shouldLogFileTransferProgress(packetIndex)) {
            int totalPackets = currentFileTransfer.totalPackets;
            int pct = totalPackets > 0 ? (int) ((100L * (packetIndex + 1)) / totalPackets) : 0;
            Log.i(
                    TAG,
                    "📊 File TX progress: packet "
                            + packetIndex
                            + "/"
                            + (totalPackets - 1)
                            + " ("
                            + pct
                            + "%, "
                            + packSize
                            + " bytes this packet)");
        }

        // Schedule acknowledgment timeout check
        fileTransferExecutor.schedule(
                () -> checkFilePacketAck(packetIndex),
                FILE_TRANSFER_ACK_TIMEOUT_MS,
                TimeUnit.MILLISECONDS);
        return true;
    }

    private static boolean shouldLogFileTransferProgress(int index) {
        int interval = AsgConstants.FILE_TRANSFER_PROGRESS_LOG_INTERVAL;
        return interval > 0 && index >= 0 && (index % interval) == 0;
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

                failFileTransfer("packet_timeout");
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
                mtu, linkState.getNegotiatedCaps().filePayloadV2 && phoneSupportsFilePayloadV2);
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
        Log.i(
                TAG,
                "📦 Transport reset - file pack size and wire protocol state restored to defaults");
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

        if ((state != 1) && shouldLogFileTransferProgress(index)) {
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
        }

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
            if (pendingFailureRetryIndex >= 0 && ackedPacketIndex >= pendingFailureRetryIndex) {
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

                failFileTransfer("ble_tx_stuck_consecutive_failures");
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
                                    ? " | last_packet_to_phone_ack=" + lastPacketToPhoneAckMs + "ms"
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
            clearFileTransferSession();
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
                failFileTransfer("max_transfer_retries_exceeded");
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

    /** Send the failure while retaining file ownership, then release the exclusive lease. */
    private void failFileTransfer(String reason) {
        FileTransferSession transfer = detachFileTransferSession();
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

            byte[] payload = json.toString().getBytes(StandardCharsets.UTF_8);
            publishOutboundMessage(payload, true);
            boolean sent =
                    transportCoordinator.endFileTransferWithFinalWrite(
                            transfer.transportLease, () -> sendMessageInternalLocked(payload));
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
        } finally {
            // Covers failures before the helper; token matching makes this a no-op after release.
            transportCoordinator.endFileTransfer(transfer.transportLease);
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
