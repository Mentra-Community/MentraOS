package com.mentra.asg_client.io.streaming.services;

import com.mentra.asg_client.AsgConstants;
import org.webrtc.PeerConnection;

/** Resolves WHIP bitrate constraints without exceeding the caller's configured ceiling. */
final class WhipBitratePolicy {
    private WhipBitratePolicy() {}

    static int initialBitrateBps(int maximumBitrateBps) {
        return Math.min(maximumBitrateBps, AsgConstants.WHIP_INITIAL_VIDEO_BITRATE_BPS);
    }

    static Integer minimumBitrateBps(Integer requestedMinimum, int maximumBitrateBps) {
        return requestedMinimum != null && requestedMinimum > 0
                ? Math.min(maximumBitrateBps, requestedMinimum)
                : null;
    }

    static int initialBitrateBps(Integer requestedInitial, Integer requestedMinimum, int maximumBitrateBps) {
        Integer minimum = minimumBitrateBps(requestedMinimum, maximumBitrateBps);
        int initial = requestedInitial != null && requestedInitial > 0
                ? requestedInitial : initialBitrateBps(maximumBitrateBps);
        return Math.min(maximumBitrateBps, Math.max(initial, minimum == null ? 0 : minimum));
    }

    static boolean applyTo(PeerConnection peerConnection, Integer requestedMinimum, int maximumBitrateBps) {
        return applyTo(peerConnection, requestedMinimum, null, maximumBitrateBps);
    }

    static boolean applyTo(PeerConnection peerConnection, Integer requestedMinimum,
            Integer requestedInitial, int maximumBitrateBps) {
        return peerConnection.setBitrate(minimumBitrateBps(requestedMinimum, maximumBitrateBps),
                initialBitrateBps(requestedInitial, requestedMinimum, maximumBitrateBps), maximumBitrateBps);
    }
}
