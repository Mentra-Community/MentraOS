package com.mentra.asg_client.camera.model;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * In-memory result of a photo capture: the sensor JPEG bytes plus the assembled IMU payload, handed
 * directly to consumers (BLE compression). Sensor-JPEG persistence is optional. Text mode keeps it
 * disabled even for save=true so the consumer can persist only its final crop (or a full-frame
 * fallback); save=false also uses a completed false future.
 *
 * <p>Produced by {@code PhotoSession} for captures enqueued with {@code deferDiskWrite=true} and
 * delivered directly through {@code PhotoCaptureCallback}. The {@link #persistence} future tracks
 * the background optional JPEG + EXIF + IMU-sidecar write; any consumer that needs the file on disk
 * must gate on {@link #awaitPersistence} instead of touching the path directly.
 */
public final class CapturedPhoto {

    /** Complete sensor JPEG as delivered by the camera HAL. */
    public final byte[] jpegBytes;

    /** Assembled IMU payload for EXIF embedding, or {@code null} when no samples were captured. */
    @Nullable public final JSONObject imuPayload;

    /**
     * Persistence result: {@code true} once the JPEG (and IMU artifacts, if any) are on disk,
     * {@code false} when persistence was intentionally skipped or failed.
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
     * Waits for a required gallery write to reach a terminal result. Interrupts are restored after
     * the write resolves so callers never report a save failure while the same write is still able
     * to publish the file.
     */
    public boolean awaitPersistenceCompletion() {
        boolean interrupted = false;
        try {
            while (true) {
                try {
                    return Boolean.TRUE.equals(persistence.get());
                } catch (InterruptedException e) {
                    interrupted = true;
                } catch (ExecutionException | CancellationException e) {
                    return false;
                }
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
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
