package com.mentra.core.sgcs;


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
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.SparseArray;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

//BMP
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.zip.CRC32;
import java.nio.ByteBuffer;

import com.google.gson.Gson;
import org.greenrobot.eventbus.EventBus;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.HashSet;

// Mentra
import com.mentra.core.sgcs.SGCManager;
import com.mentra.core.CoreManager;
import com.mentra.core.Bridge;
import com.mentra.core.utils.DeviceTypes;
import com.mentra.core.utils.BitmapJavaUtils;
import static com.mentra.core.utils.BitmapJavaUtils.convertBitmapTo1BitBmpBytes;
import com.mentra.core.utils.G1Text;
import com.mentra.core.utils.SmartGlassesConnectionState;
import com.mentra.lc3Lib.Lc3Cpp;

public class G1 extends SGCManager {
    private static final String TAG = "WearableAi_EvenRealitiesG1SGC";
    public static final String SHARED_PREFS_NAME = "EvenRealitiesPrefs";
    private int heartbeatCount = 0;
    private int micBeatCount = 0;
    private BluetoothAdapter bluetoothAdapter;

    public static final String LEFT_DEVICE_KEY = "SavedG1LeftName";
    public static final String RIGHT_DEVICE_KEY = "SavedG1RightName";

    private boolean isKilled = false;

    private static final UUID UART_SERVICE_UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID UART_TX_CHAR_UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID UART_RX_CHAR_UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID CLIENT_CHARACTERISTIC_CONFIG_UUID = UUID
            .fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String SAVED_G1_ID_KEY = "SAVED_G1_ID_KEY";
    private Context context;
    private BluetoothGatt leftGlassGatt;
    private BluetoothGatt rightGlassGatt;
    private BluetoothGattCharacteristic leftTxChar;
    private BluetoothGattCharacteristic rightTxChar;
    private BluetoothGattCharacteristic leftRxChar;
    private BluetoothGattCharacteristic rightRxChar;
    private SmartGlassesConnectionState connectionState = SmartGlassesConnectionState.DISCONNECTED;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Handler queryBatteryStatusHandler = new Handler(Looper.getMainLooper());
    private final Handler sendBrightnessCommandHandler = new Handler(Looper.getMainLooper());
    private Handler connectHandler = new Handler(Looper.getMainLooper());
    private Handler reconnectHandler = new Handler(Looper.getMainLooper());
    private Handler characteristicHandler = new Handler(Looper.getMainLooper());
    private final Semaphore sendSemaphore = new Semaphore(1);
    private boolean isLeftConnected = false;
    private boolean isRightConnected = false;
    private int currentSeq = 0;
    private boolean stopper = false;
    private boolean debugStopper = false;
    private boolean shouldUseAutoBrightness = false;
    private boolean updatingScreen = false;

    private static final long DELAY_BETWEEN_SENDS_MS = 5; // not using now
    private static final long DELAY_BETWEEN_CHUNKS_SEND = 5; // super small just in case
    private static final long DELAY_BETWEEN_ACTIONS_SEND = 250; // not using now
    private static final long HEARTBEAT_INTERVAL_MS = 15000;
    private static final long MICBEAT_INTERVAL_MS = (1000 * 60) * 30; // micbeat every 30 minutes


    private int batteryLeft = -1;
    private int batteryRight = -1;
    private int leftReconnectAttempts = 0;
    private int rightReconnectAttempts = 0;
    private int reconnectAttempts = 0; // Counts the number of reconnect attempts
    private static final long BASE_RECONNECT_DELAY_MS = 3000; // Start with 3 seconds
    private static final long MAX_RECONNECT_DELAY_MS = 60000;

    // heartbeat sender
    private Handler heartbeatHandler = new Handler();
    private Handler findCompatibleDevicesHandler;
    private boolean isScanningForCompatibleDevices = false;
    private boolean isScanning = false;

    private Runnable heartbeatRunnable;

    // mic heartbeat turn on
    private Handler micBeatHandler = new Handler();
    private Runnable micBeatRunnable;

    // white list sender
    private Handler whiteListHandler = new Handler();
    private boolean whiteListedAlready = false;

    // mic enable Handler
    private Handler micEnableHandler = new Handler();
    private boolean isMicrophoneEnabled = false; // Track current microphone state

    // notification period sender
    private Handler notificationHandler = new Handler();
    private Runnable notificationRunnable;
    private boolean notifysStarted = false;
    private int notificationNum = 10;

    // text wall periodic sender
    private Handler textWallHandler = new Handler();
    private Runnable textWallRunnable;
    private boolean textWallsStarted = false;
    private int textWallNum = 10;

    // pairing logic
    private boolean isLeftPairing = false;
    private boolean isRightPairing = false;
    private boolean isLeftBonded = false;
    private boolean isRightBonded = false;
    private BluetoothDevice leftDevice = null;
    private BluetoothDevice rightDevice = null;
    private String leftDeviceName = null;  // Store name separately since BluetoothDevice.getName() can become null
    private String rightDeviceName = null; // Store name separately since BluetoothDevice.getName() can become null
    private String preferredG1Id = null;
    private String pendingSavedG1LeftName = null;
    private String pendingSavedG1RightName = null;
    private String savedG1LeftName = null;
    private String savedG1RightName = null;
    private String preferredG1DeviceId = null;

    // handler to turn off screen
    // Handler goHomeHandler;
    // Runnable goHomeRunnable;

    // Retry handler
    Handler retryBondHandler;
    private static final long BOND_RETRY_DELAY_MS = 5000; // 5-second backoff

    // remember when we connected
    private long lastConnectionTimestamp = 0;

    private static final long CONNECTION_TIMEOUT_MS = 10000; // 10 seconds

    // Handlers for connection timeouts
    private final Handler leftConnectionTimeoutHandler = new Handler(Looper.getMainLooper());
    private final Handler rightConnectionTimeoutHandler = new Handler(Looper.getMainLooper());

    // Runnable tasks for handling timeouts
    private Runnable leftConnectionTimeoutRunnable;
    private Runnable rightConnectionTimeoutRunnable;
    private boolean isBondingReceiverRegistered = false;
    private boolean shouldUseGlassesMic;
    private boolean lastThingDisplayedWasAnImage = false;

    // Serial number and style/color information
    public String glassesSerialNumber = "";
    public String glassesStyle = "";
    public String glassesColor = "";

    // lock writing until the last write is successful
    // fonts in G1
    G1Text g1Text;

    private static final long DEBOUNCE_DELAY_MS = 270; // Minimum time between chunk sends
    private volatile long lastSendTimestamp = 0;
    private long lc3DecoderPtr = 0;

    public G1() {
        super();
        this.type = DeviceTypes.G1;
        this.hasMic = true;  // G1 has a built-in microphone
        this.micEnabled = false;
        Bridge.log("G1: G1 constructor");
        this.context = Bridge.getContext();
        loadPairedDeviceNames();
        // goHomeHandler = new Handler();
        // this.smartGlassesDevice = smartGlassesDevice;
        preferredG1DeviceId = CoreManager.getInstance().getDeviceName();
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        this.shouldUseGlassesMic = false;

        // Initialize bitmap executor for parallel operations
        if (USE_PARALLEL_BITMAP_WRITES) {
            bitmapExecutor = Executors.newFixedThreadPool(2);
        }

        // setup LC3 decoder
        if (lc3DecoderPtr == 0) {
            lc3DecoderPtr = Lc3Cpp.initDecoder();
        }

        // setup fonts
        g1Text = new G1Text();
        caseRemoved = true;
    }

    private final BluetoothGattCallback leftGattCallback = createGattCallback("Left");
    private final BluetoothGattCallback rightGattCallback = createGattCallback("Right");

