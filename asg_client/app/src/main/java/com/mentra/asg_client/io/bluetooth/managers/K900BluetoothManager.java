package com.mentra.asg_client.io.bluetooth.managers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.bluetooth.core.BaseBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.SerialListener;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesMessageParser;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.MessageChunker;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialPortBridge;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.reporting.domains.BluetoothReporting;
import com.mentra.asg_client.service.core.AsgClientService;
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
import org.json.JSONObject;

/**
 * Implementation of IBluetoothManager for K900 devices. Uses the K900's serial port to communicate
 * with the BES2700 Bluetooth module.
 */
public class K900BluetoothManager extends BaseBluetoothManager implements SerialListener {
    private static final String TAG = "K900BluetoothManager";

    private final SerialPortBridge comManager;
    private boolean isSerialOpen = false;
    private final DebugNotificationManager notificationManager;
    private BesMessageParser messageParser;

    // File transfer state management
    private FileTransferSession currentFileTransfer = null;
    private ScheduledExecutorService fileTransferExecutor;
    private ConcurrentHashMap<Integer, FilePacketState> pendingPackets = new ConcurrentHashMap<>();
    private static final int FILE_TRANSFER_ACK_TIMEOUT_MS = 3000;
    private static final int FILE_TRANSFER_MAX_RETRIES = 5;
    private static final int PHONE_CONFIRMATION_TIMEOUT_MS = 5000; // 5 seconds
    private static final int MAX_TRANSFER_RETRIES = 3; // Max full transfer retries
    private ScheduledFuture<?> phoneConfirmationTimeout = null;
    private ScheduledFuture<?> fileTransferAckTimeout = null;
    private BleTransferStats currentStats = null;

    // BES2700 BLE flow control - tracks consecutive failures for exponential backoff
    private static final int MAX_CONSECUTIVE_FAILURES =
            10; // Abort after this many state=0 in a row
    private static final int BASE_BACKOFF_MS = 150; // Base backoff delay for state=0 failures
    private static final int MAX_BACKOFF_MS = 1000; // Cap exponential backoff at 1 second
    private static final int PACING_DELAY_MS =
            75; // Delay between successful packets - BES2700 needs time to drain BLE TX
    private int consecutiveFailures = 0;

    // Inner class to track file transfer state
    private static class FileTransferSession {
        String filePath;
        String fileName;
        byte[] fileData;
        int fileSize; // Real file size (for our internal tracking)
        int fakeFileSize; // Inflated file size to tell BES firmware (totalPackets * 400)
        int totalPackets;
        int currentPacketIndex;
        byte[] packetBuffer;
        boolean isActive;
        long startTime;
        boolean waitingForPhoneConfirmation;
        int retryCount;

        // BES2700 firmware hardcodes FILE_PACK_SIZE=400 when calculating totalPack:
        //   totalPack = (fileSize + 400 - 1) / 400
        // We "lie" about fileSize so BES expects the correct number of packets.
        // This allows us to send smaller packets (221 bytes) that fit within BLE MTU.
        private static final int BES_HARDCODED_PACK_SIZE = 400;

        FileTransferSession(String filePath, String fileName, byte[] fileData) {
            this.filePath = filePath;
            this.fileName = fileName;
            this.fileData = fileData;
            this.fileSize = fileData.length;
            this.totalPackets =
                    (fileSize + BesWireFormat.getFilePackSize() - 1)
                            / BesWireFormat.getFilePackSize();
            // Calculate fake file size so BES firmware calculates correct totalPack
            // BES does: totalPack = (fileSize + 400 - 1) / 400
            // We want BES to get our totalPackets, so: fakeFileSize = totalPackets * 400
            this.fakeFileSize = totalPackets * BES_HARDCODED_PACK_SIZE;
            this.currentPacketIndex = 0;
            this.packetBuffer = new byte[BesWireFormat.getFilePacketSize(BesWireFormat.getFilePackSize())];
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
                            + BesWireFormat.getFilePackSize());
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

    /** Per-transfer stats collected for telemetry comparison (OPTIMIZED vs LEGACY). */
    private static class BleTransferStats {
        final String mode;
        final int preDelayMs;
        int packetRetries = 0;  // single-packet resends
        int state0Count   = 0;  // flow-control / buffer-full NAKs
        int timeoutCount  = 0;  // ACK watchdog fires
        int uartFailures  = 0;  // UART write errors

