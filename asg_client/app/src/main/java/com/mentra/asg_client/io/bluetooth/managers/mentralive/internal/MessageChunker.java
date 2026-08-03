package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Splits large JSON messages into compact chunks that fit through the K900/BES BLE path.
 *
 * <p>v1: JSON chunk envelope (t="ck"). v2: binary fragments ({@link BesWireFormat#CMD_TYPE_BINARY_MSG}).
 */
public class MessageChunker {
    private static final String TAG = "MessageChunker";

    private static final int MESSAGE_SIZE_THRESHOLD_V1 = 200;
    private static final int INITIAL_CHUNK_DATA_SIZE = 80;
    private static final int MIN_CHUNK_DATA_SIZE = 4;
    /** Budget for v2 binary fragments — these are reassembled phone-side, so MTU_TARGET holds. */
    public static final int MAX_PACKED_CHUNK_SIZE = BesWireFormat.MAX_PACKED_FRAME_SIZE;

    /**
     * Budget for v1 STRING ck chunks. Unlike binary fragments, a v1 string frame must survive
     * the phone leg as ONE BLE notification (the BES relays it unfragmented and the phone parses
     * per-notification) — so the real ceiling is the notification payload cap, not MTU_TARGET.
     * Defaults to the conservative worst-case budget
     * ({@link AsgConstants#K900_STRING_CHUNK_MAX_FRAME_BYTES}); BES firmware >= 17.26.7.23
     * advertises the true cap via {@code wire_caps.notify_cap} and
     * {@link #setStringChunkBudgetFromNotifyCap(int)} raises the budget accordingly.
     */
    private static final java.util.concurrent.atomic.AtomicInteger STRING_CHUNK_BUDGET =
            new java.util.concurrent.atomic.AtomicInteger(
                    AsgConstants.K900_STRING_CHUNK_MAX_FRAME_BYTES);

    private static final AtomicLong CHUNK_SEQUENCE = new AtomicLong();

    /** Current maximum packed frame size for a v1 STRING ck chunk. */
    public static int maxPackedStringChunkSize() {
        return STRING_CHUNK_BUDGET.get();
    }

    /**
     * Adopt the BES-measured notification cap ({@code wire_caps.notify_cap}) as the v1 string
     * chunk ceiling, keeping the same re-framing safety margin the 240-byte fallback encodes
     * (240 = 253 - {@link AsgConstants#K900_STRING_CHUNK_BUDGET_MARGIN_BYTES}). The advertised
     * value is validated against the firmware contract range [253, 509] rather than trusted
     * blindly: below the floor it is malformed and ignored (the budget must never shrink below
     * the hardware-validated fallback), above the ceiling it is clamped down (an oversized
     * advertisement would size chunks beyond what the transport carries — the exact silent
     * truncation class this budget exists to prevent).
     */
    public static void setStringChunkBudgetFromNotifyCap(int notifyCap) {
        if (notifyCap < AsgConstants.K900_BLE_NOTIFY_CAP_FLOOR_BYTES) {
            Log.w(
                    TAG,
                    "Ignoring notify_cap="
                            + notifyCap
                            + " below the contract floor "
                            + AsgConstants.K900_BLE_NOTIFY_CAP_FLOOR_BYTES);
            return;
        }
        int accepted = notifyCap;
        if (accepted > AsgConstants.K900_BLE_NOTIFY_CAP_CEILING_BYTES) {
            Log.w(
                    TAG,
                    "Clamping notify_cap="
                            + notifyCap
                            + " to the contract ceiling "
                            + AsgConstants.K900_BLE_NOTIFY_CAP_CEILING_BYTES);
            accepted = AsgConstants.K900_BLE_NOTIFY_CAP_CEILING_BYTES;
        }
        STRING_CHUNK_BUDGET.set(
                accepted - AsgConstants.K900_STRING_CHUNK_BUDGET_MARGIN_BYTES);
    }

    /** Restore the conservative fallback budget (the negotiated cap died with the caps). */
    public static void resetStringChunkBudget() {
        STRING_CHUNK_BUDGET.set(AsgConstants.K900_STRING_CHUNK_MAX_FRAME_BYTES);
    }

    /**
     * Couple the string chunk budget to the link state machine's negotiated caps lifecycle: on
     * every observable transition the budget is re-derived from the current caps snapshot —
     * notify_cap advertised means the negotiated budget, caps cleared means the fallback. Tying
     * the budget to the machine (rather than to one serial callback) guarantees it can never go
     * stale on ANY path that clears the caps: {@code onSerialClose}, a failed
     * {@code onSerialOpen}, and reopen failures all drive the machine's serialClosed transition
     * directly, and a subsequent reconnect to firmware that omits notify_cap must not inherit a
     * previous session's larger budget (that would reintroduce silent notification truncation).
     * Replay-on-subscribe applies the current caps immediately. Call once per machine.
     */
    public static void followLinkState(LinkStateMachine linkState) {
        linkState.addListener(
                (state, provenCaps, phonePresence) -> {
                    int notifyCap = linkState.getNegotiatedCaps().notifyCap;
                    if (notifyCap > 0) {
                        setStringChunkBudgetFromNotifyCap(notifyCap);
                    } else {
                        resetStringChunkBudget();
                    }
                });
    }

    public static boolean needsChunking(String message) {
        if (message == null) {
            return false;
        }

        int messageBytes = message.getBytes(StandardCharsets.UTF_8).length;
        int threshold =
                BesWireFormat.isBinaryProtocolActive()
                        ? BesWireFormat.MAX_FRAGMENT_PAYLOAD
                        : MESSAGE_SIZE_THRESHOLD_V1;
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
        List<byte[]> payloadChunks = splitUtf8Bytes(messageBytes, BesWireFormat.MAX_FRAGMENT_PAYLOAD);
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
            if (frame == null || frame.length > MAX_PACKED_CHUNK_SIZE) {
                throw new JSONException(
                        "Binary fragment "
                                + i
                                + " exceeds "
                                + MAX_PACKED_CHUNK_SIZE
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
