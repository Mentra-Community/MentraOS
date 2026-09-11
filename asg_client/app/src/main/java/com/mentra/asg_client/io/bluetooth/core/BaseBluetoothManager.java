package com.mentra.asg_client.io.bluetooth.core;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.interfaces.TransportListener;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.receiver.IntentResponseBroadcaster;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Base implementation of the IBluetoothManager interface. Provides common functionality for all
 * bluetooth manager implementations.
 */
public abstract class BaseBluetoothManager implements ICompanionTransport {
    private static final String TAG = "BaseBluetoothManager";
    private static final long SIGNIFICANT_QUEUE_DELAY_MS = 250;
    private static final long SIGNIFICANT_SEND_DURATION_MS = 250;
    private static final int SIGNIFICANT_QUEUE_SIZE = 5;
    private static final long OUTBOUND_FILE_START_TIMEOUT_MS = 30000;

    protected final Context context;
    protected final List<TransportListener> listeners = new ArrayList<>();
    protected boolean isConnected = false;
    private final ThreadPoolExecutor outboundBleExecutor;
    private final AtomicLong outboundBleSequence = new AtomicLong(1);
    private final ThreadLocal<Boolean> outboundBleWorkerThread =
            ThreadLocal.withInitial(() -> false);

    /**
     * Create a new BaseBluetoothManager
     *
     * @param context The application context
     */
    public BaseBluetoothManager(Context context) {
        this.context = context.getApplicationContext();
        this.outboundBleExecutor =
                new ThreadPoolExecutor(
                        1,
                        1,
                        0L,
                        TimeUnit.MILLISECONDS,
                        new LinkedBlockingQueue<>(),
                        runnable -> {
                            Thread thread =
                                    new Thread(
                                            runnable, getClass().getSimpleName() + "-outbound-ble");
                            thread.setDaemon(true);
                            return thread;
                        });
    }

    @Override
    public void addBluetoothListener(TransportListener listener) {
        if (!listeners.contains(listener)) {
            listeners.add(listener);
        }
    }

    @Override
    public void removeBluetoothListener(TransportListener listener) {
        listeners.remove(listener);
    }

    /**
     * Notify all listeners that the bluetooth connection state has changed
     *
     * @param connected true if connected, false otherwise
     */
    protected void notifyConnectionStateChanged(boolean connected) {
        Log.d(
                TAG,
                "Bluetooth connection state changed: "
                        + (connected ? "CONNECTED" : "DISCONNECTED"));
        this.isConnected = connected;
        for (TransportListener listener : listeners) {
            try {
                listener.onConnectionStateChanged(connected);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener of connection state change", e);
            }
        }
    }

