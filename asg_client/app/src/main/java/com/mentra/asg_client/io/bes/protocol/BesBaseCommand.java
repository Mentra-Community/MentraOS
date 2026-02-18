package com.mentra.asg_client.io.bes.protocol;

import com.mentra.asg_client.io.bes.util.BesOtaUtil;

/**
 * Base class for all BES OTA commands
 * Handles 5-byte header format: [cmd:1][length:4][payload:variable]
 * Length is in little-endian format
 */
public class BesBaseCommand {
    public static final int MIN_LENGTH = 5; // 1 byte cmd + 4 bytes length

    protected byte cmd;
    protected int len;
    protected byte[] all;

    public BesBaseCommand(byte cmd) {
        this.cmd = cmd;
    }

    protected void setLen(int len) {
        this.len = len;
    }

    /**
     * Set the payload data and build complete command
     * @param data Payload data (can be null for commands with no payload)
     */
    protected void setPlayload(byte[] data) {
        int size = MIN_LENGTH;
        if (data != null) {
            size += data.length;
            setLen(data.length);
        }
        byte[] lenbytes = BesOtaUtil.int2Bytes(len);
        all = new byte[size];
        all[0] = cmd;
        System.arraycopy(lenbytes, 0, all, 1, 4);
        if (len > 0)
            System.arraycopy(data, 0, all, MIN_LENGTH, len);
    }

    /**
     * Get the complete command ready for transmission
     * @return Byte array with command, length, and payload
     */
    public byte[] getSendData() {
        if (all == null) {
            setPlayload(null);
        }
        return all;
    }
}

