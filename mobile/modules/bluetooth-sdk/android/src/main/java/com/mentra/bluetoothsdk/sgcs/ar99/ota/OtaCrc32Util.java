package com.mentra.bluetoothsdk.sgcs.ar99.ota;

import java.util.zip.CRC32;

public final class OtaCrc32Util {
  private OtaCrc32Util() {}

  public static long calculate(byte[] data) {
    CRC32 crc32 = new CRC32();
    if (data != null) crc32.update(data);
    return crc32.getValue();
  }
}
