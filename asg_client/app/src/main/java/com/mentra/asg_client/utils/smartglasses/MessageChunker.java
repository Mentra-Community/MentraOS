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

        List<String> chunkDataList = splitUtf8(messageBytes);
        int totalChunks = chunkDataList.size();

        Log.d(TAG, "Creating " + totalChunks + " chunks for message of size " + totalBytes + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            String chunkData = chunkDataList.get(i);

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
            Log.d(TAG, "Created chunk " + i + "/" + (totalChunks - 1) + " with " + chunkData.getBytes(StandardCharsets.UTF_8).length + " bytes");
        }

        return chunks;
    }

    private static List<String> splitUtf8(byte[] messageBytes) {
        List<String> chunkDataList = new ArrayList<>();
        int offset = 0;
        while (offset < messageBytes.length) {
            int endIndex = findUtf8ChunkEnd(messageBytes, offset);
            chunkDataList.add(new String(messageBytes, offset, endIndex - offset, StandardCharsets.UTF_8));
            offset = endIndex;
        }
        return chunkDataList;
    }

    private static int findUtf8ChunkEnd(byte[] messageBytes, int startIndex) {
        int endIndex = Math.min(startIndex + CHUNK_DATA_SIZE, messageBytes.length);
        while (endIndex > startIndex && endIndex < messageBytes.length && isUtf8ContinuationByte(messageBytes[endIndex])) {
            endIndex--;
        }
        return endIndex > startIndex ? endIndex : Math.min(startIndex + CHUNK_DATA_SIZE, messageBytes.length);
    }

    private static boolean isUtf8ContinuationByte(byte value) {
        return (value & 0xC0) == 0x80;
    }
}
