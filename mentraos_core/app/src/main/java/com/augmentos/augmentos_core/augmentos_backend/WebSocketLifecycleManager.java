package com.augmentos.augmentos_core.augmentos_backend;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleObserver;
import androidx.lifecycle.OnLifecycleEvent;
import androidx.lifecycle.ProcessLifecycleOwner;

import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

/**
 * Manages WebSocket lifecycle based on app state and smart glasses connection.
 *
 * This class:
 * 1. Tracks whether the app is in foreground using ProcessLifecycleOwner
 * 2. Monitors smart glasses connection state
 * 3. Connects/disconnects WebSocket based on both conditions
 */
public class WebSocketLifecycleManager implements LifecycleObserver {
    private static final String TAG = "WearableAi_WebSocketLifecycleManager";

    private final Context applicationContext;
    private final AuthHandler authHandler;

    private boolean isAppInForeground = false;
    private boolean isSmartGlassesConnected = false;
    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());

    public WebSocketLifecycleManager(Context context, AuthHandler authHandler) {
        this.applicationContext = context.getApplicationContext();
        this.authHandler = authHandler;

        // Register with ProcessLifecycleOwner to monitor app lifecycle
        ProcessLifecycleOwner.get().getLifecycle().addObserver(this);

        // Initialize foreground state
        isAppInForeground = ProcessLifecycleOwner.get().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
        Log.d(TAG, "Initial foreground state: " + isAppInForeground);
    }

    /**
     * Update the smart glasses connection state
     */
    public void updateSmartGlassesState(boolean isConnected) {
        if (this.isSmartGlassesConnected != isConnected) {
            this.isSmartGlassesConnected = isConnected;
            updateWebSocketState();
        }
    }

    /**
     * Update the smart glasses connection state from SmartGlassesConnectionState
     */
    public void updateSmartGlassesState(SmartGlassesConnectionState state) {
        boolean isConnected = state == SmartGlassesConnectionState.CONNECTED;
        updateSmartGlassesState(isConnected);
    }

    /**
     * Updates the WebSocket connection based on current state
     */
    private void updateWebSocketState() {
        // Get current token
        String coreToken = authHandler.getCoreToken();

        // Keep WebSocket connected if EITHER:
        // 1. App is in foreground, OR
        // 2. Smart glasses are connected
        if (isAppInForeground || isSmartGlassesConnected) {
            if (coreToken != null && !ServerComms.getInstance().isWebSocketConnected()) {
                Log.d(TAG, "Connecting WebSocket: " +
                        (isAppInForeground ? "app in foreground" : "") +
                        (isSmartGlassesConnected ? (isAppInForeground ? " and " : "") + "glasses connected" : ""));
                ServerComms.getInstance().connectWebSocket(coreToken);
            }
        }
        // Disconnect ONLY when BOTH conditions are false:
        // 1. App is in background, AND
        // 2. Smart glasses are disconnected
        else if (!isAppInForeground && !isSmartGlassesConnected) {
            if (ServerComms.getInstance().isWebSocketConnected()) {
                Log.d(TAG, "Disconnecting WebSocket: app in background AND glasses disconnected");
                ServerComms.getInstance().disconnectWebSocket();
            }
        }
    }

    /**
     * Manually set foreground state (can be used for testing or specific scenarios)
     */
    public void setAppInForeground(boolean inForeground) {
        if (this.isAppInForeground != inForeground) {
            this.isAppInForeground = inForeground;
            updateWebSocketState();
        }
    }

    /**
     * Clean up resources
     */
    public void cleanup() {
        ProcessLifecycleOwner.get().getLifecycle().removeObserver(this);
        reconnectHandler.removeCallbacksAndMessages(null);
    }

    // ProcessLifecycleOwner callbacks

    @OnLifecycleEvent(Lifecycle.Event.ON_START)
    public void onAppForeground() {
        Log.d(TAG, "App moved to foreground");
        isAppInForeground = true;
        updateWebSocketState();
    }

    @OnLifecycleEvent(Lifecycle.Event.ON_STOP)
    public void onAppBackground() {
        Log.d(TAG, "App moved to background");
        isAppInForeground = false;
        updateWebSocketState();
    }
}