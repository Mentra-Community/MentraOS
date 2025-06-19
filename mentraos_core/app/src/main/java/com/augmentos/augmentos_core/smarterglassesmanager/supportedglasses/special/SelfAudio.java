package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.special;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class SelfAudio extends SmartGlassesDevice {
    public SelfAudio() {
        deviceModelName = "Self Audio";
        deviceIconName = "vuzix_shield";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.SELF_OS_GLASSES;
        hasDisplay = false;
        hasSpeakers = true;
        hasCamera = true;
        hasInMic = true;
        hasOutMic = true;
        weight = 0;
    }
}
