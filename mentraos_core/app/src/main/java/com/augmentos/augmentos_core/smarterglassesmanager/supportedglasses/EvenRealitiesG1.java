package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class EvenRealitiesG1 extends SmartGlassesDevice {
    public EvenRealitiesG1() {
        deviceModelName = "Even Realities G1";
        deviceIconName = "er_g1";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.EVEN_REALITIES_G1_MCU_OS_GLASSES;
        hasDisplay = true;
        hasSpeakers = false;
        hasCamera = false;
        hasInMic = true;
        hasOutMic = false;
        useScoMic = false;
        weight = 37;
    }
}