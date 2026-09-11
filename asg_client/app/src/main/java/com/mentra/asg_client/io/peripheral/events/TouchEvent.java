package com.mentra.asg_client.io.peripheral.events;

/** Touch gesture reported by the MCU (BES command {@code sr_tpevt}). */
public final class TouchEvent extends McuEvent {

    private final int gestureType;

    public TouchEvent(int gestureType) {
        this.gestureType = gestureType;
    }

    /** Raw gesture type from JSON field {@code type}, or -1 if absent. */
    public int getGestureType() {
        return gestureType;
    }
}