    private BluetoothGattCallback createGattCallback(String side) {
        return new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                // Bridge.log("G1: ConnectionStateChanged");
                // Cancel the connection timeout
                if ("Left".equals(side) && leftConnectionTimeoutRunnable != null) {
                    leftConnectionTimeoutHandler.removeCallbacks(leftConnectionTimeoutRunnable);
                    leftConnectionTimeoutRunnable = null;
                } else if ("Right".equals(side) && rightConnectionTimeoutRunnable != null) {
                    rightConnectionTimeoutHandler.removeCallbacks(rightConnectionTimeoutRunnable);
                    rightConnectionTimeoutRunnable = null;
                }

                if (status == BluetoothGatt.GATT_SUCCESS) {

                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Bridge.log("G1: " + side + " glass connected, discovering services...");
                        if ("Left".equals(side)) {
                            isLeftConnected = true;
                            leftReconnectAttempts = 0;
                        } else {
                            isRightConnected = true;
                            rightReconnectAttempts = 0;
                        }

                        if (isLeftConnected && isRightConnected) {
                            stopScan();
                            Bridge.log("G1: Both glasses connected. Stopping BLE scan.");
                        }

                        Bridge.log("G1: Discover services calling...");
                        gatt.discoverServices();
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        Bridge.log("G1: Glass disconnected, stopping heartbeats");
                        Bridge.log("G1: Entering STATE_DISCONNECTED branch for side: " + side);

                        // Mark both sides as not ready (you could also clear both if one disconnects)
                        leftServicesWaiter.setTrue();
                        rightServicesWaiter.setTrue();
                        Bridge.log("G1: Set leftServicesWaiter and rightServicesWaiter to true.");

                        forceSideDisconnection();
                        Bridge.log("G1: Called forceSideDisconnection().");

                        // Stop any periodic transmissions
                        stopHeartbeat();
                        stopMicBeat();
                        sendQueue.clear();
                        Bridge.log("G1: Stopped heartbeat and mic beat; cleared sendQueue.");

                        updateConnectionState();
                        Bridge.log("G1: Updated connection state after disconnection.");

                        // Compute reconnection delay for both sides (here you could choose the maximum
                        // of the two delays or a new delay)
                        // long delayLeft = Math.min(BASE_RECONNECT_DELAY_MS * (1L <<
                        // leftReconnectAttempts), MAX_RECONNECT_DELAY_MS);
                        // long delayRight = Math.min(BASE_RECONNECT_DELAY_MS * (1L <<
                        // rightReconnectAttempts), MAX_RECONNECT_DELAY_MS);
                        long delay = 2000; // or choose another strategy
                        // Bridge.log("G1: Computed delayLeft: " + delayLeft + " ms, delayRight: " +
                        // delayRight + " ms. Using delay: " + delay + " ms.");

                        Bridge.log("G1: " +
                                side + " glass disconnected. Scheduling reconnection for both glasses in " + delay
                                        + " ms (Left attempts: " + leftReconnectAttempts + ", Right attempts: "
                                        + rightReconnectAttempts + ")");

                        // if (gatt.getDevice() != null) {
                        // // Close the current gatt connection
                        // Bridge.log("G1: Closing GATT connection for device: " +
                        // gatt.getDevice().getAddress());
                        // gatt.disconnect();
                        // gatt.close();
                        // Bridge.log("G1: GATT connection closed.");
                        // } else {
                        // Bridge.log("G1: No GATT device available to disconnect.");
                        // }

                        // Schedule a reconnection for both devices after the delay
                        reconnectHandler.postDelayed(() -> {
                            Bridge.log("G1: Reconnect handler triggered after delay.");
                            if (gatt.getDevice() != null && !isKilled) {
                                Bridge.log("G1: Reconnecting to both glasses. isKilled = " + isKilled);
                                // Assuming you have stored references to both devices:
                                if (leftDevice != null) {
                                    Bridge.log("G1: Attempting to reconnect to leftDevice: " + leftDevice.getAddress());
                                    reconnectToGatt(leftDevice);
                                } else {
                                    Bridge.log("G1: Left device reference is null.");
                                }
                                if (rightDevice != null) {
                                    Bridge.log("G1: Attempting to reconnect to rightDevice: " + rightDevice.getAddress());
                                    reconnectToGatt(rightDevice);
                                } else {
                                    Bridge.log("G1: Right device reference is null.");
                                }
                            } else {
                                Bridge.log("G1: Reconnect handler aborted: either no GATT device or system is killed.");
                            }
                        }, delay);
                    }
                } else {
                    Log.e(TAG, "Unexpected connection state encountered for " + side + " glass: " + newState);
                    stopHeartbeat();
                    stopMicBeat();
                    sendQueue.clear();

                    // Mark both sides as not ready (you could also clear both if one disconnects)
                    leftServicesWaiter.setTrue();
                    rightServicesWaiter.setTrue();

                    Bridge.log("G1: Stopped heartbeat and mic beat; cleared sendQueue due to connection failure.");

                    Log.e(TAG, side + " glass connection failed with status: " + status);
                    if ("Left".equals(side)) {
                        isLeftConnected = false;
                        leftReconnectAttempts++;
                        if (leftGlassGatt != null) {
                            leftGlassGatt.disconnect();
                            leftGlassGatt.close();
                        }
                        leftGlassGatt = null;
                    } else {
                        isRightConnected = false;
                        rightReconnectAttempts++;
                        if (rightGlassGatt != null) {
                            rightGlassGatt.disconnect();
                            rightGlassGatt.close();
                        }
                        rightGlassGatt = null;
                    }

                    forceSideDisconnection();
                    Bridge.log("G1: Called forceSideDisconnection() after connection failure.");

                    // gatt.disconnect();
                    // gatt.close();
                    Bridge.log("G1: GATT connection disconnected and closed due to failure.");

                    connectHandler.postDelayed(() -> {
                        Bridge.log("G1: Attempting GATT connection for leftDevice immediately.");
                        attemptGattConnection(leftDevice);
                    }, 0);

                    connectHandler.postDelayed(() -> {
                        Bridge.log("G1: Attempting GATT connection for rightDevice after 2000 ms delay.");
                        attemptGattConnection(rightDevice);
                    }, 400);
                }
            }

            private void forceSideDisconnection() {
                Bridge.log("G1: forceSideDisconnection() called for side: " + side);
                // Force disconnection from the other side if necessary
                if ("Left".equals(side)) {
                    isLeftConnected = false;
                    leftReconnectAttempts++;
                    Bridge.log("G1: Left glass: Marked as disconnected and incremented leftReconnectAttempts to "
                            + leftReconnectAttempts);
                    if (leftGlassGatt != null) {
                        Bridge.log("G1: Left glass GATT exists. Disconnecting and closing leftGlassGatt.");
                        leftGlassGatt.disconnect();
                        leftGlassGatt.close();
                        leftGlassGatt = null;
                    } else {
                        Bridge.log("G1: Left glass GATT is already null.");
                    }
                    // If right is still connected, disconnect it too
                    if (rightGlassGatt != null) {
                        Bridge.log("G1: Left glass disconnected - forcing disconnection from right glass.");
                        rightGlassGatt.disconnect();
                        rightGlassGatt.close();
                        rightGlassGatt = null;
                        isRightConnected = false;
                        rightReconnectAttempts++;
                        Bridge.log("G1: Right glass marked as disconnected and rightReconnectAttempts incremented to "
                                + rightReconnectAttempts);
                    } else {
                        Bridge.log("G1: Right glass GATT already null, no action taken.");
                    }
                } else { // side equals "Right"
                    isRightConnected = false;
                    rightReconnectAttempts++;
                    Bridge.log("G1: Right glass: Marked as disconnected and incremented rightReconnectAttempts to "
                            + rightReconnectAttempts);
                    if (rightGlassGatt != null) {
                        Bridge.log("G1: Right glass GATT exists. Disconnecting and closing rightGlassGatt.");
                        rightGlassGatt.disconnect();
                        rightGlassGatt.close();
                        rightGlassGatt = null;
                    } else {
                        Bridge.log("G1: Right glass GATT is already null.");
                    }
                    // If left is still connected, disconnect it too
                    if (leftGlassGatt != null) {
                        Bridge.log("G1: Right glass disconnected - forcing disconnection from left glass.");
                        leftGlassGatt.disconnect();
                        leftGlassGatt.close();
                        leftGlassGatt = null;
                        isLeftConnected = false;
                        leftReconnectAttempts++;
                        Bridge.log("G1: Left glass marked as disconnected and leftReconnectAttempts incremented to "
                                + leftReconnectAttempts);
                    } else {
                        Bridge.log("G1: Left glass GATT already null, no action taken.");
                    }
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    new Handler(Looper.getMainLooper()).post(() -> initG1s(gatt, side));
                }
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic,
                    int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // Bridge.log("G1: PROC_QUEUE - " + side + " glass write successful");
                } else {
                    Bridge.log("G1: " + side + " glass write failed with status: " + status);

                    if (status == 133) {
                        Bridge.log("G1: GOT THAT 133 STATUS!");

                    }
                }

                // clear the waiter
                if ("Left".equals(side)) {
                    leftWaiter.setFalse();
                } else {
                    rightWaiter.setFalse();
                }
            }

            @Override
            public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
                Bridge.log("G1: PROC - GOT DESCRIPTOR WRITE: " + status);

                // clear the waiter
                if ("Left".equals(side)) {
                    leftServicesWaiter.setFalse();
                } else {
                    rightServicesWaiter.setFalse();
                }
            }

            @Override
            public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                characteristicHandler.post(() -> {
                    if (characteristic.getUuid().equals(UART_RX_CHAR_UUID)) {
                        byte[] data = characteristic.getValue();
                        String deviceName = gatt.getDevice().getName();
                        if (deviceName == null)
                            return;

                        // Handle MIC audio data
                        if (data.length > 0 && (data[0] & 0xFF) == 0xF1) {
                            // Bridge.log("G1: Lc3 Audio data received. Data: " + Arrays.toString(data) + ",
                            // from: " + deviceName);
                            int seq = data[1] & 0xFF; // Sequence number
                            // eg. LC3 to PCM
                            byte[] lc3 = Arrays.copyOfRange(data, 2, 202);
                            // byte[] pcmData = L3cCpp.decodeLC3(lc3);
                            // if (pcmData == null) {
                            // throw new IllegalStateException("Failed to decode LC3 data");
                            // }

                            if (deviceName.contains("R_")) {
                                // decode the LC3 audio
                                if (lc3DecoderPtr != 0) {
                                    byte[] pcmData = Lc3Cpp.decodeLC3(lc3DecoderPtr, lc3);
                                    // send the PCM out
                                    if (shouldUseGlassesMic) {
                                        if (pcmData != null && pcmData.length > 0) {
                                            // audioProcessingCallback.onAudioDataAvailable(pcmData);
                                            CoreManager.getInstance().handlePcm(pcmData);
                                        }
                                    }

                                    // if (shouldUseGlassesMic) { TODO: add this back if needed
                                    // EventBus.getDefault().post(new AudioChunkNewEvent(pcmData));
                                    // } else {
                                    // Log.e(TAG, "Failed to decode LC3 frame, got null or empty result");
                                    // }
                                }

                                // send through the LC3
                                // audioProcessingCallback.onLC3AudioDataAvailable(lc3);
                                // CoreManager.getInstance().handleGlassesMicData(lc3);

                            } else {
                                // Bridge.log("G1: Lc3 Audio data received. Seq: " + seq + ", Data: " +
                                // Arrays.toString(lc3) + ", from: " + deviceName);
                            }
                        }
                        // HEAD UP MOVEMENTS
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x02) {
                            // Only check head movements from the right sensor
                            if (deviceName.contains("R_")) {
                                // Check for head down movement - initial F5 02 signal
                                Bridge.log("G1: HEAD UP MOVEMENT DETECTED");
                                CoreManager.getInstance().updateHeadUp(true);
                            }
                        }
                        // HEAD DOWN MOVEMENTS
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x03) {
                            if (deviceName.contains("R_")) {
                            Bridge.log("G1: HEAD DOWN MOVEMENT DETECTED");
                                // clearBmpDisplay();
                                CoreManager.getInstance().updateHeadUp(false);
                            }
                        }
                        // DOUBLE TAP
                        // appears to be completely broken - clears the screen - we should not tell
                        // people to use the touchpads yet til this is fixed
                        // else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && ((data[1] & 0xFF) ==
                        // 0x20) || ((data[1] & 0xFF) == 0x00)) {
                        // boolean isRight = deviceName.contains("R_");
                        // Bridge.log("G1: GOT DOUBLE TAP from isRight?: " + isRight);
                        // EventBus.getDefault().post(new GlassesTapOutputEvent(2, isRight,
                        // System.currentTimeMillis()));
                        // }
                        // BATTERY RESPONSE
                        else if (data.length > 2 && data[0] == 0x2C && data[1] == 0x66) {
                            if (deviceName.contains("L_")) {
                                // Bridge.log("G1: LEFT Battery response received");
                                batteryLeft = data[2];
                            } else if (deviceName.contains("R_")) {
                                // Bridge.log("G1: RIGHT Battery response received");
                                batteryRight = data[2];
                            }

                            if (batteryLeft != -1 && batteryRight != -1) {
                                int minBatt = Math.min(batteryLeft, batteryRight);
                                // Bridge.log("G1: Minimum Battery Level: " + minBatt);
                                // EventBus.getDefault().post(new BatteryLevelEvent(minBatt, false));
                                batteryLevel = minBatt;
                                CoreManager.getInstance().handle_request_status();
                            }
                        }
                        // CASE REMOVED
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5
                                && ((data[1] & 0xFF) == 0x07 || (data[1] & 0xFF) == 0x06)) {
                            caseRemoved = true;
                            Bridge.log("G1: CASE REMOVED");
                            CoreManager.getInstance().handle_request_status();
                        }
                        // CASE OPEN
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x08) {
                            caseOpen = true;
                            caseRemoved = false;
                            // EventBus.getDefault()
                                    // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                            CoreManager.getInstance().handle_request_status();
                        }
                        // CASE CLOSED
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x0B) {
                            caseOpen = false;
                            caseRemoved = false;
                            // EventBus.getDefault()
                                    // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                            CoreManager.getInstance().handle_request_status();
                        }
                        // CASE CHARGING STATUS
                        else if (data.length > 3 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x0E) {
                            caseCharging = (data[2] & 0xFF) == 0x01;// TODO: verify this is correct
                            // EventBus.getDefault()
                                    // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                            CoreManager.getInstance().handle_request_status();
                        }
                        // CASE CHARGING INFO
                        else if (data.length > 3 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x0F) {
                            caseBatteryLevel = (data[2] & 0xFF);// TODO: verify this is correct
                            // EventBus.getDefault()
                                    // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                            CoreManager.getInstance().handle_request_status();
                        }
                        // HEARTBEAT RESPONSE
                        else if (data.length > 0 && data[0] == 0x25) {
                            Bridge.log("G1: Heartbeat response received");
                        }
                        // TEXT RESPONSE
                        else if (data.length > 0 && data[0] == 0x4E) {
                            // Bridge.log("G1: Text response on side " + (deviceName.contains("L_") ? "Left" : "Right")
                                    // + " was: " + ((data.length > 1 && (data[1] & 0xFF) == 0xC9) ? "SUCCEED" : "FAIL"));
                        }

                        // Handle other non-audio responses
                        else {
                            // Bridge.log("G1: PROC - Received other Even Realities response: " + bytesToHex(data) + ", from: "
                                    // + deviceName);
                        }

                        // clear the waiter
                        // if ((data.length > 1 && (data[1] & 0xFF) == 0xC9)){
                        // if (deviceName.contains("L_")) {
                        // Bridge.log("G1: PROC - clearing LEFT waiter on success");
                        // leftWaiter.setFalse();
                        // } else {
                        // Bridge.log("G1: PROC - clearing RIGHT waiter on success");
                        // rightWaiter.setFalse();
                        // }
                        // }
                    }
                });
            }

        };
    }

    private void initG1s(BluetoothGatt gatt, String side) {
        gatt.requestMtu(251); // Request a higher MTU size
        Bridge.log("G1: Requested MTU size: 251");

        BluetoothGattService uartService = gatt.getService(UART_SERVICE_UUID);

        if (uartService != null) {
            BluetoothGattCharacteristic txChar = uartService.getCharacteristic(UART_TX_CHAR_UUID);
            BluetoothGattCharacteristic rxChar = uartService.getCharacteristic(UART_RX_CHAR_UUID);

            if (txChar != null) {
                if ("Left".equals(side))
                    leftTxChar = txChar;
                else
                    rightTxChar = txChar;
                // enableNotification(gatt, txChar, side);
                // txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Bridge.log("G1: " + side + " glass TX characteristic found");
            }

            if (rxChar != null) {
                if ("Left".equals(side))
                    leftRxChar = rxChar;
                else
                    rightRxChar = rxChar;
                enableNotification(gatt, rxChar, side);
                // rxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Bridge.log("G1: " + side + " glass RX characteristic found");
            }

            // Mark as connected but wait for setup below to update connection state
            if ("Left".equals(side)) {
                isLeftConnected = true;
                Bridge.log("G1: PROC_QUEUE - left side setup complete");

                // Manufacturer data decoding moved to connection start
            } else {
                isRightConnected = true;
                // Bridge.log("G1: PROC_QUEUE - right side setup complete");
            }

            // setup the G1s
            if (isLeftConnected && isRightConnected) {
                Bridge.log("G1: Sending firmware request Command");
                sendDataSequentially(new byte[] { (byte) 0x6E, (byte) 0x74 });

                Bridge.log("G1: Sending init 0x4D Command");
                sendDataSequentially(new byte[] { (byte) 0x4D, (byte) 0xFB }); // told this is only left

                Bridge.log("G1: Sending turn off wear detection command");
                sendDataSequentially(new byte[] { (byte) 0x27, (byte) 0x00 });

                Bridge.log("G1: Sending turn off silent mode Command");
                sendDataSequentially(new byte[] { (byte) 0x03, (byte) 0x0A });

                // debug command
                // Bridge.log("G1: Sending debug 0xF4 Command");
                // sendDataSequentially(new byte[]{(byte) 0xF4, (byte) 0x01});

                // no longer need to be staggered as we fixed the sender
                // do first battery status query
                queryBatteryStatusHandler.postDelayed(() -> queryBatteryStatus(), 10);

                // setup brightness
                int brightnessValue = CoreManager.getInstance().getBrightness();
                Boolean shouldUseAutoBrightness = CoreManager.getInstance().getAutoBrightness();
                sendBrightnessCommandHandler
                        .postDelayed(() -> sendBrightnessCommand(brightnessValue, shouldUseAutoBrightness), 10);

                // Maybe start MIC streaming
                sendSetMicEnabled(false, 10); // Disable the MIC

                // enable our AugmentOS notification key
                sendWhiteListCommand(10);

                // start heartbeat
                startHeartbeat(10000);

                // start mic beat
                // startMicBeat(30000);

                showHomeScreen(); // turn on the g1 display

                updateConnectionState();

                // start sending debug notifications
                // startPeriodicNotifications(302);
                // start sending debug notifications
                // startPeriodicTextWall(302);
            }
        } else {
            Bridge.log("G1: " + side + " glass UART service not found");
        }
    }

    // working on all phones - must keep the delay
    private void enableNotification(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, String side) {
        Bridge.log("G1: PROC_QUEUE - Starting notification setup for " + side);

        // Simply enable notifications
        Bridge.log("G1: PROC_QUEUE - setting characteristic notification on side: " + side);
        boolean result = gatt.setCharacteristicNotification(characteristic, true);
        Bridge.log("G1: PROC_QUEUE - setCharacteristicNotification result for " + side + ": " + result);

        // Set write type for the characteristic
        characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        Bridge.log("G1: PROC_QUEUE - write type set for " + side);

        // wait
        Bridge.log("G1: PROC_QUEUE - waiting to enable it on this side: " + side);

        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Bridge.log("G1: Error sending data: " + e.getMessage());
        }

        Bridge.log("G1: PROC_QUEUE - get descriptor on side: " + side);
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID);
        if (descriptor != null) {
            Bridge.log("G1: PROC_QUEUE - setting descriptor on side: " + side);
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            boolean r_result = gatt.writeDescriptor(descriptor);
            Bridge.log("G1: PROC_QUEUE - set descriptor on side: " + side + " with result: " + r_result);
        }
    }

    private void updateConnectionState() {
        Boolean previousReady = ready;
        if (isLeftConnected && isRightConnected) {
            connectionState = SmartGlassesConnectionState.CONNECTED;
            Bridge.log("G1: Both glasses connected");
            lastConnectionTimestamp = System.currentTimeMillis();
            ready = true;
        } else if (isLeftConnected || isRightConnected) {
            connectionState = SmartGlassesConnectionState.CONNECTING;
            Bridge.log("G1: One glass connected");
            ready = false;
        } else {
            connectionState = SmartGlassesConnectionState.DISCONNECTED;
            Bridge.log("G1: No glasses connected");
            ready = false;
        }
        if (previousReady != ready) {
            CoreManager.getInstance().handleConnectionStateChanged();
        }
    }

    private final BroadcastReceiver bondingReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);

                // Use device address to match with stored devices instead of relying on getName()
                // which can be null in the bonding broadcast
                String deviceAddress = device.getAddress();
                boolean isLeft = false;
                boolean isRight = false;
                String deviceName = device.getName();

                // Match by address with stored left/right devices from scanning
                if (leftDevice != null && leftDevice.getAddress().equals(deviceAddress)) {
                    isLeft = true;
                    // Use stored name string (more reliable than BluetoothDevice.getName())
                    if (deviceName == null) {
                        deviceName = leftDeviceName;
                    }
                } else if (rightDevice != null && rightDevice.getAddress().equals(deviceAddress)) {
                    isRight = true;
                    // Use stored name string (more reliable than BluetoothDevice.getName())
                    if (deviceName == null) {
                        deviceName = rightDeviceName;
                    }
                }

                // If we couldn't match this device, it's not one we're pairing with
                if (!isLeft && !isRight) {
                    Bridge.log("G1: Bond state changed for unknown device: " + deviceAddress);
                    return;
                }

                // If name is still null after checking stored devices, log and return
                if (deviceName == null) {
                    Bridge.log("G1: Could not determine device name for address: " + deviceAddress);
                    return;
                }

                int bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);

                if (bondState == BluetoothDevice.BOND_BONDED) {
                    Bridge.log("G1: Bonded with device: " + deviceName + " (address: " + deviceAddress + ")");
                    if (isLeft) {
                        isLeftBonded = true;
                        isLeftPairing = false;
                        pendingSavedG1LeftName = deviceName;
                    } else if (isRight) {
                        isRightBonded = true;
                        isRightPairing = false;
                        pendingSavedG1RightName = deviceName;
                    }

                    // Reset both pairing flags when a device bonds successfully
                    // This prevents the other device from being blocked when scan restarts
                    isLeftPairing = false;
                    isRightPairing = false;

                    // Restart scan for the next device
                    if (!isLeftBonded || !isRightBonded) {
                        // if (!(isLeftBonded && !isRightBonded)){// || !doPendingPairingIdsMatch()) {
                            Bridge.log("G1: Restarting scan to find remaining device...");
                        // Add delay for vendor-specific timing issues (e.g., Motorola devices)
                        new Handler(Looper.getMainLooper()).postDelayed(() -> {
                            startScan();
                        }, 500); // 500ms delay
                    } else if (isLeftBonded && isRightBonded && !doPendingPairingIdsMatch()) {
                        // We've connected to two different G1s...
                        // Let's unpair the right, try to pair to a different one
                        isRightBonded = false;
                        isRightConnected = false;
                        isRightPairing = false;
                        pendingSavedG1RightName = null;
                        Bridge.log("G1: Connected to two different G1s - retry right G1 arm");
                    } else {
                        Bridge.log("G1: Both devices bonded. Proceeding with connections...");
                        savedG1LeftName = pendingSavedG1LeftName;
                        savedG1RightName = pendingSavedG1RightName;
                        savePairedDeviceNames();
                        stopScan();

                        connectHandler.postDelayed(() -> {
                            connectToGatt(leftDevice);
                        }, 0);

                        connectHandler.postDelayed(() -> {
                            connectToGatt(rightDevice);
                        }, 2000);
                    }
                } else if (bondState == BluetoothDevice.BOND_NONE) {
                    Bridge.log("G1: Bonding failed for device: " + deviceName + " (address: " + deviceAddress + ")");
                    if (isLeft)
                        isLeftPairing = false;
                    if (isRight)
                        isRightPairing = false;

                    // Restart scanning to retry bonding
                    if (retryBondHandler == null) {
                        retryBondHandler = new Handler(Looper.getMainLooper());
                    }

                    retryBondHandler.postDelayed(() -> {
                        Bridge.log("G1: Retrying scan after bond failure...");
                        startScan();
                    }, BOND_RETRY_DELAY_MS);
                }
            }
        }
    };

    public boolean doPendingPairingIdsMatch() {
        String leftId = parsePairingIdFromDeviceName(pendingSavedG1LeftName);
        String rightId = parsePairingIdFromDeviceName(pendingSavedG1RightName);
        Bridge.log("G1: LeftID: " + leftId);
        Bridge.log("G1: RightID: " + rightId);

        // ok, HACKY, but if one of them is null, that means that we connected to the
        // other on a previous connect
        // this whole function shouldn't matter anymore anyway as we properly filter for
        // the device name, so it should be fine
        // in the future, the way to actually check this would be to check the final ID
        // string, which is the only one guaranteed to be unique
        if (leftId == null || rightId == null) {
            return true;
        }

        return leftId != null && leftId.equals(rightId);
    }

    public String parsePairingIdFromDeviceName(String input) {
        if (input == null || input.isEmpty())
            return null;
        // Regular expression to match the number after "G1_"
        Pattern pattern = Pattern.compile("G1_(\\d+)_");
        Matcher matcher = pattern.matcher(input);

        if (matcher.find()) {
            return matcher.group(1); // Group 1 contains the number
        }
        return null; // Return null if no match is found
    }

    public static void savePreferredG1DeviceId(Context context, String deviceName) {
        Bridge.saveSetting("deviceName", deviceName);
    }

    private void savePairedDeviceNames() {
        // if (savedG1LeftName != null && savedG1RightName != null) {
        // context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
        // .edit()
        // .putString(LEFT_DEVICE_KEY, savedG1LeftName)
        // .putString(RIGHT_DEVICE_KEY, savedG1RightName)
        // .apply();
        // Bridge.log("G1: Saved paired device names: Left=" + savedG1LeftName + ", Right="
        // + savedG1RightName);
        // }
    }

    private void loadPairedDeviceNames() {
        // SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME,
        // Context.MODE_PRIVATE);
        // savedG1LeftName = prefs.getString(LEFT_DEVICE_KEY, null);
        // savedG1RightName = prefs.getString(RIGHT_DEVICE_KEY, null);
        // Bridge.log("G1: Loaded paired device names: Left=" + savedG1LeftName + ", Right="
        // + savedG1RightName);
    }

    public static void deleteEvenSharedPreferences(Context context) {
        // savePreferredG1DeviceId(context, null);
        // SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME,
        // Context.MODE_PRIVATE);
        // prefs.edit().clear().apply();
        // Bridge.log("G1: Nuked EvenRealities SharedPreferences");
    }

    private void connectToGatt(BluetoothDevice device) {
        if (device == null) {
            Bridge.log("G1: Cannot connect to GATT: device is null");
            return;
        }

        Bridge.log("G1: connectToGatt called for device: " + device.getName() + " (" + device.getAddress() + ")");
        BluetoothAdapter bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            Bridge.log("G1: Bluetooth is disabled or not available. Cannot reconnect to glasses.");
            return;
        }

        // Reset the services waiter based on device name
        if (device.getName().contains("_L_")) {
            Bridge.log("G1: Device identified as left side. Resetting leftServicesWaiter.");
            leftServicesWaiter.setTrue();
        } else {
            Bridge.log("G1: Device identified as right side. Resetting rightServicesWaiter.");
            rightServicesWaiter.setTrue();
        }

        // Establish GATT connection based on device name and current connection state
        if (device.getName().contains("_L_") && leftGlassGatt == null) {
                    Bridge.log("G1: Connecting GATT to left side.");
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback);
            isLeftConnected = false; // Reset connection state
            Bridge.log("G1: Left GATT connection initiated. isLeftConnected set to false.");
        } else if (device.getName().contains("_R_") && rightGlassGatt == null && isLeftConnected) {
            Bridge.log("G1: Connecting GATT to right side.");
            rightGlassGatt = device.connectGatt(context, false, rightGattCallback);
            isRightConnected = false; // Reset connection state
            Bridge.log("G1: Right GATT connection initiated. isRightConnected set to false.");
        } else {
            Bridge.log("G1: Tried to connect to incorrect or already connected device: " + device.getName());
        }
    }

    private void reconnectToGatt(BluetoothDevice device) {
        if (isKilled) {
            return;
        }
        connectToGatt(device); // Reuse the connectToGatt method
    }

    // private void startConnectionTimeout(String side, BluetoothGatt gatt) {
    // Runnable timeoutRunnable = () -> {
    // if ("Left".equals(side)) {
    // if (!isLeftConnected) {
    // Bridge.log("G1: Left connection timed out. Closing GATT and retrying...");
    // if (leftGlassGatt != null) {
    // leftGlassGatt.disconnect();
    // leftGlassGatt.close();
    // leftGlassGatt = null;
    // }
    // leftReconnectAttempts++;
    // scheduleReconnect("Left", gatt.getDevice());
    // }
    // } else if ("Right".equals(side)) {
    // if (!isRightConnected) {
    // Bridge.log("G1: Right connection timed out. Closing GATT and retrying...");
    // if (rightGlassGatt != null) {
    // rightGlassGatt.disconnect();
    // rightGlassGatt.close();
    // rightGlassGatt = null;
    // }
    // rightReconnectAttempts++;
    // scheduleReconnect("Right", gatt.getDevice());
    // }
    // }
    // };
    //
    // if ("Left".equals(side)) {
    // leftConnectionTimeoutRunnable = timeoutRunnable;
    // leftConnectionTimeoutHandler.postDelayed(leftConnectionTimeoutRunnable,
    // CONNECTION_TIMEOUT_MS);
    // } else if ("Right".equals(side)) {
    // rightConnectionTimeoutRunnable = timeoutRunnable;
    // rightConnectionTimeoutHandler.postDelayed(rightConnectionTimeoutRunnable,
    // CONNECTION_TIMEOUT_MS);
    // }
    // }

    // private void scheduleReconnect(String side, BluetoothDevice device) {
    // long delay;
    // if ("Left".equals(side)) {
    // delay = Math.min(BASE_RECONNECT_DELAY_MS * (1L << leftReconnectAttempts),
    // MAX_RECONNECT_DELAY_MS);
    // Bridge.log(TAG, side + " glass reconnecting in " + delay + " ms (Attempt " +
    // leftReconnectAttempts + ")");
    // } else { // "Right"
    // delay = Math.min(BASE_RECONNECT_DELAY_MS * (1L << rightReconnectAttempts),
    // MAX_RECONNECT_DELAY_MS);
    // Bridge.log(TAG, side + " glass reconnecting in " + delay + " ms (Attempt " +
    // rightReconnectAttempts + ")");
    // }
    //
    // reconnectHandler.postDelayed(() -> reconnectToGatt(device), delay);
    // }

    private Set<String> seenDevices = new HashSet<>();

    private final ScanCallback modernScanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String name = device.getName();

            // Now you can reference the bluetoothAdapter field if needed:
            if (!bluetoothAdapter.isEnabled()) {
                Bridge.log("G1: Bluetooth is disabled");
                return;
            }

            // Check if G1 arm
            if (name == null || !name.contains("Even G1_")) {
                return;
            }

            // Log all available device information for debugging
            // Bridge.log("G1: === Device Information ===");
            // Bridge.log("G1: Device Name: " + name);
            // Bridge.log("G1: Device Address: " + device.getAddress());
            // Bridge.log("G1: Device Type: " + device.getType());
            // Bridge.log("G1: Device Class: " + device.getBluetoothClass());
            // Bridge.log("G1: Bond State: " + device.getBondState());

            // Try to get additional device information using reflection
            try {
                // Try to get the full device name (might contain serial number)
                Method getAliasMethod = device.getClass().getMethod("getAlias");
                String alias = (String) getAliasMethod.invoke(device);
                // add alias to seen device set:
                if (!seenDevices.contains(alias)) {
                    seenDevices.add(alias);
                } else {
                    return;
                }
                Bridge.log("G1: Device Alias: " + alias);
            } catch (Exception e) {
                Bridge.log("G1: Could not get device alias: " + e.getMessage());
            }

            // Capture manufacturer data for left device during scanning
            if (name != null && name.contains("_L_") && result.getScanRecord() != null) {
                SparseArray<byte[]> allManufacturerData = result.getScanRecord().getManufacturerSpecificData();
                for (int i = 0; i < allManufacturerData.size(); i++) {
                    String parsedDeviceName = parsePairingIdFromDeviceName(name);
                    if (parsedDeviceName != null) {
                        // Bridge.log("G1: Parsed Device Name: " + parsedDeviceName);
                    }

                    int manufacturerId = allManufacturerData.keyAt(i);
                    byte[] data = allManufacturerData.valueAt(i);
                    // Bridge.log("G1: Left Device Manufacturer ID " + manufacturerId + ": " + bytesToHex(data));

                    // Try to decode serial number from this manufacturer data
                    String decodedSerial = decodeSerialFromManufacturerData(data);
                    if (decodedSerial != null) {
                        // Bridge.log("G1: LEFT DEVICE DECODED SERIAL NUMBER from ID " + manufacturerId + ": " + decodedSerial);
                        String[] decoded = decodeEvenG1SerialNumber(decodedSerial);
                        // Bridge.log("G1: LEFT DEVICE Style: " + decoded[0] + ", Color: " + decoded[1]);

                        if (preferredG1DeviceId != null && preferredG1DeviceId.equals(parsedDeviceName)) {
                            // Store the information (matching iOS implementation)
                            glassesSerialNumber = decodedSerial;
                            glassesStyle = decoded[0];
                            glassesColor = decoded[1];

                            // Emit the serial number information to React Native
                            emitSerialNumberInfo(decodedSerial, decoded[0], decoded[1]);
                        }
                        break;
                    }
                }
            }

            // Bridge.log("G1: PREFERRED ID: " + preferredG1DeviceId);
            if (preferredG1DeviceId == null || !name.contains("_" + preferredG1DeviceId + "_")) {
                // Bridge.log("G1: NOT PAIRED GLASSES");
                return;
            }

            Bridge.log("G1: FOUND OUR PREFERRED ID: " + preferredG1DeviceId);

            boolean isLeft = name.contains("_L_");

            // // If we already have saved device names for left/right...
            // if (savedG1LeftName != null && savedG1RightName != null) {
            //     if (!(name.contains(savedG1LeftName) || name.contains(savedG1RightName))) {
            //         return; // Not a matching device
            //     }
            // }

            // Identify which side (left/right) and store both device and name
            if (isLeft) {
                leftDevice = device;
                leftDeviceName = name;  // Store name now since getName() can return null later
            } else {
                rightDevice = device;
                rightDeviceName = name;  // Store name now since getName() can return null later
            }

            int bondState = device.getBondState();
            if (bondState != BluetoothDevice.BOND_BONDED) {
                if (isLeft && !isLeftPairing && !isLeftBonded) {
                    // Stop scan before initiating bond
                    stopScan();
                    // Bridge.log("G1: Bonding with Left Glass...");
                    isLeftPairing = true;
                    connectionState = SmartGlassesConnectionState.BONDING;
                    // connectionEvent(connectionState);
                    bondDevice(device);
                } else if (!isLeft && !isRightPairing && !isRightBonded) {
                    // Stop scan before initiating bond
                    stopScan();
                    Bridge.log("G1: Attempting to bond with right device. isRightPairing=" + isRightPairing
                            + ", isRightBonded=" + isRightBonded);
                    isRightPairing = true;
                    connectionState = SmartGlassesConnectionState.BONDING;
                    // connectionEvent(connectionState);
                    bondDevice(device);
                } else {
                    Bridge.log("G1: Not running bonding - isLeft=" + isLeft + ", isLeftPairing=" + isLeftPairing +
                            ", isLeftBonded=" + isLeftBonded + ", isRightPairing=" + isRightPairing +
                            ", isRightBonded=" + isRightBonded + " - continuing scan for other side");
                }
            } else {
                // Already bonded
                if (isLeft) {
                    isLeftBonded = true;
                } else {
                    isRightBonded = true;
                }

                // Both are bonded => connect to GATT
                if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
                    Bridge.log("G1: Both sides bonded. Ready to connect to GATT.");
                    stopScan();

                    connectHandler.postDelayed(() -> {
                        attemptGattConnection(leftDevice);
                    }, 0);

                    connectHandler.postDelayed(() -> {
                        attemptGattConnection(rightDevice);
                    }, 2000);
                } else {
                    Bridge.log("G1: Not running a63dd");
                    Bridge.log("G1: leftBonded=" + isLeftBonded + ", rightBonded=" + isRightBonded);
                    Bridge.log("G1: leftDevice=" + leftDevice + ", rightDevice=" + rightDevice);
                }
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            Bridge.log("G1: Scan failed with error: " + errorCode);
        }
    };

    private void resetAllBondsAndState() {
        Bridge.log("G1: Resetting ALL bonds and internal state for complete fresh start");

        // Remove both bonds if devices exist
        if (leftDevice != null) {
            removeBond(leftDevice);
        }

        if (rightDevice != null) {
            removeBond(rightDevice);
        }

        // Reset all internal state
        isLeftBonded = false;
        isRightBonded = false;
        isLeftPairing = false;
        isRightPairing = false;
        isLeftConnected = false;
        isRightConnected = false;

        // Clear saved device names
        pendingSavedG1LeftName = null;
        pendingSavedG1RightName = null;

        // Close any existing GATT connections
        if (leftGlassGatt != null) {
            leftGlassGatt.disconnect();
            leftGlassGatt.close();
            leftGlassGatt = null;
        }

        if (rightGlassGatt != null) {
            rightGlassGatt.disconnect();
            rightGlassGatt.close();
            rightGlassGatt = null;
        }

        // Wait briefly for bond removal to complete
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            Bridge.log("G1: Restarting scan after complete bond/state reset");
            connectionState = SmartGlassesConnectionState.SCANNING;
            // connectionEvent(connectionState);
            startScan();
        }, 2000);
    }

    /**
     * Handles a device with a valid bond
     */
    private void handleValidBond(BluetoothDevice device, boolean isLeft) {
        Bridge.log("G1: Handling valid bond for " + (isLeft ? "left" : "right") + " glass");

        // Update state
        if (isLeft) {
            isLeftBonded = true;
        } else {
            isRightBonded = true;
        }

        // If both glasses are bonded, connect to GATT
        if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
            Bridge.log("G1: Both glasses have valid bonds - ready to connect to GATT");

            connectHandler.postDelayed(() -> {
                attemptGattConnection(leftDevice);
            }, 0);

            connectHandler.postDelayed(() -> {
                attemptGattConnection(rightDevice);
            }, 2000);
        } else {
            // Continue scanning for the other glass
            Bridge.log("Still need to find " + (isLeft ? "right" : "left") + " glass - resuming scan");
            startScan();
        }
    }

    /**
     * Removes an existing bond with a Bluetooth device to force fresh pairing
     */
    private boolean removeBond(BluetoothDevice device) {
        try {
            if (device == null) {
                Bridge.log("G1: Cannot remove bond: device is null");
                return false;
            }

            Method method = device.getClass().getMethod("removeBond");
            boolean result = (Boolean) method.invoke(device);
            Bridge.log("G1: Removing bond for device " + device.getName() + ", result: " + result);
            return result;
        } catch (Exception e) {
            Bridge.log("G1: Error removing bond: " + e.getMessage());
            return false;
        }
    }

    public void connectToSmartGlasses() {
        // Register bonding receiver
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        context.registerReceiver(bondingReceiver, filter);
        isBondingReceiverRegistered = true;

        preferredG1DeviceId = CoreManager.getInstance().getDeviceName();

        if (!bluetoothAdapter.isEnabled()) {
            return;
        }

        // Start scanning for devices
        connectionState = SmartGlassesConnectionState.SCANNING;
        // connectionEvent(connectionState);
        startScan();
    }

    private void startScan() {
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            Bridge.log("G1: BluetoothLeScanner not available.");
            return;
        }

        // Optionally, define filters if needed
        List<ScanFilter> filters = new ArrayList<>();
        // For example, to filter by device name:
        // filters.add(new ScanFilter.Builder().setDeviceName("Even G1_").build());

        // Set desired scan settings
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        // Start scanning
        isScanning = true;
        scanner.startScan(filters, settings, modernScanCallback);
        Bridge.log("G1: CALL START SCAN - Started scanning for devices...");

        // Ensure scanning state is immediately communicated to UI
        connectionState = SmartGlassesConnectionState.SCANNING;
        // connectionEvent(connectionState);

        // Stop the scan after some time (e.g., 10-15s instead of 60 to avoid
        // throttling)
        // handler.postDelayed(() -> stopScan(), 10000);
    }

    private void stopScan() {
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner != null) {
            scanner.stopScan(modernScanCallback);
        }
        isScanning = false;
        Bridge.log("G1: Stopped scanning for devices");
    }

    private void bondDevice(BluetoothDevice device) {
        try {
            Bridge.log("G1: Attempting to bond with device: " + device.getName());
            Method method = device.getClass().getMethod("createBond");
            method.invoke(device);
        } catch (Exception e) {
            Bridge.log("G1: Bonding failed: " + e.getMessage());
        }
    }

    private Runnable rightConnectionRetryRunnable;
    private static final long RIGHT_CONNECTION_RETRY_DELAY = 1000; // 1 second

    private void attemptGattConnection(BluetoothDevice device) {
        // if (!isKilled)

        if (device == null) {
            Bridge.log("G1: Cannot connect to GATT: Device is null");
            return;
        }

        String deviceName = device.getName();
        if (deviceName == null) {
            Bridge.log("G1: Skipping null device name: " + device.getAddress()
                    + "... this means something horriffic has occured. Look into this.");
            return;
        }

        Bridge.log("G1: attemptGattConnection called for device: " + deviceName + " (" + device.getAddress() + ")");

        // Check if both devices are bonded before attempting connection
        if (!isLeftBonded || !isRightBonded) {
            Bridge.log("G1: Cannot connect to GATT: Both devices are not bonded yet (isLeftBonded: " + isLeftBonded
                    + ", isRightBonded: " + isRightBonded + ")");
            return;
        }

        connectionState = SmartGlassesConnectionState.CONNECTING;
        Bridge.log("G1: Setting connectionState to CONNECTING. Notifying connectionEvent.");
        // connectionEvent(connectionState);

        boolean isLeftDevice = deviceName.contains("_L_");
        boolean isRightDevice = deviceName.contains("_R_");

        if (isLeftDevice) {
            connectLeftDevice(device);
        } else if (isRightDevice) {
            connectRightDevice(device);
        } else {
            Bridge.log("G1: Unknown device type: " + deviceName);
        }
    }

    private void connectLeftDevice(BluetoothDevice device) {
        if (leftGlassGatt == null) {
            Bridge.log("G1: Attempting GATT connection for Left Glass...");
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback);
            isLeftConnected = false;
            Bridge.log("G1: Left GATT connection initiated. isLeftConnected set to false.");
        } else {
            Bridge.log("G1: Left Glass GATT already exists");
        }
    }

    private void connectRightDevice(BluetoothDevice device) {
        // Only connect right after left is fully connected
        if (isLeftConnected) {
            if (rightGlassGatt == null) {
                Bridge.log("G1: Attempting GATT connection for Right Glass...");
                rightGlassGatt = device.connectGatt(context, false, rightGattCallback);
                isRightConnected = false;
                Bridge.log("G1: Right GATT connection initiated. isRightConnected set to false.");

                // Cancel any pending retry attempts since we're now connecting
                if (rightConnectionRetryRunnable != null) {
                    connectHandler.removeCallbacks(rightConnectionRetryRunnable);
                    rightConnectionRetryRunnable = null;
                }
            } else {
                Bridge.log("G1: Right Glass GATT already exists");
            }
        } else {
            Bridge.log("G1: Waiting for left glass before connecting right. Scheduling retry in "
                    + RIGHT_CONNECTION_RETRY_DELAY + "ms");

            // Cancel any existing retry attempts to avoid duplicate retries
            if (rightConnectionRetryRunnable != null) {
                connectHandler.removeCallbacks(rightConnectionRetryRunnable);
            }

            // Create new retry runnable
            rightConnectionRetryRunnable = new Runnable() {
                @Override
                public void run() {
                    if (!isKilled) {
                        Bridge.log("G1: Retrying right glass connection...");
                        attemptGattConnection(device);
                    } else {
                        Bridge.log("G1: Connection cancelled, stopping retry attempts");
                    }
                }
            };

            // Schedule retry
            connectHandler.postDelayed(rightConnectionRetryRunnable, RIGHT_CONNECTION_RETRY_DELAY);
        }
    }

    private byte[] createTextPackage(String text, int currentPage, int totalPages, int screenStatus) {
        byte[] textBytes = text.getBytes();
        ByteBuffer buffer = ByteBuffer.allocate(9 + textBytes.length);
        buffer.put((byte) 0x4E);
        buffer.put((byte) (currentSeq++ & 0xFF));
        buffer.put((byte) 1);
        buffer.put((byte) 0);
        buffer.put((byte) screenStatus);
        buffer.put((byte) 0);
        buffer.put((byte) 0);
        buffer.put((byte) currentPage);
        buffer.put((byte) totalPages);
        buffer.put(textBytes);

        return buffer.array();
    }

    private void sendDataSequentially(byte[] data) {
        sendDataSequentially(data, false);
    }

    private void sendDataSequentially(List<byte[]> data) {
        sendDataSequentially(data, false);
    }

    public void sendJson(Map<String, Object> jsonOriginal, boolean wakeUp) {

    }

    @Override
    public void requestPhoto(String requestId, String appId, String size, String webhookUrl, String authToken, String compress) {

    }

    @Override
    public void startRtmpStream(Map<String, Object> message) {

    }

    @Override
    public void stopRtmpStream() {

    }

    @Override
    public void sendRtmpKeepAlive(Map<String, Object> message) {

    }

    @Override
    public void startBufferRecording() {

    }

    @Override
    public void stopBufferRecording() {

    }

    @Override
    public void saveBufferVideo(String requestId, int durationSeconds) {

    }

    @Override
    public void startVideoRecording(String requestId, boolean save) {

    }

    @Override
    public void stopVideoRecording(String requestId) {

    }

    @Override
    public void sendButtonPhotoSettings() {

    }

    @Override
    public void sendButtonModeSetting() {

    }

    @Override
    public void sendButtonVideoRecordingSettings() {

    }

    @Override
    public void sendButtonCameraLedSetting() {

    }

    @Override
    public void sendButtonMaxRecordingTime() {

    }

    @Override
    public void setBrightness(int level, boolean autoMode) {
        Bridge.log("G1: setBrightness() - level: " + level + "%, autoMode: " + autoMode);
        sendBrightnessCommand(level, autoMode);
    }

    @Override
    public void clearDisplay() {
        Bridge.log("G1: clearDisplay() - sending space");
        sendTextWall(" ");
    }

    @Override
    public void sendTextWall(String text) {
        Bridge.log("G1: sendTextWall() - text: " + text);
        displayTextWall(text);
    }

    @Override
    public void sendDoubleTextWall(String top, String bottom) {
        Bridge.log("G1: sendDoubleTextWall() - top: " + top + ", bottom: " + bottom);
        displayDoubleTextWall(top, bottom);
    }

    @Override
    public boolean displayBitmap(String base64ImageData) {
        try {
            // Decode base64 to byte array
            byte[] bmpData = android.util.Base64.decode(base64ImageData, android.util.Base64.DEFAULT);

            if (bmpData == null || bmpData.length == 0) {
                Log.e(TAG, "Failed to decode base64 image data");
                return false;
            }

            // Call internal implementation
            displayBitmapImage(bmpData);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error displaying bitmap from base64", e);
            return false;
        }
    }

    @Override
    public void showDashboard() {
        exit();
    }

    @Override
    public void setDashboardPosition(int height, int depth) {
        Bridge.log("G1: setDashboardPosition() - height: " + height + ", depth: " + depth);
        sendDashboardPositionCommand(height, depth);
    }

    @Override
    public void setHeadUpAngle(int angle) {
        Bridge.log("G1: setHeadUpAngle() - angle: " + angle);
        sendHeadUpAngleCommand(angle);
    }

    @Override
    public void getBatteryStatus() {
        Bridge.log("G1: Requesting battery status");
        queryBatteryStatus();
    }

    @Override
    public void setSilentMode(boolean enabled) {

    }

    @Override
    public void exit() {
        sendExitCommand();
    }

    @Override
    public void sendRgbLedControl(String requestId, String packageName, String action, String color, int ontime, int offtime, int count) {
        Bridge.log("sendRgbLedControl - not supported on G1");
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported");
    }

    @Override
    public void disconnect() {
        ready = false;
        ready = false;
        destroy();
        // CoreManager.getInstance().handleConnectionStateChanged();
    }

    @Override
    public void forget() {
        ready = false;
        destroy();
        CoreManager.getInstance().handleConnectionStateChanged();
    }

    @Override
    public void connectById(String id) {
        preferredG1DeviceId = id;
        connectToSmartGlasses();
    }

    @Override
    public String getConnectedBluetoothName() {
        // Return left device name if available, otherwise right device name
        if (leftDevice != null && leftDevice.getName() != null) {
            return leftDevice.getName();
        } else if (rightDevice != null && rightDevice.getName() != null) {
            return rightDevice.getName();
        }
        return "";
    }

    @Override
    public void requestWifiScan() {

    }

    @Override
    public void sendWifiCredentials(String ssid, String password) {

    }

    @Override
    public void sendHotspotState(boolean enabled) {

    }

    @Override
    public void queryGalleryStatus() {

    }

    @Override
    public void sendGalleryMode() {
        // G1 doesn't have a built-in camera/gallery system
        Bridge.log("G1: sendGalleryModeActive - not supported on G1");
    }

    // private void sendDataSequentially(byte[] data, boolean onlyLeft) {
    // if (stopper) return;
    // stopper = true;
    //
    // new Thread(() -> {
    // try {
    // if (leftGlassGatt != null && leftTxChar != null) {
    // leftTxChar.setValue(data);
    // leftGlassGatt.writeCharacteristic(leftTxChar);
    // Thread.sleep(DELAY_BETWEEN_SENDS_MS);
    // }
    //
    // if (!onlyLeft && rightGlassGatt != null && rightTxChar != null) {
    // rightTxChar.setValue(data);
    // rightGlassGatt.writeCharacteristic(rightTxChar);
    // Thread.sleep(DELAY_BETWEEN_SENDS_MS);
    // }
    // stopper = false;
    // } catch (InterruptedException e) {
    // Bridge.log("G1: Error sending data: " + e.getMessage());
    // }
    // }).start();
    // }

    // Data class to represent a send request
    private static class SendRequest {
        final byte[] data;
        final boolean onlyLeft;
        final boolean onlyRight;
        public int waitTime = -1;

        SendRequest(byte[] data, boolean onlyLeft, boolean onlyRight) {
            this.data = data;
            this.onlyLeft = onlyLeft;
            this.onlyRight = onlyRight;
        }

        SendRequest(byte[] data, boolean onlyLeft, boolean onlyRight, int waitTime) {
            this.data = data;
            this.onlyLeft = onlyLeft;
            this.onlyRight = onlyRight;
            this.waitTime = waitTime;
        }
    }

    // Queue to hold pending requests
    private final BlockingQueue<SendRequest[]> sendQueue = new LinkedBlockingQueue<>();

    private volatile boolean isWorkerRunning = false;

    // Non-blocking function to add new send request
    private void sendDataSequentially(byte[] data, boolean onlyLeft) {
        SendRequest[] chunks = { new SendRequest(data, onlyLeft, false) };
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    // Non-blocking function to add new send request
    private void sendDataSequentially(byte[] data, boolean onlyLeft, int waitTime) {
        SendRequest[] chunks = { new SendRequest(data, onlyLeft, false, waitTime) };
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    // Overloaded function to handle multiple chunks (List<byte[]>)
    private void sendDataSequentially(List<byte[]> data, boolean onlyLeft) {
        sendDataSequentially(data, onlyLeft, false);
    }

    private void sendDataSequentially(byte[] data, boolean onlyLeft, boolean onlyRight) {
        SendRequest[] chunks = { new SendRequest(data, onlyLeft, onlyRight) };
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    private void sendDataSequentially(byte[] data, boolean onlyLeft, boolean onlyRight, int waitTime) {
        SendRequest[] chunks = { new SendRequest(data, onlyLeft, onlyRight, waitTime) };
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    private void sendDataSequentially(List<byte[]> data, boolean onlyLeft, boolean onlyRight) {
        SendRequest[] chunks = new SendRequest[data.size()];
        for (int i = 0; i < data.size(); i++) {
            chunks[i] = new SendRequest(data.get(i), onlyLeft, onlyRight);
        }
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    // Start the worker thread if it's not already running
    private synchronized void startWorkerIfNeeded() {
        if (!isWorkerRunning) {
            isWorkerRunning = true;
            new Thread(this::processQueue, "EvenRealitiesG1SGCProcessQueue").start();
        }
    }

    // Fast send method for bitmap chunks - doesn't wait for write confirmation
    private void sendBitmapChunkNoWait(byte[] data, boolean sendLeft, boolean sendRight) {
        if (data == null || data.length == 0)
            return;

        // IMPORTANT: Set write type to NO_RESPONSE for fire-and-forget behavior
        // This prevents waiting for BLE acknowledgments

        // Send to right glass without waiting
        if (sendRight && rightGlassGatt != null && rightTxChar != null && isRightConnected) {
            rightTxChar.setValue(data);
            rightTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            rightGlassGatt.writeCharacteristic(rightTxChar);
            // Restore default write type
            rightTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        }

        // Send to left glass without waiting
        if (sendLeft && leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
            leftTxChar.setValue(data);
            leftTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            leftGlassGatt.writeCharacteristic(leftTxChar);
            // Restore default write type
            leftTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        }
    }

    public class BooleanWaiter {
        private boolean flag = true; // initially true

        public synchronized void waitWhileTrue() throws InterruptedException {
            while (flag) {
                wait();
            }
        }

        public synchronized void setTrue() {
            flag = true;
        }

        public synchronized void setFalse() {
            flag = false;
            notifyAll();
        }
    }

    private final BooleanWaiter leftWaiter = new BooleanWaiter();
    private final BooleanWaiter rightWaiter = new BooleanWaiter();
    private final BooleanWaiter leftServicesWaiter = new BooleanWaiter();
    private final BooleanWaiter rightServicesWaiter = new BooleanWaiter();
    private static final long INITIAL_CONNECTION_DELAY_MS = 350; // Adjust this value as needed

    private void processQueue() {
        // First wait until the services are setup and ready to receive data
        Bridge.log("G1: PROC_QUEUE - waiting on services waiters");
        try {
            leftServicesWaiter.waitWhileTrue();
            rightServicesWaiter.waitWhileTrue();
        } catch (InterruptedException e) {
            Bridge.log("G1: Interrupted waiting for descriptor writes: " + e.toString());
        }
        Bridge.log("G1: PROC_QUEUE - DONE waiting on services waiters");

        while (!isKilled) {
            try {
                // Make sure services are ready before processing requests
                leftServicesWaiter.waitWhileTrue();
                rightServicesWaiter.waitWhileTrue();

                // This will block until data is available - no CPU spinning!
                SendRequest[] requests = sendQueue.take();

                for (SendRequest request : requests) {
                    if (request == null) {
                        isWorkerRunning = false;
                        break;
                    }

                    try {
                        // Force an initial delay so BLE gets all setup
                        long timeSinceConnection = System.currentTimeMillis() - lastConnectionTimestamp;
                        if (timeSinceConnection < INITIAL_CONNECTION_DELAY_MS) {
                            Thread.sleep(INITIAL_CONNECTION_DELAY_MS - timeSinceConnection);
                        }

                        boolean leftSuccess = true;
                        boolean rightSuccess = true;

                        // Start both writes without waiting
                        boolean leftStarted = false;
                        boolean rightStarted = false;

                        // Start right glass write (non-blocking)
                        if (!request.onlyLeft && rightGlassGatt != null && rightTxChar != null && isRightConnected) {
                            rightWaiter.setTrue();
                            rightTxChar.setValue(request.data);
                            rightSuccess = rightGlassGatt.writeCharacteristic(rightTxChar);
                            if (rightSuccess) {
                                rightStarted = true;
                                lastSendTimestamp = System.currentTimeMillis();
                            }
                        }

                        // Start left glass write immediately (non-blocking)
                        if (!request.onlyRight && leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
                            leftWaiter.setTrue();
                            leftTxChar.setValue(request.data);
                            leftSuccess = leftGlassGatt.writeCharacteristic(leftTxChar);
                            if (leftSuccess) {
                                leftStarted = true;
                                lastSendTimestamp = System.currentTimeMillis();
                            }
                        }

                        // Now wait for both to complete
                        if (rightStarted) {
                            rightWaiter.waitWhileTrue();
                        }
                        if (leftStarted) {
                            leftWaiter.waitWhileTrue();
                        }

                        Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND);

                        // If the packet asked us to do a delay, then do it
                        if (request.waitTime != -1) {
                            Thread.sleep(request.waitTime);
                        }
                    } catch (InterruptedException e) {
                        Bridge.log("G1: Error sending data: " + e.getMessage());
                        if (isKilled)
                            break;
                    }
                }
            } catch (InterruptedException e) {
                if (isKilled) {
                    Bridge.log("G1: Process queue thread interrupted - shutting down");
                    break;
                }
                Bridge.log("G1: Error in queue processing: " + e.getMessage());
            }
        }

        Bridge.log("G1: Process queue thread exiting");
    }

    // @Override
    // public void displayReferenceCardSimple(String title, String body, int
    // lingerTimeMs) {
    // displayReferenceCardSimple(title, body, lingerTimeMs);
    // }

    private static final int NOTIFICATION = 0x4B; // Notification command

    private String createNotificationJson(String appIdentifier, String title, String subtitle, String message) {
        long currentTime = System.currentTimeMillis() / 1000L; // Unix timestamp in seconds
        String currentDate = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new java.util.Date()); // Date
                                                                                                                 // format
                                                                                                                 // for
                                                                                                                 // 'date'
                                                                                                                 // field

        NCSNotification ncsNotification = new NCSNotification(
                notificationNum++, // Increment sequence ID for uniqueness
                1, // type (e.g., 1 = notification type)
                appIdentifier,
                title,
                subtitle,
                message,
                (int) currentTime, // Cast long to int to match Python
                currentDate, // Add the current date to the notification
                "AugmentOS" // display_name
        );

        Notification notification = new Notification(ncsNotification, "Add");

        Gson gson = new Gson();
        return gson.toJson(notification);
    }

    class Notification {
        NCSNotification ncs_notification;
        String type;

        public Notification() {
            // Default constructor
        }

        public Notification(NCSNotification ncs_notification, String type) {
            this.ncs_notification = ncs_notification;
            this.type = type;
        }
    }

    class NCSNotification {
        int msg_id;
        int type;
        String app_identifier;
        String title;
        String subtitle;
        String message;
        int time_s; // Changed from long to int for consistency
        String date; // Added to match Python's date field
        String display_name;

        public NCSNotification(int msg_id, int type, String app_identifier, String title, String subtitle,
                String message, int time_s, String date, String display_name) {
            this.msg_id = msg_id;
            this.type = type;
            this.app_identifier = app_identifier;
            this.title = title;
            this.subtitle = subtitle;
            this.message = message;
            this.time_s = time_s;
            this.date = date; // Initialize the date field
            this.display_name = display_name;
        }
    }

    private List<byte[]> createNotificationChunks(String json) {
        final int MAX_CHUNK_SIZE = 176; // 180 - 4 header bytes
        byte[] jsonBytes = json.getBytes(StandardCharsets.UTF_8);
        int totalChunks = (int) Math.ceil((double) jsonBytes.length / MAX_CHUNK_SIZE);

        List<byte[]> chunks = new ArrayList<>();
        for (int i = 0; i < totalChunks; i++) {
            int start = i * MAX_CHUNK_SIZE;
            int end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.length);
            byte[] payloadChunk = Arrays.copyOfRange(jsonBytes, start, end);

            // Create the header
            byte[] header = new byte[] {
                    (byte) NOTIFICATION,
                    0x00, // notify_id (can be updated as needed)
                    (byte) totalChunks,
                    (byte) i
            };

            // Combine header and payload
            ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
            chunk.put(header);
            chunk.put(payloadChunk);

            chunks.add(chunk.array());
        }

        return chunks;
    }

    public void displayReferenceCardSimple(String title, String body) {
        if (!isConnected()) {
            Bridge.log("G1: Not connected to glasses");
            return;
        }

        if (title.trim().isEmpty() && body.trim().isEmpty()) {
            if (CoreManager.getInstance().getPowerSavingMode()) {
                sendExitCommand();
                return;
            }
        }

        List<byte[]> chunks = createTextWallChunks(title + "\n\n" + body);
        for (int i = 0; i < chunks.size(); i++) {
            byte[] chunk = chunks.get(i);
            boolean isLastChunk = (i == chunks.size() - 1);

            if (isLastChunk) {
                sendDataSequentially(chunk, false);
            } else {
                sendDataSequentially(chunk, false, 300);
            }
        }
        Bridge.log("G1: Send simple reference card");
    }

    public void destroy() {
        Bridge.log("G1: EvenRealitiesG1SGC ONDESTROY");
        showHomeScreen();
        isKilled = true;
        ready = false;

        // Reset battery levels
        batteryLeft = -1;
        batteryRight = -1;
        batteryLevel = -1;

        // stop BLE scanning
        stopScan();

        // Shutdown bitmap executor
        if (bitmapExecutor != null) {
            bitmapExecutor.shutdown();
            try {
                if (!bitmapExecutor.awaitTermination(1, TimeUnit.SECONDS)) {
                    bitmapExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                bitmapExecutor.shutdownNow();
            }
        }

        if (bondingReceiver != null && isBondingReceiverRegistered) {
            context.unregisterReceiver(bondingReceiver);
            isBondingReceiverRegistered = false;
        }

        if (rightConnectionRetryRunnable != null) {
            connectHandler.removeCallbacks(rightConnectionRetryRunnable);
            rightConnectionRetryRunnable = null;
        }

        // disable the microphone
        sendSetMicEnabled(false, 0);

        // stop sending heartbeat
        stopHeartbeat();

        // stop sending micbeat
        stopMicBeat();

        // Stop periodic notifications
        stopPeriodicNotifications();

        // Stop periodic text wall
        // stopPeriodicNotifications();

        if (leftGlassGatt != null) {
            leftGlassGatt.disconnect();
            leftGlassGatt.close();
            leftGlassGatt = null;
        }
        if (rightGlassGatt != null) {
            rightGlassGatt.disconnect();
            rightGlassGatt.close();
            rightGlassGatt = null;
        }

        if (handler != null)
            handler.removeCallbacksAndMessages(null);
        if (heartbeatHandler != null)
            heartbeatHandler.removeCallbacks(heartbeatRunnable);
        if (whiteListHandler != null)
            whiteListHandler.removeCallbacksAndMessages(null);
        if (micEnableHandler != null)
            micEnableHandler.removeCallbacksAndMessages(null);
        if (notificationHandler != null)
            notificationHandler.removeCallbacks(notificationRunnable);
        if (textWallHandler != null)
            textWallHandler.removeCallbacks(textWallRunnable);
        // if (goHomeHandler != null)
        // goHomeHandler.removeCallbacks(goHomeRunnable);
        if (findCompatibleDevicesHandler != null)
            findCompatibleDevicesHandler.removeCallbacksAndMessages(null);
        if (connectHandler != null)
            connectHandler.removeCallbacksAndMessages(null);
        if (retryBondHandler != null)
            retryBondHandler.removeCallbacksAndMessages(null);
        if (characteristicHandler != null) {
            characteristicHandler.removeCallbacksAndMessages(null);
        }
        if (reconnectHandler != null) {
            reconnectHandler.removeCallbacksAndMessages(null);
        }
        if (leftConnectionTimeoutHandler != null && leftConnectionTimeoutRunnable != null) {
            leftConnectionTimeoutHandler.removeCallbacks(leftConnectionTimeoutRunnable);
        }
        if (rightConnectionTimeoutHandler != null && rightConnectionTimeoutRunnable != null) {
            rightConnectionTimeoutHandler.removeCallbacks(rightConnectionTimeoutRunnable);
        }
        if (reconnectHandler != null) {
            reconnectHandler.removeCallbacksAndMessages(null);
        }
        if (queryBatteryStatusHandler != null && queryBatteryStatusHandler != null) {
            queryBatteryStatusHandler.removeCallbacksAndMessages(null);
        }

        // free LC3 decoder
        if (lc3DecoderPtr != 0) {
            Lc3Cpp.freeDecoder(lc3DecoderPtr);
            lc3DecoderPtr = 0;
        }

        sendQueue.clear();

        // Add a dummy element to unblock the take() call if needed
        sendQueue.offer(new SendRequest[0]); // is this needed?

        isWorkerRunning = false;

        isLeftConnected = false;
        isRightConnected = false;

        // Clear device references and stored names
        leftDevice = null;
        rightDevice = null;
        leftDeviceName = null;
        rightDeviceName = null;

        Bridge.log("G1: EvenRealitiesG1SGC cleanup complete");
    }

    public boolean isConnected() {
        return connectionState == SmartGlassesConnectionState.CONNECTED;
    }

    // Remaining methods
    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageInput) {
    }

    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs) {
    }

    public void scrollingTextViewIntermediateText(String text) {
    }

    public void scrollingTextViewFinalText(String text) {
    }

    public void stopScrollingTextViewMode() {
    }

    public void displayPromptView(String title, String[] options) {
    }

    public void displayTextLine(String text) {
    }

    public void displayBitmap(Bitmap bmp) {
        try {
            byte[] bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false);
            displayBitmapImage(bmpBytes);
        } catch (Exception e) {
            Log.e(TAG, e.getMessage());
        }
    }

    public void blankScreen() {
    }

    public void displayDoubleTextWall(String textTop, String textBottom) {
        // if (updatingScreen)
        //     return;

        // if (textTop.trim().isEmpty() && textBottom.trim().isEmpty()) {
        //     if (CoreManager.getInstance().getPowerSavingMode()) {
        //         sendExitCommand();
        //         return;
        //     }
        // }

        List<byte[]> chunks = g1Text.createDoubleTextWallChunks(textTop, textBottom);
        sendChunks(chunks);
    }

    public void showHomeScreen() {
        // if (CoreManager.getInstance().getPowerSavingMode()) {
            // sendExitCommand();
        // } else {
            displayTextWall(" ");
        // }

        // if (lastThingDisplayedWasAnImage) {
        //     // clearG1Screen();
        //     lastThingDisplayedWasAnImage = false;
        // }
    }

    public void clearG1Screen() {
        Bridge.log("G1: Clearing G1 screen");
        byte[] exitCommand = new byte[] { (byte) 0x18 };
        // sendDataSequentially(exitCommand, false);
        byte[] theClearBitmapOrSomething = loadEmptyBmpFromAssets();
        Bitmap bmp = BitmapJavaUtils.bytesToBitmap(theClearBitmapOrSomething);
        try {
            byte[] bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false);
            displayBitmapImage(bmpBytes);
        } catch (Exception e) {
            Log.e(TAG, "Error displaying clear bitmap: " + e.getMessage());
        }
    }


    public void displayRowsCard(String[] rowStrings) {
    }

    public void displayBulletList(String title, String[] bullets) {
    }

    public void displayReferenceCardImage(String title, String body, String imgUrl) {
    }

    public void displayTextWall(String a) {
        // if (a.trim().isEmpty()) {
        //     if (CoreManager.getInstance().getPowerSavingMode()) {
        //         sendExitCommand();
        //         return;
        //     }
        // }

        List<byte[]> chunks = createTextWallChunks(a);
        // if (a.isEmpty()) {
        //     clearDisplay();
        //     return;
        // }
        // List<byte[]> chunks = chunkTextForTransmission(a);
        sendChunks(chunks);
    }

    public void setUpdatingScreen(boolean updatingScreen) {
        this.updatingScreen = updatingScreen;
    }

    public void setFontSizes() {
    }

    // Heartbeat methods
    private byte[] constructHeartbeat() {
        ByteBuffer buffer = ByteBuffer.allocate(6);
        buffer.put((byte) 0x25);
        buffer.put((byte) 6);
        buffer.put((byte) (currentSeq & 0xFF));
        buffer.put((byte) 0x00);
        buffer.put((byte) 0x04);
        buffer.put((byte) (currentSeq++ & 0xFF));
        return buffer.array();
    }

    private byte[] constructBatteryLevelQuery() {
        ByteBuffer buffer = ByteBuffer.allocate(2);
        buffer.put((byte) 0x2C); // Command
        buffer.put((byte) 0x01); // use 0x02 for iOS
        return buffer.array();
    }

    private void startHeartbeat(int delay) {
        Bridge.log("G1: Starting heartbeat");
        if (heartbeatCount > 0)
            stopHeartbeat();

        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                sendHeartbeat();
                // sendLoremIpsum();

                // quickRestartG1();

                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
            }
        };

        heartbeatHandler.postDelayed(heartbeatRunnable, delay);
    }

    // periodically send a mic ON request so it never turns off
    private void startMicBeat(int delay) {
        Bridge.log("G1: Starting micbeat");
        if (micBeatCount > 0)
            stopMicBeat();
        sendSetMicEnabled(true, 10);

        micBeatRunnable = new Runnable() {
            @Override
            public void run() {
                Bridge.log("G1: SENDING MIC BEAT");
                sendSetMicEnabled(shouldUseGlassesMic, 1);
                micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS);
            }
        };

        micBeatHandler.postDelayed(micBeatRunnable, delay);
    }

    @Override
    public void findCompatibleDevices() {
        Bridge.log("G1: findCompatibleDevices called");
        if (isScanningForCompatibleDevices) {
            Bridge.log("G1: Scan already in progress, skipping...");
            return;
        }
        isScanningForCompatibleDevices = true;

        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            Log.e(TAG, "BluetoothLeScanner not available");
            isScanningForCompatibleDevices = false;
            return;
        }

        List<String> foundDeviceNames = new ArrayList<>();
        if (findCompatibleDevicesHandler == null) {
            findCompatibleDevicesHandler = new Handler(Looper.getMainLooper());
        }

        // Optional: add filters if you want to narrow the scan
        List<ScanFilter> filters = new ArrayList<>();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
                .build();

        // Create a modern ScanCallback instead of the deprecated LeScanCallback
        final ScanCallback bleScanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice device = result.getDevice();
                String name = device.getName();
                if (name != null && name.contains("Even G1_") && name.contains("_L_")) {
                    synchronized (foundDeviceNames) {
                        if (!foundDeviceNames.contains(name)) {
                            foundDeviceNames.add(name);
                            Bridge.log("Found smart glasses: " + name);
                            String adjustedName = parsePairingIdFromDeviceName(name);
                            // If parsing failed, use the full name as fallback
                            if (adjustedName == null) {
                                adjustedName = name;
                                Bridge.log("G1: Failed to parse device ID from name: " + name);
                            }
                            Bridge.sendDiscoveredDevice("Even Realities G1", adjustedName);
                        }
                    }
                }
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                // If needed, handle batch results here
            }

            @Override
            public void onScanFailed(int errorCode) {
                Log.e(TAG, "BLE scan failed with code: " + errorCode);
            }
        };

        // Start scanning
        scanner.startScan(filters, settings, bleScanCallback);
        Bridge.log("G1: Started scanning for smart glasses with BluetoothLeScanner...");

        // Stop scanning after 10 seconds (adjust as needed)
        findCompatibleDevicesHandler.postDelayed(() -> {
            scanner.stopScan(bleScanCallback);
            isScanningForCompatibleDevices = false;
            Bridge.log("G1: Stopped scanning for smart glasses.");
            // EventBus.getDefault().post(
            // new GlassesBluetoothSearchStopEvent(
            // smartGlassesDevice.deviceModelName
            // )
            // );
        }, 10000);
    }

    private void sendWhiteListCommand(int delay) {
        if (whiteListedAlready) {
            return;
        }
        whiteListedAlready = true;

        Bridge.log("G1: Sending whitelist command");
        whiteListHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                List<byte[]> chunks = getWhitelistChunks();
                sendDataSequentially(chunks, false);
                // for (byte[] chunk : chunks) {
                // Bridge.log("G1: Sending this chunk for white list:" + bytesToUtf8(chunk));
                // sendDataSequentially(chunk, false);
                //
                //// // Sleep for 100 milliseconds between sending each chunk
                //// try {
                //// Thread.sleep(150);
                //// } catch (InterruptedException e) {
                //// e.printStackTrace();
                //// }
                // }
            }
        }, delay);
    }

    private void stopHeartbeat() {
        Bridge.log("G1: stopHeartbeat()");
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacksAndMessages(null);
            heartbeatHandler.removeCallbacksAndMessages(heartbeatRunnable);
            heartbeatCount = 0;
        }
    }

    private void stopMicBeat() {
        Bridge.log("G1: stopMicBeat()");
        sendSetMicEnabled(false, 10);
        if (micBeatHandler != null) {
            micBeatHandler.removeCallbacksAndMessages(null);
            micBeatHandler.removeCallbacksAndMessages(micBeatRunnable);
            micBeatRunnable = null;
            micBeatCount = 0;
        }
    }

    private void sendHeartbeat() {
        byte[] heartbeatPacket = constructHeartbeat();
        // Bridge.log("G1: Sending heartbeat: " + bytesToHex(heartbeatPacket));

        sendDataSequentially(heartbeatPacket, false, 100);

        if (batteryLeft == -1 || batteryRight == -1 || heartbeatCount % 10 == 0) {
            queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500);
        }
        // queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500);

        heartbeatCount++;
    }

    private void queryBatteryStatus() {
        byte[] batteryQueryPacket = constructBatteryLevelQuery();
        // Bridge.log("G1: Sending battery status query: " +
        // bytesToHex(batteryQueryPacket));

        sendDataSequentially(batteryQueryPacket, false, 250);
    }

    public void sendBrightnessCommand(int brightness, boolean autoLight) {
        // Validate brightness range

        int validBrightness;
        if (brightness != -1) {
            validBrightness = (brightness * 63) / 100;
        } else {
            validBrightness = (30 * 63) / 100;
        }

        // Construct the command
        ByteBuffer buffer = ByteBuffer.allocate(3);
        buffer.put((byte) 0x01); // Command
        buffer.put((byte) validBrightness); // Brightness level (0~63)
        buffer.put((byte) (autoLight ? 1 : 0)); // Auto light (0 = close, 1 = open)

        sendDataSequentially(buffer.array(), false, 100);

        Bridge.log("G1: Sent auto light brightness command => Brightness: " + brightness + ", Auto Light: "
                + (autoLight ? "Open" : "Close"));

        // send to AugmentOS core
        // if (autoLight) {
        // EventBus.getDefault().post(new BrightnessLevelEvent(autoLight));
        // } else {
        // EventBus.getDefault().post(new BrightnessLevelEvent(brightness));
        // }
    }

    public void sendHeadUpAngleCommand(int headUpAngle) {
        // Validate headUpAngle range (0 ~ 60)
        if (headUpAngle < 0) {
            headUpAngle = 0;
        } else if (headUpAngle > 60) {
            headUpAngle = 60;
        }

        // Construct the command
        ByteBuffer buffer = ByteBuffer.allocate(3);
        buffer.put((byte) 0x0B); // Command for configuring headUp angle
        buffer.put((byte) headUpAngle); // Angle value (0~60)
        buffer.put((byte) 0x01); // Level (fixed at 0x01)

        sendDataSequentially(buffer.array(), false, 100);

        Bridge.log("G1: Sent headUp angle command => Angle: " + headUpAngle);
        // EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));
    }

    public void sendDashboardPositionCommand(int height, int depth) {
        // clamp height and depth to 0-8 and 1-9 respectively:
        height = Math.max(0, Math.min(height, 8));
        depth = Math.max(1, Math.min(depth, 9));

        int globalCounter = 0;// TODO: must be incremented each time this command is sent!

        ByteBuffer buffer = ByteBuffer.allocate(8);
        buffer.put((byte) 0x26); // Command for dashboard height
        buffer.put((byte) 0x08); // Length
        buffer.put((byte) 0x00); // Sequence
        buffer.put((byte) (globalCounter & 0xFF));// counter
        buffer.put((byte) 0x02); // Fixed value
        buffer.put((byte) 0x01); // State ON
        buffer.put((byte) height); // Height value (0-8)
        buffer.put((byte) depth); // Depth value (0-9)

        sendDataSequentially(buffer.array(), false, 100);

        Bridge.log("G1: Sent dashboard height/depth command => Height: " + height + ", Depth: " + depth);
        // EventBus.getDefault().post(new DashboardPositionEvent(height, depth));
    }

    public void updateGlassesBrightness(int brightness) {
        Bridge.log("G1: Updating glasses brightness: " + brightness);
        sendBrightnessCommand(brightness, false);
    }

    public void updateGlassesAutoBrightness(boolean autoBrightness) {
        Bridge.log("G1: Updating glasses auto brightness: " + autoBrightness);
        sendBrightnessCommand(-1, autoBrightness);
    }

    public void updateGlassesHeadUpAngle(int headUpAngle) {
        sendHeadUpAngleCommand(headUpAngle);
    }

    public void updateGlassesDepthHeight(int depth, int height) {
        sendDashboardPositionCommand(height, depth);
    }

    public void sendExitCommand() {
        sendDataSequentially(new byte[] { (byte) 0x18 }, false, 100);
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X ", b));
        }
        return sb.toString().trim();
    }

    // microphone stuff
    public void sendSetMicEnabled(boolean enable, int delay) {
        Bridge.log("G1: sendSetMicEnabled(): " + enable);

        isMicrophoneEnabled = enable; // Update the state tracker
        micEnabled = enable;
        micEnableHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isConnected()) {
                    Bridge.log("G1: Tryna start mic: Not connected to glasses");
                    return;
                }

                byte command = 0x0E; // Command for MIC control
                byte enableByte = (byte) (enable ? 1 : 0); // 1 to enable, 0 to disable

                ByteBuffer buffer = ByteBuffer.allocate(2);
                buffer.put(command);
                buffer.put(enableByte);

                sendDataSequentially(buffer.array(), false, true, 300); // wait some time to setup the mic
                Bridge.log("G1: Sent MIC command: " + bytesToHex(buffer.array()));
            }
        }, delay);
    }

    // notifications
    private void startPeriodicNotifications(int delay) {
        if (notifysStarted) {
            return;
        }
        notifysStarted = true;

        notificationRunnable = new Runnable() {
            @Override
            public void run() {
                // Send notification
                sendPeriodicNotification();

                // Schedule the next notification
                notificationHandler.postDelayed(this, 12000);
            }
        };

        // Start the first notification after 5 seconds
        notificationHandler.postDelayed(notificationRunnable, delay);
    }

    private void sendPeriodicNotification() {
        if (!isConnected()) {
            Bridge.log("G1: Cannot send notification: Not connected to glasses");
            return;
        }

        // Example notification data (replace with your actual data)
        // String json = createNotificationJson("com.augment.os", "QuestionAnswerer",
        // "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
        String json = createNotificationJson("com.augment.os", "QuestionAnswerer",
                "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
        Bridge.log("G1: the JSON to send: " + json);
        List<byte[]> chunks = createNotificationChunks(json);
        for (byte[] chunk : chunks) {
            Bridge.log("G1: Sent chunk to glasses: " + bytesToUtf8(chunk));
        }

        // Send each chunk with a short sleep between each send
        sendDataSequentially(chunks, false);

        Bridge.log("G1: Sent periodic notification");
    }

    // text wall debug
    private void startPeriodicTextWall(int delay) {
        if (textWallsStarted) {
            return;
        }
        textWallsStarted = true;

        textWallRunnable = new Runnable() {
            @Override
            public void run() {
                // Send notification
                sendPeriodicTextWall();

                // Schedule the next notification
                textWallHandler.postDelayed(this, 12000);
            }
        };

        // Start the first text wall send after 5 seconds
        textWallHandler.postDelayed(textWallRunnable, delay);
    }

    // Constants for text wall display
    private static final int TEXT_COMMAND = 0x4E; // Text command
    private static final int DISPLAY_WIDTH = 488;
    private static final int DISPLAY_USE_WIDTH = 488; // How much of the display to use
    private static final float FONT_MULTIPLIER = 1 / 50.0f;
    private static final int OLD_FONT_SIZE = 21; // Font size
    private static final float FONT_DIVIDER = 2.0f;
    private static final int LINES_PER_SCREEN = 5; // Lines per screen
    private static final int MAX_CHUNK_SIZE = 176; // Maximum chunk size for BLE packets
    // private static final int INDENT_SPACES = 32; // Number of spaces to indent
    // text

    private int textSeqNum = 0; // Sequence number for text packets

    // currently only a single page - 1PAGE CHANGE
    private List<byte[]> createTextWallChunks(String text) {
        int margin = 5;

        // Get width of single space character
        int spaceWidth = g1Text.calculateTextWidth(" ");

        // Calculate effective display width after accounting for left and right margins
        // in spaces
        int marginWidth = margin * spaceWidth; // Width of left margin in pixels
        int effectiveWidth = DISPLAY_WIDTH - (2 * marginWidth); // Subtract left and right margins

        // Split text into lines based on effective display width
        List<String> lines = g1Text.splitIntoLines(text, effectiveWidth);

        // Calculate total pages
        int totalPages = 1; // hard set to 1 since we only do 1 page - 1PAGECHANGE

        List<byte[]> allChunks = new ArrayList<>();

        // Process each page
        for (int page = 0; page < totalPages; page++) {
            // Get lines for current page
            int startLine = page * LINES_PER_SCREEN;
            int endLine = Math.min(startLine + LINES_PER_SCREEN, lines.size());
            List<String> pageLines = lines.subList(startLine, endLine);

            // Combine lines for this page with proper indentation
            StringBuilder pageText = new StringBuilder();

            for (String line : pageLines) {
                // Add the exact number of spaces for indentation
                String indentation = " ".repeat(margin);
                pageText.append(indentation).append(line).append("\n");
            }

            byte[] textBytes = pageText.toString().getBytes(StandardCharsets.UTF_8);
            int totalChunks = (int) Math.ceil((double) textBytes.length / MAX_CHUNK_SIZE);

            // Create chunks for this page
            for (int i = 0; i < totalChunks; i++) {
                int start = i * MAX_CHUNK_SIZE;
                int end = Math.min(start + MAX_CHUNK_SIZE, textBytes.length);
                byte[] payloadChunk = Arrays.copyOfRange(textBytes, start, end);

                // Create header with protocol specifications
                byte screenStatus = 0x71; // New content (0x01) + Text Show (0x70)
                byte[] header = new byte[] {
                        (byte) TEXT_COMMAND, // Command type
                        (byte) textSeqNum, // Sequence number
                        (byte) totalChunks, // Total packages
                        (byte) i, // Current package number
                        screenStatus, // Screen status
                        (byte) 0x00, // new_char_pos0 (high)
                        (byte) 0x00, // new_char_pos1 (low)
                        (byte) page, // Current page number
                        (byte) totalPages // Max page number
                };

                // Combine header and payload
                ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
                chunk.put(header);
                chunk.put(payloadChunk);

                allChunks.add(chunk.array());
            }

            // Increment sequence number for next page
            textSeqNum = (textSeqNum + 1) % 256;
            break; // hard set to 1 - 1PAGECHANGE
        }

        return allChunks;
    }

    private int calculateSpacesForAlignment(int currentWidth, int targetPosition, int spaceWidth) {
        // Calculate space needed in pixels
        int pixelsNeeded = targetPosition - currentWidth;

        // Calculate spaces needed (with minimum of 1 space for separation)
        if (pixelsNeeded <= 0) {
            return 1; // Ensure at least one space between columns
        }

        // Calculate the exact number of spaces needed
        int spaces = (int) Math.ceil((double) pixelsNeeded / spaceWidth);

        // Cap at a reasonable maximum
        return Math.min(spaces, 100);
    }

    private List<byte[]> chunkTextForTransmission(String text) {
        byte[] textBytes = text.getBytes(StandardCharsets.UTF_8);
        int totalChunks = (int) Math.ceil((double) textBytes.length / MAX_CHUNK_SIZE);

        List<byte[]> allChunks = new ArrayList<>();
        for (int i = 0; i < totalChunks; i++) {
            int start = i * MAX_CHUNK_SIZE;
            int end = Math.min(start + MAX_CHUNK_SIZE, textBytes.length);
            byte[] payloadChunk = Arrays.copyOfRange(textBytes, start, end);

            // Create header with protocol specifications
            byte screenStatus = 0x71; // New content (0x01) + Text Show (0x70)
            byte[] header = new byte[] {
                    (byte) TEXT_COMMAND, // Command type
                    (byte) textSeqNum, // Sequence number
                    (byte) totalChunks, // Total packages
                    (byte) i, // Current package number
                    screenStatus, // Screen status
                    (byte) 0x00, // new_char_pos0 (high)
                    (byte) 0x00, // new_char_pos1 (low)
                    (byte) 0x00, // Current page number (always 0 for now)
                    (byte) 0x01 // Max page number (always 1)
            };

            // Combine header and payload
            ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
            chunk.put(header);
            chunk.put(payloadChunk);

            allChunks.add(chunk.array());
        }

        // Increment sequence number for next page
        textSeqNum = (textSeqNum + 1) % 256;

        return allChunks;
    }

    private void sendPeriodicTextWall() {
        if (!isConnected()) {
            Bridge.log("G1: Cannot send text wall: Not connected to glasses");
            return;
        }

        Bridge.log("G1: ^^^^^^^^^^^^^ SENDING DEBUG TEXT WALL");

        // Example text wall content - replace with your actual text content
        String sampleText = "This is an example of a text wall that will be displayed on the glasses. " +
                "It demonstrates how text can be split into multiple pages and displayed sequentially. " +
                "Each page contains multiple lines, and each line is carefully formatted to fit the display width. " +
                "The text continues across multiple pages, showing how longer content can be handled effectively.";

        List<byte[]> chunks = createTextWallChunks(sampleText);

        // Send each chunk with a delay between sends
        for (byte[] chunk : chunks) {
            sendDataSequentially(chunk);

            // try {
            // Thread.sleep(150); // 150ms delay between chunks
            // } catch (InterruptedException e) {
            // e.printStackTrace();
            // }
        }

        // Bridge.log("G1: Sent text wall");
    }

    private static String bytesToUtf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private void stopPeriodicNotifications() {
        if (notificationHandler != null && notificationRunnable != null) {
            notificationHandler.removeCallbacks(notificationRunnable);
            Bridge.log("G1: Stopped periodic notifications");
        }
    }

    // handle white list stuff
    private static final int WHITELIST_CMD = 0x04; // Command ID for whitelist

    public List<byte[]> getWhitelistChunks() {
        // Define the hardcoded whitelist JSON
        List<AppInfo> apps = new ArrayList<>();
        apps.add(new AppInfo("com.augment.os", "AugmentOS"));
        String whitelistJson = createWhitelistJson(apps);

        Bridge.log("G1: Creating chunks for hardcoded whitelist: " + whitelistJson);

        // Convert JSON to bytes and split into chunks
        return createWhitelistChunks(whitelistJson);
    }

    private String createWhitelistJson(List<AppInfo> apps) {
        JSONArray appList = new JSONArray();
        try {
            // Add each app to the list
            for (AppInfo app : apps) {
                JSONObject appJson = new JSONObject();
                appJson.put("id", app.getId());
                appJson.put("name", app.getName());
                appList.put(appJson);
            }

            JSONObject whitelistJson = new JSONObject();
            whitelistJson.put("calendar_enable", false);
            whitelistJson.put("call_enable", false);
            whitelistJson.put("msg_enable", false);
            whitelistJson.put("ios_mail_enable", false);

            JSONObject appObject = new JSONObject();
            appObject.put("list", appList);
            appObject.put("enable", true);

            whitelistJson.put("app", appObject);

            return whitelistJson.toString();
        } catch (JSONException e) {
            Log.e(TAG, "Error creating whitelist JSON: " + e.getMessage());
            return "{}";
        }
    }

    // Simple class to hold app info
    class AppInfo {
        private String id;
        private String name;

        public AppInfo(String id, String name) {
            this.id = id;
            this.name = name;
        }

        public String getId() {
            return id;
        }

        public String getName() {
            return name;
        }
    }

    // Helper function to split JSON into chunks
    private List<byte[]> createWhitelistChunks(String json) {
        final int MAX_CHUNK_SIZE = 180 - 4; // Reserve space for the header
        byte[] jsonBytes = json.getBytes(StandardCharsets.UTF_8);
        int totalChunks = (int) Math.ceil((double) jsonBytes.length / MAX_CHUNK_SIZE);

        List<byte[]> chunks = new ArrayList<>();
        for (int i = 0; i < totalChunks; i++) {
            int start = i * MAX_CHUNK_SIZE;
            int end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.length);
            byte[] payloadChunk = Arrays.copyOfRange(jsonBytes, start, end);

            // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
            byte[] header = new byte[] {
                    (byte) WHITELIST_CMD, // Command ID
                    (byte) totalChunks, // Total number of chunks
                    (byte) i // Current chunk index
            };

            // Combine header and payload
            ByteBuffer buffer = ByteBuffer.allocate(header.length + payloadChunk.length);
            buffer.put(header);
            buffer.put(payloadChunk);

            chunks.add(buffer.array());
        }

        return chunks;
    }

    public void displayCustomContent(String content) {
        Bridge.log("G1: DISPLAY CUSTOM CONTENT");
    }

    private void sendChunks(List<byte[]> chunks) {
        // Send each chunk with a delay between sends
        for (byte[] chunk : chunks) {
            // Bridge.log("G1: Sending chunk: " + Arrays.toString(chunk));
            sendDataSequentially(chunk);

            // try {
            // Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND); // delay between chunks
            // } catch (InterruptedException e) {
            // e.printStackTrace();
            // }
        }
    }

    // public int DEFAULT_CARD_SHOW_TIME = 6;
    // public void homeScreenInNSeconds(int n){
    // if (n == -1){
    // return;
    // }
    //
    // if (n == 0){
    // n = DEFAULT_CARD_SHOW_TIME;
    // }
    //
    // //disconnect after slight delay, so our above text gets a chance to show up
    // goHomeHandler.removeCallbacksAndMessages(goHomeRunnable);
    // goHomeHandler.removeCallbacksAndMessages(null);
    // goHomeRunnable = new Runnable() {
    // @Override
    // public void run() {
    // showHomeScreen();
    // }};
    // goHomeHandler.postDelayed(goHomeRunnable, n * 1000);
    // }

    // BMP handling

    // Add these class variables
    private static final int BMP_CHUNK_SIZE = 194;
    private static final byte[] GLASSES_ADDRESS = new byte[] { 0x00, 0x1c, 0x00, 0x00 };
    private static final byte[] END_COMMAND = new byte[] { 0x20, 0x0d, 0x0e };
    private static final int MAX_BMP_RETRY_ATTEMPTS = 10;
    private static final long BMP_RETRY_DELAY_MS = 1000;

    // Platform-specific timing (matching Flutter implementation)
    // private static final long ANDROID_CHUNK_DELAY_MS = 5;
    private static final long ANDROID_CHUNK_DELAY_MS = 8;
    private static final long IOS_CHUNK_DELAY_MS = 8;
    private static final long END_COMMAND_TIMEOUT_MS = 3000;
    private static final long CRC_COMMAND_TIMEOUT_MS = 3000;
    private static final long CHUNK_SEND_TIMEOUT_MS = 5000;

    // Optimized bitmap display flags
    private static final boolean USE_OPTIMIZED_BITMAP_DISPLAY = true;
    private static final boolean USE_PARALLEL_BITMAP_WRITES = true;
    private volatile boolean isSendingBitmap = false;

    // Executor for parallel bitmap operations
    private ExecutorService bitmapExecutor;

    // Progress callback interface
    public interface BmpProgressCallback {
        void onProgress(String side, int offset, int chunkIndex, int totalSize);

        void onSuccess(String side);

        void onError(String side, String error);
    }

    /**
     * Inverts BMP pixel data by flipping all bits after the header.
     * Matches iOS implementation exactly (G1.swift line 1790-1811)
     *
     * @param bmpData The original BMP data
     * @return Inverted BMP data with pixel bits flipped
     */
    private byte[] invertBmpPixels(byte[] bmpData) {
        if (bmpData == null || bmpData.length <= 62) {
            Bridge.log("G1: BMP data too small to contain pixel data");
            return bmpData;
        }

        // BMP header is 62 bytes (14 byte file header + 40 byte DIB header + 8 byte color table)
        final int headerSize = 62;
        byte[] invertedData = new byte[bmpData.length];

        // Copy header unchanged
        System.arraycopy(bmpData, 0, invertedData, 0, headerSize);

        // Invert the pixel data (everything after the header)
        for (int i = headerSize; i < bmpData.length; i++) {
            // Invert each byte (flip all bits)
            invertedData[i] = (byte) ~bmpData[i];
        }

        Bridge.log("G1: Inverted BMP pixels: " + (bmpData.length - headerSize) + " bytes processed");
        return invertedData;
    }

    public void displayBitmapImage(byte[] bmpData) {
        displayBitmapImage(bmpData, null);
    }

    public void displayBitmapImage(byte[] bmpData, BmpProgressCallback callback) {
        // Invert BMP pixels to match iOS implementation
        byte[] invertedBmpData = invertBmpPixels(bmpData);

        if (USE_OPTIMIZED_BITMAP_DISPLAY) {
            displayBitmapImageOptimized(invertedBmpData, callback);
        } else {
            displayBitmapImageLegacy(invertedBmpData, callback);
        }
    }

    // Optimized bitmap display using iOS-like approach
    private void displayBitmapImageOptimized(byte[] bmpData, BmpProgressCallback callback) {
        Bridge.log("G1: Starting OPTIMIZED BMP display process");

        try {
            if (bmpData == null || bmpData.length == 0) {
                Log.e(TAG, "Invalid BMP data provided");
                if (callback != null)
                    callback.onError("both", "Invalid BMP data");
                return;
            }

            isSendingBitmap = true;
            long startTime = System.currentTimeMillis();

            Bridge.log("G1: Processing BMP data, size: " + bmpData.length + " bytes");
            List<byte[]> chunks = createBmpChunks(bmpData);
            Bridge.log("G1: Created " + chunks.size() + " chunks");

            // Send chunks using optimized method
            boolean chunksSuccess = sendBmpChunksOptimized(chunks, callback);
            if (!chunksSuccess) {
                Log.e(TAG, "Failed to send BMP chunks");
                if (callback != null)
                    callback.onError("both", "Failed to send chunks");
                return;
            }

            // Send end command - this needs confirmation
            boolean endSuccess = sendBmpEndCommandOptimized();
            if (!endSuccess) {
                Log.e(TAG, "Failed to send BMP end command");
                if (callback != null)
                    callback.onError("both", "Failed to send end command");
                return;
            }

            // Send CRC - this needs confirmation
            boolean crcSuccess = sendBmpCrcOptimized(bmpData);
            if (!crcSuccess) {
                Log.e(TAG, "Failed to send BMP CRC");
                if (callback != null)
                    callback.onError("both", "CRC check failed");
                return;
            }

            lastThingDisplayedWasAnImage = true;

            long totalTime = System.currentTimeMillis() - startTime;
            Bridge.log("G1: BMP display completed in " + totalTime + "ms");

            if (callback != null) {
                callback.onSuccess("both");
            }

        } catch (Exception e) {
            Log.e(TAG, "Error in displayBitmapImageOptimized: " + e.getMessage());
            if (callback != null)
                callback.onError("both", "Exception: " + e.getMessage());
        } finally {
            isSendingBitmap = false;
        }
    }

    // Legacy method for fallback
    private void displayBitmapImageLegacy(byte[] bmpData, BmpProgressCallback callback) {
        Bridge.log("G1: Starting LEGACY BMP display process");

        try {
            if (bmpData == null || bmpData.length == 0) {
                Log.e(TAG, "Invalid BMP data provided");
                if (callback != null)
                    callback.onError("both", "Invalid BMP data");
                return;
            }
            Bridge.log("G1: Processing BMP data, size: " + bmpData.length + " bytes");
            // Split into chunks and send
            List<byte[]> chunks = createBmpChunks(bmpData);
            Bridge.log("G1: Created " + chunks.size() + " chunks");

            // Send all chunks
            sendBmpChunks(chunks);
            // Send all chunks with progress
            boolean chunksSuccess = sendBmpChunksWithProgress(chunks, callback);
            if (!chunksSuccess) {
                Log.e(TAG, "Failed to send BMP chunks");
                if (callback != null)
                    callback.onError("both", "Failed to send chunks");
                return;
            }

            // Send end command with retry
            boolean endSuccess = sendBmpEndCommandWithRetry();
            if (!endSuccess) {
                Log.e(TAG, "Failed to send BMP end command");
                if (callback != null)
                    callback.onError("both", "Failed to send end command");
                return;
            }

            // Calculate and send CRC with proper algorithm
            boolean crcSuccess = sendBmpCrcWithRetry(bmpData);
            if (!crcSuccess) {
                Log.e(TAG, "Failed to send BMP CRC");
                if (callback != null)
                    callback.onError("both", "CRC check failed");
                return;
            }

            lastThingDisplayedWasAnImage = true;

            if (callback != null) {
                callback.onSuccess("both");
            }

            Bridge.log("G1: BMP display process completed successfully");

        } catch (Exception e) {
            Log.e(TAG, "Error in displayBitmapImage: " + e.getMessage());
            if (callback != null)
                callback.onError("both", "Exception: " + e.getMessage());
        }
    }

    private List<byte[]> createBmpChunks(byte[] bmpData) {
        List<byte[]> chunks = new ArrayList<>();
        int totalChunks = (int) Math.ceil((double) bmpData.length / BMP_CHUNK_SIZE);
        Bridge.log("G1: Creating " + totalChunks + " chunks from " + bmpData.length + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            int start = i * BMP_CHUNK_SIZE;
            int end = Math.min(start + BMP_CHUNK_SIZE, bmpData.length);
            byte[] chunk = Arrays.copyOfRange(bmpData, start, end);

            // First chunk needs address bytes
            if (i == 0) {
                byte[] headerWithAddress = new byte[2 + GLASSES_ADDRESS.length + chunk.length];
                headerWithAddress[0] = 0x15; // Command
                headerWithAddress[1] = (byte) (i & 0xFF); // Sequence
                System.arraycopy(GLASSES_ADDRESS, 0, headerWithAddress, 2, GLASSES_ADDRESS.length);
                System.arraycopy(chunk, 0, headerWithAddress, 6, chunk.length);
                chunks.add(headerWithAddress);
            } else {
                byte[] header = new byte[2 + chunk.length];
                header[0] = 0x15; // Command
                header[1] = (byte) (i & 0xFF); // Sequence
                System.arraycopy(chunk, 0, header, 2, chunk.length);
                chunks.add(header);
            }
        }
        return chunks;
    }

    private boolean sendBmpChunksWithProgress(List<byte[]> chunks, BmpProgressCallback callback) {
        if (updatingScreen)
            return false;

        for (int i = 0; i < chunks.size(); i++) {
            byte[] chunk = chunks.get(i);
            Bridge.log("G1: Sending chunk " + i + " of " + chunks.size() + ", size: " + chunk.length);

            boolean success = sendDataSequentiallyWithTimeout(chunk, CHUNK_SEND_TIMEOUT_MS);
            if (!success) {
                Log.e(TAG, "Failed to send chunk " + i);
                return false;
            }

            // Report progress
            if (callback != null) {
                int offset = i * BMP_CHUNK_SIZE;
                callback.onProgress("both", offset, i, chunks.size() * BMP_CHUNK_SIZE);
            }

            // Platform-specific delay between chunks (matching Flutter implementation)
            try {
                Thread.sleep(ANDROID_CHUNK_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e(TAG, "Sleep interrupted: " + e.getMessage());
                return false;
            }
        }
        return true;
    }

    // Optimized chunk sending - mimics iOS approach
    private boolean sendBmpChunksOptimized(List<byte[]> chunks, BmpProgressCallback callback) {
        if (updatingScreen)
            return false;

        Bridge.log("G1: Sending " + chunks.size() + " chunks using OPTIMIZED method");

        // Send all chunks except last without waiting for response
        for (int i = 0; i < chunks.size() - 1; i++) {
            byte[] chunk = chunks.get(i);
            final int chunkIndex = i;

            if (USE_PARALLEL_BITMAP_WRITES && bitmapExecutor != null) {
                // Send to both glasses in parallel using executor
                CountDownLatch latch = new CountDownLatch(2);

                // Send to left glass
                bitmapExecutor.execute(() -> {
                    try {
                        if (leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
                            synchronized (leftTxChar) {
                                leftTxChar.setValue(chunk);
                                leftTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                                leftGlassGatt.writeCharacteristic(leftTxChar);
                                leftTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                            }
                        }
                    } finally {
                        latch.countDown();
                    }
                });

                // Send to right glass
                bitmapExecutor.execute(() -> {
                    try {
                        if (rightGlassGatt != null && rightTxChar != null && isRightConnected) {
                            synchronized (rightTxChar) {
                                rightTxChar.setValue(chunk);
                                rightTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                                rightGlassGatt.writeCharacteristic(rightTxChar);
                                rightTxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                            }
                        }
                    } finally {
                        latch.countDown();
                    }
                });

                // Wait for both to complete (but don't wait for BLE response)
                try {
                    latch.await(50, TimeUnit.MILLISECONDS); // Short timeout
                } catch (InterruptedException e) {
                    // Continue anyway
                }
            } else {
                // Fall back to sequential but still no wait
                sendBitmapChunkNoWait(chunk, true, true);
            }

            // Report progress
            if (callback != null) {
                int offset = chunkIndex * BMP_CHUNK_SIZE;
                callback.onProgress("both", offset, chunkIndex, chunks.size() * BMP_CHUNK_SIZE);
            }

            // Small delay between chunks (iOS uses 8ms)
            try {
                Thread.sleep(ANDROID_CHUNK_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e(TAG, "Sleep interrupted: " + e.getMessage());
                return false;
            }
        }

        // Last chunk - wait for confirmation (like iOS)
        if (!chunks.isEmpty()) {
            byte[] lastChunk = chunks.get(chunks.size() - 1);
            Bridge.log("G1: Sending last chunk with confirmation");

            boolean success = sendDataSequentiallyWithTimeout(lastChunk, 2000); // Shorter timeout for last chunk
            if (!success) {
                Log.e(TAG, "Failed to send last chunk");
                return false;
            }

            if (callback != null) {
                int offset = (chunks.size() - 1) * BMP_CHUNK_SIZE;
                callback.onProgress("both", offset, chunks.size() - 1, chunks.size() * BMP_CHUNK_SIZE);
            }
        }

        return true;
    }

    // Optimized end command sending
    private boolean sendBmpEndCommandOptimized() {
        Bridge.log("G1: Sending BMP end command (optimized)");

        // End command needs confirmation, but with shorter timeout
        boolean success = sendDataSequentiallyWithTimeout(END_COMMAND, 1000);
        if (success) {
            Bridge.log("G1: BMP end command sent successfully");

            // Small delay after end command
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                // Ignore
            }
        }
        return success;
    }

    // Optimized CRC sending
    private boolean sendBmpCrcOptimized(byte[] bmpData) {
        // Create data with address for CRC calculation
        byte[] dataWithAddress = new byte[GLASSES_ADDRESS.length + bmpData.length];
        System.arraycopy(GLASSES_ADDRESS, 0, dataWithAddress, 0, GLASSES_ADDRESS.length);
        System.arraycopy(bmpData, 0, dataWithAddress, GLASSES_ADDRESS.length, bmpData.length);

        // Calculate CRC32
        CRC32 crc = new CRC32();
        crc.update(dataWithAddress);
        long crcValue = crc.getValue();

        // Create CRC command packet
        byte[] crcCommand = new byte[5];
        crcCommand[0] = 0x16; // CRC command
        crcCommand[1] = (byte) ((crcValue >> 24) & 0xFF);
        crcCommand[2] = (byte) ((crcValue >> 16) & 0xFF);
        crcCommand[3] = (byte) ((crcValue >> 8) & 0xFF);
        crcCommand[4] = (byte) (crcValue & 0xFF);

        Bridge.log("G1: Sending CRC command (optimized), CRC value: " + Long.toHexString(crcValue));

        // CRC needs confirmation, but with shorter timeout
        boolean success = sendDataSequentiallyWithTimeout(crcCommand, 1000);
        if (success) {
            Bridge.log("G1: CRC command sent successfully");
        }
        return success;
    }

    private boolean sendDataSequentiallyWithTimeout(byte[] data, long timeoutMs) {
        // Create a future to track the send operation
        final boolean[] success = { false };
        final CountDownLatch latch = new CountDownLatch(1);

        // Send the data asynchronously
        new Thread(() -> {
            try {
                sendDataSequentially(data);
                success[0] = true;
            } catch (Exception e) {
                Log.e(TAG, "Error sending data: " + e.getMessage());
                success[0] = false;
            } finally {
                latch.countDown();
            }
        }).start();

        // Wait for completion or timeout
        try {
            boolean completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
            return completed && success[0];
        } catch (InterruptedException e) {
            Log.e(TAG, "Timeout waiting for data send");
            return false;
        }
    }

    private boolean sendBmpEndCommandWithRetry() {
        if (updatingScreen)
            return false;

        for (int attempt = 0; attempt < MAX_BMP_RETRY_ATTEMPTS; attempt++) {
            Bridge.log("G1: Sending BMP end command, attempt " + (attempt + 1));

            boolean success = sendDataSequentiallyWithTimeout(END_COMMAND, END_COMMAND_TIMEOUT_MS);
            if (success) {
                Bridge.log("G1: BMP end command sent successfully");
                return true;
            }

            Log.w(TAG, "BMP end command failed, attempt " + (attempt + 1));

            // Wait before retry
            try {
                Thread.sleep(BMP_RETRY_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e(TAG, "Sleep interrupted during retry");
                return false;
            }
        }

        Log.e(TAG, "Failed to send BMP end command after " + MAX_BMP_RETRY_ATTEMPTS + " attempts");
        return false;
    }

    private boolean sendBmpCrcWithRetry(byte[] bmpData) {
        // Create data with address for CRC calculation
        byte[] dataWithAddress = new byte[GLASSES_ADDRESS.length + bmpData.length];
        System.arraycopy(GLASSES_ADDRESS, 0, dataWithAddress, 0, GLASSES_ADDRESS.length);
        System.arraycopy(bmpData, 0, dataWithAddress, GLASSES_ADDRESS.length, bmpData.length);

        // Calculate CRC32-XZ (using standard CRC32 for now, but should be Crc32Xz)
        CRC32 crc = new CRC32();
        crc.update(dataWithAddress);
        long crcValue = crc.getValue();

        // Create CRC command packet
        byte[] crcCommand = new byte[5];
        crcCommand[0] = 0x16; // CRC command
        crcCommand[1] = (byte) ((crcValue >> 24) & 0xFF);
        crcCommand[2] = (byte) ((crcValue >> 16) & 0xFF);
        crcCommand[3] = (byte) ((crcValue >> 8) & 0xFF);
        crcCommand[4] = (byte) (crcValue & 0xFF);

        Bridge.log("G1: Sending CRC command, CRC value: " + Long.toHexString(crcValue));

        // Send CRC with retry
        for (int attempt = 0; attempt < MAX_BMP_RETRY_ATTEMPTS; attempt++) {
            boolean success = sendDataSequentiallyWithTimeout(crcCommand, CRC_COMMAND_TIMEOUT_MS);
            if (success) {
                Bridge.log("G1: CRC command sent successfully");
                return true;
            }

            Log.w(TAG, "CRC command failed, attempt " + (attempt + 1));

            try {
                Thread.sleep(BMP_RETRY_DELAY_MS);
            } catch (InterruptedException e) {
                Log.e(TAG, "Sleep interrupted during CRC retry");
                return false;
            }
        }

        Log.e(TAG, "Failed to send CRC command after " + MAX_BMP_RETRY_ATTEMPTS + " attempts");
        return false;
    }

    // Legacy methods for backward compatibility
    private void sendBmpChunks(List<byte[]> chunks) {
        sendBmpChunksWithProgress(chunks, null);
    }

    private void sendBmpEndCommand() {
        sendBmpEndCommandWithRetry();
    }

    private void sendBmpCRC(byte[] bmpData) {
        sendBmpCrcWithRetry(bmpData);
    }

    private void sendBmpToSide(byte[] bmpData, String side) {
        // For now, send to both sides but could be modified for side-specific sending
        displayBitmapImage(bmpData, new BmpProgressCallback() {
            @Override
            public void onProgress(String side, int offset, int chunkIndex, int totalSize) {
                Bridge.log("G1: BMP progress for " + side + ": " + offset + "/" + totalSize);
            }

            @Override
            public void onSuccess(String side) {
                Bridge.log("G1: BMP sent successfully to " + side);
            }

            @Override
            public void onError(String side, String error) {
                Log.e(TAG, "BMP error for " + side + ": " + error);
            }
        });
    }

    private byte[] loadBmpFromFile(String filePath) {
        try {
            java.io.File file = new java.io.File(filePath);
            if (!file.exists()) {
                Log.e(TAG, "BMP file does not exist: " + filePath);
                return null;
            }

            // Read file into byte array
            byte[] fileData = new byte[(int) file.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                fis.read(fileData);
            }

            // Convert to 1-bit BMP format if needed
            return convertTo1BitBmp(fileData);

        } catch (Exception e) {
            Log.e(TAG, "Error loading BMP file: " + e.getMessage());
            return null;
        }
    }

    private byte[] convertTo1BitBmp(byte[] originalBmp) {
        // This is a placeholder - in a real implementation, you'd convert the BMP to
        // 1-bit format
        // For now, we'll assume the input is already in the correct format
        return originalBmp;
    }

    private byte[] loadEmptyBmpFromAssets() {
        try {
            try (InputStream is = context.getAssets().open("empty_bmp.bmp")) {
                return is.readAllBytes();
            }
        } catch (IOException e) {
            Log.e(TAG, "Failed to load BMP from assets: " + e.getMessage());
            return null;
        }
    }

    public void clearBmpDisplay() {
        if (updatingScreen)
            return;
        Bridge.log("G1: Clearing BMP display with EXIT command");
        byte[] exitCommand = new byte[] { 0x18 };
        sendDataSequentially(exitCommand);
    }

    public void exitBmp() {
        clearBmpDisplay();
    }

    // Enhanced error handling and validation
    public boolean validateBmpFormat(byte[] bmpData) {
        if (bmpData == null || bmpData.length < 54) { // Minimum BMP header size
            Log.e(TAG, "Invalid BMP data: null or too short");
            return false;
        }

        // Check BMP signature
        if (bmpData[0] != 'B' || bmpData[1] != 'M') {
            Log.e(TAG, "Invalid BMP signature");
            return false;
        }

        // Check if it's 1-bit format (simplified check)
        int bitsPerPixel = bmpData[28] & 0xFF;
        if (bitsPerPixel != 1) {
            Log.w(TAG, "BMP is not 1-bit format (bits per pixel: " + bitsPerPixel + ")");
        }

        return true;
    }

    // Batch processing with progress
    public void sendBmpBatch(List<String> bmpPaths, BmpProgressCallback callback) {
        for (int i = 0; i < bmpPaths.size(); i++) {
            String path = bmpPaths.get(i);

            if (callback != null) {
                callback.onProgress("batch", i, i, bmpPaths.size());
            }

            try {
                byte[] bmpData = loadBmpFromFile(path);
                if (bmpData != null && validateBmpFormat(bmpData)) {
                    displayBitmapImage(bmpData, new BmpProgressCallback() {
                        @Override
                        public void onProgress(String side, int offset, int chunkIndex, int totalSize) {
                            // Individual image progress
                        }

                        @Override
                        public void onSuccess(String side) {
                            Bridge.log("G1: Successfully sent BMP: " + path);
                        }

                        @Override
                        public void onError(String side, String error) {
                            Log.e(TAG, "Failed to send BMP " + path + ": " + error);
                            if (callback != null) {
                                callback.onError("batch", "Failed to send " + path + ": " + error);
                            }
                        }
                    });

                    // Delay between images
                    Thread.sleep(2000);
                } else {
                    Log.e(TAG, "Invalid BMP format: " + path);
                    if (callback != null) {
                        callback.onError("batch", "Invalid BMP format: " + path);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error processing BMP " + path + ": " + e.getMessage());
                if (callback != null) {
                    callback.onError("batch", "Error processing " + path + ": " + e.getMessage());
                }
            }
        }

        if (callback != null) {
            callback.onSuccess("batch");
        }
    }

    private void sendLoremIpsum() {
        if (updatingScreen)
            return;
        String text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";
        sendDataSequentially(createTextWallChunks(text));
    }

    // Enhanced clearing with state management
    public void clearBmpDisplayWithState() {
        if (updatingScreen) {
            Bridge.log("G1: Screen update in progress, queuing clear command");
            // Queue the clear command for later
            handler.postDelayed(this::clearBmpDisplay, 1000);
            return;
        }

        Bridge.log("G1: Clearing BMP display with EXIT command");
        updatingScreen = true;

        try {
            byte[] exitCommand = new byte[] { 0x18 };
            boolean success = sendDataSequentiallyWithTimeout(exitCommand, 2000);
            if (success) {
                lastThingDisplayedWasAnImage = false;
                Bridge.log("G1: BMP display cleared successfully");
            } else {
                Log.e(TAG, "Failed to clear BMP display");
            }
        } finally {
            updatingScreen = false;
        }
    }

    // Optimized batch clearing
    public void clearAndDisplayBmp(byte[] bmpData, BmpProgressCallback callback) {
        if (updatingScreen) {
            Bridge.log("G1: Screen update in progress, cannot clear and display");
            if (callback != null)
                callback.onError("both", "Screen update in progress");
            return;
        }

        // Clear first, then display
        clearBmpDisplayWithState();

        // Small delay to ensure clear completes
        handler.postDelayed(() -> {
            displayBitmapImage(bmpData, callback);
        }, 500);
    }

    // Efficient multiple image display with clearing
    public void displayBmpSequence(List<byte[]> bmpDataList, BmpProgressCallback callback) {
        if (bmpDataList == null || bmpDataList.isEmpty()) {
            Log.e(TAG, "No BMP data provided for sequence");
            if (callback != null)
                callback.onError("sequence", "No BMP data provided");
            return;
        }

        displayBmpSequenceInternal(bmpDataList, 0, callback);
    }

    private void displayBmpSequenceInternal(List<byte[]> bmpDataList, int index, BmpProgressCallback callback) {
        if (index >= bmpDataList.size()) {
            Bridge.log("G1: BMP sequence completed");
            if (callback != null)
                callback.onSuccess("sequence");
            return;
        }

        byte[] bmpData = bmpDataList.get(index);
        displayBitmapImage(bmpData, new BmpProgressCallback() {
            @Override
            public void onProgress(String side, int offset, int chunkIndex, int totalSize) {
                if (callback != null) {
                    // Calculate overall progress including sequence position
                    int overallProgress = (index * 100) / bmpDataList.size();
                    callback.onProgress("sequence", overallProgress, index, bmpDataList.size());
                }
            }

            @Override
            public void onSuccess(String side) {
                Bridge.log("G1: BMP " + (index + 1) + " of " + bmpDataList.size() + " displayed successfully");

                // Schedule next image with delay
                handler.postDelayed(() -> {
                    displayBmpSequenceInternal(bmpDataList, index + 1, callback);
                }, 2000); // 2 second delay between images
            }

            @Override
            public void onError(String side, String error) {
                Log.e(TAG, "Failed to display BMP " + (index + 1) + ": " + error);
                if (callback != null) {
                    callback.onError("sequence", "Failed to display BMP " + (index + 1) + ": " + error);
                }
            }
        });
    }

    private void quickRestartG1() {
        Bridge.log("G1: Sending restart 0x23 0x72 Command");
        sendDataSequentially(new byte[] { (byte) 0x23, (byte) 0x72 }); // quick restart comand
    }

    public void setMicEnabled(boolean isMicrophoneEnabled) {
        Bridge.log("G1: setMicEnabled(): " + isMicrophoneEnabled);

        // Update the shouldUseGlassesMic flag to reflect the current state
        this.shouldUseGlassesMic = isMicrophoneEnabled;
        Bridge.log("G1: Updated shouldUseGlassesMic to: " + shouldUseGlassesMic);

        if (isMicrophoneEnabled) {
            Bridge.log("G1: Microphone enabled, starting audio input handling");
            sendSetMicEnabled(true, 10);
            startMicBeat((int) MICBEAT_INTERVAL_MS);
        } else {
            Bridge.log("G1: Microphone disabled, stopping audio input handling");
            sendSetMicEnabled(false, 10);
            stopMicBeat();
        }
    }

    public List<String> sortMicRanking(List<String> list) {
        return list;
    }

    /**
     * Returns whether the microphone is currently enabled
     *
     * @return true if microphone is enabled, false otherwise
     */
    public boolean isMicrophoneEnabled() {
        return micEnabled;
    }

    /**
     * Decodes Even G1 serial number to extract style and color information
     *
     * @param serialNumber The full serial number (e.g., "S110LABD020021")
     * @return Array containing [style, color] or ["Unknown", "Unknown"] if invalid
     */
    public static String[] decodeEvenG1SerialNumber(String serialNumber) {
        if (serialNumber == null || serialNumber.length() < 6) {
            return new String[] { "Unknown", "Unknown" };
        }

        // Style mapping: 3rd character (index 2)
        String style;
        switch (serialNumber.charAt(1)) {
            case '0':
                style = "Round";
                break;
            case '1':
                style = "Rectangular";
                break;
            default:
                style = "Round";
                break;
        }

        // Color mapping: 5th character (index 4)
        String color;
        switch (serialNumber.charAt(4)) {
            case 'A':
                color = "Grey";
                break;
            case 'B':
                color = "Brown";
                break;
            case 'C':
                color = "Green";
                break;
            default:
                color = "Grey";
                break;
        }

        return new String[] { style, color };
    }

    /**
     * Emits serial number information to React Native (matching iOS implementation)
     */
    private void emitSerialNumberInfo(String serialNumber, String style, String color) {
        try {
            JSONObject eventBody = new JSONObject();
            eventBody.put("type", "glasses_serial_number");
            eventBody.put("serialNumber", serialNumber);
            eventBody.put("style", style);
            eventBody.put("color", color);

            String jsonString = eventBody.toString();
            Bridge.sendEvent("CoreMessageEvent", jsonString);
            Bridge.log("G1: 📱 Emitted serial number info: " + serialNumber + ", Style: " + style + ", Color: " + color);

            // Trigger status update to include serial number in status JSON
            CoreManager.getInstance().handle_request_status();
        } catch (Exception e) {
            Bridge.log("G1: Error emitting serial number info: " + e.getMessage());
        }
    }

    /**
     * Decodes serial number from manufacturer data bytes
     *
     * @param manufacturerData The manufacturer data bytes
     * @return Decoded serial number string or null if not found
     */
    private String decodeSerialFromManufacturerData(byte[] manufacturerData) {
        if (manufacturerData == null || manufacturerData.length < 10) {
            return null;
        }

        try {
            // Convert hex bytes to ASCII string
            StringBuilder serialBuilder = new StringBuilder();
            for (int i = 0; i < manufacturerData.length; i++) {
                byte b = manufacturerData[i];
                if (b == 0x00) {
                    // Stop at null terminator
                    break;
                }
                if (b >= 0x20 && b <= 0x7E) {
                    // Only include printable ASCII characters
                    serialBuilder.append((char) b);
                }
            }

            String decodedString = serialBuilder.toString().trim();

            // Check if it looks like a valid Even G1 serial number
            if (decodedString.length() >= 12 &&
                    (decodedString.startsWith("S1") || decodedString.startsWith("100")
                            || decodedString.startsWith("110"))) {
                return decodedString;
            }

            return null;
        } catch (Exception e) {
            Log.e(TAG, "Error decoding manufacturer data: " + e.getMessage());
            return null;
        }
    }

    public void cleanup() {
        // TODO:
    }
}
