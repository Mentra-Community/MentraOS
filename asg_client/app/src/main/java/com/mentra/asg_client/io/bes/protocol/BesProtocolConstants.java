package com.mentra.asg_client.io.bes.protocol;

/**
 * BES OTA Protocol Command Constants
 * Defines all command byte pairs for MTK↔BES communication
 * SCMD: App → BES (send commands)
 * RCMD: BES → App (receive responses)
 */
public class BesProtocolConstants {
    // Get protocol version
    public static final byte SCMD_GET_PROTOCOL_VERSION  = (byte)0x99;
    public static final byte RCMD_GET_PROTOCOL_VERSION  = (byte)0x9a;

    // Set user type
    public static final byte SCMD_SET_USER              = (byte)0x97;
    public static final byte RCMD_SET_USER              = (byte)0x98;

    // Get firmware version
    public static final byte SCMD_GET_FIRMWARE_VERSION  = (byte)0x8e;
    public static final byte RCMD_GET_FIRMWARE_VERSION  = (byte)0x8f;

    // Select A/B partition side
    public static final byte SCMD_SELECT_SIDE           = (byte)0x90;
    public static final byte RCMD_SELECT_SIDE           = (byte)0x91;

    // Check for breakpoint (resume capability)
    public static final byte SCMD_GET_BREAKPOINT        = (byte)0x8c;
    public static final byte RCMD_GET_BREAKPOINT        = (byte)0x8d;

    // Set start info (file size, etc.)
    public static final byte SCMD_SET_START_INFO        = (byte)0x80;
    public static final byte RCMD_SET_START_INFO        = (byte)0x81;

    // Set configuration (BT name, address, etc.)
    public static final byte SCMD_SET_CONFIG            = (byte)0x86;
    public static final byte RCMD_SET_CONFIG            = (byte)0x87;

    // Send firmware data
    public static final byte SCMD_SEND_DATA             = (byte)0x85;
    public static final byte RCMD_SEND_DATA             = (byte)0x8B;

    // Segment verification (CRC32)
    public static final byte SCMD_SEGMENT_VERIFY        = (byte)0x82;
    public static final byte RCMD_SEGMENT_VERIFY        = (byte)0x83;

    // Send finish notification
    public static final byte SCMD_SEND_FINISH           = (byte)0x88;
    public static final byte RCMD_SEND_FINISH           = (byte)0x84;

    // Apply firmware and reboot
    public static final byte SCMD_APPLY                 = (byte)0x92;
    public static final byte RCMD_APPLY                 = (byte)0x93;
}

