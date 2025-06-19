package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class DoubleTextWallViewRequestEvent implements Serializable {
    public String textTop;
    public String textBottom;
    public static final String eventId = "doubleTextWallViewRequestEvent";


    public DoubleTextWallViewRequestEvent(String textTop, String textBottom) {
        this.textTop = textTop;
        this.textBottom = textBottom;
    }
}
