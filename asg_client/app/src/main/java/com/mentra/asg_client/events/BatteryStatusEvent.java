package com.mentra.asg_client.events;

/**
 * EventBus event for battery status updates from glasses
 * Used to communicate battery status between AsgClientService and OtaHelper
 */
public class BatteryStatusEvent {
    private final int batteryLevel;
    private final boolean charging;
    private final long timestamp;

    public BatteryStatusEvent(int batteryLevel, boolean charging, long timestamp) {
        this.batteryLevel = batteryLevel;
        this.charging = charging;
        this.timestamp = timestamp;
    }

    public int getBatteryLevel() {
        return batteryLevel;
    }

    public boolean isCharging() {
        return charging;
    }

    public long getTimestamp() {
        return timestamp;
    }

    @Override
    public String toString() {
        return "BatteryStatusEvent{" +
                "batteryLevel=" + batteryLevel +
                ", charging=" + charging +
                ", timestamp=" + timestamp +
                '}';
    }
}