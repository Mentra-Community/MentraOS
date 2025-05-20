package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

import static com.augmentos.augmentos_core.smarterglassesmanager.utils.BitmapJavaUtils.convertBitmapTo1BitBmpBytes;

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
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.preference.PreferenceManager;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.BlockingQueue;

//BMP
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.zip.CRC32;
import java.nio.ByteBuffer;

import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.isMicEnabledForFrontendEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.HeadUpAngleEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.BitmapJavaUtils;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.G1FontLoader;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
import com.google.gson.Gson;
import com.augmentos.smartglassesmanager.cpp.L3cCpp;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BrightnessLevelEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchStopEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadDownEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadUpEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.R;

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

public class EvenRealitiesG1SGC extends SmartGlassesCommunicator {
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
    private static final UUID CLIENT_CHARACTERISTIC_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
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
    private int brightnessValue;

    private static final long DELAY_BETWEEN_SENDS_MS = 5; //not using now
    private static final long DELAY_BETWEEN_CHUNKS_SEND = 5; //super small just in case
    private static final long DELAY_BETWEEN_ACTIONS_SEND = 250; //not using now
    private static final long HEARTBEAT_INTERVAL_MS = 15000;
    private static final long MICBEAT_INTERVAL_MS = (1000 * 60) * 30; //micbeat every 30 minutes
    private int batteryLeft = -1;
    private int batteryRight = -1;
    private int leftReconnectAttempts = 0;
    private int rightReconnectAttempts = 0;
    private int reconnectAttempts = 0;  // Counts the number of reconnect attempts
    private static final long BASE_RECONNECT_DELAY_MS = 3000;  // Start with 3 seconds
    private static final long MAX_RECONNECT_DELAY_MS = 60000;

    //heartbeat sender
    private Handler heartbeatHandler = new Handler();
    private Handler findCompatibleDevicesHandler;
    private boolean isScanningForCompatibleDevices = false;
    private boolean isScanning = false;

    private Runnable heartbeatRunnable;

    //mic heartbeat turn on
    private Handler micBeatHandler = new Handler();
    private Runnable micBeatRunnable;

    //white list sender
    private Handler whiteListHandler = new Handler();
    private boolean whiteListedAlready = false;

    //mic enable Handler
    private Handler micEnableHandler = new Handler();
    private boolean micEnabledAlready = false;
    private boolean isMicrophoneEnabled = false; // Track current microphone state

    //notification period sender
    private Handler notificationHandler = new Handler();
    private Runnable notificationRunnable;
    private boolean notifysStarted = false;
    private int notificationNum = 10;

    //text wall periodic sender
    private Handler textWallHandler = new Handler();
    private Runnable textWallRunnable;
    private boolean textWallsStarted = false;
    private int textWallNum = 10;

    //pairing logic
    private boolean isLeftPairing = false;
    private boolean isRightPairing = false;
    private boolean isLeftBonded = false;
    private boolean isRightBonded = false;
    private BluetoothDevice leftDevice = null;
    private BluetoothDevice rightDevice = null;
    private String preferredG1Id = null;
    private String pendingSavedG1LeftName = null;
    private String pendingSavedG1RightName = null;
    private String savedG1LeftName = null;
    private String savedG1RightName = null;
    private String preferredG1DeviceId = null;

    //handler to turn off screen
    //Handler goHomeHandler;
    //Runnable goHomeRunnable;

    //Retry handler
    Handler retryBondHandler;
    private static final long BOND_RETRY_DELAY_MS = 5000; // 5-second backoff

    //remember when we connected
    private long lastConnectionTimestamp = 0;
    private SmartGlassesDevice smartGlassesDevice;

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

    // lock writing until the last write is successful
    //fonts in G1
    G1FontLoader fontLoader;

    private static final long DEBOUNCE_DELAY_MS = 270; // Minimum time between chunk sends
    private volatile long lastSendTimestamp = 0;
    private long lc3DecoderPtr = 0;

    public EvenRealitiesG1SGC(Context context, SmartGlassesDevice smartGlassesDevice) {
        super();
        this.context = context;
        loadPairedDeviceNames();
        //goHomeHandler = new Handler();
        this.smartGlassesDevice = smartGlassesDevice;
        preferredG1DeviceId = getPreferredG1DeviceId(context);
        brightnessValue = 50;
        shouldUseAutoBrightness = false;
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        this.shouldUseGlassesMic = SmartGlassesManager.getSensingEnabled(context) && !SmartGlassesManager.getForceCoreOnboardMic(context);

        //setup LC3 decoder
        if (lc3DecoderPtr == 0) {
            lc3DecoderPtr = L3cCpp.initDecoder();
        }

        //setup fonts
        fontLoader = new G1FontLoader(context);
    }

    private final BluetoothGattCallback leftGattCallback = createGattCallback("Left");
    private final BluetoothGattCallback rightGattCallback = createGattCallback("Right");

