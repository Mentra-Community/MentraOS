package com.mentra.asg_client.io.ota.utils;

/**
 * Typed exception thrown when a firmware download fails for a reason that is NOT
 * a transient network error (e.g. size cap exceeded, sha256 mismatch).
 *
 * Carries a stable {@link #errorCode} string so callers can pipe a precise
 * error code through to the phone without falling back to the generic
 * "download_failed" classification (which would imply WiFi trouble and lead the
 * user to retry an operation that will deterministically fail again).
 *
 * Codes are kept in sync with {@code mobile/src/utils/otaErrorMapping.ts}.
 */
public class FirmwareDownloadException extends Exception {
    public static final String CODE_FILE_TOO_LARGE = "firmware_too_large";
    public static final String CODE_VERIFY_FAILED = "firmware_verify_failed";

    private final String errorCode;

    public FirmwareDownloadException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public String getErrorCode() {
        return errorCode;
    }
}
