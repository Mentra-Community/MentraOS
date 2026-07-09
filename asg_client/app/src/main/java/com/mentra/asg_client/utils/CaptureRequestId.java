package com.mentra.asg_client.utils;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Helpers for embedding a capture request ID in capture directory names and recovering it later.
 *
 * <p>Capture directories are named {@code <IMG|VID>_<yyyyMMdd_HHmmss_SSS>_<rand>[_<requestId>]}.
 * The optional trailing segment is the sanitized ID of the SDK request that produced the capture,
 * so files pulled during gallery sync can be correlated with the originating request instead of
 * being timestamp-matched (which breaks under clock skew and rapid bursts). Button captures have
 * no originating request; their stable ID is the capture directory name itself.
 */
public final class CaptureRequestId {

    /** Matches capture directory names; group(1) is the embedded request ID, if any. */
    private static final Pattern CAPTURE_DIR_PATTERN =
            Pattern.compile("^(?:IMG|VID)_\\d{8}_\\d{6}_\\d{3}_\\d{1,3}(?:_(.+))?$");

    private static final int MAX_EMBEDDED_LENGTH = 64;

    private CaptureRequestId() {}

    /**
     * Sanitize a request ID so it is safe to use as part of a single directory-name segment on
     * the glasses and on the phone after sync. Returns an empty string when nothing embeddable
     * remains (callers should then omit the suffix entirely).
     *
     * <p>Dots are excluded from the allowlist entirely: a surviving ".." sequence would embed
     * into the directory name and later be rejected by FileSecurityValidator's path-traversal
     * check, leaving a capture that syncs into listings but can never be served or deleted.
     */
    public static String sanitizeForDirName(String requestId) {
        if (requestId == null) {
            return "";
        }
        String sanitized = requestId.replaceAll("[^A-Za-z0-9_-]", "-");
        if (sanitized.length() > MAX_EMBEDDED_LENGTH) {
            sanitized = sanitized.substring(0, MAX_EMBEDDED_LENGTH);
        }
        // A suffix that is all separators carries no information; omit it.
        if (sanitized.matches("-+")) {
            return "";
        }
        return sanitized;
    }

    /**
     * Extract the request ID embedded in a capture ID (capture directory name), or {@code null}
     * when the capture has none (button captures, legacy flat files).
     */
    public static String extractFromCaptureId(String captureId) {
        if (captureId == null) {
            return null;
        }
        Matcher matcher = CAPTURE_DIR_PATTERN.matcher(captureId);
        if (!matcher.matches()) {
            return null;
        }
        String embedded = matcher.group(1);
        return (embedded == null || embedded.isEmpty()) ? null : embedded;
    }
}
