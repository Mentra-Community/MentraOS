package com.mentra.bluetoothsdk.sgcs.ar99.ota;

public interface OtaGattTransport {
  boolean enableOtaNotification();

  void sendOtaData(byte[] data);

  void requestMtu(int mtu);

  boolean isBleConnected();
}
