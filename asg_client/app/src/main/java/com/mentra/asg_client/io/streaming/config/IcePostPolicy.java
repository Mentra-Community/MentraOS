package com.mentra.asg_client.io.streaming.config;

/**
 * Decides when the WHIP offer may be POSTed, given the ICE mode and what triggered the check.
 *
 * <p>WHIP has no trickle ICE on either side here: there is no {@code PATCH} support, so the offer
 * we POST is the only offer the server will ever see. In the normal STUN path we accept a partial
 * gather because a server-reflexive candidate is enough to connect and {@code GATHER_ONCE} can
 * otherwise sit in GATHERING far longer than the phone's start timeout.
 *
 * <p>SoftAP is different. There is no STUN server, the only useful candidate is the hotspot host
 * candidate, and gathering local host candidates is nearly instant. So host-only mode waits for
 * {@code GATHERING_COMPLETE} and verifies a hotspot host candidate is actually present. That avoids
 * the failure where the offer is posted after some unrelated interface's candidate arrives first
 * and the hotspot candidate lands milliseconds later, never reaching the server.
 *
 * <p>Pure decision logic, split from {@code WhipStreamingService} so it unit tests without WebRTC.
 */
public final class IcePostPolicy {

    /** How ICE was configured for this negotiation. */
    public enum Mode {
        /** A STUN server is configured; server-reflexive candidates are expected. */
        STUN,
        /** No STUN server (SoftAP). Only local host candidates will ever be gathered. */
        HOST_ONLY,
    }

    /** What prompted the POST check. */
    public enum Trigger {
        /** First server-reflexive candidate arrived. */
        SRFLX,
        /** The short gather cap elapsed. */
        TIMEOUT,
        /** libwebrtc reported ICE gathering COMPLETE. */
        GATHERING_COMPLETE,
    }

    public enum Decision {
        /** POST the current local description now. */
        POST,
        /** Not yet; a later trigger will decide. */
        WAIT,
        /** Gathering finished without a usable hotspot candidate. The stream cannot work. */
        FAIL_NO_HOTSPOT_CANDIDATE,
    }

    /** Failure reason code paired with {@link Decision#FAIL_NO_HOTSPOT_CANDIDATE}. */
    public static final String REASON_NO_HOTSPOT_CANDIDATE = "no_hotspot_candidate";

    private IcePostPolicy() {}

    /**
     * @param mode ICE mode for this negotiation
     * @param trigger what prompted this check
     * @param hasHotspotHostCandidate whether a private-subnet {@code typ host} candidate was seen
     */
    public static Decision decide(Mode mode, Trigger trigger, boolean hasHotspotHostCandidate) {
        if (mode == Mode.HOST_ONLY) {
            // srflx can never arrive without STUN, and the timeout would post a possibly
            // incomplete offer. Only a completed gather is trustworthy here.
            if (trigger != Trigger.GATHERING_COMPLETE) return Decision.WAIT;
            return hasHotspotHostCandidate ? Decision.POST : Decision.FAIL_NO_HOTSPOT_CANDIDATE;
        }
        return Decision.POST;
    }

    /**
     * Whether the short gather cap should be armed at all. Host-only mode must not arm it: the
     * timeout would post before {@code GATHERING_COMPLETE} and defeat the whole point.
     */
    public static boolean schedulesGatherTimeout(Mode mode) {
        return mode == Mode.STUN;
    }

    /** Mode implied by the resolved STUN server: absent or blank means SoftAP host-only. */
    public static Mode modeForStunServer(String stunServer) {
        return (stunServer == null || stunServer.trim().isEmpty()) ? Mode.HOST_ONLY : Mode.STUN;
    }

    /**
     * True when the candidate line is a {@code typ host} candidate on a private IPv4 subnet.
     *
     * <p>The glasses' own hotspot interface is 192.168.43.1 by default, but the check accepts any
     * RFC1918 range so a different AP subnet does not silently fail the gate. Link-local, loopback,
     * and public addresses are rejected, as are IPv6 and mDNS-obfuscated candidates, none of which
     * can carry media across the SoftAP link.
     */
    public static boolean isHotspotHostCandidate(String candidateSdp) {
        if (candidateSdp == null) return false;
        if (!candidateSdp.contains("typ host")) return false;

        for (String token : candidateSdp.split("\\s+")) {
            if (isPrivateIpv4(token)) return true;
        }
        return false;
    }

    /** RFC1918: 10/8, 172.16/12, 192.168/16. */
    static boolean isPrivateIpv4(String token) {
        String[] octets = token.split("\\.");
        if (octets.length != 4) return false;

        int[] values = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                values[i] = Integer.parseInt(octets[i]);
            } catch (NumberFormatException e) {
                return false;
            }
            if (values[i] < 0 || values[i] > 255) return false;
        }

        if (values[0] == 10) return true;
        if (values[0] == 172 && values[1] >= 16 && values[1] <= 31) return true;
        return values[0] == 192 && values[1] == 168;
    }
}
