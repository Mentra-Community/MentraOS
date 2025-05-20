package com.augmentos.augmentos.logcapture;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;

public class LogcatCaptureModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext reactContext;

    public LogcatCaptureModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @Override
    public String getName() {
        return "LogcatCapture";
    }

    @ReactMethod
    public void getLogs(int logSize, Promise promise) {
        try {
            Process process = Runtime.getRuntime().exec("logcat -d -t " + logSize);
            BufferedReader bufferedReader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()));

            StringBuilder log = new StringBuilder();
            String line;
            while ((line = bufferedReader.readLine()) != null) {
                log.append(line).append("\n");
            }

            promise.resolve(log.toString());
        } catch (Exception e) {
            promise.reject("ERR_UNEXPECTED_EXCEPTION", e);
        }
    }
    
    @ReactMethod
    public void clearLogs(Promise promise) {
        try {
            Runtime.getRuntime().exec("logcat -c");
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("ERR_UNEXPECTED_EXCEPTION", e);
        }
    }
}