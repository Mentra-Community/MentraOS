package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class TextLineViewRequestEvent implements Serializable {
    public String text;
    public static final String eventId = "textLineViewRequestEvent";

    public TextLineViewRequestEvent(String text) {
        this.text = text;
    }
}
