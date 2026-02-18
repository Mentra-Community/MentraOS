package com.mentra.asg_client.io.bes;

/**
 * Callback interface for BES OTA command responses
 * Notified when commands are parsed and processed
 */
public interface BesOtaCommandListener {
    /**
     * Called when a command response is parsed
     * @param cmd The command byte that was received
     * @param data The data payload of the response
     */
    void onParseResult(byte cmd, byte[] data);
}

