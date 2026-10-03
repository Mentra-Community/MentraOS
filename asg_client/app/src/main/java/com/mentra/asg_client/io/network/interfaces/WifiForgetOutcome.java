package com.mentra.asg_client.io.network.interfaces;

/** Semantic result of asking a network backend to forget an exact SSID. */
public enum WifiForgetOutcome {
    CONFIRMED("confirmed"),
    DISPATCHED("dispatched"),
    NOT_FOUND("not_found"),
    UNSUPPORTED("unsupported"),
    FAILED("failed");

    private final String wireValue;

    WifiForgetOutcome(String wireValue) {
        this.wireValue = wireValue;
    }

    public String getWireValue() {
        return wireValue;
    }
}
