package com.mentra.asg_client.service.utils;

import android.content.Context;
import android.util.Log;

import java.lang.reflect.Method;

/**
 * Utility class for reading Android system properties.
 * Uses reflection to access android.os.SystemProperties which is not part of the public API.
 */
public class SysProp {
    private static final String TAG = "SysProp";
    
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
}

