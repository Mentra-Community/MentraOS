package com.augmentos.augmentos;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import android.content.pm.PackageInfo;
import android.content.pm.ApplicationInfo;
import java.util.ArrayList;
import java.util.List;


public class TpaHelpersModule extends ReactContextBaseJavaModule {
    private static final String MODULE_NAME = "TpaHelpers";
    private final ReactApplicationContext reactContext;

    public TpaHelpersModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

//    @ReactMethod
//    public void launchTargetApp(String packageName, Promise promise) {
//        if (isAppInstalled(packageName)) {
//            launchTargetApp(packageName);
//            promise.resolve(true);
//        } else {
//            promise.resolve(false);
//        }
//    }

    @ReactMethod
    public void isAppInstalled(String packageName, Promise promise) {
        promise.resolve(isAppInstalled(packageName));
    }

    @ReactMethod
    public void launchTargetApp(String packageName) {
        PackageManager pm = getReactApplicationContext().getPackageManager();
        Intent launchIntent = pm.getLaunchIntentForPackage(packageName);

        if (launchIntent != null) {
            getReactApplicationContext().startActivity(launchIntent);
        }
    }

    private boolean isAppInstalled(String packageName) {
        try {
            getReactApplicationContext()
                    .getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            System.out.println("App not found: " + packageName);
            return false;
        }
    }
}
