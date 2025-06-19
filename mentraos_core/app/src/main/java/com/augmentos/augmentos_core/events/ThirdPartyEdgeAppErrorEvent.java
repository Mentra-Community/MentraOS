package com.augmentos.augmentos_core.events;

public class ThirdPartyEdgeAppErrorEvent {
    public String packageName;
    public String text;

    public ThirdPartyEdgeAppErrorEvent(String packageName, String text){
        this.packageName = packageName;
        this.text = text;
    }
}
