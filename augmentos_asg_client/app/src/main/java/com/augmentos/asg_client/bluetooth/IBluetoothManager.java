package com.augmentos.asg_client.bluetooth;

/**
 * Interface for bluetooth management operations across different device types.
 * This interface abstracts BLE operations to support different
 * implementations for different device types (K900, standard Android).
 */
public interface IBluetoothManager {
    /**
     * Initialize the bluetooth manager and check current connectivity
     */
    void initialize();
    
    /**
     * Start advertising BLE services to allow companion app to discover
     * and connect to the glasses
     */
    void startAdvertising();
    
    /**
     * Stop BLE advertising
     */
    void stopAdvertising();
    
    /**
     * Check if the device is currently connected to a companion device
     * @return true if connected via BLE, false otherwise
     */
    boolean isConnected();
    
    /**
     * Disconnect from the currently connected device
     */
    void disconnect();
    
    /**
     * Send data to the connected device
     * @param data The data to send
     * @return true if the data was sent successfully, false otherwise
     */
    boolean sendData(byte[] data);
    
    /**
     * Add a listener for Bluetooth state changes and data reception
     * @param listener The listener to add
     */
    void addBluetoothListener(BluetoothStateListener listener);
    
    /**
     * Remove a previously added Bluetooth state listener
     * @param listener The listener to remove
     */
    void removeBluetoothListener(BluetoothStateListener listener);
    
    /**
     * Cleanup resources when the manager is no longer needed
     */
    void shutdown();
}