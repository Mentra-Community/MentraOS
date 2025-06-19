package com.augmentos.augmentos_core.tpa.eventbusmessages;

public class NaturalLanguageArgsCommandViewRequestEvent {
    public String prompt;
    public String naturalLanguageInput;
    public static final String eventId = "naturalLanguageRequest";

    //if options is null, then it's a natural langauge prompt
    public NaturalLanguageArgsCommandViewRequestEvent(String prompt, String naturalLanguageInput) {
        this.prompt = prompt;
        this.naturalLanguageInput = naturalLanguageInput;
    }
}
