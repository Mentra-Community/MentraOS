package com.mentra.asg_client.io.bluetooth.core;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.interfaces.BluetoothStateListener;

import java.util.ArrayList;
import java.util.List;

/**
 * Base implementation of the IBluetoothManager interface.
 * Provides common functionality for all bluetooth manager implementations.
 */
public abstract class BaseBluetoothManager implements IBluetoothManager {
    private static final String TAG = "BaseBluetoothManager";
    
    protected final Context context;
    protected final List<BluetoothStateListener> listeners = new ArrayList<>();
    protected boolean isConnected = false;
    
    /**
     * Create a new BaseBluetoothManager
     * @param context The application context
     */
    public BaseBluetoothManager(Context context) {
        this.context = context.getApplicationContext();
    }
    
    @Override
    public void addBluetoothListener(BluetoothStateListener listener) {
        if (!listeners.contains(listener)) {
            listeners.add(listener);
        }
    }
    
    @Override
    public void removeBluetoothListener(BluetoothStateListener listener) {
        listeners.remove(listener);
    }
    
    /**
     * Notify all listeners that the bluetooth connection state has changed
     * @param connected true if connected, false otherwise
     */
    protected void notifyConnectionStateChanged(boolean connected) {
        Log.d(TAG, "Bluetooth connection state changed: " + (connected ? "CONNECTED" : "DISCONNECTED"));
        this.isConnected = connected;
        for (BluetoothStateListener listener : listeners) {
            try {
                listener.onConnectionStateChanged(connected);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener of connection state change", e);
            }
        }
    }
    
    /**
     * Notify all listeners that data has been received
     * @param data The received data
     */
    protected void notifyDataReceived(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "Attempted to notify data received with null or empty data");
            return;
        }
        
        Log.d(TAG, "Bluetooth data received: " + data.length + " bytes");
        for (BluetoothStateListener listener : listeners) {
            try {
                listener.onDataReceived(data);
            } catch (Exception e) {
                Log.e(TAG, "Error notifying listener of data reception", e);
            }
        }
    }
    
    @Override
    public boolean isConnected() {
        return isConnected;
    }
    
    /**
     * Initialize the bluetooth manager
     * Default implementation just logs the initialization
     */
    @Override
    public void initialize() {
        Log.d(TAG, "Initializing bluetooth manager");
    }
    
    /**
     * Clean up resources
     * Default implementation clears listeners
     */
    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down bluetooth manager");
        listeners.clear();
    }
    
    /**
     * Send a test image from assets folder (for testing purposes)
     * Default implementation returns false. Override in subclasses that support file transfer.
     * 
     * @param assetFileName Name of the image file in assets folder
     * @return true if transfer started, false otherwise
     */
    public boolean sendTestImageFromAssets(String assetFileName) {
        Log.w(TAG, "sendTestImageFromAssets not implemented in " + getClass().getSimpleName());
        return false;
    }

    public boolean sendImageFile(String path){
        Log.w(TAG, "sendImageFile not implemented in " + getClass().getSimpleName());
        return false;
    }
} 