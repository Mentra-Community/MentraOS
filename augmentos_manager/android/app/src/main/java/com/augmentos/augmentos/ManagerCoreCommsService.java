package com.augmentos.augmentos;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

// This class is deprecated and will be removed in future versions
// It's kept as a stub to maintain backward compatibility
// All functionality has been moved to AugmentOSCommunicator
public class ManagerCoreCommsService extends Service {
    public final String TAG = "ManagerCoreCommsService";

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "onCreate: This service is deprecated and no longer used");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "onStartCommand: This service is deprecated and no longer used");
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy: Called");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public void processCoreMessage(String jsonString) {
        // No-op
    }

    public void sendCommandToCore(String jsonString) {
        // Forward to new implementation
        AugmentOSCommunicator.getInstance().sendCommandToCore(jsonString);
    }
}