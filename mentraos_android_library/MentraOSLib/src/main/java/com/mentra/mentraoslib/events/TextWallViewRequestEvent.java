package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class TextWallViewRequestEvent implements Serializable {
    public String text;
    public static final String eventId = "textWallViewRequestEvent";

    public TextWallViewRequestEvent(String text) {
        this.text = text;
    }
}
