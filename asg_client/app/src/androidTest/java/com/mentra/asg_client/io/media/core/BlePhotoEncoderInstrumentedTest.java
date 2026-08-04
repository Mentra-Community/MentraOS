package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On-device benchmark for the BLE payload encoders ({@link JpegFastBleEncoder} vs
 * {@link AvifBleEncoder}) - the exact code the camera pipeline runs in
 * {@code MediaCaptureService.compressAndSendViaBle}. Run on the glasses:
 *
 * <pre>./gradlew :app:connectedAndroidTest --tests "*BlePhotoEncoder*"</pre>
 *
 * <p>Input: drops a real capture named {@code blebench_input.jpg} into the app's external files
 * dir to benchmark it ({@code adb push photo.jpg
 * /sdcard/Android/data/com.mentra.asg_client/files/blebench_input.jpg}); without one the test
 * synthesizes a 4032x3024 text-page frame so it is self-contained. Encoded outputs are dumped
 * next to the input for visual/OCR inspection, and each config logs a summary row under the
 * {@code BleJpegBench} tag:
 *
 * <pre>BENCH | codec=... | input=WxH | output=WxH | q=.. | encode=..ms | total=..ms | bytes=..</pre>
 */
@RunWith(AndroidJUnit4.class)
public class BlePhotoEncoderInstrumentedTest {
    private static final String TAG = "BleJpegBench";

    private static File sourceJpeg;
    private static int sourceWidth;
    private static int sourceHeight;
    private static final List<String> summaryRows = new ArrayList<>();

    @BeforeClass
    public static void prepareSourceJpeg() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File filesDir = context.getExternalFilesDir(null);
        File pushed = new File(filesDir, "blebench_input.jpg");
        if (pushed.isFile()) {
            sourceJpeg = pushed;
            Log.i(TAG, "Using pushed test picture " + pushed.getAbsolutePath());
        } else {
            sourceJpeg = new File(filesDir, "blebench_synthetic.jpg");
            Bitmap page = renderSyntheticTextPage(4032, 3024);
            try (FileOutputStream fos = new FileOutputStream(sourceJpeg)) {
                assertTrue(page.compress(Bitmap.CompressFormat.JPEG, 95, fos));
            } finally {
                page.recycle();
            }
            Log.i(TAG, "Synthesized test picture " + sourceJpeg.getAbsolutePath());
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(sourceJpeg.getAbsolutePath(), bounds);
        sourceWidth = bounds.outWidth;
        sourceHeight = bounds.outHeight;
        Log.i(TAG, "Benchmark input: " + sourceWidth + "x" + sourceHeight);
    }

    @Test
    public void benchmarkFullResolutionJpegQ75() throws Exception {
        runConfig("full_q75", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 75);
    }

    @Test
    public void benchmarkFullResolutionJpegQ80() throws Exception {
        runConfig("full_q80", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 80);
    }

    @Test
    public void benchmarkFullResolutionJpegQ85() throws Exception {
        runConfig("full_q85", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 85);
    }

    @Test
    public void benchmarkFullResolutionJpegQ90() throws Exception {
        runConfig("full_q90", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 90);
    }

    @Test
    public void benchmarkFullResolutionJpegQ95() throws Exception {
        runConfig("full_q95", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 95);
    }

    @Test
    public void benchmarkFullResolutionJpegQ100() throws Exception {
        runConfig("full_q100", BleCodec.JPEG_FAST, Integer.MAX_VALUE, 100);
    }

    @Test
    public void benchmark1280JpegQ75() throws Exception {
        runConfig("1280_q75", BleCodec.JPEG_FAST, 1280, 75);
    }

    @Test
    public void benchmark960JpegQ75() throws Exception {
        runConfig("960_q75", BleCodec.JPEG_FAST, 960, 75);
    }

    @Test
    public void benchmark960JpegQ70() throws Exception {
        runConfig("960_q70", BleCodec.JPEG_FAST, 960, 70);
    }

    @Test
    public void benchmarkCurrentTextModeCropConfig() throws Exception {
        // A detected text crop preserves more spatial detail for small text.
        runConfig(
                "2880_jpeg_q80",
                BleCodec.JPEG_FAST,
                AsgConstants.TEXT_MODE_BLE_TARGET_WIDTH,
                AsgConstants.BLE_PHOTO_JPEG_FAST_QUALITY);
    }

