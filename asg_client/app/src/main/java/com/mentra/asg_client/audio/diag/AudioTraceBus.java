package com.mentra.asg_client.audio.diag;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Optional observation hook on the production cue and I2S bridge path.
 *
 * <p>With no sink registered, {@link #emit} is one volatile read, so production cue timing and
 * behavior are unchanged. The audio reproduction harness registers a sink only while a gated run
 * is active. Every event is timestamped with {@link System#nanoTime()} (CLOCK_MONOTONIC, the same
 * clock as {@code logcat -v monotonic}) on the thread that emits it, before any hand-off.
 */
public final class AudioTraceBus {

    /** A primary cue entered the production play path; carries {@code token}. */
    public static final String PLAYER_REQUEST = "player_request";
    /** A new BES bridge START was requested; carries {@code token} and {@code request_id}. */
    public static final String BRIDGE_OPEN_REQ = "bridge_open_req";
    /** The START could not be delivered; carries {@code token} and {@code request_id}. */
    public static final String BRIDGE_OPEN_FAILED = "bridge_open_failed";
    /**
     * An existing bridge was reused without a new START; carries {@code token}, {@code reason}
     * ({@link #REUSE_READY}, {@link #REUSE_PENDING}, or {@link #REUSE_EXTERNAL}) and
     * {@code request_id} (0 when external audio owns the path).
     */
    public static final String BRIDGE_REUSED = "bridge_reused";
    /** {@code mh_starti2s}/{@code mh_stopi2s} was handed to the UART transport. */
    public static final String UART_I2S_CMD = "uart_i2s_cmd";
    /** {@code hm_i2sready} arrived on the UART reader thread. */
    public static final String I2S_READY_RX = "i2s_ready_rx";
    /** A readiness request was registered before START was sent. */
    public static final String I2S_READY_BEGIN = "i2s_ready_begin";
    /** A readiness request completed (reply, timeout, legacy delay, or link loss). */
    public static final String I2S_READY = "i2s_ready";
    /** The readiness timeout fired; carries {@code legacy}. */
    public static final String I2S_READY_TIMEOUT = "i2s_ready_timeout";
    /** The primary player actually started after bridge readiness; carries {@code token}. */
    public static final String PLAYER_START = "player_start";
    /**
     * The primary player ended; carries {@code token} and {@code reason} ({@code complete},
     * {@code error}, {@code cancelled}, {@code stopped}, or {@code failed}).
     */
    public static final String PLAYER_END = "player_end";
    /** The idle close grace began; carries {@code request_id}. */
    public static final String GRACE_BEGIN = "grace_begin";
    /** A pending idle close was cancelled by new playback; carries {@code request_id}. */
    public static final String GRACE_CANCEL = "grace_cancel";
    /** The bridge was released; carries {@code request_id} and {@code stop_sent}. */
    public static final String BRIDGE_CLOSE = "bridge_close";
    /** Another audio owner stopped the bridge or the UART link was lost. */
    public static final String BRIDGE_INVALIDATED = "bridge_invalidated";

    public static final String REUSE_READY = "ready";
    public static final String REUSE_PENDING = "pending";
    public static final String REUSE_EXTERNAL = "external";

    /** Receives trace events on the emitting thread; implementations must not block. */
    public interface Sink {
        void onTrace(String event, long monoNs, String threadName, Map<String, Object> fields);
    }

    private static volatile Sink sSink;

    private AudioTraceBus() {}

    public static synchronized void setSink(Sink sink) {
        sSink = sink;
    }

    /** Clear the sink only if it is still the one supplied, so a newer run is not detached. */
    public static synchronized void clearSink(Sink sink) {
        if (sSink == sink) sSink = null;
    }

    public static boolean isActive() {
        return sSink != null;
    }

    /** Emit {@code event} with alternating key/value pairs. */
    public static void emit(String event, Object... keyValues) {
        Sink sink = sSink;
        if (sink == null) return;
        long now = System.nanoTime();
        Map<String, Object> fields;
        if (keyValues.length == 0) {
            fields = Collections.emptyMap();
        } else {
            fields = new LinkedHashMap<>();
            for (int i = 0; i + 1 < keyValues.length; i += 2) {
                fields.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
            }
        }
        try {
            sink.onTrace(event, now, Thread.currentThread().getName(), fields);
        } catch (RuntimeException ignored) {
            // Observation must never break the production audio path.
        }
    }
}
