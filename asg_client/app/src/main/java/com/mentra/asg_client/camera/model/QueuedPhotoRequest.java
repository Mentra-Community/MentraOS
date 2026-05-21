package com.mentra.asg_client.camera.model;

import com.mentra.asg_client.camera.CameraNeoService;

/**
 * A photo capture job waiting in the global FIFO ({@link QueuedPhotoRequestQueue}).
 *
 * <p><b>Lifecycle role:</b> This type represents the <em>waiting</em> phase. Callers enqueue via
 * {@link CameraNeoService#enqueuePhotoRequest}; {@link com.mentra.asg_client.camera.lifecycle.PhotoSession}
 * later {@link QueuedPhotoRequestQueue#poll() polls} the head and promotes it to an
 * {@link ActivePhotoCapture} while Camera2 runs AE/capture.
 *
 * <p><b>Why not merge with {@link ActivePhotoCapture}?</b> Queue entries may sit for a long time,
 * survive service restarts (callbacks re-bound by {@code requestId}), and have their
 * {@link #callback} patched after enqueue. The in-flight capture uses a separate immutable snapshot
 * so AE/capture never sees mid-flight mutation.
 *
 * <p><b>Immutability:</b> All fields except {@link #callback} are {@code final}. The callback may
 * be {@code null} at enqueue time and filled from {@link QueuedPhotoRequestQueue}'s registry before
 * dispatch.
 */
public final class QueuedPhotoRequest {

    /** Stable id for logging and {@link QueuedPhotoRequestQueue}'s callback registry. */
    public final String requestId;

    /** Absolute path for the JPEG output file. */
    public final String filePath;

    /** Resolution preset ({@code "small"}, {@code "medium"}, {@code "large"}, etc.). */
    public final String size;

    /** Whether to pulse the privacy LED during capture. */
    public final boolean enableLed;

    /**
     * {@code true} when the request originated from an SDK/app photo (affects JPEG quality path);
     * {@code false} for local button capture.
     */
    public final boolean isFromSdk;

    /**
     * Optional manual shutter for this shot only (Camera2 {@code SENSOR_EXPOSURE_TIME}, nanoseconds).
     * {@code null} means auto exposure.
     */
    public final Long exposureTimeNs;

    /** Wall-clock time when this entry was enqueued; copied to {@link ActivePhotoCapture#startTimeMs}. */
    public final long enqueuedAtMs;

    /**
     * Result delivery. May be {@code null} at construction; {@link QueuedPhotoRequestQueue} can
     * attach from its registry using {@link #requestId}.
     */
    public CameraNeoService.PhotoCaptureCallback callback;

    public QueuedPhotoRequest(
            String filePath,
            String size,
            boolean enableLed,
            boolean isFromSdk,
            Long exposureTimeNs,
            CameraNeoService.PhotoCaptureCallback callback) {
        this.requestId = "photo_" + System.currentTimeMillis() + "_" + filePath.hashCode();
        this.filePath = filePath;
        this.size = size;
        this.enableLed = enableLed;
        this.isFromSdk = isFromSdk;
        this.exposureTimeNs = exposureTimeNs;
        this.callback = callback;
        this.enqueuedAtMs = System.currentTimeMillis();
    }
}
