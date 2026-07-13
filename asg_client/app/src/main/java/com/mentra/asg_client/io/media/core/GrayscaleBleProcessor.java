package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Log;
import androidx.annotation.Nullable;
import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import java.io.IOException;

/**
 * Phase 1 of the BLE photo pipeline rework: decode the source JPEG straight into a single-channel
 * luma ("Y plane") buffer, crop to a region of interest, apply a contrast stretch + mild unsharp,
 * and only rehydrate to a full RGBA {@link Bitmap} at the very last step for the AVIF encoder
 * (which only accepts {@link Bitmap} input).
 *
 * <p>This targets photos that exist to be read (documents, signs, screens) rather than viewed -
 * color contributes nothing to legibility, so every intermediate buffer here is 1 byte/pixel
 * instead of the 4 bytes/pixel the old ARGB decode -> resize -> sharpen chain used. That's where
 * the previous pipeline spent most of its ~35MB peak per photo.
 *
 * <p>Chroma is never allocated on our side, but the AVIF encoder itself still emits a YUV420
 * (color) bitstream internally - true YUV400-only encode requires a native libavif/libaom shim
 * that this library doesn't expose (Phase 2, out of scope here). The wire-size win from skipping
 * chroma is small regardless (flat chroma planes already compress to near-nothing in AV1); the
 * real payoff of this pass is the ~3x RAM reduction and matching increase in decode/encode speed.
 */
final class GrayscaleBleProcessor {
    private static final String TAG = "GrayscaleBleProcessor";

    // Same Laplacian-based unsharp weights as BleImageSharpener, ported to single-channel luma.
    private static final int CENTER_W = 34;
    private static final int NEIGHBOR_W = 6;
    private static final int SCALE = 10;

    private GrayscaleBleProcessor() {}

    /**
     * Decode {@code jpegPath}, crop to {@code roi} (source-pixel coordinates; {@code null} means
     * full frame - Phase 2 wires a real ROI in here from edge-density analysis), apply a contrast
     * stretch + unsharp, and scale to fit within {@code targetWidth}x{@code targetHeight}
     * (aspect-preserving, same semantics as the caps in {@code resolveBleParams}). Returns a
     * grayscale (R=G=B) bitmap ready for {@link PhotoExifMetadataWriter#encodeAvifForBle}; caller
     * owns recycling it.
     */
    static Bitmap process(String jpegPath, @Nullable Rect roi, int targetWidth, int targetHeight)
            throws IOException {
        long start = System.currentTimeMillis();

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(jpegPath, bounds);
        int srcWidth = bounds.outWidth;
        int srcHeight = bounds.outHeight;
        if (srcWidth <= 0 || srcHeight <= 0) {
            throw new IOException("Failed to read JPEG bounds: " + jpegPath);
        }

        Rect region =
                (roi != null) ? clampRect(roi, srcWidth, srcHeight) : new Rect(0, 0, srcWidth, srcHeight);

        // Decode at the smallest power-of-two sample size that still comfortably covers the
        // target resolution - we never materialize a full-res ARGB bitmap here.
        int sampleSize = computeSampleSize(region.width(), region.height(), targetWidth, targetHeight);

        BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
        decodeOpts.inSampleSize = sampleSize;
        // Source JPEG has no alpha; RGB_565 halves decode memory vs ARGB_8888 (2B/px vs 4B/px)
        // and loses nothing we need since we reduce to luma immediately below.
        decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap decoded = BitmapFactory.decodeFile(jpegPath, decodeOpts);
        if (decoded == null) {
            throw new IOException("Failed to decode JPEG: " + jpegPath);
        }

        float scale = 1f / sampleSize;
        Rect scaledRegion =
                clampRect(
                        new Rect(
                                (int) (region.left * scale),
                                (int) (region.top * scale),
                                (int) (region.right * scale),
                                (int) (region.bottom * scale)),
                        decoded.getWidth(),
                        decoded.getHeight());

        byte[] luma = extractCroppedLuma(decoded, scaledRegion);
        decoded.recycle();

        int lumaWidth = scaledRegion.width();
        int lumaHeight = scaledRegion.height();

        applyContrastStretch(luma, lumaWidth, lumaHeight);

        int[] outDims = fitWithinAspect(lumaWidth, lumaHeight, targetWidth, targetHeight);
        byte[] resized = resizeLumaBilinear(luma, lumaWidth, lumaHeight, outDims[0], outDims[1]);
        byte[] sharpened = unsharpLuma(resized, outDims[0], outDims[1]);

        Bitmap gray = lumaToGrayscaleBitmap(sharpened, outDims[0], outDims[1]);

        Log.d(
                TAG,
                "GrayscaleBleProcessor: "
                        + srcWidth
                        + "x"
                        + srcHeight
                        + " -> crop "
                        + lumaWidth
                        + "x"
                        + lumaHeight
                        + " -> out "
                        + outDims[0]
                        + "x"
                        + outDims[1]
                        + " in "
                        + (System.currentTimeMillis() - start)
                        + "ms");
        return gray;
    }

