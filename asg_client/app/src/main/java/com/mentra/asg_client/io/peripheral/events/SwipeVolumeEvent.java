package com.mentra.asg_client.io.peripheral.events;

/** Swipe-to-change-volume status report from the MCU (BES command {@code sr_fbvol}). */
public final class SwipeVolumeEvent extends McuEvent {

    private final boolean enabled;

    public SwipeVolumeEvent(boolean enabled) {
        this.enabled = enabled;
    }

    /** True when the swipe-volume feature is enabled (JSON {@code switch} == 1). */
    public boolean isEnabled() {
        return enabled;
    }
}
