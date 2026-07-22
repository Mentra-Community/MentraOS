package com.mentra.bluetoothsdk.sgcs.ar99.ota;

import android.bluetooth.BluetoothGatt;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Arrays;

public class Ar99OtaManager {
  private static final String TAG = "Ar99OtaManager";
  private static final int DEFAULT_BLOCK_SIZE = 200;
  private static final int TIMEOUT_MS = 5000;
  private static final int RECONNECT_TIMEOUT_MS = 90000;

  private static volatile Ar99OtaManager instance;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private OtaGattTransport transport;
  private OTACallback callback;
  private Runnable timeoutRunnable;
  private Runnable reconnectTimeoutRunnable;

  private int state = OtaCommandConstants.OTA.State.IDLE;
  private byte[] firmwareData;
  private int firmwareSize;
  private long firmwareCrc32;
  private int blockSize = DEFAULT_BLOCK_SIZE;
  private int currentOffset = 0;
  private boolean otaNotifyEnabled = false;

  private Ar99OtaManager() {}

  public static Ar99OtaManager getInstance() {
    if (instance == null) {
      synchronized (Ar99OtaManager.class) {
        if (instance == null) instance = new Ar99OtaManager();
      }
    }
    return instance;
  }

  public synchronized void setTransport(OtaGattTransport transport) {
    this.transport = transport;
  }

  public synchronized void setCallback(OTACallback callback) {
    this.callback = callback;
  }

  public synchronized int getState() {
    return state;
  }

  public synchronized boolean isOTAInProgress() {
    return state != OtaCommandConstants.OTA.State.IDLE
        && state != OtaCommandConstants.OTA.State.COMPLETED
        && state != OtaCommandConstants.OTA.State.FAILED;
  }

  public synchronized boolean isPausedWaitingReconnect() {
    return state == OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED;
  }

  public synchronized int getProgress() {
    if (firmwareSize <= 0) return 0;
    return (int) ((currentOffset * 100L) / firmwareSize);
  }

