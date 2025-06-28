package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class GlassesSerialNumberEvent {
    public final String serialNumber;
    public final String style;
    public final String color;
    
    public GlassesSerialNumberEvent(String serialNumber, String style, String color) {
        this.serialNumber = serialNumber;
        this.style = style;
        this.color = color;
    }
} 