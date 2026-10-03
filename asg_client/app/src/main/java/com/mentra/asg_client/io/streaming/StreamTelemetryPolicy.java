package com.mentra.asg_client.io.streaming;

import androidx.annotation.Nullable;
import com.mentra.asg_client.AsgConstants;
import org.json.JSONObject;

/**
 * Runtime switch for the 1Hz stream telemetry ({@code [STREAM_QUALITY]} logs and BLE {@code
 * stream_status.stats}, which carries the SoC temperature).
 *
 * <p>The build default is {@link AsgConstants#ENABLE_PIPELINE_FPS_TELEMETRY}. The phone opts in
 * per stream with {@code start_stream.telemetry} (compact key {@code tl}); every {@code
 * start_stream} re-evaluates the flag, so a stream that does not ask for telemetry never inherits
 * it from a previous one.
 */
public final class StreamTelemetryPolicy {
    private static final String KEY_FULL = "telemetry";
    private static final String KEY_COMPACT = "tl";

    private static volatile boolean sEnabled = AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY;

    private StreamTelemetryPolicy() {}

    public static boolean isEnabled() {
        return sEnabled;
    }

    public static void setEnabled(boolean enabled) {
        sEnabled = enabled;
    }

    public static void resetToDefault() {
        setEnabled(AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY);
    }

    /** Reads {@code telemetry} (full key wins) or {@code tl}; absent or null payload → build default. */
    public static boolean fromStartStream(@Nullable JSONObject startStream) {
        if (startStream == null) return AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY;
        if (startStream.has(KEY_FULL)) {
            return startStream.optBoolean(KEY_FULL, AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY);
        }
        if (startStream.has(KEY_COMPACT)) {
            return startStream.optBoolean(KEY_COMPACT, AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY);
        }
        return AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY;
    }

    /** Applies the per-stream opt-in carried by a {@code start_stream} command. */
    public static void applyStartStream(@Nullable JSONObject startStream) {
        setEnabled(fromStartStream(startStream));
    }
}
