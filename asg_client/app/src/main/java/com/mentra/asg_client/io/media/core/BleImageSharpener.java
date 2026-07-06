package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.graphics.Bitmap;
import android.util.Log;

/**
 * Mild unsharp pass applied after downscaling BLE photos. Downscaling low-pass-filters the image,
 * which is what turns photographed text mushy; restoring some edge contrast before the AVIF encode
 * measurably improves glyph legibility at near-zero byte cost.
 *
 * <p>Pure-Java convolution on int[] pixels. The RenderScript convolve intrinsic looked like the
 * obvious tool but its bitmap-backed Allocation SIGSEGVs natively on the K900 (deprecated runtime,
 * ABitmap_getPixels fault) and a native crash kills the whole service - no Java fallback can catch
 * it. ~100ms at 1280px on the K900's cores, negligible inside the multi-second photo pipeline.
 */
final class BleImageSharpener {
    private static final String TAG = "BleImageSharpener";

    // Identity + 0.6x Laplacian (plus-shaped, corners zero), sums to 1.0:
    // moderate sharpen tuned for text strokes after a bilinear downscale.
    // Fixed-point x10: out = (34*center - 6*(left+right+up+down)) / 10.
    private static final int CENTER_W = 34;
    private static final int NEIGHBOR_W = 6;
    private static final int SCALE = 10;

    private BleImageSharpener() {}

    /**
     * Returns a sharpened copy of {@code src} (recycling is the caller's concern for both), or
     * {@code src} itself if sharpening is unavailable.
     */
    static Bitmap sharpen(Context context, Bitmap src) {
        try {
            long start = System.currentTimeMillis();
            int w = src.getWidth();
            int h = src.getHeight();
            if (w < 3 || h < 3) {
                return src;
            }

            int[] in = new int[w * h];
            src.getPixels(in, 0, w, 0, 0, w, h);
            int[] out = new int[w * h];
            // Border rows/cols copy through (no full neighborhood there).
            System.arraycopy(in, 0, out, 0, w);
            System.arraycopy(in, (h - 1) * w, out, (h - 1) * w, w);

            for (int y = 1; y < h - 1; y++) {
                int row = y * w;
                out[row] = in[row];
                out[row + w - 1] = in[row + w - 1];
                for (int x = 1; x < w - 1; x++) {
                    int i = row + x;
                    int c = in[i];
                    int l = in[i - 1];
                    int r = in[i + 1];
                    int u = in[i - w];
                    int d = in[i + w];

                    int cr =
                            ((c >> 16) & 0xFF) * CENTER_W
                                    - (((l >> 16) & 0xFF)
                                                    + ((r >> 16) & 0xFF)
                                                    + ((u >> 16) & 0xFF)
                                                    + ((d >> 16) & 0xFF))
                                            * NEIGHBOR_W;
                    int cg =
                            ((c >> 8) & 0xFF) * CENTER_W
                                    - (((l >> 8) & 0xFF)
                                                    + ((r >> 8) & 0xFF)
                                                    + ((u >> 8) & 0xFF)
                                                    + ((d >> 8) & 0xFF))
                                            * NEIGHBOR_W;
                    int cb =
                            (c & 0xFF) * CENTER_W
                                    - ((l & 0xFF) + (r & 0xFF) + (u & 0xFF) + (d & 0xFF))
                                            * NEIGHBOR_W;

                    cr /= SCALE;
                    cg /= SCALE;
                    cb /= SCALE;
                    if (cr < 0) cr = 0;
                    else if (cr > 255) cr = 255;
                    if (cg < 0) cg = 0;
                    else if (cg > 255) cg = 255;
                    if (cb < 0) cb = 0;
                    else if (cb > 255) cb = 255;

                    out[i] = (c & 0xFF000000) | (cr << 16) | (cg << 8) | cb;
                }
            }

            Bitmap.Config config = src.getConfig();
            if (config == null) {
                config = Bitmap.Config.ARGB_8888;
            }
            Bitmap result = Bitmap.createBitmap(w, h, config);
            result.setPixels(out, 0, w, 0, 0, w, h);
            Log.d(
                    TAG,
                    "Unsharp pass "
                            + w
                            + "x"
                            + h
                            + " in "
                            + (System.currentTimeMillis() - start)
                            + "ms");
            return result;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "Sharpen unavailable, sending unsharpened image", e);
            return src;
        }
    }
}
