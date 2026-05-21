package com.mentra.asg_client.camera.policy;

import android.util.Range;

/**
 * Phase 3 prep: pure-logic FPS-range selection policy for photo preview.
 *
 * <p>Extracted from {@code CameraNeoService.chooseOptimalFpsRange} so the heuristic is unit-testable
 * without standing up a camera service. Behavior is byte-for-byte equivalent.
 *
 * <p>Selection priority (matches the historical heuristic):
 * <ol>
 *   <li><b>Wide range preference</b> — pick the first range that contains 30fps and starts at
 *       or below 5fps. A wide range allows long exposures (helpful for triggering MFNR which
 *       requires ISO &gt;800).</li>
 *   <li><b>Moderate range fallback</b> — pick the first range that contains 30fps and starts
 *       at or below 15fps.</li>
 *   <li><b>Final fallback</b> — pick the range with the highest minimum FPS.</li>
 * </ol>
 */
public final class FpsRangePolicy {

    /** Default range used when the camera reports no FPS ranges. */
    public static final Range<Integer> DEFAULT_FPS_RANGE = Range.create(30, 30);

    private FpsRangePolicy() {}

    /**
     * Select the optimal FPS range from a non-empty list of options.
     *
     * <p>Pure function — does not log. {@link CameraNeoService} performs its own logging using the
     * returned value.
     *
     * @throws IllegalArgumentException if {@code ranges} is null or empty (use
     *         {@link #DEFAULT_FPS_RANGE} for the "no characteristics" fallback).
     */
    public static Range<Integer> chooseOptimalFpsRange(Range<Integer>[] ranges) {
        if (ranges == null || ranges.length == 0) {
            throw new IllegalArgumentException("ranges must be non-empty");
        }

        // 1. Prefer wide ranges (5-30fps) that allow longer exposures for higher ISO.
        for (Range<Integer> range : ranges) {
            if (range.contains(30) && range.getLower() <= 5) {
                return range;
            }
        }

        // 2. Fallback: ranges that include 30fps with lower minimum.
        for (Range<Integer> range : ranges) {
            if (range.contains(30) && range.getLower() <= 15) {
                return range;
            }
        }

        // 3. Final fallback: highest minimum FPS.
        Range<Integer> best = ranges[0];
        for (Range<Integer> range : ranges) {
            if (range.getLower() > best.getLower()) {
                best = range;
            }
        }
        return best;
    }
}
