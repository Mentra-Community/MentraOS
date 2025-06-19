package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

public class SmartGlassesConnectionEvent {
    public final SmartGlassesConnectionState connectionStatus;

    public SmartGlassesConnectionEvent(SmartGlassesConnectionState newSmartGlassesConnectionState) {
        this.connectionStatus = newSmartGlassesConnectionState;
    }
}