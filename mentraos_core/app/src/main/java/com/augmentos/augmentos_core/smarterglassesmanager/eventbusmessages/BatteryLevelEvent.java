package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class BatteryLevelEvent {
    public final int batteryLevel;
    public final boolean isCharging;
    public BatteryLevelEvent(int batteryLevel, boolean isCharging) {
        this.batteryLevel = batteryLevel;
        this.isCharging = isCharging;
    }
}