    @Test
    public void benchmarkCurrentTextModeFallbackConfig() throws Exception {
        // A full-frame fallback retains the previous BLE transfer bound.
        runConfig(
                "1920_jpeg_q80",
                BleCodec.JPEG_FAST,
                AsgConstants.TEXT_MODE_BLE_FALLBACK_TARGET_WIDTH,
                AsgConstants.BLE_PHOTO_JPEG_FAST_QUALITY);
    }

    @Test
    public void zzz_printSummaryTable() {
        // Named to run last under the default method ordering; rows from earlier tests in the
        // same instrumentation run accumulate in summaryRows.
        Log.i(TAG, "==== BLE encoder benchmark summary ====");
        Log.i(TAG, "codec | input | output | quality | encode_ms | total_ms | bytes");
        for (String row : summaryRows) {
            Log.i(TAG, row);
        }
    }

    /**
     * Mirrors the production pipeline: subsampled decode from the source JPEG, aspect-preserving
     * scale so the long edge fits {@code maxDimension}, then the selected encoder. Sharpening is
     * skipped here on purpose - it is orthogonal to codec choice and measured separately by the
     * pipeline's own COMPRESS stage logs.
     */
    private static void runConfig(String label, BleCodec codec, int maxDimension, int quality)
            throws Exception {
        long totalStart = System.currentTimeMillis();

        int targetLongEdge = Math.min(maxDimension, Math.max(sourceWidth, sourceHeight));
        int sample = 1;
        while (Math.max(sourceWidth, sourceHeight) / (sample * 2) >= targetLongEdge) {
            sample *= 2;
        }
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap decoded = BitmapFactory.decodeFile(sourceJpeg.getAbsolutePath(), opts);
        assertTrue("decode failed", decoded != null);

        Bitmap processed;
        if (Math.max(decoded.getWidth(), decoded.getHeight()) > targetLongEdge) {
            float scale = targetLongEdge / (float) Math.max(decoded.getWidth(), decoded.getHeight());
            processed =
                    Bitmap.createScaledBitmap(
                            decoded,
                            Math.max(1, Math.round(decoded.getWidth() * scale)),
                            Math.max(1, Math.round(decoded.getHeight() * scale)),
                            true);
            if (processed != decoded) {
                decoded.recycle();
            }
        } else {
            processed = decoded;
        }

        BlePhotoEncoder.EncodeResult result;
        try {
            result =
                    BlePhotoEncoders.forCodec(codec)
                            .encode(processed, quality, sourceJpeg.getAbsolutePath());
        } finally {
            int outWidth = processed.getWidth();
            int outHeight = processed.getHeight();
            processed.recycle();
            Log.d(TAG, label + ": processed bitmap was " + outWidth + "x" + outHeight);
        }
        long totalMs = System.currentTimeMillis() - totalStart;

        File out =
                new File(
                        sourceJpeg.getParentFile(),
                        "blebench_" + label + (codec == BleCodec.AVIF ? ".avif" : ".jpg"));
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(result.data);
        }

        String row =
                String.format(
                        Locale.US,
                        "BENCH | codec=%s | input=%dx%d | output(long_edge)=%d | q=%d | encode=%dms | total=%dms | bytes=%d | file=%s",
                        result.codecUsed,
                        sourceWidth,
                        sourceHeight,
                        targetLongEdge,
                        quality,
                        result.encodeMs,
                        totalMs,
                        result.data.length,
                        out.getName());
        summaryRows.add(row);
        Log.i(TAG, row);
        assertTrue("empty payload", result.data.length > 0);
    }

    /** White page filled with black and colored text rows - a worst-ish case for text encoding. */
    private static Bitmap renderSyntheticTextPage(int width, int height) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTextSize(64);
        paint.setTypeface(android.graphics.Typeface.MONOSPACE);
        String line = "The quick brown fox jumps over the lazy dog 0123456789 !@#$%^&*()";
        int[] colors = {Color.BLACK, Color.BLACK, Color.BLACK, Color.rgb(180, 0, 0), Color.rgb(0, 0, 160)};
        int y = 96;
        int i = 0;
        while (y < height - 32) {
            paint.setColor(colors[i % colors.length]);
            canvas.drawText(line, 32 + (i % 7) * 12, y, paint);
            y += 88;
            i++;
        }
        return bitmap;
    }
}
