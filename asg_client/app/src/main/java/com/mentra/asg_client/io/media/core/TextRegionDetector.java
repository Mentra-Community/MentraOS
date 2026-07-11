package com.mentra.asg_client.io.media.core;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Log;
import androidx.annotation.Nullable;

/**
 * Finds the text/document region of a photo so the BLE pipeline can crop to it instead of
 * spending its byte budget on background. Pure-Java edge-density analysis on a tiny (~320px)
 * grayscale decode - no ML, runs in ~10-20ms on the MTK8766.
 *
 * <p>Approach (per docs/agents/BLE_PHOTO_QUALITY_PLAN.md): Sobel gradient magnitude accumulated
 * into a coarse grid, then the bounding box of cells whose edge density clearly exceeds the
 * frame average, padded by 10%. Detection is deliberately conservative - cropping away real text
 * is far worse for OCR than sending some extra background - so it returns {@code null} (no crop)
 * whenever the signal is weak, spread across the whole frame, or the crop would barely shrink
 * the image.
 */
final class TextRegionDetector {
    private static final String TAG = "TextRegionDetector";

    /** Analysis raster cap; keeps Sobel + grid work trivial. */
    private static final int ANALYSIS_MAX_DIM = 320;

    private static final int GRID_COLS = 8;
    private static final int GRID_ROWS = 6;

    /** A cell counts as "text" when its mean gradient exceeds this multiple of the frame mean. */
    private static final float CELL_ACTIVATION_RATIO = 1.5f;

    /** Below this mean gradient (0..255 scale) the frame has no usable edge signal at all. */
    private static final float MIN_FRAME_MEAN_GRADIENT = 4f;

    /** Crops that keep more than this fraction of the frame area are not worth the risk. */
    private static final float MAX_USEFUL_AREA_FRACTION = 0.80f;

    /** Padding added around the detected bounding box, as a fraction of its size. */
    private static final float PADDING_FRACTION = 0.10f;

    private TextRegionDetector() {}

    /**
     * Returns the detected text region in source-pixel coordinates of {@code jpegPath}, or
     * {@code null} when no clearly concentrated edge region exists (caller should send the full
     * frame).
     */
    @Nullable
    static Rect detect(String jpegPath) {
        try {
            long start = System.currentTimeMillis();

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(jpegPath, bounds);
            int srcWidth = bounds.outWidth;
            int srcHeight = bounds.outHeight;
            if (srcWidth <= 0 || srcHeight <= 0) {
                return null;
            }

            int sampleSize = 1;
            while (srcWidth / (sampleSize * 2) >= ANALYSIS_MAX_DIM
                    && srcHeight / (sampleSize * 2) >= ANALYSIS_MAX_DIM) {
                sampleSize *= 2;
            }
            BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
            decodeOpts.inSampleSize = sampleSize;
            decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap decoded = BitmapFactory.decodeFile(jpegPath, decodeOpts);
            if (decoded == null) {
                return null;
            }

            int w = decoded.getWidth();
            int h = decoded.getHeight();
            byte[] luma = new byte[w * h];
            int[] row = new int[w];
            for (int y = 0; y < h; y++) {
                decoded.getPixels(row, 0, w, 0, y, w, 1);
                int off = y * w;
                for (int x = 0; x < w; x++) {
                    int px = row[x];
                    int r = (px >> 16) & 0xFF;
                    int g = (px >> 8) & 0xFF;
                    int b = px & 0xFF;
                    luma[off + x] = (byte) ((r * 66 + g * 129 + b * 25 + 128) >> 8);
                }
            }
            decoded.recycle();

            Rect analysisRect = detectOnLuma(luma, w, h);
            if (analysisRect == null) {
                Log.d(
                        TAG,
                        "No text region detected in "
                                + (System.currentTimeMillis() - start)
                                + "ms - sending full frame");
                return null;
            }

            // Map analysis coordinates back to source pixels.
            float scaleX = (float) srcWidth / w;
            float scaleY = (float) srcHeight / h;
            Rect srcRect =
                    new Rect(
                            Math.max(0, (int) (analysisRect.left * scaleX)),
                            Math.max(0, (int) (analysisRect.top * scaleY)),
                            Math.min(srcWidth, (int) Math.ceil(analysisRect.right * scaleX)),
                            Math.min(srcHeight, (int) Math.ceil(analysisRect.bottom * scaleY)));
            Log.d(
                    TAG,
                    "Text region "
                            + srcRect.width()
                            + "x"
                            + srcRect.height()
                            + " at ("
                            + srcRect.left
                            + ","
                            + srcRect.top
                            + ") of "
                            + srcWidth
                            + "x"
                            + srcHeight
                            + " ("
                            + Math.round(
                                    100f
                                            * srcRect.width()
                                            * srcRect.height()
                                            / ((float) srcWidth * srcHeight))
                            + "% area) in "
                            + (System.currentTimeMillis() - start)
                            + "ms");
            return srcRect;
        } catch (Exception | OutOfMemoryError e) {
            // Detection is an optimization; any failure means "send the full frame".
            Log.w(TAG, "Text region detection failed - sending full frame", e);
            return null;
        }
    }

