package com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses;

import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;

import java.io.Serializable;

public class SmartGlassesDevice implements Serializable {
    public String deviceModelName;
    public String deviceIconName;
    public boolean anySupport;
    public boolean fullSupport;
    public SmartGlassesOperatingSystem glassesOs;
    public boolean hasDisplay;
    public boolean hasSpeakers;
    public boolean hasCamera;
    public boolean hasInMic;
    public boolean hasOutMic;
    public boolean useScoMic;
    public double weight;

    public int connectionState = -1; //0 is not connected, 1 is trying to connect, 2 is connected

    public String getDeviceModelName() {
        return deviceModelName;
    }

    public void setDeviceModelName(String deviceModelName) {
        this.deviceModelName = deviceModelName;
    }

    public String getDeviceIconName() {
        return deviceIconName;
    }

    public void setDeviceIconName(String deviceIconName) {
        this.deviceIconName = deviceIconName;
    }

    public boolean getAnySupport() {
        return anySupport;
    }

    public void setAnySupport(boolean anySupport) {
        this.anySupport = anySupport;
    }

    public boolean getFullSupport() {
        return fullSupport;
    }

    public void setFullSupport(boolean fullSupport) {
        this.fullSupport = fullSupport;
    }

    public SmartGlassesOperatingSystem getGlassesOs() {
        return glassesOs;
    }

    public void setGlassesOs(SmartGlassesOperatingSystem glassesOs) {
        this.glassesOs = glassesOs;
    }

    public boolean getHasDisplay() {
        return hasDisplay;
    }

    public void setHasDisplay(boolean hasDisplay) {
        this.hasDisplay = hasDisplay;
    }

    public boolean getHasSpeakers() {
        return hasSpeakers;
    }

    public void setHasSpeakers(boolean hasSpeakers) {
        this.hasSpeakers = hasSpeakers;
    }

    public boolean getHasCamera() {
        return hasCamera;
    }

    public void setHasCamera(boolean hasCamera) {
        this.hasCamera = hasCamera;
    }

    public boolean getHasInMic() {
        return hasInMic;
    }

    public void setHasInMic(boolean hasInMic) {
        this.hasInMic = hasInMic;
    }

    public boolean getHasOutMic() {
        return hasOutMic;
    }

    public void setHasOutMic(boolean hasOutMic) {
        this.hasOutMic = hasOutMic;
    }

    public double getWeight() {
        return weight;
    }

    public void setWeight(double weight) {
        this.weight = weight;
    }

    public int getConnectionState() {
        return connectionState;
    }

    public void setConnectionState(int connectionState) {
        this.connectionState = connectionState;
    }
}
