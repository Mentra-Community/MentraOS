package com.mentra.asg_client.utils.smartglasses;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Splits large JSON messages into compact chunks that fit through the K900/BES BLE path.
 *
 * This mirrors the phone-to-glasses chunk envelope:
 * t="ck", id=session id, c=chunk index, n=total chunks, d=raw JSON slice.
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    private static final int MESSAGE_SIZE_THRESHOLD = 200;
    private static final int INITIAL_CHUNK_DATA_SIZE = 80;
    private static final int MIN_CHUNK_DATA_SIZE = 4;
    private static final int MAX_PACKED_CHUNK_SIZE = 253;
    private static final AtomicLong CHUNK_SEQUENCE = new AtomicLong();

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

        byte[] messageBytes = originalJson.getBytes(StandardCharsets.UTF_8);
        int totalBytes = messageBytes.length;
        String chunkId = messageId + "_" + System.currentTimeMillis() + "_" + CHUNK_SEQUENCE.incrementAndGet();

        for (int chunkSize = INITIAL_CHUNK_DATA_SIZE; chunkSize >= MIN_CHUNK_DATA_SIZE; chunkSize--) {
            List<JSONObject> chunks = buildChunks(messageBytes, chunkId, messageId, chunkSize);
            if (allChunksFit(chunks)) {
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
        }

        return chunks;
    }

    private static boolean allChunksFit(List<JSONObject> chunks) {
        for (int i = 0; i < chunks.size(); i++) {
            byte[] packed = K900ProtocolUtils.formatMessageForTransmission(chunks.get(i).toString());
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
}
