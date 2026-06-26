package com.mentra.asg_client.io.bluetooth.interfaces;

/**
 * Interface for bluetooth management operations across different device types. This interface
 * abstracts BLE operations to support different implementations for different device types (K900,
 * standard Android).
 */
public interface IBluetoothManager {
    /** Initialize the bluetooth manager and check current connectivity */
    void initialize();

    /** Start advertising BLE services to allow companion app to discover and connect */
    void startAdvertising();

    /** Stop BLE advertising */
    void stopAdvertising();

    /**
     * @return true if connected via BLE, false otherwise
     */
    boolean isConnected();

    /** Disconnect from the currently connected device */
    void disconnect();

    interface SendMessageCallback {
        void onSendComplete(boolean success);
    }

    interface SendMessageGate {
        boolean shouldSend();
    }

    /**
     * Queue a message to send to the connected device.
     *
     * @param data The data to send
     * @return true if the data was accepted for outbound delivery, false otherwise
     */
    boolean sendMessage(byte[] data);

    /**
     * Queue a message to send to the connected device and notify when the queued send attempt
     * completes.
     *
     * @param data The data to send
     * @param callback Optional callback invoked after the queued send attempt completes
     * @return true if the data was accepted for outbound delivery, false otherwise
     */
    boolean sendMessage(byte[] data, SendMessageCallback callback);

    /**
     * Queue a message and check whether it is still valid immediately before the queued send.
     *
     * @param data The data to send
     * @param callback Optional callback invoked after the queued send attempt completes
     * @param gate Optional gate checked on the outbound worker before writing
     * @return true if the data was accepted for outbound delivery, false otherwise
     */
    boolean sendMessage(byte[] data, SendMessageCallback callback, SendMessageGate gate);

    /**
     * Send a file to the connected device.
     *
     * @param filePath path to the file
     * @return true if transfer start was accepted after earlier outbound messages drained
     */
    boolean sendFile(String filePath);

    /**
     * @return true if a transfer is active, false otherwise
     */
    boolean isFileTransferInProgress();

    void addBluetoothListener(TransportListener listener);

    void removeBluetoothListener(TransportListener listener);

    void shutdown();
}
