package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class EngoTwo extends SmartGlassesDevice {
    public EngoTwo() {
        deviceModelName = "Engo2 by ActiveLook";
        deviceIconName = "engo_two";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.ACTIVELOOK_OS_GLASSES;
        hasDisplay = true;
        hasSpeakers = false;
        hasCamera = false;
        hasInMic = false;
        hasOutMic = false;
        weight = 37;
    }
}
