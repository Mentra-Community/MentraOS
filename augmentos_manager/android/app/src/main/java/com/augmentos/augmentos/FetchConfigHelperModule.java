package com.augmentos.augmentos;

import android.content.res.Resources;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class FetchConfigHelperModule extends ReactContextBaseJavaModule {

    public FetchConfigHelperModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "FetchConfigHelperModule";
    }

    @ReactMethod
    public void fetchConfig(String packageName, Promise promise) {
        try {
            // Get resources
            ReactApplicationContext context = getReactApplicationContext();
            Resources res = context.getResources();

            // Get resource ID dynamically using packageName
            int resId = res.getIdentifier("config", "raw", packageName);

            if (resId == 0) {
                promise.reject("CONFIG_NOT_FOUND", "Config file not found in raw resources.");
                return;
            }

            // Open the raw resource
            InputStream is = res.openRawResource(resId);

            // Read the file into a String
            byte[] buffer = new byte[is.available()];
            is.read(buffer);
            is.close();
            String configJson = new String(buffer, StandardCharsets.UTF_8);

            // Resolve the promise with the JSON string
            promise.resolve(configJson);
        } catch (Exception e) {
            promise.reject("CONFIG_READ_ERROR", "Error reading config file", e);
        }
    }
}