package com.mentra.asg_client.io.streaming.services;

import com.mentra.asg_client.AsgConstants;
import org.webrtc.PeerConnection;

/** Resolves WHIP bitrate constraints without exceeding the caller's configured ceiling. */
final class WhipBitratePolicy {
    private WhipBitratePolicy() {}

    static int initialBitrateBps(int maximumBitrateBps) {
        return Math.min(maximumBitrateBps, AsgConstants.WHIP_INITIAL_VIDEO_BITRATE_BPS);
    }

    static boolean applyTo(PeerConnection peerConnection, int maximumBitrateBps) {
        return peerConnection.setBitrate(
                null, initialBitrateBps(maximumBitrateBps), maximumBitrateBps);
    }
}
