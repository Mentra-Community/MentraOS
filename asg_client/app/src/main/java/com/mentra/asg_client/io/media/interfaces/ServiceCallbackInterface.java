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
     * Send an in-memory payload via Bluetooth using the K900 file transfer protocol, without
     * writing it to disk first.
     *
     * @param data payload bytes
     * @param fileName wire name for the transfer (K900 protocol caps this at 16 chars)
     * @return true if file transfer started successfully, false otherwise
     */
    boolean sendFileViaBluetooth(byte[] data, String fileName);

    /** Send an in-memory payload after an owner-ordered control message. */
    boolean sendFileViaBluetooth(byte[] data, String fileName, byte[] prelude);
    
    /**
     * Check if a BLE file transfer is currently in progress
     * @return true if a transfer is active, false otherwise
     */
    boolean isBleTransferInProgress();
}
