package com.mentra.bluetoothsdk.utils;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Handles chunking of large messages that exceed BLE transmission limits.
 * Messages are split at the JSON layer to work within MCU protocol constraints.
 *
 * Uses compact keys to minimize overhead per chunk:
 *   t  = "ck" (chunk type identifier)
 *   id = chunk session ID
 *   c  = chunk index (0-based)
 *   n  = total number of chunks
 *   d  = chunk data payload
 *
 * Each chunk after C-wrapping + K900 framing must fit within the BES2700's
 * 253-byte BLE write limit. Payload size is selected by measuring the final
 * packed chunk so JSON escaping cannot push a chunk over the BLE limit.
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    // Threshold: if C-wrapped message exceeds this, chunking is triggered.
    // BES2700 limit is 253 bytes; anything over ~200 bytes packed needs chunking.
    private static final int MESSAGE_SIZE_THRESHOLD = 200;

    private static final int INITIAL_CHUNK_DATA_SIZE = 80;
    private static final int MIN_CHUNK_DATA_SIZE = 4;
    private static final int MAX_PACKED_CHUNK_SIZE = 253;
    private static final int MAX_BINARY_FRAGMENT_PAYLOAD = BleWireProtocol.MAX_FRAGMENT_PAYLOAD;
    private static final int MAX_BINARY_FRAME_SIZE = BleWireProtocol.MTU_TARGET;

    /**
     * Check if a message needs to be chunked
     * @param message The complete message string (already C-wrapped)
     * @return true if message exceeds threshold and needs chunking
     */
    public static boolean needsChunking(String message) {
        if (message == null) {
            return false;
        }

        int messageBytes = message.getBytes(StandardCharsets.UTF_8).length;
        boolean needsChunking = messageBytes > MESSAGE_SIZE_THRESHOLD;

        if (needsChunking) {
            Log.d(TAG, "Message size " + messageBytes + " exceeds threshold " + MESSAGE_SIZE_THRESHOLD + ", will chunk");
        }

        return needsChunking;
    }

    /**
     * Create chunks from a message that's too large for single transmission.
     * Uses compact keys to minimize per-chunk overhead.
     * @param originalJson The original JSON string to be sent (before C-wrapping)
     * @param messageId The message ID for ACK tracking (if applicable)
     * @return List of chunk JSON objects ready to be C-wrapped and sent
     */
    public static List<JSONObject> createChunks(String originalJson, long messageId) throws JSONException {
        return createChunks(originalJson, messageId, false);
    }

    public static List<JSONObject> createChunks(String originalJson, long messageId, boolean wakeup) throws JSONException {
        if (originalJson == null) {
            throw new IllegalArgumentException("Cannot chunk null message");
        }

        byte[] messageBytes = originalJson.getBytes(StandardCharsets.UTF_8);
        int totalBytes = messageBytes.length;

        // Compact chunk session ID: messageId_timestamp (no "chunk_" prefix)
        String chunkId = messageId + "_" + System.currentTimeMillis();

        for (int chunkSize = INITIAL_CHUNK_DATA_SIZE; chunkSize >= MIN_CHUNK_DATA_SIZE; chunkSize--) {
            List<JSONObject> chunks = buildChunks(messageBytes, chunkId, messageId, chunkSize);
            if (allChunksFit(chunks, wakeup)) {
                Log.d(TAG, "Creating " + chunks.size() + " chunks for message of size " + totalBytes
                        + " bytes using " + chunkSize + "-byte UTF-8 slices");
                return chunks;
            }
        }

        throw new JSONException("Unable to create K900 chunks within " + MAX_PACKED_CHUNK_SIZE + " bytes");
    }

    private static List<JSONObject> buildChunks(byte[] messageBytes, String chunkId, long messageId, int chunkSize) throws JSONException {
        List<JSONObject> chunks = new ArrayList<>();
        List<String> chunkDataList = splitUtf8(messageBytes, chunkSize);
        int totalChunks = chunkDataList.size();

        for (int i = 0; i < totalChunks; i++) {
            String chunkData = chunkDataList.get(i);

            // Create chunk JSON with compact keys
            JSONObject chunk = new JSONObject();
            chunk.put("t", "ck");
            chunk.put("id", chunkId);
            chunk.put("c", i);
            chunk.put("n", totalChunks);
            chunk.put("d", chunkData);

            // Add message ID to final chunk only for ACK tracking
            if (i == totalChunks - 1 && messageId != -1) {
                chunk.put("mId", messageId);
            }

            chunks.add(chunk);

            Log.d(TAG, "Created chunk " + i + "/" + (totalChunks - 1) + " with " + chunkData.getBytes(StandardCharsets.UTF_8).length + " bytes");
        }

        return chunks;
    }

    private static boolean allChunksFit(List<JSONObject> chunks, boolean wakeup) {
        for (int i = 0; i < chunks.size(); i++) {
            byte[] packed = K900ProtocolUtils.packJsonToK900(chunks.get(i).toString(), wakeup && i == 0);
            if (packed == null || packed.length > MAX_PACKED_CHUNK_SIZE) {
                Log.d(TAG, "Chunk " + i + " packed to " + (packed != null ? packed.length : 0)
                        + " bytes, exceeding " + MAX_PACKED_CHUNK_SIZE);
                return false;
            }
        }
        return true;
    }

    private static List<String> splitUtf8(byte[] messageBytes, int chunkSize) {
        List<String> chunkDataList = new ArrayList<>();
        int offset = 0;
        while (offset < messageBytes.length) {
            int endIndex = findUtf8ChunkEnd(messageBytes, offset, chunkSize);
            chunkDataList.add(new String(messageBytes, offset, endIndex - offset, StandardCharsets.UTF_8));
            offset = endIndex;
        }
        return chunkDataList;
    }

    private static int findUtf8ChunkEnd(byte[] messageBytes, int startIndex, int chunkSize) {
        int endIndex = Math.min(startIndex + chunkSize, messageBytes.length);
        while (endIndex > startIndex && endIndex < messageBytes.length && isUtf8ContinuationByte(messageBytes[endIndex])) {
            endIndex--;
        }
        return endIndex > startIndex ? endIndex : Math.min(startIndex + chunkSize, messageBytes.length);
    }

    private static boolean isUtf8ContinuationByte(byte value) {
        return (value & 0xC0) == 0x80;
    }

    /**
     * Check if a received message is a chunked message.
     * Supports both verbose ("type":"chunked_msg") and compact ("t":"ck") formats.
     * @param json The received JSON object (after C-unwrapping)
     * @return true if this is a chunked message
     */
    public static boolean isChunkedMessage(JSONObject json) {
        if (json == null) {
            return false;
        }

        String type = json.optString("type", json.optString("t", ""));
        return "chunked_msg".equals(type) || "ck".equals(type);
    }

    /**
     * Extract chunk information from a chunked message.
     * Supports both verbose and compact key formats.
     */
    public static ChunkInfo getChunkInfo(JSONObject json) throws JSONException {
        if (!isChunkedMessage(json)) {
            return null;
        }

        // Support both verbose and compact keys
        String chunkId = optStringWithFallback(json, "chunkId", "id");
        int chunkIndex = optIntWithFallback(json, "chunk", "c", -1);
        int totalChunks = optIntWithFallback(json, "total", "n", -1);
        String data = optStringWithFallback(json, "data", "d");
        long messageId = json.optLong("mId", -1);

        if (chunkId == null || chunkIndex < 0 || totalChunks < 0 || data == null) {
            return null;
        }

        return new ChunkInfo(chunkId, chunkIndex, totalChunks, data, messageId);
    }

    /** Try full key first, then compact key */
    private static String optStringWithFallback(JSONObject json, String fullKey, String compactKey) {
        if (json.has(fullKey)) {
            return json.optString(fullKey, null);
        }
        return json.optString(compactKey, null);
    }

    /** Try full key first, then compact key, then default */
    private static int optIntWithFallback(JSONObject json, String fullKey, String compactKey, int defaultValue) {
        if (json.has(fullKey)) {
            return json.optInt(fullKey, defaultValue);
        }
        return json.optInt(compactKey, defaultValue);
    }

    public static boolean needsBinaryFragmenting(byte[] payload) {
        return payload != null && payload.length > MAX_BINARY_FRAGMENT_PAYLOAD;
    }

    public static boolean needsBinaryFragmenting(String json) {
        if (json == null) {
            return false;
        }
        return needsBinaryFragmenting(json.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Split raw UTF-8 payload into binary wire fragments (v2 path).
     */
    public static List<BinaryFragment> createBinaryFragments(
            byte[] payload, int msgId, boolean wakeup, boolean ackRequested) {
        if (payload == null) {
            throw new IllegalArgumentException("Cannot fragment null payload");
        }

        int fragCount = (payload.length + MAX_BINARY_FRAGMENT_PAYLOAD - 1) / MAX_BINARY_FRAGMENT_PAYLOAD;
        if (fragCount > 255) {
            throw new IllegalArgumentException("Payload too large for binary fragmentation");
        }
        if (fragCount == 0) {
            fragCount = 1;
        }

        List<BinaryFragment> fragments = new ArrayList<>(fragCount);
        for (int i = 0; i < fragCount; i++) {
            int offset = i * MAX_BINARY_FRAGMENT_PAYLOAD;
            int len = Math.min(MAX_BINARY_FRAGMENT_PAYLOAD, payload.length - offset);
            byte[] fragPayload = Arrays.copyOfRange(payload, offset, offset + len);

            byte flags = 0;
            if (i == 0) {
                flags |= BleWireProtocol.BLE_WIRE_FLAG_FIRST_FRAG;
            }
            if (i == fragCount - 1) {
                flags |= BleWireProtocol.BLE_WIRE_FLAG_LAST_FRAG;
            }
            if (wakeup && i == 0) {
                flags |= BleWireProtocol.BLE_WIRE_FLAG_WAKE;
            }
            if (ackRequested && i == fragCount - 1) {
                flags |= BleWireProtocol.BLE_WIRE_FLAG_ACK_REQUESTED;
            }

            fragments.add(new BinaryFragment(flags, msgId, i, fragCount, fragPayload));
        }

        Log.d(TAG, "Created " + fragments.size() + " binary fragments for "
                + payload.length + " byte payload");
        return fragments;
    }

    public static boolean allBinaryFragmentsFit(List<BinaryFragment> fragments) {
        for (BinaryFragment fragment : fragments) {
            byte[] packed = K900ProtocolUtils.packBinaryFragment(
                    fragment.flags,
                    fragment.msgId,
                    fragment.fragIdx,
                    fragment.fragCount,
                    fragment.payload);
            if (packed == null || packed.length > MAX_BINARY_FRAME_SIZE) {
                return false;
            }
        }
        return true;
    }

    /**
     * Container for binary wire fragment metadata
     */
    public static class BinaryFragment {
        public final byte flags;
        public final int msgId;
        public final int fragIdx;
        public final int fragCount;
        public final byte[] payload;

        public BinaryFragment(byte flags, int msgId, int fragIdx, int fragCount, byte[] payload) {
            this.flags = flags;
            this.msgId = msgId;
            this.fragIdx = fragIdx;
            this.fragCount = fragCount;
            this.payload = payload;
        }
    }

    /**
     * Container for chunk information
     */
    public static class ChunkInfo {
        public final String chunkId;
        public final int chunkIndex;
        public final int totalChunks;
        public final String data;
        public final long messageId;

        public ChunkInfo(String chunkId, int chunkIndex, int totalChunks, String data, long messageId) {
            this.chunkId = chunkId;
            this.chunkIndex = chunkIndex;
            this.totalChunks = totalChunks;
            this.data = data;
            this.messageId = messageId;
        }

        public boolean isFinalChunk() {
            return chunkIndex == totalChunks - 1;
        }
    }
}
