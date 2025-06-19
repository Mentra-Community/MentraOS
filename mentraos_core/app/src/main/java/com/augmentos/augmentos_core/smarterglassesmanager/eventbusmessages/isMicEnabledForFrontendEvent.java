package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class isMicEnabledForFrontendEvent {
    public boolean micState;

    public isMicEnabledForFrontendEvent(boolean micState){
        this.micState = micState;
    }
}