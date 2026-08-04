package com.mentra.asg_client.camera.model;

import com.mentra.asg_client.camera.CameraNeoService;

import java.util.Objects;

/**
 * Immutable snapshot of the photo capture currently executing in {@link
 * com.mentra.asg_client.camera.lifecycle.PhotoSession}.
 *
 * <p><b>Lifecycle role:</b> Set when a {@link QueuedPhotoRequest} is dequeued and capture begins
 * ({@code activateQueuedRequest}); cleared when the shot finishes or errors ({@code
 * clearActiveCapture}). While non-null, AE wait, still capture, and JPEG save read
 * exposure/size/callback from here.
 *
 * <p><b>Why not merge with {@link QueuedPhotoRequest}?</b> The queue item can be mutated (callback
 * binding) and carries {@link QueuedPhotoRequest#requestId} for FIFO bookkeeping. This type is a
 * frozen copy of only what Camera2 needs, without queue identity — so in-flight code cannot observe
 * late registry updates.
 *
 * <p><b>Field naming:</b> {@link #ledEnabled} mirrors {@link QueuedPhotoRequest#enableLed}; {@link
 * #startTimeMs} mirrors {@link QueuedPhotoRequest#enqueuedAtMs} (capture clock starts at dequeue).
 */
public final class ActivePhotoCapture {

    public final String filePath;
    public final String size;
    public final boolean isFromSdk;

    /** {@code null} = auto exposure for this shot. */
    public final Long exposureTimeNs;

    /** {@code null} = derive ISO from preview metering for manual exposure captures. */
    public final Integer iso;

    public final PhotoCaptureSettings captureSettings;
    public final boolean ledEnabled;
    public final long startTimeMs;

    /** Mirrors {@link QueuedPhotoRequest#deferDiskWrite}. */
    public final boolean deferDiskWrite;

    /** Mirrors {@link QueuedPhotoRequest#persistToDisk}. */
    public final boolean persistToDisk;

    public final CameraNeoService.PhotoCaptureCallback callback;

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            boolean ledEnabled,
            long startTimeMs,
            CameraNeoService.PhotoCaptureCallback callback) {
        this(
                filePath,
                size,
                isFromSdk,
                exposureTimeNs,
                null,
                PhotoCaptureSettings.EMPTY,
                ledEnabled,
                startTimeMs,
                callback);
    }

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            boolean ledEnabled,
            long startTimeMs,
            CameraNeoService.PhotoCaptureCallback callback) {
        this(
                filePath,
                size,
                isFromSdk,
                exposureTimeNs,
                iso,
                PhotoCaptureSettings.EMPTY,
                ledEnabled,
                startTimeMs,
                callback);
    }

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            boolean ledEnabled,
            long startTimeMs,
            CameraNeoService.PhotoCaptureCallback callback) {
        this(
                filePath,
                size,
                isFromSdk,
                exposureTimeNs,
                iso,
                captureSettings,
                ledEnabled,
                startTimeMs,
                false,
                true,
                callback);
    }

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            boolean ledEnabled,
            long startTimeMs,
            boolean deferDiskWrite,
            CameraNeoService.PhotoCaptureCallback callback) {
        this(
                filePath,
                size,
                isFromSdk,
                exposureTimeNs,
                iso,
                captureSettings,
                ledEnabled,
                startTimeMs,
                deferDiskWrite,
                true,
                callback);
    }

    public ActivePhotoCapture(
            String filePath,
            String size,
            boolean isFromSdk,
            Long exposureTimeNs,
            Integer iso,
            PhotoCaptureSettings captureSettings,
            boolean ledEnabled,
            long startTimeMs,
            boolean deferDiskWrite,
            boolean persistToDisk,
            CameraNeoService.PhotoCaptureCallback callback) {
        this.filePath = filePath;
        this.size = size;
        this.isFromSdk = isFromSdk;
        this.exposureTimeNs = exposureTimeNs;
        this.iso = iso;
        this.captureSettings =
                captureSettings != null ? captureSettings : PhotoCaptureSettings.EMPTY;
        this.ledEnabled = ledEnabled;
        this.startTimeMs = startTimeMs;
        this.deferDiskWrite = deferDiskWrite;
        this.persistToDisk = persistToDisk;
        this.callback = callback;
    }

    /**
     * Promote a dequeued {@link QueuedPhotoRequest} to the in-flight snapshot. Call once per shot,
     * before starting AE/capture.
     */
    public static ActivePhotoCapture fromQueued(QueuedPhotoRequest queued) {
        return new ActivePhotoCapture(
                queued.filePath,
                queued.size,
                queued.isFromSdk,
                queued.exposureTimeNs,
                queued.iso,
                queued.captureSettings,
                queued.enableLed,
                queued.enqueuedAtMs,
                queued.deferDiskWrite,
                queued.persistToDisk,
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
                && deferDiskWrite == that.deferDiskWrite
                && persistToDisk == that.persistToDisk
                && Objects.equals(filePath, that.filePath)
                && Objects.equals(size, that.size)
                && Objects.equals(exposureTimeNs, that.exposureTimeNs)
                && Objects.equals(iso, that.iso)
                && Objects.equals(callback, that.callback);
    }

    @Override
    public int hashCode() {
        return Objects.hash(
                filePath,
                size,
                isFromSdk,
                exposureTimeNs,
                iso,
                ledEnabled,
                startTimeMs,
                deferDiskWrite,
                persistToDisk,
                callback);
    }
}
