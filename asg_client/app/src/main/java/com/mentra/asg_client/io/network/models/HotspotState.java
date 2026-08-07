package com.mentra.asg_client.io.network.models;

/** Immutable public hotspot state captured at one point in its lifecycle. */
public final class HotspotState {
    private final boolean mEnabled;
    private final boolean mTransitioning;
    private final String mSsid;
    private final String mPassword;
    private final String mGatewayIp;

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
        mEnabled = enabled;
        mTransitioning = transitioning;
        mSsid = ssid != null ? ssid : "";
        mPassword = password != null ? password : "";
        mGatewayIp = gatewayIp != null ? gatewayIp : "";
    }

    /** Returns whether the hotspot is ready for a client. */
    public boolean isEnabled() {
        return mEnabled;
    }

    /** Returns whether hotspot startup or teardown is in progress. */
    public boolean isTransitioning() {
        return mTransitioning;
    }

    /** Returns the current hotspot SSID, or an empty string when unavailable. */
    public String getSsid() {
        return mSsid;
    }

    /** Returns the current hotspot password, or an empty string when unavailable. */
    public String getPassword() {
        return mPassword;
    }

    /** Returns the current local gateway address, or an empty string when unavailable. */
    public String getGatewayIp() {
        return mGatewayIp;
    }
}
