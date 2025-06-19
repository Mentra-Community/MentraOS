package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class InmoGo extends SmartGlassesDevice {
    public InmoGo() {
        deviceModelName = "INMO GO";
        deviceIconName = "inmo_go";
        anySupport = false;
        fullSupport = false;
        glassesOs = SmartGlassesOperatingSystem.INMO_GO_MCU_OS_GLASSES;
        hasDisplay = true;
        hasSpeakers = false;
        hasCamera = false;
        hasInMic = true;
        hasOutMic = false;
        useScoMic = false;
        weight = 38;
    }
}
