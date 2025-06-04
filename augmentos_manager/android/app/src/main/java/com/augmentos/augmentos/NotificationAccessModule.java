package com.augmentos.augmentos;

import android.app.Activity;
import android.content.Intent;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.util.Set;

public class NotificationAccessModule extends ReactContextBaseJavaModule {

    public NotificationAccessModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "NotificationAccess";
    }

    @ReactMethod
    public void hasNotificationAccess(Promise promise) {
        try {
            ReactApplicationContext context = getReactApplicationContext();
            Set<String> enabledListenerPackages = NotificationManagerCompat.getEnabledListenerPackages(context);
            boolean hasAccess = enabledListenerPackages.contains(context.getPackageName());
            promise.resolve(hasAccess);
        } catch (Exception e) {
            promise.reject("ERROR_CHECKING_ACCESS", e);
        }
    }

    @ReactMethod
    public void requestNotificationAccess(Promise promise) {
        try {
            Activity currentActivity = getCurrentActivity();
            if (currentActivity == null) {
                promise.reject("NO_ACTIVITY", "No current activity to open settings");
                return;
            }

            Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            currentActivity.startActivity(intent);

            promise.resolve("OPENED_NOTIFICATION_ACCESS_SETTINGS");
        } catch (Exception e) {
            promise.reject("ERROR_OPENING_SETTINGS", e);
        }
    }
}