package com.mentra.asg_client.io.peripheral.events;

/** Switch status report from the MCU (BES command {@code sr_swst}). */
public final class SwitchEvent extends McuEvent {

    private final int type;
    private final int switchValue;

    public SwitchEvent(int type, int switchValue) {
        this.type = type;
        this.switchValue = switchValue;
    }

    /** Switch type from JSON field {@code type}, or -1 if absent. */
    public int getType() {
        return type;
    }

    /** Switch value from JSON field {@code switch}, or -1 if absent. */
    public int getSwitchValue() {
        return switchValue;
    }
}
