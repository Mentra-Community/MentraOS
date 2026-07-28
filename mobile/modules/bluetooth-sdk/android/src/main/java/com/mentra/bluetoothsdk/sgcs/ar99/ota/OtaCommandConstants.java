package com.mentra.bluetoothsdk.sgcs.ar99.ota;

public final class OtaCommandConstants {
  private OtaCommandConstants() {}

  public static final class OTA {
    public static final byte SVC_ID = 0x09;

    public static final byte REQUEST_UPGRADE = 0x01;
    public static final byte CONNECT_NEGOTIATION = 0x02;
    public static final byte REQUIRE_IMAGE_DATA = 0x03;
    public static final byte VALIDATE_IMAGE = 0x06;
    public static final byte NEGOTIATION_RESULT = 0x09;
    public static final byte SEND_IMAGE_DATA = 0x0B;

    public static final class ErrorCode {
      public static final int PROTOCOL_ERROR = 0x04;
      public static final int PACKAGE_SIZE_ERROR = 0x06;
      public static final int FIRMWARE_VALIDATION_FAILED = 0x0A;
      public static final int UNKNOWN_ERROR = 0xFF;
    }

    public static final class State {
      public static final int IDLE = 0;
      public static final int REQUESTING = 1;
      public static final int NEGOTIATING = 2;
      public static final int WAITING_READY = 3;
      public static final int TRANSFERRING = 4;
      public static final int VALIDATING = 5;
      public static final int COMPLETED = 6;
      public static final int FAILED = 7;
      public static final int PAUSED_DISCONNECTED = 8;
    }
  }
}
