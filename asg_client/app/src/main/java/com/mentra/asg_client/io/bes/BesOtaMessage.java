package com.mentra.asg_client.io.bes;

/**
 * Data structure for BES OTA protocol messages
 * Represents a parsed message from the BES2700 firmware
 */
public class BesOtaMessage {
    public boolean error;
    public byte cmd;
    public int len;
    public byte[] body;
}

