package com.augmentos.augmentos;

import android.content.Intent;
import android.util.Log;

import com.augmentos.augmentos_core.AugmentosService;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * React Native module for communicating with AugmentOS Core
 * Simplified replacement for ManagerCoreCommsServiceModule
 */
public class CoreCommsServiceModule extends ReactContextBaseJavaModule {
    private static final String TAG = "CoreCommsServiceModule";
    private final ReactApplicationContext reactContext;
    private static CoreCommsServiceModule moduleInstance;
    private boolean isInitialized = false;

    public CoreCommsServiceModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        moduleInstance = this;
        
        // Initialize communicator right away
        AugmentOSCommunicator.getInstance().initialize(reactContext);
        isInitialized = true;
    }

    @Override
    public String getName() {
        return "CoreCommsService";
    }

    public static CoreCommsServiceModule getInstance() {
        return moduleInstance;
    }

    @ReactMethod
    public void startService() {
        try {
            // Initialize the communicator if not already done
            if (!isInitialized || !AugmentOSCommunicator.getInstance().isInitialized()) {
                AugmentOSCommunicator.getInstance().initialize(reactContext);
                isInitialized = true;
            }
            
            // Start Core service
            startAugmentosCoreService();
            
            Log.d(TAG, "Core service started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start Core service", e);
        }
    }

    @ReactMethod
    public void startAugmentosCoreService() {
        try {
            Intent intent = new Intent(getReactApplicationContext(), AugmentosService.class);
            intent.setAction("ACTION_START_CORE");
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                getReactApplicationContext().startForegroundService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to start Core service", e);
        }
    }

    @ReactMethod
    public void stopService() {
        try {
            // Stop Core service
            Intent intent = new Intent(getReactApplicationContext(), AugmentosService.class);
            intent.setAction("ACTION_STOP_CORE");
            getReactApplicationContext().stopService(intent);
            
            // Cleanup communicator
            AugmentOSCommunicator.getInstance().cleanup();
            isInitialized = false;
            
            Log.d(TAG, "Core service stopped and communicator cleaned up");
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop Core service", e);
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean isServiceRunning() {
        return isInitialized && AugmentOSCommunicator.getInstance().isInitialized();
    }

    @ReactMethod
    public void sendCommandToCore(String jsonString) {
        if (!isInitialized || !AugmentOSCommunicator.getInstance().isInitialized()) {
            startService();
        }

        AugmentOSCommunicator.getInstance().sendCommandToCore(jsonString);
    }

    /**
     * Emits a message to JavaScript
     */
    public void emitMessageToJS(String eventName, String message) {
        if (reactContext.hasActiveCatalystInstance()) {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(eventName, message);
        }
    }

    // Event listener implementation
    @ReactMethod
    public void addListener(String eventName) {
        Log.d(TAG, "Added listener for: " + eventName);
    }

    @ReactMethod
    public void removeListeners(int count) {
        Log.d(TAG, "Removed " + count + " listeners");
    }
}