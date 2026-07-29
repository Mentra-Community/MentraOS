package com.mentra.asg_client.io.bluetooth.interfaces;

/**
 * Listener for serial port events.
 */
public interface SerialListener {
    /**
     * Called when a serial port is opened
     * @param bSucc Whether the open was successful
     * @param code Error code
     * @param serialPath The path to the serial port
     * @param msg Error message
     */
    void onSerialOpen(boolean bSucc, int code, String serialPath, String msg);
    
    /**
     * Called when a serial port is ready for use
     * @param serialPath The path to the serial port
     * @param readerGeneration Immutable identity of the reader attached to this port
     */
    void onSerialReady(String serialPath, long readerGeneration);
    
    /**
     * Called when data is read from a serial port
     * @param serialPath The path to the serial port
     * @param data The data read
     * @param size The size of the data
     * @param readerGeneration Immutable identity of the reader that produced the data
     */
    void onSerialRead(String serialPath, byte[] data, int size, long readerGeneration);
    
    /**
     * Called when a serial port is closed
     * @param serialPath The path to the serial port
     */
    void onSerialClose(String serialPath);

    /** Called after BES accepts an OTA image and begins rebooting at its default UART baud. */
    default void onBesOtaApplied() {}
}
