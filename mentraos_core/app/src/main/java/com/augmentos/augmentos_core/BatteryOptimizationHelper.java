package com.augmentos.augmentos_core;

import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import java.lang.reflect.Method;

public class BatteryOptimizationHelper {
    private static final String TAG = "BatteryOptimizationHelper";

    // Check if the app is a system app
    public static boolean isSystemApp(Context context) {
        return (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
    }

    // Check if the app is already exempt from battery optimization
    public static boolean isWhitelisted(Context context) {
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    // Try to whitelist the app programmatically
    public static void tryWhitelistApp(Context context) {
        if (isSystemApp(context)) {
            try {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                String packageName = context.getPackageName();

                // Access hidden method via reflection
                Method method = pm.getClass().getDeclaredMethod("addIgnoredBatteryOptimizations", String.class);
                method.setAccessible(true);
                boolean result = (boolean) method.invoke(pm, packageName);

                Log.d(TAG, result
                        ? "Successfully added to battery optimization whitelist."
                        : "Failed to add to battery optimization whitelist.");
            } catch (Exception e) {
                Log.e(TAG, "Error while whitelisting battery optimization", e);
            }
        } else {
            Log.d(TAG, "App is not a system app; cannot programmatically whitelist.");
        }
    }

    // Prompt the user manually if the app is not already whitelisted
    public static void promptUserToDisableOptimization(Context context) {
        Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    public static void handleBatteryOptimization(Context context) {
        // Check if the app is already whitelisted
        if (BatteryOptimizationHelper.isWhitelisted(context)) {
            Log.d(TAG, "App is already exempt from battery optimization.");
            return;
        }

        // Attempt to whitelist programmatically if it's a system app
        BatteryOptimizationHelper.tryWhitelistApp(context);

        // If not a system app, prompt the user to manually disable battery optimization
        if (!BatteryOptimizationHelper.isSystemApp(context)) {
            BatteryOptimizationHelper.promptUserToDisableOptimization(context);
        }
    }
}