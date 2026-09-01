package com.mentra.asg_client.io.network.interfaces;

/** Semantic result of requesting the network backend's saved SSID inventory. */
public enum SavedWifiNetworksOutcome {
    CONFIRMED("confirmed"),
    UNSUPPORTED("unsupported"),
    FAILED("failed");

    private final String wireValue;

    SavedWifiNetworksOutcome(String wireValue) {
        this.wireValue = wireValue;
    }

    public String getWireValue() {
        return wireValue;
    }
}
