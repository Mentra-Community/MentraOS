package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class CaseEvent {
    public final int caseBatteryLevel;
    public final boolean caseCharging;
    public final boolean caseOpen;
    public final boolean caseRemoved;
    public CaseEvent(int caseBatteryLevel, boolean caseCharging, boolean caseOpen, boolean caseRemoved) {
        this.caseBatteryLevel = caseBatteryLevel;
        this.caseCharging = caseCharging;
        this.caseOpen = caseOpen;
        this.caseRemoved = caseRemoved;
    }
}
