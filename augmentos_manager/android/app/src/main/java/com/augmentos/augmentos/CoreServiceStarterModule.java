package com.augmentos.augmentos;

import android.content.ComponentName;
import android.content.Intent;
import android.location.LocationManager;
import android.util.Log;
import android.content.pm.PackageManager;
import android.content.Context;


import com.augmentos.augmentos_core.AugmentosService;
import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.NewPermissionUtils;
import com.augmentos.augmentos_core.PermissionsActivity;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class CoreServiceStarterModule extends ReactContextBaseJavaModule {
    private static final String TAG = "CoreServiceStarter";

    public CoreServiceStarterModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "ServiceStarter";
    }

    @ReactMethod
    public void startService() {
        try {
            //Intent intent = new Intent();
            //intent.setComponent(new ComponentName(
            //        "com.augmentos.augmentos_core",
            //        "com.augmentos.augmentos_core.AugmentosService"));
            Intent intent = new Intent(getReactApplicationContext(), AugmentosService.class);


            intent.setAction("ACTION_START_CORE");

            Log.d(TAG, "Intent: " + intent.toString());
            Log.d(TAG, "PackageManager resolves service: " +
                    getReactApplicationContext().getPackageManager().resolveService(intent, 0));

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                Log.d(TAG, "Starting service as foreground service");
                getReactApplicationContext().startForegroundService(intent);
                // } else {
                // Log.d(TAG, "Starting service as normal service");
                // getReactApplicationContext().startService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to start service", e);
        }
    }

    @ReactMethod
    public void stopService() {
        try {
            Intent intent = new Intent(getReactApplicationContext(), AugmentosService.class);
            intent.setAction("ACTION_STOP_CORE");

            Log.d(TAG, "Stopping service with intent: " + intent.toString());

            getReactApplicationContext().stopService(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop service", e);
        }
    }

    @ReactMethod
    public void openPermissionsActivity() {
        try {

            Intent intent = new Intent(getReactApplicationContext(), PermissionsActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(intent);
        } catch (Exception e) {
            Log.d(TAG, "Error opening the app, " + e);
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean isAugmentOsCoreInstalled() {
        // Core is just a library now, so it is always installed
        return true;
//        try {
//            getReactApplicationContext()
//                    .getPackageManager()
//                    .getPackageInfo("com.augmentos.augmentos_core", 0);
//            return true;
//        } catch (PackageManager.NameNotFoundException e) {
//            return false;
//        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean areAllCorePermissionsGranted() {
        return NewPermissionUtils.areAllPermissionsGranted(getReactApplicationContext());
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean isLocationEnabled() {
        try {
            LocationManager locationManager = (LocationManager) getReactApplicationContext().getSystemService(Context.LOCATION_SERVICE);
            boolean gpsEnabled = locationManager != null && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
            boolean networkEnabled = locationManager != null && locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            Log.d(TAG, "Location services: GPS=" + gpsEnabled + ", Network=" + networkEnabled);
            return gpsEnabled || networkEnabled;
        } catch (Exception e) {
            Log.e(TAG, "Failed to check location status", e);
            return false;
        }
    }
}
