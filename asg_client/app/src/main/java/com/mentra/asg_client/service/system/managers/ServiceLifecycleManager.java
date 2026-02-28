package com.mentra.asg_client.service.system.managers;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.SysControl;
import com.mentra.asg_client.io.ota.services.OtaService;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IServiceLifecycle;

/**
 * Manages service lifecycle operations.
 * Follows Single Responsibility Principle by handling only lifecycle concerns.
 */
public class ServiceLifecycleManager implements IServiceLifecycle {
    
    private static final String TAG = "ServiceLifecycleManager";
    
    private final Context context;
    private final AsgClientServiceManager serviceManager;
    private final CommandProcessor commandProcessor;
    private final AsgNotificationManager notificationManager;
    
    private boolean isInitialized = false;
    
    public ServiceLifecycleManager(Context context, 
                                 AsgClientServiceManager serviceManager,
                                 CommandProcessor commandProcessor,
                                 AsgNotificationManager notificationManager) {
        this.context = context;
        this.serviceManager = serviceManager;
        this.commandProcessor = commandProcessor;
        this.notificationManager = notificationManager;
    }
    
    @Override
    public void initialize() {
        if (isInitialized) {
            Log.d(TAG, "Service already initialized");
            return;
        }
        
        Log.d(TAG, "Initializing service lifecycle");
        
        // Initialize managers
        serviceManager.initialize();
        
        // Schedule OTA service start
        scheduleOtaServiceStart();
        
        // Clean up system packages
        // cleanupSystemPackages(); Not needed anymore
        
        isInitialized = true;
        Log.d(TAG, "Service lifecycle initialized successfully");
    }
    
    @Override
    public void onStart() {
        Log.d(TAG, "Service starting");
        
        // Create notification channel and start foreground
        notificationManager.createNotificationChannel();
        // Note: Actual foreground start is handled by the service itself
    }
    
    @Override
    public void handleAction(String action, Bundle extras) {
        Log.d(TAG, "Handling service action: " + action);
        
        switch (action) {
            case "ACTION_START_CORE":
            case "MY_ACTION_START_FOREGROUND_SERVICE":
                handleStartService();
                break;
            case "com.mentra.asg_client.ACTION_RESTART_SERVICE":
                handleRestartService();
                break;
            case "ACTION_STOP_CORE":
            case "MY_ACTION_STOP_FOREGROUND_SERVICE":
                handleStopService();
                break;
            case "com.mentra.asg_client.ACTION_RESTART_CAMERA":
                handleRestartCamera();
                break;
            default:
                Log.d(TAG, "Unknown action: " + action);
                break;
        }
    }
    
    @Override
    public void cleanup() {
        Log.d(TAG, "Cleaning up service lifecycle");
        
        // Clean up managers
        if (serviceManager != null) {
            serviceManager.cleanup();
        }
        
        isInitialized = false;
        Log.d(TAG, "Service lifecycle cleanup completed");
    }
    
    @Override
    public boolean isInitialized() {
        return isInitialized;
    }
    
    private void scheduleOtaServiceStart() {
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            Log.d(TAG, "Starting internal OTA service after delay");
            Intent otaIntent = new Intent(context, OtaService.class);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(otaIntent);
            } else {
                context.startService(otaIntent);
            }
        }, 5000);
    }
    
    private void cleanupSystemPackages() {
        SysControl.uninstallPackage(context, "com.lhs.btserver");
        SysControl.uninstallPackageViaAdb(context, "com.lhs.btserver");
    }
    
    private void handleStartService() {
        Log.d(TAG, "Handling start service action");
        // Implementation would be handled by the service itself
    }
    
    private void handleRestartService() {
        Log.d(TAG, "Handling restart service action");
        // Implementation would be handled by the service itself
    }
    
    private void handleStopService() {
        Log.d(TAG, "Handling stop service action");
        // Implementation would be handled by the service itself
    }
    
    private void handleRestartCamera() {
        Log.d(TAG, "Handling restart camera action");
        try {
            SysControl.injectAdbCommand(context, 
                "pm grant " + context.getPackageName() + " android.permission.CAMERA");
            SysControl.injectAdbCommand(context, 
                "kill $(pidof cameraserver)");
            SysControl.injectAdbCommand(context, 
                "kill $(pidof mediaserver)");
        } catch (Exception e) {
            Log.e(TAG, "Error resetting camera service", e);
        }
    }
} 