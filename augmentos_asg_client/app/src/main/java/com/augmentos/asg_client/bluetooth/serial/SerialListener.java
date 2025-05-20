package com.augmentos.asg_client.bluetooth.serial;

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
     */
    void onSerialReady(String serialPath);
    
    /**
     * Called when data is read from a serial port
     * @param serialPath The path to the serial port
     * @param data The data read
     * @param size The size of the data
     */
    void onSerialRead(String serialPath, byte[] data, int size);
    
    /**
     * Called when a serial port is closed
     * @param serialPath The path to the serial port
     */
    void onSerialClose(String serialPath);
}