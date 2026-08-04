package com.mentra.bluetoothsdk.sgcs;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.format.DateFormat;
import android.util.Log;
import com.google.protobuf.CodedInputStream;
import com.google.protobuf.CodedOutputStream;
import com.google.protobuf.WireFormat;
import com.mentra.bluetoothsdk.Bridge;
import com.mentra.bluetoothsdk.DeviceManager;
import com.mentra.bluetoothsdk.DeviceStore;
import com.mentra.bluetoothsdk.PhotoRequest;
import com.mentra.bluetoothsdk.sgcs.ar99.ota.Ar99OtaManager;
import com.mentra.bluetoothsdk.sgcs.ar99.ota.OtaGattTransport;
import com.mentra.bluetoothsdk.utils.ConnTypes;
import com.mentra.bluetoothsdk.utils.DeviceTypes;
import com.mentra.bluetoothsdk.utils.audio.Ar99OpusPcmDecoder;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

public class Ar99 extends SGCManager {
  private static final String TAG = "Ar99";

  /** Use: {@code adb logcat -s Ar99Opus}. */
  private static final String LOG_TAG_OPUS = "Ar99Opus";

  // NOTE: UUIDs are taken from the reference implementation.
  private static final UUID CTRL_SERVICE_UUID =
      UUID.fromString("A72EC9A8-CF72-8544-AD96-D1481A02CE98");
  private static final UUID CTRL_HOST_TO_SLAVE =
      UUID.fromString("A72EC9A9-CF72-8544-AD96-D1481A02CE98");
  private static final UUID CTRL_SLAVE_TO_HOST =
      UUID.fromString("A72EC9AA-CF72-8544-AD96-D1481A02CE98");

  private static final UUID OPUS_SERVICE_UUID =
      UUID.fromString("F6B26AAD-41A5-93F5-F640-AC3BA3C73597");
  private static final UUID OPUS_SLAVE_TO_HOST =
      UUID.fromString("F6B26AAF-41A5-93F5-F640-AC3BA3C73597");

  private static final UUID OTA_SERVICE_UUID =
      UUID.fromString("e49a25f8-f69a-11e8-8eb2-f2801f1b9fd1");
  private static final UUID OTA_WRITE_UUID =
      UUID.fromString("e49a25e0-f69a-11e8-8eb2-f2801f1b9fd1");
  private static final UUID OTA_NOTIFY_UUID =
      UUID.fromString("e49a28e1-f69a-11e8-8eb2-f2801f1b9fd1");

  private static final UUID CLIENT_CHARACTERISTIC_CONFIG_UUID =
      UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

  private static final int MAGIC_NUMBER = 0x1A2B3C4D;

  private static final int FUNC_COMM = 1;
  private static final int FUNC_TRANS = 3;
  private static final int FUNC_COMM_DISPLAY = 7;

  private static final int CMD_TRANS_DISPLAY_START = 100;
  private static final int CMD_TRANS_DISPLAY_STOP = 101;
  private static final int CMD_TRANS_DISPLAY_SET_CONTENT = 102;

  private static final int CMD_DISPLAY_GET_DEVICEINFO = 100;
  private static final int CMD_DISPLAY_SET_LANGUAGE = 131;
  private static final int CMD_DISPLAY_GET_BRIGHT = 102;
  private static final int CMD_DISPLAY_GET_BATTERY = 104;
  private static final int CMD_COMM_SET_TIME = 31;
  private static final int CMD_DISPLAY_SET_BRIGHT = 132;
  private static final int CMD_DISPLAY_SET_AUTO_ADJUST_LIGHT = 138;

  private static final int CMD_DISPLAY_CTRL_AUDIO_RECORD = 161;
  private static final int CMD_DISPLAY_CTRL_FACTORY_RESET = 162;
  private static final int CMD_DISPLAY_CTRL_SYS_FUNCTION = 164;
  private static final int CMD_DISPLAY_CTRL_MINIMAL_TEXT_START = 181;
  private static final int CMD_DISPLAY_CTRL_MINIMAL_TEXT_SET = 182;
  private static final int CMD_DISPLAY_CTRL_MINIMAL_TEXT_CLEAR = 183;
  private static final int CMD_DISPLAY_CTRL_MINIMAL_TEXT_STOP = 184;

  private static final int TEXT_STREAM_STATE_BEGIN = 0;
  private static final int TEXT_STREAM_STATE_UPDATE = 1;
  private static final int TEXT_STREAM_STATE_END = 2;

  private static final int TRANS_DISPLAY_SOURCE_LANGUAGE = 0;
  private static final int TRANS_DISPLAY_TARGET_LANGUAGE = 1;
  private static final int TRANS_DISPLAY_MIC_SOURCE_PHONE = 0;
  private static final int TRANS_DISPLAY_FONT_SIZE = 24;
  private static final int DISPLAY_FUNCTION_TYPE_UI_MODE = 2;
  private static final int DISPLAY_UI_MODE_MINIMAL = 1;
  private static final int DISPLAY_LANGUAGE_ENGLISH = 1;
  private static final int FACTORY_RESET_CONFIRM_CODE = 0xAA;

  private static final int TARGET_MOBILE_APP = 0;
  private static final int TARGET_GLASS_ANDROID = 1;
  private static final int TARGET_GLASS_MCU_DISPLAY = 3;

  private static final int CTRL_ACTION_RESPONSE = 0x40;

  private static final long SCAN_DURATION_MS = 15_000L;
  private static final long INITIAL_BATTERY_RETRY_DELAY_MS = 1_000L;
  private static final int MAX_INITIAL_BATTERY_RETRIES = 5;
  private static final long BATTERY_POLL_INTERVAL_MS = 60_000L;
  private static final int BLE_WRITE_CHUNK_SIZE = 180;
  private static final long BLE_WRITE_CHUNK_DELAY_MS = 10L;
  private static final long READY_MINIMAL_MODE_DELAY_MS = 40L;
  private static final long READY_LANGUAGE_DELAY_MS = 90L;
  private static final long READY_DEVICE_INFO_DELAY_MS = 140L;
  private static final long READY_BRIGHTNESS_DELAY_MS = 280L;
  private static final long READY_BATTERY_DELAY_MS = 420L;
  private static final long DISPLAY_SESSION_IDLE_RESTART_MS = 8_000L;
  static final String[] SUPPORTED_PROJECT_NAMES = new String[] {"AR99"};

  private static final int CTRL_SENDER_MASK = 0x03;

  private final Context context;
  private final BluetoothAdapter bluetoothAdapter;
  private final Handler handler;
  private final Handler batteryQueryHandler;
  private final AtomicInteger sequence = new AtomicInteger(1);

  private final LinkedHashSet<String> discoveredNames = new LinkedHashSet<>();
  private final Deque<byte[]> writeQueue = new ArrayDeque<>();
  private final Deque<byte[]> otaWriteQueue = new ArrayDeque<>();
  private final Deque<BluetoothGattCharacteristic> notifyQueue = new ArrayDeque<>();
  private byte[] controlNotifyBuffer = new byte[0];

  private BluetoothLeScanner scanner;
  private ScanCallback scanCallback;
  private Runnable scanTimeoutRunnable;
  private String targetIdentifier;
  private String currentProjectName;
  private String currentBroadcastMacAddress;

  private BluetoothGatt controlGatt;
  private BluetoothGattCharacteristic controlWriteCharacteristic;
  private BluetoothGattCharacteristic controlNotifyCharacteristic;
  private BluetoothGattCharacteristic opusNotifyCharacteristic;
  private BluetoothGattCharacteristic otaWriteCharacteristic;
  private BluetoothGattCharacteristic otaNotifyCharacteristic;

  /** Lazily created; decodes 48-byte framed Opus from {@link #OPUS_SLAVE_TO_HOST} notifies. */
  private Ar99OpusPcmDecoder opusPcmDecoder;

  /** Reset in {@link #cleanupGatt}; first notify each session logs INFO with hex preview. */
  private boolean opusLoggedFirstInSession;

  private boolean isScanning = false;
  @SuppressWarnings("unused")
  private boolean connecting = false;
  private boolean isWriteInFlight = false;
  private boolean isOtaWriteInFlight = false;
  private boolean otaWriteUsesNoResponseMode = false;
  private boolean isOtaNotificationEnabled = false;
  private boolean isNotifyWriteInFlight = false;
  private boolean minimalModeReady = false;
  private boolean displaySessionStarted = false;
  private boolean awaitingMicDisableAck = false;
  private long lastDisplayContentAtMs = 0L;
  private boolean hasPendingDisplayUpdate = false;
  private String pendingDisplayText = "";
  private String lastDisplayText = "";
  private boolean hasReceivedBatteryForCurrentConnection = false;
  private int pendingBatteryRetries = 0;
  private final Runnable writeDrainRunnable =
      new Runnable() {
        @Override
        public void run() {
          isWriteInFlight = false;
          processNextWrite();
        }
      };

  private final Runnable initialBatteryRetryRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          if (hasReceivedBatteryForCurrentConnection
              || pendingBatteryRetries >= MAX_INITIAL_BATTERY_RETRIES) {
            return;
          }

