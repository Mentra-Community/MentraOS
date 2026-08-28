package com.mentra.asg_client.io.peripheral.events;

/** Pairing-window exit notification from the MCU ({@code hm_pairexit}). */
public final class PairingModeExitEvent extends McuEvent {

    private final String reason;

    public PairingModeExitEvent(String reason) {
        this.reason = reason == null ? "unknown" : reason;
    }

    /** Firmware lifecycle reason, used for diagnostics only. */
    public String getReason() {
        return reason;
    }
}