    private static Rect clampRect(Rect r, int width, int height) {
        int left = clampInt(r.left, 0, width - 1);
        int top = clampInt(r.top, 0, height - 1);
        int right = clampInt(r.right, left + 1, width);
        int bottom = clampInt(r.bottom, top + 1, height);
        return new Rect(left, top, right, bottom);
    }

    private static int computeSampleSize(
            int regionWidth, int regionHeight, int targetWidth, int targetHeight) {
        int sample = 1;
        while ((regionWidth / (sample * 2)) >= targetWidth
                && (regionHeight / (sample * 2)) >= targetHeight) {
            sample *= 2;
        }
        return sample;
    }

    /** Reads one decoded-bitmap row at a time (width-sized int[]) - never a full-frame int[]. */
    private static byte[] extractCroppedLuma(Bitmap bitmap, Rect region) {
        int width = region.width();
        int height = region.height();
        byte[] luma = new byte[width * height];
        int[] row = new int[width];
        for (int y = 0; y < height; y++) {
            bitmap.getPixels(row, 0, width, region.left, region.top + y, width, 1);
            int rowOffset = y * width;
            for (int x = 0; x < width; x++) {
                int px = row[x];
                int r = (px >> 16) & 0xFF;
                int g = (px >> 8) & 0xFF;
                int b = px & 0xFF;
                // BT.601 luma weights - matches the camera's own YUV luma convention.
                luma[rowOffset + x] = (byte) ((r * 66 + g * 129 + b * 25 + 128) >> 8);
            }
        }
        return luma;
    }

    /** In-place min/max stretch; skipped on near-flat/noisy frames to avoid amplifying noise. */
    private static void applyContrastStretch(byte[] luma, int width, int height) {
        int min = 255;
        int max = 0;
        for (byte v : luma) {
            int value = v & 0xFF;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        int range = max - min;
        if (range < 16) {
            return;
        }
        float scale = 255f / range;
        for (int i = 0; i < luma.length; i++) {
            int v = Math.round(((luma[i] & 0xFF) - min) * scale);
            luma[i] = (byte) clampInt(v, 0, 255);
        }
    }

    private static int[] fitWithinAspect(int width, int height, int targetWidth, int targetHeight) {
        float aspect = (float) width / height;
        int outWidth = targetWidth;
        int outHeight = targetHeight;
        if (aspect > (float) targetWidth / targetHeight) {
            outHeight = Math.max(1, Math.round(targetWidth / aspect));
        } else {
            outWidth = Math.max(1, Math.round(targetHeight * aspect));
        }
        return new int[] {outWidth, outHeight};
    }

    private static byte[] resizeLumaBilinear(
            byte[] src, int srcWidth, int srcHeight, int dstWidth, int dstHeight) {
        if (srcWidth == dstWidth && srcHeight == dstHeight) {
            return src;
        }
        byte[] dst = new byte[dstWidth * dstHeight];
        float xRatio = (float) srcWidth / dstWidth;
        float yRatio = (float) srcHeight / dstHeight;
        for (int y = 0; y < dstHeight; y++) {
            float sy = (y + 0.5f) * yRatio - 0.5f;
            int y0 = clampInt((int) Math.floor(sy), 0, srcHeight - 1);
            int y1 = clampInt(y0 + 1, 0, srcHeight - 1);
            float fy = sy - y0;
            int rowOffset0 = y0 * srcWidth;
            int rowOffset1 = y1 * srcWidth;
            int dstRowOffset = y * dstWidth;
            for (int x = 0; x < dstWidth; x++) {
                float sx = (x + 0.5f) * xRatio - 0.5f;
                int x0 = clampInt((int) Math.floor(sx), 0, srcWidth - 1);
                int x1 = clampInt(x0 + 1, 0, srcWidth - 1);
                float fx = sx - x0;

                int p00 = src[rowOffset0 + x0] & 0xFF;
                int p10 = src[rowOffset0 + x1] & 0xFF;
                int p01 = src[rowOffset1 + x0] & 0xFF;
                int p11 = src[rowOffset1 + x1] & 0xFF;

                float top = p00 + (p10 - p00) * fx;
                float bottom = p01 + (p11 - p01) * fx;
                int v = Math.round(top + (bottom - top) * fy);
                dst[dstRowOffset + x] = (byte) clampInt(v, 0, 255);
            }
        }
        return dst;
    }

    /**
     * Single-channel port of {@link BleImageSharpener}'s Laplacian unsharp: identity + 0.6x
     * Laplacian, tuned for text strokes after a downscale. Border pixels copy through unchanged.
     */
    private static byte[] unsharpLuma(byte[] src, int width, int height) {
        if (width < 3 || height < 3) {
            return src;
        }
        byte[] dst = new byte[width * height];
        System.arraycopy(src, 0, dst, 0, width);
        System.arraycopy(src, (height - 1) * width, dst, (height - 1) * width, width);

        for (int y = 1; y < height - 1; y++) {
            int row = y * width;
            dst[row] = src[row];
            dst[row + width - 1] = src[row + width - 1];
            for (int x = 1; x < width - 1; x++) {
                int i = row + x;
                int c = src[i] & 0xFF;
                int l = src[i - 1] & 0xFF;
                int r = src[i + 1] & 0xFF;
                int u = src[i - width] & 0xFF;
                int d = src[i + width] & 0xFF;

                int v = (c * CENTER_W - (l + r + u + d) * NEIGHBOR_W) / SCALE;
                dst[i] = (byte) clampInt(v, 0, 255);
            }
        }
        return dst;
    }

    /** Builds the output bitmap one row at a time - never allocates a full-frame int[]. */
    private static Bitmap lumaToGrayscaleBitmap(byte[] luma, int width, int height) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        int[] row = new int[width];
        for (int y = 0; y < height; y++) {
            int offset = y * width;
            for (int x = 0; x < width; x++) {
                int v = luma[offset + x] & 0xFF;
                row[x] = 0xFF000000 | (v << 16) | (v << 8) | v;
            }
            bitmap.setPixels(row, 0, width, 0, y, width, 1);
        }
        return bitmap;
    }

