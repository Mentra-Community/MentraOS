package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;

public class SetFontSizeEvent {

    public SmartGlassesFontSize fontSize;

    public SetFontSizeEvent(SmartGlassesFontSize newFontSize){
        this.fontSize = newFontSize;
    }
}
