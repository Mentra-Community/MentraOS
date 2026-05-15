package com.mentra.asg_client.camera.request;

import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.MeteringRectangle;
import android.util.Range;
import android.util.Size;

import com.mentra.asg_client.camera.policy.MeteringRegions;

/**
 * Phase 2c: pure-logic helper that stamps the still-capture recipe onto a {@link Sink}.
 *
 * <p>Extracted from {@link CameraNeoService#capturePhoto()} so the recipe is unit-testable without
 * mocking the {@code final} {@link CaptureRequest.Builder} (which Robolectric + Mockito's inline
 * mock maker cannot agree on). Production code wraps a real {@link CaptureRequest.Builder} via
 * {@link #wrap(CaptureRequest.Builder)}; tests pass any test double that implements {@link Sink}.
 *
 * <p>The helper has no service-level state, never touches the {@code CameraCaptureSession}, and
 * is byte-for-byte equivalent to the inline code that used to live in {@code capturePhoto()} —
 * verified by {@link com.mentra.asg_client.camera.StillCaptureBuilderTest}. The caller is still
 * responsible for:
 * <ul>
 *   <li>adding capture targets (preview/still surfaces) before invoking,</li>
 *   <li>applying vendor-specific {@code CameraSettings.configureCaptureBuilder(...)} on the
 *       auto-exposure path (skipped for manual since manual SENSOR_* keys conflict with the
 *       vendor MFNR pipeline), and</li>
 *   <li>calling {@code builder.build()} + {@code session.capture(...)}.</li>
 * </ul>
 */
public final class StillCaptureBuilder {

    private StillCaptureBuilder() {}

    /**
     * Minimal abstraction over {@link CaptureRequest.Builder#set} so tests can record key/value
     * pairs without instantiating or mocking a real {@code Builder}.
     */
    public interface Sink {
        <T> void set(CaptureRequest.Key<T> key, T value);
    }

    /** Wrap a real {@link CaptureRequest.Builder} as a {@link Sink}. */
    public static Sink wrap(CaptureRequest.Builder builder) {
        return new Sink() {
            @Override
            public <T> void set(CaptureRequest.Key<T> key, T value) {
                builder.set(key, value);
            }
        };
    }

    /**
     * Configure exposure-related keys on the still-capture sink.
     *
     * <p>Manual path: AE off, explicit SENSOR_EXPOSURE_TIME / SENSOR_SENSITIVITY /
     * SENSOR_FRAME_DURATION, AWB still auto.
     *
     * <p>Auto path: AE on + locked, AWB auto, user EV compensation, fixed FPS range.
     */
    public static void configureExposure(Sink sink,
                                   boolean useManual,
                                   long manualClampedNs,
                                   int manualIso,
                                   long manualFrameDurationNs,
                                   int userExposureCompensation,
                                   Range<Integer> selectedFpsRange) {
        if (useManual) {
            sink.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
            sink.set(CaptureRequest.SENSOR_EXPOSURE_TIME, manualClampedNs);
            sink.set(CaptureRequest.SENSOR_SENSITIVITY, manualIso);
            sink.set(CaptureRequest.SENSOR_FRAME_DURATION, manualFrameDurationNs);
            sink.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
        } else {
            sink.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            sink.set(CaptureRequest.CONTROL_AE_LOCK, true);
            sink.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
            sink.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, userExposureCompensation);
            if (selectedFpsRange != null) {
                sink.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, selectedFpsRange);
            }
        }
    }

    /**
     * Configure autofocus mode and a center-weighted AF region (and AE region on the auto path).
     * No-op when the camera has no autofocus or the size is unknown.
     */
    public static void configureFocusAndMetering(Sink sink,
                                           boolean hasAutoFocus,
                                           Size jpegSize,
                                           boolean useManual) {
        if (!hasAutoFocus || jpegSize == null) {
            return;
        }
        sink.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);

        MeteringRectangle[] regions = MeteringRegions.centerWeighted(jpegSize);
        sink.set(CaptureRequest.CONTROL_AF_REGIONS, regions);
        if (!useManual) {
            sink.set(CaptureRequest.CONTROL_AE_REGIONS, regions);
        }
    }

    /**
     * Configure the post-processing pipeline keys (NR/Edge), JPEG quality, and JPEG orientation.
     */
    public static void configureQualityAndOrientation(Sink sink, int jpegQuality, int jpegOrientation) {
        sink.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
        sink.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
        sink.set(CaptureRequest.JPEG_QUALITY, (byte) jpegQuality);
        sink.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation);
    }

    /**
     * Convenience wrapper that applies the full still-capture recipe in one call. The caller is
     * still responsible for vendor-specific ZSL/MFNR configuration (only valid on the auto path).
     */
    public static void configure(Sink sink,
                          boolean useManual,
                          long manualClampedNs,
                          int manualIso,
                          long manualFrameDurationNs,
                          int userExposureCompensation,
                          Range<Integer> selectedFpsRange,
                          boolean hasAutoFocus,
                          Size jpegSize,
                          int jpegQuality,
                          int jpegOrientation) {
        configureExposure(sink, useManual, manualClampedNs, manualIso, manualFrameDurationNs,
                userExposureCompensation, selectedFpsRange);
        configureFocusAndMetering(sink, hasAutoFocus, jpegSize, useManual);
        configureQualityAndOrientation(sink, jpegQuality, jpegOrientation);
    }
}
