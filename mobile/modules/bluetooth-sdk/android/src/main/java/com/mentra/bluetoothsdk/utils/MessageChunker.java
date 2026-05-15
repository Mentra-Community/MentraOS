package com.mentra.core.utils;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
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
 * 253-byte BLE write limit. With compact keys, 80 bytes of raw data produces
 * a final packed size of ~245 bytes worst-case (with heavy JSON escaping).
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    // Threshold: if C-wrapped message exceeds this, chunking is triggered.
    // BES2700 limit is 253 bytes; anything over ~200 bytes packed needs chunking.
    private static final int MESSAGE_SIZE_THRESHOLD = 200;

    // Maximum raw bytes per chunk. After double JSON escaping + compact envelope
    // + C-wrapper + K900 framing, 80 bytes stays under the 253-byte BLE limit.
    private static final int CHUNK_DATA_SIZE = 80;

    /**
     * Check if a message needs to be chunked
     * @param message The complete message string (already C-wrapped)
     * @return true if message exceeds threshold and needs chunking
     */
    public static boolean needsChunking(String message) {
        if (message == null) {
            return false;
        }

        int messageBytes = message.getBytes().length;
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
        if (originalJson == null) {
            throw new IllegalArgumentException("Cannot chunk null message");
        }

        List<JSONObject> chunks = new ArrayList<>();
        byte[] messageBytes = originalJson.getBytes();
        int totalBytes = messageBytes.length;

        // Compact chunk session ID: messageId_timestamp (no "chunk_" prefix)
        String chunkId = messageId + "_" + System.currentTimeMillis();

        // Calculate total chunks needed
        int totalChunks = (int) Math.ceil((double) totalBytes / CHUNK_DATA_SIZE);

        Log.d(TAG, "Creating " + totalChunks + " chunks for message of size " + totalBytes + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            int startIndex = i * CHUNK_DATA_SIZE;
            int endIndex = Math.min(startIndex + CHUNK_DATA_SIZE, totalBytes);
            int chunkLength = endIndex - startIndex;

            // Extract chunk data as string
            String chunkData = new String(messageBytes, startIndex, chunkLength);

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

            Log.d(TAG, "Created chunk " + i + "/" + (totalChunks - 1) + " with " + chunkLength + " bytes");
        }

        return chunks;
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
