package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

/**
 * MentraLive SmartGlassesDevice class - defines characteristics of the Mentra Live glasses
 * Note: These glasses only have camera and microphone capabilities, no display
 */
public class MentraLive extends SmartGlassesDevice {
    public MentraLive() {
        deviceModelName = "Mentra Live";
        deviceIconName = "vuzix_shield";
        anySupport = true;
        fullSupport = true;
        glassesOs = SmartGlassesOperatingSystem.MENTRA_LIVE_OS;
        hasDisplay = false; // No display capability
        hasSpeakers = false; // No speakers
        hasCamera = true; // Has camera
        hasInMic = true; // Has microphone
        hasOutMic = true;
        weight = 44;
    }
}