          pendingBatteryRetries++;
          Bridge.log(TAG + ": retrying battery query attempt " + pendingBatteryRetries);
          getBatteryStatus();
          batteryQueryHandler.postDelayed(this, INITIAL_BATTERY_RETRY_DELAY_MS);
        }
      };

  private final Runnable periodicBatteryPollRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          getBatteryStatus();
          batteryQueryHandler.postDelayed(this, BATTERY_POLL_INTERVAL_MS);
        }
      };

  private final Runnable readyDeviceInfoRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          requestDeviceInfo();
        }
      };

  private final Runnable readyMinimalModeRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          setMinimalDisplayMode();
        }
      };

  private final Runnable readyLanguageRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          setDisplayLanguage(DISPLAY_LANGUAGE_ENGLISH);
        }
      };

  private final Runnable readyBrightnessRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          requestBrightness();
        }
      };

  private final Runnable readyBatteryRunnable =
      new Runnable() {
        @Override
        public void run() {
          if (controlGatt == null || !getConnected()) return;
          getBatteryStatus();
        }
      };

  private final BluetoothGattCallback gattCallback =
      new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
          if (newState == BluetoothProfile.STATE_CONNECTED) {
            Bridge.log(TAG + ": connected to " + (gatt.getDevice() != null ? gatt.getDevice().getName() : ""));
            controlGatt = gatt;
            gatt.discoverServices();
          } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            Bridge.log(TAG + ": disconnected status=" + status);
            if (Ar99OtaManager.getInstance().isOTAInProgress()) {
              Ar99OtaManager.getInstance().onBleDisconnected();
            }
            cleanupGatt();
            updateConnectionState(ConnTypes.DISCONNECTED);
          }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
          if (status != BluetoothGatt.GATT_SUCCESS) {
            Bridge.log(TAG + ": service discovery failed status=" + status);
            return;
          }

          BluetoothGattService controlService = gatt.getService(CTRL_SERVICE_UUID);
          controlWriteCharacteristic = controlService != null ? controlService.getCharacteristic(CTRL_HOST_TO_SLAVE) : null;
          controlNotifyCharacteristic = controlService != null ? controlService.getCharacteristic(CTRL_SLAVE_TO_HOST) : null;

          BluetoothGattService opusService = gatt.getService(OPUS_SERVICE_UUID);
          opusNotifyCharacteristic = opusService != null ? opusService.getCharacteristic(OPUS_SLAVE_TO_HOST) : null;

          BluetoothGattService otaService = gatt.getService(OTA_SERVICE_UUID);
          otaWriteCharacteristic = otaService != null ? otaService.getCharacteristic(OTA_WRITE_UUID) : null;
          otaNotifyCharacteristic = otaService != null ? otaService.getCharacteristic(OTA_NOTIFY_UUID) : null;
          isOtaNotificationEnabled = false;

          notifyQueue.clear();
          if (controlNotifyCharacteristic != null) notifyQueue.add(controlNotifyCharacteristic);
          if (opusNotifyCharacteristic != null) notifyQueue.add(opusNotifyCharacteristic);

          processNextNotifyDescriptor();

          if (notifyQueue.isEmpty()) {
            markReady();
          }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
          isNotifyWriteInFlight = false;
          if (status != BluetoothGatt.GATT_SUCCESS) {
            Bridge.log(TAG + ": descriptor write failed status=" + status);
          }
          if (otaNotifyCharacteristic != null
              && descriptor.getCharacteristic() != null
              && OTA_NOTIFY_UUID.equals(descriptor.getCharacteristic().getUuid())) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
              isOtaNotificationEnabled = true;
              Ar99OtaManager.getInstance().onOtaNotifyEnabled();
            }
          }
          processNextNotifyDescriptor();
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
          if (characteristic != null && OTA_WRITE_UUID.equals(characteristic.getUuid())) {
            synchronized (otaWriteQueue) {
              if (otaWriteUsesNoResponseMode) {
                return;
              }
              isOtaWriteInFlight = false;
            }
            if (status != BluetoothGatt.GATT_SUCCESS) {
              Bridge.log(TAG + ": OTA characteristic write failed status=" + status);
            }
            processNextOtaWrite();
            return;
          }

          handler.removeCallbacks(writeDrainRunnable);
          isWriteInFlight = false;
          if (status != BluetoothGatt.GATT_SUCCESS) {
            Bridge.log(TAG + ": characteristic write failed status=" + status);
          }
          processNextWrite();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
          byte[] data = characteristic.getValue();
          if (data == null) return;

          UUID uuid = characteristic.getUuid();
          if (OTA_NOTIFY_UUID.equals(uuid)) {
            Ar99OtaManager.getInstance().handleOTAResponse(data);
          } else if (CTRL_SLAVE_TO_HOST.equals(uuid)) {
            handleControlNotifyChunk(data);
          } else if (OPUS_SLAVE_TO_HOST.equals(uuid)) {
            handleOpusData(data);
          }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
          if (Ar99OtaManager.getInstance().handleGattMtuChangedForOta(status)) {
            return;
          }
          super.onMtuChanged(gatt, mtu, status);
        }
      };

  public Ar99() {
    context = Bridge.getContext();
    bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    handler = new Handler(Looper.getMainLooper());
    batteryQueryHandler = new Handler(Looper.getMainLooper());

    this.type = DeviceTypes.AR99;
    this.hasMic = true;

    DeviceStore.INSTANCE.apply("glasses", "micEnabled", false);
    Ar99OtaManager.getInstance()
        .setTransport(
            new OtaGattTransport() {
              @Override
              public boolean enableOtaNotification() {
                return Ar99.this.enableOtaNotification();
              }

              @Override
              public void sendOtaData(byte[] data) {
                Ar99.this.sendOtaData(data);
              }

              @Override
              public void requestMtu(int mtu) {
                BluetoothGatt gatt = controlGatt;
                if (gatt != null) {
                  gatt.requestMtu(mtu);
                }
              }

              @Override
              public boolean isBleConnected() {
                return controlGatt != null
                    && controlWriteCharacteristic != null
                    && otaWriteCharacteristic != null
                    && otaNotifyCharacteristic != null;
              }
            });
  }

  @Override
  public void setMicEnabled(boolean enabled) {
    if (enabled) {
      awaitingMicDisableAck = false;
      DeviceStore.INSTANCE.apply("glasses", "micEnabled", true);
    } else {
      awaitingMicDisableAck = true;
    }
    sendControlDisplayAudioRecord(enabled);
  }

  @Override
  public java.util.List<String> sortMicRanking(java.util.List<String> list) {
    return list;
  }

  @Override
  public void requestPhoto(PhotoRequest request) {
    Bridge.log(TAG + ": requestPhoto not implemented for AR99 yet");
  }

  @Override
  public void startStream(java.util.Map<String, Object> message) {}

  @Override
  public void stopStream() {}

  @Override
  public void sendStreamKeepAlive(java.util.Map<String, Object> message) {}

  @Override
  public void startVideoRecording(String requestId, boolean save, boolean sound) {}

  @Override
  public void stopVideoRecording(String requestId) {}

  @Override
  public void sendButtonPhotoSettings() {}

  public void sendButtonModeSetting() {}

  @Override
  public void sendButtonVideoRecordingSettings() {}

  @Override
  public void sendButtonMaxRecordingTime() {}

  public void sendButtonCameraLedSetting() {}

  @Override
  public void sendCameraFovSetting() {}

  @Override
  public void setBrightness(int level, boolean autoMode) {
    int brightness = Math.max(0, Math.min(100, level));
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_SET_AUTO_ADJUST_LIGHT,
        buildProtoMessageBool(1, autoMode),
        TARGET_GLASS_MCU_DISPLAY);
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_SET_BRIGHT,
        buildProtoMessageUInt32(1, brightness),
        TARGET_GLASS_MCU_DISPLAY);
  }

  @Override
  public void clearDisplay() {
    clearMinimalText();
  }

  @Override
  public void sendTextWall(String text) {
    sendMinimalText(text);
  }

  @Override
  public void sendText(String text) {
    sendTextWall(text);
  }

  @Override
  public void sendDoubleTextWall(String top, String bottom) {
    sendMinimalText(joinDisplayLines(top, bottom));
  }

  @Override
  public boolean displayBitmap(
      String base64ImageData, Integer x, Integer y, Integer width, Integer height) {
    return displayBitmap(base64ImageData);
  }

  public boolean displayBitmap(String base64ImageData) {
    return false;
  }

  @Override
  public void showDashboard() {}

  @Override
  public void setDashboardPosition(int height, int depth) {}

  @Override
  public void setHeadUpAngle(int angle) {}

  @Override
  public void getBatteryStatus() {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_GET_BATTERY,
        new byte[0],
        TARGET_GLASS_MCU_DISPLAY);
  }

  @Override
  public void setSilentMode(boolean enabled) {}

  @Override
  public void exit() {}

  @Override
  public void sendShutdown() {}

  @Override
  public void sendReboot() {}

  public void sendFactoryReset() {
    Bridge.log(TAG + ": sending factory reset");
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_CTRL_FACTORY_RESET,
        buildProtoMessageUInt32(1, FACTORY_RESET_CONFIRM_CODE),
        TARGET_GLASS_MCU_DISPLAY);
  }

  @Override
  public void sendRgbLedControl(
      String requestId,
      String packageName,
      String action,
      String color,
      int ontime,
      int offtime,
      int count) {}

  @Override
  public void disconnect() {
    stopScan();
    cleanupGatt();
    updateConnectionState(ConnTypes.DISCONNECTED);
  }

  @Override
  public void forget() {
    targetIdentifier = null;
    disconnect();
  }

  @Override
  public void findCompatibleDevices() {
    discoveredNames.clear();
    startScan(false);
  }

  @Override
  public void connectById(String id) {
    targetIdentifier = id != null ? id.trim() : null;
    discoveredNames.clear();
    startScan(true);
  }

  @Override
  public String getConnectedBluetoothName() {
    if (controlGatt != null && controlGatt.getDevice() != null && controlGatt.getDevice().getName() != null) {
      return controlGatt.getDevice().getName();
    }
    return "";
  }

  @Override
  public void cleanup() {
    disconnect();
  }

  @Override
  public void ping() {
    requestDeviceInfo();
  }

  @Override
  public void dbg1() {}

  @Override
  public void dbg2() {}

  @Override
  public void requestWifiScan(String scanId) {}

  @Override
  public void sendWifiCredentials(String ssid, String password) {}

  @Override
  public void forgetWifiNetwork(String ssid) {}

  @Override
  public void sendHotspotState(boolean enabled) {}

  @Override
  public void sendUserEmailToGlasses(String email) {}

  @Override
  public void sendIncidentId(String incidentId, String apiBaseUrl) {
    Bridge.log(TAG + ": sendIncidentId not implemented for AR99 yet");
  }

  @Override
  public void queryGalleryStatus() {}

  @Override
  public void sendGalleryMode() {}

  @Override
  public void requestVersionInfo() {
    requestDeviceInfo();
  }

  private void startScan(boolean forConnection) {
    if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
      Bridge.log(TAG + ": Bluetooth unavailable or disabled");
      return;
    }

    stopScan();

    scanner = bluetoothAdapter.getBluetoothLeScanner();
    if (scanner == null) {
      Bridge.log(TAG + ": BLE scanner unavailable");
      return;
    }

    updateConnectionState(ConnTypes.SCANNING);
    connecting = forConnection;
    isScanning = true;

    scanCallback =
        new ScanCallback() {
          @Override
          public void onScanResult(int callbackType, ScanResult result) {
            handleScanResult(result, forConnection);
          }

          @Override
          public void onScanFailed(int errorCode) {
            Bridge.log(TAG + ": scan failed with code=" + errorCode);
            stopScan();
            if (ConnTypes.SCANNING.equals(getConnectionState())) {
              updateConnectionState(ConnTypes.DISCONNECTED);
            }
          }
        };

    ScanSettings settings =
        new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();

    BluetoothLeScanner localScanner = scanner;
    ScanCallback localCallback = scanCallback;
    if (localScanner == null || localCallback == null) return;

    localScanner.startScan(Collections.emptyList(), settings, localCallback);
    scanTimeoutRunnable = this::stopScan;
    handler.postDelayed(scanTimeoutRunnable, SCAN_DURATION_MS);
  }

  @Override
  public void stopScan() {
    if (scanTimeoutRunnable != null) {
      handler.removeCallbacks(scanTimeoutRunnable);
      scanTimeoutRunnable = null;
    }
    if (!isScanning) return;

    ScanCallback cb = scanCallback;
    if (scanner != null && cb != null) {
      try {
        scanner.stopScan(cb);
      } catch (Throwable t) {
        // ignore
      }
    }

    isScanning = false;
    scanCallback = null;
    scanner = null;
  }

  private void handleScanResult(ScanResult result, boolean forConnection) {
    if (result == null || result.getDevice() == null) return;
    BluetoothDevice device = result.getDevice();

    String name = device.getName();
    ParsedAdvertisement advertisement = parseAdvertisement(result.getScanRecord() != null ? result.getScanRecord().getBytes() : null);
    if (name == null) name = advertisement != null ? advertisement.bleName : null;
    if (name == null) return;

    if (!matchesAr99(name, advertisement != null ? advertisement.projectName : null)) return;

    String displayName = buildDisplayName(name, advertisement, device.getAddress());

        if (!forConnection) {
      if (discoveredNames.add(displayName)) {
        Bridge.sendDiscoveredDevice(
            type,
            displayName,
            advertisement != null && advertisement.bleAddress != null && !advertisement.bleAddress.trim().isEmpty() ? advertisement.bleAddress.trim() : "",
            result.getRssi(),
            advertisement != null ? advertisement.projectName : null);
      }
      return;
    }
    if (advertisement != null && advertisement.projectName != null && !advertisement.projectName.trim().isEmpty()) {
      currentProjectName = advertisement.projectName.trim();
      currentBroadcastMacAddress = advertisement.bleAddress != null && !advertisement.bleAddress.trim().isEmpty()
          ? advertisement.bleAddress.trim()
          : null;
    }

    String target = targetIdentifier != null ? targetIdentifier : "";
    String normalizedTarget = normalizeDisplayIdentifier(target);
    String targetSerial = extractTargetSerial(target);
    boolean matchesTarget =
        target.isEmpty()
            || name.equalsIgnoreCase(target)
            || displayName.equalsIgnoreCase(target)
            || (device.getAddress() != null
                && (device.getAddress().equalsIgnoreCase(target)
                    || device.getAddress().equalsIgnoreCase(normalizedTarget)))
            || (advertisement != null
                && ((advertisement.bleAddress != null
                        && (advertisement.bleAddress.equalsIgnoreCase(target)
                            || advertisement.bleAddress.equalsIgnoreCase(normalizedTarget)))
                    || (advertisement.btAddress != null
                        && (advertisement.btAddress.equalsIgnoreCase(target)
                            || advertisement.btAddress.equalsIgnoreCase(normalizedTarget)))
                    || (advertisement.serialNumber != null
                        && (advertisement.serialNumber.equalsIgnoreCase(target)
                            || advertisement.serialNumber.equalsIgnoreCase(normalizedTarget)))
                    || (advertisement.serialNumber != null && advertisement.serialNumber.equalsIgnoreCase(targetSerial))));

    if (!matchesTarget) return;

    String reconnectAddress =
        advertisement != null && advertisement.bleAddress != null && !advertisement.bleAddress.trim().isEmpty()
            ? advertisement.bleAddress.trim()
            : device.getAddress();
    if (reconnectAddress != null && !reconnectAddress.trim().isEmpty()) {
      DeviceManager.getInstance().setDeviceAddress(reconnectAddress);
    }

    stopScan();
    connectGatt(device);
  }

  private void connectGatt(BluetoothDevice device) {
    cleanupGatt();
    updateConnectionState(ConnTypes.CONNECTING);
    connecting = true;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      controlGatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
    } else {
      controlGatt = device.connectGatt(context, false, gattCallback);
    }
  }

  private void processNextNotifyDescriptor() {
    BluetoothGatt gatt = controlGatt;
    if (gatt == null) return;
    if (isNotifyWriteInFlight) return;

    BluetoothGattCharacteristic characteristic = notifyQueue.pollFirst();
    if (characteristic == null) {
      markReady();
      Ar99OtaManager.getInstance().tryResumeOtaAfterGattReady();
      return;
    }

    gatt.setCharacteristicNotification(characteristic, true);

    BluetoothGattDescriptor descriptor = null;
    if (characteristic.getDescriptors() != null) {
      for (BluetoothGattDescriptor d : characteristic.getDescriptors()) {
        if (d != null && CLIENT_CHARACTERISTIC_CONFIG_UUID.equals(d.getUuid())) {
          descriptor = d;
          break;
        }
      }
    }

    if (descriptor == null) {
      processNextNotifyDescriptor();
      return;
    }

    descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
    isNotifyWriteInFlight = gatt.writeDescriptor(descriptor);

    if (!isNotifyWriteInFlight) {
      Bridge.log(TAG + ": failed to start descriptor write for " + characteristic.getUuid());
      processNextNotifyDescriptor();
    }
  }

  public boolean startOtaFromFile(String path) {
    if (path == null || path.trim().isEmpty()) {
      sendAr99OtaStatus("failed", 0, 0, 0, "Firmware path is empty");
      return false;
    }
    Ar99OtaManager manager = Ar99OtaManager.getInstance();
    // Match the validated c100_client flow: if the user manually restarts OTA after a
    // BLE disconnect, abandon the paused/in-progress native session first so the fresh
    // start call is not rejected as "already in progress".
    manager.setCallback(null);
    if (manager.isOTAInProgress()) {
      manager.cancelOTA();
    }
    manager.setCallback(
        new Ar99OtaManager.OTACallback() {
          private int lastOffset = 0;
          private int lastTotal = 0;

          @Override
          public void onProgress(int offset, int total, int progress) {
            lastOffset = offset;
            lastTotal = total;
            sendAr99OtaStatus("transferring", progress, offset, total, null);
          }

          @Override
          public void onCompleted(boolean needReboot) {
            sendAr99OtaStatus("success", 100, lastTotal, lastTotal, null);
            manager.setCallback(null);
          }

          @Override
          public void onError(int errorCode, String message) {
            sendAr99OtaStatus("failed", manager.getProgress(), lastOffset, lastTotal, message);
            manager.setCallback(null);
          }

          @Override
          public void onCancelled() {
            sendAr99OtaStatus("cancelled", manager.getProgress(), lastOffset, lastTotal, null);
            manager.setCallback(null);
          }

          @Override
          public void onPausedWaitingReconnect() {
            sendAr99OtaStatus(
                "paused", manager.getProgress(), lastOffset, lastTotal, "Waiting for reconnect");
          }
        });
    sendAr99OtaStatus("preparing", 0, 0, 0, null);
    boolean started = manager.startOTA(new File(path));
    if (!started) {
      sendAr99OtaStatus("failed", 0, 0, 0, "Unable to start AR99 OTA");
      manager.setCallback(null);
    }
    return started;
  }

  public void cancelAr99Ota() {
    Ar99OtaManager.getInstance().cancelOTA();
  }

  private boolean enableOtaNotification() {
    BluetoothGatt gatt = controlGatt;
    BluetoothGattCharacteristic characteristic = otaNotifyCharacteristic;
    if (gatt == null || characteristic == null) return false;
    if (isOtaNotificationEnabled) {
      Ar99OtaManager.getInstance().onOtaNotifyEnabled();
      return true;
    }
    BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID);
    if (descriptor == null) return false;
    gatt.setCharacteristicNotification(characteristic, true);
    descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
    return gatt.writeDescriptor(descriptor);
  }

  private void sendOtaData(byte[] data) {
    if (data == null || data.length == 0) return;
    if (controlGatt == null || otaWriteCharacteristic == null || !isOtaNotificationEnabled) return;
    synchronized (otaWriteQueue) {
      otaWriteQueue.add(data);
      if (!isOtaWriteInFlight) {
        processNextOtaWrite();
      }
    }
  }

  private void processNextOtaWrite() {
    synchronized (otaWriteQueue) {
      BluetoothGatt gatt = controlGatt;
      BluetoothGattCharacteristic characteristic = otaWriteCharacteristic;
      if (gatt == null || characteristic == null || isOtaWriteInFlight) return;
      byte[] next = otaWriteQueue.pollFirst();
      if (next == null) return;

      isOtaWriteInFlight = true;
      int props = characteristic.getProperties();
      int writeType =
          (props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
              ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
              : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
      characteristic.setWriteType(writeType);
      otaWriteUsesNoResponseMode = writeType == BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
      characteristic.setValue(next);
      boolean started = gatt.writeCharacteristic(characteristic);
      if (!started) {
        isOtaWriteInFlight = false;
        otaWriteUsesNoResponseMode = false;
        otaWriteQueue.addFirst(next);
        handler.postDelayed(this::processNextOtaWrite, 15L);
      } else if (writeType == BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) {
        isOtaWriteInFlight = false;
        handler.post(this::processNextOtaWrite);
      }
    }
  }


  private void sendAr99OtaStatus(String phase, int progress, int offset, int total, String errorMessage) {
    java.util.HashMap<String, Object> body = new java.util.HashMap<>();
    body.put("type", "ar99_ota_status");
    body.put("phase", phase);
    body.put("progress", Math.max(0, Math.min(100, progress)));
    body.put("offset", offset);
    body.put("total", total);
    if (errorMessage != null && !errorMessage.isEmpty()) {
      body.put("errorMessage", errorMessage);
      body.put("error_message", errorMessage);
    }
    Bridge.sendTypedMessage("ar99_ota_status", body);
  }

  private void enqueueMessage(int function, int cmd, byte[] payload, int receiver) {
    if (payload == null) payload = new byte[0];
    byte[] packet = buildHeader(function, cmd, payload, TARGET_MOBILE_APP, receiver, false);
    MessageHeader header = parseHeader(packet);
    if (header != null) {
      logSend(
          ">>>"
              + bytesToHex(packet)
              + ",len="
              + packet.length
              + " function="
              + header.function
              + " cmd="
              + header.cmd);
    }

    for (int start = 0; start < packet.length; start += BLE_WRITE_CHUNK_SIZE) {
      int end = Math.min(packet.length, start + BLE_WRITE_CHUNK_SIZE);
      writeQueue.add(Arrays.copyOfRange(packet, start, end));
    }
    processNextWrite();
  }

  private void processNextWrite() {
    BluetoothGatt gatt = controlGatt;
    if (gatt == null) return;
    BluetoothGattCharacteristic characteristic = controlWriteCharacteristic;
    if (characteristic == null) return;
    if (isWriteInFlight) return;

    byte[] packet = writeQueue.pollFirst();
    if (packet == null) return;

    characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
    characteristic.setValue(packet);

    isWriteInFlight = gatt.writeCharacteristic(characteristic);
    if (!isWriteInFlight) {
      writeQueue.addFirst(packet);
      logSend("writeCharacteristic(false) requeue chunk len=" + packet.length);
      handler.removeCallbacks(writeDrainRunnable);
      handler.postDelayed(writeDrainRunnable, BLE_WRITE_CHUNK_DELAY_MS * 2);
      return;
    }
    handler.removeCallbacks(writeDrainRunnable);
    handler.postDelayed(writeDrainRunnable, BLE_WRITE_CHUNK_DELAY_MS);
  }

  private byte[] buildHeader(
      int function,
      int cmd,
      byte[] payload,
      int sender,
      int receiver,
      boolean isResponse) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);

    int ctrl =
        (sender & CTRL_SENDER_MASK)
            | ((receiver & CTRL_SENDER_MASK) << 2)
            | (isResponse ? CTRL_ACTION_RESPONSE : 0);
    int seq = nextSequence();

    try {
      coded.writeFixed32(1, MAGIC_NUMBER);
      coded.writeUInt32(2, function);
      coded.writeUInt32(3, cmd);
      if (payload != null && payload.length > 0) {
        coded.writeUInt32(4, payload.length);
      }
      coded.writeUInt32(5, ctrl);
      coded.writeUInt32(6, seq);
      if (payload != null && payload.length > 0) {
        coded.writeUInt32(7, checksum16(payload));
        coded.writeByteArray(8, payload);
      }
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildHeader IO error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private int nextSequence() {
    while (true) {
      int seq = sequence.getAndIncrement() & 0x7F;
      if (seq != 0) return seq;
    }
  }

  private int checksum16(byte[] data) {
    if (data == null) return 0;
    int sum = 0;
    for (byte b : data) {
      sum += b & 0xFF;
    }
    return sum & 0xFFFF;
  }

  // ---------------- Payload builders (minimal protobuf encoding) ----------------

  private byte[] buildProtoMessageUInt32(int fieldNumber, int value) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeUInt32(fieldNumber, value);
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildProtoMessageUInt32 error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildProtoMessageBool(int fieldNumber, boolean value) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeBool(fieldNumber, value);
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildProtoMessageBool error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildSetTimePayload(long timestampMs) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      TimeZone timeZone = TimeZone.getDefault();
      int timezoneOffsetMinutes = timeZone.getOffset(timestampMs) / (60 * 1000);
      boolean is24Hour = DateFormat.is24HourFormat(context);

      coded.writeInt64(1, timestampMs);
      coded.writeUInt32(2, 1);
      coded.writeBool(3, is24Hour);
      coded.writeInt32(4, timezoneOffsetMinutes);
      coded.writeString(5, timeZone.getID());
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildSetTimePayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildTranslationDisplayStartPayload(
      int sourceLanguage, int targetLanguage, int micSource) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeUInt32(1, sourceLanguage);
      coded.writeUInt32(2, targetLanguage);
      coded.writeUInt32(3, micSource);
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildTranslationDisplayStartPayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildTranslationDisplaySetContentPayload(
      int state, int fontSize, String sourceText, String targetText) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeUInt32(1, state);
      coded.writeUInt32(2, fontSize);
      coded.writeUInt32(3, TRANS_DISPLAY_SOURCE_LANGUAGE);
      coded.writeUInt32(4, TRANS_DISPLAY_TARGET_LANGUAGE);
      coded.writeString(5, sourceText != null ? sourceText : "");
      coded.writeString(6, targetText != null ? targetText : "");
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildTranslationDisplaySetContentPayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildDisplaySystemFunctionPayload(int functionType, int action) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeUInt32(1, functionType);
      coded.writeUInt32(2, action);
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildDisplaySystemFunctionPayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildControlDisplayAudioRecordPayload(boolean enabled) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      // Old 161 protocol uses start=false to begin recording, start=true to stop.
      coded.writeBool(1, !enabled);
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildControlDisplayAudioRecordPayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  private byte[] buildMinimalTextSetPayload(String text) {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    CodedOutputStream coded = CodedOutputStream.newInstance(output);
    try {
      coded.writeString(1, text != null ? text : "");
      coded.flush();
    } catch (IOException e) {
      Bridge.log(TAG + ": buildMinimalTextSetPayload error: " + e.getMessage());
    }
    return output.toByteArray();
  }

  // ---------------- High-level AR99 messages ----------------

  private void sendMinimalText(String text) {
    String normalizedText = text != null ? text : "";
    if (!minimalModeReady) {
      pendingDisplayText = normalizedText;
      hasPendingDisplayUpdate = true;
      logSend(
          "minimal text deferred until minimal mode ready: len=" + pendingDisplayText.length());
      return;
    }
    long now = System.currentTimeMillis();
    if (displaySessionStarted
        && lastDisplayContentAtMs > 0L
        && now - lastDisplayContentAtMs >= DISPLAY_SESSION_IDLE_RESTART_MS) {
      displaySessionStarted = false;
      lastDisplayText = "";
    }
    sendMinimalTextNow(normalizedText);
  }

  private void sendMinimalTextNow(String text) {
    String normalizedText = text != null ? text : "";
    if (normalizedText.equals(lastDisplayText)) {
      return;
    }

    if (normalizedText.isEmpty()) {
      clearMinimalTextNow();
      return;
    }

    startMinimalTextIfNeeded();
    logDisplayRequest(normalizedText);

    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_CTRL_MINIMAL_TEXT_SET,
        buildMinimalTextSetPayload(normalizedText),
        TARGET_GLASS_MCU_DISPLAY);

    lastDisplayText = normalizedText;
    lastDisplayContentAtMs = System.currentTimeMillis();
  }

  private void flushPendingDisplayUpdateIfNeeded() {
    if (!minimalModeReady || !hasPendingDisplayUpdate) return;
    String text = pendingDisplayText;
    hasPendingDisplayUpdate = false;
    pendingDisplayText = "";
    logSend("flushing deferred minimal text update: len=" + text.length());
    sendMinimalTextNow(text);
  }

  private void startMinimalTextIfNeeded() {
    if (displaySessionStarted) return;
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_CTRL_MINIMAL_TEXT_START,
        new byte[0],
        TARGET_GLASS_MCU_DISPLAY);
    displaySessionStarted = true;
    lastDisplayContentAtMs = System.currentTimeMillis();
  }

  private void clearMinimalText() {
    if (!minimalModeReady) {
      pendingDisplayText = "";
      hasPendingDisplayUpdate = false;
      lastDisplayText = "";
      return;
    }
    clearMinimalTextNow();
  }

  private void clearMinimalTextNow() {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_CTRL_MINIMAL_TEXT_CLEAR,
        new byte[0],
        TARGET_GLASS_MCU_DISPLAY);
    resetMinimalTextSession();
  }

  private void resetMinimalTextSession() {
    displaySessionStarted = false;
    lastDisplayContentAtMs = 0L;
    lastDisplayText = "";
  }

  private String joinDisplayLines(String top, String bottom) {
    String first = top != null ? top.trim() : "";
    String second = bottom != null ? bottom.trim() : "";
    if (first.isEmpty()) return second;
    if (second.isEmpty()) return first;
    return first + "\n" + second;
  }

  private void logDisplayRequest(String text) {
    logSend(
        "minimalText len="
            + (text != null ? text.length() : 0)
            + " text=\""
            + formatDisplayTextForLog(text)
            + "\"");
  }

  private String formatDisplayTextForLog(String text) {
    if (text == null) {
      return "<null>";
    }
    return text.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n");
  }

  private void sendControlDisplayAudioRecord(boolean enabled) {
    byte[] payload = buildControlDisplayAudioRecordPayload(enabled);
    enqueueMessage(
        FUNC_COMM_DISPLAY, CMD_DISPLAY_CTRL_AUDIO_RECORD, payload, TARGET_GLASS_ANDROID);
  }

  private void setMinimalDisplayMode() {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_CTRL_SYS_FUNCTION,
        buildDisplaySystemFunctionPayload(DISPLAY_FUNCTION_TYPE_UI_MODE, DISPLAY_UI_MODE_MINIMAL),
        TARGET_GLASS_MCU_DISPLAY);
  }

  private void setDisplayLanguage(int language) {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_SET_LANGUAGE,
        buildProtoMessageUInt32(1, language),
        TARGET_GLASS_MCU_DISPLAY);
  }

  private void requestDeviceInfo() {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_GET_DEVICEINFO,
        new byte[0],
        TARGET_GLASS_MCU_DISPLAY);
  }

  private void requestBrightness() {
    enqueueMessage(
        FUNC_COMM_DISPLAY,
        CMD_DISPLAY_GET_BRIGHT,
        new byte[0],
        TARGET_GLASS_MCU_DISPLAY);
  }

  @Override
  public void sendSetSystemTime(long timestampMs) {
    Bridge.log(TAG + ": sending set time timestampMs=" + timestampMs);
    enqueueMessage(
        FUNC_COMM,
        CMD_COMM_SET_TIME,
        buildSetTimePayload(timestampMs),
        TARGET_GLASS_MCU_DISPLAY);
  }

  private void handleControlPacket(byte[] data) {
    MessageHeader header = parseHeader(data);
    if (header == null) return;
    boolean isResponse = (header.ctrl & CTRL_ACTION_RESPONSE) != 0;
    logRecv(
        "<<<"
            + bytesToHex(data)
            + ",len="
            + data.length
            + " function="
            + header.function
            + " cmd="
            + header.cmd
            + " ctrl="
            + header.ctrl
            + " isResponse="
            + isResponse);

    if (header.function == FUNC_COMM) {
      handleCommMessage(header.cmd, isResponse, header.payload);
    } else if (header.function == FUNC_COMM_DISPLAY) {
      if (header.cmd == CMD_DISPLAY_CTRL_AUDIO_RECORD) {
        handleLegacyAudioRecordMessage(isResponse, header.payload);
      } else {
        handleDisplayMessage(header.cmd, isResponse, header.payload);
      }
    } else if (header.function == FUNC_TRANS) {
      handleTransMessage(header.cmd, isResponse, header.payload);
    }
  }

  private void handleTransMessage(int cmd, boolean isResponse, byte[] payload) {
    if (!isResponse && cmd == CMD_TRANS_DISPLAY_STOP) {
      setMicEnabled(false);
      resetMinimalTextSession();
      logRecv("parsed trans stop request; local display session reset");
      return;
    }

    if (isResponse && cmd == CMD_TRANS_DISPLAY_STOP) {
      Boolean success = parseSuccessResponse(payload);
      if (success != null && success) {
        resetMinimalTextSession();
      }
      logRecv(
          "parsed trans stop response success="
              + success
              + " localDisplaySessionStarted="
              + displaySessionStarted);
      return;
    }

    if (isResponse && cmd == CMD_TRANS_DISPLAY_START) {
      Boolean success = parseSuccessResponse(payload);
      if (success == null || !success) {
        logRecv(
            "parsed trans start response success="
                + success
                + " localDisplaySessionStarted="
                + displaySessionStarted);
      }
      return;
    }

    if (isResponse && cmd == CMD_TRANS_DISPLAY_SET_CONTENT) {
      Boolean success = parseSuccessResponse(payload);
      if (success == null || !success) {
        logRecv(
            "parsed trans set_content response success="
                + success
                + " localDisplaySessionStarted="
                + displaySessionStarted);
      }
    }
  }

  private void handleDisplayMessage(int cmd, boolean isResponse, byte[] payload) {
    if (cmd == CMD_DISPLAY_GET_BATTERY) {
      BatteryInfo info = parseBatteryResponse(payload);
      if (info != null) {
        logRecv(
            "parsed cmd="
                + cmd
                + " isResponse="
                + isResponse
                + " battery="
                + info.battery
                + " charging="
                + info.charging);
        if (info.battery >= 0 && info.battery <= 100) {
          DeviceStore.INSTANCE.apply("glasses", "batteryLevel", info.battery);
          boolean charging =
              info.charging != null
                  ? info.charging
                  : (DeviceStore.INSTANCE.get("glasses", "charging") instanceof Boolean
                      ? (Boolean) DeviceStore.INSTANCE.get("glasses", "charging")
                      : false);
          if (info.charging != null) {
            DeviceStore.INSTANCE.apply("glasses", "charging", charging);
          }
          Bridge.sendBatteryStatus(info.battery, charging);
          hasReceivedBatteryForCurrentConnection = true;
          pendingBatteryRetries = 0;
          batteryQueryHandler.removeCallbacks(initialBatteryRetryRunnable);
        } else {
          Bridge.log(TAG + ": ignoring out-of-range battery response: " + info.battery);
        }
      } else {
        Bridge.log(
            TAG + ": failed to parse battery response payload len="
                + payload.length
                + " hex="
                + bytesToHex(payload));
      }
    } else if (cmd == CMD_DISPLAY_GET_DEVICEINFO) {
      DeviceInfo info = parseDeviceInfoResponse(payload);
      if (info != null) {
        logRecv(
            "parsed cmd="
                + cmd
                + " isResponse="
                + isResponse
                + " firmware="
                + info.firmwareVersion
                + " product="
                + info.productName
                + " btMac="
                + info.btMac
                + " serial="
                + info.serialNumber
                + " deviceName="
                + info.deviceName);
        if (info.firmwareVersion != null) {
          DeviceStore.INSTANCE.apply("glasses", "firmwareVersion", info.firmwareVersion);
        }
        if (info.productName != null) {
          DeviceStore.INSTANCE.apply("glasses", "deviceModel", info.productName);
        }
          String preferredBtMac = currentBroadcastMacAddress != null && !currentBroadcastMacAddress.trim().isEmpty() ? currentBroadcastMacAddress : info.btMac;
          if (preferredBtMac != null && !preferredBtMac.trim().isEmpty()) {
            DeviceStore.INSTANCE.apply("glasses", "bluetoothMacAddress", preferredBtMac);
          }
        if (info.serialNumber != null) {
          DeviceStore.INSTANCE.apply("glasses", "serialNumber", info.serialNumber);
        }
        sendVersionInfo(info);
      }
    } else if (cmd == CMD_DISPLAY_GET_BRIGHT) {
      Integer brightness = parseBrightnessResponse(payload);
      if (brightness != null) {
        DeviceStore.INSTANCE.apply("glasses", "brightness", brightness);
        logRecv(
            "parsed cmd="
                + cmd
                + " isResponse="
                + isResponse
                + " brightness="
                + brightness);
      }
    } else if (cmd == CMD_DISPLAY_SET_LANGUAGE) {
      LanguageResponse response = parseLanguageResponse(payload);
      if (response != null) {
        logRecv(
            "parsed cmd="
                + cmd
                + " isResponse="
                + isResponse
                + " success="
                + response.success
                + " language="
                + response.language);
      } else {
        Bridge.log(
            TAG
                + ": failed to parse display response cmd="
                + cmd
                + " payload="
                + bytesToHex(payload));
      }
    } else if (cmd == CMD_DISPLAY_SET_BRIGHT) {
      Integer brightness = parseSetBrightnessResponse(payload);
      if (brightness != null) {
        DeviceStore.INSTANCE.apply("glasses", "brightness", brightness);
        logRecv(
            "parsed cmd="
                + cmd
                + " isResponse="
                + isResponse
                + " currentBrightness="
                + brightness);
      }
    } else if (cmd == CMD_DISPLAY_CTRL_FACTORY_RESET) {
      Boolean success = null;
      Integer confirmCode = null;
      try {
        CodedInputStream input = CodedInputStream.newInstance(payload);
        while (!input.isAtEnd()) {
          int tag = input.readTag();
          if (tag == 0) break;
          switch (WireFormat.getTagFieldNumber(tag)) {
            case 1:
              success = input.readBool();
              break;
            case 2:
              confirmCode = input.readUInt32();
              break;
            default:
              input.skipField(tag);
              break;
          }
        }
      } catch (IOException e) {
        Bridge.log(TAG + ": failed parsing factory reset response: " + e.getMessage());
      }
      logRecv(
          "parsed cmd="
              + cmd
              + " isResponse="
              + isResponse
              + " success="
              + success
              + " confirmCode="
              + confirmCode);
    } else if (cmd == CMD_DISPLAY_CTRL_SYS_FUNCTION) {
      Boolean success = parseSuccessResponse(payload);
      if (success != null) {
        logRecv("parsed cmd=" + cmd + " isResponse=" + isResponse + " success=" + success);
        if (isResponse && success) {
          minimalModeReady = true;
          flushPendingDisplayUpdateIfNeeded();
        }
      }
    } else if (cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_START
        || cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_SET
        || cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_CLEAR
        || cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_STOP) {
      Boolean success = parseSuccessResponse(payload);
      logRecv("parsed cmd=" + cmd + " isResponse=" + isResponse + " success=" + success);
      if (isResponse && Boolean.FALSE.equals(success)) {
        if (cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_START) {
          displaySessionStarted = false;
        } else if (cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_CLEAR
            || cmd == CMD_DISPLAY_CTRL_MINIMAL_TEXT_STOP) {
          resetMinimalTextSession();
        }
      }
    }
  }

  private void handleCommMessage(int cmd, boolean isResponse, byte[] payload) {
    if (cmd == CMD_COMM_SET_TIME) {
      SetTimeResponse response = parseSetTimeResponse(payload);
      if (response != null) {
        StringBuilder log =
            new StringBuilder("parsed cmd=")
                .append(cmd)
                .append(" isResponse=")
                .append(isResponse)
                .append(" success=")
                .append(response.success);
        if (response.timeValue != null) {
          log.append(" timeValue=").append(response.timeValue);
        }
        logRecv(log.toString());
      } else {
        Bridge.log(
            TAG + ": failed to parse comm response cmd=" + cmd + " payload=" + bytesToHex(payload));
      }
    }
  }

  private void handleLegacyAudioRecordMessage(boolean isResponse, byte[] payload) {
    Boolean currentRecording = parseLegacyAudioRecordResponse(payload);
    if (currentRecording != null) {
      if (!currentRecording) {
        awaitingMicDisableAck = false;
        if (opusPcmDecoder != null) {
          opusPcmDecoder.resetBuffer();
        }
      }
      DeviceStore.INSTANCE.apply("glasses", "micEnabled", currentRecording);
      logRecv(
          "parsed legacy cmd="
              + CMD_DISPLAY_CTRL_AUDIO_RECORD
              + " isResponse="
              + isResponse
              + " currentRecording="
              + currentRecording);
    }
  }

  private CommonResult parseCommonResult(CodedInputStream input) throws IOException {
    byte[] raw = input.readByteArray();
    return parseCommonResult(raw);
  }

  private CommonResult parseCommonResult(byte[] raw) throws IOException {
    CodedInputStream nested = CodedInputStream.newInstance(raw);
    boolean success = false;
    int errorCode = 0;
    String errorMessage = "";

    while (!nested.isAtEnd()) {
      int tag = nested.readTag();
      if (tag == 0) break;
      switch (WireFormat.getTagFieldNumber(tag)) {
        case 1:
          success = nested.readBool();
          break;
        case 2:
          errorCode = nested.readUInt32();
          break;
        case 3:
          errorMessage = nested.readString();
          break;
        default:
          nested.skipField(tag);
          break;
      }
    }

    return new CommonResult(success, errorCode, errorMessage);
  }

  private Boolean readSuccessField(CodedInputStream input, int tag) throws IOException {
    int wireType = WireFormat.getTagWireType(tag);
    if (wireType == WireFormat.WIRETYPE_VARINT) {
      return input.readBool();
    }
    if (wireType == WireFormat.WIRETYPE_LENGTH_DELIMITED) {
      return parseCommonResult(input).success;
    }
    input.skipField(tag);
    return null;
  }

  private BatteryInfo parseBatteryResponse(byte[] payload) {
    BatteryInfo nested = parseBatteryResponseNested(payload);
    if (nested != null) {
      return nested;
    }
    return parseBatteryResponseFlat(payload);
  }

  private BatteryInfo parseBatteryResponseNested(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      int battery = -1;
      Boolean charging = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            battery = input.readUInt32();
            break;
          case 3:
            charging = input.readBool();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (success == null || !success) return null;
      return new BatteryInfo(battery, charging);
    } catch (Throwable t) {
      return null;
    }
  }

  /**
   * Some AR99 firmware revisions appear to flatten the battery response instead of nesting a
   * CommonResult submessage in field 1. Accept both layouts so the UI doesn't stay stuck at -1.
   */
  private BatteryInfo parseBatteryResponseFlat(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Integer battery = null;
      Boolean charging = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;

        int fieldNumber = WireFormat.getTagFieldNumber(tag);
        int wireType = WireFormat.getTagWireType(tag);

        switch (fieldNumber) {
          case 1:
            if (wireType == WireFormat.WIRETYPE_LENGTH_DELIMITED) {
              CommonResult result = parseCommonResult(input.readByteArray());
              success = result.success;
            } else if (wireType == WireFormat.WIRETYPE_VARINT) {
              long value = input.readUInt64();
              if (value == 0L || value == 1L) {
                success = value == 1L;
              } else if (battery == null && value >= 0L && value <= 100L) {
                battery = (int) value;
              }
            } else {
              input.skipField(tag);
            }
            break;
          case 2:
            if (wireType == WireFormat.WIRETYPE_VARINT) {
              long value = input.readUInt64();
              if (battery == null && value >= 0L && value <= 100L) {
                battery = (int) value;
              } else if (charging == null && (value == 0L || value == 1L)) {
                charging = value == 1L;
              }
            } else {
              input.skipField(tag);
            }
            break;
          case 3:
            if (wireType == WireFormat.WIRETYPE_VARINT) {
              charging = input.readBool();
            } else {
              input.skipField(tag);
            }
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (battery == null) {
        return null;
      }
      if (success != null && !success) {
        return null;
      }
      return new BatteryInfo(battery, charging);
    } catch (Throwable t) {
      return null;
    }
  }

  private DeviceInfo parseDeviceInfoResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      String firmware = null;
      String version = null;
      String deviceName = null;
      String productName = null;
      String btMac = null;
      String serial = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            firmware = input.readString();
            break;
          case 5:
            version = input.readString();
            break;
          case 6:
            deviceName = input.readString();
            break;
          case 7:
            productName = input.readString();
            break;
          case 8:
            btMac = input.readString();
            break;
          case 9:
            serial = input.readString();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (success == null || !success) return null;
      return new DeviceInfo(
          version != null && !version.isEmpty() ? version : firmware,
          deviceName,
          productName,
          btMac,
          serial);
    } catch (Throwable t) {
      return null;
    }
  }

  private LanguageResponse parseLanguageResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Integer language = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            language = input.readUInt32();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (success == null) return null;
      return new LanguageResponse(success, language);
    } catch (Throwable t) {
      return null;
    }
  }

  private SetTimeResponse parseSetTimeResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Long timeValue = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        int fieldNumber = WireFormat.getTagFieldNumber(tag);
        int wireType = WireFormat.getTagWireType(tag);

        switch (fieldNumber) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            if (wireType == WireFormat.WIRETYPE_VARINT) {
              timeValue = input.readUInt64();
            } else {
              input.skipField(tag);
            }
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (success == null) return null;
      return new SetTimeResponse(success, timeValue);
    } catch (Throwable t) {
      return null;
    }
  }

  private void sendVersionInfo(DeviceInfo info) {
    HashMap<String, Object> values = new HashMap<>();
    if (info.firmwareVersion != null) {
      values.put("firmwareVersion", info.firmwareVersion);
    }
    if (info.productName != null) {
      values.put("deviceModel", info.productName);
    }
    if (info.serialNumber != null) {
      values.put("serialNumber", info.serialNumber);
    }
    Bridge.sendVersionInfo(values);
  }

  private Integer parseBrightnessResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Integer brightness = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            brightness = input.readUInt32();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      return success != null && success ? brightness : null;
    } catch (Throwable t) {
      return null;
    }
  }

  private Integer parseSetBrightnessResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Integer brightness = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          case 2:
            brightness = input.readUInt32();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      return success != null && success ? brightness : null;
    } catch (Throwable t) {
      return null;
    }
  }

  private Boolean parseSuccessResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = readSuccessField(input, tag);
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      return success;
    } catch (Throwable t) {
      return null;
    }
  }

  private Boolean parseLegacyAudioRecordResponse(byte[] payload) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(payload);
      Boolean success = null;
      Boolean start = null;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        switch (WireFormat.getTagFieldNumber(tag)) {
          case 1:
            success = input.readBool();
            break;
          case 2:
            start = input.readBool();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (success == null || !success || start == null) {
        return null;
      }
      return !start;
    } catch (Throwable t) {
      return null;
    }
  }

  private static final class LanguageResponse {
    final boolean success;
    final Integer language;

    LanguageResponse(boolean success, Integer language) {
      this.success = success;
      this.language = language;
    }
  }

  private static final class SetTimeResponse {
    final boolean success;
    final Long timeValue;

    SetTimeResponse(boolean success, Long timeValue) {
      this.success = success;
      this.timeValue = timeValue;
    }
  }

  private void handleControlNotifyChunk(byte[] data) {
    if (data == null || data.length == 0) return;

    if (controlNotifyBuffer.length == 0) {
      controlNotifyBuffer = Arrays.copyOf(data, data.length);
    } else {
      byte[] merged = Arrays.copyOf(controlNotifyBuffer, controlNotifyBuffer.length + data.length);
      System.arraycopy(data, 0, merged, controlNotifyBuffer.length, data.length);
      controlNotifyBuffer = merged;
    }

    while (true) {
      int start = findMessageStart(controlNotifyBuffer);
      if (start < 0) {
        trimControlNotifyBuffer();
        return;
      }
      if (start > 0) {
        controlNotifyBuffer =
            Arrays.copyOfRange(controlNotifyBuffer, start, controlNotifyBuffer.length);
      }

      int nextStart = findMessageStart(controlNotifyBuffer, 1);
      byte[] candidatePacket =
          nextStart > 0
              ? Arrays.copyOfRange(controlNotifyBuffer, 0, nextStart)
              : controlNotifyBuffer;

      MessageHeader header = parseHeader(candidatePacket);
      if (header == null) {
        if (nextStart > 0) {
          controlNotifyBuffer =
              Arrays.copyOfRange(controlNotifyBuffer, nextStart, controlNotifyBuffer.length);
          continue;
        }
        trimControlNotifyBuffer();
        return;
      }

      if (controlNotifyBuffer.length < header.totalBytes) {
        trimControlNotifyBuffer();
        return;
      }

      byte[] packet = Arrays.copyOfRange(controlNotifyBuffer, 0, header.totalBytes);
      controlNotifyBuffer =
          Arrays.copyOfRange(controlNotifyBuffer, header.totalBytes, controlNotifyBuffer.length);
      handleControlPacket(packet);
    }
  }

  private void trimControlNotifyBuffer() {
    if (controlNotifyBuffer.length <= 2048) return;

    int candidateStart = findMessageStart(controlNotifyBuffer);
    if (candidateStart > 0 && candidateStart < controlNotifyBuffer.length) {
      controlNotifyBuffer = Arrays.copyOfRange(controlNotifyBuffer, candidateStart, controlNotifyBuffer.length);
      return;
    }

    controlNotifyBuffer = new byte[0];
  }

  private int findMessageStart(byte[] data) {
    return findMessageStart(data, 0);
  }

  private int findMessageStart(byte[] data, int fromIndex) {
    if (data == null || data.length < 5) return -1;

    int start = Math.max(0, fromIndex);
    for (int i = start; i <= data.length - 5; i++) {
      if ((data[i] & 0xFF) == 0x0D
          && (data[i + 1] & 0xFF) == 0x4D
          && (data[i + 2] & 0xFF) == 0x3C
          && (data[i + 3] & 0xFF) == 0x2B
          && (data[i + 4] & 0xFF) == 0x1A) {
        return i;
      }
    }

    return -1;
  }


  private void handleOpusData(byte[] data) {
    if (data == null || data.length == 0) {
      return;
    }
    // Logcat: adb logcat -s Ar99Opus (DEBUG = per-chunk length; INFO = first chunk + hex)
    Log.d(LOG_TAG_OPUS, "notify len=" + data.length);
    if (!opusLoggedFirstInSession) {
      opusLoggedFirstInSession = true;
      Log.i(
          LOG_TAG_OPUS,
          "Opus BLE (first chunk) len=" + data.length + " head16=" + hexPrefixUpper(data, 16));
    }
    if (!getMicEnabled()) {
      Log.w(LOG_TAG_OPUS, "received OPUS while glasses micEnabled=false; decoding anyway");
    }
    ensureOpusDecoder();
    if (opusPcmDecoder == null) {
      Log.w(LOG_TAG_OPUS, "decoder unavailable; skipping PCM");
      return;
    }
    opusPcmDecoder.submitBleNotify(data);
  }

  private static String hexPrefixUpper(byte[] data, int maxBytes) {
    int n = Math.min(maxBytes, data.length);
    StringBuilder sb = new StringBuilder(n * 3);
    for (int i = 0; i < n; i++) {
      if (i > 0) {
        sb.append(' ');
      }
      sb.append(String.format("%02X", data[i] & 0xFF));
    }
    if (data.length > maxBytes) {
      sb.append(" ...");
    }
    return sb.toString();
  }

  private static String bytesToHex(byte[] data) {
    if (data == null || data.length == 0) return "";
    StringBuilder sb = new StringBuilder(data.length * 2);
    for (byte b : data) {
      sb.append(String.format("%02X", b & 0xFF));
    }
    return sb.toString();
  }

  private void logSend(String message) {
    Log.d(TAG, message);
  }

  private void logRecv(String message) {
    Log.d(TAG, message);
  }

  private synchronized void ensureOpusDecoder() {
    if (opusPcmDecoder != null) {
      return;
    }
    try {
      opusPcmDecoder =
          new Ar99OpusPcmDecoder(
              new Ar99OpusPcmDecoder.Callback() {
                @Override
                public void onPcmDecoded(byte[] pcmData) {
                  DeviceManager.getInstance().reportGlassesAudioActivity();
                  DeviceManager.getInstance().handlePcm(pcmData);
                }

                @Override
                public void onNotifyProcessed(int rawLen, int pcmFrames, int pcmBytesOut) {
                  if (pcmFrames > 0) {
                    Log.d(
                        LOG_TAG_OPUS,
                        "decoded PCM chunks="
                            + pcmFrames
                            + " bytesOut="
                            + pcmBytesOut
                            + " rawLen="
                            + rawLen);
                  }
                }
              });
    } catch (Throwable e) {
      Bridge.log(TAG + ": failed to create Opus decoder: " + e.getMessage());
    }
  }

  // ---------------- Parsing ----------------

  private MessageHeader parseHeader(byte[] data) {
    try {
      CodedInputStream input = CodedInputStream.newInstance(data);
      int magic = 0;
      int function = 0;
      int cmd = 0;
      int ctrl = 0;
      int seq = 0;
      byte[] payload = new byte[0];
      int totalBytes = -1;

      while (!input.isAtEnd()) {
        int tag = input.readTag();
        if (tag == 0) break;
        int fieldNumber = WireFormat.getTagFieldNumber(tag);
        switch (fieldNumber) {
          case 1:
            magic = input.readFixed32();
            break;
          case 2:
            function = input.readUInt32();
            break;
          case 3:
            cmd = input.readUInt32();
            break;
          case 5:
            ctrl = input.readUInt32();
            break;
          case 6:
            seq = input.readUInt32();
            break;
          case 8:
            payload = input.readByteArray();
            totalBytes = input.getTotalBytesRead();
            break;
          default:
            input.skipField(tag);
            break;
        }
      }

      if (magic != MAGIC_NUMBER) return null;
      if (totalBytes <= 0) {
        totalBytes = data.length;
      }
      return new MessageHeader(function, cmd, ctrl, seq, payload, totalBytes);
    } catch (Throwable t) {
      return null;
    }
  }


  // ---------------- Connection state ----------------

  private void markReady() {
    if (controlWriteCharacteristic == null || controlNotifyCharacteristic == null) return;
    if (ConnTypes.CONNECTED.equals(getConnectionState()) && getConnected() && getFullyBooted()) return;

    minimalModeReady = false;
    hasPendingDisplayUpdate = false;
    pendingDisplayText = "";
    resetMinimalTextSession();
    hasReceivedBatteryForCurrentConnection = false;
    if (currentProjectName != null && !currentProjectName.trim().isEmpty()) {
      DeviceStore.INSTANCE.apply("bluetooth", "project_name", currentProjectName.trim());
    }
    String connectedBluetoothName = getConnectedBluetoothName();
    if (connectedBluetoothName != null && !connectedBluetoothName.trim().isEmpty()) {
      DeviceStore.INSTANCE.apply("glasses", "bluetoothName", connectedBluetoothName.trim());
    }
    DeviceStore.INSTANCE.apply("glasses", "connected", true);
    DeviceStore.INSTANCE.apply("glasses", "fullyBooted", true);
    updateConnectionState(ConnTypes.CONNECTED);

    handler.removeCallbacks(readyMinimalModeRunnable);
    handler.removeCallbacks(readyLanguageRunnable);
    handler.removeCallbacks(readyDeviceInfoRunnable);
    handler.removeCallbacks(readyBrightnessRunnable);
    handler.removeCallbacks(readyBatteryRunnable);
    handler.postDelayed(readyMinimalModeRunnable, READY_MINIMAL_MODE_DELAY_MS);
    handler.postDelayed(readyLanguageRunnable, READY_LANGUAGE_DELAY_MS);
    handler.postDelayed(readyDeviceInfoRunnable, READY_DEVICE_INFO_DELAY_MS);
    handler.postDelayed(readyBrightnessRunnable, READY_BRIGHTNESS_DELAY_MS);
    handler.postDelayed(readyBatteryRunnable, READY_BATTERY_DELAY_MS);
    scheduleBatteryQueries();
  }

  private void scheduleBatteryQueries() {
    pendingBatteryRetries = 0;
    batteryQueryHandler.removeCallbacks(initialBatteryRetryRunnable);
    batteryQueryHandler.removeCallbacks(periodicBatteryPollRunnable);

    batteryQueryHandler.postDelayed(initialBatteryRetryRunnable, INITIAL_BATTERY_RETRY_DELAY_MS);
    batteryQueryHandler.postDelayed(periodicBatteryPollRunnable, BATTERY_POLL_INTERVAL_MS);
  }

  private void cleanupGatt() {
    writeQueue.clear();
    synchronized (otaWriteQueue) {
      otaWriteQueue.clear();
      isOtaWriteInFlight = false;
      otaWriteUsesNoResponseMode = false;
    }
    notifyQueue.clear();
    isWriteInFlight = false;
    isOtaNotificationEnabled = false;
    isNotifyWriteInFlight = false;
    minimalModeReady = false;
    resetMinimalTextSession();
    hasPendingDisplayUpdate = false;
    pendingDisplayText = "";
    hasReceivedBatteryForCurrentConnection = false;
    controlNotifyBuffer = new byte[0];
    pendingBatteryRetries = 0;
    handler.removeCallbacks(readyMinimalModeRunnable);
    handler.removeCallbacks(readyLanguageRunnable);
    handler.removeCallbacks(readyDeviceInfoRunnable);
    handler.removeCallbacks(readyBrightnessRunnable);
    handler.removeCallbacks(readyBatteryRunnable);
    handler.removeCallbacks(writeDrainRunnable);
    batteryQueryHandler.removeCallbacks(initialBatteryRetryRunnable);
    batteryQueryHandler.removeCallbacks(periodicBatteryPollRunnable);

    controlWriteCharacteristic = null;
    controlNotifyCharacteristic = null;
    opusNotifyCharacteristic = null;
    otaWriteCharacteristic = null;
    otaNotifyCharacteristic = null;

    BluetoothGatt gatt = controlGatt;
    if (gatt != null) {
      try {
        gatt.disconnect();
      } catch (Throwable t) {
        // ignore
      }
      try {
        gatt.close();
      } catch (Throwable t) {
        // ignore
      }
    }
    controlGatt = null;

    opusLoggedFirstInSession = false;

    if (opusPcmDecoder != null) {
      opusPcmDecoder.resetBuffer();
    }

    awaitingMicDisableAck = false;
    DeviceStore.INSTANCE.apply("glasses", "connected", false);
    DeviceStore.INSTANCE.apply("glasses", "fullyBooted", false);
    DeviceStore.INSTANCE.apply("glasses", "micEnabled", false);
    DeviceStore.INSTANCE.apply("glasses", "batteryLevel", -1);
    DeviceStore.INSTANCE.apply("glasses", "charging", false);
  }

  private void updateConnectionState(String state) {
    DeviceStore.INSTANCE.apply("glasses", "connectionState", state);
  }

  // ---------------- Advertisement parsing (BtUtil-like) ----------------

  private boolean matchesAr99(String name, String projectName) {
    return isSupportedProjectName(projectName);
  }

  static boolean isSupportedProjectName(String projectName) {
    String project = projectName != null ? projectName.trim() : "";
    for (String supported : SUPPORTED_PROJECT_NAMES) {
      if (project.equalsIgnoreCase(supported)) return true;
    }
    return false;
  }
  private ParsedAdvertisement parseAdvertisement(byte[] scanRecord) {
    if (scanRecord == null || scanRecord.length == 0) return null;

    int pos = 0;
    String bleName = null;
    String projectName = null;
    String bleAddress = null;
    String btAddress = null;
    String serialNumber = null;

    while (pos < scanRecord.length - 1) {
      int size = scanRecord[pos] & 0xFF;
      if (size == 0 || pos + size >= scanRecord.length) break;
      int type = scanRecord[pos + 1] & 0xFF;

      switch (type) {
        case 0x09:
          bleName = new String(scanRecord, pos + 2, size - 1);
          break;
        case 0xFF:
          int p = pos + 2;
          if (size >= 21 && p + 19 < scanRecord.length) {
            projectName = trimAscii4(scanRecord, p);
            bleAddress = xorMac6ToColon(scanRecord, p + 8);
            btAddress = xorMac6ToColon(scanRecord, p + 14);
            serialNumber = parseAr99SerialNumber(scanRecord, pos, size);
          }
          break;
        default:
          break;
      }

      pos += size + 1;
    }

    if (!matchesAr99(bleName, projectName)) return null;
    return new ParsedAdvertisement(bleName, projectName, bleAddress, btAddress, serialNumber);
  }

  private String trimAscii4(byte[] data, int offset) {
    int end = offset + 4;
    while (end > offset && data[end - 1] == 0) end--;
    if (end <= offset) return "";
    try {
      return new String(data, offset, end - offset, "UTF-8");
    } catch (Exception e) {
      return "";
    }
  }

  private String xorMac6ToColon(byte[] data, int offset) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < 6; i++) {
      int decoded = (data[offset + i] ^ 0xAD) & 0xFF;
      if (i > 0) sb.append(":");
      sb.append(String.format("%02X", decoded));
    }
    return sb.toString();
  }

  private String parseAr99SerialNumber(byte[] scanRecord, int fieldStart, int size) {
    String project = trimAscii4(scanRecord, fieldStart + 2);
    if (!matchesAr99(null, project)) return null;

    int lastPayloadIdx = fieldStart + size;
    int serialOffset = fieldStart + 22;

    if (serialOffset + 12 <= scanRecord.length && serialOffset + 12 - 1 <= lastPayloadIdx) {
      if (!isAllZeroBytes(scanRecord, serialOffset, 12) && isAsciiDigits(scanRecord, serialOffset, 12)) {
        return safeAscii(scanRecord, serialOffset, 12);
      }
    }

    if (serialOffset + 6 <= scanRecord.length && serialOffset + 6 - 1 <= lastPayloadIdx) {
      if (!isAllZeroBytes(scanRecord, serialOffset, 6) && isAsciiDigits(scanRecord, serialOffset, 6)) {
        return safeAscii(scanRecord, serialOffset, 6);
      }
      if (!isAllZeroBytes(scanRecord, serialOffset, 6)) {
        return bytes6ToHex12(scanRecord, serialOffset);
      }
    }

    return null;
  }

  private boolean isAsciiDigits(byte[] data, int offset, int length) {
    for (int i = 0; i < length; i++) {
      int b = data[offset + i] & 0xFF;
      if (b < '0' || b > '9') return false;
    }
    return true;
  }

  private boolean isAllZeroBytes(byte[] data, int offset, int length) {
    boolean allZero = true;
    boolean allAsciiZero = true;
    for (int i = 0; i < length; i++) {
      int b = data[offset + i] & 0xFF;
      if (b != 0) {
        allZero = false;
      }
      if (b != '0') {
        allAsciiZero = false;
      }
    }
    return allZero || allAsciiZero;
  }

  private String safeAscii(byte[] data, int offset, int length) {
    try {
      return new String(data, offset, length, "UTF-8");
    } catch (Exception e) {
      return null;
    }
  }

  private String bytes6ToHex12(byte[] data, int offset) {
    StringBuilder sb = new StringBuilder(12);
    for (int i = 0; i < 6; i++) {
      sb.append(String.format("%02X", data[offset + i] & 0xFF));
    }
    return sb.toString();
  }

  private String buildDisplayName(
      String fallbackName, ParsedAdvertisement advertisement, String deviceAddress) {
    if (advertisement != null && advertisement.serialNumber != null && !advertisement.serialNumber.trim().isEmpty()) {
      return "SN: " + advertisement.serialNumber.trim();
    }
    String bleName = advertisement != null ? advertisement.bleName : fallbackName;
    String legacyNameSerial = extractLegacyNameSerial(bleName);
    if (!legacyNameSerial.isEmpty()) {
      return "SN: " + legacyNameSerial;
    }
    if (deviceAddress != null && !deviceAddress.trim().isEmpty()) {
      return "MAC: " + deviceAddress.trim();
    }
    return fallbackName;
  }

  private String extractTargetSerial(String target) {
    String trimmed = normalizeDisplayIdentifier(target);
    if (trimmed.isEmpty()) return "";
    int underscore = trimmed.lastIndexOf('_');
    if (underscore >= 0 && underscore + 1 < trimmed.length()) {
      return trimmed.substring(underscore + 1).trim();
    }
    return trimmed;
  }

  private String normalizeDisplayIdentifier(String value) {
    if (value == null) return "";
    String trimmed = value.trim();
    String upper = trimmed.toUpperCase();
    if (upper.startsWith("SN:")) {
      return trimmed.substring(3).trim();
    }
    if (upper.startsWith("MAC:")) {
      return trimmed.substring(4).trim();
    }
    return trimmed;
  }

  private String extractLegacyNameSerial(String bleName) {
    if (bleName == null) return "";
    String trimmed = bleName.trim();
    int underscore = trimmed.indexOf('_');
    if (underscore < 0 || underscore + 1 >= trimmed.length()) {
      return "";
    }
    return trimmed.substring(underscore + 1).trim();
  }

  // ---------------- Data holders ----------------

  private static class ParsedAdvertisement {
    final String bleName;
    final String projectName;
    final String bleAddress;
    final String btAddress;
    final String serialNumber;

    ParsedAdvertisement(String bleName, String projectName, String bleAddress, String btAddress, String serialNumber) {
      this.bleName = bleName;
      this.projectName = projectName;
      this.bleAddress = bleAddress;
      this.btAddress = btAddress;
      this.serialNumber = serialNumber;
    }
  }

  private static class MessageHeader {
    final int function;
    final int cmd;
    final int ctrl;
    final int sequence;
    final byte[] payload;
    final int totalBytes;

    MessageHeader(int function, int cmd, int ctrl, int sequence, byte[] payload, int totalBytes) {
      this.function = function;
      this.cmd = cmd;
      this.ctrl = ctrl;
      this.sequence = sequence;
      this.payload = payload;
      this.totalBytes = totalBytes;
    }
  }

  private static class DeviceInfo {
    final String firmwareVersion;
    final String deviceName;
    final String productName;
    final String btMac;
    final String serialNumber;

    DeviceInfo(String firmwareVersion, String deviceName, String productName, String btMac, String serialNumber) {
      this.firmwareVersion = firmwareVersion;
      this.deviceName = deviceName;
      this.productName = productName;
      this.btMac = btMac;
      this.serialNumber = serialNumber;
    }
  }

  private static class CommonResult {
    final boolean success;
    final int errorCode;
    final String errorMessage;

    CommonResult(boolean success, int errorCode, String errorMessage) {
      this.success = success;
      this.errorCode = errorCode;
      this.errorMessage = errorMessage;
    }
  }

  private static class BatteryInfo {
    final int battery;
    final Boolean charging;

    BatteryInfo(int battery, Boolean charging) {
      this.battery = battery;
      this.charging = charging;
    }
  }
}
