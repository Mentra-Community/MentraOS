package com.mentra.bluetoothsdk.sgcs.ar99.ota;

import java.io.ByteArrayOutputStream;

public final class OtaProtocol {
  private OtaProtocol() {}

  public static byte[] buildFrame(byte cmd, byte paramType, byte[] payload) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(OtaCommandConstants.OTA.SVC_ID & 0xFF);
    out.write(cmd & 0xFF);
    out.write(paramType & 0xFF);
    int len = payload != null ? payload.length : 0;
    out.write(len & 0xFF);
    out.write((len >> 8) & 0xFF);
    if (payload != null && payload.length > 0) {
      try {
        out.write(payload);
      } catch (Exception ignored) {
      }
    }
    return out.toByteArray();
  }

  public static byte[] buildRequestUpgrade(int packageSize, int blockSize, long crc32) {
    // Wire layout matches the vendor bring-up frame: type marker, then TLV
    // 0x0A/len4 = package size (LE). CRC is validated per-block in SEND_IMAGE_DATA;
    // blockSize is negotiated separately in CONNECT_NEGOTIATION.
    ByteArrayOutputStream payload = new ByteArrayOutputStream();
    payload.write(0x09);
    payload.write(0x01);
    payload.write(0x00);
    payload.write(0x01);
    payload.write(0x0A);
    payload.write(0x04);
    payload.write(packageSize & 0xFF);
    payload.write((packageSize >> 8) & 0xFF);
    payload.write((packageSize >> 16) & 0xFF);
    payload.write((packageSize >> 24) & 0xFF);
    payload.write(0x00);
    return buildFrame(OtaCommandConstants.OTA.REQUEST_UPGRADE, (byte) 0x80, payload.toByteArray());
  }

  public static byte[] buildConnectNegotiation(int blockSize) {
    return buildFrame(OtaCommandConstants.OTA.CONNECT_NEGOTIATION, (byte) 0x80, null);
  }

  public static byte[] buildNegotiationResult() {
    ByteArrayOutputStream payload = new ByteArrayOutputStream();
    payload.write(0x01);
    payload.write(0x01);
    payload.write(0x00);
    payload.write(0x01);
    return buildFrame(OtaCommandConstants.OTA.NEGOTIATION_RESULT, (byte) 0x80, payload.toByteArray());
  }

  public static byte[] buildSendImageData(int psn, byte[] data) {
    ByteArrayOutputStream payload = new ByteArrayOutputStream();
    payload.write(psn & 0xFF);
    long crc32 = OtaCrc32Util.calculate(data);
    payload.write((byte) (crc32 & 0xFF));
    payload.write((byte) ((crc32 >> 8) & 0xFF));
    payload.write((byte) ((crc32 >> 16) & 0xFF));
    payload.write((byte) ((crc32 >> 24) & 0xFF));
    if (data != null && data.length > 0) {
      try {
        payload.write(data);
      } catch (Exception ignored) {
      }
    }
    return buildFrame(OtaCommandConstants.OTA.SEND_IMAGE_DATA, (byte) 0x80, payload.toByteArray());
  }

  public static FrameHeader parseFrameHeader(byte[] frame) {
    if (frame == null || frame.length < 5) return null;
    FrameHeader header = new FrameHeader();
    header.svcId = frame[0];
    header.cmd = frame[1];
    header.paramType = frame[2];
    header.paramLen = OtaByteUtils.readShortLE(frame, 3) & 0xFFFF;
    header.payloadOffset = 5;
    return header;
  }

  public static class FrameHeader {
    public byte svcId;
    public byte cmd;
    public byte paramType;
    public int paramLen;
    public int payloadOffset;
  }
}
