package com.augmentos.asg_client;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

/**
 * A transparent activity that starts the AsgClientService as a foreground service
 * and then finishes itself. This is used to launch the service after boot.
 */
public class BootstrapActivity extends Activity {
    private static final String TAG = "BootstrapActivity";
    private static final int STARTUP_DELAY_MS = 3000; // 3 second delay before starting service
    private static final int FINISH_DELAY_MS = 2000;  // 2 second delay after starting before finishing
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        try {
            super.onCreate(savedInstanceState);
            Log.e(TAG, "BootstrapActivity onCreate - preparing to start AsgClientService");
            
            // Log boot information for debugging
            logBootInfo();
            
            // Create PowerManager WakeLock to ensure we stay awake during service start
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "AugmentOS:BootstrapWakeLock");
            wakeLock.acquire(60000); // 60 second timeout as safety
            
            // Wait a moment to let system services fully initialize, then start our service
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    Log.e(TAG, "BootstrapActivity delayed execution - starting AsgClientService now");
                    
                    // Start AsgClientService as a foreground service
                    Intent serviceIntent = new Intent(this, AsgClientService.class);
                    serviceIntent.setAction(AsgClientService.ACTION_START_FOREGROUND_SERVICE);
                    
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        Log.e(TAG, "Using startForegroundService for Android O+");
                        startForegroundService(serviceIntent);
                    } else {
                        Log.e(TAG, "Using startService for pre-Android O");
                        startService(serviceIntent);
                    }
                    
                    // Record successful start attempt
                    recordServiceStartAttempt(true);
                    
                    // Wait a moment to ensure the service starts properly, then finish
                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                        Log.e(TAG, "AsgClientService started, finishing BootstrapActivity");
                        if (wakeLock.isHeld()) {
                            wakeLock.release();
                        }
                        finish();
                    }, FINISH_DELAY_MS);
                    
                } catch (Exception e) {
                    Log.e(TAG, "ERROR starting AsgClientService: " + e.getMessage(), e);
                    recordServiceStartAttempt(false);
                    if (wakeLock.isHeld()) {
                        wakeLock.release();
                    }
                    finish();
                }
            }, STARTUP_DELAY_MS);
            
        } catch (Exception e) {
            Log.e(TAG, "FATAL ERROR in BootstrapActivity onCreate: " + e.getMessage(), e);
            finish();
        }
    }
    
    /**
     * Record boot information for debugging purposes
     */
    private void logBootInfo() {
        try {
            Log.e(TAG, "==============================================");
            Log.e(TAG, "BOOTSTRAP INFO - STARTING SERVICE ON BOOT");
            Log.e(TAG, "Android version: " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");
            Log.e(TAG, "Device: " + Build.MANUFACTURER + " " + Build.MODEL);
            Log.e(TAG, "Thread ID: " + Thread.currentThread().getId());
            Log.e(TAG, "==============================================");
        } catch (Exception e) {
            Log.e(TAG, "Error logging boot info", e);
        }
    }
    
    /**
     * Record service start attempt in SharedPreferences for debugging
     */
    private void recordServiceStartAttempt(boolean success) {
        try {
            SharedPreferences prefs = getSharedPreferences("boot_stats", MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            
            // Increment boot attempt counter
            int attempts = prefs.getInt("boot_attempts", 0) + 1;
            editor.putInt("boot_attempts", attempts);
            
            // Record success/failure
            if (success) {
                int successes = prefs.getInt("boot_successes", 0) + 1;
                editor.putInt("boot_successes", successes);
            } else {
                int failures = prefs.getInt("boot_failures", 0) + 1;
                editor.putInt("boot_failures", failures);
            }
            
            // Save timestamp
            editor.putLong("last_boot_attempt", System.currentTimeMillis());
            editor.putBoolean("last_boot_success", success);
            
            editor.apply();
            
            Log.e(TAG, "Recorded boot attempt: " + (success ? "SUCCESS" : "FAILURE") + 
                    " (Total: " + attempts + ")");
        } catch (Exception e) {
            Log.e(TAG, "Error recording boot stats", e);
        }
    }
    
    @Override
    protected void onDestroy() {
        try {
            Log.e(TAG, "BootstrapActivity onDestroy");
            super.onDestroy();
        } catch (Exception e) {
            Log.e(TAG, "Error in onDestroy", e);
        }
    }
}