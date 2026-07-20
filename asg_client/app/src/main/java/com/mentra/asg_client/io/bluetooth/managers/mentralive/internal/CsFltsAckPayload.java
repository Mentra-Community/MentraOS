package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * Parses BES {@code cs_flts} file-transfer ACK JSON payloads used on the UART hot path.
 *
 * <p>Package-visible so unit tests can cover the JSON-parse branches without constructing a full
 * {@code K900BluetoothManager}.
 */
public final class CsFltsAckPayload {
    public enum Kind {
        /** Payload is not a cs_flts command (caller should continue normal routing). */
        NOT_CS_FLTS,
        /** Recognized as cs_flts but missing/invalid body fields (consume; do not ack). */
        MALFORMED,
        /** Valid cs_flts ACK with state and index. */
        ACK
    }

    public final Kind kind;
    public final int state;
    public final int index;

    private CsFltsAckPayload(Kind kind, int state, int index) {
        this.kind = kind;
        this.state = state;
        this.index = index;
    }

    public static CsFltsAckPayload notCsFlts() {
        return new CsFltsAckPayload(Kind.NOT_CS_FLTS, -1, -1);
    }

    public static CsFltsAckPayload malformed() {
        return new CsFltsAckPayload(Kind.MALFORMED, -1, -1);
    }

    public static CsFltsAckPayload ack(int state, int index) {
        return new CsFltsAckPayload(Kind.ACK, state, index);
    }

    /**
     * Probe and parse a UART payload for a {@code cs_flts} ACK.
     *
     * @param payload raw K900/BES payload bytes (may be null)
     * @return parse result; never null
     */
    public static CsFltsAckPayload parse(byte[] payload) {
        if (payload == null || payload.length < 20) {
            return notCsFlts();
        }
        // Cheap reject before JSON parse — hot path during photo/file TX.
        String probe = new String(payload, 0, Math.min(payload.length, 64), StandardCharsets.UTF_8);
        if (!probe.contains("cs_flts")) {
            return notCsFlts();
        }
        JSONObject json;
        try {
            json = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            // Can't confirm this is even a cs_flts message — fall back to normal routing.
            return notCsFlts();
        }
        if (!"cs_flts".equals(json.optString("C", ""))) {
            return notCsFlts();
        }
        // "C":"cs_flts" is confirmed — any failure past this point is a malformed cs_flts ACK.
        // Consume it (return MALFORMED) rather than NOT_CS_FLTS, which would skip the fast path
        // and re-route the payload through CommandProcessor/BleTrace.
        try {
            JSONObject body = json.optJSONObject("B");
            if (body == null) {
                String bodyString = json.optString("B", "");
                body = bodyString.isEmpty() ? null : new JSONObject(bodyString);
            }
            if (body == null) {
                return malformed();
            }
            int state = body.optInt("state", -1);
            int index = body.optInt("index", -1);
            if (state >= 0 && index >= 0) {
                return ack(state, index);
            }
            return malformed();
        } catch (Exception e) {
            return malformed();
        }
    }
}
