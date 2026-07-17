package com.mentra.asg_client.io.media.core.textdetect;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.mentra.asg_client.AsgConstants;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Bundled, offline ML Kit text localizer for Mentra Live text-mode photos.
 *
 * <p>The sensor JPEG remains the source of truth. This class decodes only a sampled analysis
 * bitmap, scales it to the configured analysis long edge, and maps ML Kit line boxes back into
 * source-pixel coordinates. A missing/invalid result is represented by a {@code null} ROI so
 * callers preserve and transmit the full frame.
 */
public final class MlKitTextRoiDetector implements AutoCloseable {
    private static final String TAG = "MlKitTextRoi";

    private final TextRecognizer recognizer;
    private final int analysisLongEdge;

    @Nullable private Task<Text> warmupTask;
    private boolean closed;

    public MlKitTextRoiDetector() {
        this(AsgConstants.TEXT_MODE_MLKIT_ANALYSIS_LONG_EDGE);
    }

    /** Visible for the on-device benchmark harness. */
    MlKitTextRoiDetector(int analysisLongEdge) {
        this(
                analysisLongEdge,
                TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS));
    }

    /** Visible for unit tests that exercise recognizer lifecycle failures. */
    MlKitTextRoiDetector(int analysisLongEdge, TextRecognizer recognizer) {
        this.analysisLongEdge = analysisLongEdge;
        this.recognizer = recognizer;
    }

    /** Starts model initialization while the camera is capturing. Safe to call repeatedly. */
    public synchronized void warmUp() {
        if (closed || warmupTask != null) {
            return;
        }
        Bitmap blank = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888);
        blank.eraseColor(Color.WHITE);
        long startMs = SystemClock.elapsedRealtime();
        Task<Text> task = recognizer.process(InputImage.fromBitmap(blank, 0));
        warmupTask = task;
        task.addOnCompleteListener(
                completedTask -> {
                    blank.recycle();
                    handleWarmupCompletion(completedTask);
                    Log.i(
                            TAG,
                            "ML Kit warmup finished in "
                                    + (SystemClock.elapsedRealtime() - startMs)
                                    + "ms success="
                                    + completedTask.isSuccessful());
                });
    }

    private synchronized void handleWarmupCompletion(Task<Text> completedTask) {
        if (warmupTask == completedTask && !completedTask.isSuccessful()) {
            warmupTask = null;
        }
    }

    /** Detects a padded source-pixel ROI from an in-memory JPEG. */
    public synchronized Detection detect(byte[] jpegBytes) {
        if (jpegBytes == null || jpegBytes.length == 0) {
            return Detection.fullFrame("empty_jpeg", 0, 0, 0);
        }
        return detectInternal(jpegBytes, null);
    }

    /** Detects a padded source-pixel ROI from a file-backed JPEG fallback flow. */
    public synchronized Detection detect(String jpegPath) {
        if (jpegPath == null || jpegPath.isEmpty()) {
            return Detection.fullFrame("empty_path", 0, 0, 0);
        }
        return detectInternal(null, jpegPath);
    }

    private Detection detectInternal(@Nullable byte[] jpegBytes, @Nullable String jpegPath) {
        long startMs = SystemClock.elapsedRealtime();
        if (closed) {
            return Detection.fullFrame("detector_closed", 0, 0, 0);
        }

        Bitmap decoded = null;
        Bitmap analysis = null;
        try {
            warmUp();
            Task<Text> taskToAwait = warmupTask;
            if (taskToAwait != null) {
                try {
                    Tasks.await(
                            taskToAwait,
                            AsgConstants.TEXT_MODE_MLKIT_TIMEOUT_MS,
                            TimeUnit.MILLISECONDS);
                } catch (Throwable warmupError) {
                    // A transient model-init failure or timeout must not poison every later text
                    // capture. Only clear the task we actually awaited; an older completion must
                    // never clear a newer retry.
                    if (warmupTask == taskToAwait) {
                        warmupTask = null;
                    }
                    throw warmupError;
                }
            }

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            decode(jpegBytes, jpegPath, bounds);
            int sourceWidth = bounds.outWidth;
            int sourceHeight = bounds.outHeight;
            if (sourceWidth <= 0 || sourceHeight <= 0) {
                return Detection.fullFrame(
                        "invalid_jpeg_bounds",
                        SystemClock.elapsedRealtime() - startMs,
                        sourceWidth,
                        sourceHeight);
            }

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = computeSampleSize(sourceWidth, sourceHeight, analysisLongEdge);
            decoded = decode(jpegBytes, jpegPath, options);
            if (decoded == null) {
                return Detection.fullFrame(
                        "jpeg_decode_failed",
                        SystemClock.elapsedRealtime() - startMs,
                        sourceWidth,
                        sourceHeight);
            }

            analysis = scaleLongEdge(decoded, analysisLongEdge);
            Text text =
                    Tasks.await(
                            recognizer.process(InputImage.fromBitmap(analysis, 0)),
                            AsgConstants.TEXT_MODE_MLKIT_TIMEOUT_MS,
                            TimeUnit.MILLISECONDS);

            List<Rect> sourceLineBoxes = mapLineBoxes(text, analysis, sourceWidth, sourceHeight);
            Rect roi = buildPaddedUnion(sourceLineBoxes, sourceWidth, sourceHeight);
            long elapsedMs = SystemClock.elapsedRealtime() - startMs;
            if (roi == null) {
                return Detection.fullFrame("no_text_lines", elapsedMs, sourceWidth, sourceHeight);
            }
            return new Detection(
                    roi,
                    "mlkit_lines",
                    sourceLineBoxes.size(),
                    elapsedMs,
                    sourceWidth,
                    sourceHeight,
                    analysis.getWidth(),
                    analysis.getHeight());
        } catch (Throwable error) {
            Log.w(TAG, "ML Kit detection failed; preserving full frame", error);
            return Detection.fullFrame(
                    "mlkit_error:" + error.getClass().getSimpleName(),
                    SystemClock.elapsedRealtime() - startMs,
                    0,
                    0);
        } finally {
            if (analysis != null && analysis != decoded) {
                analysis.recycle();
            }
            if (decoded != null) {
                decoded.recycle();
            }
        }
    }

    @Nullable
    private static Bitmap decode(
            @Nullable byte[] jpegBytes, @Nullable String jpegPath, BitmapFactory.Options options) {
        if (jpegBytes != null) {
            return BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length, options);
        }
        return BitmapFactory.decodeFile(jpegPath, options);
    }

    private static int computeSampleSize(int width, int height, int targetLongEdge) {
        int longEdge = Math.max(width, height);
        int sampleSize = 1;
        while (longEdge / (sampleSize * 2) >= targetLongEdge) {
            sampleSize *= 2;
        }
        return sampleSize;
    }

    private static Bitmap scaleLongEdge(Bitmap bitmap, int targetLongEdge) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int longEdge = Math.max(width, height);
        if (longEdge <= targetLongEdge) {
            return bitmap;
        }
        float scale = targetLongEdge / (float) longEdge;
        return Bitmap.createScaledBitmap(
                bitmap, Math.round(width * scale), Math.round(height * scale), true);
    }

    private static List<Rect> mapLineBoxes(
            Text text, Bitmap analysis, int sourceWidth, int sourceHeight) {
        float scaleX = sourceWidth / (float) analysis.getWidth();
        float scaleY = sourceHeight / (float) analysis.getHeight();
        List<Rect> boxes = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect box = line.getBoundingBox();
                if (box == null || box.width() <= 0 || box.height() <= 0) {
                    continue;
                }
                Rect mapped =
                        new Rect(
                                clamp(Math.round(box.left * scaleX), 0, sourceWidth),
                                clamp(Math.round(box.top * scaleY), 0, sourceHeight),
                                clamp(Math.round(box.right * scaleX), 0, sourceWidth),
                                clamp(Math.round(box.bottom * scaleY), 0, sourceHeight));
                if (mapped.width() > 0 && mapped.height() > 0) {
                    boxes.add(mapped);
                }
            }
        }
        return boxes;
    }

    @Nullable
    static Rect buildPaddedUnion(List<Rect> boxes, int sourceWidth, int sourceHeight) {
        if (boxes == null || boxes.isEmpty() || sourceWidth <= 0 || sourceHeight <= 0) {
            return null;
        }
        int left = sourceWidth;
        int top = sourceHeight;
        int right = 0;
        int bottom = 0;
        for (Rect box : boxes) {
            left = Math.min(left, box.left);
            top = Math.min(top, box.top);
            right = Math.max(right, box.right);
            bottom = Math.max(bottom, box.bottom);
        }
        if (right <= left || bottom <= top) {
            return null;
        }
        int paddingX =
                Math.max(
                        AsgConstants.TEXT_MODE_MLKIT_MIN_PADDING_PX,
                        Math.round(
                                (right - left) * AsgConstants.TEXT_MODE_MLKIT_PADDING_X_FRACTION));
        int paddingY =
                Math.max(
                        AsgConstants.TEXT_MODE_MLKIT_MIN_PADDING_PX,
                        Math.round(
                                (bottom - top) * AsgConstants.TEXT_MODE_MLKIT_PADDING_Y_FRACTION));
        int paddingTop = paddingY;
        int paddingBottom = paddingY;
        if (boxes.size() == 1) {
            int lineHeight = bottom - top;
            paddingX =
                    Math.max(
                            paddingX,
                            Math.round(
                                    lineHeight
                                            * AsgConstants
                                                    .TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_X_HEIGHTS));
            paddingTop =
                    Math.max(
                            paddingTop,
                            Math.round(
                                    lineHeight
                                            * AsgConstants
                                                    .TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_TOP_HEIGHTS));
            paddingBottom =
                    Math.max(
                            paddingBottom,
                            Math.round(
                                    lineHeight
                                            * AsgConstants
                                                    .TEXT_MODE_MLKIT_SINGLE_LINE_PADDING_BOTTOM_HEIGHTS));
        }
        return new Rect(
                Math.max(0, left - paddingX),
                Math.max(0, top - paddingTop),
                Math.min(sourceWidth, right + paddingX),
                Math.min(sourceHeight, bottom + paddingBottom));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    @Override
    public synchronized void close() {
        if (!closed) {
            closed = true;
            recognizer.close();
        }
    }

    /** Immutable detector result; a {@code null} ROI means transmit the full frame. */
    public static final class Detection {
        @Nullable public final Rect roi;
        public final String reason;
        public final int lineCount;
        public final long elapsedMs;
        public final int sourceWidth;
        public final int sourceHeight;
        public final int analysisWidth;
        public final int analysisHeight;

        private Detection(
                @Nullable Rect roi,
                String reason,
                int lineCount,
                long elapsedMs,
                int sourceWidth,
                int sourceHeight,
                int analysisWidth,
                int analysisHeight) {
            this.roi = roi;
            this.reason = reason;
            this.lineCount = lineCount;
            this.elapsedMs = elapsedMs;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.analysisWidth = analysisWidth;
            this.analysisHeight = analysisHeight;
        }

        private static Detection fullFrame(
                String reason, long elapsedMs, int sourceWidth, int sourceHeight) {
            return new Detection(null, reason, 0, elapsedMs, sourceWidth, sourceHeight, 0, 0);
        }
    }
}
