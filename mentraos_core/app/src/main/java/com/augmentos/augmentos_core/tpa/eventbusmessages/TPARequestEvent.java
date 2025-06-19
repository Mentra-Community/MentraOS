package com.augmentos.augmentos_core.tpa.eventbusmessages;

import java.io.Serializable;

public class TPARequestEvent {
    public String eventId;
    public Serializable serializedEvent;
    public String sendingPackage;

    public TPARequestEvent(String eventId, Serializable serializedEvent, String sendingPackage){
        this.eventId = eventId;
        this.serializedEvent = serializedEvent;
        this.sendingPackage = sendingPackage;
    }
}