    private BluetoothGattCallback createGattCallback(String side) {
        return new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
//                Log.d(TAG, "ConnectionStateChanged");
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
                        Log.d(TAG, side + " glass connected, discovering services...");
                        if ("Left".equals(side)) {
                            isLeftConnected = true;
                            leftReconnectAttempts = 0;
                        } else {
                            isRightConnected = true;
                            rightReconnectAttempts = 0;
                        }

                        if (isLeftConnected && isRightConnected) {
                            stopScan();
                            Log.d(TAG, "Both glasses connected. Stopping BLE scan.");
                        }

                        Log.d(TAG, "Discover services calling...");
                        gatt.discoverServices();
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        Log.d(TAG, side + " glass disconnected, stopping heartbeats");
                        Log.d(TAG, "Entering STATE_DISCONNECTED branch for side: " + side);

                        // Mark both sides as not ready (you could also clear both if one disconnects)
                        leftServicesWaiter.setTrue();
                        rightServicesWaiter.setTrue();
                        Log.d(TAG, "Set leftServicesWaiter and rightServicesWaiter to true.");

                        forceSideDisconnection();
                        Log.d(TAG, "Called forceSideDisconnection().");

                        // Stop any periodic transmissions
                        stopHeartbeat();
                        stopMicBeat();
                        sendQueue.clear();
                        Log.d(TAG, "Stopped heartbeat and mic beat; cleared sendQueue.");

                        updateConnectionState();
                        Log.d(TAG, "Updated connection state after disconnection.");

                        // Compute reconnection delay for both sides (here you could choose the maximum of the two delays or a new delay)
//                        long delayLeft = Math.min(BASE_RECONNECT_DELAY_MS * (1L << leftReconnectAttempts), MAX_RECONNECT_DELAY_MS);
//                        long delayRight = Math.min(BASE_RECONNECT_DELAY_MS * (1L << rightReconnectAttempts), MAX_RECONNECT_DELAY_MS);
                        long delay = 2000; // or choose another strategy
//                        Log.d(TAG, "Computed delayLeft: " + delayLeft + " ms, delayRight: " + delayRight + " ms. Using delay: " + delay + " ms.");

                        Log.d(TAG, side + " glass disconnected. Scheduling reconnection for both glasses in " + delay + " ms (Left attempts: " + leftReconnectAttempts + ", Right attempts: " + rightReconnectAttempts + ")");

//                        if (gatt.getDevice() != null) {
//                            // Close the current gatt connection
//                            Log.d(TAG, "Closing GATT connection for device: " + gatt.getDevice().getAddress());
//                            gatt.disconnect();
//                            gatt.close();
//                            Log.d(TAG, "GATT connection closed.");
//                        } else {
//                            Log.d(TAG, "No GATT device available to disconnect.");
//                        }

                        // Schedule a reconnection for both devices after the delay
                        reconnectHandler.postDelayed(() -> {
                            Log.d(TAG, "Reconnect handler triggered after delay.");
                            if (gatt.getDevice() != null && !isKilled) {
                                Log.d(TAG, "Reconnecting to both glasses. isKilled = " + isKilled);
                                // Assuming you have stored references to both devices:
                                if (leftDevice != null) {
                                    Log.d(TAG, "Attempting to reconnect to leftDevice: " + leftDevice.getAddress());
                                    reconnectToGatt(leftDevice);
                                } else {
                                    Log.d(TAG, "Left device reference is null.");
                                }
                                if (rightDevice != null) {
                                    Log.d(TAG, "Attempting to reconnect to rightDevice: " + rightDevice.getAddress());
                                    reconnectToGatt(rightDevice);
                                } else {
                                    Log.d(TAG, "Right device reference is null.");
                                }
                            } else {
                                Log.d(TAG, "Reconnect handler aborted: either no GATT device or system is killed.");
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

                    Log.d(TAG, "Stopped heartbeat and mic beat; cleared sendQueue due to connection failure.");

                    Log.e(TAG, side + " glass connection failed with status: " + status);
                    if ("Left".equals(side)) {
                        isLeftConnected = false;
                        leftReconnectAttempts++;
                        if (leftGlassGatt != null){
                            leftGlassGatt.disconnect();
                            leftGlassGatt.close();
                        }
                        leftGlassGatt = null;
                    } else {
                        isRightConnected = false;
                        rightReconnectAttempts++;
                        if (rightGlassGatt != null){
                            rightGlassGatt.disconnect();
                            rightGlassGatt.close();
                        }
                        rightGlassGatt = null;
                    }

                    forceSideDisconnection();
                    Log.d(TAG, "Called forceSideDisconnection() after connection failure.");

//                    gatt.disconnect();
//                    gatt.close();
                    Log.d(TAG, "GATT connection disconnected and closed due to failure.");

                    connectHandler.postDelayed(() -> {
                        Log.d(TAG, "Attempting GATT connection for leftDevice immediately.");
                        attemptGattConnection(leftDevice);
                    }, 0);

                    connectHandler.postDelayed(() -> {
                        Log.d(TAG, "Attempting GATT connection for rightDevice after 2000 ms delay.");
                        attemptGattConnection(rightDevice);
                    }, 400);
                }
            }

            private void forceSideDisconnection() {
                Log.d(TAG, "forceSideDisconnection() called for side: " + side);
                // Force disconnection from the other side if necessary
                if ("Left".equals(side)) {
                    isLeftConnected = false;
                    leftReconnectAttempts++;
                    Log.d(TAG, "Left glass: Marked as disconnected and incremented leftReconnectAttempts to " + leftReconnectAttempts);
                    if (leftGlassGatt != null) {
                        Log.d(TAG, "Left glass GATT exists. Disconnecting and closing leftGlassGatt.");
                        leftGlassGatt.disconnect();
                        leftGlassGatt.close();
                        leftGlassGatt = null;
                    } else {
                        Log.d(TAG, "Left glass GATT is already null.");
                    }
                    // If right is still connected, disconnect it too
                    if (rightGlassGatt != null) {
                        Log.d(TAG, "Left glass disconnected - forcing disconnection from right glass.");
                        rightGlassGatt.disconnect();
                        rightGlassGatt.close();
                        rightGlassGatt = null;
                        isRightConnected = false;
                        rightReconnectAttempts++;
                        Log.d(TAG, "Right glass marked as disconnected and rightReconnectAttempts incremented to " + rightReconnectAttempts);
                    } else {
                        Log.d(TAG, "Right glass GATT already null, no action taken.");
                    }
                } else { // side equals "Right"
                    isRightConnected = false;
                    rightReconnectAttempts++;
                    Log.d(TAG, "Right glass: Marked as disconnected and incremented rightReconnectAttempts to " + rightReconnectAttempts);
                    if (rightGlassGatt != null) {
                        Log.d(TAG, "Right glass GATT exists. Disconnecting and closing rightGlassGatt.");
                        rightGlassGatt.disconnect();
                        rightGlassGatt.close();
                        rightGlassGatt = null;
                    } else {
                        Log.d(TAG, "Right glass GATT is already null.");
                    }
                    // If left is still connected, disconnect it too
                    if (leftGlassGatt != null) {
                        Log.d(TAG, "Right glass disconnected - forcing disconnection from left glass.");
                        leftGlassGatt.disconnect();
                        leftGlassGatt.close();
                        leftGlassGatt = null;
                        isLeftConnected = false;
                        leftReconnectAttempts++;
                        Log.d(TAG, "Left glass marked as disconnected and leftReconnectAttempts incremented to " + leftReconnectAttempts);
                    } else {
                        Log.d(TAG, "Left glass GATT already null, no action taken.");
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
            public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    Log.d(TAG, "PROC_QUEUE - " + side + " glass write successful");
                } else {
                    Log.e(TAG, side + " glass write failed with status: " + status);

                    if(status == 133) {
                        Log.d(TAG, "GOT THAT 133 STATUS!");

                    }
                }

                //clear the waiter
                if ("Left".equals(side)) {
                    leftWaiter.setFalse();
                } else {
                    rightWaiter.setFalse();
                }
            }

            @Override
            public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
                Log.d(TAG, "PROC - GOT DESCRIPTOR WRITE: " + status);

                //clear the waiter
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
                        if (deviceName == null) return;

                        // Handle MIC audio data
                        if (data.length > 0 && (data[0] & 0xFF) == 0xF1) {
                            // Log.d(TAG, "Lc3 Audio data received. Data: " + Arrays.toString(data) + ", from: " + deviceName);
                            int seq = data[1] & 0xFF; // Sequence number
                            // eg. LC3 to PCM
                            byte[] lc3 = Arrays.copyOfRange(data, 2, 202);
//                            byte[] pcmData = L3cCpp.decodeLC3(lc3);
//                            if (pcmData == null) {
//                                throw new IllegalStateException("Failed to decode LC3 data");
//                            }

                            if (deviceName.contains("R_")) {
                                //decode the LC3 audio
                                if (lc3DecoderPtr != 0) {
                                    byte[] pcmData = L3cCpp.decodeLC3(lc3DecoderPtr, lc3);
                                    //send the PCM out
                                    if (shouldUseGlassesMic) {
                                        if (audioProcessingCallback != null) {
                                            if (pcmData != null && pcmData.length > 0) {
                                                audioProcessingCallback.onAudioDataAvailable(pcmData);
                                            }
                                        } else {
                                            // If we get here, it means the callback wasn't properly registered
                                            Log.e(TAG, "Audio processing callback is null - callback registration failed!");
                                        }
                                    }

//                                    if (shouldUseGlassesMic) { TODO: add this back if needed
//                                        EventBus.getDefault().post(new AudioChunkNewEvent(pcmData));
//                                    } else {
//                                        Log.e(TAG, "Failed to decode LC3 frame, got null or empty result");
//                                    }
                                }

                            //send through the LC3
                            audioProcessingCallback.onLC3AudioDataAvailable(lc3);

                        } else {
                            // Log.d(TAG, "Lc3 Audio data received. Seq: " + seq + ", Data: " + Arrays.toString(lc3) + ", from: " + deviceName);
                        }
                    }
                        //HEAD UP MOVEMENTS
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x02) {
                            // Only check head movements from the right sensor
                            if (deviceName.contains("R_")) {
                                // Check for head down movement - initial F5 02 signal
                                Log.d(TAG, "HEAD UP MOVEMENT DETECTED");
                                EventBus.getDefault().post(new GlassesHeadUpEvent());
                            }
                        }
                        //HEAD DOWN MOVEMENTS
                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && (data[1] & 0xFF) == 0x03) {
                            if (deviceName.contains("R_")) {
                                 Log.d(TAG, "HEAD DOWN MOVEMENT DETECTED");
                                //                                clearBmpDisplay();
                                EventBus.getDefault().post(new GlassesHeadDownEvent());
                            }
                        }
                        //DOUBLE TAP
                        //appears to be completely broken - clears the screen - we should not tell people to use the touchpads yet til this is fixed
//                        else if (data.length > 1 && (data[0] & 0xFF) == 0xF5 && ((data[1] & 0xFF) == 0x20) || ((data[1] & 0xFF) == 0x00)) {
//                            boolean isRight = deviceName.contains("R_");
//                            Log.d(TAG, "GOT DOUBLE TAP from isRight?: " + isRight);
//                            EventBus.getDefault().post(new GlassesTapOutputEvent(2, isRight, System.currentTimeMillis()));
//                        }
                        //BATTERY RESPONSE
                        else if (data.length > 2 && data[0] == 0x2C && data[1] == 0x66) {
                            if (deviceName.contains("L_")) {
                                //Log.d(TAG, "LEFT Battery response received");
                                batteryLeft = data[2];
                            } else if (deviceName.contains("R_")) {
                                //Log.d(TAG, "RIGHT Battery response received");
                                batteryRight = data[2];
                            }

                            if(batteryLeft != -1 && batteryRight != -1) {
                                int minBatt = Math.min(batteryLeft, batteryRight);
                                //Log.d(TAG, "Minimum Battery Level: " + minBatt);
                                EventBus.getDefault().post(new BatteryLevelEvent(minBatt, false));
                            }
                        }
                        //HEARTBEAT RESPONSE
                        else if (data.length > 0 && data[0] == 0x25) {
                            Log.d(TAG, "Heartbeat response received");
                        }
                        //TEXT RESPONSE
                        else if (data.length > 0 && data[0] == 0x4E) {
                            Log.d(TAG, "Text response on side " + (deviceName.contains("L_") ? "Left" : "Right") + " was: " + ((data.length > 1 && (data[1] & 0xFF) == 0xC9) ? "SUCCEED" : "FAIL"));
                        }


                        // Handle other non-audio responses
                        else {
                            Log.d(TAG, "PROC - Received other Even Realities response: " + bytesToHex(data) + ", from: " + deviceName);
                        }

                        //clear the waiter
//                        if ((data.length > 1 && (data[1] & 0xFF) == 0xC9)){
//                            if (deviceName.contains("L_")) {
//                                Log.d(TAG, "PROC - clearing LEFT waiter on success");
//                                leftWaiter.setFalse();
//                            } else {
//                                Log.d(TAG, "PROC - clearing RIGHT waiter on success");
//                                rightWaiter.setFalse();
//                            }
//                        }
                    }
                });
            }

        };
    }

    private void initG1s(BluetoothGatt gatt, String side){
        gatt.requestMtu(251); // Request a higher MTU size
        Log.d(TAG, "Requested MTU size: 251");

        BluetoothGattService uartService = gatt.getService(UART_SERVICE_UUID);

        if (uartService != null) {
            BluetoothGattCharacteristic txChar = uartService.getCharacteristic(UART_TX_CHAR_UUID);
            BluetoothGattCharacteristic rxChar = uartService.getCharacteristic(UART_RX_CHAR_UUID);

            if (txChar != null) {
                if ("Left".equals(side)) leftTxChar = txChar;
                else rightTxChar = txChar;
//                            enableNotification(gatt, txChar, side);
//                            txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Log.d(TAG, side + " glass TX characteristic found");
            }

            if (rxChar != null) {
                if ("Left".equals(side)) leftRxChar = rxChar;
                else rightRxChar = rxChar;
                enableNotification(gatt, rxChar, side);
//                            rxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Log.d(TAG, side + " glass RX characteristic found");
            }


            // Mark as connected but wait for setup below to update connection state
            if ("Left".equals(side)) {
                isLeftConnected = true;
                //Log.d(TAG, "PROC_QUEUE - left side setup complete");
            } else {
                isRightConnected = true;
                //Log.d(TAG, "PROC_QUEUE - right side setup complete");
            }

            //setup the G1s
            if (isLeftConnected && isRightConnected) {
                Log.d(TAG, "Sending firmware request Command");
                sendDataSequentially(new byte[]{(byte) 0x6E, (byte) 0x74});

                Log.d(TAG, "Sending init 0x4D Command");
                sendDataSequentially(new byte[]{(byte) 0x4D, (byte) 0xFB}); //told this is only left

                Log.d(TAG, "Sending turn off wear detection command");
                sendDataSequentially(new byte[]{(byte) 0x27, (byte) 0x00});

                Log.d(TAG, "Sending turn off silent mode Command");
                sendDataSequentially(new byte[]{(byte) 0x03, (byte) 0x0A});

                //debug command
//                            Log.d(TAG, "Sending debug 0xF4 Command");
//                            sendDataSequentially(new byte[]{(byte) 0xF4, (byte) 0x01});

                //no longer need to be staggered as we fixed the sender
                //do first battery status query
                queryBatteryStatusHandler.postDelayed(() -> queryBatteryStatus(), 10);

                //setup brightness
                sendBrightnessCommandHandler.postDelayed(() -> sendBrightnessCommand(brightnessValue, shouldUseAutoBrightness), 10);

                // Maybe start MIC streaming
                setMicEnabled(false, 10); // Disable the MIC

                //enable our AugmentOS notification key
                sendWhiteListCommand(10);

                //start heartbeat
                startHeartbeat(10000);

                //start mic beat
//                startMicBeat(30000);

                showHomeScreen(); //turn on the g1 display

                updateConnectionState();

                //start sending debug notifications
                //                        startPeriodicNotifications(302);
                //start sending debug notifications
                //                        startPeriodicTextWall(302);
            }
        } else {
            Log.e(TAG, side + " glass UART service not found");
        }
    }

    //working on all phones - must keep the delay
    private void enableNotification(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, String side) {
        Log.d(TAG, "PROC_QUEUE - Starting notification setup for " + side);

        // Simply enable notifications
        Log.d(TAG, "PROC_QUEUE - setting characteristic notification on side: " + side);
        boolean result = gatt.setCharacteristicNotification(characteristic, true);
        Log.d(TAG, "PROC_QUEUE - setCharacteristicNotification result for " + side + ": " + result);

        // Set write type for the characteristic
        characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        Log.d(TAG, "PROC_QUEUE - write type set for " + side);

        //wait
        Log.d(TAG, "PROC_QUEUE - waiting to enable it on this side: " + side);

        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Log.e(TAG, "Error sending data: " + e.getMessage());
        }

        Log.d(TAG, "PROC_QUEUE - get descriptor on side: " + side);
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID);
        if (descriptor != null) {
            Log.d(TAG, "PROC_QUEUE - setting descriptor on side: " + side);
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            boolean r_result = gatt.writeDescriptor(descriptor);
            Log.d(TAG, "PROC_QUEUE - set descriptor on side: " + side + " with result: " + r_result);
        }
    }

    private void updateConnectionState() {
        if (isLeftConnected && isRightConnected) {
            connectionState = SmartGlassesConnectionState.CONNECTED;
            Log.d(TAG, "Both glasses connected");
            lastConnectionTimestamp = System.currentTimeMillis();
            connectionEvent(connectionState);
        } else if (isLeftConnected || isRightConnected) {
            connectionState = SmartGlassesConnectionState.CONNECTING;
            Log.d(TAG, "One glass connected");
            connectionEvent(connectionState);
        } else {
            connectionState = SmartGlassesConnectionState.DISCONNECTED;
            Log.d(TAG, "No glasses connected");
            connectionEvent(connectionState);
        }
    }

    private final BroadcastReceiver bondingReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device.getName() == null) {
                    Log.d(TAG, "Bluetooth Device Name is Null!!!");
                    return;
                }

                int bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);

                if (bondState == BluetoothDevice.BOND_BONDED) {
                    Log.d(TAG, "Bonded with device: " + device.getName());
                    if (device.getName().contains("_L_")) {
                        isLeftBonded = true;
                        isLeftPairing = false;
                        pendingSavedG1LeftName = device.getName();
                    } else if (device.getName().contains("_R_")) {
                        isRightBonded = true;
                        isRightPairing = false;
                        pendingSavedG1RightName = device.getName();
                    }

                    // Restart scan for the next device
                    if (!isLeftBonded || !isRightBonded) {
                        // if (!(isLeftBonded && !isRightBonded)){// || !doPendingPairingIdsMatch()) {
                        Log.d(TAG, "Restarting scan to find remaining device...");
                        startScan();
                    } else if (isLeftBonded && isRightBonded && !doPendingPairingIdsMatch()) {
                        // We've connected to two different G1s...
                        // Let's unpair the right, try to pair to a different one
                        isRightBonded = false;
                        isRightConnected = false;
                        isRightPairing = false;
                        pendingSavedG1RightName = null;
                        Log.d(TAG, "Connected to two different G1s - retry right G1 arm");
                    } else {
                        Log.d(TAG, "Both devices bonded. Proceeding with connections...");
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
                    Log.d(TAG, "Bonding failed for device: " + device.getName());
                    if (device.getName().contains("_L_")) isLeftPairing = false;
                    if (device.getName().contains("_R_")) isRightPairing = false;

                    // Restart scanning to retry bonding
                    if (retryBondHandler == null) {
                        retryBondHandler = new Handler(Looper.getMainLooper());
                    }

                    retryBondHandler.postDelayed(() -> {
                        Log.d(TAG, "Retrying scan after bond failure...");
                        startScan();
                    }, BOND_RETRY_DELAY_MS);
                }
            }
        }
    };

    public boolean doPendingPairingIdsMatch() {
        String leftId = parsePairingIdFromDeviceName(pendingSavedG1LeftName);
        String rightId = parsePairingIdFromDeviceName(pendingSavedG1RightName);
        Log.d(TAG, "LeftID: " + leftId);
        Log.d(TAG, "RightID: " + rightId);

        //ok, HACKY, but if one of them is null, that means that we connected to the other on a previous connect
        //this whole function shouldn't matter anymore anyway as we properly filter for the device name, so it should be fine
        //in the future, the way to actually check this would be to check the final ID string, which is the only one guaranteed to be unique
        if (leftId == null || rightId == null){
            return true;
        }

        return leftId != null && leftId.equals(rightId);
    }
    public String parsePairingIdFromDeviceName(String input) {
        if (input == null || input.isEmpty()) return null;
        // Regular expression to match the number after "G1_"
        Pattern pattern = Pattern.compile("G1_(\\d+)_");
        Matcher matcher = pattern.matcher(input);

        if (matcher.find()) {
            return matcher.group(1); // Group 1 contains the number
        }
        return null; // Return null if no match is found
    }

    public static void savePreferredG1DeviceId(Context context, String deviceName){
        context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(SAVED_G1_ID_KEY, deviceName)
                .apply();
    }

    public static String getPreferredG1DeviceId(Context context){
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getString(SAVED_G1_ID_KEY, null);
    }

