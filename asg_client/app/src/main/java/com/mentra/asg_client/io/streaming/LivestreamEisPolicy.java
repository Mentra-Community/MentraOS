package com.mentra.asg_client.io.streaming;

import android.util.Log;

/**
 * Livestream EIS only arms below the 500k pixel gate. Mentra Call 540p (960×540 =
 * 518_400) and 720p (921_600) both miss it. ~360p (640×360 = 230_400) is under.
 *
 * <p>Exclusive: {@code pixels < MAX_PIXELS}, same as the original {@code EIS_MAX_PIXELS}
 * check in {@code StreamCommandHandler}.
 */
public final class LivestreamEisPolicy {
    public static final int MAX_PIXELS = 500_000;

    private LivestreamEisPolicy() {}

    public static boolean shouldEnable(int width, int height) {
        if (width <= 0 || height <= 0) {
            return false;
        }
        return (long) width * (long) height < MAX_PIXELS;
    }

    /**
     * Always logs the Mentra Call EIS decision at INFO so logcat answers whether the
     * livestream armed EIS and why. Safe to call from every apply site.
     */
    public static boolean logDecision(String tag, String stage, int width, int height) {
        boolean enable = shouldEnable(width, height);
        long pixels = (long) width * (long) height;
        String reason;
        if (width <= 0 || height <= 0) {
            reason = "invalid-size";
        } else if (enable) {
            reason = "under-500k";
        } else {
            reason = "at-or-above-500k";
        }
        Log.i(
                tag,
                "EIS stage="
                        + stage
                        + " enable="
                        + enable
                        + " size="
                        + width
                        + "x"
                        + height
                        + " pixels="
                        + pixels
                        + " gate="
                        + pixels
                        + "<"
                        + MAX_PIXELS
                        + "="
                        + enable
                        + " reason="
                        + reason);
        return enable;
    }
}
