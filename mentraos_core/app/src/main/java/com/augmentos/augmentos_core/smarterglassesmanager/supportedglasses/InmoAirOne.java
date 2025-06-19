package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

// these glasses are pretty bad. There's no home button/gesture... the text/font size is all off android specs. Arms are big. The company has zero customer support. We might drop support for these - cayden
public class InmoAirOne extends SmartGlassesDevice {
    public InmoAirOne() {
        deviceModelName = "Inmo Air 1";
        deviceIconName = "inmo_air";
        anySupport = true;
        fullSupport = false;
        glassesOs = SmartGlassesOperatingSystem.ANDROID_OS_GLASSES;
        hasDisplay = true;
        hasSpeakers = true;
        hasCamera = true;
        hasInMic = true;
        hasOutMic = false; //unknown
        weight = 76;
    }
}
