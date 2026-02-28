package com.mentra.asg_client.io.media.interfaces;

/**
 * Interface for communication between MediaCaptureService and AsgClientService
 */
public interface ServiceCallbackInterface {
    /**
     * Send data through Bluetooth connection
     * @param data The data to send
     */
    void sendThroughBluetooth(byte[] data);
    
    /**
     * Send a file via Bluetooth using the K900 file transfer protocol
     * @param filePath The path to the file to send
     * @return true if file transfer started successfully, false otherwise
     */
    boolean sendFileViaBluetooth(String filePath);
    
    /**
     * Check if a BLE file transfer is currently in progress
     * @return true if a transfer is active, false otherwise
     */
    boolean isBleTransferInProgress();
} 