package com.mentra.mentraoslib.events;

import java.io.Serializable;

public class TranslateOutputEvent implements Serializable {
    public String text;
    public String fromLanguageCode;
    public String toLanguageCode;
    public long timestamp;
    public boolean isFinal;
    public static final String eventId = "TranslateOutputEvent";

    public TranslateOutputEvent(String text, String fromLanguageCode, String toLanguageCode, long timestamp, boolean isFinal){
        this.text = text;
        this.fromLanguageCode = fromLanguageCode;
        this.toLanguageCode = toLanguageCode;
        this.timestamp = timestamp;
        this.isFinal = isFinal;
    }
}