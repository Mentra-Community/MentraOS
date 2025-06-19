package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class MentraMach1 extends SmartGlassesDevice {
    public MentraMach1() {
        deviceModelName = "Mentra Mach1";
        deviceIconName = "vuzix_ultralite";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.ULTRALITE_MCU_OS_GLASSES;
        hasDisplay = true;
        hasSpeakers = false;
        hasCamera = false;
        hasInMic = false;
        hasOutMic = false;
        useScoMic = true;
        weight = 38;
    }
}