    /**
     * Notify all listeners that data has been received
     *
     * @param data The received data
     */
    protected void notifyDataReceived(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "Attempted to notify data received with null or empty data");
            return;
        }

        Log.d(TAG, "Bluetooth data received: " + data.length + " bytes");
        BleTraceLogger.logBytes("phone_to_glasses", "asg_ble_input", data);
        for (TransportListener listener : listeners) {
            try {
                listener.onDataReceived(data);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener of data reception", e);
            }
        }
    }

    /** Queue an outbound message so BLE chunk pacing never blocks app/camera handler threads. */
    @Override
    public final boolean sendMessage(byte[] data) {
        return sendMessage(data, null);
    }

    /** Queue an outbound message and notify once the queued send attempt finishes. */
    @Override
    public final boolean sendMessage(byte[] data, SendMessageCallback callback) {
        return sendMessage(data, callback, null);
    }

    /** Queue an outbound message with a final worker-side send gate. */
    @Override
    public final boolean sendMessage(
            byte[] data, SendMessageCallback callback, SendMessageGate gate) {
        return queueOutboundMessage(data, callback, true, gate);
    }

    /** Queue an outbound command that should not be broadcast back to phone-facing listeners. */
    protected final boolean sendInternalCommand(byte[] data) {
        return queueOutboundMessage(data, null, false, null);
    }

    private boolean queueOutboundMessage(
            byte[] data,
            SendMessageCallback callback,
            boolean broadcastJsonResponses,
            SendMessageGate gate) {
        if (data == null || data.length == 0) {
            return false;
        }

        byte[] payload = Arrays.copyOf(data, data.length);
        long sequence = outboundBleSequence.getAndIncrement();
        long queuedAtMs = System.currentTimeMillis();
        OutboundTraceInfo traceInfo = OutboundTraceInfo.from(payload);

        try {
            outboundBleExecutor.execute(
                    () ->
                            runOnOutboundBleWorker(
                                    () ->
                                            sendQueuedMessage(
                                                    payload,
                                                    sequence,
                                                    queuedAtMs,
                                                    traceInfo,
                                                    callback,
                                                    broadcastJsonResponses,
                                                    gate)));
            logOutboundQueueEvent(
                    "queued",
                    sequence,
                    traceInfo,
                    queuedAtMs,
                    null,
                    null,
                    null,
                    payload.length,
                    outboundBleExecutor.getQueue().size(),
                    null);
            return true;
        } catch (RejectedExecutionException e) {
            logOutboundQueueEvent(
                    "rejected",
                    sequence,
                    traceInfo,
                    queuedAtMs,
                    null,
                    null,
                    false,
                    payload.length,
                    outboundBleExecutor.getQueue().size(),
                    e);
            return false;
        }
    }

    private void sendQueuedMessage(
            byte[] data,
            long sequence,
            long queuedAtMs,
            OutboundTraceInfo traceInfo,
            SendMessageCallback callback,
            boolean broadcastJsonResponses,
            SendMessageGate gate) {
        long dequeuedAtMs = System.currentTimeMillis();
        logOutboundQueueEvent(
                "dequeued",
                sequence,
                traceInfo,
                queuedAtMs,
                dequeuedAtMs - queuedAtMs,
                null,
                null,
                data.length,
                outboundBleExecutor.getQueue().size(),
                null);

        long sendStartedAtMs = System.currentTimeMillis();
        boolean success = false;
        boolean skipped = false;
        Exception error = null;
        try {
            if (gate == null) {
                success = sendMessageNow(data, broadcastJsonResponses);
            } else {
                Object gateLock = gate.lock();
                if (gateLock == null) {
                    if (!shouldSendQueuedMessage(gate)) {
                        skipped = true;
                        return;
                    }
                    success = sendMessageNow(data, broadcastJsonResponses);
                } else {
                    synchronized (gateLock) {
                        if (!shouldSendQueuedMessage(gate)) {
                            skipped = true;
                            return;
                        }
                        success = sendMessageNow(data, broadcastJsonResponses);
                    }
                }
            }
        } catch (Exception e) {
            error = e;
            Log.e(TAG, "Error sending queued outbound BLE message", e);
        } finally {
            if (!skipped) {
                logOutboundQueueEvent(
                        "send_result",
                        sequence,
                        traceInfo,
                        queuedAtMs,
                        sendStartedAtMs - queuedAtMs,
                        System.currentTimeMillis() - sendStartedAtMs,
                        success,
                        data.length,
                        outboundBleExecutor.getQueue().size(),
                        error);
            }
            notifySendMessageCallback(callback, success);
        }
    }

    private boolean shouldSendQueuedMessage(SendMessageGate gate) {
        if (gate == null) {
            return true;
        }
        try {
            return gate.shouldSend();
        } catch (Exception e) {
            Log.w(TAG, "Queued send gate failed", e);
            return false;
        }
    }

    private void runOnOutboundBleWorker(Runnable runnable) {
        boolean wasWorker = Boolean.TRUE.equals(outboundBleWorkerThread.get());
        outboundBleWorkerThread.set(true);
        try {
            runnable.run();
        } finally {
            if (wasWorker) {
                outboundBleWorkerThread.set(true);
            } else {
                outboundBleWorkerThread.remove();
            }
        }
    }

    private <T> T callOnOutboundBleWorker(Callable<T> callable) throws Exception {
        boolean wasWorker = Boolean.TRUE.equals(outboundBleWorkerThread.get());
        outboundBleWorkerThread.set(true);
        try {
            return callable.call();
        } finally {
            if (wasWorker) {
                outboundBleWorkerThread.set(true);
            } else {
                outboundBleWorkerThread.remove();
            }
        }
    }

    /** Queue a transport-owned action behind every previously accepted outbound message. */
    protected final boolean queueOutboundAction(Runnable action) {
        if (action == null) {
            return false;
        }
        try {
            outboundBleExecutor.execute(() -> runOnOutboundBleWorker(action));
            return true;
        } catch (RejectedExecutionException e) {
            Log.e(TAG, "Rejected transport-owned outbound action", e);
            return false;
        }
    }

    private static void notifySendMessageCallback(SendMessageCallback callback, boolean success) {
        if (callback == null) {
            return;
        }
        try {
            callback.onSendComplete(success);
        } catch (Exception e) {
            Log.w(TAG, "Queued send callback failed", e);
        }
    }

    /**
     * Template method: broadcasts JSON responses to registered intent listeners, then delegates to
     * the subclass-specific send implementation.
     */
    private boolean sendMessageNow(byte[] data, boolean broadcastJsonResponses) {
        publishOutboundMessage(data, broadcastJsonResponses);
        return sendMessageInternal(data);
    }

    /**
     * Record and locally publish a message that a subclass will send on its owned transport lane.
     */
    protected final void publishOutboundMessage(byte[] data, boolean broadcastJsonResponses) {
        BleTraceLogger.logBytes("glasses_to_phone", "asg_ble_output", data);

        // Try to broadcast JSON responses to intent listeners
        if (broadcastJsonResponses) {
            try {
                String str = new String(data, StandardCharsets.UTF_8);
                if (str.startsWith("{")) {
                    JSONObject json = new JSONObject(str);
                    IntentResponseBroadcaster.getInstance().broadcastResponse(context, json);
                }
            } catch (Exception e) {
                // Not valid JSON; skip broadcast, still send over BLE.
            }
        }
    }

    private void logOutboundQueueEvent(
            String stage,
            long sequence,
            OutboundTraceInfo traceInfo,
            long queuedAtMs,
            Long queueDelayMs,
            Long sendDurationMs,
            Boolean success,
            int payloadBytes,
            int queueSize,
            Exception error) {
        String warningReason =
                outboundQueueWarningReason(
                        stage, queueDelayMs, sendDurationMs, success, queueSize, error);
        if (warningReason == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("level", "warning");
            payload.put("warningReason", warningReason);
            payload.put("stage", stage);
            payload.put("sequence", sequence);
            payload.put("commandType", traceInfo.commandType);
            putIfPresent(payload, "requestId", traceInfo.requestId);
            putIfPresent(payload, "appId", traceInfo.appId);
            if (traceInfo.messageId != -1) {
                payload.put("messageId", traceInfo.messageId);
            }
            payload.put("queuedAtMs", queuedAtMs);
            payload.put("payloadBytes", payloadBytes);
            payload.put("queueSize", queueSize);
            if (queueDelayMs != null) {
                payload.put("queueDelayMs", queueDelayMs.longValue());
            }
            if (sendDurationMs != null) {
                payload.put("sendDurationMs", sendDurationMs.longValue());
            }
            if (success != null) {
                payload.put("success", success.booleanValue());
            }
            if (error != null) {
                payload.put("errorClass", error.getClass().getSimpleName());
                payload.put("errorMessage", error.getMessage());
            }
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }

        BleTraceLogger.logEvent(
                "glasses_to_phone", "asg_ble_outbound_queue", traceInfo.commandType, payload);
    }

    private static String outboundQueueWarningReason(
            String stage,
            Long queueDelayMs,
            Long sendDurationMs,
            Boolean success,
            int queueSize,
            Exception error) {
        if (error != null) {
            return "send_error";
        }
        if (Boolean.FALSE.equals(success)) {
            return "send_failed";
        }
        if ("rejected".equals(stage)) {
            return "queue_rejected";
        }
        if (queueDelayMs != null && queueDelayMs >= SIGNIFICANT_QUEUE_DELAY_MS) {
            return "queue_delay";
        }
        if (sendDurationMs != null && sendDurationMs >= SIGNIFICANT_SEND_DURATION_MS) {
            return "send_duration";
        }
        if ("queued".equals(stage) && queueSize >= SIGNIFICANT_QUEUE_SIZE) {
            return "queue_depth";
        }
        return null;
    }

    private static void putIfPresent(JSONObject payload, String key, String value) {
        try {
            if (value != null && !value.isEmpty()) {
                payload.put(key, value);
            }
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }
    }

    private static final class OutboundTraceInfo {
        final String commandType;
        final String requestId;
        final String appId;
        final long messageId;

        OutboundTraceInfo(String commandType, String requestId, String appId, long messageId) {
            this.commandType = commandType;
            this.requestId = requestId;
            this.appId = appId;
            this.messageId = messageId;
        }

        static OutboundTraceInfo from(byte[] data) {
            String commandType = "unknown";
            String requestId = null;
            String appId = null;
            long messageId = -1;

            try {
                String str = new String(data, StandardCharsets.UTF_8).trim();
                if (!str.startsWith("{")) {
                    return new OutboundTraceInfo("raw", null, null, -1);
                }

                JSONObject json = new JSONObject(str);
                commandType = nonEmptyString(json, "type");
                requestId = nonEmptyString(json, "requestId");
                appId = nonEmptyString(json, "appId");
                messageId = optMessageId(json);

                String cValue = json.optString("C", "");
                if ((commandType == null || commandType.isEmpty()) && !cValue.isEmpty()) {
                    try {
                        JSONObject inner = new JSONObject(cValue);
                        commandType = firstNonEmpty(inner, "type", "t");
                        requestId = firstNonEmpty(inner, "requestId", "r");
                        appId = firstNonEmpty(inner, "appId", "a");
                        messageId = optMessageId(inner);
                    } catch (Exception ignored) {
                        // C is often a compact K900 command, not JSON.
                    }

                    if (commandType == null || commandType.isEmpty()) {
                        commandType = "k900";
                    }
                }
            } catch (Exception ignored) {
                // Best-effort trace metadata only.
            }

            if (commandType == null || commandType.isEmpty()) {
                commandType = "unknown";
            }
            return new OutboundTraceInfo(commandType, requestId, appId, messageId);
        }

        private static String firstNonEmpty(JSONObject json, String... keys) {
            for (String key : keys) {
                String value = nonEmptyString(json, key);
                if (value != null) {
                    return value;
                }
            }
            return null;
        }

        private static String nonEmptyString(JSONObject json, String key) {
            String value = json.optString(key, "");
            return value.isEmpty() ? null : value;
        }

        private static long optMessageId(JSONObject json) {
            if (json.has("messageId")) {
                return json.optLong("messageId", -1);
            }
            return json.optLong("mId", -1);
        }
    }

    /**
     * Subclass-specific send implementation.
     *
     * @param data The data to send
     * @return true if the data was sent successfully
     */
    protected abstract boolean sendMessageInternal(byte[] data);

    @Override
    public boolean isConnected() {
        return isConnected;
    }

    /** Initialize the bluetooth manager Default implementation just logs the initialization */
    @Override
    public void initialize() {
        Log.d(TAG, "Initializing bluetooth manager");
    }

    /** Clean up resources Default implementation clears listeners */
    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down bluetooth manager");
        outboundBleExecutor.shutdownNow();
        listeners.clear();
    }

    /**
     * Send a test image from assets folder (for testing purposes) Default implementation returns
     * false. Override in subclasses that support file transfer.
     *
     * @param assetFileName Name of the image file in assets folder
     * @return true if transfer started, false otherwise
     */
    public boolean sendTestImageFromAssets(String assetFileName) {
        Log.w(TAG, "sendTestImageFromAssets not implemented in " + getClass().getSimpleName());
        return false;
    }

    public final boolean sendFile(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return startFileTransfer(() -> sendFileInternal(path));
    }

    /**
     * Send an in-memory payload using the file-transfer protocol without requiring it to exist on
     * disk. Same outbound-worker serialization and start-timeout semantics as the path-based {@link
     * #sendFile(String)}.
     */
    @Override
    public final boolean sendFile(byte[] data, String fileName) {
        if (data == null || data.length == 0 || fileName == null || fileName.isEmpty()) {
            return false;
        }
        return startFileTransfer(() -> sendFileInternal(data, fileName));
    }

    @Override
    public final boolean sendFile(byte[] data, String fileName, byte[] prelude) {
        if (data == null
                || data.length == 0
                || fileName == null
                || fileName.isEmpty()
                || prelude == null
                || prelude.length == 0) {
            return false;
        }
        return startFileTransfer(() -> sendFileInternal(data, fileName, prelude));
    }

    private boolean startFileTransfer(Callable<Boolean> startAction) {
        if (Boolean.TRUE.equals(outboundBleWorkerThread.get())) {
            try {
                return startAction.call();
            } catch (Exception e) {
                Log.e(TAG, "Outbound BLE file transfer start failed on worker", e);
                return false;
            }
        }

        Future<Boolean> future = null;
        try {
            future = outboundBleExecutor.submit(() -> callOnOutboundBleWorker(startAction));
            return future.get(OUTBOUND_FILE_START_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            Log.e(TAG, "Rejected outbound BLE file transfer start", e);
            return false;
        } catch (TimeoutException e) {
            if (future != null && future.cancel(false)) {
                Log.e(TAG, "Timed out waiting for queued outbound BLE file transfer start", e);
                return false;
            }
            Log.w(
                    TAG,
                    "Timed out waiting for outbound BLE file transfer start after it began; "
                            + "waiting for the actual start result",
                    e);
            return awaitFileTransferStartResult(future, OUTBOUND_FILE_START_TIMEOUT_MS);
        } catch (InterruptedException e) {
            if (future != null) {
                future.cancel(false);
            }
            Thread.currentThread().interrupt();
            Log.e(TAG, "Interrupted waiting for outbound BLE file transfer start", e);
            return false;
        } catch (ExecutionException e) {
            Log.e(TAG, "Outbound BLE file transfer start failed", e);
            return false;
        }
    }

    private boolean awaitFileTransferStartResult(Future<Boolean> future, long timeoutMs) {
        if (future == null) {
            return false;
        }
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            Log.w(
                    TAG,
                    "Timed out waiting for already-running outbound BLE file transfer start; "
                            + "leaving the worker uninterrupted",
                    e);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.e(TAG, "Interrupted waiting for outbound BLE file transfer start result", e);
            return false;
        } catch (ExecutionException e) {
            Log.e(TAG, "Outbound BLE file transfer start failed", e);
            return false;
        }
    }

    protected boolean sendFileInternal(String path) {
        Log.w(TAG, "sendFile not implemented in " + getClass().getSimpleName());
        return false;
    }

    protected boolean sendFileInternal(byte[] data, String fileName) {
        Log.w(TAG, "sendFile(byte[]) not implemented in " + getClass().getSimpleName());
        return false;
    }

    protected boolean sendFileInternal(byte[] data, String fileName, byte[] prelude) {
        Log.w(TAG, "sendFile(byte[], prelude) not implemented in " + getClass().getSimpleName());
        return false;
    }
}
