package com.mentra.lc3Lib;

public class Lc3Cpp {

    static {
        System.loadLibrary("lc3");
    }

    private Lc3Cpp() {
        // Private constructor to prevent instantiation
    }

    public static void init() {
        // This method can be used for additional initialization if needed
    }

    public static native long initEncoder();
    public static native void freeEncoder(long encoderPtr);

    // Parameterized encoding function with frame size
    public static native byte[] encodeLC3(long encoderPtr, byte[] pcmData, int frameSize);

    // Convenience overload with default frame size (20 bytes for backward compatibility)
    public static byte[] encodeLC3(long encoderPtr, byte[] pcmData) {
        return encodeLC3(encoderPtr, pcmData, 20);
    }

    public static native long initDecoder();
    public static native void freeDecoder(long decoderPtr);

    // Parameterized decoding function with frame size
    public static native byte[] decodeLC3(long decoderPtr, byte[] lc3Data, int frameSize);

    // Convenience overload with default frame size (20 bytes for backward compatibility)
    public static byte[] decodeLC3(long decoderPtr, byte[] lc3Data) {
        return decodeLC3(decoderPtr, lc3Data, 20);
    }
}
