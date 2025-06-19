package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class GlassesBluetoothSearchDiscoverEvent {
    public String modelName;
    public String deviceName;

    public GlassesBluetoothSearchDiscoverEvent(String modelName, String deviceName){
        this.modelName = modelName;
        this.deviceName = deviceName;
    }
}
