package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import com.mentra.asg_client.io.peripheral.McuEventParser;
import com.mentra.asg_client.io.peripheral.events.FileTransferAckEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import java.nio.charset.StandardCharsets;
import java.util.function.BiConsumer;
import org.json.JSONObject;

/**
 * Mentra-owned file-transfer ACK dispatch helpers.
 *
 * <p>The historical early path in {@code K900BluetoothManager.processReceivedMessage} checked for
 * {@code CMD_TYPE_PHOTO} at {@code message[0]}, but BesMessageParser frames always start with
 * {@code ##} ({@code 0x23}), so every ACK fell through the full JSON command pipeline. This class
 * is the corrected fast path and the slow-path mirror used by CI microbenchmarks.
 */
public final class FileTransferAckDispatch {
    private static final byte[] CS_FLTS_NEEDLE = "cs_flts".getBytes(StandardCharsets.US_ASCII);

    private FileTransferAckDispatch() {}

    /** Parsed {@code cs_flts} acknowledgment. */
    public static final class Ack {
        public final int state;
        public final int index;

        public Ack(int state, int index) {
            this.state = state;
            this.index = index;
        }
    }

    /** True if {@code payload} ASCII-contains {@code cs_flts} (cheap reject before JSON parse). */
    public static boolean looksLikeCsFlts(byte[] payload) {
        return indexOf(payload, CS_FLTS_NEEDLE) >= 0;
    }

    /**
     * Parse a K900 JSON payload as a file-transfer ACK.
     *
     * @return parsed ack, or null if this is not {@code cs_flts}
     */
    public static Ack tryParseCsFlts(byte[] payload) {
        if (payload == null || payload.length == 0 || !looksLikeCsFlts(payload)) {
            return null;
        }
        try {
            JSONObject json = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            if (!"cs_flts".equals(json.optString("C", ""))) {
                return null;
            }
            JSONObject body = json.optJSONObject("B");
            if (body == null) {
                return null;
            }
            int state = body.optInt("state", -1);
            int index = body.optInt("index", -1);
            if (state < 0 || index < 0) {
                return null;
            }
            return new Ack(state, index);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Fast path: parse {@code cs_flts} and invoke {@code handler(state, index)}.
     *
     * @return true if the payload was a file ACK and was dispatched
     */
    public static boolean dispatchFast(byte[] payload, BiConsumer<Integer, Integer> handler) {
        Ack ack = tryParseCsFlts(payload);
        if (ack == null) {
            return false;
        }
        handler.accept(ack.state, ack.index);
        return true;
    }

    /**
     * Fast path used by {@code K900BluetoothManager} during an active transfer. Returns false when
     * no transfer is active so the caller can fall through to the normal command pipeline.
     *
     * @return true if the payload was consumed as a file ACK
     */
    public static boolean tryDispatchDuringTransfer(
            boolean transferActive, byte[] payload, BiConsumer<Integer, Integer> handler) {
        if (!transferActive) {
            return false;
        }
        return dispatchFast(payload, handler);
    }

    /**
     * Slow path mirror of today's production pipeline cost: JSON parse → {@link McuEventParser} →
     * typed event → handler. Used by CI microbenchmarks to prove the fast path stays cheaper.
     *
     * @return true if the payload was a file ACK and was dispatched
     */
    public static boolean dispatchSlow(byte[] payload, BiConsumer<Integer, Integer> handler) {
        if (payload == null || payload.length == 0) {
            return false;
        }
        try {
            JSONObject json = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            McuEvent event = McuEventParser.parse(json);
            if (!(event instanceof FileTransferAckEvent)) {
                return false;
            }
            FileTransferAckEvent ack = (FileTransferAckEvent) event;
            handler.accept(ack.getState(), ack.getIndex());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static int indexOf(byte[] haystack, byte[] needle) {
        if (haystack == null || needle == null || needle.length == 0) {
            return -1;
        }
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