  public boolean startOTA(File firmwareFile) {
    if (firmwareFile == null || !firmwareFile.exists()) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "Firmware file does not exist");
      return false;
    }
    try {
      return startOTA(readFile(firmwareFile));
    } catch (IOException e) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "Failed to read firmware file");
      return false;
    }
  }

  public synchronized boolean startOTA(byte[] data) {
    if (isOTAInProgress()) {
      Log.w(TAG, "OTA is already in progress");
      return false;
    }
    if (data == null || data.length == 0) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.PACKAGE_SIZE_ERROR, "Firmware data is empty");
      return false;
    }

    state = OtaCommandConstants.OTA.State.IDLE;
    otaNotifyEnabled = false;
    cancelTimeout();
    cancelReconnectTimeout();
    firmwareData = data;
    firmwareSize = data.length;
    firmwareCrc32 = OtaCrc32Util.calculate(data);
    blockSize = DEFAULT_BLOCK_SIZE;
    currentOffset = 0;

    OtaGattTransport t = transport;
    if (t == null) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA transport is not initialized");
      return false;
    }
    if (!t.enableOtaNotification()) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA service was not found");
      return false;
    }
    return true;
  }

  public void cancelOTA() {
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.IDLE;
      otaNotifyEnabled = false;
      firmwareData = null;
      firmwareSize = 0;
      currentOffset = 0;
      cancelTimeout();
      cancelReconnectTimeout();
    }
    OTACallback cb = callback;
    if (cb != null) mainHandler.post(cb::onCancelled);
    cleanupFirmware();
  }

  public void onBleDisconnected() {
    boolean shouldNotify = false;
    synchronized (this) {
      if (!isOTAInProgress() || firmwareData == null || firmwareSize <= 0) return;
      if (state == OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED) return;
      state = OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED;
      otaNotifyEnabled = false;
      cancelTimeout();
      startReconnectTimeout();
      shouldNotify = true;
    }
    if (shouldNotify) notifyPausedWaitingReconnect();
  }

  public void tryResumeOtaAfterGattReady() {
    boolean resume;
    synchronized (this) {
      resume =
          state == OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED
              && firmwareData != null
              && firmwareSize > 0;
    }
    if (resume) {
      OtaGattTransport t = transport;
      if (t != null) t.enableOtaNotification();
    }
  }

  public void onOtaNotifyEnabled() {
    synchronized (this) {
      otaNotifyEnabled = true;
      if (firmwareData == null || firmwareSize <= 0) return;
      if (state != OtaCommandConstants.OTA.State.IDLE
          && state != OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED) {
        return;
      }
    }
    mainHandler.postDelayed(
        () -> {
          synchronized (Ar99OtaManager.this) {
            if (state != OtaCommandConstants.OTA.State.IDLE
                && state != OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED) {
              return;
            }
          }
          sendUpgradeRequest();
        },
        1000);
  }

  public boolean handleGattMtuChangedForOta(int status) {
    synchronized (this) {
      if (state != OtaCommandConstants.OTA.State.REQUESTING) return false;
    }
    if (status != BluetoothGatt.GATT_SUCCESS) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "MTU negotiation failed");
      return true;
    }
    onMtuNegotiated();
    return true;
  }

  public void handleOTAResponse(byte[] data) {
    if (data == null || data.length < 5) return;
    OtaProtocol.FrameHeader header = OtaProtocol.parseFrameHeader(data);
    if (header == null || header.svcId != OtaCommandConstants.OTA.SVC_ID) return;
    cancelTimeout();

    byte[] payload = null;
    if (header.paramLen > 0 && data.length >= header.payloadOffset + header.paramLen) {
      payload = Arrays.copyOfRange(data, header.payloadOffset, header.payloadOffset + header.paramLen);
    }

    switch (header.cmd) {
      case OtaCommandConstants.OTA.REQUEST_UPGRADE:
        handleUpgradeRequestResponse(payload);
        break;
      case OtaCommandConstants.OTA.CONNECT_NEGOTIATION:
        handleNegotiationResponse(payload);
        break;
      case OtaCommandConstants.OTA.NEGOTIATION_RESULT:
        handleNegotiationResultResponse();
        break;
      case OtaCommandConstants.OTA.REQUIRE_IMAGE_DATA:
        handleRequireImageData(payload);
        break;
      case OtaCommandConstants.OTA.SEND_IMAGE_DATA:
        handleImageDataResponse(payload);
        break;
      case OtaCommandConstants.OTA.VALIDATE_IMAGE:
        handleValidateImageResponse(payload);
        break;
      default:
        startTimeout();
        break;
    }
  }

  private boolean sendUpgradeRequest() {
    if (!isBluetoothConnected()) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "Bluetooth is not connected");
      return false;
    }
    synchronized (this) {
      if (firmwareData == null || firmwareSize <= 0) {
        state = OtaCommandConstants.OTA.State.IDLE;
        return false;
      }
      cancelReconnectTimeout();
      state = OtaCommandConstants.OTA.State.REQUESTING;
    }
    OtaGattTransport t = transport;
    if (t == null) {
      notifyError(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA transport is not initialized");
      return false;
    }
    t.requestMtu(247);
    startTimeout();
    return true;
  }

  private void onMtuNegotiated() {
    mainHandler.postDelayed(
        () -> {
          synchronized (Ar99OtaManager.this) {
            if (state != OtaCommandConstants.OTA.State.REQUESTING) return;
          }
          sendOtaData(OtaProtocol.buildRequestUpgrade(firmwareSize, blockSize, firmwareCrc32));
        },
        500);
  }

  private void handleUpgradeRequestResponse(byte[] payload) {
    if (payload == null || payload.length < 3) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid upgrade response");
      return;
    }

    int offset = 0;
    boolean success = false;
    while (offset + 3 <= payload.length) {
      int type = payload[offset++] & 0xFF;
      int len = OtaByteUtils.readShortLE(payload, offset);
      offset += 2;
      if (offset + len > payload.length) {
        handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid upgrade TLV");
        return;
      }
      if (type == 0x7F && len >= 4) {
        int errorCode = OtaByteUtils.readIntLE(payload, offset);
        if (errorCode == 100000) {
          success = true;
        } else {
          handleOTAFailure(
              OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Upgrade request failed: " + errorCode);
          return;
        }
      }
      offset += len;
    }

    if (!success) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Upgrade request was rejected");
      return;
    }
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.NEGOTIATING;
    }
    sendOtaData(OtaProtocol.buildConnectNegotiation(blockSize));
    startTimeout();
  }

  private void handleNegotiationResponse(byte[] payload) {
    if (payload == null || payload.length < 3) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid negotiation response");
      return;
    }
    int offset = 0;
    while (offset + 3 <= payload.length) {
      int type = payload[offset++] & 0xFF;
      int len = OtaByteUtils.readShortLE(payload, offset);
      offset += 2;
      if (offset + len > payload.length) {
        handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid negotiation TLV");
        return;
      }
      if (type == 0x03 && len >= 2) {
        int suggestedBlockSize = OtaByteUtils.readShortLE(payload, offset);
        if (suggestedBlockSize > 0) blockSize = suggestedBlockSize;
      }
      offset += len;
    }
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.WAITING_READY;
    }
    sendOtaData(OtaProtocol.buildNegotiationResult());
    startTimeout();
  }

  private void handleNegotiationResultResponse() {
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.TRANSFERRING;
    }
    startTimeout();
  }

  private void handleRequireImageData(byte[] payload) {
    if (payload == null || payload.length < 3) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid image data request");
      return;
    }

    int offset = 0;
    int fileOffset = 0;
    int fileLength = 0;
    while (offset + 3 <= payload.length) {
      int type = payload[offset++] & 0xFF;
      int len = OtaByteUtils.readShortLE(payload, offset);
      offset += 2;
      if (offset + len > payload.length) {
        handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid image data TLV");
        return;
      }
      if (type == 0x01 && len >= 4) {
        fileOffset = OtaByteUtils.readIntLE(payload, offset);
      } else if (type == 0x02 && len >= 4) {
        fileLength = OtaByteUtils.readIntLE(payload, offset);
      }
      offset += len;
    }

    byte[] image;
    int imageSize;
    synchronized (this) {
      image = firmwareData;
      imageSize = firmwareSize;
    }
    if (image == null || imageSize <= 0 || fileOffset < 0 || fileOffset > imageSize) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid firmware offset");
      return;
    }
    if (fileOffset >= imageSize) {
      startTimeout();
      return;
    }

    int remaining = imageSize - fileOffset;
    int totalSendLength = fileLength > 0 ? Math.min(remaining, fileLength) : remaining;
    int sentLength = 0;
    int psn = 0;
    while (sentLength < totalSendLength) {
      int size = Math.min(totalSendLength - sentLength, blockSize);
      int current = fileOffset + sentLength;
      byte[] block = Arrays.copyOfRange(image, current, current + size);
      sendOtaData(OtaProtocol.buildSendImageData(psn, block));
      sentLength += size;
      psn++;
    }

    synchronized (this) {
      currentOffset = fileOffset + sentLength;
    }
    notifyProgress(currentOffset, getProgress());
    startTimeout();
  }

  private void handleValidateImageResponse(byte[] payload) {
    Integer validFlag = null;
    if (payload != null && payload.length >= 4) {
      int offset = 0;
      while (offset + 3 <= payload.length) {
        int type = payload[offset++] & 0xFF;
        int len = OtaByteUtils.readShortLE(payload, offset);
        offset += 2;
        if (offset + len > payload.length) break;
        if (type == 0x01 && len >= 1) {
          validFlag = payload[offset] & 0xFF;
          break;
        }
        offset += len;
      }
    }
    if (validFlag == null && payload != null && payload.length > 0) {
      validFlag = payload[0] & 0xFF;
    }

    if (validFlag != null && validFlag == 1) {
      handleOTASuccess();
    } else {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.FIRMWARE_VALIDATION_FAILED, "Firmware validation failed");
    }
  }

  private void handleImageDataResponse(byte[] payload) {
    if (payload == null || payload.length < 5) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.PROTOCOL_ERROR, "Invalid image data response");
      return;
    }
    int receivedOffset = OtaByteUtils.readIntLE(payload, 0);
    int status = payload[4] & 0xFF;
    if (status != 0) {
      handleOTAFailure(status, "Firmware data write failed");
      return;
    }
    synchronized (this) {
      if (receivedOffset != currentOffset) currentOffset = receivedOffset;
    }
    startTimeout();
  }

  private void sendOtaData(byte[] frame) {
    OtaGattTransport t = transport;
    if (t == null) {
      handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA transport is not initialized");
      return;
    }
    t.sendOtaData(frame);
  }

  private boolean isBluetoothConnected() {
    OtaGattTransport t = transport;
    return t != null && t.isBleConnected() && otaNotifyEnabled;
  }

  private void handleOTASuccess() {
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.COMPLETED;
      currentOffset = firmwareSize;
      cancelTimeout();
      cancelReconnectTimeout();
    }
    notifyProgress(firmwareSize, 100);
    OTACallback cb = callback;
    if (cb != null) mainHandler.post(() -> cb.onCompleted(false));
    cleanupFirmware();
  }

  private void handleOTAFailure(int code, String message) {
    synchronized (this) {
      state = OtaCommandConstants.OTA.State.FAILED;
      cancelTimeout();
      cancelReconnectTimeout();
    }
    notifyError(code, message);
    cleanupFirmware();
  }

  private synchronized void startTimeout() {
    cancelTimeout();
    timeoutRunnable =
        () -> handleOTAFailure(OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA timed out");
    mainHandler.postDelayed(timeoutRunnable, TIMEOUT_MS);
  }

  private synchronized void cancelTimeout() {
    if (timeoutRunnable != null) {
      mainHandler.removeCallbacks(timeoutRunnable);
      timeoutRunnable = null;
    }
  }

  private synchronized void startReconnectTimeout() {
    cancelReconnectTimeout();
    reconnectTimeoutRunnable =
        () -> {
          synchronized (Ar99OtaManager.this) {
            if (state != OtaCommandConstants.OTA.State.PAUSED_DISCONNECTED) return;
          }
          handleOTAFailure(
              OtaCommandConstants.OTA.ErrorCode.UNKNOWN_ERROR, "OTA reconnect timed out");
        };
    mainHandler.postDelayed(reconnectTimeoutRunnable, RECONNECT_TIMEOUT_MS);
  }

  private synchronized void cancelReconnectTimeout() {
    if (reconnectTimeoutRunnable != null) {
      mainHandler.removeCallbacks(reconnectTimeoutRunnable);
      reconnectTimeoutRunnable = null;
    }
  }

  private void notifyProgress(int offset, int progress) {
    OTACallback cb = callback;
    int total;
    synchronized (this) {
      total = firmwareSize;
    }
    if (cb != null) mainHandler.post(() -> cb.onProgress(offset, total, progress));
  }

  private void notifyError(int errorCode, String message) {
    OTACallback cb = callback;
    if (cb != null) mainHandler.post(() -> cb.onError(errorCode, message));
  }

  private void notifyPausedWaitingReconnect() {
    OTACallback cb = callback;
    if (cb != null) mainHandler.post(cb::onPausedWaitingReconnect);
  }

  private static byte[] readFile(File file) throws IOException {
    try (FileInputStream input = new FileInputStream(file);
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int read;
      while ((read = input.read(buffer)) != -1) {
        output.write(buffer, 0, read);
      }
      return output.toByteArray();
    }
  }

  private synchronized void cleanupFirmware() {
    firmwareData = null;
    firmwareSize = 0;
    firmwareCrc32 = 0;
    currentOffset = 0;
    blockSize = DEFAULT_BLOCK_SIZE;
    otaNotifyEnabled = false;
    cancelTimeout();
  }

  public interface OTACallback {
    void onProgress(int offset, int total, int progress);

    void onCompleted(boolean needReboot);

    void onError(int errorCode, String message);

    void onCancelled();

    default void onPausedWaitingReconnect() {}
  }
}
