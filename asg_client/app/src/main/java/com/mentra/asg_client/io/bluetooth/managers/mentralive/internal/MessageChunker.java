package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Splits large JSON messages into compact chunks that fit through the K900/BES BLE path.
 *
 * <p>v1: JSON chunk envelope (t="ck"). v2: binary fragments ({@link
 * BesWireFormat#CMD_TYPE_BINARY_MSG}).
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    private static final int MESSAGE_SIZE_THRESHOLD_V1 = 200;
    private static final int INITIAL_CHUNK_DATA_SIZE = 80;
    private static final int MIN_CHUNK_DATA_SIZE = 4;

    /** Local ceiling for every complete K900 control frame, regardless of wire version. */
    public static final int MAX_PACKED_CHUNK_SIZE =
            AsgConstants.K900_CONTROL_MAX_PACKED_FRAME_BYTES;

    private static final int BINARY_FRAME_OVERHEAD =
            BesWireFormat.LENGTH_CMD_MIN_SIZE + BesWireFormat.BINARY_HEADER_SIZE;

    private static final AtomicLong CHUNK_SEQUENCE = new AtomicLong();

    /** Current maximum size of a complete packed frame for both v1 and v2. */
    public static int maxPackedFrameSize() {
        return MAX_PACKED_CHUNK_SIZE;
    }

    /** Current maximum packed frame size for a v1 STRING ck chunk. */
    public static int maxPackedStringChunkSize() {
        return maxPackedFrameSize();
    }

    /** Current maximum v2 message payload after the 14-byte K900 binary framing overhead. */
    public static int maxBinaryFragmentPayload() {
        return Math.max(0, maxPackedFrameSize() - BINARY_FRAME_OVERHEAD);
    }

    public static boolean needsChunking(String message) {
        if (message == null) {
            return false;
        }

        int messageBytes = message.getBytes(StandardCharsets.UTF_8).length;
        int threshold = MESSAGE_SIZE_THRESHOLD_V1;
        if (BesWireFormat.isBinaryProtocolActive()) {
            try {
                messageBytes = BesWireFormat.buildOutboundPayloadBytes(message).length;
            } catch (JSONException e) {
                return true;
            }
            threshold = maxBinaryFragmentPayload();
        }
        boolean needsChunking = messageBytes > threshold;
        if (needsChunking) {
            Log.d(
                    TAG,
                    "Message size "
                            + messageBytes
                            + " exceeds threshold "
                            + threshold
                            + ", will chunk");
        }
        return needsChunking;
    }

    public static List<JSONObject> createChunks(String originalJson, long messageId)
            throws JSONException {
        if (originalJson == null) {
            throw new IllegalArgumentException("Cannot chunk null message");
        }

        byte[] messageBytes = originalJson.getBytes(StandardCharsets.UTF_8);
        int totalBytes = messageBytes.length;
        String chunkId =
                messageId
                        + "_"
                        + System.currentTimeMillis()
                        + "_"
                        + CHUNK_SEQUENCE.incrementAndGet();

        for (int chunkSize = INITIAL_CHUNK_DATA_SIZE;
                chunkSize >= MIN_CHUNK_DATA_SIZE;
                chunkSize--) {
            List<JSONObject> chunks = buildChunks(messageBytes, chunkId, messageId, chunkSize);
            if (allChunksFit(chunks)) {
                Log.d(
                        TAG,
                        "Creating "
                                + chunks.size()
                                + " chunks for message of size "
                                + totalBytes
                                + " bytes using "
                                + chunkSize
                                + "-byte UTF-8 slices");
                return chunks;
            }
        }

        throw new JSONException(
                "Unable to create K900 chunks within " + maxPackedStringChunkSize() + " bytes");
    }

    /**
     * Split a JSON message into v2 binary wire frames.
     *
     * @param originalJson Raw JSON to send (C/V/B wrapper applied per Phase 3 rules)
     * @param msgId 16-bit message id shared across fragments
     */
    public static List<byte[]> createBinaryFragments(String originalJson, int msgId)
            throws JSONException {
        if (originalJson == null) {
            throw new IllegalArgumentException("Cannot chunk null message");
        }

        byte[] messageBytes = BesWireFormat.buildOutboundPayloadBytes(originalJson);
        int payloadBudget = maxBinaryFragmentPayload();
        if (payloadBudget <= 0) {
            throw new JSONException(
                    "notify_cap leaves no room for the "
                            + BINARY_FRAME_OVERHEAD
                            + "-byte binary frame overhead");
        }
        List<byte[]> payloadChunks = splitUtf8Bytes(messageBytes, payloadBudget);
        int totalFragments = payloadChunks.size();
        List<byte[]> frames = new ArrayList<>(totalFragments);

        for (int i = 0; i < totalFragments; i++) {
            byte flags = 0;
            if (i == 0) {
                flags |= BesWireFormat.FLAG_FIRST_FRAG;
            }
            if (i == totalFragments - 1) {
                flags |= BesWireFormat.FLAG_LAST_FRAG;
            }
            byte[] frame =
                    BesWireFormat.packBinaryFragment(
                            flags, msgId, i, totalFragments, payloadChunks.get(i));
            int frameBudget = maxPackedFrameSize();
            if (frame == null || frame.length > frameBudget) {
                throw new JSONException(
                        "Binary fragment "
                                + i
                                + " exceeds "
                                + frameBudget
                                + " bytes ("
                                + (frame != null ? frame.length : 0)
                                + ")");
            }
            frames.add(frame);
        }

        Log.d(
                TAG,
                "Created "
                        + frames.size()
                        + " binary fragments for "
                        + messageBytes.length
                        + " payload bytes (msgId="
                        + msgId
                        + ")");
        return frames;
    }

    private static List<JSONObject> buildChunks(
            byte[] messageBytes, String chunkId, long messageId, int chunkSize)
            throws JSONException {
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
        int budget = maxPackedStringChunkSize();
        for (int i = 0; i < chunks.size(); i++) {
            byte[] packed = BesWireFormat.formatMessageForTransmission(chunks.get(i).toString());
            if (packed == null || packed.length > budget) {
                Log.d(
                        TAG,
                        "Chunk "
                                + i
                                + " packed to "
                                + (packed != null ? packed.length : 0)
                                + " bytes, exceeding "
                                + budget);
                return false;
            }
        }
        return true;
    }

    private static List<byte[]> splitUtf8Bytes(byte[] messageBytes, int chunkSize) {
        List<byte[]> chunkDataList = new ArrayList<>();
        int offset = 0;
        while (offset < messageBytes.length) {
            int endIndex = findUtf8ChunkEnd(messageBytes, offset, chunkSize);
            byte[] slice = new byte[endIndex - offset];
            System.arraycopy(messageBytes, offset, slice, 0, slice.length);
            chunkDataList.add(slice);
            offset = endIndex;
        }
        return chunkDataList;
    }

    private static List<String> splitUtf8(byte[] messageBytes, int chunkSize) {
        List<String> chunkDataList = new ArrayList<>();
        int offset = 0;
        while (offset < messageBytes.length) {
            int endIndex = findUtf8ChunkEnd(messageBytes, offset, chunkSize);
            chunkDataList.add(
                    new String(messageBytes, offset, endIndex - offset, StandardCharsets.UTF_8));
            offset = endIndex;
        }
        return chunkDataList;
    }

    private static int findUtf8ChunkEnd(byte[] messageBytes, int startIndex, int chunkSize) {
        int endIndex = Math.min(startIndex + chunkSize, messageBytes.length);
        while (endIndex > startIndex
                && endIndex < messageBytes.length
                && isUtf8ContinuationByte(messageBytes[endIndex])) {
            endIndex--;
        }
        return endIndex > startIndex
                ? endIndex
                : Math.min(startIndex + chunkSize, messageBytes.length);
    }

    private static boolean isUtf8ContinuationByte(byte value) {
        return (value & 0xC0) == 0x80;
    }
}