//    public static int getSavedBrightnessValue(Context context){
//        return Integer.parseInt(PreferenceManager.getDefaultSharedPreferences(context).getString(context.getResources().getString(R.string.SHARED_PREF_BRIGHTNESS), "50"));
//    }

//    public static boolean getSavedAutoBrightnessValue(Context context){
//        return PreferenceManager.getDefaultSharedPreferences(context).getBoolean(context.getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), false);
//    }

    private void savePairedDeviceNames() {
        if (savedG1LeftName != null && savedG1RightName != null) {
            context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(LEFT_DEVICE_KEY, savedG1LeftName)
                    .putString(RIGHT_DEVICE_KEY, savedG1RightName)
                    .apply();
            Log.d(TAG, "Saved paired device names: Left=" + savedG1LeftName + ", Right=" + savedG1RightName);
        }
    }

    private void loadPairedDeviceNames() {
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
        savedG1LeftName = prefs.getString(LEFT_DEVICE_KEY, null);
        savedG1RightName = prefs.getString(RIGHT_DEVICE_KEY, null);
        Log.d(TAG, "Loaded paired device names: Left=" + savedG1LeftName + ", Right=" + savedG1RightName);
    }

    public static void deleteEvenSharedPreferences(Context context) {
        savePreferredG1DeviceId(context, null);
        SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().clear().apply();
        Log.d(TAG, "Nuked EvenRealities SharedPreferences");
    }

    private void connectToGatt(BluetoothDevice device) {
        if (device == null) {
            Log.e(TAG, "Cannot connect to GATT: device is null");
            return;
        }

        Log.d(TAG, "connectToGatt called for device: " + device.getName() + " (" + device.getAddress() + ")");
        BluetoothAdapter bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Bluetooth is disabled or not available. Cannot reconnect to glasses.");
            return;
        }

        // Reset the services waiter based on device name
        if (device.getName().contains("_L_")) {
            Log.d(TAG, "Device identified as left side. Resetting leftServicesWaiter.");
            leftServicesWaiter.setTrue();
        } else {
            Log.d(TAG, "Device identified as right side. Resetting rightServicesWaiter.");
            rightServicesWaiter.setTrue();
        }

        // Establish GATT connection based on device name and current connection state
        if (device.getName().contains("_L_") && leftGlassGatt == null) {
            Log.d(TAG, "Connecting GATT to left side.");
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback);
            isLeftConnected = false; // Reset connection state
            Log.d(TAG, "Left GATT connection initiated. isLeftConnected set to false.");
        } else if (device.getName().contains("_R_") && rightGlassGatt == null && isLeftConnected) {
            Log.d(TAG, "Connecting GATT to right side.");
            rightGlassGatt = device.connectGatt(context, false, rightGattCallback);
            isRightConnected = false; // Reset connection state
            Log.d(TAG, "Right GATT connection initiated. isRightConnected set to false.");
        } else {
            Log.d(TAG, "Tried to connect to incorrect or already connected device: " + device.getName());
        }
    }

    private void reconnectToGatt(BluetoothDevice device) {
        if (isKilled){
            return;
        }
        connectToGatt(device); // Reuse the connectToGatt method
    }

