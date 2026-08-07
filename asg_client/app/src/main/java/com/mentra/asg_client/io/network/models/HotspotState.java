package com.mentra.asg_client.io.network.models;

/** Immutable public hotspot state captured at one point in its lifecycle. */
public final class HotspotState {
    private final boolean enabled;
    private final boolean transitioning;
    private final String ssid;
    private final String password;
    private final String gatewayIp;

    /**
     * Creates a hotspot snapshot captured at one lifecycle point.
     *
     * @param enabled whether the hotspot is ready for a client
     * @param transitioning whether hotspot startup or teardown is in progress
     * @param ssid current hotspot SSID, or {@code null} when unavailable
     * @param password current hotspot password, or {@code null} when unavailable
     * @param gatewayIp current local gateway address, or {@code null} when unavailable
     */
    public HotspotState(
            boolean enabled,
            boolean transitioning,
            String ssid,
            String password,
            String gatewayIp) {
        this.enabled = enabled;
        this.transitioning = transitioning;
        this.ssid = ssid != null ? ssid : "";
        this.password = password != null ? password : "";
        this.gatewayIp = gatewayIp != null ? gatewayIp : "";
    }

    /** Returns whether the hotspot is ready for a client. */
    public boolean isEnabled() {
        return enabled;
    }

    /** Returns whether hotspot startup or teardown is in progress. */
    public boolean isTransitioning() {
        return transitioning;
    }

    /** Returns the current hotspot SSID, or an empty string when unavailable. */
    public String getSsid() {
        return ssid;
    }

    /** Returns the current hotspot password, or an empty string when unavailable. */
    public String getPassword() {
        return password;
    }

    /** Returns the current local gateway address, or an empty string when unavailable. */
    public String getGatewayIp() {
        return gatewayIp;
    }
}
