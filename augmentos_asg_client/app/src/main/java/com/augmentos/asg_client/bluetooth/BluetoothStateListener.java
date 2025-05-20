package com.augmentos.asg_client.bluetooth;

/**
 * Listener interface for bluetooth state changes and data reception.
 */
public interface BluetoothStateListener {
    /**
     * Called when the bluetooth connection state changes
     * @param connected true if connected, false if disconnected
     */
    void onConnectionStateChanged(boolean connected);
    
    /**
     * Called when data is received from the connected device
     * @param data The received data
     */
    void onDataReceived(byte[] data);
}