//    private void startConnectionTimeout(String side, BluetoothGatt gatt) {
//        Runnable timeoutRunnable = () -> {
//            if ("Left".equals(side)) {
//                if (!isLeftConnected) {
//                    Log.d(TAG, "Left connection timed out. Closing GATT and retrying...");
//                    if (leftGlassGatt != null) {
//                        leftGlassGatt.disconnect();
//                        leftGlassGatt.close();
//                        leftGlassGatt = null;
//                    }
//                    leftReconnectAttempts++;
//                    scheduleReconnect("Left", gatt.getDevice());
//                }
//            } else if ("Right".equals(side)) {
//                if (!isRightConnected) {
//                    Log.d(TAG, "Right connection timed out. Closing GATT and retrying...");
//                    if (rightGlassGatt != null) {
//                        rightGlassGatt.disconnect();
//                        rightGlassGatt.close();
//                        rightGlassGatt = null;
//                    }
//                    rightReconnectAttempts++;
//                    scheduleReconnect("Right", gatt.getDevice());
//                }
//            }
//        };
//
//        if ("Left".equals(side)) {
//            leftConnectionTimeoutRunnable = timeoutRunnable;
//            leftConnectionTimeoutHandler.postDelayed(leftConnectionTimeoutRunnable, CONNECTION_TIMEOUT_MS);
//        } else if ("Right".equals(side)) {
//            rightConnectionTimeoutRunnable = timeoutRunnable;
//            rightConnectionTimeoutHandler.postDelayed(rightConnectionTimeoutRunnable, CONNECTION_TIMEOUT_MS);
//        }
//    }

//    private void scheduleReconnect(String side, BluetoothDevice device) {
//        long delay;
//        if ("Left".equals(side)) {
//            delay = Math.min(BASE_RECONNECT_DELAY_MS * (1L << leftReconnectAttempts), MAX_RECONNECT_DELAY_MS);
//            Log.d(TAG, side + " glass reconnecting in " + delay + " ms (Attempt " + leftReconnectAttempts + ")");
//        } else { // "Right"
//            delay = Math.min(BASE_RECONNECT_DELAY_MS * (1L << rightReconnectAttempts), MAX_RECONNECT_DELAY_MS);
//            Log.d(TAG, side + " glass reconnecting in " + delay + " ms (Attempt " + rightReconnectAttempts + ")");
//        }
//
//        reconnectHandler.postDelayed(() -> reconnectToGatt(device), delay);
//    }

    private final ScanCallback modernScanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String name = device.getName();

            // Now you can reference the bluetoothAdapter field if needed:
            if (!bluetoothAdapter.isEnabled()) {
                Log.e(TAG, "Bluetooth is disabled");
                return;
            }

            // Check if G1 arm
            if (name == null || !name.contains("Even G1_")) {
                return;
            }

