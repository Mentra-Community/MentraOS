package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

public class SmartGlassesConnectionStateChangedEvent {
    public final SmartGlassesDevice device;
    public SmartGlassesConnectionState connectionState;
    public SmartGlassesConnectionStateChangedEvent(SmartGlassesDevice newDevice, SmartGlassesConnectionState connectionState) {
        this.device = newDevice;
        this.connectionState = connectionState;
    }
}