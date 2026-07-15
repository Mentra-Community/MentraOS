package com.mentra.asg_client.camera.model;

import androidx.annotation.Nullable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.json.JSONObject;

/**
 * In-memory result of a photo capture: the sensor JPEG bytes plus the assembled IMU payload,
 * handed to consumers (BLE compression) before — and independently of — the background disk write.
 *
 * <p>Produced by {@code PhotoSession} for captures enqueued with {@code deferDiskWrite=true} and
 * retrieved via {@link CapturedPhotoStore}. The {@link #persistence} future tracks the background
 * JPEG + EXIF + IMU-sidecar write; any consumer that needs the file on disk (gallery save, upload,
 * canonical text crop) must gate on {@link #awaitPersistence} instead of touching the path
 * directly, so it can never race the write.
 */
public final class CapturedPhoto {

    /** Complete sensor JPEG as delivered by the camera HAL. */
    public final byte[] jpegBytes;

    /** Assembled IMU payload for EXIF embedding, or {@code null} when no samples were captured. */
    @Nullable public final JSONObject imuPayload;

    /**
     * Background persistence result: {@code true} once the JPEG (and IMU artifacts, if any) are on
     * disk at the capture's intended path.
     */
    public final Future<Boolean> persistence;

    public CapturedPhoto(
            byte[] jpegBytes, @Nullable JSONObject imuPayload, Future<Boolean> persistence) {
        this.jpegBytes = jpegBytes;
        this.imuPayload = imuPayload;
        this.persistence = persistence;
    }

    /**
     * Block until the background disk write finishes.
     *
     * @return true when the file is on disk, false on write failure or timeout
     */
    public boolean awaitPersistence(long timeoutMs) {
        try {
            return Boolean.TRUE.equals(persistence.get(timeoutMs, TimeUnit.MILLISECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (ExecutionException | TimeoutException | CancellationException e) {
            return false;
        }
    }

    /**
     * Try to cancel the background write for photos that will never be kept (save=false). Returns
     * true when the write was cancelled before starting — nothing was or will be written. When
     * cancellation loses the race, the caller must await and clean the file up as usual.
     */
    public boolean cancelPersistence() {
        return persistence.cancel(false);
    }
}
