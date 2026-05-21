package com.mentra.asg_client.camera.policy;

import android.hardware.camera2.params.MeteringRectangle;
import android.util.Size;

/**
 * Phase 3.1: pure-logic helper for AE/AF metering rectangles.
 *
 * <p>Consolidates the three previously inlined copies (preview-AF in
 * {@link CameraNeoService#createCameraSessionInternal(boolean)}, still-AF in
 * {@link StillCaptureBuilder#configureFocusAndMetering}, and the full-image preview-AE region)
 * into one place. Pure math, fully unit-testable.
 *
 * <p>The "center-weighted" region matches the historical formula: square region of edge
 * {@code min(width, height) / 3}, centered, clamped to image bounds, with
 * {@link MeteringRectangle#METERING_WEIGHT_MAX} weight.
 */
public final class MeteringRegions {

    private MeteringRegions() {}

    /**
     * Center 1/3 region with maximum weight, clamped to image bounds.
     *
     * <p>Returns {@code null} when {@code imageSize} is null so callers can no-op without an
     * extra branch.
     */
    public static MeteringRectangle[] centerWeighted(Size imageSize) {
        if (imageSize == null) {
            return null;
        }
        int w = imageSize.getWidth();
        int h = imageSize.getHeight();
        int centerX = w / 2;
        int centerY = h / 2;
        int regionSize = Math.min(w, h) / 3;
        int left = Math.max(0, centerX - regionSize / 2);
        int top = Math.max(0, centerY - regionSize / 2);
        int right = Math.min(w - 1, centerX + regionSize / 2);
        int bottom = Math.min(h - 1, centerY + regionSize / 2);
        return new MeteringRectangle[]{
            new MeteringRectangle(left, top, right - left, bottom - top,
                                  MeteringRectangle.METERING_WEIGHT_MAX)
        };
    }

    /** Full-image region with maximum weight (used by preview AE on the photo path). */
    public static MeteringRectangle[] fullImage(Size imageSize) {
        if (imageSize == null) {
            return null;
        }
        return new MeteringRectangle[]{
            new MeteringRectangle(0, 0, imageSize.getWidth(), imageSize.getHeight(),
                                  MeteringRectangle.METERING_WEIGHT_MAX)
        };
    }
}
