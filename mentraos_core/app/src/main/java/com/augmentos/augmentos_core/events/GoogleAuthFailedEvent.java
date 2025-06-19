package com.augmentos.augmentos_core.events;

public class GoogleAuthFailedEvent {

    public String reason;
    public GoogleAuthFailedEvent(String newReason){this.reason = newReason;}
}
