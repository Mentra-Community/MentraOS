package com.mentra.asg_client.audio.diag;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * One scheduled harness operation. An operation runs once, {@link #delayMs} after its anchor event
 * {@code <producer>.<event>} is observed, where the producer is {@code trial} or another operation
 * ID in the same trial. Delays are never negative: to place A before B, anchor B on an event of A.
 */
public final class ReproOp {

    public enum Type {
        /** Production primary cue via {@code IHardwareManager.playAudioAssetTracked}. */
        CUE("cue"),
        CAPTURE_START("capture_start"),
        CAPTURE_STOP("capture_stop"),
        /** Waits for a verified state and then emits {@code <id>.satisfied}. */
        WAIT_STATE("wait_state"),
        /** Pulls the BES runtime trace once over UART ({@code mh_logs}). */
        BES_LOG_PULL("bes_log_pull"),
        MARK("mark"),
        END("end"),
        /** Production stop of all cue playback; allowed only as cleanup. */
        STOP_PLAYBACK("stop_playback");

        public final String wireName;

        Type(String wireName) {
            this.wireName = wireName;
        }

        public static Type fromWire(String name) {
            for (Type type : values()) {
                if (type.wireName.equals(name)) return type;
            }
            throw new IllegalArgumentException("unknown op type: " + name);
        }
    }

    public static final String TRIAL_PRODUCER = "trial";
    public static final String TRIAL_START = "trial.start";

    public final String id;
    public final Type type;
    /** {@code <producer>.<event>}; empty for cleanup operations, which run immediately. */
    public final String anchor;
    public final long delayMs;
    /** Anchor wait bound in milliseconds, or 0 for the sequence default. */
    public final long timeoutMs;
    public final Map<String, Object> params;

    public ReproOp(
            String id,
            Type type,
            String anchor,
            long delayMs,
            long timeoutMs,
            Map<String, Object> params) {
        this.id = id;
        this.type = type;
        this.anchor = anchor == null ? "" : anchor;
        this.delayMs = delayMs;
        this.timeoutMs = timeoutMs;
        this.params =
                params == null
                        ? Collections.emptyMap()
                        : Collections.unmodifiableMap(new LinkedHashMap<>(params));
    }

    /** The operation (or {@code trial}) whose event anchors this one. */
    public String anchorProducer() {
        int dot = anchor.indexOf('.');
        return dot <= 0 ? "" : anchor.substring(0, dot);
    }

    public String anchorEvent() {
        int dot = anchor.indexOf('.');
        return dot <= 0 ? "" : anchor.substring(dot + 1);
    }

    public String stringParam(String key, String fallback) {
        Object value = params.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    public long longParam(String key, long fallback) {
        Object value = params.get(key);
        if (value instanceof Number) return ((Number) value).longValue();
        if (value instanceof String) {
            try {
                return Long.parseLong((String) value);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    public boolean booleanParam(String key, boolean fallback) {
        Object value = params.get(key);
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return Boolean.parseBoolean((String) value);
        return fallback;
    }

    @Override
    public String toString() {
        return String.format(
                Locale.US, "%s(%s @%s+%dms)", id, type.wireName, anchor, delayMs);
    }
}
