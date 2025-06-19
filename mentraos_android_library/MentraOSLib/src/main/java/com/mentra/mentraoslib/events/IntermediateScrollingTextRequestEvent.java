package com.mentra.mentraoslib.events;

public class IntermediateScrollingTextRequestEvent {
    public String text;
    public static final String eventId = "intermediateScrollingTextEvent";

    public IntermediateScrollingTextRequestEvent(String text){
        this.text = text;
    }
}
