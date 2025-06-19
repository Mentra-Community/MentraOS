package com.augmentos.augmentos_core.events;

public class SharingContactChangedEvent {
    public String name;
    public String phoneNumber;
    public SharingContactChangedEvent(String newName, String newNum){
        name = newName;
        phoneNumber = newNum;
    }
}
