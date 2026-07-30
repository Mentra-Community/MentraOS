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

        Object lock();
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
     * Send an in-memory payload to the connected device using the file-transfer protocol, without
     * requiring the payload to exist on disk. Default returns false for transports without
     * file-transfer support.
     *
     * @param data payload bytes
     * @param fileName wire name for the transfer (the K900 protocol caps this at 16 chars)
     * @return true if transfer start was accepted after earlier outbound messages drained
     */
    default boolean sendFile(byte[] data, String fileName) {
        return false;
    }

    /**
     * Send an in-memory payload after an owner-ordered control message. Transports without an
     * exclusive file lane may reject this operation.
     */
    default boolean sendFile(byte[] data, String fileName, byte[] prelude) {
        return false;
    }

    /**
     * @return true if a transfer is active, false otherwise
     */
    boolean isFileTransferInProgress();

    void addBluetoothListener(TransportListener listener);

    void removeBluetoothListener(TransportListener listener);

    void shutdown();

    /**
     * Called when the BLE MTU has been negotiated with the phone. Implementations should adjust
     * transport packet sizes accordingly. Default is a no-op for transports without configurable
     * packet sizes.
     *
     * @param mtu the negotiated MTU value in bytes
     */
    default void onMtuNegotiated(int mtu) {}

    /**
     * Called when the transport connection is reset (e.g. the phone reconnects). Implementations
     * should restore default transport configuration. Default is a no-op.
     */
    default void onTransportReset() {}

    /**
     * Called when the phone confirms a file transfer result. Default is a no-op for transports
     * without file-transfer sessions.
     *
     * @param fileName the name of the file that was transferred
     * @param success whether the transfer succeeded
     */
    default void onFileTransferConfirmation(String fileName, boolean success) {}

    /**
     * Called when the MCU sends a file-transfer ACK frame. Default is a no-op for transports
     * without file-transfer sessions.
     *
     * @param state ACK state code from the MCU
     * @param index packet index being acknowledged
     */
    default void onFileTransferAck(int state, int index) {}
}
