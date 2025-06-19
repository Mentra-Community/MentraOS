package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class ManagerToCoreRequestEvent implements Serializable {
    public String jsonData;
    public static final String eventId = "managerToCoreRequestEvent";

    public ManagerToCoreRequestEvent(String newJsonData){
        this.jsonData = newJsonData;
    }
}