        BleTransferStats() {
            this.mode       = BleTransferMode.get().name();
            this.preDelayMs = BleTransferMode.preTransferDelayMs();
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

        // Create the communication manager
        comManager = new SerialPortBridge(context);
        comManager.registerListener(this);
        comManager.start();

        // Create the message parser to handle fragmented messages
        messageParser = new BesMessageParser();

        // Initialize file transfer executor
        fileTransferExecutor = Executors.newSingleThreadScheduledExecutor();

        // Register ADB-toggleable transfer mode receiver
        BleTransferMode.registerReceiver(context);
    }

    @Override
    protected boolean sendMessageInternal(byte[] data) {
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
                            "📡 🔧 JSON data detected, applying C-wrapping and protocol formatting...");
                    Log.d(TAG, "📡 📦 JSON DATA BEFORE C-WRAPPING: " + originalData);
                    String wrappedJson = BesWireFormat.createTransmissionWrapperJson(originalData);
                    if (MessageChunker.needsChunking(wrappedJson)) {
                        return sendChunkedJson(originalData);
                    }

                    data = BesWireFormat.formatMessageForTransmission(originalData);

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
                    data = BesWireFormat.packDataCommand(data, BesWireFormat.CMD_TYPE_STRING);
                }
            } catch (Exception e) {
                // If we can't interpret as string, just apply protocol formatting to raw bytes
                Log.d(TAG, "📡 🔧 Applying protocol format to raw bytes");
                data = BesWireFormat.packDataCommand(data, BesWireFormat.CMD_TYPE_STRING);
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

    /**
     * Sends an internal command directly to the glasses transport without broadcasting it as a
     * phone-facing command response.
     */
    public boolean sendCommandToGlasses(byte[] data) {
        return sendMessageInternal(data);
    }

    private boolean sendChunkedJson(String originalJson) {
        try {
            long messageId = -1;
            try {
                JSONObject original = new JSONObject(originalJson);
                messageId = original.optLong("mId", -1);
            } catch (Exception ignored) {
                // Chunking also supports non-ACK messages.
            }

            List<JSONObject> chunks = MessageChunker.createChunks(originalJson, messageId);
            Log.d(TAG, "📡 🧩 Sending chunked JSON as " + chunks.size() + " chunks");

            boolean allSent = true;
            for (int i = 0; i < chunks.size(); i++) {
                byte[] chunkData =
                        BesWireFormat.formatMessageForTransmission(chunks.get(i).toString());
                Log.d(
                        TAG,
                        "📡 🧩 Sending chunk "
                                + (i + 1)
                                + "/"
                                + chunks.size()
                                + " ("
                                + chunkData.length
                                + " bytes packed)");
                boolean sent = comManager.send(chunkData);
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

            return allSent;
        } catch (Exception e) {
            Log.e(TAG, "Error chunking JSON for K900 transmission", e);
            return false;
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
        cancelFilePacketAckTimeout();
        cancelPhoneConfirmationTimeout();

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
            // Build K900 command format: {"C":"cs_syvr","V":1,"B":""}
            org.json.JSONObject k900Command = new org.json.JSONObject();
            k900Command.put("C", "cs_syvr");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
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

            // Parse the B field: prefer "version" (matches factory / hs_syvr) then "dpj"
            String bFieldStr = json.optString("B", "");
            if (bFieldStr.isEmpty()) {
                org.json.JSONObject bData = json.optJSONObject("B");
                cacheBesVersionFromSyvrBField(bData);
            } else {
                org.json.JSONObject bData = new org.json.JSONObject(bFieldStr);
                cacheBesVersionFromSyvrBField(bData);
            }

            return true; // Handled
        } catch (Exception e) {
            Log.e(TAG, "💥 Error parsing sr_syvr response", e);
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
                                    "📋 BES version updated from UART — re-sending version info to phone");
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

            // Add the data to our message parser
            if (messageParser != null && messageParser.addData(dataCopy, size)) {
                // Try to extract complete messages
                List<byte[]> completeMessages = messageParser.parseMessages();
                if (completeMessages != null && !completeMessages.isEmpty()) {
                    Log.d(TAG, "📥 Extracted " + completeMessages.size() + " complete messages");
                    // Process each complete message
                    for (byte[] message : completeMessages) {
                        BleTraceLogger.logK900Frame("bes_to_asg", "asg_uart_input", message);

                        // Extract payload from K900 protocol message for listeners
                        if (BesWireFormat.isK900ProtocolFormat(message)) {
                            // Try to extract payload (big-endian first, then little-endian)
                            byte[] payload = BesWireFormat.extractPayload(message);
                            if (payload == null) {
                                payload = BesWireFormat.extractPayloadFromK900(message);
                            }

                            if (payload != null && payload.length > 0) {
                                // Notify listeners with the clean payload (JSON data without
                                // markers)
                                String payloadPreview =
                                        new String(payload, 0, Math.min(payload.length, 200));
                                Log.d(
                                        TAG,
                                        "📥 Extracted K900 payload ("
                                                + payload.length
                                                + " bytes): "
                                                + payloadPreview);

                                // Check if this is a sr_syvr response (BES system version)
                                // Handle it directly here to avoid timing issues with
                                // CommandProcessor initialization
                                if (!handleSrSyvrResponse(payload)) {
                                    // Not a sr_syvr response, forward to listeners
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
                } else {
                    // No complete messages yet, just accumulating data
                    Log.d(TAG, "📥 Data added to parser, waiting for complete message");
                }
            } else {
                // If parser is not available or data couldn't be added, send raw data
                Log.d(TAG, "📥 📤 Parser unavailable, notifying listeners of raw data...");
                notifyDataReceived(dataCopy);
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
    public boolean sendFile(String filePath) {
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

        // Create file transfer session
        String fileName = file.getName();
        if (fileName.length() > 16) {
            fileName = fileName.substring(0, 16); // Truncate to 16 chars max
        }

        currentFileTransfer = new FileTransferSession(filePath, fileName, fileData);
        pendingPackets.clear();
        consecutiveFailures = 0; // Reset failure counter for new transfer
        currentStats = new BleTransferStats();
        Log.i(TAG, "📊 Transfer mode: " + currentStats.mode + ", preDelay=" + currentStats.preDelayMs + "ms");

        Log.d(
                TAG,
                "Starting file transfer: "
                        + fileName
                        + " ("
                        + fileData.length
                        + " bytes, "
                        + currentFileTransfer.totalPackets
                        + " packets)");

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

    /** Send the next file packet */
    private void sendNextFilePacket() {
        long methodStartTime = System.currentTimeMillis();

        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        if (currentFileTransfer.currentPacketIndex >= currentFileTransfer.totalPackets) {
            // All packets sent and ACKed by MCU
            cancelFilePacketAckTimeout();
            long transferDuration = System.currentTimeMillis() - currentFileTransfer.startTime;
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

        // Calculate packet data
        int packetIndex = currentFileTransfer.currentPacketIndex;
        int offset = packetIndex * BesWireFormat.getFilePackSize();
        int packSize =
                Math.min(BesWireFormat.getFilePackSize(), currentFileTransfer.fileSize - offset);

        // Pack the file packet
        // NOTE: We use fakeFileSize to lie to BES firmware about total file size.
        // BES hardcodes 400-byte pack size when calculating totalPack, so we inflate
        // fileSize to make BES expect the correct number of our smaller packets.
        int packetLength =
                BesWireFormat.packFilePacketInto(
                        currentFileTransfer.packetBuffer,
                        currentFileTransfer.fileData,
                        offset,
                        packetIndex,
                        packSize,
                        currentFileTransfer.fakeFileSize,
                        currentFileTransfer.fileName,
                        0, // flags = 0
                        BesWireFormat.CMD_TYPE_PHOTO);

        if (packetLength <= 0) {
            Log.e(TAG, "Failed to pack file packet " + packetIndex);
            notifyTransferFailedToPhone("packet_pack_failed");
            comManager.setFastMode(false);
            currentFileTransfer = null;
            pendingPackets.clear();
            cancelFilePacketAckTimeout();
            return;
        }

        // Send the packet using sendFile (no logging)
        long sendStartTime = System.currentTimeMillis();
        boolean sent = comManager.sendFile(currentFileTransfer.packetBuffer, packetLength);
        long sendEndTime = System.currentTimeMillis();
        if (!sent) {
            Log.e(TAG, "Failed to write file packet " + packetIndex + " to UART");
            if (currentStats != null) currentStats.uartFailures++;
            notifyTransferFailedToPhone("uart_write_failed");
            emitTransferTelemetry(false);
            comManager.setFastMode(false);
            currentFileTransfer = null;
            pendingPackets.clear();
            cancelFilePacketAckTimeout();
            return;
        }

        // Track packet state for acknowledgment (preserve retry count if resending)
        FilePacketState existingState = pendingPackets.get(packetIndex);
        if (existingState == null) {
            pendingPackets.put(packetIndex, new FilePacketState());
        } else {
            // Update timestamp but preserve retry count
            existingState.lastSendTime = System.currentTimeMillis();
        }

        if (packetIndex == 0
                || packetIndex == currentFileTransfer.totalPackets - 1
                || packetIndex % 50 == 0) {
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
        }

        scheduleFilePacketAckTimeout(packetIndex);
    }

    private void scheduleFilePacketAckTimeout(int packetIndex) {
        cancelFilePacketAckTimeout();
        fileTransferAckTimeout =
                fileTransferExecutor.schedule(
                        () -> checkFilePacketAck(packetIndex),
                        FILE_TRANSFER_ACK_TIMEOUT_MS,
                        TimeUnit.MILLISECONDS);
    }

    private void cancelFilePacketAckTimeout() {
        if (fileTransferAckTimeout != null) {
            fileTransferAckTimeout.cancel(false);
            fileTransferAckTimeout = null;
        }
    }

    /** Check if file packet acknowledgment was received */
    private void checkFilePacketAck(int packetIndex) {
        fileTransferAckTimeout = null;
        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        FilePacketState packetState = pendingPackets.get(packetIndex);
        if (packetState == null) {
            // Packet was already ACKed — watchdog fired late, not a real timeout
            return;
        }

        long timeSinceLastSend = System.currentTimeMillis() - packetState.lastSendTime;
        if (timeSinceLastSend >= FILE_TRANSFER_ACK_TIMEOUT_MS) {
            // Only count as a real timeout once we confirm the ACK is genuinely missing
            if (currentStats != null) currentStats.timeoutCount++;
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
                        context, currentFileTransfer.filePath, "send_file", "packet_timeout", null);

                notificationManager.showDebugNotification(
                        "File Transfer Failed", "Packet " + packetIndex + " timeout");

                notifyTransferFailedToPhone("packet_timeout");
                emitTransferTelemetry(false);

                // Cancel transfer
                comManager.setFastMode(false);
                currentFileTransfer = null;
                pendingPackets.clear();
                cancelFilePacketAckTimeout();
            } else {
                if (currentStats != null) currentStats.packetRetries++;
                Log.w(
                        TAG,
                        "File packet "
                                + packetIndex
                                + " timeout, retrying (attempt "
                                + (packetState.retryCount + 1)
                                + "/"
                                + FILE_TRANSFER_MAX_RETRIES
                                + ")");

                // Resend the packet
                currentFileTransfer.currentPacketIndex = packetIndex;
                sendNextFilePacket();
            }
        }
    }

    /**
     * Handle file transfer acknowledgment Made public so K900CommandHandler can call it when ACK is
     * received as JSON
     */
    public void handleFileTransferAck(int state, int index) {
        if (currentFileTransfer == null || !currentFileTransfer.isActive) {
            return;
        }

        // BES success ACK uses index as the next requested packet, so the accepted packet is
        // index - 1. Failure ACK uses index as the exact 0-based packet to resend.
        int ackedPacketIndex = index - 1;
        int retryPacketIndex = index;
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
            // CRITICAL: Ignore duplicate ACKs for packets we've already moved past
            // This prevents scheduling multiple sendNextFilePacket() calls
            if (ackedPacketIndex < currentFileTransfer.currentPacketIndex) {
                Log.w(
                        TAG,
                        "⚠️ Ignoring duplicate ACK for already-processed packet "
                                + ackedPacketIndex
                                + " (current="
                                + currentFileTransfer.currentPacketIndex
                                + ")");
                return;
            }
            cancelFilePacketAckTimeout();

            // Reset consecutive failure counter on success
            consecutiveFailures = 0;

            // Remove from pending packets
            pendingPackets.remove(ackedPacketIndex);

            // Move to next packet
            currentFileTransfer.currentPacketIndex = ackedPacketIndex + 1;

            // Send next packet immediately - BES flow control via ACKs handles pacing
            sendNextFilePacket();
        } else {
            // Error - BES2700 buffer likely full, need to backoff before retry
            // state=0 means BES couldn't process the packet (flow control)

            // Ignore failures for packets we've already moved past (stale ACKs)
            if (retryPacketIndex < currentFileTransfer.currentPacketIndex) {
                Log.w(
                        TAG,
                        "⚠️ Ignoring stale failure ACK for packet "
                                + retryPacketIndex
                                + " (current="
                                + currentFileTransfer.currentPacketIndex
                                + ")");
                return;
            }
            cancelFilePacketAckTimeout();
            if (currentStats != null) currentStats.state0Count++;

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
                        currentFileTransfer.filePath,
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
                emitTransferTelemetry(false);

                // Abort the transfer
                comManager.setFastMode(false);
                currentFileTransfer.isActive = false;
                currentFileTransfer = null;
                pendingPackets.clear();
                cancelFilePacketAckTimeout();
                consecutiveFailures = 0;
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

            // Add exponential backoff delay to let BES2700 drain its buffers
            fileTransferExecutor.schedule(
                    () -> {
                        if (currentFileTransfer != null && currentFileTransfer.isActive) {
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
            Log.d(TAG, "✅ Phone confirmed success - cleaning up");
            long transferDuration = System.currentTimeMillis() - currentFileTransfer.startTime;

            notificationManager.showDebugNotification(
                    "Transfer Success!", currentFileTransfer.fileName + " confirmed by phone");

            emitTransferTelemetry(true);
            deleteFileAfterSuccess();
            comManager.setFastMode(false);
            currentFileTransfer = null;
            pendingPackets.clear();
            cancelFilePacketAckTimeout();
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

                // Reset for retry
                currentFileTransfer.currentPacketIndex = 0;
                currentFileTransfer.startTime = System.currentTimeMillis();
                currentFileTransfer.waitingForPhoneConfirmation = false;
                pendingPackets.clear();
                cancelFilePacketAckTimeout();

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
                emitTransferTelemetry(false);
                comManager.setFastMode(false);
                currentFileTransfer = null;
                pendingPackets.clear();
                cancelFilePacketAckTimeout();
            }
        }
    }

    /**
     * Emit transfer performance telemetry via {@link BluetoothReporting}.
     * Safe to call from any thread; no-ops if stats were never initialised.
     */
    private void emitTransferTelemetry(boolean success) {
        if (currentStats == null || currentFileTransfer == null) return;
        long durationMs = System.currentTimeMillis() - currentFileTransfer.startTime;
        long bytesPerSec = durationMs > 0
                ? (currentFileTransfer.fileSize * 1000L / durationMs)
                : 0;
        BluetoothReporting.reportFileTransferComplete(
                context,
                currentFileTransfer.filePath,
                currentStats.mode,
                success,
                currentFileTransfer.fileSize,
                currentFileTransfer.totalPackets,
                BesWireFormat.getFilePackSize(),
                durationMs,
                bytesPerSec,
                currentFileTransfer.retryCount,
                currentStats.packetRetries,
                currentStats.state0Count,
                currentStats.timeoutCount,
                currentStats.uartFailures,
                currentStats.preDelayMs);
        Log.i(TAG, "📊 [" + currentStats.mode + "] transfer=" + (success ? "OK" : "FAIL")
                + " dur=" + durationMs + "ms"
                + " rate=" + bytesPerSec + "B/s"
                + " packs=" + currentFileTransfer.totalPackets
                + " retries=" + currentFileTransfer.retryCount
                + " pktRetry=" + currentStats.packetRetries
                + " state0=" + currentStats.state0Count
                + " timeouts=" + currentStats.timeoutCount
                + " uartFail=" + currentStats.uartFailures);
        currentStats = null;
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

    /** Delete file after successful transfer */
    private void deleteFileAfterSuccess() {
        if (currentFileTransfer == null) {
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
