package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CaptureRequest;
import android.util.Range;

/**
 * Phase 2d: pure-logic helper that stamps one HDR-burst bracket onto a
 * {@link StillCaptureBuilder.Sink}. Extracted from {@link CameraNeoService#captureHdrBurst()} so the
 * recipe is unit-testable without standing up a real {@code CameraCaptureSession}.
 *
 * <p>The current burst recipe (matching the inline code that previously lived in
 * {@code captureHdrBurst()}):
 * <ul>
 *   <li>AE on + locked (consistent base across all brackets),</li>
 *   <li>per-bracket EV compensation (under/normal/over),</li>
 *   <li>AWB auto,</li>
 *   <li>fixed FPS range, continuous-picture AF when supported,</li>
 *   <li>high-quality NR/Edge,</li>
 *   <li>JPEG quality + orientation supplied by caller.</li>
 * </ul>
 *
 * <p>The caller is responsible for adding the still surface as a capture target before invoking,
 * applying vendor-specific {@code CameraSettings.configureCaptureBuilder(...)} (ZSL/MFNR), and
 * driving the actual {@code captureBurst(...)} call against the session.
 */
public final class HdrBurstBuilder {

    /** Number of frames in the HDR burst. */
    public static final int HDR_BURST_COUNT = 3;

    /** Exposure compensation values, in EV, for the brackets (under, normal, over). */
    public static final int[] HDR_EV_BRACKETS = {-2, 0, 2};

    private HdrBurstBuilder() {}

    /**
     * Configure a single HDR bracket onto the supplied sink.
     *
     * @param sink target builder/recorder.
     * @param evCompensation per-bracket exposure compensation in EV. Must come from
     *                       {@link #HDR_EV_BRACKETS} in production.
     * @param selectedFpsRange caller's locked FPS range (nullable — when null, the key is skipped).
     * @param hasAutoFocus whether the device supports autofocus.
     * @param jpegQuality JPEG compression quality (0-100; cast to byte).
     * @param jpegOrientation JPEG EXIF orientation tag.
     */
    public static void configureBracket(StillCaptureBuilder.Sink sink,
                                         int evCompensation,
                                         Range<Integer> selectedFpsRange,
                                         boolean hasAutoFocus,
                                         int jpegQuality,
                                         int jpegOrientation) {
        sink.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
        sink.set(CaptureRequest.CONTROL_AE_LOCK, true);
        sink.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
        sink.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evCompensation);
        if (selectedFpsRange != null) {
            sink.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, selectedFpsRange);
        }
        if (hasAutoFocus) {
            sink.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
        }
        sink.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
        sink.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
        sink.set(CaptureRequest.JPEG_QUALITY, (byte) jpegQuality);
        sink.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation);
    }

    /**
     * Resolve the on-disk filename suffix for a given bracket index ({@code "ev-2"}, {@code "ev0"},
     * {@code "ev2"}). Clamps out-of-range indices to the last bracket — matches the historical
     * {@code HDR_EV_BRACKETS[Math.min(frameIdx, HDR_EV_BRACKETS.length - 1)]} behavior.
     */
    public static String bracketFileSuffix(int frameIdx) {
        int idx = Math.min(Math.max(frameIdx, 0), HDR_EV_BRACKETS.length - 1);
        return "ev" + HDR_EV_BRACKETS[idx];
    }
}
