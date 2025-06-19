package com.augmentos.augmentos_core.statushelpers;

import android.os.Build;

public class DeviceInfo {

    public static String getDeviceInfo() {
        return "Device Info:\n" +
                "Manufacturer: " + Build.MANUFACTURER + "\n" +
                "Model: " + Build.MODEL + "\n" +
                "Brand: " + Build.BRAND + "\n" +
                "Device: " + Build.DEVICE + "\n" +
                "Product: " + Build.PRODUCT + "\n" +
                "Android Version: " + Build.VERSION.RELEASE + " (API Level: " + Build.VERSION.SDK_INT + ")";
    }
}
