package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class BrightnessLevelEvent {
    public final int brightnessLevel;
    public final boolean autoBrightness;

    public BrightnessLevelEvent(int brightnessLevel) {
        this.brightnessLevel = brightnessLevel;
        this.autoBrightness = false;
    }

    public BrightnessLevelEvent(boolean autoBrightness) {
        this.autoBrightness = autoBrightness;
        this.brightnessLevel = -1;
    }
}