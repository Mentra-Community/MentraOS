package com.augmentos.asg_client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * Boot receiver for AsgClient application.
 * Listens for device boot and starts BootstrapActivity, which then starts AsgClientService.
 * This workaround is needed because Android restricts starting foreground services directly
 * from broadcast receivers in newer Android versions.
 */
public class AsgClientBootReceiver extends BroadcastReceiver {
    private static final String TAG = "AsgClientBootReceiver";
    private static final int ACTIVITY_START_DELAY_MS = 8000; // 1 second delay

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            // Use more visible error level logging for easier debugging
            Log.e(TAG, "Boot receiver triggered with action: " + intent.getAction());
            
            if (intent == null || intent.getAction() == null) {
                Log.e(TAG, "Received null intent or action");
                return;
            }
            
            // Log detailed boot information
            logBootInfo(context);
            
            // Record this boot receipt in SharedPreferences
            recordBootReceived(context, intent.getAction());
            
            String action = intent.getAction();
            if (Intent.ACTION_BOOT_COMPLETED.equals(action) || 
                    "android.intent.action.QUICKBOOT_POWERON".equals(action) ||
                    "android.intent.action.LOCKED_BOOT_COMPLETED".equals(action) ||
                    "android.intent.action.MY_PACKAGE_REPLACED".equals(action)) {
                
                Log.e(TAG, "Valid boot action received - preparing to launch BootstrapActivity");
                
                // Delay slightly to ensure system is ready
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        Log.e(TAG, "Launching BootstrapActivity after delay");
                        
                        // Start BootstrapActivity which will start the service properly
                        Intent activityIntent = new Intent(context, BootstrapActivity.class);
                        activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activityIntent.putExtra("boot_source", action);
                        activityIntent.putExtra("boot_time", System.currentTimeMillis());
                        context.startActivity(activityIntent);
                        
                        // Record successful activity launch attempt
                        recordActivityLaunchAttempt(context, true, null);
                        
                    } catch (Exception e) {
                        Log.e(TAG, "ERROR launching BootstrapActivity: " + e.getMessage(), e);
                        recordActivityLaunchAttempt(context, false, e.getMessage());
                        
                        // Fallback: Try to start service directly as a last resort
                        tryDirectServiceStart(context);
                    }
                }, ACTIVITY_START_DELAY_MS);
            } else {
                Log.e(TAG, "Unsupported action: " + action);
            }
        } catch (Exception e) {
            Log.e(TAG, "FATAL ERROR in boot receiver: " + e.getMessage(), e);
        }
    }
    
    /**
     * Record detailed boot information for debugging
     */
    private void logBootInfo(Context context) {
        try {
            Log.e(TAG, "==============================================");
            Log.e(TAG, "BOOT RECEIVER TRIGGERED");
            Log.e(TAG, "Android version: " + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");
            Log.e(TAG, "Device: " + Build.MANUFACTURER + " " + Build.MODEL);
            Log.e(TAG, "Package: " + context.getPackageName());
            Log.e(TAG, "Thread ID: " + Thread.currentThread().getId());
            Log.e(TAG, "==============================================");
        } catch (Exception e) {
            Log.e(TAG, "Error logging boot info", e);
        }
    }
    
    /**
     * Record boot events in SharedPreferences for debugging
     */
    private void recordBootReceived(Context context, String action) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("boot_stats", Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            
            // Increment boot counter
            int bootCount = prefs.getInt("boot_receiver_count", 0) + 1;
            editor.putInt("boot_receiver_count", bootCount);
            
            // Record timestamp and action
            editor.putLong("last_boot_time", System.currentTimeMillis());
            editor.putString("last_boot_action", action);
            
            editor.apply();
            
            Log.e(TAG, "Recorded boot #" + bootCount + " with action: " + action);
        } catch (Exception e) {
            Log.e(TAG, "Error recording boot stats", e);
        }
    }
    
    /**
     * Record activity launch attempts in SharedPreferences
     */
    private void recordActivityLaunchAttempt(Context context, boolean success, String errorMsg) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("boot_stats", Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            
            // Increment counter
            int attemptCount = prefs.getInt("activity_launch_count", 0) + 1;
            editor.putInt("activity_launch_count", attemptCount);
            
            // Record success/failure
            editor.putBoolean("last_activity_launch_success", success);
            if (errorMsg != null) {
                editor.putString("last_activity_launch_error", errorMsg);
            }
            
            editor.putLong("last_activity_launch_time", System.currentTimeMillis());
            
            editor.apply();
            
            Log.e(TAG, "Recorded activity launch attempt #" + attemptCount + ": " + (success ? "SUCCESS" : "FAILURE"));
        } catch (Exception e) {
            Log.e(TAG, "Error recording activity launch stats", e);
        }
    }
    
    /**
     * Fallback method to try starting service directly
     * This is a last resort if launching the activity fails
     */
    private void tryDirectServiceStart(Context context) {
        try {
            Log.e(TAG, "Attempting direct service start as fallback");
            
            // Try to start service directly
            Intent serviceIntent = new Intent(context, AsgClientService.class);
            serviceIntent.setAction(AsgClientService.ACTION_START_FOREGROUND_SERVICE);
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Log.e(TAG, "Using context.startForegroundService() for Android O+");
                context.startForegroundService(serviceIntent);
            } else {
                Log.e(TAG, "Using context.startService() for pre-Android O");
                context.startService(serviceIntent);
            }
            
            Log.e(TAG, "Direct service start attempt completed");
        } catch (Exception e) {
            Log.e(TAG, "ERROR in direct service start fallback: " + e.getMessage(), e);
        }
    }
}