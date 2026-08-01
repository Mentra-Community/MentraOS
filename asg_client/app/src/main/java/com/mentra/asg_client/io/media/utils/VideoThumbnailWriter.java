package com.mentra.asg_client.io.media.utils;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Writes a {@code thumb.jpg} sidecar next to a finished video capture (e.g. {@code
 * VID_xxx/base.mp4} → {@code VID_xxx/thumb.jpg}) so consumers that read capture folders directly
 * (USB/WebUSB transfer, desktop tools) get a preview without decoding the full video.
 *
 * <p>This is distinct from {@link com.mentra.asg_client.io.file.managers.ThumbnailManager}, which
 * maintains an on-demand, content-hashed thumbnail cache for the Wi-Fi camera server. The sidecar
 * is written eagerly, once, at capture-finalize time, and lives (and dies) with its capture folder.
 *
 * <p>Static and side-effect free beyond the sidecar file itself, following the {@code
 * VideoRecordingSession.deleteCorruptCapture} pattern so the path/guard logic is unit-testable
 * without camera plumbing.
 */
public final class VideoThumbnailWriter {
    private static final String TAG = "VideoThumbnailWriter";

    /** Sidecar filename inside a capture folder. */
    public static final String SIDECAR_NAME = "thumb.jpg";

    /** Longest edge of the generated thumbnail, in pixels. Aspect ratio is preserved. */
    static final int MAX_DIMENSION = 480;

    static final int JPEG_QUALITY = 80;

    /** Frame to sample, in microseconds (1 second in, falling back to the first frame). */
    private static final long FRAME_TIME_US = 1_000_000L;

    private VideoThumbnailWriter() {}

    /** The sidecar file a given video would get, whether or not it exists yet. */
    public static File sidecarFor(File videoFile) {
        return new File(videoFile.getParentFile(), SIDECAR_NAME);
    }

    /**
     * Extract a frame from {@code videoFile} and write it as {@code thumb.jpg} in the same folder.
     * The write is atomic (temp file + rename) so readers never observe a half-written thumbnail.
     * Never throws.
     *
     * @return the sidecar file on success, or null if extraction or writing failed
     */
    public static File writeSidecar(File videoFile) {
        if (videoFile == null || !videoFile.isFile()) {
            return null;
        }
        File sidecar = sidecarFor(videoFile);
        File tmp = new File(sidecar.getParentFile(), SIDECAR_NAME + ".tmp");
        Bitmap frame = null;
        Bitmap scaled = null;
        try {
            frame = extractFrame(videoFile);
            if (frame == null) {
                Log.w(TAG, "No frame extracted for thumbnail: " + videoFile.getAbsolutePath());
                return null;
            }
            float scale =
                    Math.min(
                            1f,
                            (float) MAX_DIMENSION / Math.max(frame.getWidth(), frame.getHeight()));
            scaled =
                    scale < 1f
                            ? Bitmap.createScaledBitmap(
                                    frame,
                                    Math.round(frame.getWidth() * scale),
                                    Math.round(frame.getHeight() * scale),
                                    true)
                            : frame;
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, fos)) {
                    return null;
                }
            }
            if (!tmp.renameTo(sidecar)) {
                Log.w(TAG, "Could not move thumbnail into place: " + sidecar.getAbsolutePath());
                return null;
            }
            return sidecar;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "Thumbnail generation failed for " + videoFile.getAbsolutePath(), e);
            return null;
        } finally {
            if (scaled != null && scaled != frame) {
                scaled.recycle();
            }
            if (frame != null) {
                frame.recycle();
            }
            if (tmp.exists() && !tmp.delete()) {
                Log.w(TAG, "Could not delete temp thumbnail: " + tmp.getAbsolutePath());
            }
        }
    }

    private static Bitmap extractFrame(File videoFile) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(videoFile.getAbsolutePath());
            Bitmap frame = retriever.getFrameAtTime(FRAME_TIME_US);
            if (frame == null) {
                frame = retriever.getFrameAtTime();
            }
            return frame;
        } catch (Exception e) {
            Log.w(TAG, "Frame extraction failed for " + videoFile.getAbsolutePath(), e);
            return null;
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // best effort
            }
        }
    }
}
