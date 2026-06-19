package com.mentra.asg_client.io.peripheral.events;

/** BES OTA authorization response from the BES chip (BES command {@code hm_ota}). */
public final class BesOtaAuthEvent extends McuEvent {

    private final boolean authorized;

    public BesOtaAuthEvent(boolean authorized) {
        this.authorized = authorized;
    }

    /** True when the BES chip granted the OTA request (JSON {@code result} == 1). */
    public boolean isAuthorized() {
        return authorized;
    }
}
