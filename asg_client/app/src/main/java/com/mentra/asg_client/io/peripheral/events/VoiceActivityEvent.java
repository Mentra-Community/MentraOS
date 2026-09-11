package com.mentra.asg_client.io.peripheral.events;

/** Voice Activity Detection event from the MCU (BES command {@code sr_vad}). */
public final class VoiceActivityEvent extends McuEvent {

    private final boolean active;

    public VoiceActivityEvent(boolean active) {
        this.active = active;
    }

    /** True when voice activity is detected (JSON {@code on} == 1). */
    public boolean isActive() {
        return active;
    }
}
