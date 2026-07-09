package com.mentra.bluetoothsdk.ota;

public interface OtaGattTransport {
  boolean enableOtaNotification();

  void sendOtaData(byte[] data);

  void requestMtu(int mtu);

  boolean isBleConnected();
}
