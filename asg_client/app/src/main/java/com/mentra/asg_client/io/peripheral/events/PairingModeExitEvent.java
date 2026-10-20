package com.mentra.asg_client.io.peripheral.events;

import java.util.Locale;

/**
 * Pairing-window exit notification from the MCU ({@code hm_pairexit}). BES sends it exactly once
 * per window close with {@code B.reason} in {@code paired|cancelled|timeout}.
 */
public final class PairingModeExitEvent extends McuEvent {

    public static final String REASON_PAIRED = "paired";
    public static final String REASON_CANCELLED = "cancelled";
    public static final String REASON_TIMEOUT = "timeout";
    public static final String REASON_UNKNOWN = "unknown";

    private final String reason;

    public PairingModeExitEvent(String reason) {
        String trimmed = reason == null ? "" : reason.trim();
        this.reason = trimmed.isEmpty() ? REASON_UNKNOWN : trimmed;
    }

    /**
     * Firmware close reason exactly as received ({@code paired}, {@code cancelled}, {@code
     * timeout}), or {@code unknown} when the field was missing or blank. Other values (older
     * firmware) are passed through unchanged.
     */
    public String getReason() {
        return reason;
    }

    /** Lower-cased reason for matching against the {@code REASON_*} constants. */
    public String getNormalizedReason() {
        return reason.toLowerCase(Locale.ROOT);
    }
}
