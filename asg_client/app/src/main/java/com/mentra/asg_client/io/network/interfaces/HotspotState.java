package com.mentra.asg_client.io.network.interfaces;

/** One committed hotspot event; consumers use its credentials instead of mutable manager state. */
public record HotspotState(boolean enabled, String ssid, String password, String gatewayIp) {}
