package com.mentra.asg_client.service.utils;

import android.content.Context;

/** High-level device profile for factory selection (Mentra Live vs generic Android). */
public enum DeviceProfile {
    MENTRA_LIVE,
    GENERIC_ANDROID;

    public static DeviceProfile detect(Context context) {
        return ServiceUtils.isK900Device(context) ? MENTRA_LIVE : GENERIC_ANDROID;
    }

    public boolean isK900() {
        return this == MENTRA_LIVE;
    }
}
