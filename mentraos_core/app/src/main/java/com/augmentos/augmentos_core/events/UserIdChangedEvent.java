package com.augmentos.augmentos_core.events;

public class UserIdChangedEvent {
    public String userId;

    public UserIdChangedEvent(String newUserId){
        userId = newUserId;
    }
}
