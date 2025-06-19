package com.augmentos.asg_client.bluetooth.utils;

/**
 * Utility class for byte array operations.
 * Adapted from K900_server_sdk ByteUtil class.
 */
public class ByteUtil {
    /**
     * Copy bytes from source array to destination array
     * @param src source array
     * @param srcOffset offset in source array
     * @param len length to copy
     * @param dest destination array
     * @param destOffset offset in destination array
     */
    public static void copyBytes(byte[] src, int srcOffset, int len, byte[] dest, int destOffset) {
        if (src == null || dest == null) {
            return;
        }
        if (srcOffset + len > src.length || destOffset + len > dest.length) {
            return;
        }
        
        for (int i = 0; i < len; i++) {
            dest[destOffset + i] = src[srcOffset + i];
        }
    }
    
    /**
     * Convert byte array to int
     * @param data byte array
     * @param offset offset in the array
     * @param len length of bytes to convert (up to 4)
     * @return integer value
     */
    public static int bytes2Int(byte[] data, int offset, int len) {
        if (data == null || offset < 0 || len <= 0 || offset + len > data.length) {
            return 0;
        }
        
        int ret = 0;
        for (int i = 0; i < len; i++) {
            ret = (ret << 8) | (data[offset + i] & 0xFF);
        }
        return ret;
    }
    
    /**
     * Format a byte array as a hex string
     * @param data byte array
     * @param offset offset in the array
     * @param len length of bytes to format
     * @return formatted hex string
     */
    public static String outputHexString(byte[] data, int offset, int len) {
        if (data == null || offset < 0 || len <= 0 || offset + len > data.length) {
            return "";
        }
        
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < len; i++) {
            String hex = Integer.toHexString(data[offset + i] & 0xFF);
            if (hex.length() == 1) {
                sb.append('0');
            }
            sb.append(hex);
            sb.append(' ');
        }
        return sb.toString().trim();
    }
    
    /**
     * Format a byte array as a hex string with dots between bytes (compatible with K900_server_sdk)
     * @param flags byte array
     * @param startpos offset in the array
     * @param length length of bytes to format
     * @return formatted hex string
     */
    public static String outputHexStringWithDots(byte[] flags, int startpos, int length) {
        return getHexString_by_Bytes_dot(flags, startpos, length);
    }
    
    /**
     * Helper method to format a byte array as a hex string with dots between bytes
     * @param data byte array
     * @param startpos offset in the array
     * @param length length of bytes to format
     * @return formatted hex string with dots
     */
    private static String getHexString_by_Bytes_dot(byte[] data, int startpos, int length) {
        if (data == null || startpos < 0 || length <= 0 || startpos + length > data.length) {
            return "";
        }
        
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) {
            String hex = Integer.toHexString(data[startpos + i] & 0xFF);
            if (hex.length() == 1) {
                sb.append('0');
            }
            sb.append(hex);
            if (i < length - 1) {
                sb.append('.');
            }
        }
        return sb.toString();
    }
}