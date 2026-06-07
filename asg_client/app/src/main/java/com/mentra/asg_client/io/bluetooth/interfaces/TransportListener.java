package com.mentra.asg_client.io.bluetooth.interfaces;

/** Listener for companion transport connection state and inbound data. */
public interface TransportListener {
    /**
     * Called when the transport connection state changes.
     *
     * @param connected true if connected, false if disconnected
     */
    void onConnectionStateChanged(boolean connected);

    /**
     * Called when data is received from the connected device.
     *
     * @param data The received data
     */
    void onDataReceived(byte[] data);
}
