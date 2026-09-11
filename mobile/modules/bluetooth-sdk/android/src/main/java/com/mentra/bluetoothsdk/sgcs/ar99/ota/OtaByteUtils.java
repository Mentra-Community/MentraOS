package com.mentra.bluetoothsdk.sgcs.ar99.ota;

public final class OtaByteUtils {
  private OtaByteUtils() {}

  public static int readShortLE(byte[] data, int offset) {
    if (data == null || offset < 0 || offset + 1 >= data.length) return 0;
    return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
  }

  public static int readIntLE(byte[] data, int offset) {
    if (data == null || offset < 0 || offset + 3 >= data.length) return 0;
    return (data[offset] & 0xFF)
        | ((data[offset + 1] & 0xFF) << 8)
        | ((data[offset + 2] & 0xFF) << 16)
        | ((data[offset + 3] & 0xFF) << 24);
  }
}
