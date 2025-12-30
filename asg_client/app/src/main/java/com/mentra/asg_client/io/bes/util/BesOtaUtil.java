package com.mentra.asg_client.io.bes.util;

import java.util.zip.CRC32;

/**
 * Utility methods for BES OTA operations
 * Handles CRC32, byte conversions, magic code validation, and firmware parsing
 */
public class BesOtaUtil {
    // BES firmware magic code "009K"
    public static final byte[] MAGIC_CODE = {0x30, 0x30, 0x39, 0x4b};
    
    // Size constants
    public static final int MAX_FILE_SIZE = 2048 * 1024; // 2048KB max firmware size (was 1100KB)
    public static final int PACKET_SIZE = 504; // 504 bytes per packet
    public static final int SEGMENT_SIZE = 16 * 1024; // 16KB per segment for CRC32
    
    /**
     * Calculate CRC32 checksum for data segment
     * @param data The data array
     * @param offset Start offset in the array
     * @param length Number of bytes to process
     * @return CRC32 checksum value
     */
    public static long crc32(byte[] data, int offset, int length) {
        CRC32 crc32 = new CRC32();
        crc32.update(data, offset, length);
        return crc32.getValue();
    }
    
    /**
     * Validate magic code in firmware data
     * @param data The data array containing magic code
     * @param offset Start offset of magic code
     * @param len Expected length (should be 4)
     * @return true if magic code matches "009K"
     */
    public static boolean isMagicCodeValid(byte[] data, int offset, int len) {
        if (len == MAGIC_CODE.length) {
            for (int i = 0; i < MAGIC_CODE.length; i++) {
                if (MAGIC_CODE[i] != data[offset + i]) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }
    
    /**
     * Extract firmware version from data
     * @param data The data array
     * @param offset Start offset of version
     * @param len Expected length (should be 4)
     * @return Firmware version as byte array, or null if invalid
     */
    public static byte[] getFirmwareVersion(byte[] data, int offset, int len) {
        if (len == 4) {
            byte[] version = new byte[4];
            System.arraycopy(data, offset, version, 0, len);
            return version;
        }
        return null;
    }

    /**
     * Convert integer to little-endian byte array
     * @param value The integer value
     * @return 4-byte array in little-endian format
     */
    public static byte[] int2Bytes(int value) {
        byte[] src = new byte[4];
        src[3] = (byte) ((value >> 24) & 0xFF);
        src[2] = (byte) ((value >> 16) & 0xFF);
        src[1] = (byte) ((value >> 8) & 0xFF);
        src[0] = (byte) (value & 0xFF);
        return src;
    }

    /**
     * Convert long to little-endian byte array
     * Used for CRC32 values
     * @param value The long value
     * @return 4-byte array in little-endian format
     */
    public static byte[] long2Bytes(long value) {
        byte[] src = new byte[4];
        src[3] = (byte) ((value >> 24) & 0xFF);
        src[2] = (byte) ((value >> 16) & 0xFF);
        src[1] = (byte) ((value >> 8) & 0xFF);
        src[0] = (byte) (value & 0xFF);
        return src;
    }

    /**
     * Convert little-endian byte array to integer
     * @param src The source byte array
     * @param offset Start offset in the array
     * @param len Number of bytes to read (should be 4)
     * @return The integer value
     */
    public static int bytes2Int(byte[] src, int offset, int len) {
        if (src == null || offset + len > src.length) {
            return 0;
        }
        int v = 0;
        for (int i = offset + len - 1; i >= offset; i--) {
            v = (v << 8);
            v += (src[i] < 0) ? (256 + src[i]) : src[i];
        }
        return v;
    }
}

