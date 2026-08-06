package com.mentra.asg_client.io.network.models;

/** Immutable public hotspot state captured at one point in its lifecycle. */
public final class HotspotState {
    private final boolean enabled;
    private final boolean transitioning;
    private final String ssid;
    private final String password;
    private final String gatewayIp;

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

    public boolean isEnabled() {
        return enabled;
    }

    public boolean isTransitioning() {
        return transitioning;
    }

    public String getSsid() {
        return ssid;
    }

    public String getPassword() {
        return password;
    }

    public String getGatewayIp() {
        return gatewayIp;
    }
}
