package com.mentra.asg_client.service.utils;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.lang.reflect.Method;

/**
 * Utility class for reading/writing Android system properties.
 * Uses reflection to access android.os.SystemProperties which is not part of the public API.
 * For writing persistent properties, uses broadcast to com.android.systemui.
 */
public class SysProp {
    private static final String TAG = "SysProp";

    // System property key for BES BT MAC address
    public static final String KEY_BES_BT_MAC = "persist.mentra.live.mac";

    /**
     * Get a system property value
     * @param context Application context
     * @param key System property key (e.g., "ro.custom.ota.version")
     * @return Property value or empty string if not available
     * @throws IllegalArgumentException if key is null
     */
    public static String get(Context context, String key) throws IllegalArgumentException {
        if (key == null) {
            throw new IllegalArgumentException("System property key cannot be null");
        }

        String ret = "";
        try {
            ClassLoader cl = context.getClassLoader();
            Class<?> SystemProperties = cl.loadClass("android.os.SystemProperties");
            Class<?>[] paramTypes = new Class[1];
            paramTypes[0] = String.class;
            Method get = SystemProperties.getMethod("get", paramTypes);
            Object[] params = new Object[1];
            params[0] = key;
            ret = (String) get.invoke(SystemProperties, params);

            if (ret == null) {
                ret = "";
            }
        } catch (IllegalArgumentException iAE) {
            throw iAE;
        } catch (Exception e) {
            Log.w(TAG, "Failed to read system property: " + key, e);
            ret = "";
        }
        return ret;
    }

    /**
     * Set a persistent system property value via broadcast to systemui.
     * Only works for properties starting with "persist." on Mentra Live hardware.
     * @param context Application context
     * @param key System property key (must start with "persist.")
     * @param value Property value to set
     */
    public static void set(Context context, String key, String value) {
        if (key == null || !key.startsWith("persist.")) {
            Log.e(TAG, "Cannot set system property: key must start with 'persist.' - got: " + key);
            return;
        }
        if (value == null) {
            value = "";
        }

        Log.i(TAG, "Setting system property: " + key + " = " + value);

        Intent intent = new Intent("com.xy.xsetting.action");
        intent.setPackage("com.android.systemui");
        intent.putExtra("cmd", "setProperty");
        intent.putExtra("name", key);
        intent.putExtra("value", value);
        context.sendBroadcast(intent);

        Log.d(TAG, "Sent setProperty broadcast for: " + key);
    }

    /**
     * Get the BES BT MAC address from system properties
     * @param context Application context
     * @return BT MAC address or empty string if not set
     */
    public static String getBesBtMac(Context context) {
        return get(context, KEY_BES_BT_MAC);
    }

    /**
     * Save the BES BT MAC address to system properties (persistent)
     * @param context Application context
     * @param mac BT MAC address (e.g., "12:23:AB:CD:EF:3E")
     */
    public static void setBesBtMac(Context context, String mac) {
        set(context, KEY_BES_BT_MAC, mac);
    }
}

