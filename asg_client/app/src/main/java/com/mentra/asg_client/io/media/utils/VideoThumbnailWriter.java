package com.mentra.asg_client.io.media.utils;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

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

    private VideoThumbnailWriter() {}

    /** The sidecar file a given video would get, whether or not it exists yet. */
    public static File sidecarFor(File videoFile) {
        return new File(videoFile.getParentFile(), AsgConstants.VIDEO_THUMBNAIL_SIDECAR_NAME);
    }

    private static File partialFor(File videoFile) {
        return new File(videoFile.getParentFile(), AsgConstants.VIDEO_THUMBNAIL_PARTIAL_NAME);
    }

    /**
     * Remove thumbnail artifacts when the owning video is intentionally discarded. Never throws.
     */
    public static void deleteSidecar(File videoFile) {
        if (videoFile == null) {
            return;
        }
        deleteBestEffort(sidecarFor(videoFile));
        deleteBestEffort(partialFor(videoFile));
    }

    /**
     * Extract a frame from {@code videoFile} and write it as {@code thumb.jpg} in the same folder.
     * The write is atomic (temp file + rename) so readers never observe a half-written thumbnail.
     * Never throws.
     *
     * @return the sidecar file on success, or null if extraction or writing failed
     */
    public static File writeSidecar(File videoFile) {
        if (videoFile == null) {
            return null;
        }
        File sidecar = null;
        File partial = null;
        Bitmap frame = null;
        Bitmap scaled = null;
        try {
            if (!videoFile.isFile()) {
                return null;
            }
            sidecar = sidecarFor(videoFile);
            partial = partialFor(videoFile);
            frame = extractFrame(videoFile);
            if (frame == null) {
                Log.w(TAG, "No frame extracted for thumbnail: " + videoFile.getAbsolutePath());
                return null;
            }
            float scale =
                    Math.min(
                            1f,
                            (float) AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION
                                    / Math.max(frame.getWidth(), frame.getHeight()));
            scaled =
                    scale < 1f
                            ? Bitmap.createScaledBitmap(
                                    frame,
                                    Math.round(frame.getWidth() * scale),
                                    Math.round(frame.getHeight() * scale),
                                    true)
                            : frame;
            try (FileOutputStream fos = new FileOutputStream(partial)) {
                if (!scaled.compress(
                        Bitmap.CompressFormat.JPEG,
                        AsgConstants.VIDEO_THUMBNAIL_JPEG_QUALITY,
                        fos)) {
                    return null;
                }
            }
            if (!partial.renameTo(sidecar)) {
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
            if (partial != null && partial.exists() && !partial.delete()) {
                Log.w(TAG, "Could not delete partial thumbnail: " + partial.getAbsolutePath());
            }
        }
    }

    private static Bitmap extractFrame(File videoFile) {
        return extractFrameWithTimeout(
                videoFile,
                VideoThumbnailWriter::extractFrameDirect,
                AsgConstants.VIDEO_THUMBNAIL_EXTRACTION_TIMEOUT_MS);
    }

    static Bitmap extractFrameWithTimeout(
            File videoFile, FrameExtractor extractor, long timeoutMs) {
        ExecutorService executor =
                Executors.newSingleThreadExecutor(
                        runnable -> {
                            Thread thread = new Thread(runnable, "VideoThumbnailDecode");
                            thread.setPriority(Thread.NORM_PRIORITY - 1);
                            return thread;
                        });
        Future<Bitmap> future = executor.submit(() -> extractor.extract(videoFile));
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            Log.w(
                    TAG,
                    "Frame extraction timed out after "
                            + timeoutMs
                            + "ms for "
                            + videoFile.getAbsolutePath());
            return null;
        } catch (InterruptedException e) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException e) {
            Log.w(TAG, "Frame extraction failed for " + videoFile.getAbsolutePath(), e.getCause());
            return null;
        } finally {
            executor.shutdownNow();
        }
    }

    private static Bitmap extractFrameDirect(File videoFile) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(videoFile.getAbsolutePath());
            Bitmap frame = retriever.getFrameAtTime(AsgConstants.VIDEO_THUMBNAIL_FRAME_TIME_US);
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

    private static void deleteBestEffort(File file) {
        try {
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "Could not delete thumbnail artifact: " + file.getAbsolutePath());
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not delete thumbnail artifact: " + file.getAbsolutePath(), e);
        }
    }

    @FunctionalInterface
    interface FrameExtractor {
        Bitmap extract(File videoFile);
    }
}
