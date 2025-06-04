package com.augmentos.augmentos;


import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.util.Log;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.greenrobot.eventbus.EventBus;
import org.json.JSONObject;

public class NotificationServiceModule extends ReactContextBaseJavaModule {

    private static final String TAG = "NotificationServiceUtils";
    private static ReactApplicationContext reactContext;


    public NotificationServiceModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        NotificationService.setReactApplicationContext(reactContext);

    }

    @Override
    public String getName() {
        return "NotificationServiceUtils";
    }

    // Method to check if Notification Listener is enabled
    @ReactMethod
    public void isNotificationListenerEnabled(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            String enabledListeners = Settings.Secure.getString(
                    context.getContentResolver(),
                    "enabled_notification_listeners"
            );
            ComponentName myListener = new ComponentName(context, NotificationService.class);
            boolean isEnabled = enabledListeners != null && enabledListeners.contains(myListener.flattenToString());
            promise.resolve(isEnabled);
        } catch (Exception e) {
            promise.reject("ERROR", e);
        }
    }

    // Method to start the Notification Listener Service
    @ReactMethod
    public void startNotificationListenerService(Promise promise) {
        try {
            Log.d(TAG, "Starting notification listener service");
            Context context = getReactApplicationContext();
            Intent serviceIntent = new Intent(context, NotificationService.class);
            context.startService(serviceIntent);
            promise.resolve("Service started successfully.");
        } catch (Exception e) {
            promise.reject("ERROR", e);
        }
    }

    // Method to stop the Notification Listener Service
    @ReactMethod
    public void stopNotificationListenerService(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            Intent serviceIntent = new Intent(context, NotificationService.class);
            context.stopService(serviceIntent);
            promise.resolve("Service stopped successfully.");
        } catch (Exception e) {
            promise.reject("ERROR", e);
        }
    }

    // Send notifications to React Native
    private void sendNotificationToJS(String jsonString) {
        Log.d(TAG, "sendNotificationToJS - jsonString: " + jsonString);
        getReactApplicationContext()
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onNotificationPosted", jsonString);
    }

    // Method in NotificationServiceModule.java to process notification
    public void onNotificationPosted(String jsonString) {
        try {
            Log.d(TAG, "onNotificationPosted START - jsonString: " + jsonString);
            sendNotificationToJS(jsonString); // Uncommented to send to JS
            
            // Post to EventBus for AugmentOSCommunicator to handle
            try {
                JSONObject json = new JSONObject(jsonString);
                String appName = json.getString("appName");
                String title = json.getString("title");
                String text = json.getString("text");
                
                NewNotificationReceivedEvent event = new NewNotificationReceivedEvent(appName, title, text);
                EventBus.getDefault().post(event);
                
                // Log confirmation that event was posted
                Log.d(TAG, "Posted notification to EventBus: " + event.toString());
            } catch (Exception e) {
                Log.e(TAG, "Error parsing notification JSON", e);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in onNotificationPosted: ", e);
        }
    }

    @ReactMethod
    public void addListener(String eventName) {
        Log.d(TAG, "addListener: Event listener added for " + eventName);
    }

    @ReactMethod
    public void removeListeners(int count) {
        Log.d(TAG, "removeListeners: Removed " + count + " listeners");
    }
}