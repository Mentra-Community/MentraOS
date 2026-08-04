package com.mentra.asg_client.io.bes;

/**
 * Callback interface for UART data reception during BES OTA Receives raw data from the serial port
 * during firmware updates
 */
public interface BesOtaUartListener {
    /**
     * Called when OTA data is received from UART
     *
     * @param data The raw byte array received
     * @param size The number of valid bytes in the array
     */
    void onOtaRecv(byte[] data, int size);

    /** Terminal result after BES reboot and an exact target-version readback. */
    default void onBesPostApplyVerification(
            boolean success, String expectedVersion, String actualVersion, String diagnostic) {}
}
