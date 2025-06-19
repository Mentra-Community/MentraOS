package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class SpeechRecOutputEvent implements Serializable {
    public String text;
    public String languageCode;
    public long timestamp;
    public boolean isFinal;
    public boolean isTranslated = false;
    public static final String eventId = "SpeechRecOutputEvent";

    public SpeechRecOutputEvent(String text, String languageCode, long timestamp, boolean isFinal){
        this.text = text;
        this.languageCode = languageCode;
        this.timestamp = timestamp;
        this.isFinal = isFinal;
    }
}
