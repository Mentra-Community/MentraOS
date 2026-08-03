package com.mentra.asg_client.io.media.core.textdetect;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.os.SystemClock;
import android.os.UserManager;
import android.util.Log;

import androidx.annotation.Nullable;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.MlKit;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import com.mentra.asg_client.AsgConstants;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

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
    private static final Executor DIRECT_EXECUTOR = Runnable::run;

    @Nullable private final Context context;
    private final int analysisLongEdge;
    private final Object recognizerLock = new Object();

    @Nullable private TextRecognizer recognizer;

    private final AtomicReference<Task<Text>> warmupTask = new AtomicReference<>();
    private final AtomicReference<Task<Text>> activeRecognizerTask = new AtomicReference<>();
    private volatile boolean closed;

    /** Set by {@link #tryStartRecognizerProcess} when it returns null; consumed by detect. */
    @Nullable private volatile String lastStartFailureReason;

    public MlKitTextRoiDetector(Context context) {
        this(context, AsgConstants.TEXT_MODE_MLKIT_ANALYSIS_LONG_EDGE);
    }

    /** Visible for the on-device benchmark harness. */
    MlKitTextRoiDetector(Context context, int analysisLongEdge) {
        this.context = context.getApplicationContext();
        this.analysisLongEdge = analysisLongEdge;
    }

    /** Visible for unit tests that exercise recognizer lifecycle failures. */
    MlKitTextRoiDetector(int analysisLongEdge, TextRecognizer recognizer) {
        this.context = null;
        this.analysisLongEdge = analysisLongEdge;
        this.recognizer = recognizer;
    }

    /** Starts model initialization while the camera is capturing. Safe to call repeatedly. */
    public void warmUp() {
        synchronized (warmupTask) {
            if (closed || warmupTask.get() != null) {
                return;
            }
            Bitmap blank = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888);
            blank.eraseColor(Color.WHITE);
            long startMs = SystemClock.elapsedRealtime();
            Task<Text> task = tryStartRecognizerProcess(InputImage.fromBitmap(blank, 0));
            if (task == null) {
                blank.recycle();
                return;
            }
            warmupTask.set(task);
            task.addOnCompleteListener(
                    DIRECT_EXECUTOR,
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
    }

    /**
     * @return recognition task, or {@code null} when ML Kit is unavailable/busy. Use {@link
     *     #lastStartFailureReason} for the caller-facing full-frame reason.
     */
    @Nullable
    private Task<Text> tryStartRecognizerProcess(InputImage image) {
        TextRecognizer availableRecognizer = getOrCreateRecognizer();
        if (availableRecognizer == null) {
            if (lastStartFailureReason == null) {
                lastStartFailureReason = "mlkit_unavailable";
            }
            return null;
        }
        synchronized (activeRecognizerTask) {
            Task<Text> activeTask = activeRecognizerTask.get();
            if (activeTask != null && !activeTask.isComplete()) {
                lastStartFailureReason = "mlkit_busy";
                return null;
            }
            if (activeTask != null) {
                activeRecognizerTask.compareAndSet(activeTask, null);
            }
            try {
                Task<Text> newTask = availableRecognizer.process(image);
                activeRecognizerTask.set(newTask);
                newTask.addOnCompleteListener(
                        DIRECT_EXECUTOR,
                        completedTask -> activeRecognizerTask.compareAndSet(completedTask, null));
                return newTask;
            } catch (RuntimeException error) {
                Log.w(TAG, "Unable to start ML Kit recognition; preserving full frame", error);
                lastStartFailureReason = "mlkit_process_error";
                return null;
            }
        }
    }

    /**
     * Creates the text recognizer on first use rather than during direct-boot service construction.
     *
     * <p>ML Kit's manifest provider is not direct-boot-aware. Mentra Live starts this process from
     * {@code LOCKED_BOOT_COMPLETED}, so the provider may be skipped. Prefer the same {@code
     * getClient()} path that worked before lazy init; only call {@link MlKit#initialize} when that
     * fails and credential storage is available. Never hard-fail on {@code isUserUnlocked} before
     * attempting {@code getClient()} — that gate permanently disabled text crop on devices where
     * unlock reporting is unreliable but ML Kit still works.
     */
    @Nullable
    private TextRecognizer getOrCreateRecognizer() {
        synchronized (recognizerLock) {
            if (closed) {
                lastStartFailureReason = "detector_closed";
                return null;
            }
            if (recognizer != null) {
                return recognizer;
            }
            if (context == null) {
                lastStartFailureReason = "mlkit_no_context";
                return null;
            }
            lastStartFailureReason = null;

            // Path A: provider already ran (normal post-unlock / process restart). Matches the
            // pre-d2a270364 behavior that successfully cropped text-mode photos.
            try {
                recognizer =
                        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                Log.i(TAG, "ML Kit text recognizer ready via getClient()");
                return recognizer;
            } catch (RuntimeException firstError) {
                Log.i(
                        TAG,
                        "ML Kit getClient failed; trying explicit initialize after unlock",
                        firstError);
            }

            // Path B: provider skipped during direct boot — repair once CE storage is available.
            if (!isUserUnlocked(context)) {
                lastStartFailureReason = "mlkit_user_locked";
                Log.w(TAG, "ML Kit unavailable before user unlock; will retry on next capture");
                return null;
            }
            try {
                MlKit.initialize(context);
                recognizer =
                        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                Log.i(TAG, "ML Kit text recognizer ready via initialize()+getClient()");
                return recognizer;
            } catch (RuntimeException error) {
                // Do not permanently disable detection: a later capture may run after Android has
                // finished unlocking or after another transient initialization failure clears.
                lastStartFailureReason = "mlkit_init_error";
                Log.w(TAG, "ML Kit is not ready; preserving full frame", error);
                return null;
            }
        }
    }

    private static boolean isUserUnlocked(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return true;
        }
        UserManager userManager = context.getSystemService(UserManager.class);
        return userManager == null || userManager.isUserUnlocked();
    }

    private void handleWarmupCompletion(Task<Text> completedTask) {
        if (!completedTask.isSuccessful()) {
            warmupTask.compareAndSet(completedTask, null);
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
        Task<Text> detectionTask = null;
        try {
            warmUp();
            Task<Text> taskToAwait = warmupTask.get();
            if (taskToAwait != null) {
                try {
                    Tasks.await(
                            taskToAwait,
                            AsgConstants.TEXT_MODE_MLKIT_TIMEOUT_MS,
                            TimeUnit.MILLISECONDS);
                } catch (Throwable warmupError) {
                    // A transient model-init failure or timeout must not poison every later text
                    // capture. A timed-out task is still using the recognizer, so keep it until its
                    // completion listener runs rather than starting overlapping work.
                    handleWarmupAwaitFailure(taskToAwait);
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
            detectionTask = tryStartRecognizerProcess(InputImage.fromBitmap(analysis, 0));
            if (detectionTask == null) {
                String reason =
                        lastStartFailureReason != null ? lastStartFailureReason : "mlkit_busy";
                return Detection.fullFrame(
                        reason,
                        SystemClock.elapsedRealtime() - startMs,
                        sourceWidth,
                        sourceHeight);
            }
            Text text =
                    Tasks.await(
                            detectionTask,
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
            recycleBitmapsAfterTask(detectionTask, analysis, decoded);
        }
    }

    /** Keeps timed-out work registered until ML Kit actually completes it. */
    void handleWarmupAwaitFailure(Task<Text> awaitedTask) {
        if (awaitedTask.isComplete()) {
            warmupTask.compareAndSet(awaitedTask, null);
        }
    }

    /** Defers recycling when a timed-out ML Kit task may still be reading its input bitmap. */
    static void recycleBitmapsAfterTask(
            @Nullable Task<?> task, @Nullable Bitmap analysis, @Nullable Bitmap decoded) {
        if (task != null && !task.isComplete()) {
            task.addOnCompleteListener(
                    DIRECT_EXECUTOR, ignored -> recycleBitmaps(analysis, decoded));
            return;
        }
        recycleBitmaps(analysis, decoded);
    }

    private static void recycleBitmaps(@Nullable Bitmap analysis, @Nullable Bitmap decoded) {
        if (analysis != null && analysis != decoded) {
            analysis.recycle();
        }
        if (decoded != null) {
            decoded.recycle();
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
        synchronized (warmupTask) {
            if (!closed) {
                closed = true;
                synchronized (recognizerLock) {
                    if (recognizer != null) {
                        recognizer.close();
                        recognizer = null;
                    }
                }
            }
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
