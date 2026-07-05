package com.mentra.asg_client.io.media.core;

import android.content.Context;
import android.graphics.Bitmap;
import android.renderscript.Allocation;
import android.renderscript.Element;
import android.renderscript.RenderScript;
import android.renderscript.ScriptIntrinsicConvolve3x3;
import android.util.Log;

/**
 * Mild unsharp pass applied after downscaling BLE photos. Downscaling low-pass-filters the image,
 * which is what turns photographed text mushy; restoring some edge contrast before the AVIF encode
 * measurably improves glyph legibility at near-zero byte cost.
 *
 * <p>Uses the RenderScript convolve intrinsic (deprecated but present and GPU-fast on the K900's
 * API level). Any failure falls back to returning the input bitmap untouched - sharpening is an
 * enhancement, never a dependency.
 */
final class BleImageSharpener {
    private static final String TAG = "BleImageSharpener";

    // Identity + 0.6x Laplacian, sums to 1.0: moderate sharpen tuned for text
    // strokes after a bilinear downscale. If halos show up on hardware, drop the
    // corner weight to 0.4 (center 2.6).
    private static final float[] UNSHARP_KERNEL = {
        0f, -0.6f, 0f,
        -0.6f, 3.4f, -0.6f,
        0f, -0.6f, 0f,
    };

    private BleImageSharpener() {}

    /**
     * Returns a sharpened copy of {@code src} (recycling is the caller's concern for both), or
     * {@code src} itself if sharpening is unavailable.
     */
    static Bitmap sharpen(Context context, Bitmap src) {
        RenderScript rs = null;
        Allocation in = null;
        Allocation out = null;
        try {
            rs = RenderScript.create(context);
            Bitmap result = Bitmap.createBitmap(src.getWidth(), src.getHeight(), src.getConfig());
            in = Allocation.createFromBitmap(rs, src);
            out = Allocation.createFromBitmap(rs, result);
            ScriptIntrinsicConvolve3x3 convolve =
                    ScriptIntrinsicConvolve3x3.create(rs, Element.U8_4(rs));
            convolve.setCoefficients(UNSHARP_KERNEL);
            convolve.setInput(in);
            convolve.forEach(out);
            out.copyTo(result);
            return result;
        } catch (Exception | UnsatisfiedLinkError e) {
            Log.w(TAG, "Sharpen unavailable, sending unsharpened image", e);
            return src;
        } finally {
            if (in != null) in.destroy();
            if (out != null) out.destroy();
            if (rs != null) rs.destroy();
        }
    }
}
