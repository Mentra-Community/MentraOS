package com.mentra.asg_client.utils.smartglasses;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Splits large JSON messages into compact chunks that fit through the K900/BES BLE path.
 *
 * This mirrors the phone-to-glasses chunk envelope:
 * t="ck", id=session id, c=chunk index, n=total chunks, d=raw JSON slice.
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    private static final int MESSAGE_SIZE_THRESHOLD = 200;
    private static final int CHUNK_DATA_SIZE = 80;

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

    public static List<JSONObject> createChunks(String originalJson, long messageId) throws JSONException {
        if (originalJson == null) {
            throw new IllegalArgumentException("Cannot chunk null message");
        }

        List<JSONObject> chunks = new ArrayList<>();
        byte[] messageBytes = originalJson.getBytes(StandardCharsets.UTF_8);
        int totalBytes = messageBytes.length;
        String chunkId = messageId + "_" + System.currentTimeMillis();
        int totalChunks = (int) Math.ceil((double) totalBytes / CHUNK_DATA_SIZE);

        Log.d(TAG, "Creating " + totalChunks + " chunks for message of size " + totalBytes + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            int startIndex = i * CHUNK_DATA_SIZE;
            int endIndex = Math.min(startIndex + CHUNK_DATA_SIZE, totalBytes);
            int chunkLength = endIndex - startIndex;
            String chunkData = new String(messageBytes, startIndex, chunkLength, StandardCharsets.UTF_8);

            JSONObject chunk = new JSONObject();
            chunk.put("t", "ck");
            chunk.put("id", chunkId);
            chunk.put("c", i);
            chunk.put("n", totalChunks);
            chunk.put("d", chunkData);

            if (i == totalChunks - 1 && messageId != -1) {
                chunk.put("mId", messageId);
            }

            chunks.add(chunk);
            Log.d(TAG, "Created chunk " + i + "/" + (totalChunks - 1) + " with " + chunkLength + " bytes");
        }

        return chunks;
    }
}