//            Log.d(TAG, "PREFERRED ID: " + preferredG1DeviceId);
            if (preferredG1DeviceId == null || !name.contains(preferredG1DeviceId + "_")) {
                Log.d(TAG, "NOT PAIRED GLASSES");
                return;
            }


            Log.d(TAG, "FOUND OUR PREFERRED ID: " + preferredG1DeviceId);

            boolean isLeft = name.contains("_L_");

            // If we already have saved device names for left/right...
            if (savedG1LeftName != null && savedG1RightName != null) {
                if (!(name.contains(savedG1LeftName) || name.contains(savedG1RightName))) {
                    return; // Not a matching device
                }
            }

            // Identify which side (left/right)
            if (isLeft) {
                leftDevice = device;
            } else {
                rightDevice = device;
            }

            int bondState = device.getBondState();
            if (bondState != BluetoothDevice.BOND_BONDED) {
                // Stop scan before initiating bond
                stopScan();

                if (isLeft && !isLeftPairing && !isLeftBonded) {
//                    Log.d(TAG, "Bonding with Left Glass...");
                    isLeftPairing = true;
                    connectionState = SmartGlassesConnectionState.BONDING;
                    connectionEvent(connectionState);
                    bondDevice(device);
                } else if (!isLeft && !isRightPairing && !isRightBonded) {
//                    Log.d(TAG, "Bonding with Right Glass...");
                    isRightPairing = true;
                    connectionState = SmartGlassesConnectionState.BONDING;
                    connectionEvent(connectionState);
                    bondDevice(device);
                } else {
                    Log.d(TAG, "Not running a53dd");
                }
            } else {
                // Already bonded
                if (isLeft) isLeftBonded = true; else isRightBonded = true;

                // Both are bonded => connect to GATT
                if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
                    Log.d(TAG, "Both sides bonded. Ready to connect to GATT.");
                    stopScan();

                    connectHandler.postDelayed(() -> {
                        attemptGattConnection(leftDevice);
                    },0);

                    connectHandler.postDelayed(() -> {
                        attemptGattConnection(rightDevice);
                    },2000);
                } else {
                    Log.d(TAG, "Not running a63dd");
                }
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.e(TAG, "Scan failed with error: " + errorCode);
        }
    };

    private void resetAllBondsAndState() {
        Log.d(TAG, "Resetting ALL bonds and internal state for complete fresh start");

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
            Log.d(TAG, "Restarting scan after complete bond/state reset");
            connectionState = SmartGlassesConnectionState.SCANNING;
            connectionEvent(connectionState);
            startScan();
        }, 2000);
    }

    /**
     * Handles a device with a valid bond
     */
    private void handleValidBond(BluetoothDevice device, boolean isLeft) {
        Log.d(TAG, "Handling valid bond for " + (isLeft ? "left" : "right") + " glass");

        // Update state
        if (isLeft) {
            isLeftBonded = true;
        } else {
            isRightBonded = true;
        }

        // If both glasses are bonded, connect to GATT
        if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
            Log.d(TAG, "Both glasses have valid bonds - ready to connect to GATT");

            connectHandler.postDelayed(() -> {
                attemptGattConnection(leftDevice);
            }, 0);

            connectHandler.postDelayed(() -> {
                attemptGattConnection(rightDevice);
            }, 2000);
        } else {
            // Continue scanning for the other glass
            Log.d(TAG, "Still need to find " + (isLeft ? "right" : "left") + " glass - resuming scan");
            startScan();
        }
    }

    /**
     * Removes an existing bond with a Bluetooth device to force fresh pairing
     */
    private boolean removeBond(BluetoothDevice device) {
        try {
            if (device == null) {
                Log.e(TAG, "Cannot remove bond: device is null");
                return false;
            }

            Method method = device.getClass().getMethod("removeBond");
            boolean result = (Boolean) method.invoke(device);
            Log.d(TAG, "Removing bond for device " + device.getName() + ", result: " + result);
            return result;
        } catch (Exception e) {
            Log.e(TAG, "Error removing bond: " + e.getMessage(), e);
            return false;
        }
    }

    @Override
    public void connectToSmartGlasses() {
        // Register bonding receiver
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        context.registerReceiver(bondingReceiver, filter);
        isBondingReceiverRegistered=true;

        preferredG1DeviceId = getPreferredG1DeviceId(context);

        if(!bluetoothAdapter.isEnabled()) {

            return;
        }

        // Start scanning for devices
        connectionState = SmartGlassesConnectionState.SCANNING;
        connectionEvent(connectionState);
        startScan();
    }

    private void startScan() {
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            Log.e(TAG, "BluetoothLeScanner not available.");
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
        Log.d(TAG, "CALL START SCAN - Started scanning for devices...");

        // Stop the scan after some time (e.g., 10-15s instead of 60 to avoid throttling)
        //handler.postDelayed(() -> stopScan(), 10000);
    }

    private void stopScan() {
        BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner != null) {
            scanner.stopScan(modernScanCallback);
        }
        isScanning = false;
        Log.d(TAG, "Stopped scanning for devices");
    }

    private void bondDevice(BluetoothDevice device) {
        try {
            Log.d(TAG, "Attempting to bond with device: " + device.getName());
            Method method = device.getClass().getMethod("createBond");
            method.invoke(device);
        } catch (Exception e) {
            Log.e(TAG, "Bonding failed: " + e.getMessage());
        }
    }

    private Runnable rightConnectionRetryRunnable;
    private static final long RIGHT_CONNECTION_RETRY_DELAY = 1000; // 1 second

    private void attemptGattConnection(BluetoothDevice device) {
//        if (!isKilled)

        if (device == null) {
            Log.d(TAG, "Cannot connect to GATT: Device is null");
            return;
        }

        String deviceName = device.getName();
        Log.d(TAG, "attemptGattConnection called for device: " + deviceName + " (" + device.getAddress() + ")");

        // Check if both devices are bonded before attempting connection
        if (!isLeftBonded || !isRightBonded) {
            Log.d(TAG, "Cannot connect to GATT: Both devices are not bonded yet (isLeftBonded: " + isLeftBonded + ", isRightBonded: " + isRightBonded + ")");
            return;
        }

        connectionState = SmartGlassesConnectionState.CONNECTING;
        Log.d(TAG, "Setting connectionState to CONNECTING. Notifying connectionEvent.");
        connectionEvent(connectionState);

        boolean isLeftDevice = deviceName.contains("_L_");
        boolean isRightDevice = deviceName.contains("_R_");

        if (isLeftDevice) {
            connectLeftDevice(device);
        } else if (isRightDevice) {
            connectRightDevice(device);
        } else {
            Log.d(TAG, "Unknown device type: " + deviceName);
        }
    }

    private void connectLeftDevice(BluetoothDevice device) {
        if (leftGlassGatt == null) {
            Log.d(TAG, "Attempting GATT connection for Left Glass...");
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback);
            isLeftConnected = false;
            Log.d(TAG, "Left GATT connection initiated. isLeftConnected set to false.");
        } else {
            Log.d(TAG, "Left Glass GATT already exists");
        }
    }

    private void connectRightDevice(BluetoothDevice device) {
        // Only connect right after left is fully connected
        if (isLeftConnected) {
            if (rightGlassGatt == null) {
                Log.d(TAG, "Attempting GATT connection for Right Glass...");
                rightGlassGatt = device.connectGatt(context, false, rightGattCallback);
                isRightConnected = false;
                Log.d(TAG, "Right GATT connection initiated. isRightConnected set to false.");

                // Cancel any pending retry attempts since we're now connecting
                if (rightConnectionRetryRunnable != null) {
                    connectHandler.removeCallbacks(rightConnectionRetryRunnable);
                    rightConnectionRetryRunnable = null;
                }
            } else {
                Log.d(TAG, "Right Glass GATT already exists");
            }
        } else {
            Log.d(TAG, "Waiting for left glass before connecting right. Scheduling retry in " + RIGHT_CONNECTION_RETRY_DELAY + "ms");

            // Cancel any existing retry attempts to avoid duplicate retries
            if (rightConnectionRetryRunnable != null) {
                connectHandler.removeCallbacks(rightConnectionRetryRunnable);
            }

            // Create new retry runnable
            rightConnectionRetryRunnable = new Runnable() {
                @Override
                public void run() {
                    if (!isKilled) {
                        Log.d(TAG, "Retrying right glass connection...");
                        attemptGattConnection(device);
                    } else {
                        Log.d(TAG, "Connection cancelled, stopping retry attempts");
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

//    private void sendDataSequentially(byte[] data, boolean onlyLeft) {
//        if (stopper) return;
//        stopper = true;
//
//        new Thread(() -> {
//            try {
//                if (leftGlassGatt != null && leftTxChar != null) {
//                    leftTxChar.setValue(data);
//                    leftGlassGatt.writeCharacteristic(leftTxChar);
//                    Thread.sleep(DELAY_BETWEEN_SENDS_MS);
//                }
//
//                if (!onlyLeft && rightGlassGatt != null && rightTxChar != null) {
//                    rightTxChar.setValue(data);
//                    rightGlassGatt.writeCharacteristic(rightTxChar);
//                    Thread.sleep(DELAY_BETWEEN_SENDS_MS);
//                }
//                stopper = false;
//            } catch (InterruptedException e) {
//                Log.e(TAG, "Error sending data: " + e.getMessage());
//            }
//        }).start();
//    }

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
        SendRequest [] chunks = {new SendRequest(data, onlyLeft, false)};
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    // Non-blocking function to add new send request
    private void sendDataSequentially(byte[] data, boolean onlyLeft, int waitTime) {
        SendRequest [] chunks = {new SendRequest(data, onlyLeft, false, waitTime)};
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    // Overloaded function to handle multiple chunks (List<byte[]>)
    private void sendDataSequentially(List<byte[]> data, boolean onlyLeft) {
        sendDataSequentially(data, onlyLeft, false);
    }

    private void sendDataSequentially(byte[] data, boolean onlyLeft, boolean onlyRight) {
        SendRequest [] chunks = {new SendRequest(data, onlyLeft, onlyRight)};
        sendQueue.offer(chunks);
        startWorkerIfNeeded();
    }

    private void sendDataSequentially(byte[] data, boolean onlyLeft, boolean onlyRight, int waitTime) {
        SendRequest [] chunks = {new SendRequest(data, onlyLeft, onlyRight, waitTime)};
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



    public class BooleanWaiter {
        private boolean flag = true;  // initially true

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
        Log.d(TAG, "PROC_QUEUE - waiting on services waiters");
        try {
            leftServicesWaiter.waitWhileTrue();
            rightServicesWaiter.waitWhileTrue();
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted waiting for descriptor writes: " + e);
        }
        Log.d(TAG, "PROC_QUEUE - DONE waiting on services waiters");

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

                        // Send to left glass
                        if (!request.onlyRight && leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
                            leftWaiter.setTrue();
                            leftTxChar.setValue(request.data);
                            leftSuccess = leftGlassGatt.writeCharacteristic(leftTxChar);
                            if (leftSuccess) {
                                lastSendTimestamp = System.currentTimeMillis();
                            }
                        }

                        if (leftSuccess) {
                            leftWaiter.waitWhileTrue();
                        } else {
                            //Log.d(TAG, "PROC_QUEUE - LEFT send fail");
                        }

                        // Send to right glass
                        if (!request.onlyLeft && rightGlassGatt != null && rightTxChar != null && isRightConnected) {
                            rightWaiter.setTrue();
                            rightTxChar.setValue(request.data);
                            rightSuccess = rightGlassGatt.writeCharacteristic(rightTxChar);
                            if (rightSuccess) {
                                lastSendTimestamp = System.currentTimeMillis();
                            }
                        }

                        if (rightSuccess) {
                            rightWaiter.waitWhileTrue();
                        } else {
                            //Log.d(TAG, "PROC_QUEUE - RIGHT send fail");
                        }

                        Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND);

                        // If the packet asked us to do a delay, then do it
                        if (request.waitTime != -1){
                            Thread.sleep(request.waitTime);
                        }
                    } catch (InterruptedException e) {
                        Log.e(TAG, "Error sending data: " + e.getMessage());
                        if (isKilled) break;
                    }
                }
            } catch (InterruptedException e) {
                if (isKilled) {
                    Log.d(TAG, "Process queue thread interrupted - shutting down");
                    break;
                }
                Log.e(TAG, "Error in queue processing: " + e.getMessage());
            }
        }

        Log.d(TAG, "Process queue thread exiting");
    }

//    @Override
//    public void displayReferenceCardSimple(String title, String body, int lingerTimeMs) {
//        displayReferenceCardSimple(title, body, lingerTimeMs);
//    }

    private static final int NOTIFICATION = 0x4B; // Notification command
    private String createNotificationJson(String appIdentifier, String title, String subtitle, String message) {
        long currentTime = System.currentTimeMillis() / 1000L; // Unix timestamp in seconds
        String currentDate = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new java.util.Date()); // Date format for 'date' field

        NCSNotification ncsNotification = new NCSNotification(
                notificationNum++,  // Increment sequence ID for uniqueness
                1,             // type (e.g., 1 = notification type)
                appIdentifier,
                title,
                subtitle,
                message,
                (int) currentTime,  // Cast long to int to match Python
                currentDate,        // Add the current date to the notification
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
        int time_s;  // Changed from long to int for consistency
        String date; // Added to match Python's date field
        String display_name;

        public NCSNotification(int msg_id, int type, String app_identifier, String title, String subtitle, String message, int time_s, String date, String display_name) {
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

    @Override
    public void displayReferenceCardSimple(String title, String body) {
        if (!isConnected()) {
            Log.d(TAG, "Not connected to glasses");
            return;
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
        Log.d(TAG, "Send simple reference card");
    }

    @Override
    public void destroy() {
        Log.d(TAG, "EvenRealitiesG1SGC ONDESTROY");
        showHomeScreen();
        isKilled = true;

        //stop BLE scanning
        stopScan();

        if (bondingReceiver != null && isBondingReceiverRegistered) {
            context.unregisterReceiver(bondingReceiver);
            isBondingReceiverRegistered = false;
        }

        if (rightConnectionRetryRunnable != null) {
            connectHandler.removeCallbacks(rightConnectionRetryRunnable);
            rightConnectionRetryRunnable = null;
        }

        //disable the microphone
        setMicEnabled(false, 0);

        //stop sending heartbeat
        stopHeartbeat();

        //stop sending micbeat
        stopMicBeat();

        // Stop periodic notifications
        stopPeriodicNotifications();


        // Stop periodic text wall
//        stopPeriodicNotifications();

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
        //if (goHomeHandler != null)
        //    goHomeHandler.removeCallbacks(goHomeRunnable);
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

        //free LC3 decoder
        if (lc3DecoderPtr != 0) {
            L3cCpp.freeDecoder(lc3DecoderPtr);
            lc3DecoderPtr = 0;
        }

        sendQueue.clear();

        // Add a dummy element to unblock the take() call if needed
        sendQueue.offer(new SendRequest[0]); //is this needed?

        isWorkerRunning = false;

        isLeftConnected = false;
        isRightConnected = false;

        Log.d(TAG, "EvenRealitiesG1SGC cleanup complete");
    }


    @Override
    public boolean isConnected() {
        return connectionState == SmartGlassesConnectionState.CONNECTED;
    }

    // Remaining methods
    @Override
    public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageInput) {}

    @Override
    public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs) {}

    @Override
    public void scrollingTextViewIntermediateText(String text) {}

    @Override
    public void scrollingTextViewFinalText(String text) {}

    @Override
    public void stopScrollingTextViewMode() {}

    @Override
    public void displayPromptView(String title, String[] options) {}

    @Override
    public void displayTextLine(String text) {}

    @Override
    public void displayBitmap(Bitmap bmp) {
        try {
            byte[] bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false);
            displayBitmapImage(bmpBytes);
        } catch (Exception e) {
            Log.e(TAG, e.getMessage());
        }
    }

    public void blankScreen() {}

    public void displayDoubleTextWall(String textTop, String textBottom) {
        List<byte[]> chunks = createDoubleTextWallChunks(textTop, textBottom);
        sendChunks(chunks);
    }

    public void showHomeScreen() {
        displayTextWall(" ");

        if (lastThingDisplayedWasAnImage) {
            //clearG1Screen();
            lastThingDisplayedWasAnImage = false;
        }
    }

    public void clearG1Screen() {
        Log.d(TAG, "Clearing G1 screen");
        byte[] exitCommand = new byte[]{(byte) 0x18};
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

    @Override
    public void setFontSize(SmartGlassesFontSize fontSize) {}

    public void displayRowsCard(String[] rowStrings) {}

    public void displayBulletList(String title, String[] bullets) {}

    public void displayReferenceCardImage(String title, String body, String imgUrl) {}

    public void displayTextWall(String a) {
        List<byte[]> chunks = createTextWallChunks(a);
        sendChunks(chunks);
    }

    public void setFontSizes() {}

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
        buffer.put((byte) 0x2C);  // Command
        buffer.put((byte) 0x01); // use 0x02 for iOS
        return buffer.array();
    }

    private void startHeartbeat(int delay) {
        Log.d(TAG, "Starting heartbeat");
        if (heartbeatCount > 0) stopHeartbeat();

        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                sendHeartbeat();
//                sendLoremIpsum();

//                quickRestartG1();


                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS);
            }
        };


        heartbeatHandler.postDelayed(heartbeatRunnable, delay);
    }

    //periodically send a mic ON request so it never turns off
    private void startMicBeat(int delay) {
        Log.d(TAG, "Starting micbeat");
        if (micBeatCount > 0) stopMicBeat();
        setMicEnabled(true, 10);

        micBeatRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "SENDING MIC BEAT");
                setMicEnabled(shouldUseGlassesMic, 1);
                micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS);
            }
        };

        micBeatHandler.postDelayed(micBeatRunnable, delay);
    }

    @Override
    public void findCompatibleDeviceNames() {
        if (isScanningForCompatibleDevices) {
            Log.d(TAG, "Scan already in progress, skipping...");
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
                            Log.d(TAG, "Found smart glasses: " + name);
                            String adjustedName = parsePairingIdFromDeviceName(name);
                            EventBus.getDefault().post(
                                    new GlassesBluetoothSearchDiscoverEvent(
                                            smartGlassesDevice.deviceModelName,
                                            adjustedName
                                    )
                            );
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
        Log.d(TAG, "Started scanning for smart glasses with BluetoothLeScanner...");

        // Stop scanning after 10 seconds (adjust as needed)
        findCompatibleDevicesHandler.postDelayed(() -> {
            scanner.stopScan(bleScanCallback);
            isScanningForCompatibleDevices = false;
            Log.d(TAG, "Stopped scanning for smart glasses.");
            EventBus.getDefault().post(
                    new GlassesBluetoothSearchStopEvent(
                            smartGlassesDevice.deviceModelName
                    )
            );
        }, 10000);
    }

    private void sendWhiteListCommand(int delay) {
        if (whiteListedAlready){
            return;
        }
        whiteListedAlready = true;

        Log.d(TAG, "Sending whitelist command");
        whiteListHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                List<byte[]> chunks = getWhitelistChunks();
                sendDataSequentially(chunks, false);
//                for (byte[] chunk : chunks) {
//                    Log.d(TAG, "Sending this chunk for white list:" + bytesToUtf8(chunk));
//                    sendDataSequentially(chunk, false);
//
////                    // Sleep for 100 milliseconds between sending each chunk
////                    try {
////                        Thread.sleep(150);
////                    } catch (InterruptedException e) {
////                        e.printStackTrace();
////                    }
//                }
            }
        }, delay);
    }

    private void stopHeartbeat() {
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacksAndMessages(null);
            heartbeatHandler.removeCallbacksAndMessages(heartbeatRunnable);
            heartbeatCount = 0;
        }
    }

    private void stopMicBeat() {
        setMicEnabled(false, 10);
        if (micBeatHandler != null) {
            micBeatHandler.removeCallbacksAndMessages(null);
            micBeatHandler.removeCallbacksAndMessages(micBeatRunnable);
            micBeatRunnable = null;
            micBeatCount = 0;
        }
    }

    private void sendHeartbeat() {
        byte[] heartbeatPacket = constructHeartbeat();
//        Log.d(TAG, "Sending heartbeat: " + bytesToHex(heartbeatPacket));

        sendDataSequentially(heartbeatPacket, false, 100);

        if (batteryLeft == -1 || batteryRight == -1 || heartbeatCount % 10 == 0) {
             queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500);
        }
        //queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500);

        heartbeatCount++;
    }
    private void queryBatteryStatus() {
        byte[] batteryQueryPacket = constructBatteryLevelQuery();
//        Log.d(TAG, "Sending battery status query: " + bytesToHex(batteryQueryPacket));

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
        buffer.put((byte) 0x01);              // Command
        buffer.put((byte) validBrightness);       // Brightness level (0~63)
        buffer.put((byte) (autoLight ? 1 : 0)); // Auto light (0 = close, 1 = open)

        sendDataSequentially(buffer.array(), false, 100);

        Log.d(TAG, "Sent auto light brightness command => Brightness: " + brightness + ", Auto Light: " + (autoLight ? "Open" : "Close"));

        //send to AugmentOS core
//        if (autoLight) {
//            EventBus.getDefault().post(new BrightnessLevelEvent(autoLight));
//        } else {
//            EventBus.getDefault().post(new BrightnessLevelEvent(brightness));
//        }
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
        buffer.put((byte) 0x0B);        // Command for configuring headUp angle
        buffer.put((byte) headUpAngle); // Angle value (0~60)
        buffer.put((byte) 0x01);        // Level (fixed at 0x01)

        sendDataSequentially(buffer.array(), false, 100);

        Log.d(TAG, "Sent headUp angle command => Angle: " + headUpAngle);
        EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));
    }

    public void sendDashboardPositionCommand(int height, int depth) {
        // clamp height and depth to 0-8 and 1-9 respectively:
        height = Math.max(0, Math.min(height, 8));
        depth = Math.max(1, Math.min(depth, 9));

        int globalCounter = 0;// TODO: must be incremented each time this command is sent!

        ByteBuffer buffer = ByteBuffer.allocate(8);
        buffer.put((byte) 0x26);        // Command for dashboard height
        buffer.put((byte) 0x08);     // Length
        buffer.put((byte) 0x00);     // Sequence
        buffer.put((byte) (globalCounter & 0xFF));// counter
        buffer.put((byte) 0x02);     // Fixed value
        buffer.put((byte) 0x01);     // State ON
        buffer.put((byte) height);     // Height value (0-8)
        buffer.put((byte) depth);     // Depth value (0-9)
        
        sendDataSequentially(buffer.array(), false, 100);

        Log.d(TAG, "Sent dashboard height/depth command => Height: " + height + ", Depth: " + depth);
        // EventBus.getDefault().post(new DashboardPositionEvent(height, depth));
    }
    

    @Override
    public void updateGlassesBrightness(int brightness) {
        Log.d(TAG, "Updating glasses brightness: " + brightness);
        sendBrightnessCommand(brightness, false);
    }

    @Override
    public void updateGlassesAutoBrightness(boolean autoBrightness) {
        Log.d(TAG, "Updating glasses auto brightness: " + autoBrightness);
        sendBrightnessCommand(-1, autoBrightness);
    }

    @Override
    public void updateGlassesHeadUpAngle(int headUpAngle) {
        sendHeadUpAngleCommand(headUpAngle);
    }

    @Override
    public void updateGlassesDashboardHeight(int height) {
        // TODO: get depth from settings!
        sendDashboardPositionCommand(height, 0);
    }

    @Override
    public void updateGlassesDepth(int depth) {
        // TODO: get height from settings!
        sendDashboardPositionCommand(0, depth);
    }
    

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X ", b));
        }
        return sb.toString().trim();
    }

    //microphone stuff
    public void setMicEnabled(boolean enable, int delay) {
        // Log.d(TAG, "^^^^^^^^^^^^^");
        // Log.d(TAG, "^^^^^^^^^^^^^");
        // Log.d(TAG, "^^^^^^^^^^^^^");
        // Log.d(TAG, "Running set mic enabled: " + enable);
        // Log.d(TAG, "^^^^^^^^^^^^^");
        // Log.d(TAG, "^^^^^^^^^^^^^");
        // Log.d(TAG, "^^^^^^^^^^^^^");

        isMicrophoneEnabled = enable; // Update the state tracker
        EventBus.getDefault().post(new isMicEnabledForFrontendEvent(enable));
        micEnableHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isConnected()) {
                    Log.d(TAG, "Tryna start mic: Not connected to glasses");
                    return;
                }

                byte command = 0x0E; // Command for MIC control
                byte enableByte = (byte) (enable ? 1 : 0); // 1 to enable, 0 to disable

                ByteBuffer buffer = ByteBuffer.allocate(2);
                buffer.put(command);
                buffer.put(enableByte);

                sendDataSequentially(buffer.array(), false, true, 300); //wait some time to setup the mic
                Log.d(TAG, "Sent MIC command: " + bytesToHex(buffer.array()));
            }
        }, delay);
    }

    //notifications
    private void startPeriodicNotifications(int delay) {
        if (notifysStarted){
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
            Log.d(TAG, "Cannot send notification: Not connected to glasses");
            return;
        }

        // Example notification data (replace with your actual data)
//        String json = createNotificationJson("com.augment.os", "QuestionAnswerer", "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
        String json = createNotificationJson("com.augment.os", "QuestionAnswerer", "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
        Log.d(TAG, "the JSON to send: " + json);
        List<byte[]> chunks = createNotificationChunks(json);
//        Log.d(TAG, "THE CHUNKS:");
//        Log.d(TAG, chunks.get(0).toString());
//        Log.d(TAG, chunks.get(1).toString());
        for (byte[] chunk : chunks) {
            Log.d(TAG, "Sent chunk to glasses: " + bytesToUtf8(chunk));
        }

        // Send each chunk with a short sleep between each send
        sendDataSequentially(chunks, false);
//        for (byte[] chunk : chunks) {
//            sendDataSequentially(chunk);
//
////            // Sleep for 100 milliseconds between sending each chunk
////            try {
////                Thread.sleep(150);
////            } catch (InterruptedException e) {
////                e.printStackTrace();
////            }
//        }

        Log.d(TAG, "Sent periodic notification");
    }

    //text wall debug
    private void startPeriodicTextWall(int delay) {
        if (textWallsStarted){
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
    private static final int TEXT_COMMAND = 0x4E;  // Text command
    private static final int DISPLAY_WIDTH = 488;
    private static final int DISPLAY_USE_WIDTH = 488;  // How much of the display to use
    private static final float FONT_MULTIPLIER = 1/50.0f;
    private static final int OLD_FONT_SIZE = 21;      // Font size
    private static final float FONT_DIVIDER = 2.0f;
    private static final int LINES_PER_SCREEN = 5; // Lines per screen
    private static final int MAX_CHUNK_SIZE = 176; // Maximum chunk size for BLE packets
//    private static final int INDENT_SPACES = 32;    // Number of spaces to indent text

    private int textSeqNum = 0; // Sequence number for text packets

    //currently only a single page - 1PAGE CHANGE
    private List<byte[]> createTextWallChunks(String text) {
        int margin = 5;

        // Get width of single space character
        int spaceWidth = calculateTextWidth(" ");

        // Calculate effective display width after accounting for left and right margins in spaces
        int marginWidth = margin * spaceWidth; // Width of left margin in pixels
        int effectiveWidth = DISPLAY_WIDTH - (2 * marginWidth); // Subtract left and right margins

        // Split text into lines based on effective display width
        List<String> lines = splitIntoLines(text, effectiveWidth);

        // Calculate total pages
        int totalPages = 1; //hard set to 1 since we only do 1 page - 1PAGECHANGE

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
                        (byte) TEXT_COMMAND,    // Command type
                        (byte) textSeqNum,      // Sequence number
                        (byte) totalChunks,     // Total packages
                        (byte) i,               // Current package number
                        screenStatus,           // Screen status
                        (byte) 0x00,            // new_char_pos0 (high)
                        (byte) 0x00,            // new_char_pos1 (low)
                        (byte) page,            // Current page number
                        (byte) totalPages       // Max page number
                };

                // Combine header and payload
                ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
                chunk.put(header);
                chunk.put(payloadChunk);

                allChunks.add(chunk.array());
            }

            // Increment sequence number for next page
            textSeqNum = (textSeqNum + 1) % 256;
            break; //hard set to 1  - 1PAGECHANGE
        }

        return allChunks;
    }

    private int calculateTextWidth(String text) {
        int width = 0;
        for (char c : text.toCharArray()) {
            G1FontLoader.FontGlyph glyph = fontLoader.getGlyph(c);
            width += glyph.width + 1; // Add 1 pixel per character for spacing
        }
        return width * 2;
    }

    private List<byte[]> createDoubleTextWallChunks(String text1, String text2) {
        // Define column widths and positions
        final int LEFT_COLUMN_WIDTH = (int)(DISPLAY_WIDTH * 0.5);  // 40% of display for left column
        final int RIGHT_COLUMN_START = (int)(DISPLAY_WIDTH * 0.55);  // Right column starts at 60%

        // Split texts into lines with specific width constraints
        List<String> lines1 = splitIntoLines(text1, LEFT_COLUMN_WIDTH);
        List<String> lines2 = splitIntoLines(text2, DISPLAY_WIDTH - RIGHT_COLUMN_START);

        // Ensure we have exactly LINES_PER_SCREEN lines (typically 5)
        while (lines1.size() < LINES_PER_SCREEN) lines1.add("");
        while (lines2.size() < LINES_PER_SCREEN) lines2.add("");

        lines1 = lines1.subList(0, LINES_PER_SCREEN);
        lines2 = lines2.subList(0, LINES_PER_SCREEN);

        // Get precise space width
        int spaceWidth = calculateTextWidth(" ");

        // Construct the text output by merging the lines with precise positioning
        StringBuilder pageText = new StringBuilder();
        for (int i = 0; i < LINES_PER_SCREEN; i++) {
            String leftText = lines1.get(i).replace("\u2002", ""); // Drop enspaces
            String rightText = lines2.get(i).replace("\u2002", "");

            // Calculate width of left text in pixels
            int leftTextWidth = calculateTextWidth(leftText);

            // Calculate exactly how many spaces are needed to position the right column correctly
            int spacesNeeded = calculateSpacesForAlignment(leftTextWidth, RIGHT_COLUMN_START, spaceWidth);

            // Log detailed alignment info for debugging
            Log.d(TAG, String.format("Line %d: Left='%s' (width=%dpx) | Spaces=%d | Right='%s'",
                    i, leftText, leftTextWidth, spacesNeeded, rightText));

            // Construct the full line with precise alignment
            pageText.append(leftText)
                    .append(" ".repeat(spacesNeeded))
                    .append(rightText)
                    .append("\n");
        }

        // Convert to bytes and chunk for transmission
        return chunkTextForTransmission(pageText.toString());
    }

    private int calculateSpacesForAlignment(int currentWidth, int targetPosition, int spaceWidth) {
        // Calculate space needed in pixels
        int pixelsNeeded = targetPosition - currentWidth;

        // Calculate spaces needed (with minimum of 1 space for separation)
        if (pixelsNeeded <= 0) {
            return 1; // Ensure at least one space between columns
        }

        // Calculate the exact number of spaces needed
        int spaces = (int)Math.ceil((double)pixelsNeeded / spaceWidth);

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
            byte[] header = new byte[]{
                    (byte) TEXT_COMMAND,    // Command type
                    (byte) textSeqNum,      // Sequence number
                    (byte) totalChunks,     // Total packages
                    (byte) i,               // Current package number
                    screenStatus,           // Screen status
                    (byte) 0x00,            // new_char_pos0 (high)
                    (byte) 0x00,            // new_char_pos1 (low)
                    (byte) 0x00,            // Current page number (always 0 for now)
                    (byte) 0x01             // Max page number (always 1)
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

    private int calculateSubstringWidth(String text, int start, int end) {
        return calculateTextWidth(text.substring(start, end));
    }

    private List<String> splitIntoLines(String text, int maxDisplayWidth) {
        // Replace specific symbols
        text = text.replace("⬆", "^").replace("⟶", "-");

        List<String> lines = new ArrayList<>();

        // Handle empty or single space case
        if (text.isEmpty() || " ".equals(text)) {
            lines.add(text);
            return lines;
        }

        // Split by newlines first
        String[] rawLines = text.split("\n");

        Log.d(TAG, "Splitting text into lines..." + Arrays.toString(rawLines));

        for (String rawLine : rawLines) {
            // Add empty lines for newlines
            if (rawLine.isEmpty()) {
                lines.add("");
                continue;
            }

            int lineLength = rawLine.length();
            int startIndex = 0;

            while (startIndex < lineLength) {
                // Get maximum possible end index
                int endIndex = lineLength;

                // Calculate width of the entire remaining text
                int lineWidth = calculateSubstringWidth(rawLine, startIndex, endIndex);

                Log.d(TAG, "Line length: " + rawLine);
                Log.d(TAG, "Calculating line width: " + lineWidth);

                // If entire line fits, add it and move to next line
                if (lineWidth <= maxDisplayWidth) {
                    lines.add(rawLine.substring(startIndex));
                    break;
                }

                // Binary search to find the maximum number of characters that fit
                int left = startIndex + 1;
                int right = lineLength;
                int bestSplitIndex = startIndex + 1;

                while (left <= right) {
                    int mid = left + (right - left) / 2;
                    int width = calculateSubstringWidth(rawLine, startIndex, mid);

                    if (width <= maxDisplayWidth) {
                        bestSplitIndex = mid;
                        left = mid + 1;
                    } else {
                        right = mid - 1;
                    }
                }

                // Now find a good place to break (preferably at a space)
                int splitIndex = bestSplitIndex;

                // Look for a space to break at
                boolean foundSpace = false;
                for (int i = bestSplitIndex; i > startIndex; i--) {
                    if (rawLine.charAt(i - 1) == ' ') {
                        splitIndex = i;
                        foundSpace = true;
                        break;
                    }
                }

                // If we couldn't find a space in a reasonable range, use the calculated split point
                if (!foundSpace && bestSplitIndex - startIndex > 2) {
                    splitIndex = bestSplitIndex;
                }

                // Add the line
                String line = rawLine.substring(startIndex, splitIndex).trim();
                lines.add(line);

                // Skip any spaces at the beginning of the next line
                while (splitIndex < lineLength && rawLine.charAt(splitIndex) == ' ') {
                    splitIndex++;
                }

                startIndex = splitIndex;
            }
        }

        return lines;
    }

    private void sendPeriodicTextWall() {
        if (!isConnected()) {
            Log.d(TAG, "Cannot send text wall: Not connected to glasses");
            return;
        }

        Log.d(TAG, "^^^^^^^^^^^^^ SENDING DEBUG TEXT WALL");

        // Example text wall content - replace with your actual text content
        String sampleText = "This is an example of a text wall that will be displayed on the glasses. " +
                "It demonstrates how text can be split into multiple pages and displayed sequentially. " +
                "Each page contains multiple lines, and each line is carefully formatted to fit the display width. " +
                "The text continues across multiple pages, showing how longer content can be handled effectively.";

        List<byte[]> chunks = createTextWallChunks(sampleText);

        // Send each chunk with a delay between sends
        for (byte[] chunk : chunks) {
            sendDataSequentially(chunk);

//            try {
//                Thread.sleep(150); // 150ms delay between chunks
//            } catch (InterruptedException e) {
//                e.printStackTrace();
//            }
        }

        // Log.d(TAG, "Sent text wall");
    }

    private static String bytesToUtf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private void stopPeriodicNotifications() {
        if (notificationHandler != null && notificationRunnable != null) {
            notificationHandler.removeCallbacks(notificationRunnable);
            Log.d(TAG, "Stopped periodic notifications");
        }
    }

    // handle white list stuff
    private static final int WHITELIST_CMD = 0x04; // Command ID for whitelist
    public List<byte[]> getWhitelistChunks() {
        // Define the hardcoded whitelist JSON
        List<AppInfo> apps = new ArrayList<>();
        apps.add(new AppInfo("com.augment.os", "AugmentOS"));
        String whitelistJson = createWhitelistJson(apps);

        Log.d(TAG, "Creating chunks for hardcoded whitelist: " + whitelistJson);

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

        public String getId() { return id; }
        public String getName() { return name; }
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
                    (byte) WHITELIST_CMD,  // Command ID
                    (byte) totalChunks,   // Total number of chunks
                    (byte) i              // Current chunk index
            };

            // Combine header and payload
            ByteBuffer buffer = ByteBuffer.allocate(header.length + payloadChunk.length);
            buffer.put(header);
            buffer.put(payloadChunk);

            chunks.add(buffer.array());
        }

        return chunks;
    }

    @Override
    public void displayCustomContent(String content){
        Log.d(TAG, "DISPLAY CUSTOM CONTENT");
    }

    private void sendChunks(List<byte[]> chunks){
        // Send each chunk with a delay between sends
        for (byte[] chunk : chunks) {
            sendDataSequentially(chunk);

//            try {
//                Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND); // delay between chunks
//            } catch (InterruptedException e) {
//                e.printStackTrace();
//            }
        }
    }

