package com.augmentos.augmentos_core;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class NewPermissionUtils {

    // Base permissions required for most Android versions
    private static final String[] BASE_PERMISSIONS = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.RECORD_AUDIO,
//            Manifest.permission.READ_PHONE_STATE,
//            Manifest.permission.CAMERA,
            Manifest.permission.POST_NOTIFICATIONS
    };

    /**
     * Returns all the permissions required by the core, dynamically determined
     * by Android version.
     */
    public static String[] getRequiredPermissions() {
        List<String> permissionsList = new ArrayList<>(Arrays.asList(BASE_PERMISSIONS));

        // Conditionally add WRITE_EXTERNAL_STORAGE for devices < Android 10
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            permissionsList.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }

        // For Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // TODO: Temporarily remove this as I don't think we need this right now
            // permissionsList.add(Manifest.permission.READ_MEDIA_IMAGES);
        } else {
            // For devices below Android 13
            permissionsList.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }

        // Add calendar permissions if your app requires calendar access
        permissionsList.add(Manifest.permission.READ_CALENDAR);
        // Optionally add WRITE_CALENDAR if you plan to modify calendar events
        permissionsList.add(Manifest.permission.WRITE_CALENDAR);

        return permissionsList.toArray(new String[0]);
    }

    /**
     * Checks if all required permissions are currently granted.
     * @param context The context to use for checking permissions.
     * @return True if all required permissions are granted, false otherwise.
     */
    public static boolean areAllPermissionsGranted(Context context) {
        String[] requiredPermissions = getRequiredPermissions();
        for (String permission : requiredPermissions) {
            if (ContextCompat.checkSelfPermission(context, permission)
                    != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }

        // Check background location if API >= Q
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    // Optionally, you can add a helper method for whether background location is granted.
    // public static boolean isBackgroundLocationGranted(Context context) {
    //    // ...
    // }
}
