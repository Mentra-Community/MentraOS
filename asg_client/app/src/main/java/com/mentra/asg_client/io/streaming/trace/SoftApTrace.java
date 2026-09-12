package com.mentra.asg_client.io.streaming.trace;

import android.os.SystemClock;
import android.util.Log;
import java.util.Locale;

/**
 * Correlated stage logging for the SoftAP calling pipeline (glasses side).
 *
 * <p>TEMPORARY DIAGNOSTIC. Every line carries the literal {@code SOFTAP_TRACE} marker so a single
 * {@code rg -n 'SOFTAP_TRACE'} across the repo finds all of them at cleanup time. Set {@link
 * #ENABLED} to {@code false} to mute the layer for a release without deleting it.
 *
 * <p>The emitted shape mirrors the existing {@code [STREAM_STARTUP] stage=... elapsedMs=...}
 * convention used by {@code StreamCommandHandler} and {@code WhipStreamingService}, so existing log
 * tooling keeps parsing it.
 *
 * <p>{@code traceId} is minted by the phone when it starts the hotspot and arrives in the {@code
 * start_stream} payload. Both devices stamp the same id on every line, which is the only way to
 * correlate two logs whose clocks were never synchronised.
 */
public final class SoftApTrace {

    /** Master switch. Flip to false to mute the trace without removing call sites. */
    public static final boolean ENABLED = true;

    /** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
    public static final String MARKER = "SOFTAP_TRACE";

    private static final String TAG = "SoftApTrace";

    /** Keys whose values must never reach logcat. Matched case-insensitively as substrings. */
    private static final String[] SENSITIVE_KEYS = {
        "password",
        "passwd",
        "passphrase",
        "psk",
        "token",
        "secret",
        "credential",
        "authorization",
        "bearer",
        "meetingurl",
    };

    private static final String REDACTED = "<redacted>";

    private static volatile String sTraceId = "";
    private static volatile long sOriginMs = 0L;
    private static volatile String sLastStage = "";

    private SoftApTrace() {}

    /**
     * Adopt the phone-minted trace id and reset the elapsed-time origin. Called when {@code
     * start_stream} arrives.
     */
    public static void begin(String traceId) {
        sTraceId = traceId == null ? "" : traceId;
        sOriginMs = SystemClock.elapsedRealtime();
        sLastStage = "";
    }

    /** Clear trace state at the end of a stream. */
    public static void reset() {
        sTraceId = "";
        sOriginMs = 0L;
        sLastStage = "";
    }

    public static String traceId() {
        return sTraceId;
    }

    /**
     * Last stage successfully logged. Use as {@code failedStage} context when reporting an error,
     * the way {@code mLastStartupStage} already does for stream startup.
     */
    public static String lastStage() {
        return sLastStage;
    }

    /**
     * Log one pipeline stage transition.
     *
     * @param stage stable snake_case stage name, e.g. {@code ice_gathering_complete}
     * @param keyValuePairs alternating key/value pairs; an odd trailing element is ignored
     */
    public static void stage(String stage, Object... keyValuePairs) {
        if (!ENABLED) return;
        sLastStage = stage;
        long elapsedMs = sOriginMs == 0L ? 0L : SystemClock.elapsedRealtime() - sOriginMs;
        Log.i(TAG, format(sTraceId, stage, elapsedMs, keyValuePairs));
    }

    /**
     * Pure formatter. Split out from {@link #stage} so it can be unit tested without the Android
     * logging framework.
     */
    public static String format(
            String traceId, String stage, long elapsedMs, Object... keyValuePairs) {
        StringBuilder line = new StringBuilder(128);
        line.append('[').append(MARKER).append(']');
        if (traceId != null && !traceId.isEmpty()) {
            line.append(" traceId=").append(traceId);
        }
        line.append(" stage=").append(stage);
        line.append(" elapsedMs=").append(elapsedMs);

        if (keyValuePairs != null) {
            for (int i = 0; i + 1 < keyValuePairs.length; i += 2) {
                String key = String.valueOf(keyValuePairs[i]);
                line.append(' ')
                        .append(key)
                        .append('=')
                        .append(sanitize(key, keyValuePairs[i + 1]));
            }
        }
        return line.toString();
    }

    /**
     * Redact secrets outright and strip query strings from URLs. The local WHIP URL is genuinely
     * useful in a trace, but a URL carrying a watch token is not, so query and userinfo go.
     */
    static String sanitize(String key, Object value) {
        if (isSensitive(key)) return REDACTED;
        if (value == null) return "null";

        String text = String.valueOf(value);
        if (text.isEmpty()) return "\"\"";
        if (text.indexOf(' ') >= 0) return "\"" + stripUrlSecrets(text) + "\"";
        return stripUrlSecrets(text);
    }

    private static boolean isSensitive(String key) {
        if (key == null) return false;
        String lower = key.toLowerCase(Locale.ROOT);
        for (String sensitive : SENSITIVE_KEYS) {
            if (lower.contains(sensitive)) return true;
        }
        return false;
    }

    /** Drop {@code ?query}, {@code #fragment}, and {@code user:pass@} from anything URL-shaped. */
    private static String stripUrlSecrets(String text) {
        if (text.indexOf("://") < 0) return text;

        String result = text;
        int cut = result.indexOf('?');
        if (cut >= 0) result = result.substring(0, cut) + "?<redacted>";
        int fragment = result.indexOf('#');
        if (fragment >= 0) result = result.substring(0, fragment);

        int scheme = result.indexOf("://");
        int at = result.indexOf('@', scheme + 3);
        if (at >= 0)
            result = result.substring(0, scheme + 3) + REDACTED + "@" + result.substring(at + 1);
        return result;
    }
}
