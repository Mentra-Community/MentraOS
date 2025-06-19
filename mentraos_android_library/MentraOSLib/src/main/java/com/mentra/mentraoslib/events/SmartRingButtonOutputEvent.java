package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class SmartRingButtonOutputEvent implements Serializable {
    public int buttonId;
    public long timestamp;
    public boolean isDown;
    public static final String eventId = "buttonOutputEvent";

    public SmartRingButtonOutputEvent(int buttonId, long timestamp, boolean isDown){
        this.buttonId = buttonId;
        this.timestamp = timestamp;
        this.isDown = isDown;
    }
}
