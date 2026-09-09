package com.mentra.asg_client.io.peripheral.events;

/** Spoken pairing-code request from the MCU (BES command {@code hm_spkcode}). */
public final class SpeakPairingCodeEvent extends McuEvent {

    private final String code;

    public SpeakPairingCodeEvent(String code) {
        this.code = code == null ? "" : code.trim();
    }

    /** Pairing code characters from JSON field {@code code}, e.g. {@code A1B2}. */
    public String getCode() {
        return code;
    }
}
