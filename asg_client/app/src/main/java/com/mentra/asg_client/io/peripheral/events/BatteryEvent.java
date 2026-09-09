package com.mentra.asg_client.io.peripheral.events;

import android.os.SystemClock;

/** Battery reading reported by the MCU (BES command {@code hm_batv}). */
public final class BatteryEvent extends McuEvent {

    private final int percentage;
    private final int voltageMillivolts;
    private final boolean activeCharging;
    private final long receivedAtElapsedMs;

    public BatteryEvent(int percentage, int voltageMillivolts) {
        this(percentage, voltageMillivolts, false);
    }

    /** Active charging is affirmative BES evidence, never inferred from voltage. */
    public BatteryEvent(int percentage, int voltageMillivolts, boolean activeCharging) {
        this.percentage = percentage;
        this.voltageMillivolts = voltageMillivolts;
        this.activeCharging = activeCharging;
        this.receivedAtElapsedMs = SystemClock.elapsedRealtime();
    }

    /** Battery percentage from JSON field {@code pt}, or -1 if absent. */
    public int getPercentage() {
        return percentage;
    }

    /** Battery voltage in millivolts from JSON field {@code vt}, or -1 if absent. */
    public int getVoltageMillivolts() {
        return voltageMillivolts;
    }

    public boolean isActiveCharging() {
        return activeCharging;
    }

    public long getReceivedAtElapsedMs() {
        return receivedAtElapsedMs;
    }
}
