package com.mentra.asg_client.camera.policy;

import android.util.Range;

/**
 * Phase 2: pure-logic policy that computes sensor parameters for a manual-exposure still capture.
 *
 * <p>Extracted from {@link CameraNeoService} so the math is unit-testable without a real camera.
 * All methods are static and side-effect free; they take all inputs explicitly rather than
 * reading service-level state.
 */
public final class ManualExposurePolicy {

    /** Default ISO used as the baseline when no metered preview ISO is available yet. */
    public static final int DEFAULT_ISO = 400;

    /** Guard band added between requested exposure and the sensor frame duration. */
    public static final long FRAME_DURATION_GUARD_NS = 1_000_000L; // 1 ms

    private ManualExposurePolicy() {}

    /**
     * Clamp a requested manual exposure time to the sensor-supported range.
     *
     * @param requestedNs caller's desired SENSOR_EXPOSURE_TIME, in nanoseconds.
     * @param sensorExposureTimeRange sensor-reported {@code SENSOR_INFO_EXPOSURE_TIME_RANGE}, or
     *                                {@code null} when the camera doesn't advertise it (returns
     *                                {@code requestedNs} unchanged).
     * @return clamped exposure time in nanoseconds.
     */
    public static long clampExposureTimeNs(long requestedNs, Range<Long> sensorExposureTimeRange) {
        if (sensorExposureTimeRange == null) {
            return requestedNs;
        }
        long lo = sensorExposureTimeRange.getLower();
        long hi = sensorExposureTimeRange.getUpper();
        return Math.max(lo, Math.min(hi, requestedNs));
    }

    /**
     * Choose an ISO (SENSOR_SENSITIVITY) that keeps exposure value approximately stable when
     * the shutter speed changes from the AE-metered preview value to the requested manual shutter.
     *
     * <p>Algorithm:
     * <ol>
     *   <li>Start from the last preview-metered ISO ({@link #DEFAULT_ISO} if unavailable).</li>
     *   <li>If both metered and target exposure are available, scale ISO by the shutter ratio:
     *       {@code iso_target = iso_metered * (t_metered / t_target)}.</li>
     *   <li>Clamp the result to the sensor's supported ISO range, when known.</li>
     * </ol>
     *
     * @param targetExposureNs the (already-clamped) manual shutter time.
     * @param meteredIso last ISO emitted by the AE-driven preview, or {@code null}.
     * @param meteredExposureNs last shutter time emitted by the AE-driven preview, or {@code null}.
     * @param sensorSensitivityRange sensor-reported ISO range, or {@code null} when unknown.
     * @return ISO value to apply to the manual still capture.
     */
    public static int pickSensitivityForManualCapture(long targetExposureNs,
                                                Integer meteredIso,
                                                Long meteredExposureNs,
                                                Range<Integer> sensorSensitivityRange) {
        int iso = (meteredIso != null && meteredIso > 0) ? meteredIso : DEFAULT_ISO;
        if (meteredExposureNs != null && meteredExposureNs > 0 && targetExposureNs > 0 && iso > 0) {
            double evScale = (double) meteredExposureNs / (double) targetExposureNs;
            // Floor at 1 — Math.round can return 0 for very small ratios, which is an invalid ISO.
            iso = Math.max(1, (int) Math.round(iso * evScale));
        }
        if (sensorSensitivityRange != null) {
            iso = Math.max(sensorSensitivityRange.getLower(),
                    Math.min(sensorSensitivityRange.getUpper(), iso));
        }
        return iso;
    }

    /**
     * Choose a SENSOR_FRAME_DURATION large enough to encompass the shutter time (plus guard band)
     * but no larger than the sensor's reported maximum.
     */
    public static long pickFrameDurationForManualCapture(long exposureNs, Long sensorMaxFrameDurationNs) {
        long frameDurationNs = exposureNs + FRAME_DURATION_GUARD_NS;
        if (sensorMaxFrameDurationNs != null && sensorMaxFrameDurationNs > 0L) {
            frameDurationNs = Math.min(frameDurationNs, sensorMaxFrameDurationNs);
        }
        return Math.max(frameDurationNs, exposureNs);
    }
}
