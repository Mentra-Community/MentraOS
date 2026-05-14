package com.mentra.asg_client.camera;

import java.util.Objects;

/**
 * Snapshot of the in-flight photo capture parameters (replaces scattered {@code pending*} fields).
 */
public final class CurrentRequest {
    public final String filePath;
    public final String size;
    public final boolean isFromSdk;
    /** Null = auto exposure. */
    public final Long exposureTimeNs;
    public final boolean ledEnabled;
    public final long startTimeMs;
    public final CameraNeo.PhotoCaptureCallback callback;

    public CurrentRequest(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            boolean ledEnabled,
            long startTimeMs,
            CameraNeo.PhotoCaptureCallback callback) {
        this.filePath = filePath;
        this.size = size;
        this.isFromSdk = isFromSdk;
        this.exposureTimeNs = exposureTimeNs;
        this.ledEnabled = ledEnabled;
        this.startTimeMs = startTimeMs;
        this.callback = callback;
    }

    public static CurrentRequest from(PhotoRequest pr) {
        return new CurrentRequest(
                pr.filePath,
                pr.size,
                pr.isFromSdk,
                pr.exposureTimeNs,
                pr.enableLed,
                pr.timestamp,
                pr.callback);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof CurrentRequest)) {
            return false;
        }
        CurrentRequest that = (CurrentRequest) o;
        return isFromSdk == that.isFromSdk
                && ledEnabled == that.ledEnabled
                && startTimeMs == that.startTimeMs
                && Objects.equals(filePath, that.filePath)
                && Objects.equals(size, that.size)
                && Objects.equals(exposureTimeNs, that.exposureTimeNs)
                && Objects.equals(callback, that.callback);
    }

    @Override
    public int hashCode() {
        return Objects.hash(filePath, size, isFromSdk, exposureTimeNs, ledEnabled, startTimeMs, callback);
    }
}