    /**
     * Result of {@link #extractDetectionLuma}: a subsampled full-frame luma buffer plus the
     * true source-JPEG dimensions, so a caller running detection on this buffer can scale the
     * returned crop back up to source-pixel coordinates via {@link #scaleDetectionRoi}.
     *
     * <p>{@code srcWidth}/{@code srcHeight} are carried explicitly because {@code
     * BitmapFactory.inSampleSize} decoding uses integer division — the decoded dimensions are
     * often not exactly {@code src / sampleSize}, so multiplying back by {@code sampleSize}
     * would misalign the crop.
     */
    static final class DetectionLuma {
        final byte[] luma;
        final int width;
        final int height;
        final int sampleSize;
        final int srcWidth;
        final int srcHeight;

        DetectionLuma(
                byte[] luma, int width, int height, int sampleSize, int srcWidth, int srcHeight) {
            this.luma = luma;
            this.width = width;
            this.height = height;
            this.sampleSize = sampleSize;
            this.srcWidth = srcWidth;
            this.srcHeight = srcHeight;
        }
    }

    /**
     * Decodes {@code jpegPath} at the smallest sample size that still comfortably covers {@code
     * analysisWidth}, then reduces it to a single-channel luma buffer. Used to feed {@code
     * TextRegionDetector} a small analysis frame without ever allocating a full-resolution
     * bitmap. Independent of {@link #process}, which performs its own separate decode.
     */
    static DetectionLuma extractDetectionLuma(String jpegPath, int analysisWidth) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(jpegPath, bounds);
        int srcWidth = bounds.outWidth;
        int srcHeight = bounds.outHeight;
        if (srcWidth <= 0 || srcHeight <= 0) {
            throw new IOException("Failed to read JPEG bounds: " + jpegPath);
        }

        // computeSampleSize doubles the sample size while both dimensions stay >= target; passing
        // targetHeight=1 makes that condition a no-op for height (real photos are far from 1px
        // tall at any sane sample size), so the loop is effectively driven by analysisWidth alone
        // while inSampleSize decoding preserves aspect ratio for us.
        int sampleSize = computeSampleSize(srcWidth, srcHeight, analysisWidth, 1);

        BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
        decodeOpts.inSampleSize = sampleSize;
        decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap decoded = BitmapFactory.decodeFile(jpegPath, decodeOpts);
        if (decoded == null) {
            throw new IOException("Failed to decode JPEG: " + jpegPath);
        }

        int width = decoded.getWidth();
        int height = decoded.getHeight();
        Rect fullFrame = new Rect(0, 0, width, height);
        byte[] luma = extractCroppedLuma(decoded, fullFrame);
        decoded.recycle();

        return new DetectionLuma(luma, width, height, sampleSize, srcWidth, srcHeight);
    }

    /**
     * Scales a {@code TextRegionDetector} crop (computed against the subsampled dimensions
     * returned by {@link #extractDetectionLuma}) back up to true source-JPEG pixel coordinates.
     *
     * <p>Uses the actual decoded-to-source dimension ratio rather than multiplying by {@code
     * sampleSize}: {@code BitmapFactory.inSampleSize} decoding rounds dimensions with integer
     * division, so {@code decoded * sampleSize} can overshoot the real source size and misalign
     * the crop. The result is clamped to the source bounds.
     */
    static Rect scaleDetectionRoi(CropRect roi, DetectionLuma input) {
        float scaleX = input.srcWidth / (float) Math.max(1, input.width);
        float scaleY = input.srcHeight / (float) Math.max(1, input.height);
        int left = clampInt(Math.round(roi.left * scaleX), 0, input.srcWidth - 1);
        int top = clampInt(Math.round(roi.top * scaleY), 0, input.srcHeight - 1);
        int right = clampInt(Math.round(roi.right * scaleX), left + 1, input.srcWidth);
        int bottom = clampInt(Math.round(roi.bottom * scaleY), top + 1, input.srcHeight);
        return new Rect(left, top, right, bottom);
    }

    private static int clampInt(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }
}
