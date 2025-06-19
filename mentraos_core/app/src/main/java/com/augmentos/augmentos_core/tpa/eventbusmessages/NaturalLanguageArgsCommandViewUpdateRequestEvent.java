package com.augmentos.augmentos_core.tpa.eventbusmessages;

public class NaturalLanguageArgsCommandViewUpdateRequestEvent {
    public String naturalLanguageInput;
    public static final String eventId = "naturalLanguageUpdateRequest";

    public NaturalLanguageArgsCommandViewUpdateRequestEvent(String naturalLanguageInput) {
        this.naturalLanguageInput = naturalLanguageInput;
    }
}
