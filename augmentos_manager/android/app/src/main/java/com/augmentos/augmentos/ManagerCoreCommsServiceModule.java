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
 * This module serves as an interface to the AugmentOSCommunicator singleton
 */
public class ManagerCoreCommsServiceModule extends ReactContextBaseJavaModule {
    private static final String TAG = "ManagerCoreCommsServiceModule";
    private final ReactApplicationContext reactContext;
    private static ManagerCoreCommsServiceModule moduleInstance;

    public ManagerCoreCommsServiceModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        moduleInstance = this;
        
        // Initialize the communicator right away
        AugmentOSCommunicator.getInstance().initialize(reactContext);
    }

    @Override
    public String getName() {
        return "ManagerCoreCommsService";
    }

    public static ManagerCoreCommsServiceModule getInstance() {
        return moduleInstance;
    }

    @ReactMethod
    public void startService() {
        try {
            // Initialize the communicator if not already initialized
            if (!AugmentOSCommunicator.getInstance().isInitialized()) {
                AugmentOSCommunicator.getInstance().initialize(reactContext);
            }
            
            // Start the core service
            startAugmentosCoreService();
            
            Log.d(TAG, "AugmentOSCommunicator initialized and core service started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize AugmentOSCommunicator", e);
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
            Log.e(TAG, "Failed to start core service", e);
        }
    }

    @ReactMethod
    public void stopService() {
        // Cleanup the communicator
        AugmentOSCommunicator.getInstance().cleanup();
        
        // Log that we're explicitly resetting the listener state
        Log.d(TAG, "Event listeners will be recreated on next initialization");
        
        // We can't directly clear RCTDeviceEventEmitter listeners, but the cleanup()
        // method above should reset everything properly
        
        Log.d(TAG, "AugmentOSCommunicator cleaned up");
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean isServiceRunning() {
        return AugmentOSCommunicator.getInstance().isInitialized();
    }

    @ReactMethod
    public void sendCommandToCore(String jsonString) {
        if (!AugmentOSCommunicator.getInstance().isInitialized()) {
            startService();
        }

        AugmentOSCommunicator.getInstance().sendCommandToCore(jsonString);
    }

    public void emitMessageToJS(String eventName, String message) {
        if (reactContext.hasActiveCatalystInstance()) {
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(eventName, message);
        }
    }

    // AddListener Implementation
    @ReactMethod
    public void addListener(String eventName) {
        Log.d(TAG, "addListener: Event listener added for " + eventName);
        // No additional setup required for basic event listeners
    }

    @ReactMethod
    public void removeListeners(int count) {
        Log.d(TAG, "removeListeners: Removed " + count + " listeners");
        // No additional teardown required for basic event listeners
    }
}