//    public int DEFAULT_CARD_SHOW_TIME = 6;
//    public void homeScreenInNSeconds(int n){
//        if (n == -1){
//            return;
//        }
//
//        if (n == 0){
//            n = DEFAULT_CARD_SHOW_TIME;
//        }
//
//        //disconnect after slight delay, so our above text gets a chance to show up
//        goHomeHandler.removeCallbacksAndMessages(goHomeRunnable);
//        goHomeHandler.removeCallbacksAndMessages(null);
//        goHomeRunnable = new Runnable() {
//            @Override
//            public void run() {
//                showHomeScreen();
//            }};
//        goHomeHandler.postDelayed(goHomeRunnable, n * 1000);
//    }


    //BMP handling

    // Add these class variables
    private static final int BMP_CHUNK_SIZE = 194;
    private static final byte[] GLASSES_ADDRESS = new byte[]{0x00, 0x1c, 0x00, 0x00};
    private static final byte[] END_COMMAND = new byte[]{0x20, 0x0d, 0x0e};

    public void displayBitmapImage(byte[] bmpData) {
        Log.d(TAG, "Starting BMP display process");

        try {
            if (bmpData == null || bmpData.length == 0) {
                Log.e(TAG, "Invalid BMP data provided");
                return;
            }
            Log.d(TAG, "Processing BMP data, size: " + bmpData.length + " bytes");

            // Split into chunks and send
            List<byte[]> chunks = createBmpChunks(bmpData);
            Log.d(TAG, "Created " + chunks.size() + " chunks");

            // Send all chunks
            sendBmpChunks(chunks);

            // Send end command
            sendBmpEndCommand();

            // Calculate and send CRC
            sendBmpCRC(bmpData);

            lastThingDisplayedWasAnImage = true;

        } catch (Exception e) {
            Log.e(TAG, "Error in displayBitmapImage: " + e.getMessage());
        }
    }

    private List<byte[]> createBmpChunks(byte[] bmpData) {
        List<byte[]> chunks = new ArrayList<>();
        int totalChunks = (int) Math.ceil((double) bmpData.length / BMP_CHUNK_SIZE);
        Log.d(TAG, "Creating " + totalChunks + " chunks from " + bmpData.length + " bytes");

        for (int i = 0; i < totalChunks; i++) {
            int start = i * BMP_CHUNK_SIZE;
            int end = Math.min(start + BMP_CHUNK_SIZE, bmpData.length);
            byte[] chunk = Arrays.copyOfRange(bmpData, start, end);

            // First chunk needs address bytes
            if (i == 0) {
                byte[] headerWithAddress = new byte[2 + GLASSES_ADDRESS.length + chunk.length];
                headerWithAddress[0] = 0x15;  // Command
                headerWithAddress[1] = (byte)(i & 0xFF);  // Sequence
                System.arraycopy(GLASSES_ADDRESS, 0, headerWithAddress, 2, GLASSES_ADDRESS.length);
                System.arraycopy(chunk, 0, headerWithAddress, 6, chunk.length);
                chunks.add(headerWithAddress);
            } else {
                byte[] header = new byte[2 + chunk.length];
                header[0] = 0x15;  // Command
                header[1] = (byte)(i & 0xFF);  // Sequence
                System.arraycopy(chunk, 0, header, 2, chunk.length);
                chunks.add(header);
            }
        }
        return chunks;
    }

    private void sendBmpChunks(List<byte[]> chunks) {
        for (int i = 0; i < chunks.size(); i++) {
            byte[] chunk = chunks.get(i);
            Log.d(TAG, "Sending chunk " + i + " of " + chunks.size() + ", size: " + chunk.length);
            sendDataSequentially(chunk);

//            try {
//                Thread.sleep(25); // Small delay between chunks
//            } catch (InterruptedException e) {
//                Log.e(TAG, "Sleep interrupted: " + e.getMessage());
//            }
        }
    }

    private void sendBmpEndCommand() {
        Log.d(TAG, "Sending BMP end command");
        sendDataSequentially(END_COMMAND);

//        try {
//            Thread.sleep(100); // Give it time to process
//        } catch (InterruptedException e) {
//            Log.e(TAG, "Sleep interrupted: " + e.getMessage());
//        }
    }

    private void sendBmpCRC(byte[] bmpData) {
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
        crcCommand[0] = 0x16;  // CRC command
        crcCommand[1] = (byte)((crcValue >> 24) & 0xFF);
        crcCommand[2] = (byte)((crcValue >> 16) & 0xFF);
        crcCommand[3] = (byte)((crcValue >> 8) & 0xFF);
        crcCommand[4] = (byte)(crcValue & 0xFF);

        Log.d(TAG, "Sending CRC command, CRC value: " + Long.toHexString(crcValue));
        sendDataSequentially(crcCommand);
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
        Log.d(TAG, "Clearing BMP display with EXIT command");
        byte[] exitCommand = new byte[]{0x18};
        sendDataSequentially(exitCommand);
    }

    private void sendLoremIpsum(){
        String text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";
        sendDataSequentially(createTextWallChunks(text));
    }

    private void quickRestartG1(){
        Log.d(TAG, "Sending restart 0x23 0x72 Command");
        sendDataSequentially(new byte[]{(byte) 0x23, (byte) 0x72}); //quick restart comand
    }

    @Override
    public void changeSmartGlassesMicrophoneState(boolean isMicrophoneEnabled) {
        Log.d(TAG, "Microphone state changed: " + isMicrophoneEnabled);
        if (isMicrophoneEnabled) {
            Log.d(TAG, "Microphone enabled, starting audio input handling");
            // setMicEnabled(true, 10);
            startMicBeat((int) MICBEAT_INTERVAL_MS);
        } else {
            Log.d(TAG, "Microphone disabled, stopping audio input handling");
            // setMicEnabled(false, 10);
            stopMicBeat();
        }
    }

    /**
     * Returns whether the microphone is currently enabled
     * @return true if microphone is enabled, false otherwise
     */
    public boolean isMicrophoneEnabled() {
        return isMicrophoneEnabled;
    }
}