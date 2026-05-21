package com.mentra.asg_client.camera.model;

import java.util.Objects;

import com.mentra.asg_client.camera.CameraNeoService;

/**
 * Immutable snapshot of the photo capture currently executing in {@link com.mentra.asg_client.camera.lifecycle.PhotoSession}.
 *
 * <p><b>Lifecycle role:</b> Set when a {@link QueuedPhotoRequest} is dequeued and capture begins
 * ({@code activateQueuedRequest}); cleared when the shot finishes or errors ({@code clearActiveCapture}).
 * While non-null, AE wait, still capture, and JPEG save read exposure/size/callback from here.
 *
 * <p><b>Why not merge with {@link QueuedPhotoRequest}?</b> The queue item can be mutated (callback
 * binding) and carries {@link QueuedPhotoRequest#requestId} for FIFO bookkeeping. This type is a
 * frozen copy of only what Camera2 needs, without queue identity — so in-flight code cannot observe
 * late registry updates.
 *
 * <p><b>Field naming:</b> {@link #ledEnabled} mirrors {@link QueuedPhotoRequest#enableLed};
 * {@link #startTimeMs} mirrors {@link QueuedPhotoRequest#enqueuedAtMs} (capture clock starts at dequeue).
 */
public final class ActivePhotoCapture {

    public final String filePath;
    public final String size;
    public final boolean isFromSdk;
    /** {@code null} = auto exposure for this shot. */
    public final Long exposureTimeNs;
    public final boolean ledEnabled;
    public final long startTimeMs;
    public final CameraNeoService.PhotoCaptureCallback callback;

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            boolean ledEnabled,
            long startTimeMs,
            CameraNeoService.PhotoCaptureCallback callback) {
        this.filePath = filePath;
        this.size = size;
        this.isFromSdk = isFromSdk;
        this.exposureTimeNs = exposureTimeNs;
        this.ledEnabled = ledEnabled;
        this.startTimeMs = startTimeMs;
        this.callback = callback;
    }

    /**
     * Promote a dequeued {@link QueuedPhotoRequest} to the in-flight snapshot.
     * Call once per shot, before starting AE/capture.
     */
    public static ActivePhotoCapture fromQueued(QueuedPhotoRequest queued) {
        return new ActivePhotoCapture(
                queued.filePath,
                queued.size,
                queued.isFromSdk,
                queued.exposureTimeNs,
                queued.enableLed,
                queued.enqueuedAtMs,
                queued.callback);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ActivePhotoCapture)) {
            return false;
        }
        ActivePhotoCapture that = (ActivePhotoCapture) o;
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
