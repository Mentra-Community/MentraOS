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

    /**
     * Send a message to the connected device.
     *
     * @param data The data to send
     * @return true if the data was sent successfully, false otherwise
     */
    boolean sendMessage(byte[] data);

    /**
     * Send a file to the connected device.
     *
     * @param filePath path to the file
     * @return true if transfer started or completed successfully
     */
    boolean sendFile(String filePath);

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
