package com.augmentos.augmentos_core;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.d(TAG, "BootReceiver triggered");
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.d(TAG, "Starting AugmentosService...");
            Intent serviceIntent = new Intent(context, AugmentosService.class);

            // For Android Oreo (API 26) and above, use startForegroundService
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Log.d(TAG, "Using startForegroundService for AugmentosService");

                // TODO: Reenable this
                //context.startForegroundService(serviceIntent);
            } else {
                //context.startService(serviceIntent);
            }
        }
    }
}
