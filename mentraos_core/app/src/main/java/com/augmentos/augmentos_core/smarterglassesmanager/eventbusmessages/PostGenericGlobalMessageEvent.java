package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class PostGenericGlobalMessageEvent {
    public String message;

    public PostGenericGlobalMessageEvent(String newMessage){
        this.message = newMessage;
    }
}
