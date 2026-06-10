package com.mentra.asg_client.io.peripheral.events;

/** Battery reading reported by the MCU (BES command {@code hm_batv}). */
public final class BatteryEvent extends McuEvent {

    private final int percentage;
    private final int voltageMillivolts;

    public BatteryEvent(int percentage, int voltageMillivolts) {
        this.percentage = percentage;
        this.voltageMillivolts = voltageMillivolts;
    }

    /** Battery percentage from JSON field {@code pt}, or -1 if absent. */
    public int getPercentage() {
        return percentage;
    }

    /** Battery voltage in millivolts from JSON field {@code vt}, or -1 if absent. */
    public int getVoltageMillivolts() {
        return voltageMillivolts;
    }
}
