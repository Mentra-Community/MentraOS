package com.mentra.core.utils;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Handles chunking of large messages that exceed BLE transmission limits.
 * Messages are split at the JSON layer to work within MCU protocol constraints.
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    // Threshold for chunking - accounts for MCU protocol overhead
    // MTU ~512 - BLE overhead (3) - MCU protocol (7) - C-wrapper (~50) - safety margin
    private static final int MESSAGE_SIZE_THRESHOLD = 400;

    // Maximum size for chunk data content
    // Account for chunk wrapper overhead (~100 bytes for type, chunkId, indices)
    private static final int CHUNK_DATA_SIZE = 300;

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
     * Create chunks from a message that's too large for single transmission
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

        // Generate unique chunk ID for this message set
        String chunkId = "chunk_" + messageId + "_" + System.currentTimeMillis();

        // Calculate total chunks needed
        int totalChunks = (int) Math.ceil((double) totalBytes / CHUNK_DATA_SIZE);

        Log.d(TAG, "Creating " + totalChunks + " chunks for message of size " + totalBytes + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            int startIndex = i * CHUNK_DATA_SIZE;
            int endIndex = Math.min(startIndex + CHUNK_DATA_SIZE, totalBytes);
            int chunkLength = endIndex - startIndex;

            // Extract chunk data as string
            String chunkData = new String(messageBytes, startIndex, chunkLength);

            // Create chunk JSON
            JSONObject chunk = new JSONObject();
            chunk.put("type", "chunked_msg");
            chunk.put("chunkId", chunkId);
            chunk.put("chunk", i);
            chunk.put("total", totalChunks);
            chunk.put("data", chunkData);

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
     * Check if a received message is a chunked message
     * @param json The received JSON object (after C-unwrapping)
     * @return true if this is a chunked message
     */
    public static boolean isChunkedMessage(JSONObject json) {
        if (json == null) {
            return false;
        }

        String type = json.optString("type", "");
        return "chunked_msg".equals(type);
    }

    /**
     * Extract chunk information from a chunked message
     */
    public static ChunkInfo getChunkInfo(JSONObject json) throws JSONException {
        if (!isChunkedMessage(json)) {
            return null;
        }

        String chunkId = json.getString("chunkId");
        int chunkIndex = json.getInt("chunk");
        int totalChunks = json.getInt("total");
        String data = json.getString("data");
        long messageId = json.optLong("mId", -1);

        return new ChunkInfo(chunkId, chunkIndex, totalChunks, data, messageId);
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
