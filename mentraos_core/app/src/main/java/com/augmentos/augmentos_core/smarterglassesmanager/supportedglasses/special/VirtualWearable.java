package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.special;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

public class VirtualWearable extends SmartGlassesDevice {
    public VirtualWearable() {
        deviceModelName = "Simulated Glasses";
        deviceIconName = "bluetooth_earpiece";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.VIRTUAL_WEARABLE;
        hasDisplay = false;
        hasSpeakers = false; //set as false because we want to do this from ASP
        hasCamera = false;
        hasInMic = false; //set as false because we want to do this from ASP
        hasOutMic = false;
        useScoMic = true;
        weight = 14;
    }
}