    /**
     * Core detection on a luma raster; exposed for unit tests. Returns the padded bounding box in
     * raster coordinates, or {@code null} for "no crop".
     */
    @Nullable
    static Rect detectOnLuma(byte[] luma, int width, int height) {
        if (width < GRID_COLS * 2 || height < GRID_ROWS * 2) {
            return null;
        }

        // Sobel gradient magnitude accumulated per grid cell.
        long[] cellEnergy = new long[GRID_COLS * GRID_ROWS];
        long[] cellPixels = new long[GRID_COLS * GRID_ROWS];
        long totalEnergy = 0;
        for (int y = 1; y < height - 1; y++) {
            int rowOff = y * width;
            int cellRow = Math.min(GRID_ROWS - 1, y * GRID_ROWS / height);
            for (int x = 1; x < width - 1; x++) {
                int i = rowOff + x;
                int tl = luma[i - width - 1] & 0xFF;
                int t = luma[i - width] & 0xFF;
                int tr = luma[i - width + 1] & 0xFF;
                int l = luma[i - 1] & 0xFF;
                int r = luma[i + 1] & 0xFF;
                int bl = luma[i + width - 1] & 0xFF;
                int b = luma[i + width] & 0xFF;
                int br = luma[i + width + 1] & 0xFF;

                int gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
                int gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
                int mag = Math.abs(gx) + Math.abs(gy);

                int cellCol = Math.min(GRID_COLS - 1, x * GRID_COLS / width);
                int cell = cellRow * GRID_COLS + cellCol;
                cellEnergy[cell] += mag;
                cellPixels[cell]++;
                totalEnergy += mag;
            }
        }

        long totalPixels = (long) (width - 2) * (height - 2);
        float frameMean = totalEnergy / (float) totalPixels;
        if (frameMean < MIN_FRAME_MEAN_GRADIENT) {
            return null;
        }

        // Bounding box of activated cells.
        float threshold = frameMean * CELL_ACTIVATION_RATIO;
        int minCol = GRID_COLS;
        int maxCol = -1;
        int minRow = GRID_ROWS;
        int maxRow = -1;
        for (int cr = 0; cr < GRID_ROWS; cr++) {
            for (int cc = 0; cc < GRID_COLS; cc++) {
                int cell = cr * GRID_COLS + cc;
                if (cellPixels[cell] == 0) {
                    continue;
                }
                float mean = cellEnergy[cell] / (float) cellPixels[cell];
                if (mean >= threshold) {
                    if (cc < minCol) minCol = cc;
                    if (cc > maxCol) maxCol = cc;
                    if (cr < minRow) minRow = cr;
                    if (cr > maxRow) maxRow = cr;
                }
            }
        }
        if (maxCol < 0) {
            return null;
        }

        // Cell box -> pixel box.
        int left = minCol * width / GRID_COLS;
        int right = (maxCol + 1) * width / GRID_COLS;
        int top = minRow * height / GRID_ROWS;
        int bottom = (maxRow + 1) * height / GRID_ROWS;

        // 10% padding on each side.
        int padX = Math.round((right - left) * PADDING_FRACTION);
        int padY = Math.round((bottom - top) * PADDING_FRACTION);
        left = Math.max(0, left - padX);
        right = Math.min(width, right + padX);
        top = Math.max(0, top - padY);
        bottom = Math.min(height, bottom + padY);

        // Not worth cropping when the region is basically the whole frame.
        float areaFraction = (right - left) * (bottom - top) / ((float) width * height);
        if (areaFraction > MAX_USEFUL_AREA_FRACTION) {
            return null;
        }

        return new Rect(left, top, right, bottom);
    }
}
