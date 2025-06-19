package com.augmentos.augmentos_core.events;

public class NewScreenTextEvent {
    public String title;
    public String body;

    public NewScreenTextEvent(String newText){
        title = null;
        body = newText;
    }

    public NewScreenTextEvent(String newTitle, String newBody){
        title = newTitle;
        body = newBody;
    }
}
