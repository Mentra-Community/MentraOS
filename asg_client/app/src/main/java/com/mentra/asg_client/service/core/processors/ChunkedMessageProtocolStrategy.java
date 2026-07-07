package com.mentra.asg_client.service.core.processors;

import android.util.Log;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.io.bluetooth.utils.BleJsonCompact;
import com.mentra.asg_client.logging.BleTraceLogger;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Protocol detection strategy for chunked messages. Detects and handles reassembly of messages
 * split across multiple chunks.
 */
public class ChunkedMessageProtocolStrategy
        implements CommandProtocolDetector.ProtocolDetectionStrategy {
    private static final String TAG = "ChunkedMessageStrategy";
    private static final AtomicLong CHUNK_TRACE_SEQUENCE = new AtomicLong(1);
    private static final long SIGNIFICANT_CHUNK_REASSEMBLY_MS = 250;
    private static final long CHUNK_TRACE_SESSION_TIMEOUT_MS = 30000;
    private static final int MAX_CHUNK_TRACE_SESSIONS = 10;

    private final ChunkReassembler chunkReassembler;
    private final ConcurrentHashMap<String, InboundChunkTraceSession> chunkTraceSessions =
            new ConcurrentHashMap<>();

    public ChunkedMessageProtocolStrategy(ChunkReassembler chunkReassembler) {
        this.chunkReassembler = chunkReassembler;
    }

    /** Returns true when the raw K900 frame is a v2 binary fragment (type 0x40). */
    public static boolean isBinaryWireFrame(byte[] frame) {
        return BesWireFormat.isBinaryWireFrame(frame);
    }

    /**
     * Process one inbound binary wire frame. Handshake frames are ignored here (handled upstream).
     *
     * @return Reassembled UTF-8 JSON bytes when the message is complete, otherwise null
     */
    public byte[] processBinaryWireFrame(byte[] frame) {
        BesWireFormat.BinaryHeader header = BesWireFormat.parseBinaryHeader(frame);
        if (!header.valid) {
            Log.w(TAG, "Invalid binary wire frame");
            return null;
        }

        if ((header.flags & BesWireFormat.FLAG_HANDSHAKE) != 0) {
            return null;
        }

        return chunkReassembler.addBinaryFragment(
                header.flags,
                header.msgId,
                header.fragIdx,
                header.fragCount,
                header.payload);
    }

    /**
     * Parse a completed binary reassembly into a protocol detection result.
     */
    public CommandProtocolDetector.ProtocolDetectionResult detectReassembledBinaryPayload(
            byte[] payload) {
        if (payload == null || payload.length == 0) {
            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.UNKNOWN, null, "", -1, false);
        }

        try {
            String jsonStr = new String(payload, StandardCharsets.UTF_8);
            JSONObject reassembledJson = new JSONObject(jsonStr);
            if (BesWireFormat.isBinaryProtocolActive()) {
                reassembledJson = BleJsonCompact.decodeIfSupported(reassembledJson);
                if (reassembledJson == null) {
                    Log.w(TAG, "Rejected unsupported compact reassembled wire form");
                    return new CommandProtocolDetector.ProtocolDetectionResult(
                            CommandProtocolDetector.ProtocolType.UNKNOWN, null, "", -1, false);
                }
            }
            String commandType = reassembledJson.optString("type", "");
            long messageId = reassembledJson.optLong("mId", -1);

            BleTraceLogger.logWireMetrics(
                    "phone_to_glasses",
                    "sdk_ble_binary",
                    commandType.isEmpty() ? "binary" : commandType,
                    payload.length,
                    payload.length,
                    1,
                    0,
                    BesWireFormat.getActiveProtocolVersion());

            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.JSON_COMMAND,
                    reassembledJson,
                    commandType,
                    messageId,
                    true);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to parse reassembled binary payload", e);
            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.UNKNOWN, null, "", -1, false);
        }
    }

    @Override
    public boolean canHandle(JSONObject json) {
        // Can handle if it has a "C" field containing chunked message
        if (json.has("C")) {
            String dataPayload = json.optString("C", "");
            try {
                JSONObject innerJson = new JSONObject(dataPayload);
                if (isChunkedType(innerJson)) return true;
            } catch (JSONException e) {
                // Not valid JSON in C field or not chunked message
                return false;
            }
        }

        // Also check direct format (for testing or future use)
        return isChunkedType(json);
    }

    /** Check for both verbose ("type":"chunked_msg") and compact ("t":"ck") formats */
    private boolean isChunkedType(JSONObject json) {
        String type = json.optString("type", json.optString("t", ""));
        return "chunked_msg".equals(type) || "ck".equals(type);
    }

    @Override
    public CommandProtocolDetector.ProtocolDetectionResult detect(JSONObject json) {
        try {
            JSONObject chunkMessage;
            boolean cWrapped = json.has("C");

            // Extract chunk message from C field if present
            if (cWrapped) {
                String dataPayload = json.optString("C", "");
                chunkMessage = new JSONObject(dataPayload);
                Log.d(TAG, "Detected chunked message in C field format");
            } else {
                // Direct format
                chunkMessage = json;
                Log.d(TAG, "Detected chunked message in direct format");
            }

            // Extract chunk information (supports both verbose and compact keys)
            String chunkId = optStringFallback(chunkMessage, "chunkId", "id");
            int chunkIndex = optIntFallback(chunkMessage, "chunk", "c", -1);
            int totalChunks = optIntFallback(chunkMessage, "total", "n", -1);
            String data = optStringFallback(chunkMessage, "data", "d");
            long messageId = chunkMessage.optLong("mId", -1);
            long traceSequence = CHUNK_TRACE_SEQUENCE.getAndIncrement();

            if (chunkId == null
                    || chunkId.isEmpty()
                    || chunkIndex < 0
                    || totalChunks <= 0
                    || chunkIndex >= totalChunks
                    || data == null) {
                Log.e(TAG, "Missing required chunk fields");
                logInboundBleChunk(
                        "invalid",
                        "chunked",
                        traceSequence,
                        chunkId,
                        chunkIndex,
                        totalChunks,
                        data,
                        messageId,
                        cWrapped,
                        json,
                        null,
                        null,
                        null,
                        null,
                        "missing_required_chunk_fields");
                return new CommandProtocolDetector.ProtocolDetectionResult(
                        CommandProtocolDetector.ProtocolType.UNKNOWN, json, "", -1, false);
            }

            InboundChunkTraceSession traceSession =
                    noteInboundChunk(chunkId, chunkIndex, totalChunks);

            Log.d(
                    TAG,
                    "Processing chunk "
                            + chunkIndex
                            + "/"
                            + (totalChunks - 1)
                            + " for session "
                            + chunkId
                            + (messageId != -1 ? " (mId: " + messageId + ")" : ""));
            logInboundBleChunk(
                    "received",
                    "chunked",
                    traceSequence,
                    chunkId,
                    chunkIndex,
                    totalChunks,
                    data,
                    messageId,
                    cWrapped,
                    json,
                    null,
                    null,
                    null,
                    null,
                    null);

            // Add chunk to reassembler
            String reassembled = chunkReassembler.addChunk(chunkId, chunkIndex, totalChunks, data);

            if (reassembled != null) {
                // Message complete - parse and return the reassembled message
                Log.d(
                        TAG,
                        "Chunk session " + chunkId + " complete, processing reassembled message");

                try {
                    JSONObject reassembledJson = new JSONObject(reassembled);

                    // Extract command type and message ID from reassembled message
                    String commandType = reassembledJson.optString("type", "");
                    long reassembledMessageId = reassembledJson.optLong("mId", messageId);
                    long reassemblyDurationMs = traceSession.durationMs();
                    int receivedChunks = traceSession.receivedChunks;
                    chunkTraceSessions.remove(chunkId);
                    logInboundBleChunk(
                            "reassembled",
                            commandType,
                            traceSequence,
                            chunkId,
                            chunkIndex,
                            totalChunks,
                            data,
                            reassembledMessageId,
                            cWrapped,
                            json,
                            reassembled,
                            reassembledJson,
                            reassemblyDurationMs,
                            receivedChunks,
                            null);

                    Log.d(
                            TAG,
                            "Reassembled message type: "
                                    + commandType
                                    + ", messageId: "
                                    + reassembledMessageId);

                    return new CommandProtocolDetector.ProtocolDetectionResult(
                            CommandProtocolDetector.ProtocolType.JSON_COMMAND,
                            reassembledJson,
                            commandType,
                            reassembledMessageId,
                            true);

                } catch (JSONException e) {
                    Log.e(TAG, "Failed to parse reassembled message as JSON: " + reassembled, e);
                    chunkTraceSessions.remove(chunkId);
                    logInboundBleChunk(
                            "reassemble_parse_error",
                            "chunked",
                            traceSequence,
                            chunkId,
                            chunkIndex,
                            totalChunks,
                            data,
                            messageId,
                            cWrapped,
                            json,
                            reassembled,
                            null,
                            traceSession.durationMs(),
                            traceSession.receivedChunks,
                            e.getClass().getSimpleName());

                    // Return as unknown protocol if not valid JSON
                    return new CommandProtocolDetector.ProtocolDetectionResult(
                            CommandProtocolDetector.ProtocolType.UNKNOWN,
                            json,
                            "",
                            messageId,
                            false);
                }
            } else {
                // Chunk added but message not complete yet
                Log.d(TAG, "Chunk added, waiting for more chunks");

                // Return a special result indicating chunk processing in progress
                // This should not trigger further processing
                return new CommandProtocolDetector.ProtocolDetectionResult(
                        CommandProtocolDetector.ProtocolType.JSON_COMMAND,
                        null, // No data to process yet
                        "chunk_in_progress",
                        -1, // No ACK needed for individual chunks
                        false // Not valid for processing
                        );
            }

        } catch (Exception e) {
            Log.e(TAG, "Error processing chunked message", e);
            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.UNKNOWN, json, "", -1, false);
        }
    }

    private InboundChunkTraceSession noteInboundChunk(
            String chunkId, int chunkIndex, int totalChunks) {
        pruneInboundChunkTraceSessions(chunkId);
        return chunkTraceSessions.compute(
                chunkId,
                (id, existing) -> {
                    InboundChunkTraceSession session =
                            existing != null ? existing : new InboundChunkTraceSession();
                    session.receivedChunks++;
                    session.totalChunks = totalChunks;
                    session.maxChunkIndex = Math.max(session.maxChunkIndex, chunkIndex);
                    session.lastChunkAtMs = System.currentTimeMillis();
                    return session;
                });
    }

    private void pruneInboundChunkTraceSessions(String incomingChunkId) {
        long now = System.currentTimeMillis();
        chunkTraceSessions
                .entrySet()
                .removeIf(
                        entry ->
                                now - entry.getValue().lastChunkAtMs
                                        > CHUNK_TRACE_SESSION_TIMEOUT_MS);

        if (chunkTraceSessions.size() < MAX_CHUNK_TRACE_SESSIONS
                || chunkTraceSessions.containsKey(incomingChunkId)) {
            return;
        }

        String oldestChunkId = null;
        long oldestChunkAtMs = Long.MAX_VALUE;
        for (Map.Entry<String, InboundChunkTraceSession> entry : chunkTraceSessions.entrySet()) {
            long lastChunkAtMs = entry.getValue().lastChunkAtMs;
            if (lastChunkAtMs < oldestChunkAtMs) {
                oldestChunkAtMs = lastChunkAtMs;
                oldestChunkId = entry.getKey();
            }
        }
        if (oldestChunkId != null) {
            chunkTraceSessions.remove(oldestChunkId);
        }
    }

    private static void logInboundBleChunk(
            String stage,
            String eventType,
            long sequence,
            String chunkId,
            int chunkIndex,
            int totalChunks,
            String data,
            long messageId,
            boolean cWrapped,
            JSONObject sourceJson,
            String reassembled,
            JSONObject reassembledJson,
            Long reassemblyDurationMs,
            Integer receivedChunks,
            String errorMessage) {
        String warningReason = inboundChunkWarningReason(stage, reassemblyDurationMs, errorMessage);
        if (warningReason == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("level", "warning");
            payload.put("warningReason", warningReason);
            payload.put("stage", stage);
            payload.put("sequence", sequence);
            payload.put("chunked", true);
            payload.put("cWrapped", cWrapped);
            if (chunkId != null && !chunkId.isEmpty()) {
                payload.put("chunkId", chunkId);
            }
            if (chunkIndex >= 0) {
                payload.put("chunkIndex", chunkIndex);
                payload.put("chunkNumber", chunkIndex + 1);
            }
            if (totalChunks > 0) {
                payload.put("totalChunks", totalChunks);
            }
            payload.put("payloadBytes", utf8ByteCount(data));
            if (sourceJson != null) {
                payload.put("wireJsonBytes", utf8ByteCount(sourceJson.toString()));
            }
            if (messageId != -1) {
                payload.put("messageId", messageId);
            }
            if (receivedChunks != null) {
                payload.put("receivedChunks", receivedChunks.intValue());
            }
            if (reassemblyDurationMs != null) {
                payload.put("durationMs", reassemblyDurationMs.longValue());
            }
            if (reassembled != null) {
                payload.put("reassembledBytes", utf8ByteCount(reassembled));
                payload.put("complete", true);
            }
            if (reassembledJson != null) {
                putIfPresent(payload, "commandType", reassembledJson.optString("type", ""));
                putIfPresent(payload, "requestId", reassembledJson.optString("requestId", ""));
                putIfPresent(payload, "appId", reassembledJson.optString("appId", ""));
            }
            putIfPresent(payload, "errorMessage", errorMessage);
        } catch (Exception ignored) {
            // Keep trace logging non-fatal.
        }

        BleTraceLogger.logEvent(
                "phone_to_glasses",
                "sdk_ble_chunk",
                eventType != null && !eventType.isEmpty() ? eventType : "chunked",
                payload);
    }

    private static String inboundChunkWarningReason(
            String stage, Long reassemblyDurationMs, String errorMessage) {
        if (errorMessage != null && !errorMessage.isEmpty()) {
            return "chunk_reassembly_error";
        }
        if ("invalid".equals(stage) || "reassemble_parse_error".equals(stage)) {
            return "chunk_reassembly_error";
        }
        if (reassemblyDurationMs != null
                && reassemblyDurationMs >= SIGNIFICANT_CHUNK_REASSEMBLY_MS) {
            return "chunk_reassembly_duration";
        }
        return null;
    }

    private static class InboundChunkTraceSession {
        final long firstChunkAtMs = System.currentTimeMillis();
        long lastChunkAtMs = firstChunkAtMs;
        int receivedChunks = 0;
        int totalChunks = 0;
        int maxChunkIndex = -1;

        long durationMs() {
            return lastChunkAtMs - firstChunkAtMs;
        }
    }

    @Override
    public CommandProtocolDetector.ProtocolType getProtocolType() {
        return CommandProtocolDetector.ProtocolType.JSON_COMMAND;
    }

    /** Try full key first, then compact key */
    private static String optStringFallback(JSONObject json, String fullKey, String compactKey) {
        if (json.has(fullKey)) {
            return json.optString(fullKey, null);
        }
        if (json.has(compactKey)) {
            return json.optString(compactKey, null);
        }
        return null;
    }

    /** Try full key first, then compact key, then default */
    private static int optIntFallback(
            JSONObject json, String fullKey, String compactKey, int defaultValue) {
        if (json.has(fullKey)) {
            return json.optInt(fullKey, defaultValue);
        }
        return json.optInt(compactKey, defaultValue);
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
}
