// NOTE: Last stable code from nex-sgc branch for reference. DELETE LATER.

// package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

// import android.os.Bundle;

// import com.augmentos.augmentos_core.BuildConfig;

// import mentraos.ble.MentraosBle;
// import mentraos.ble.MentraosBle.DisplayText;
// import mentraos.ble.MentraosBle.DisplayScrollingText;
// import mentraos.ble.MentraosBle.PhoneToGlasses;
// //import mentraos.ble.MentraosBle.PhoneToGlasses.PayloadCase;
// import mentraos.ble.MentraosBle.GlassesToPhone;
// import mentraos.ble.MentraosBle.GlassesToPhone.PayloadCase;
// // import mentraos.ble.MentraosBle.PingRequest; // No longer used - phone receives pings instead of sending them
// import mentraos.ble.MentraosBle.DisplayImage;
// import mentraos.ble.MentraosBle.BatteryStatus;
// import mentraos.ble.MentraosBle.ChargingState;
// import mentraos.ble.MentraosBle.ChargingState.State;
// import mentraos.ble.MentraosBle.DeviceInfo;
// import mentraos.ble.MentraosBle.HeadPosition;
// import mentraos.ble.MentraosBle.HeadUpAngleResponse;
// import mentraos.ble.MentraosBle.PongResponse;
// import mentraos.ble.MentraosBle.VadEvent;
// import mentraos.ble.MentraosBle.ImageTransferComplete;
// import mentraos.ble.MentraosBle.ImageTransferComplete.Status;
// import mentraos.ble.MentraosBle.ImuData;
// import mentraos.ble.MentraosBle.ButtonEvent;
// import mentraos.ble.MentraosBle.HeadGesture;
// import mentraos.ble.MentraosBle.BatteryStateRequest;
// import mentraos.ble.MentraosBle.MicStateConfig;
// import mentraos.ble.MentraosBle.BrightnessConfig;
// import mentraos.ble.MentraosBle.AutoBrightnessConfig;
// import mentraos.ble.MentraosBle.HeadUpAngleConfig;
// import mentraos.ble.MentraosBle.DisplayHeightConfig;
// import mentraos.ble.MentraosBle.VersionRequest;
// import mentraos.ble.MentraosBle.VersionResponse;
// import mentraos.ble.MentraosBle.VadEnabledRequest;
// import mentraos.ble.MentraosBle.VadConfigRequest;

// import com.google.protobuf.InvalidProtocolBufferException;

// import android.bluetooth.BluetoothAdapter;
// import android.bluetooth.BluetoothDevice;
// import android.bluetooth.BluetoothGatt;
// import android.bluetooth.BluetoothGattCallback;
// import android.bluetooth.BluetoothGattCharacteristic;
// import android.bluetooth.BluetoothGattDescriptor;
// import android.bluetooth.BluetoothGattService;
// import android.bluetooth.BluetoothProfile;
// import android.bluetooth.le.BluetoothLeScanner;
// import android.bluetooth.le.ScanCallback;
// import android.bluetooth.le.ScanFilter;
// import android.bluetooth.le.ScanResult;
// import android.bluetooth.le.ScanSettings;
// import android.content.BroadcastReceiver;
// import android.content.Context;
// import android.content.pm.ApplicationInfo;
// import android.content.Intent;
// import android.content.IntentFilter;
// import android.content.SharedPreferences;
// import android.graphics.Bitmap;
// import android.graphics.Canvas;
// import android.graphics.Color;
// import android.graphics.Paint;
// import android.os.Handler;
// import android.os.Message;
// import android.os.Handler.Callback;
// import android.os.Looper;
// import android.util.Log;
// import android.util.SparseArray;

// import androidx.preference.PreferenceManager;

// import java.util.concurrent.BlockingQueue;

// import org.json.JSONException;
// import org.json.JSONObject;

// //BMP

// import java.util.Random;
// import java.util.ArrayList;
// import java.util.List;
// import java.util.concurrent.LinkedBlockingQueue;
// import java.util.zip.CRC32;
// import java.nio.ByteBuffer;

// import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.isMicEnabledForFrontendEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesCommunicator;
// import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.HeadUpAngleEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.DisplayTextEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.DisplayImageEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.BitmapJavaUtils;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.G1FontLoader;
// import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
// import com.augmentos.augmentos_core.audio.Lc3Player;
// import com.google.gson.Gson;
// import com.augmentos.smartglassesmanager.cpp.L3cCpp;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.CaseEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BrightnessLevelEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchStopEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadDownEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadUpEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BleCommandReceiver;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BleCommandSender;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.HeartbeatSentEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.HeartbeatReceivedEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
// import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.augmentos.SpeechRecAugmentos;
// import com.augmentos.augmentos_core.R;

// import org.greenrobot.eventbus.EventBus;
// import org.json.JSONArray;

// import java.lang.reflect.Method;
// import java.nio.charset.Charset;
// import java.nio.charset.StandardCharsets;
// import java.util.Arrays;
// import java.util.UUID;
// import java.util.concurrent.Semaphore;
// import java.util.regex.Matcher;
// import java.util.regex.Pattern;
// import java.util.Map;
// import java.util.HashMap;

// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesSerialNumberEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ProtobufSchemaVersionEvent;
// import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.ProtocolVersionResponseEvent;

// import java.io.IOException;
// import java.io.InputStream;

// /**
//  * MentraNexSGC - Smart Glasses Communicator for Mentra Nex Glasses
//  * 
//  * Heartbeat System: This implementation now follows the protobuf specification where:
//  * - Glasses send PING messages to the phone
//  * - Phone responds with PONG messages
//  * - Phone no longer sends periodic PING messages
//  */
// public final class MentraNexSGC extends SmartGlassesCommunicator {
//     private final String TAG = "WearableAi_MentraNexSGC";
//     public final String SHARED_PREFS_NAME = "NexGlassesPrefs";
//     private final String NEX_MAIN_DEVICE_KEY = "NEX_MAIN_DEVICE_KEY";
//     private final String NEX_MAIN_DEVICE_ADDRESS = "NEX_MAIN_DEVICE_ADDRESS";
//     private final String SAVED_NEX_ID_KEY = "SAVED_Nex_ID_KEY";

//     private boolean isDebugMode = true;
//     private boolean isLc3AudioEnabled = true;

//     private boolean isVadEnabled = true;
//     private int vadSensitivity = 50;

//     // Count of pings received from glasses (used for battery query timing)
//     private int heartbeatCount = 0;
//     private int micBeatCount = 0;
    
//     // Heartbeat timing tracking
//     private long lastHeartbeatSentTime = 0;
//     private long lastHeartbeatReceivedTime = 0;

//     private int lastReceivedLc3Sequence = -1;

//     private BluetoothAdapter bluetoothAdapter;

//     private boolean isKilled = false;//

//     private final UUID MAIN_SERVICE_UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb");
//     private final UUID WRITE_CHAR_UUID = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb");
//     private final UUID NOTIFY_CHAR_UUID = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb");
//     private final UUID CLIENT_CHARACTERISTIC_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

//     private final byte PACKET_TYPE_JSON = (byte) 0x01;
//     private final byte PACKET_TYPE_PROTOBUF = (byte) 0x02;
//     private final byte PACKET_TYPE_AUDIO = (byte) 0xA0;
//     private final byte PACKET_TYPE_IMAGE = (byte) 0xB0;
//     private final Random random = new Random();

//     private Context context;
//     private BluetoothGatt mainGlassGatt;
//     private BluetoothGattCharacteristic mainWriteChar;
//     private BluetoothGattCharacteristic mainNotifyChar;
//     private final int MTU_517 = 517; // Maximum MTU we'll use
//     private final int MTU_DEFAULT = 23; // Default BLE MTU
//     private int currentMTU = 0;
//     private int deviceMaxMTU = 0; // Discovered maximum MTU capability

//     private volatile boolean isImageSendProgressing = false;
//     private List<byte[]> currentImageChunks = new ArrayList<>();

//     private SmartGlassesConnectionState connectionState = SmartGlassesConnectionState.DISCONNECTED;
//     // gatt callbacks
//     private final int MAIN_TASK_HANDLER_CODE_GATT_STATUS_CHANGED = 110;
//     private final int MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES = 120;
//     private final int MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED = 210;
//     // actions of device or gatt
//     private final int MAIN_TASK_HANDLER_CODE_CONNECT_DEVICE = 310;
//     private final int MAIN_TASK_HANDLER_CODE_DISCONNECT_DEVICE = 320;
//     private final int MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE = 350;
//     private final int MAIN_TASK_HANDLER_CODE_CANCEL_RECONNECT_DEVICE = 360;
//     private final int MAIN_TASK_HANDLER_CODE_RECONNECT_GATT = 370;
//     private final int MAIN_TASK_HANDLER_CODE_SCAN_START = 410;
//     private final int MAIN_TASK_HANDLER_CODE_SCAN_END = 420;
//     // actions of NEX Glasses
//     private final int MAIN_TASK_HANDLER_CODE_BATTERY_QUERY = 620;
//     private final int MAIN_TASK_HANDLER_CODE_HEART_BEAT = 630;
//     private final Handler mainTaskHandler = new Handler(Looper.getMainLooper(), new Callback() {
//         @Override
//         public boolean handleMessage(Message msg) {
//             final int msgCode = msg.what;
//             Log.d(TAG, "handleMessage msgCode: " + msgCode);
//             Log.d(TAG, "handleMessage obj: " + msg.obj);
//             switch (msgCode) {
//                 case MAIN_TASK_HANDLER_CODE_GATT_STATUS_CHANGED:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES:
//                     final boolean statusBool = (boolean) msg.obj;
//                     if (statusBool) {
//                         initNexGlasses(mainGlassGatt);
//                     }
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED:
//                     final BluetoothGattCharacteristic characteristic = (BluetoothGattCharacteristic) msg.obj;
//                     onCharacteristicChangedHandler(characteristic);
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_CONNECT_DEVICE:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_DISCONNECT_DEVICE:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE: {
//                     attemptGattConnection(mainDevice);
//                 }
//                 break;
//                 case MAIN_TASK_HANDLER_CODE_CANCEL_RECONNECT_DEVICE:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_RECONNECT_GATT:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_SCAN_START:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_SCAN_END:
//                     break;
//                 case MAIN_TASK_HANDLER_CODE_BATTERY_QUERY: {
//                     queryBatteryStatus();
//                 }
//                 break;
//                 case MAIN_TASK_HANDLER_CODE_HEART_BEAT:
//                     // Note: Heartbeat is now handled by receiving ping from glasses
//                     // This case is kept for backward compatibility but no longer used
//                     Log.d(TAG, "Heartbeat handler called - no longer sending periodic pings");
//                     break;
//                 default:
//                     break;
//             }
//             return true;
//         }
//     });
//     private final Semaphore sendSemaphore = new Semaphore(1);
//     private boolean isMainConnected = false;
//     private int currentSeq = 0;
//     private boolean stopper = false;
//     private boolean debugStopper = false;
//     private boolean shouldUseAutoBrightness = false;
//     private int brightnessValue;
//     private boolean updatingScreen = false;

//     private final int DELAY_BETWEEN_SENDS_MS = 5; // not using now
//     private final int DELAY_BETWEEN_CHUNKS_SEND = 5; // super small just in case
//     private final int DELAY_BETWEEN_ACTIONS_SEND = 250; // not using now
//     // Note: HEARTBEAT_INTERVAL_MS is no longer used since phone receives pings instead of sending them
//     // private final int HEARTBEAT_INTERVAL_MS = 15000;
//     private final int MICBEAT_INTERVAL_MS = (1000 * 60) * 30; // micbeat every 30 minutes
//     private int caseBatteryLevel = -1;
//     private boolean caseCharging = false;
//     private boolean caseOpen = false;
//     private boolean caseRemoved = true;
//     private int batteryMain = -1;
//     private int mainReconnectAttempts = 0;
//     private int reconnectAttempts = 0; // Counts the number of reconnect attempts
//     private final int BASE_RECONNECT_DELAY_MS = 3000; // Start with 3 seconds
//     private final int MAX_RECONNECT_DELAY_MS = 60000;

//     // heartbeat monitoring (passive - waiting for ping from glasses)
//     private Handler findCompatibleDevicesHandler;
//     private boolean isScanningForCompatibleDevices = false;
//     private boolean isScanning = false;

//     private ScanCallback bleScanCallback;

//     // mic heartbeat turn on
//     private Handler micBeatHandler = new Handler();
//     private Runnable micBeatRunnable;

//     // white list sender
//     private Handler whiteListHandler = new Handler();
//     private boolean whiteListedAlready = false;

//     // mic enable Handler
//     private final Handler micEnableHandler = new Handler();
//     private boolean micEnabledAlready = false;
//     private boolean isMicrophoneEnabled = true; // Track current microphone state
//     private boolean microphoneStateBeforeDisconnection = false; // Remember state for reconnection

//     // notification period sender
//     private Handler notificationHandler = new Handler();
//     private Runnable notificationRunnable;
//     private boolean notifysStarted = false;
//     private int notificationNum = 10;

//     // text wall periodic sender
//     private Handler textWallHandler = new Handler();
//     private Runnable textWallRunnable;
//     private boolean textWallsStarted = false;
//     private int textWallNum = 10;

//     private BluetoothDevice mainDevice = null;
//     private String preferredNexId = null;
//     private String pendingSavedNexMainName = null;
//     private String savedNexMainName = null;
//     private String savedNexMainAddress = null;
//     private String preferredMainDeviceId = null;

//     // Retry handler
//     private final int BOND_RETRY_DELAY_MS = 5000; // 5-second backoff

//     // remember when we connected
//     private long lastConnectionTimestamp = 0;
//     private SmartGlassesDevice smartGlassesDevice;

//     private final long CONNECTION_TIMEOUT_MS = 10000; // 10 seconds

//     // Runnable tasks for handling timeouts
//     private boolean isBondingReceiverRegistered = false;
//     private boolean shouldUseGlassesMic = true;// just for test
//     private boolean lastThingDisplayedWasAnImage = false;

//     // lock writing until the last write is successful
//     // fonts in NexGlasses
//     private G1FontLoader fontLoader;

//     private final int DEBOUNCE_DELAY_MS = 270; // Minimum time between chunk sends
//     private volatile long lastSendTimestamp = 0;
//     private long lc3DecoderPtr = 0;

//     private final Gson gson = new Gson();

//     private Lc3Player lc3AudioPlayer;
    
//     // Track if protobuf version has been posted to avoid duplicates
//     private boolean protobufVersionPosted = false;

//     public MentraNexSGC(Context context, SmartGlassesDevice smartGlassesDevice) {
//         super();
//         this.context = context;
//         isDebugMode = isDebug(context);
//         Log.d(TAG, "Init MentraNexSGC");
//         loadPairedDeviceNames();
//         loadPairedDeviceAddress();
//         // goHomeHandler = new Handler();
//         this.smartGlassesDevice = smartGlassesDevice;
//         preferredMainDeviceId = getPreferredMainDeviceId(context);
//         brightnessValue = getSavedBrightnessValue(context);
//         shouldUseAutoBrightness = getSavedAutoBrightnessValue(context);
//         this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
//         this.shouldUseGlassesMic = SmartGlassesManager.getSensingEnabled(context)
//                 && !"phone".equals(SmartGlassesManager.getPreferredMic(context));

//         // setup LC3 decoder
//         if (lc3DecoderPtr == 0) {
//             lc3DecoderPtr = L3cCpp.initDecoder();
//             Log.d(TAG, "initDecoder lc3DecoderPtr：" + lc3DecoderPtr);
//         }
//         // setup fonts
//         fontLoader = new G1FontLoader(context);
//         // SpeechRecAugmentos.getInstance(context);
//         // SpeechRecAugmentos.getInstance(context).changeBypassVadForDebuggingState(true);

//         // Initialize LC3 audio player
//         lc3AudioPlayer = new Lc3Player(context);
//         lc3AudioPlayer.init();
//         if (isLc3AudioEnabled) {
//             lc3AudioPlayer.startPlay();
//         }
//     }

//     private final BluetoothGattCallback mainGattCallback = createGattCallback();

//     private BluetoothGattCallback createGattCallback() {
//         return new BluetoothGattCallback() {
//             @Override
//             public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
//                 Log.d(TAG, "onConnectionStateChange status State " + (status == BluetoothGatt.GATT_SUCCESS));
//                 Log.d(TAG, "onConnectionStateChange connected State " + (newState == BluetoothProfile.STATE_CONNECTED));

//                 if (status == BluetoothGatt.GATT_SUCCESS) {

//                     if (newState == BluetoothProfile.STATE_CONNECTED) {
//                         Log.d(TAG, " glass connected, discovering services...");
//                         gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
//                         gatt.setPreferredPhy(BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_LE_2M_MASK,
//                                 BluetoothDevice.PHY_OPTION_NO_PREFERRED);

//                         isMainConnected = true;
//                         mainReconnectAttempts = 0;
//                         Log.d(TAG, "Both glasses connected. Stopping BLE scan.");
//                         stopScan();

//                         if (!isWorkerRunning) {
//                             Log.d(TAG, "Worker thread is not running. Starting it.");
//                             startWorkerIfNeeded();
//                         }

//                         Log.d(TAG, "Discover services calling...");
//                         gatt.discoverServices();
//                         updateConnectionState();
//                         if (mainDevice != null) {
//                             savedNexMainName = mainDevice.getName();
//                             savedNexMainAddress = mainDevice.getAddress();
//                             savePairedDeviceNames();
//                             savePairedDeviceAddress();
//                         }

//                         // just for test
//                         // EventBus.getDefault().post(new BatteryLevelEvent(20, true));
//                     } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
//                         Log.d(TAG, " glass disconnected, stopping heartbeats");
//                         Log.d(TAG, "Entering STATE_DISCONNECTED branch for side: ");
                        
//                         // Save current microphone state before disconnection
//                         microphoneStateBeforeDisconnection = isMicrophoneEnabled;
//                         Log.d(TAG, "Saved microphone state before disconnection: " + microphoneStateBeforeDisconnection);
                        
//                         // Reset protobuf version posted flag for next connection
//                         protobufVersionPosted = false;
                        
//                         // Mark both sides as not ready (you could also clear both if one disconnects)
//                         MAX_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
//                         BMP_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
//                         mainServicesWaiter.setTrue();
//                         Log.d(TAG, "Set mainServicesWaiter and rightServicesWaiter to true.");
//                         forceSideDisconnection();
//                         Log.d(TAG, "Called forceSideDisconnection().");
//                         currentMTU = 0;
//                         // Stop any periodic transmissions
//                         stopMicBeat();
//                         sendQueue.clear();
//                         Log.d(TAG, "Stopped heartbeat monitoring and mic beat; cleared sendQueue.");
//                         updateConnectionState();
//                         Log.d(TAG, "Updated connection state after disconnection.");
//                         if (gatt.getDevice() != null) {
//                             // Close the current gatt connection
//                             Log.d(TAG, "Closing GATT connection for device: " + gatt.getDevice().getAddress());
//                             gatt.disconnect();
//                             gatt.close();
//                             Log.d(TAG, "GATT connection closed.");
//                         } else {
//                             Log.d(TAG, "No GATT device available to disconnect.");
//                         }
//                     }
//                 } else {
//                     // Save current microphone state before connection failure
//                     microphoneStateBeforeDisconnection = isMicrophoneEnabled;
//                     Log.d(TAG, "Saved microphone state before connection failure: " + microphoneStateBeforeDisconnection);
                    
//                     currentMTU = 0;
//                     MAX_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
//                     BMP_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
//                     Log.d(TAG, "Unexpected connection state encountered for " + " glass: " + newState);
//                     stopMicBeat();
//                     sendQueue.clear();

//                     // Mark both sides as not ready (you could also clear both if one disconnects)
//                     mainServicesWaiter.setTrue();

//                     Log.d(TAG, "Stopped heartbeat monitoring and mic beat; cleared sendQueue due to connection failure.");

//                     Log.d(TAG, " glass connection failed with status: " + status);
//                     isMainConnected = false;
//                     mainReconnectAttempts++;
//                     if (mainGlassGatt != null) {
//                         mainGlassGatt.disconnect();
//                         mainGlassGatt.close();
//                     }
//                     mainGlassGatt = null;

//                     forceSideDisconnection();
//                     Log.d(TAG, "Called forceSideDisconnection() after connection failure.");

//                     // gatt.disconnect();
//                     // gatt.close();
//                     Log.d(TAG, "GATT connection disconnected and closed due to failure.");

//                     mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0); // 1 second
//                     // delay
//                 }
//             }

//             private void forceSideDisconnection() {
//                 Log.d(TAG, "forceSideDisconnection() called for side: ");
//                 // Force disconnection from the other side if necessary
//                 isMainConnected = false;
//                 mainReconnectAttempts++;
//                 Log.d(TAG, "Main glass: Marked as disconnected and incremented mainReconnectAttempts to "
//                         + mainReconnectAttempts);
//                 if (mainGlassGatt != null) {
//                     Log.d(TAG, "Main glass GATT exists. Disconnecting and closing mainGlassGatt.");
//                     mainGlassGatt.disconnect();
//                     mainGlassGatt.close();
//                     mainGlassGatt = null;
//                 } else {
//                     Log.d(TAG, "Main glass GATT is already null.");
//                 }
//             }

//             @Override
//             public void onServicesDiscovered(BluetoothGatt gatt, int status) {
//                 final boolean statusBool = (status == BluetoothGatt.GATT_SUCCESS);
//                 final Message msg = Message.obtain();
//                 msg.what = MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES;
//                 msg.obj = statusBool; // Attach any object you want
//                 mainTaskHandler.sendMessage(msg);
//             }

//             @Override
//             public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic,
//                                               int status) {
//                 Log.d(TAG, "onCharacteristicWrite callback - ");
//                 final byte[] values = characteristic.getValue();
//                 if (status == BluetoothGatt.GATT_SUCCESS) {
//                     Log.d(TAG, "onCharacteristicWrite PROC_QUEUE - " + " glass write successful");
//                     Log.d(TAG, "onCharacteristicWrite len - " + values.length);
//                     final String packetHex = bytesToHex(values);
//                     Log.d(TAG, "onCharacteristicWrite Values - " + packetHex);
//                     final int dataLen = values.length;
//                     if (dataLen > 0) {
//                         final byte packetType = values[0];
//                         final byte[] protobufData = Arrays.copyOfRange(values, 1, dataLen);
//                         switch (packetType) {
//                             case PACKET_TYPE_PROTOBUF:
//                                 // just for test
//                                 decodeProtobufsByWrite(protobufData, packetHex);
//                                 break;
//                         }
//                     }
//                 } else {
//                     Log.e(TAG, " glass write failed with status: " + status);
//                     if (status == 133) {
//                         Log.d(TAG, "GOT THAT 133 STATUS!");
//                     }
//                 }
//                 // clear the waiter
//                 mainWaiter.setFalse();
//             }

//             @Override
//             public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
//                 Log.d(TAG, "PROC - GOT DESCRIPTOR WRITE: " + status);
//                 // clear the waiter
//                 mainServicesWaiter.setFalse();
//             }

//             @Override
//             public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
//                 final boolean statusBool = status == BluetoothGatt.GATT_SUCCESS;
//                 Log.d(TAG, "🔄 MTU Negotiation Result: Success=" + statusBool + ", Device MTU=" + mtu + ", Status=" + status);
                
//                 if (statusBool) {
//                     // Store device capability and calculate actual negotiated MTU
//                     deviceMaxMTU = mtu; // Record what device actually supports
//                     // The actual negotiated MTU is the minimum of our request and device capability
//                     currentMTU = Math.min(MTU_517, mtu);
                    
//                     Log.d(TAG, "🎯 MTU Negotiation Complete:");
//                     Log.d(TAG, "   📱 App Requested: " + MTU_517 + " bytes");
//                     Log.d(TAG, "   📡 Device Supports: " + deviceMaxMTU + " bytes");
//                     Log.d(TAG, "   🤝 Negotiated MTU: " + currentMTU + " bytes");
                    
//                     // Calculate optimal chunk sizes based on negotiated MTU
//                     MAX_CHUNK_SIZE = currentMTU - 10;
//                     BMP_CHUNK_SIZE = currentMTU - 20; // BMP has more config bytes
                    
//                     Log.d(TAG, "✅ MTU Configuration Complete:");
//                     Log.d(TAG, "   📊 Final MTU: " + currentMTU + " bytes");
//                     Log.d(TAG, "   📦 Data Chunk Size: " + MAX_CHUNK_SIZE + " bytes");
//                     Log.d(TAG, "   🖼️ Image Chunk Size: " + BMP_CHUNK_SIZE + " bytes");
//                     Log.d(TAG, "   🔧 Device Maximum: " + deviceMaxMTU + " bytes");
                    
//                 } else {
//                     Log.w(TAG, "❌ MTU Request Failed - Status: " + status + ", Requested: " + mtu);
                    
//                     // Simple fallback strategy: 247 → 23
//                     if (mtu == MTU_517) {
//                         Log.d(TAG, "🔄 247 bytes failed, trying default: " + MTU_DEFAULT + " bytes...");
//                         Log.d(TAG, "📤 Requesting MTU: " + MTU_DEFAULT + " bytes (fallback)");
//                         gatt.requestMtu(MTU_DEFAULT);
//                     } else {
//                         Log.w(TAG, "⚠️ All MTU requests failed, using defaults");
//                         currentMTU = MTU_DEFAULT;
//                         deviceMaxMTU = MTU_DEFAULT;
//                         MAX_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
//                         BMP_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT;
                        
//                         Log.d(TAG, "📋 Fallback Configuration:");
//                         Log.d(TAG, "   📊 Default MTU: " + MTU_DEFAULT + " bytes");
//                         Log.d(TAG, "   📦 Data Chunk Size: " + MAX_CHUNK_SIZE + " bytes");
//                         Log.d(TAG, "   🖼️ Image Chunk Size: " + BMP_CHUNK_SIZE + " bytes");
//                     }
//                 }
//             }

//             @Override
//             public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
//                 final Message msg = Message.obtain();
//                 msg.what = MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED;
//                 msg.obj = characteristic; // Attach any object you want
//                 mainTaskHandler.sendMessage(msg);
//             }

//         };
//     }

//     private void initNexGlasses(BluetoothGatt gatt) {
//         // Start MTU discovery with our maximum target
//         Log.d(TAG, "🔍 MTU Discovery: Requesting maximum MTU size: " + MTU_517);
//         Log.d(TAG, "🎯 Target: Use " + MTU_517 + " bytes max, or " + MTU_DEFAULT + " bytes default");
//         Log.d(TAG, "📤 Requesting MTU: " + MTU_517 + " bytes");
//         gatt.requestMtu(MTU_517); // Request our maximum MTU

//         BluetoothGattService uartService = gatt.getService(MAIN_SERVICE_UUID);

//         if (uartService != null) {
//             BluetoothGattCharacteristic writeChar = uartService.getCharacteristic(WRITE_CHAR_UUID);
//             BluetoothGattCharacteristic notifyChar = uartService.getCharacteristic(NOTIFY_CHAR_UUID);

//             if (writeChar != null) {
//                 mainWriteChar = writeChar;
//                 // enableNotification(gatt, txChar, side);
//                 // txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
//                 Log.d(TAG, " glass TX characteristic found");
//             }

//             if (notifyChar != null) {
//                 mainNotifyChar = notifyChar;
//                 enableNotification(gatt, notifyChar);
//                 // rxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
//                 Log.d(TAG, " glass RX characteristic found");
//             }

//             // Mark as connected but wait for setup below to update connection state
//             isMainConnected = true;
//             Log.d(TAG, "PROC_QUEUE - left side setup complete");

//             // Manufacturer data decoding moved to connection start

//             // setup the NexGlasses
//             if (isMainConnected) {
//                 // do first battery status query
//                 mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_BATTERY_QUERY, 10);

//                 // setup brightness
//                 // sendBrightnessCommandHandler
//                 // .postDelayed(() -> sendBrightnessCommand(brightnessValue,
//                 // shouldUseAutoBrightness), 10);

//                 // Restore previous microphone state or disable if this is the first connection
//                 boolean shouldRestoreMic = microphoneStateBeforeDisconnection;
//                 Log.d(TAG, "Restoring microphone state to: " + shouldRestoreMic + 
//                           " (previous state: " + microphoneStateBeforeDisconnection + ")");
//                 if (shouldRestoreMic) {
//                     startMicBeat((int) MICBEAT_INTERVAL_MS);
//                 } else {
//                     stopMicBeat();
//                 }

//                 // enable our AugmentOS notification key
//                 sendWhiteListCommand(10);

//                 // start mic beat
//                 // startMicBeat(30000);

//                 showHomeScreen(); // turn on the NexGlasses display

//                 updateConnectionState();

//                 // start sending debug notifications
//                 // startPeriodicNotifications(302);
//                 // start sending debug notifications
//                 //just for test
//                 //startPeriodicTextWall(302);
                
//                 // Post protobuf schema version information (only once)
//                 if (!protobufVersionPosted) {
//                     postProtobufSchemaVersionInfo();
//                     protobufVersionPosted = true;
//                 }
                
//                 // Query glasses protobuf version from firmware
//                 queryGlassesProtobufVersionFromFirmware();
//             }
//         } else {
//             Log.e(TAG, " glass UART service not found");
//         }
//     }

//     // working on all phones - must keep the delay
//     private void enableNotification(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
//         Log.d(TAG, "PROC_QUEUE - Starting notification setup for ");

//         // Simply enable notifications
//         Log.d(TAG, "PROC_QUEUE - setting characteristic notification on side: ");
//         boolean result = gatt.setCharacteristicNotification(characteristic, true);
//         Log.d(TAG, "PROC_QUEUE - setCharacteristicNotification result for " + ": " + result);

//         // Set write type for the characteristic
//         characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
//         Log.d(TAG, "PROC_QUEUE - write type set for ");

//         // wait
//         Log.d(TAG, "PROC_QUEUE - waiting to enable it on this side: ");

//         try {
//             Thread.sleep(100);
//         } catch (InterruptedException e) {
//             Log.e(TAG, "Error sending data: " + e.getMessage());
//         }

//         Log.d(TAG, "PROC_QUEUE - get descriptor on side: ");
//         BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID);
//         if (descriptor != null) {
//             Log.d(TAG, "PROC_QUEUE - setting descriptor on side: ");
//             descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
//             boolean r_result = gatt.writeDescriptor(descriptor);
//             Log.d(TAG, "PROC_QUEUE - set descriptor on side: " + " with result: " + r_result);
//         }
//     }

//     private void updateConnectionState() {
//         if (isMainConnected) {
//             connectionState = SmartGlassesConnectionState.CONNECTED;
//             Log.d(TAG, "Main glasses connected");
//             lastConnectionTimestamp = System.currentTimeMillis();
//             // try {
//             // Thread.sleep(100);
//             // } catch (InterruptedException e) {
//             // e.printStackTrace();
//             // }
//             connectionEvent(connectionState);
//         } else {
//             connectionState = SmartGlassesConnectionState.DISCONNECTED;
//             Log.d(TAG, "No Main glasses connected");
//             connectionEvent(connectionState);
//         }
//     }

//     public boolean doPendingPairingIdsMatch() {
//         String mainId = parsePairingIdFromDeviceName(pendingSavedNexMainName);
//         Log.d(TAG, "MainID: " + mainId);

//         // ok, HACKY, but if one of them is null, that means that we connected to the
//         // other on a previous connect
//         // this whole function shouldn't matter anymore anyway as we properly filter for
//         // the device name, so it should be fine
//         // in the future, the way to actually check this would be to check the final ID
//         // string, which is the only one guaranteed to be unique
//         if (mainId == null) {
//             return true;
//         }

//         return mainId != null;
//     }

//     public String parsePairingIdFromDeviceName(String input) {
//         if (input == null || input.isEmpty())
//             return null;
//         // Regular expression to match the number after "G1_"
//         Pattern pattern = Pattern.compile("G1_(\\d+)_");
//         Matcher matcher = pattern.matcher(input);

//         if (matcher.find()) {
//             return matcher.group(1); // Group 1 contains the number
//         }
//         return null; // Return null if no match is found
//     }

//     public void savePreferredNexGlassesDeviceId(Context context, String deviceName) {
//         context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE).edit()
//                 .putString(SAVED_NEX_ID_KEY, deviceName).apply();
//     }

//     public String getPreferredMainDeviceId(Context context) {
//         SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
//         return prefs.getString(SAVED_NEX_ID_KEY, null);
//     }

//     public int getSavedBrightnessValue(Context context) {
//         return Integer.parseInt(PreferenceManager.getDefaultSharedPreferences(context)
//                 .getString(context.getResources().getString(R.string.SHARED_PREF_BRIGHTNESS), "50"));
//     }

//     public boolean getSavedAutoBrightnessValue(Context context) {
//         return PreferenceManager.getDefaultSharedPreferences(context)
//                 .getBoolean(context.getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), false);
//     }

//     private void savePairedDeviceNames() {
//         if (savedNexMainName != null) {
//             context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE).edit()
//                     .putString(NEX_MAIN_DEVICE_KEY, savedNexMainName).apply();
//             Log.d(TAG, "Saved paired device names: " + savedNexMainName);
//         }
//     }

//     private void loadPairedDeviceNames() {
//         SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
//         savedNexMainName = prefs.getString(NEX_MAIN_DEVICE_KEY, null);
//         Log.d(TAG, "Loaded paired device names: " + savedNexMainName);
//     }

//     private void savePairedDeviceAddress() {
//         if (savedNexMainAddress != null) {
//             context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE).edit()
//                     .putString(NEX_MAIN_DEVICE_ADDRESS, savedNexMainAddress).apply();
//             Log.d(TAG, "Saved paired device address: " + savedNexMainAddress);
//         }
//     }

//     private void loadPairedDeviceAddress() {
//         SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
//         savedNexMainAddress = prefs.getString(NEX_MAIN_DEVICE_ADDRESS, null);
//         Log.d(TAG, "Loaded paired device address: " + savedNexMainAddress);
//     }

//     public void deleteEvenSharedPreferences(Context context) {
//         savePreferredNexGlassesDeviceId(context, null);
//         SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE);
//         prefs.edit().clear().apply();
//         Log.d(TAG, "Nuked EvenRealities SharedPreferences");
//     }

//     private void connectToGatt(BluetoothDevice device) {
//         if (device == null) {
//             Log.e(TAG, "Cannot connect to GATT: device is null");
//             return;
//         }

//         Log.d(TAG, "connectToGatt called for device: " + device.getName() + " (" + device.getAddress() + ")");
//         BluetoothAdapter bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
//         if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
//             Log.e(TAG, "Bluetooth is disabled or not available. Cannot reconnect to glasses.");
//             return;
//         }

//         // Reset the services waiter based on device name
//         Log.d(TAG, "Device identified as main side. Resetting ServicesWaiter.");
//         mainServicesWaiter.setTrue();

//         // Establish GATT connection based on device name and current connection state
//         Log.d(TAG, "Connecting GATT to main side.");
//         mainGlassGatt = device.connectGatt(context, false, mainGattCallback);
//         isMainConnected = false; // Reset connection state
//         Log.d(TAG, "Main GATT connection initiated. isMainConnected set to false.");
//     }

//     private void reconnectToGatt(BluetoothDevice device) {
//         if (isKilled) {
//             return;
//         }
//         connectToGatt(device); // Reuse the connectToGatt method
//     }

//     private final ScanCallback modernScanCallback = new ScanCallback() {
//         @Override
//         public void onScanResult(int callbackType, ScanResult result) {
//             BluetoothDevice device = result.getDevice();
//             String name = device.getName();

//             // Now you can reference the bluetoothAdapter field if needed:
//             if (!bluetoothAdapter.isEnabled()) {
//                 Log.e(TAG, "Bluetooth is disabled");
//                 return;
//             }
//             Log.d(TAG, " === New Device is Found ===" + name + " " + device.getAddress());
//             Log.d(TAG, " === new Glasses Device Information ===");

//             // Log all available device information for debugging
//             Log.d(TAG, "=== Device Information ===");
//             Log.d(TAG, "Device Name: " + name);
//             Log.d(TAG, "Device Address: " + device.getAddress());
//             Log.d(TAG, "Device Type: " + device.getType());
//             Log.d(TAG, "Device Class: " + device.getBluetoothClass());
//             Log.d(TAG, "Bond State: " + device.getBondState());

//             // If we already have saved device names for main...
//             if (name != null && savedNexMainName != null) {
//                 if (!(name.contains(savedNexMainName))) {
//                     return; // Not a matching device
//                 }
//             }

//             // Identify which side (main)
//             stopScan();
//             mainDevice = device;
//             mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0); // 1
//             // second
//             // delay
//         }

//         @Override
//         public void onScanFailed(int errorCode) {
//             Log.e(TAG, "Scan failed with error: " + errorCode);
//         }
//     };

//     private void resetAllBondsAndState() {
//         Log.d(TAG, "Resetting ALL bonds and internal state for complete fresh start");

//         // Remove both bonds if devices exist
//         if (mainDevice != null) {
//             removeBond(mainDevice);
//         }

//         // Reset all internal state
//         isMainConnected = false;

//         // Clear saved device names
//         pendingSavedNexMainName = null;

//         // Close any existing GATT connections
//         if (mainGlassGatt != null) {
//             mainGlassGatt.disconnect();
//             mainGlassGatt.close();
//             mainGlassGatt = null;
//         }

//         // Wait briefly for bond removal to complete
//         new Handler(Looper.getMainLooper()).postDelayed(() -> {
//             Log.d(TAG, "Restarting scan after complete bond/state reset");
//             connectionState = SmartGlassesConnectionState.SCANNING;
//             connectionEvent(connectionState);
//             startScan();
//         }, 2000);
//     }

//     /**
//      * Handles a device with a valid bond
//      */
//     private void handleValidBond(BluetoothDevice device, boolean isLeft) {
//         Log.d(TAG, "Handling valid bond for " + (isLeft ? "left" : "right") + " glass");

//         // Update state

//         // If both glasses are bonded, connect to GATT
//         if (mainDevice != null) {
//             Log.d(TAG, "Both glasses have valid bonds - ready to connect to GATT");

//             mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0); // 1 second delay
//         } else {
//             // Continue scanning for the other glass
//             Log.d(TAG, "Still need to find " + (isLeft ? "right" : "left") + " glass - resuming scan");
//             startScan();
//         }
//     }

//     /**
//      * Removes an existing bond with a Bluetooth device to force fresh pairing
//      */
//     private boolean removeBond(BluetoothDevice device) {
//         try {
//             if (device == null) {
//                 Log.e(TAG, "Cannot remove bond: device is null");
//                 return false;
//             }

//             Method method = device.getClass().getMethod("removeBond");
//             boolean result = (Boolean) method.invoke(device);
//             Log.d(TAG, "Removing bond for device " + device.getName() + ", result: " + result);
//             return result;
//         } catch (Exception e) {
//             Log.e(TAG, "Error removing bond: " + e.getMessage(), e);
//             return false;
//         }
//     }

//     @Override
//     public void connectToSmartGlasses(SmartGlassesDevice device) {
//         // Register bonding receiver
//         Log.d(TAG, "connectToSmartGlasses start");
//         Log.d(TAG, "try to ConnectToSmartGlassesing deviceModelName:" + device.deviceModelName + "  deviceAddress:"
//                 + device.deviceAddress);

//         preferredMainDeviceId = getPreferredMainDeviceId(context);

//         if (!bluetoothAdapter.isEnabled()) {
//             return;
//         }

//         if (device.deviceModelName != null && device.deviceAddress != null) {
//             stopScan();
//             mainDevice = bluetoothAdapter.getRemoteDevice(device.deviceAddress);
//             mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0);
//             return;
//         }
//         if (savedNexMainAddress != null) {
//             mainDevice = bluetoothAdapter.getRemoteDevice(savedNexMainAddress);
//             mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0);
//             return;
//         }

//         // Start scanning for devices
//         stopScan();
//         connectionState = SmartGlassesConnectionState.SCANNING;
//         connectionEvent(connectionState);
//         startScan();
//     }

//     private void startScan() {
//         BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
//         if (scanner == null) {
//             Log.e(TAG, "BluetoothLeScanner not available.");
//             return;
//         }

//         // Optionally, define filters if needed
//         List<ScanFilter> filters = new ArrayList<>();
//         // For example, to filter by device name:
//         // filters.add(new ScanFilter.Builder().setDeviceName("Even G1_").build());

//         // Set desired scan settings
//         ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();

//         // Start scanning
//         isScanning = true;
//         scanner.startScan(filters, settings, modernScanCallback);
//         scanner.flushPendingScanResults(modernScanCallback);
//         Log.d(TAG, "CALL START SCAN - Started scanning for devices...");

//         // Ensure scanning state is immediately communicated to UI
//         connectionState = SmartGlassesConnectionState.SCANNING;
//         connectionEvent(connectionState);

//         // Stop the scan after some time (e.g., 10-15s instead of 60 to avoid
//         // throttling)
//         // handler.postDelayed(() -> stopScan(), 10000);
//     }

//     private void stopScan() {
//         BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
//         if (scanner != null) {
//             scanner.stopScan(modernScanCallback);
//         }
//         isScanning = false;
//         Log.d(TAG, "Stopped scanning for devices");
//         if (bleScanCallback != null && isScanningForCompatibleDevices) {
//             scanner.stopScan(bleScanCallback);
//             isScanningForCompatibleDevices = false;
//         }

//     }

//     private void bondDevice(BluetoothDevice device) {
//         try {
//             Log.d(TAG, "Attempting to bond with device: " + device.getName());
//             Method method = device.getClass().getMethod("createBond");
//             method.invoke(device);
//         } catch (Exception e) {
//             Log.e(TAG, "Bonding failed: " + e.getMessage());
//         }
//     }

//     private void attemptGattConnection(BluetoothDevice device) {
//         // if (!isKilled)

//         if (device == null) {
//             Log.d(TAG, "Cannot connect to GATT: Device is null");
//             return;
//         }

//         String deviceName = device.getName();
//         if (deviceName == null) {
//             Log.d(TAG, "Skipping null device name: " + device.getAddress()
//                     + "... this means something horriffic has occured. Look into this.");
//             return;
//         }

//         Log.d(TAG, "attemptGattConnection called for device: " + deviceName + " (" + device.getAddress() + ")");

//         connectionState = SmartGlassesConnectionState.CONNECTING;
//         Log.d(TAG, "Setting connectionState to CONNECTING. Notifying connectionEvent.");
//         connectionEvent(connectionState);

//         connectLeftDevice(device);
//     }

//     private void connectLeftDevice(BluetoothDevice device) {
//         if (mainGlassGatt == null) {
//             Log.d(TAG, "Attempting GATT connection for Main Glass...");
//             mainGlassGatt = device.connectGatt(context, false, mainGattCallback);
//             isMainConnected = false;
//             Log.d(TAG, "Main GATT connection initiated. isMainConnected set to false.");
//         } else {
//             Log.d(TAG, "Main Glass GATT already exists");
//         }
//     }

//     private byte[] createTextPackage(String text, int currentPage, int totalPages, int screenStatus) {
//         byte[] textBytes = text.getBytes();
//         ByteBuffer buffer = ByteBuffer.allocate(9 + textBytes.length);
//         buffer.put((byte) 0x4E);
//         buffer.put((byte) (currentSeq++ & 0xFF));
//         buffer.put((byte) 1);
//         buffer.put((byte) 0);
//         buffer.put((byte) screenStatus);
//         buffer.put((byte) 0);
//         buffer.put((byte) 0);
//         buffer.put((byte) currentPage);
//         buffer.put((byte) totalPages);
//         buffer.put(textBytes);

//         return buffer.array();
//     }

//     // Data class to represent a send request
//     private class SendRequest {
//         final byte[] data;
//         public int waitTime = -1;

//         SendRequest(byte[] data) {
//             this.data = data;
//         }

//         SendRequest(byte[] data, int waitTime) {
//             this.data = data;
//             this.waitTime = waitTime;
//         }
//     }

//     // Queue to hold pending requests
//     private final BlockingQueue<SendRequest[]> sendQueue = new LinkedBlockingQueue<>();

//     private volatile boolean isWorkerRunning = false;

//     // Non-blocking function to add new send request
//     private void sendDataSequentially(byte[] data) {
//         SendRequest[] chunks = {new SendRequest(data)};
//         sendQueue.offer(chunks);
//         startWorkerIfNeeded();
//     }

//     // Non-blocking function to add new send request
//     private void sendDataSequentially(byte[] data, int waitTime) {
//         SendRequest[] chunks = {new SendRequest(data, waitTime)};
//         sendQueue.offer(chunks);
//         startWorkerIfNeeded();
//     }

//     private void sendDataSequentially(List<byte[]> data) {
//         SendRequest[] chunks = new SendRequest[data.size()];
//         for (int i = 0; i < data.size(); i++) {
//             chunks[i] = new SendRequest(data.get(i));
//         }
//         sendQueue.offer(chunks);
//         startWorkerIfNeeded();
//     }

//     // Start the worker thread if it's not already running
//     private synchronized void startWorkerIfNeeded() {
//         if (!isWorkerRunning) {
//             isWorkerRunning = true;
//             new Thread(this::processQueue, "MentraNexSGCProcessQueue").start();
//         }
//     }

//     public class BooleanWaiter {
//         private boolean flag = true; // initially true

//         public synchronized void waitWhileTrue() throws InterruptedException {
//             while (flag) {
//                 wait();
//             }
//         }

//         public synchronized void setTrue() {
//             flag = true;
//         }

//         public synchronized void setFalse() {
//             flag = false;
//             notifyAll();
//         }
//     }

//     private final BooleanWaiter mainWaiter = new BooleanWaiter();
//     private final BooleanWaiter mainServicesWaiter = new BooleanWaiter();
//     private final long INITIAL_CONNECTION_DELAY_MS = 350; // Adjust this value as needed

//     private void processQueue() {
//         // First wait until the services are setup and ready to receive data
//         Log.d(TAG, "PROC_QUEUE - waiting on services waiters");
//         try {
//             mainServicesWaiter.waitWhileTrue();
//         } catch (InterruptedException e) {
//             Log.e(TAG, "Interrupted waiting for descriptor writes: " + e);
//         }
//         Log.d(TAG, "PROC_QUEUE - DONE waiting on services waiters");

//         while (!isKilled) {
//             try {
//                 // Make sure services are ready before processing requests
//                 mainServicesWaiter.waitWhileTrue();

//                 // This will block until data is available - no CPU spinning!
//                 SendRequest[] requests = sendQueue.take();

//                 for (SendRequest request : requests) {
//                     if (request == null) {
//                         isWorkerRunning = false;
//                         break;
//                     }

//                     try {
//                         // Force an initial delay so BLE gets all setup
//                         long timeSinceConnection = System.currentTimeMillis() - lastConnectionTimestamp;
//                         if (timeSinceConnection < INITIAL_CONNECTION_DELAY_MS) {
//                             Thread.sleep(INITIAL_CONNECTION_DELAY_MS - timeSinceConnection);
//                         }

//                         // Send to main glass
//                         if (mainGlassGatt != null && mainWriteChar != null && isMainConnected) {
//                             mainWaiter.setTrue();
//                             mainWriteChar.setValue(request.data);
//                             mainGlassGatt.writeCharacteristic(mainWriteChar);
//                             lastSendTimestamp = System.currentTimeMillis();
//                         }

//                         mainWaiter.waitWhileTrue();

//                         Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND);

//                         // If the packet asked us to do a delay, then do it
//                         if (request.waitTime != -1) {
//                             Thread.sleep(request.waitTime);
//                         }
//                     } catch (InterruptedException e) {
//                         Log.e(TAG, "Error sending data: " + e.getMessage());
//                         if (isKilled)
//                             break;
//                     }
//                 }
//             } catch (InterruptedException e) {
//                 if (isKilled) {
//                     Log.d(TAG, "Process queue thread interrupted - shutting down");
//                     break;
//                 }
//                 Log.e(TAG, "Error in queue processing: " + e.getMessage());
//             }
//         }

//         Log.d(TAG, "Process queue thread exiting");
//     }

//     private final int NOTIFICATION = 0x4B; // Notification command

//     private String createNotificationJson(String appIdentifier, String title, String subtitle, String message) {
//         long currentTime = System.currentTimeMillis() / 1000L; // Unix timestamp in seconds
//         String currentDate = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new java.util.Date()); // Date
//         // format
//         // for
//         // 'date'
//         // field

//         NCSNotification ncsNotification = new NCSNotification(notificationNum++, // Increment sequence ID for uniqueness
//                 1, // type (e.g., 1 = notification type)
//                 appIdentifier, title, subtitle, message, (int) currentTime, // Cast long to int to match Python
//                 currentDate, // Add the current date to the notification
//                 "AugmentOS" // display_name
//         );

//         Notification notification = new Notification(ncsNotification, "Add");

//         return gson.toJson(notification);
//     }

//     class Notification {
//         NCSNotification ncs_notification;
//         String type;

//         public Notification() {
//             // Default constructor
//         }

//         public Notification(NCSNotification ncs_notification, String type) {
//             this.ncs_notification = ncs_notification;
//             this.type = type;
//         }
//     }

//     class NCSNotification {
//         int msg_id;
//         int type;
//         String app_identifier;
//         String title;
//         String subtitle;
//         String message;
//         int time_s; // Changed from long to int for consistency
//         String date; // Added to match Python's date field
//         String display_name;

//         public NCSNotification(int msg_id, int type, String app_identifier, String title, String subtitle,
//                                String message, int time_s, String date, String display_name) {
//             this.msg_id = msg_id;
//             this.type = type;
//             this.app_identifier = app_identifier;
//             this.title = title;
//             this.subtitle = subtitle;
//             this.message = message;
//             this.time_s = time_s;
//             this.date = date; // Initialize the date field
//             this.display_name = display_name;
//         }
//     }

//     private List<byte[]> createNotificationChunks(String json) {
//         final int MAX_CHUNK_SIZE = 176; // 180 - 4 header bytes
//         byte[] jsonBytes = json.getBytes(StandardCharsets.UTF_8);
//         int totalChunks = (int) Math.ceil((double) jsonBytes.length / MAX_CHUNK_SIZE);

//         List<byte[]> chunks = new ArrayList<>();
//         for (int i = 0; i < totalChunks; i++) {
//             int start = i * MAX_CHUNK_SIZE;
//             int end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.length);
//             byte[] payloadChunk = Arrays.copyOfRange(jsonBytes, start, end);

//             // Create the header
//             byte[] header = new byte[]{(byte) NOTIFICATION, 0x00, // notify_id (can be updated as needed)
//                     (byte) totalChunks, (byte) i};

//             // Combine header and payload
//             ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
//             chunk.put(header);
//             chunk.put(payloadChunk);

//             chunks.add(chunk.array());
//         }

//         return chunks;
//     }

//     @Override
//     public void displayReferenceCardSimple(String title, String body) {
//         Log.d(TAG, "displayReferenceCardSimple title: " + title + " body:" + body);
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         byte[] textChunks = createTextWallChunksForNex(title + "\n\n" + body);
//         sendDataSequentially(textChunks);
// //        List<byte[]> chunks = createTextWallChunks(title + "\n\n" + body);
// //        for (int i = 0; i < chunks.size(); i++) {
// //            byte[] chunk = chunks.get(i);
// //            boolean isLastChunk = (i == chunks.size() - 1);
// //
// //            if (isLastChunk) {
// //                sendDataSequentially(chunk);
// //            } else {
// //                sendDataSequentially(chunk, 300);
// //            }
// //        }
//         Log.d(TAG, "Send simple reference card");
//     }

//     @Override
//     public void destroy() {
//         Log.d(TAG, "MentraNexSGC ONDESTROY");

//         // SpeechRecAugmentos.getInstance(context).destroy();

//         showHomeScreen();
//         isKilled = true;

//         // stop BLE scanning
//         stopScan();

//         // Save current microphone state before destroying (for potential future reconnection)
//         microphoneStateBeforeDisconnection = isMicrophoneEnabled;
//         Log.d(TAG, "Saved microphone state during destroy: " + microphoneStateBeforeDisconnection);

//         // disable the microphone and stop sending micbeat
//         stopMicBeat();

//         // Stop periodic notifications
//         stopPeriodicNotifications();

//         // Stop periodic text wall
//         // stopPeriodicNotifications();

//         if (mainGlassGatt != null) {
//             mainGlassGatt.disconnect();
//             mainGlassGatt.close();
//             mainGlassGatt = null;
//         }

//         if (lc3AudioPlayer != null) {
//             try {
//                 lc3AudioPlayer.stopPlay();
//                 Log.d(TAG, "LC3 audio player stopped and cleaned up");
//             } catch (Exception e) {
//                 Log.e(TAG, "Error stopping LC3 audio player during destroy", e);
//             } finally {
//                 lc3AudioPlayer = null;
//             }
//         }

//         if (mainTaskHandler != null) {
//             mainTaskHandler.removeCallbacksAndMessages(null);
//         }
//         if (whiteListHandler != null) {
//             whiteListHandler.removeCallbacksAndMessages(null);
//         }
//         if (micEnableHandler != null) {
//             micEnableHandler.removeCallbacksAndMessages(null);
//         }
//         if (notificationHandler != null) {
//             notificationHandler.removeCallbacks(notificationRunnable);
//         }
//         if (textWallHandler != null) {
//             textWallHandler.removeCallbacks(textWallRunnable);
//         }
//         // if (goHomeHandler != null)
//         // goHomeHandler.removeCallbacks(goHomeRunnable);
//         if (findCompatibleDevicesHandler != null) {
//             findCompatibleDevicesHandler.removeCallbacksAndMessages(null);
//         }
//         // free LC3 decoder
//         if (lc3DecoderPtr != 0) {
//             L3cCpp.freeDecoder(lc3DecoderPtr);
//             lc3DecoderPtr = 0;
//         }

//         currentImageChunks.clear();
//         isImageSendProgressing = false;

//         sendQueue.clear();

//         // Add a dummy element to unblock the take() call if needed
//         sendQueue.offer(new SendRequest[0]); // is this needed?

//         isWorkerRunning = false;

//         isMainConnected = false;

//         Log.d(TAG, "MentraNexSGC cleanup complete");
//     }

//     @Override
//     public boolean isConnected() {
//         return connectionState == SmartGlassesConnectionState.CONNECTED;
//     }

//     // Remaining methods
//     @Override
//     public void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageInput) {
//         Log.d(TAG,
//                 "showNaturalLanguageCommandScreen prompt: " + prompt + " naturalLanguageInput:" + naturalLanguageInput);

//     }

//     @Override
//     public void updateNaturalLanguageCommandScreen(String naturalLanguageArgs) {
//         Log.d(TAG, "updateNaturalLanguageCommandScreen naturalLanguageArgs: " + naturalLanguageArgs);

//     }

//     @Override
//     public void scrollingTextViewIntermediateText(String text) {
//         Log.d(TAG, "scrollingTextViewIntermediateText text: " + text);

//     }

//     @Override
//     public void scrollingTextViewFinalText(String text) {
//         Log.d(TAG, "scrollingTextViewFinalText text: " + text);
//     }

//     @Override
//     public void stopScrollingTextViewMode() {
//         Log.d(TAG, "stopScrollingTextViewMode ");
//     }

//     @Override
//     public void displayPromptView(String title, String[] options) {
//         Log.d(TAG, "displayPromptView text:" + title);
//     }

//     @Override
//     public void displayTextLine(String text) {
//         Log.d(TAG, "displayTextLine text:" + text);
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         if (updatingScreen) {
//             return;
//         }
//         byte[] textChunks = createTextWallChunksForNex(text);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void displayBitmap(Bitmap bmp) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayBitmap ");
//         try {
//             byte[] bmpBytes = BitmapJavaUtils.convertBitmapTo1BitBmpBytes(bmp, false);
//             displayBitmapImageForNexGlasses(bmpBytes, bmp.getWidth(), bmp.getHeight());
//         } catch (Exception e) {
//             Log.e(TAG, e.getMessage());
//         }
//     }

//     @Override
//     public void blankScreen() {
//         Log.d(TAG, "blankScreen ");
//     }

//     @Override
//     public void displayDoubleTextWall(String textTop, String textBottom) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayDoubleTextWall textTop:" + textTop + " textBottom:" + textBottom);
//         if (updatingScreen) {
//             return;
//         }
//         // List<byte[]> chunks = createDoubleTextWallChunks(textTop, textBottom);
//         // sendChunks(chunks);
//         StringBuilder textBuilder = new StringBuilder();
//         if (textTop != null) {
//             textBuilder.append(textTop).append("\n");
//         }
//         if (textBottom != null) {
//             textBuilder.append(textBottom);
//         }
//         final String finalText = textBuilder.toString();
//         byte[] textChunks = createTextWallChunksForNex(finalText);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void showHomeScreen() {
//         Log.d(TAG, "showHomeScreen ");
//         // dis for test
//         // displayTextWall(" ");

//         if (lastThingDisplayedWasAnImage) {
//             // clearNexScreen();
//             lastThingDisplayedWasAnImage = false;
//         }
//     }

//     public void clearNexGlassesScreen() {
//         Log.d(TAG, "Clearing NexGlasses screen");
//         // byte[] exitCommand = new byte[] { (byte) 0x18 };
//         // sendDataSequentially(exitCommand, false);
//         byte[] theClearBitmapOrSomething = loadEmptyBmpFromAssets();
//         Bitmap bmp = BitmapJavaUtils.bytesToBitmap(theClearBitmapOrSomething);
//         try {
//             byte[] bmpBytes = BitmapJavaUtils.convertBitmapTo1BitBmpBytes(bmp, false);
//             displayBitmapImage(bmpBytes);
//         } catch (Exception e) {
//             Log.e(TAG, "Error displaying clear bitmap: " + e.getMessage());
//         }
//     }

//     @Override
//     public void setFontSize(SmartGlassesFontSize fontSize) {
//         Log.d(TAG, "setFontSize ");
//     }

//     @Override
//     public void displayRowsCard(String[] rowStrings) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayRowsCard rowStrings:" + rowStrings.toString());
//         if (updatingScreen) {
//             return;
//         }
//         if (rowStrings == null || rowStrings.length == 0) {
//             return;
//         }
//         StringBuilder textBuilder = new StringBuilder();
//         for (String bullet : rowStrings) {
//             textBuilder.append(bullet).append("\n");
//         }
//         final String finalText = textBuilder.toString();
//         byte[] textChunks = createTextWallChunksForNex(finalText);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void displayBulletList(String title, String[] bullets) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayBulletList title:" + title + " bullets:" + bullets.toString());
//         if (updatingScreen) {
//             return;
//         }
//         StringBuilder textBuilder = new StringBuilder();
//         if (title != null) {
//             textBuilder.append(title).append("\n");
//         }
//         for (String bullet : bullets) {
//             textBuilder.append(bullet).append("\n");
//         }
//         final String finalText = textBuilder.toString();
//         byte[] textChunks = createTextWallChunksForNex(finalText);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void displayReferenceCardImage(String title, String body, String imgUrl) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayReferenceCardImage title:" + title + " body:" + body);
//     }

//     @Override
//     public void displayTextWall(String text) {
//         Log.d(TAG, "displayTextWall updatingScreen: " + updatingScreen + " text:" + text);
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         if (updatingScreen) {
//             return;
//         }
//         byte[] textChunks = createTextWallChunksForNex(text);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void setUpdatingScreen(boolean updatingScreen) {
//         Log.d(TAG, "setUpdatingScreen updatingScreen:" + updatingScreen);
//         this.updatingScreen = updatingScreen;
//     }

//     @Override
//     public void setFontSizes() {
//         Log.d(TAG, "setFontSizes ");
//     }

//     // get the final full binary packet
//     private byte[] generateProtobufCommandBytes(PhoneToGlasses phoneToGlasses) {
//         final byte[] contentBytes = phoneToGlasses.toByteArray();
//         final ByteBuffer chunk = ByteBuffer.allocate(contentBytes.length + 1);

//         chunk.put(PACKET_TYPE_PROTOBUF);
//         chunk.put(contentBytes);
        
//         // Enhanced logging for protobuf messages
//         byte[] result = chunk.array();
//         logProtobufMessage(phoneToGlasses, result);
        
//         return result;
//     }
    
//     // Enhanced logging method for protobuf messages
//     private void logProtobufMessage(PhoneToGlasses phoneToGlasses, byte[] fullMessage) {
//         StringBuilder logMessage = new StringBuilder();
//         logMessage.append("=== PROTOBUF MESSAGE TO GLASSES ===\n");
//         logMessage.append("Message Type: ").append(phoneToGlasses.getPayloadCase()).append("\n");
        
//         // Extract and log text content if present
//         if (phoneToGlasses.hasDisplayText()) {
//             String text = phoneToGlasses.getDisplayText().getText();
//             logMessage.append("Text Content: \"").append(text).append("\"\n");
//             logMessage.append("Text Length: ").append(text.length()).append(" characters\n");
//         } else if (phoneToGlasses.hasDisplayScrollingText()) {
//             String text = phoneToGlasses.getDisplayScrollingText().getText();
//             logMessage.append("Scrolling Text Content: \"").append(text).append("\"\n");
//             logMessage.append("Text Length: ").append(text.length()).append(" characters\n");
//         }
        
//         // Log message size information
//         logMessage.append("Protobuf Payload Size: ").append(phoneToGlasses.toByteArray().length).append(" bytes\n");
//         logMessage.append("Total Message Size: ").append(fullMessage.length).append(" bytes\n");
//         logMessage.append("Packet Type: 0x").append(String.format("%02X", PACKET_TYPE_PROTOBUF)).append("\n");
//         logMessage.append("=====================================");
        
//         Log.d(TAG, logMessage.toString());
//     }

//     // Heartbeat methods for Nex Glasses
//     // Note: Glasses send ping, phone responds with pong
//     private byte[] constructPongResponse() {
//         Log.d(TAG, "Constructing pong response to glasses ping");
        
//         // Create the PongResponse message
//         PongResponse pongResponse = PongResponse.newBuilder().build();

//         // Create the PhoneToGlasses message with the pong response
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setPong(pongResponse).build();

//         return generateProtobufCommandBytes(phoneToGlasses);
//     }

//     private byte[] constructBatteryLevelQuery() {
//         BatteryStateRequest batteryStateRequest = BatteryStateRequest.newBuilder().build();

//         // Create the PhoneToGlasses using its builder and set the batteryStateRequest
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setBatteryState(batteryStateRequest).build();

//         return generateProtobufCommandBytes(phoneToGlasses);

//     }
    
//     /**
//      * Queries the protobuf schema version from the glasses firmware
//      */
//     private void queryGlassesProtobufVersionFromFirmware() {
//         Log.d(TAG, "=== SENDING GLASSES PROTOBUF VERSION REQUEST ===");
        
//         // Generate unique message ID for this request
//         String msgId = "ver_req_" + System.currentTimeMillis();
        
//         VersionRequest versionRequest = VersionRequest.newBuilder()
//                 .setMsgId(msgId)
//                 .build();

//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//                 .setMsgId(msgId)
//                 .setVersionRequest(versionRequest)
//                 .build();

//         byte[] versionQueryPacket = generateProtobufCommandBytes(phoneToGlasses);
//         sendDataSequentially(versionQueryPacket, 100);
        
//         Log.d(TAG, "Sent glasses protobuf version request with msg_id: " + msgId);
//     }

//     // periodically send a mic ON request so it never turns off
//     private void startMicBeat(int delay) {
//         Log.d(TAG, "Starting micbeat");
//         if (micBeatCount > 0) {
//             stopMicBeat();
//         }
//         setMicEnabled(true, 10);

//         micBeatRunnable = new Runnable() {
//             @Override
//             public void run() {
//                 Log.d(TAG, "SENDING MIC BEAT");
//                 setMicEnabled(shouldUseGlassesMic, 1);
//                 micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS);
//             }
//         };

//         micBeatHandler.postDelayed(micBeatRunnable, delay);
//     }

//     @Override
//     public void findCompatibleDeviceNames() {
//         Log.d(TAG, "findCompatibleDeviceNames action");
//         findCompatibleDeviceNamesHandler();

//     }

//     private void findCompatibleDeviceNamesHandler() {
//         if (isScanningForCompatibleDevices) {
//             Log.d(TAG, "Scan already in progress, skipping...");
//             return;
//         }
//         isScanningForCompatibleDevices = true;
//         BluetoothLeScanner scanner = bluetoothAdapter.getBluetoothLeScanner();
//         if (scanner == null) {
//             Log.e(TAG, "BluetoothLeScanner not available");
//             isScanningForCompatibleDevices = false;
//             return;
//         }

//         List<String> foundDeviceNames = new ArrayList<>();
//         if (findCompatibleDevicesHandler == null) {
//             findCompatibleDevicesHandler = new Handler(Looper.getMainLooper());
//         }

//         // Optional: add filters if you want to narrow the scan
//         List<ScanFilter> filters = new ArrayList<>();
//         ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build();

//         // Create a modern ScanCallback instead of the deprecated LeScanCallback
//         bleScanCallback = new ScanCallback() {
//             @Override
//             public void onScanResult(int callbackType, ScanResult result) {
//                 BluetoothDevice device = result.getDevice();
//                 String name = device.getName();
//                 String address = device.getAddress();
//                 // if (name != null && name.contains("Even G1_") && name.contains("_L_")) {
//                 // if (name != null && name.toUpperCase().startsWith("E2:D5")) {
//                 if (name != null) {
//                     Log.d(TAG, "bleScanCallback onScanResult: " + name + " address " + device.getAddress());
//                     synchronized (foundDeviceNames) {
//                         if (!foundDeviceNames.contains(name)) {
//                             foundDeviceNames.add(name);
//                             Log.d(TAG, "Found smart glasses: " + name);
//                             // String adjustedName = parsePairingIdFromDeviceName(name);
//                             String adjustedName = smartGlassesDevice.deviceModelName;// parsePairingIdFromDeviceName(name);
//                             EventBus.getDefault().post(new GlassesBluetoothSearchDiscoverEvent(
//                                     smartGlassesDevice.deviceModelName, name, address));
//                         }
//                     }
//                 }
//             }

//             @Override
//             public void onBatchScanResults(List<ScanResult> results) {
//                 // If needed, handle batch results here
//             }

//             @Override
//             public void onScanFailed(int errorCode) {
//                 Log.e(TAG, "BLE scan failed with code: " + errorCode);
//             }
//         };

//         // Start scanning
//         scanner.startScan(filters, settings, bleScanCallback);
//         Log.d(TAG, "Started scanning for smart glasses with BluetoothLeScanner...");
//         scanner.flushPendingScanResults(bleScanCallback);
//         // Stop scanning after 10 seconds (adjust as needed)
//         findCompatibleDevicesHandler.postDelayed(() -> {
//             if (bleScanCallback != null) {
//                 scanner.stopScan(bleScanCallback);
//             }
//             isScanningForCompatibleDevices = false;
//             bleScanCallback = null;
//             Log.d(TAG, "Stopped scanning for smart glasses.");
//             EventBus.getDefault().post(new GlassesBluetoothSearchStopEvent(smartGlassesDevice.deviceModelName));
//         }, 10000);
//     }

//     private void sendWhiteListCommand(int delay) {
//         if (whiteListedAlready) {
//             return;
//         }
//         whiteListedAlready = true;

//         Log.d(TAG, "Sending whitelist command");
//         whiteListHandler.postDelayed(new Runnable() {
//             @Override
//             public void run() {
//                 List<byte[]> chunks = getWhitelistChunks();
//                 sendDataSequentially(chunks);
//                 // for (byte[] chunk : chunks) {
//                 // Log.d(TAG, "Sending this chunk for white list:" + bytesToUtf8(chunk));
//                 // sendDataSequentially(chunk, false);
//                 //
//                 //// // Sleep for 100 milliseconds between sending each chunk
//                 //// try {
//                 //// Thread.sleep(150);
//                 //// } catch (InterruptedException e) {
//                 //// e.printStackTrace();
//                 //// }
//                 // }
//             }
//         }, delay);
//     }

//     private void stopMicBeat() {
//         setMicEnabled(false, 10);
//         if (micBeatHandler != null) {
//             micBeatHandler.removeCallbacksAndMessages(null);
//             micBeatHandler.removeCallbacksAndMessages(micBeatRunnable);
//             micBeatRunnable = null;
//             micBeatCount = 0;
//         }
//     }

//     private void sendPongResponse() {
//         // Respond to ping from glasses with pong
//         lastHeartbeatReceivedTime = System.currentTimeMillis();
//         Log.d(TAG, "=== SENDING PONG RESPONSE TO GLASSES === (Time: " + lastHeartbeatReceivedTime + ")");
        
//         byte[] pongPacket = constructPongResponse();

//         // Send the pong response
//         if (pongPacket != null) {
//             sendDataSequentially(pongPacket, 100);
//             Log.d(TAG, "Pong response sent successfully");
            
//             // Notify mobile app about pong sent
//             notifyHeartbeatSent(System.currentTimeMillis());
//         } else {
//             Log.e(TAG, "Failed to construct pong response packet");
//         }

//         // Still query battery periodically (every 10 pings received)
//         if (batteryMain == -1 || heartbeatCount % 10 == 0) {
//             mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_BATTERY_QUERY, 500);
//         }

//         heartbeatCount++;
        
//         // Notify mobile app about heartbeat received
//         notifyHeartbeatReceived(lastHeartbeatReceivedTime);
//     }

//     private void queryBatteryStatus() {
//         Log.d(TAG, "=== SENDING BATTERY STATUS QUERY TO GLASSES ===");
//         byte[] batteryQueryPacket = constructBatteryLevelQuery();
//         // Log.d(TAG, "Sending battery status query: " +
//         // bytesToHex(batteryQueryPacket));

//         sendDataSequentially(batteryQueryPacket, 250);
//     }

//     public void sendBrightnessCommand(int brightness) {
//         // Validate brightness range
//         int validBrightness;
//         if (brightness != -1) {
//             validBrightness = (brightness * 63) / 100;
//         } else {
//             validBrightness = (30 * 63) / 100;
//         }

//         Log.d(TAG, "=== SENDING BRIGHTNESS COMMAND TO GLASSES ===");
//         Log.d(TAG, "Brightness Value: " + brightness + " (validated: " + validBrightness + ")");

//         BrightnessConfig brightnessConfig = BrightnessConfig.newBuilder().setValue(brightness).build();

//         // Create the PhoneToGlasses using its builder and set the brightnessConfig
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setBrightness(brightnessConfig).build();

//         byte[] cmdBytes = generateProtobufCommandBytes(phoneToGlasses);

//         sendDataSequentially(cmdBytes, 10);

//         Log.d(TAG, "Sent auto light brightness command => Brightness: " + brightness);
//         EventBus.getDefault().post(new BrightnessLevelEvent(brightness));
//     }

//     public void sendAutoBrightnessCommand(boolean autoLight) {
//         Log.d(TAG, "=== SENDING AUTO BRIGHTNESS COMMAND TO GLASSES ===");
//         Log.d(TAG, "Auto Brightness Enabled: " + autoLight);
        
//         AutoBrightnessConfig autoBrightnessConfig = AutoBrightnessConfig.newBuilder().setEnabled(autoLight).build();
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setAutoBrightness(autoBrightnessConfig).build();

//         final byte[] cmdBytes = generateProtobufCommandBytes(phoneToGlasses);

//         sendDataSequentially(cmdBytes, 10);

//         Log.d(TAG, "Sent auto light sendAutoBrightnessCommand=> " + autoLight);

//         EventBus.getDefault().post(new BrightnessLevelEvent(autoLight));
//     }

//     public void sendHeadUpAngleCommand(int headUpAngle) {
//         // Validate headUpAngle range (0 ~ 60)
//         if (headUpAngle < 0) {
//             headUpAngle = 0;
//         } else if (headUpAngle > 60) {
//             headUpAngle = 60;
//         }
        
//         Log.d(TAG, "=== SENDING HEAD UP ANGLE COMMAND TO GLASSES ===");
//         Log.d(TAG, "Head Up Angle: " + headUpAngle + " degrees (validated range: 0-60)");
        
//         HeadUpAngleConfig headUpAngleConfig = HeadUpAngleConfig.newBuilder().setAngle(headUpAngle).build();
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setHeadUpAngle(headUpAngleConfig).build();

//         final byte[] cmdBytes = generateProtobufCommandBytes(phoneToGlasses);

//         sendDataSequentially(cmdBytes, 10);

//         Log.d(TAG, "Sent headUp angle command => Angle: " + headUpAngle);
//         EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));
//     }

//     private void sendDashboardPositionCommand(int height, int depth) {
//         // clamp height and depth to 0-8 and 1-9 respectively:
//         height = Math.max(0, Math.min(height, 8));
//         depth = Math.max(1, Math.min(depth, 9));

//         Log.d(TAG, "=== SENDING DASHBOARD POSITION COMMAND TO GLASSES ===");
//         Log.d(TAG, "Dashboard Position - Height: " + height + " (0-8), Depth: " + depth + " (1-9)");

//         DisplayHeightConfig displayHeightConfig = DisplayHeightConfig.newBuilder().setHeight(height)
//                 .build();
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setDisplayHeight(displayHeightConfig).build();

//         final byte[] cmdBytes = generateProtobufCommandBytes(phoneToGlasses);

//         sendDataSequentially(cmdBytes, 10);

//         Log.d(TAG, "Sent dashboard height/depth command => Height: " + height + ", Depth: " + depth);
//         // EventBus.getDefault().post(new DashboardPositionEvent(height, depth));
//     }

//     @Override
//     public void updateGlassesBrightness(int brightness) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "Updating glasses brightness: " + brightness);
//         sendBrightnessCommand(brightness);
//     }

//     @Override
//     public void updateGlassesAutoBrightness(boolean autoBrightness) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "Updating glasses auto brightness: " + autoBrightness);
//         // sendBrightnessCommand(-1, autoBrightness);
//         // sendAutoBrightnessCommand(autoBrightness);
//         // sendPeriodicTextWall();

//         // startSendingDisplayImageTest();
//         sendAutoBrightnessCommand(autoBrightness);
//     }

//     @Override
//     public void updateGlassesHeadUpAngle(int headUpAngle) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "updateGlassesHeadUpAngle headUpAngle: " + headUpAngle);

//         sendHeadUpAngleCommand(headUpAngle);
//     }

//     @Override
//     public void updateGlassesDepthHeight(int depth, int height) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "updateGlassesDepthHeight depth: " + depth + " height:" + height);

//         sendDashboardPositionCommand(height, depth);
//     }

//     @Override
//     public void sendExitCommand() {
//         Log.d(TAG, "sendExitCommand ");
//         sendDataSequentially(new byte[]{(byte) 0x18}, 100);
//     }

//     private String bytesToHex(byte[] bytes) {
//         StringBuilder sb = new StringBuilder();
//         for (byte b : bytes) {
//             sb.append(String.format("%02X ", b));
//         }
//         return sb.toString().trim();
//     }

//     // microphone stuff
//     public void setMicEnabled(boolean enable, int delay) {
//         Log.d(TAG, "setMicEnabled called with enable: " + enable + " and delay: " + delay);
//         Log.d(TAG, "Running set mic enabled: " + enable);
//         isMicrophoneEnabled = enable; // Update the state tracker
//         EventBus.getDefault().post(new isMicEnabledForFrontendEvent(enable));
//         micEnableHandler.postDelayed(new Runnable() {
//             @Override
//             public void run() {
//                 if (!isConnected()) {
//                     Log.d(TAG, "Tryna start mic: Not connected to glasses");
//                     return;
//                 }

//                 Log.d(TAG, "=== SENDING MICROPHONE STATE COMMAND TO GLASSES ===");
//                 Log.d(TAG, "Microphone Enabled: " + enable);

//                 MicStateConfig micStateConfig = MicStateConfig.newBuilder().setEnabled(enable).build();
//                 // micStateConfig.setEnabled(enable);

//                 // Create the PhoneToGlasses using its builder and set the DisplayText
//                 PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setMicState(micStateConfig).build();

//                 byte[] micConfigBytes = generateProtobufCommandBytes(phoneToGlasses);

//                 sendDataSequentially(micConfigBytes, 10); // wait some time to setup the mic
//                 Log.d(TAG, "Sent MIC command: " + bytesToHex(micConfigBytes));
//             }
//         }, delay);
//     }

//     // notifications
//     private void startPeriodicNotifications(int delay) {
//         if (notifysStarted) {
//             return;
//         }
//         notifysStarted = true;

//         notificationRunnable = new Runnable() {
//             @Override
//             public void run() {
//                 // Send notification
//                 sendPeriodicNotification();

//                 // Schedule the next notification
//                 notificationHandler.postDelayed(this, 12000);
//             }
//         };

//         // Start the first notification after 5 seconds
//         notificationHandler.postDelayed(notificationRunnable, delay);
//     }

//     private void sendPeriodicNotification() {
//         if (!isConnected()) {
//             Log.d(TAG, "Cannot send notification: Not connected to glasses");
//             return;
//         }

//         // Example notification data (replace with your actual data)
//         // String json = createNotificationJson("com.augment.os", "QuestionAnswerer",
//         // "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
//         String json = createNotificationJson("com.augment.os", "QuestionAnswerer",
//                 "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
//         Log.d(TAG, "the JSON to send: " + json);
//         List<byte[]> chunks = createNotificationChunks(json);
//         // Log.d(TAG, "THE CHUNKS:");
//         // Log.d(TAG, chunks.get(0).toString());
//         // Log.d(TAG, chunks.get(1).toString());
//         for (byte[] chunk : chunks) {
//             Log.d(TAG, "Sent chunk to glasses: " + bytesToUtf8(chunk));
//         }

//         // Send each chunk with a short sleep between each send
//         sendDataSequentially(chunks);

//         Log.d(TAG, "Sent periodic notification");
//     }

//     // text wall debug
//     private void startPeriodicTextWall(int delay) {
//         if (textWallsStarted) {
//             return;
//         }
//         textWallsStarted = true;

//         textWallRunnable = new Runnable() {
//             @Override
//             public void run() {
//                 // Send notification
//                 sendPeriodicTextWall();

//                 // Schedule the next notification
//                 textWallHandler.postDelayed(this, 12000);
//             }
//         };

//         // Start the first text wall send after 5 seconds
//         textWallHandler.postDelayed(textWallRunnable, delay);
//     }

//     // Constants for text wall display
//     private final int TEXT_COMMAND = 0x4E; // Text command
//     private final int DISPLAY_WIDTH = 488;
//     private final int DISPLAY_USE_WIDTH = 488; // How much of the display to use
//     private final float FONT_MULTIPLIER = 1 / 50.0f;
//     private final int OLD_FONT_SIZE = 21; // Font size
//     private final float FONT_DIVIDER = 2.0f;
//     private final int LINES_PER_SCREEN = 5; // Lines per screen
//     private final int MAX_CHUNK_SIZE_DEFAULT = 176; // Maximum chunk size for BLE packets
//     private int MAX_CHUNK_SIZE = MAX_CHUNK_SIZE_DEFAULT; // Maximum chunk size for BLE packets
//     private int BMP_CHUNK_SIZE = 194;

//     // private final int INDENT_SPACES = 32; // Number of spaces to indent
//     // text

//     private int textSeqNum = 0; // Sequence number for text packets

//     // currently only a single page - 1PAGE CHANGE
//     private List<byte[]> createTextWallChunks(String text) {
//         int margin = 5;

//         // Get width of single space character
//         int spaceWidth = calculateTextWidth(" ");

//         // Calculate effective display width after accounting for Main margins
//         // in spaces
//         int marginWidth = margin * spaceWidth; // Width of left margin in pixels
//         int effectiveWidth = DISPLAY_WIDTH - (2 * marginWidth); // Subtract left and right margins

//         // Split text into lines based on effective display width
//         List<String> lines = splitIntoLines(text, effectiveWidth);

//         // Calculate total pages
//         int totalPages = 1; // hard set to 1 since we only do 1 page - 1PAGECHANGE

//         List<byte[]> allChunks = new ArrayList<>();

//         // Process each page
//         for (int page = 0; page < totalPages; page++) {
//             // Get lines for current page
//             int startLine = page * LINES_PER_SCREEN;
//             int endLine = Math.min(startLine + LINES_PER_SCREEN, lines.size());
//             List<String> pageLines = lines.subList(startLine, endLine);

//             // Combine lines for this page with proper indentation
//             StringBuilder pageText = new StringBuilder();

//             for (String line : pageLines) {
//                 // Add the exact number of spaces for indentation
//                 String indentation = " ".repeat(margin);
//                 pageText.append(indentation).append(line).append("\n");
//             }

//             byte[] textBytes = pageText.toString().getBytes(StandardCharsets.UTF_8);
//             int totalChunks = (int) Math.ceil((double) textBytes.length / MAX_CHUNK_SIZE);

//             // Create chunks for this page
//             for (int i = 0; i < totalChunks; i++) {
//                 int start = i * MAX_CHUNK_SIZE;
//                 int end = Math.min(start + MAX_CHUNK_SIZE, textBytes.length);
//                 byte[] payloadChunk = Arrays.copyOfRange(textBytes, start, end);

//                 // Create header with protocol specifications
//                 byte screenStatus = 0x71; // New content (0x01) + Text Show (0x70)
//                 byte[] header = new byte[]{(byte) TEXT_COMMAND, // Command type
//                         (byte) textSeqNum, // Sequence number
//                         (byte) totalChunks, // Total packages
//                         (byte) i, // Current package number
//                         screenStatus, // Screen status
//                         (byte) 0x00, // new_char_pos0 (high)
//                         (byte) 0x00, // new_char_pos1 (low)
//                         (byte) page, // Current page number
//                         (byte) totalPages // Max page number
//                 };

//                 // Combine header and payload
//                 ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
//                 chunk.put(header);
//                 chunk.put(payloadChunk);

//                 allChunks.add(chunk.array());
//             }

//             // Increment sequence number for next page
//             textSeqNum = (textSeqNum + 1) % 256;
//             break; // hard set to 1 - 1PAGECHANGE
//         }

//         return allChunks;
//     }

//     // currently only a single page - 1PAGE CHANGE ,for Nex glasses
//     private byte[] createTextWallChunksForNex(String text) {
//         DisplayText textNewBuilder = DisplayText
//                 .newBuilder()
//                 .setColor(10000)
//                 .setText(text)
//                 .setSize(48)
//                 .setX(20)
//                 .setY(260)
//                 .build();

//         Log.d(TAG, "=== SENDING TEXT TO GLASSES ===");
//         Log.d(TAG, "Text: \"" + text + "\"");
//         Log.d(TAG, "Text Length: " + text.length() + " characters");
//         Log.d(TAG, "DisplayText Builder: " + textNewBuilder.toString());
        
//         // Create the PhoneToGlasses using its builder and set the DisplayText
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses
//                 .newBuilder()
//                 .setDisplayText(textNewBuilder)
//                 .build();

//         return generateProtobufCommandBytes(phoneToGlasses);
//     }

//     private byte[] createTextWallChunksForNex(DisplayTextEvent displayTextEvent) {
//         DisplayText textNewBuilder = DisplayText
//                 .newBuilder()
//                 .setColor(10000)
//                 .setText(displayTextEvent.text)
//                 .setSize(displayTextEvent.size)
//                 .setX(displayTextEvent.x)
//                 .setY(displayTextEvent.y).build();

//         Log.d(TAG, "createTextWallChunksForNex textNewBuilder:" + textNewBuilder.toString());
//         // Create the PhoneToGlasses using its builder and set the DisplayText
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses
//                 .newBuilder()
//                 .setDisplayText(textNewBuilder)
//                 .build();

//         return generateProtobufCommandBytes(phoneToGlasses);
//     }

//     // TextWallChunks for text
//     private byte[] createTextWallChunksForNexForJson(String text) {

//         DisplayTextJson displayText = new DisplayTextJson();
//         displayText.setText(text);
//         displayText.setSize(20);
//         final String jsonData = gson.toJson(displayText);

//         Log.d(TAG, "createTextWallChunksForNext json " + jsonData);

//         byte[] contentBytes = jsonData.getBytes(StandardCharsets.UTF_8);

//         ByteBuffer chunk = ByteBuffer.allocate(contentBytes.length + 1);
//         // Create the PhoneToGlasses using its builder and set the DisplayText

//         chunk.put(PACKET_TYPE_JSON);
//         chunk.put(contentBytes);

//         byte[] result = new byte[chunk.position()];
//         chunk.flip();
//         chunk.get(result);
//         return result;
//     }

//     // create a VerticalScrollingfor Nex glasses
//     private byte[] createVerticalScrollingTextWallChunksForNex(String text) {

//         DisplayScrollingText textNewBuilder = DisplayScrollingText.newBuilder().setText(text).setSize(48)
//                 .setHeight(100).setWidth(200).setAlign(DisplayScrollingText.Alignment.CENTER).setLineSpacing(2)
//                 .setLoop(true).setPauseMs(10).setSpeed(50).setX(20).setY(50).build();

//         Log.d(TAG, "=== SENDING SCROLLING TEXT TO GLASSES ===");
//         Log.d(TAG, "Scrolling Text: \"" + text + "\"");
//         Log.d(TAG, "Text Length: " + text.length() + " characters");
//         Log.d(TAG, "DisplayScrollingText Builder: " + textNewBuilder.toString());

//         // Create the PhoneToGlasses using its builder and set the DisplayScrollingText
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder().setDisplayScrollingText(textNewBuilder).build();

//         return generateProtobufCommandBytes(phoneToGlasses);
//     }

//     private byte[] createStartSendingImageChunksCommand(String streamId, int totalChunks, int width, int height) {
//         Log.d(TAG, "=== SENDING IMAGE DISPLAY COMMAND TO GLASSES ===");
//         Log.d(TAG, "Image Stream ID: " + streamId);
//         Log.d(TAG, "Total Chunks: " + totalChunks);
//         Log.d(TAG, "Image Position: X=" + 0 + ", Y=" + 0);
//         Log.d(TAG, "Image Dimensions: " + width + "x" + height);
//         Log.d(TAG, "Image Encoding: raw");
        
//         DisplayImage displayImage = DisplayImage.newBuilder()
//                 .setStreamId(streamId)
//                 .setTotalChunks(totalChunks)
//                 .setX(0)
//                 .setY(0)
//                 .setWidth(width)
//                 .setHeight(height)
//                 .setEncoding("raw")
//                 .build();

//         // Create the PhoneToGlasses using its builder and set the DisplayImage with msg_id
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//                 .setMsgId("img_start_1")
//                 .setDisplayImage(displayImage)
//                 .build();

//         return generateProtobufCommandBytes(phoneToGlasses);
//     }

//     private int calculateTextWidth(String text) {
//         int width = 0;
//         for (char c : text.toCharArray()) {
//             G1FontLoader.FontGlyph glyph = fontLoader.getGlyph(c);
//             width += glyph.width + 1; // Add 1 pixel per character for spacing
//         }
//         return width * 2;
//     }

//     private List<byte[]> createDoubleTextWallChunks(String text1, String text2) {
//         // Define column widths and positions
//         final int LEFT_COLUMN_WIDTH = (int) (DISPLAY_WIDTH * 0.5); // 40% of display for left column
//         final int RIGHT_COLUMN_START = (int) (DISPLAY_WIDTH * 0.55); // Right column starts at 60%

//         // Split texts into lines with specific width constraints
//         List<String> lines1 = splitIntoLines(text1, LEFT_COLUMN_WIDTH);
//         List<String> lines2 = splitIntoLines(text2, DISPLAY_WIDTH - RIGHT_COLUMN_START);

//         // Ensure we have exactly LINES_PER_SCREEN lines (typically 5)
//         while (lines1.size() < LINES_PER_SCREEN) {
//             lines1.add("");
//         }
//         while (lines2.size() < LINES_PER_SCREEN) {
//             lines2.add("");
//         }

//         lines1 = lines1.subList(0, LINES_PER_SCREEN);
//         lines2 = lines2.subList(0, LINES_PER_SCREEN);

//         // Get precise space width
//         int spaceWidth = calculateTextWidth(" ");

//         // Construct the text output by merging the lines with precise positioning
//         StringBuilder pageText = new StringBuilder();
//         for (int i = 0; i < LINES_PER_SCREEN; i++) {
//             String leftText = lines1.get(i).replace("\u2002", ""); // Drop enspaces
//             String rightText = lines2.get(i).replace("\u2002", "");

//             // Calculate width of left text in pixels
//             int leftTextWidth = calculateTextWidth(leftText);

//             // Calculate exactly how many spaces are needed to position the right column
//             // correctly
//             int spacesNeeded = calculateSpacesForAlignment(leftTextWidth, RIGHT_COLUMN_START, spaceWidth);

//             // Log detailed alignment info for debugging
//             Log.d(TAG, String.format("Line %d: Left='%s' (width=%dpx) | Spaces=%d | Right='%s'", i, leftText,
//                     leftTextWidth, spacesNeeded, rightText));

//             // Construct the full line with precise alignment
//             pageText.append(leftText).append(" ".repeat(spacesNeeded)).append(rightText).append("\n");
//         }

//         // Convert to bytes and chunk for transmission
//         return chunkTextForTransmission(pageText.toString());
//     }

//     private int calculateSpacesForAlignment(int currentWidth, int targetPosition, int spaceWidth) {
//         // Calculate space needed in pixels
//         int pixelsNeeded = targetPosition - currentWidth;

//         // Calculate spaces needed (with minimum of 1 space for separation)
//         if (pixelsNeeded <= 0) {
//             return 1; // Ensure at least one space between columns
//         }

//         // Calculate the exact number of spaces needed
//         int spaces = (int) Math.ceil((double) pixelsNeeded / spaceWidth);

//         // Cap at a reasonable maximum
//         return Math.min(spaces, 100);
//     }

//     private List<byte[]> chunkTextForTransmission(String text) {
//         byte[] textBytes = text.getBytes(StandardCharsets.UTF_8);
//         int totalChunks = (int) Math.ceil((double) textBytes.length / MAX_CHUNK_SIZE);

//         List<byte[]> allChunks = new ArrayList<>();
//         for (int i = 0; i < totalChunks; i++) {
//             int start = i * MAX_CHUNK_SIZE;
//             int end = Math.min(start + MAX_CHUNK_SIZE, textBytes.length);
//             byte[] payloadChunk = Arrays.copyOfRange(textBytes, start, end);

//             // Create header with protocol specifications
//             byte screenStatus = 0x71; // New content (0x01) + Text Show (0x70)
//             byte[] header = new byte[]{(byte) TEXT_COMMAND, // Command type
//                     (byte) textSeqNum, // Sequence number
//                     (byte) totalChunks, // Total packages
//                     (byte) i, // Current package number
//                     screenStatus, // Screen status
//                     (byte) 0x00, // new_char_pos0 (high)
//                     (byte) 0x00, // new_char_pos1 (low)
//                     (byte) 0x00, // Current page number (always 0 for now)
//                     (byte) 0x01 // Max page number (always 1)
//             };

//             // Combine header and payload
//             ByteBuffer chunk = ByteBuffer.allocate(header.length + payloadChunk.length);
//             chunk.put(header);
//             chunk.put(payloadChunk);

//             allChunks.add(chunk.array());
//         }

//         // Increment sequence number for next page
//         textSeqNum = (textSeqNum + 1) % 256;

//         return allChunks;
//     }

//     private int calculateSubstringWidth(String text, int start, int end) {
//         return calculateTextWidth(text.substring(start, end));
//     }

//     private List<String> splitIntoLines(String text, int maxDisplayWidth) {
//         // Replace specific symbols
//         text = text.replace("⬆", "^").replace("⟶", "-");

//         List<String> lines = new ArrayList<>();

//         // Handle empty or single space case
//         if (text.isEmpty() || " ".equals(text)) {
//             lines.add(text);
//             return lines;
//         }

//         // Split by newlines first
//         String[] rawLines = text.split("\n");

//         Log.d(TAG, "Splitting text into lines..." + Arrays.toString(rawLines));

//         for (String rawLine : rawLines) {
//             // Add empty lines for newlines
//             if (rawLine.isEmpty()) {
//                 lines.add("");
//                 continue;
//             }

//             int lineLength = rawLine.length();
//             int startIndex = 0;

//             while (startIndex < lineLength) {
//                 // Get maximum possible end index
//                 int endIndex = lineLength;

//                 // Calculate width of the entire remaining text
//                 int lineWidth = calculateSubstringWidth(rawLine, startIndex, endIndex);

//                 Log.d(TAG, "Line length: " + rawLine);
//                 Log.d(TAG, "Calculating line width: " + lineWidth);

//                 // If entire line fits, add it and move to next line
//                 if (lineWidth <= maxDisplayWidth) {
//                     lines.add(rawLine.substring(startIndex));
//                     break;
//                 }

//                 // Binary search to find the maximum number of characters that fit
//                 int left = startIndex + 1;
//                 int right = lineLength;
//                 int bestSplitIndex = startIndex + 1;

//                 while (left <= right) {
//                     int mid = left + (right - left) / 2;
//                     int width = calculateSubstringWidth(rawLine, startIndex, mid);

//                     if (width <= maxDisplayWidth) {
//                         bestSplitIndex = mid;
//                         left = mid + 1;
//                     } else {
//                         right = mid - 1;
//                     }
//                 }

//                 // Now find a good place to break (preferably at a space)
//                 int splitIndex = bestSplitIndex;

//                 // Look for a space to break at
//                 boolean foundSpace = false;
//                 for (int i = bestSplitIndex; i > startIndex; i--) {
//                     if (rawLine.charAt(i - 1) == ' ') {
//                         splitIndex = i;
//                         foundSpace = true;
//                         break;
//                     }
//                 }

//                 // If we couldn't find a space in a reasonable range, use the calculated split
//                 // point
//                 if (!foundSpace && bestSplitIndex - startIndex > 2) {
//                     splitIndex = bestSplitIndex;
//                 }

//                 // Add the line
//                 String line = rawLine.substring(startIndex, splitIndex).trim();
//                 lines.add(line);

//                 // Skip any spaces at the beginning of the next line
//                 while (splitIndex < lineLength && rawLine.charAt(splitIndex) == ' ') {
//                     splitIndex++;
//                 }

//                 startIndex = splitIndex;
//             }
//         }

//         return lines;
//     }

//     private void sendPeriodicTextWall() {
//         if (!isConnected()) {
//             Log.d(TAG, "Cannot send text wall: Not connected to glasses");
//             return;
//         }

//         Log.d(TAG, "^^^^^^^^^^^^^ SENDING DEBUG TEXT WALL");

//         // Example text wall content - replace with your actual text content
//         String sampleText = "This is an example of a text wall that will be displayed on the glasses. "
//                 + "It demonstrates how text can be split into multiple pages and displayed sequentially. ";
// //                + "Each page contains multiple lines, and each line is carefully formatted to fit the display width. "
// //                + "The text continues across multiple pages, showing how longer content can be handled effectively.";
//         final boolean isForG1Glasses = false;
//         // for g1
//         if (isForG1Glasses) {
//             List<byte[]> chunks = createTextWallChunks(sampleText);
//             // for NEXglasses
//             // Send each chunk with a delay between sends
//             for (byte[] chunk : chunks) {
//                 sendDataSequentially(chunk);

//                 // try {
//                 // Thread.sleep(150); // 150ms delay between chunks
//                 // } catch (InterruptedException e) {
//                 // e.printStackTrace();
//                 // }
//             }

//             // Log.d(TAG, "Sent text wall");
//         } else {
//             final boolean isDisplayVerticalScrollingText = false;
//             if (isDisplayVerticalScrollingText) {
//                 Log.d(TAG, "Sent scrolling text wall " + sampleText + " to NexGlasses ");

//                 byte[] singleChunks = createVerticalScrollingTextWallChunksForNex(sampleText);
//                 sendDataSequentially(singleChunks);
//             } else {
//                 // sampleText = "Hello world " + random.nextInt();
//                 sampleText = sampleText + " " + random.nextInt();
//                 Log.d(TAG, "Sent text wall " + sampleText + " to NexGlasses ");

//                 byte[] singleChunks = createTextWallChunksForNex(sampleText);
//                 // byte[] singleChunks = createTextWallChunksForNexForJson(sampleText);
//                 sendDataSequentially(singleChunks);
//             }
//         }
//     }

//     private String bytesToUtf8(byte[] bytes) {
//         return new String(bytes, StandardCharsets.UTF_8);
//     }

//     private void stopPeriodicNotifications() {
//         if (notificationHandler != null && notificationRunnable != null) {
//             notificationHandler.removeCallbacks(notificationRunnable);
//             Log.d(TAG, "Stopped periodic notifications");
//         }
//     }

//     // handle white list stuff
//     private final int WHITELIST_CMD = 0x04; // Command ID for whitelist

//     public List<byte[]> getWhitelistChunks() {
//         // Define the hardcoded whitelist JSON
//         List<AppInfo> apps = new ArrayList<>();
//         apps.add(new AppInfo("com.augment.os", "AugmentOS"));
//         String whitelistJson = createWhitelistJson(apps);

//         Log.d(TAG, "Creating chunks for hardcoded whitelist: " + whitelistJson);

//         // Convert JSON to bytes and split into chunks
//         return createWhitelistChunks(whitelistJson);
//     }

//     private String createWhitelistJson(List<AppInfo> apps) {
//         JSONArray appList = new JSONArray();
//         try {
//             // Add each app to the list
//             for (AppInfo app : apps) {
//                 JSONObject appJson = new JSONObject();
//                 appJson.put("id", app.getId());
//                 appJson.put("name", app.getName());
//                 appList.put(appJson);
//             }

//             JSONObject whitelistJson = new JSONObject();
//             whitelistJson.put("calendar_enable", false);
//             whitelistJson.put("call_enable", false);
//             whitelistJson.put("msg_enable", false);
//             whitelistJson.put("ios_mail_enable", false);

//             JSONObject appObject = new JSONObject();
//             appObject.put("list", appList);
//             appObject.put("enable", true);

//             whitelistJson.put("app", appObject);

//             return whitelistJson.toString();
//         } catch (JSONException e) {
//             Log.e(TAG, "Error creating whitelist JSON: " + e.getMessage());
//             return "{}";
//         }
//     }

//     // Simple class to hold app info
//     class AppInfo {
//         private String id;
//         private String name;

//         public AppInfo(String id, String name) {
//             this.id = id;
//             this.name = name;
//         }

//         public String getId() {
//             return id;
//         }

//         public String getName() {
//             return name;
//         }
//     }

//     // Helper function to split JSON into chunks
//     private List<byte[]> createWhitelistChunks(String json) {
//         // final int MAX_CHUNK_SIZE = 180 - 4; // Reserve space for the header
//         byte[] jsonBytes = json.getBytes(StandardCharsets.UTF_8);
//         int totalChunks = (int) Math.ceil((double) jsonBytes.length / MAX_CHUNK_SIZE);

//         List<byte[]> chunks = new ArrayList<>();
//         for (int i = 0; i < totalChunks; i++) {
//             int start = i * MAX_CHUNK_SIZE;
//             int end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.length);
//             byte[] payloadChunk = Arrays.copyOfRange(jsonBytes, start, end);

//             // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
//             byte[] header = new byte[]{(byte) WHITELIST_CMD, // Command ID
//                     (byte) totalChunks, // Total number of chunks
//                     (byte) i // Current chunk index
//             };

//             // Combine header and payload
//             ByteBuffer buffer = ByteBuffer.allocate(header.length + payloadChunk.length);
//             buffer.put(header);
//             buffer.put(payloadChunk);

//             chunks.add(buffer.array());
//         }

//         return chunks;
//     }

//     @Override
//     public void onDisplayTextNotified(DisplayTextEvent displayTextEvent) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         byte[] textChunks = createTextWallChunksForNex(displayTextEvent);
//         sendDataSequentially(textChunks);
//     }

//     @Override
//     public void onDisplayImageNotified(String imageType, String imageSize) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         startSendingDisplayImageTest(imageType, imageSize);
//     }

//     @Override
//     public void displayCustomContent(String content) {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "displayCustomContent content: " + content);
//     }

//     @Override
//     public void clearDisplay() {
//         if (!isConnected()) {
//             Log.d(TAG, "Not connected to glasses");
//             return;
//         }
//         Log.d(TAG, "=== SENDING CLEAR DISPLAY COMMAND TO GLASSES ===");
        
//         // Create the clear display protobuf message
//         mentraos.ble.MentraosBle.ClearDisplay clearDisplay = mentraos.ble.MentraosBle.ClearDisplay.newBuilder()
//                 .build();

//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//                 .setMsgId("clear_disp_001")
//                 .setClearDisplay(clearDisplay)
//                 .build();

//         byte[] cmdBytes = generateProtobufCommandBytes(phoneToGlasses);
//         sendDataSequentially(cmdBytes, 10);

//         Log.d(TAG, "Sent clear display command");
//         lastThingDisplayedWasAnImage = false;
//     }

//     private void sendChunks(List<byte[]> chunks) {
//         // Send each chunk with a delay between sends
//         for (byte[] chunk : chunks) {
//             sendDataSequentially(chunk);

//             // try {
//             // Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND); // delay between chunks
//             // } catch (InterruptedException e) {
//             // e.printStackTrace();
//             // }
//         }
//     }

//     // Add these class variables
//     private final byte[] GLASSES_ADDRESS = new byte[]{0x00, 0x1c, 0x00, 0x00};
//     private final byte[] END_COMMAND = new byte[]{0x20, 0x0d, 0x0e};

//     // for g1 glasses
//     public void displayBitmapImage(byte[] bmpData) {
//         Log.d(TAG, "Starting BMP display process");

//         try {
//             if (bmpData == null || bmpData.length == 0) {
//                 Log.e(TAG, "Invalid BMP data provided");
//                 return;
//             }
//             Log.d(TAG, "Processing BMP data, size: " + bmpData.length + " bytes");

//             // Split into chunks and send
//             List<byte[]> chunks = createBmpChunks(bmpData);
//             Log.d(TAG, "Created " + chunks.size() + " chunks");

//             // Send all chunks
//             sendBmpChunks(chunks);

//             // Send end command
//             sendBmpEndCommand();

//             // Calculate and send CRC
//             sendBmpCRC(bmpData);

//             lastThingDisplayedWasAnImage = true;

//         } catch (Exception e) {
//             Log.e(TAG, "Error in displayBitmapImage: " + e.getMessage());
//         }
//     }

//     // for NexGlasses
//     public void displayBitmapImageForNexGlasses(byte[] bmpData, int width, int height) {
//         Log.d(TAG, "Starting BMP display process for " + width + "x" + height + " image");

//         try {
//             if (bmpData == null || bmpData.length == 0) {
//                 Log.e(TAG, "Invalid BMP data provided");
//                 return;
//             }

//             Log.d(TAG, "Processing BMP data, size: " + bmpData.length + " bytes");

//             // Generate proper 2-byte hex stream ID (e.g., "002A") as per protobuf specification
//             final int totalChunks = (int) Math.ceil((double) bmpData.length / BMP_CHUNK_SIZE);
//             final String streamId = String.format("%04X", random.nextInt(0x10000)); // Fixed: 4-digit hex format
//             byte[] startImageSendingBytes = createStartSendingImageChunksCommand(streamId, totalChunks, width, height);
//             sendDataSequentially(startImageSendingBytes);

//             // Send all chunks with proper stream ID parsing
//             List<byte[]> chunks = createBmpChunksForNexGlasses(streamId, bmpData, totalChunks);

//             // sendBmpChunks(chunks);
//             currentImageChunks = chunks;
//             sendDataSequentially(chunks);

//             // Send end command
//             // sendBmpEndCommand();

//             // Calculate and send CRC
//             // sendBmpCRC(bmpData);

//             // lastThingDisplayedWasAnImage = true;

//         } catch (Exception e) {
//             Log.e(TAG, "Error in displayBitmapImage: " + e.getMessage());
//         }
//     }

//     // re send the image chunks that are missing
//     private void reSendImageMissingChunks(List<Integer> missingChunksIndexList) {
//         if (!isImageSendProgressing) {
//             return;
//         }
//         if (currentImageChunks.isEmpty()) {
//             return;
//         }
//         if (missingChunksIndexList.isEmpty()) {
//             return;
//         }
//         List<byte[]> missingChunks = new ArrayList<>();
//         for (int i = 0; i < missingChunksIndexList.size(); i++) {
//             missingChunks.add(currentImageChunks.get(i));
//         }

//         sendDataSequentially(missingChunks);
//     }

//     // for g1
//     private List<byte[]> createBmpChunks(byte[] bmpData) {
//         List<byte[]> chunks = new ArrayList<>();
//         int totalChunks = (int) Math.ceil((double) bmpData.length / BMP_CHUNK_SIZE);
//         Log.d(TAG, "Creating " + totalChunks + " chunks from " + bmpData.length + " bytes");

//         for (int i = 0; i < totalChunks; i++) {
//             int start = i * BMP_CHUNK_SIZE;
//             int end = Math.min(start + BMP_CHUNK_SIZE, bmpData.length);
//             byte[] chunk = Arrays.copyOfRange(bmpData, start, end);

//             // First chunk needs address bytes
//             if (i == 0) {
//                 byte[] headerWithAddress = new byte[2 + GLASSES_ADDRESS.length + chunk.length];
//                 headerWithAddress[0] = 0x15; // Command
//                 headerWithAddress[1] = (byte) (i & 0xFF); // Sequence
//                 System.arraycopy(GLASSES_ADDRESS, 0, headerWithAddress, 2, GLASSES_ADDRESS.length);
//                 System.arraycopy(chunk, 0, headerWithAddress, 6, chunk.length);
//                 chunks.add(headerWithAddress);
//             } else {
//                 byte[] header = new byte[2 + chunk.length];
//                 header[0] = 0x15; // Command
//                 header[1] = (byte) (i & 0xFF); // Sequence
//                 System.arraycopy(chunk, 0, header, 2, chunk.length);
//                 chunks.add(header);
//             }
//         }
//         return chunks;
//     }

//     // for NexGlasses
//     private List<byte[]> createBmpChunksForNexGlasses(String streamId, byte[] bmpData, int totalChunks) {
//         List<byte[]> chunks = new ArrayList<>();
//         Log.d(TAG, "Creating " + totalChunks + " chunks from " + bmpData.length + " bytes");
        
//         // Parse hex stream ID to bytes (e.g., "002A" -> 0x00, 0x2A)
//         int streamIdInt = Integer.parseInt(streamId, 16);
        
//         for (int i = 0; i < totalChunks; i++) {
//             int start = i * BMP_CHUNK_SIZE;
//             int end = Math.min(start + BMP_CHUNK_SIZE, bmpData.length);
//             byte[] chunk = Arrays.copyOfRange(bmpData, start, end);
            
//             byte[] header = new byte[4 + chunk.length];
//             header[0] = PACKET_TYPE_IMAGE; // 0xB0
//             header[1] = (byte) ((streamIdInt >> 8) & 0xFF); // Stream ID high byte
//             header[2] = (byte) (streamIdInt & 0xFF); // Stream ID low byte  
//             header[3] = (byte) (i & 0xFF); // Chunk index
//             System.arraycopy(chunk, 0, header, 4, chunk.length);
//             chunks.add(header);
//         }
//         return chunks;
//     }

//     private void sendBmpChunks(List<byte[]> chunks) {
//         if (updatingScreen)
//             return;
//         for (int i = 0; i < chunks.size(); i++) {
//             byte[] chunk = chunks.get(i);
//             Log.d(TAG, "Sending chunk " + i + " of " + chunks.size() + ", size: " + chunk.length);
//             sendDataSequentially(chunk);

//             // try {
//             // Thread.sleep(25); // Small delay between chunks
//             // } catch (InterruptedException e) {
//             // Log.e(TAG, "Sleep interrupted: " + e.getMessage());
//             // }
//         }
//     }

//     private void sendBmpEndCommand() {
//         if (updatingScreen) {
//             return;
//         }
//         Log.d(TAG, "Sending BMP end command");
//         sendDataSequentially(END_COMMAND);

//         // try {
//         // Thread.sleep(100); // Give it time to process
//         // } catch (InterruptedException e) {
//         // Log.e(TAG, "Sleep interrupted: " + e.getMessage());
//         // }
//     }

//     private void sendBmpCRC(byte[] bmpData) {
//         // Create data with address for CRC calculation
//         byte[] dataWithAddress = new byte[GLASSES_ADDRESS.length + bmpData.length];
//         System.arraycopy(GLASSES_ADDRESS, 0, dataWithAddress, 0, GLASSES_ADDRESS.length);
//         System.arraycopy(bmpData, 0, dataWithAddress, GLASSES_ADDRESS.length, bmpData.length);

//         // Calculate CRC32
//         CRC32 crc = new CRC32();
//         crc.update(dataWithAddress);
//         long crcValue = crc.getValue();

//         // Create CRC command packet
//         byte[] crcCommand = new byte[5];
//         crcCommand[0] = 0x16; // CRC command
//         crcCommand[1] = (byte) ((crcValue >> 24) & 0xFF);
//         crcCommand[2] = (byte) ((crcValue >> 16) & 0xFF);
//         crcCommand[3] = (byte) ((crcValue >> 8) & 0xFF);
//         crcCommand[4] = (byte) (crcValue & 0xFF);

//         Log.d(TAG, "Sending CRC command, CRC value: " + Long.toHexString(crcValue));
//         sendDataSequentially(crcCommand);
//     }

//     private byte[] loadEmptyBmpFromAssets() {
//         try {
//             // test_bmp.bmp
//             // empty_bmp.bmp all black
//             try (InputStream is = context.getAssets().open("test_bmp.bmp")) {
//                 return is.readAllBytes();
//             }
//         } catch (IOException e) {
//             Log.e(TAG, "Failed to load BMP from assets: " + e.getMessage());
//             return null;
//         }
//     }

//     public void clearBmpDisplay() {
//         if (updatingScreen) {
//             return;
//         }
//         Log.d(TAG, "Clearing BMP display with EXIT command");
//         byte[] exitCommand = new byte[]{0x18};
//         sendDataSequentially(exitCommand);
//     }

//     private void sendLoremIpsum() {
//         if (updatingScreen) {
//             return;
//         }
//         String text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ";
//         sendDataSequentially(createTextWallChunks(text));
//     }

//     private void quickRestartNexGlasses() {
//         Log.d(TAG, "Sending restart 0x23 0x72 Command");
//         sendDataSequentially(new byte[]{(byte) 0x23, (byte) 0x72}); // quick restart comand
//     }

//     @Override
//     public void changeSmartGlassesMicrophoneState(boolean isMicrophoneEnabled) {
//         Log.d(TAG, "Microphone state changed: " + isMicrophoneEnabled);

//         // Update the shouldUseGlassesMic flag to reflect the current state
//         this.shouldUseGlassesMic = isMicrophoneEnabled && SmartGlassesManager.getSensingEnabled(context);// &&
//         // !SmartGlassesManager.getForceCoreOnboardMic(context);
//         Log.d(TAG, "Updated shouldUseGlassesMic to: " + shouldUseGlassesMic);

//         if (isMicrophoneEnabled) {
//             Log.d(TAG, "Microphone enabled, starting audio input handling");
//             startMicBeat((int) MICBEAT_INTERVAL_MS);
//         } else {
//             Log.d(TAG, "Microphone disabled, stopping audio input handling");
//             stopMicBeat();
//         }
//     }

//     /**
//      * Returns whether the microphone is currently enabled
//      *
//      * @return true if microphone is enabled, false otherwise
//      */
//     public boolean isMicrophoneEnabled() {
//         return isMicrophoneEnabled;
//     }

//     private void onCharacteristicChangedHandler(BluetoothGattCharacteristic characteristic) {
//         if (characteristic.getUuid().equals(NOTIFY_CHAR_UUID)) {
//             byte[] data = characteristic.getValue();
//             String deviceName = mainGlassGatt.getDevice().getName();
//             if (deviceName == null) {
//                 return;
//             }
//             final String packetHex = bytesToHex(data);
//             Log.d(TAG, "onCharacteristicChangedHandler len: " + data.length);
//             Log.d(TAG, "onCharacteristicChangedHandler: " + packetHex);
//             final int dataLen = data.length;
//             if (dataLen == 0) {
//                 return;
//             }
//             byte packetType = data[0];
//             Log.d(TAG, "onCharacteristicChangedHandler packetType: " + String.format("%02X ", packetType));
//             switch (packetType) {
//                 case PACKET_TYPE_JSON: {
//                     byte[] jsonData = Arrays.copyOfRange(data, 1, dataLen);
//                     decodeJsons(jsonData);
//                 }
//                 break;
//                 case PACKET_TYPE_PROTOBUF: {
//                     byte[] protobufData = Arrays.copyOfRange(data, 1, dataLen);
//                     decodeProtobufs(protobufData, packetHex);
//                 }
//                 break;
//                 case PACKET_TYPE_AUDIO: {
//                     // Check for audio packet header
//                     if (data[0] == (byte) 0xA0) {
//                         byte sequenceNumber = data[1];
//                         long receiveTime = System.currentTimeMillis();
                        
//                         // Basic sequence validation
//                         if (lastReceivedLc3Sequence != -1 && (byte)(lastReceivedLc3Sequence + 1) != sequenceNumber) {
//                             Log.w(TAG, "LC3 packet sequence mismatch. Expected: " + (lastReceivedLc3Sequence + 1) + ", Got: " + sequenceNumber);
//                         }
//                         lastReceivedLc3Sequence = sequenceNumber;

//                         final byte[] lc3Data = Arrays.copyOfRange(data, 2, dataLen);
                        
//                         Log.d(TAG, "Received LC3 audio packet seq=" + sequenceNumber + ", size=" + lc3Data.length);

//                         // Play LC3 audio directly through LC3 player
//                         if (lc3AudioPlayer != null && isLc3AudioEnabled) {
//                             // Use the original packet format that LC3 player expects
//                             // The original 'data' packet already has the right structure
//                             lc3AudioPlayer.write(data, 0, dataLen);
//                             Log.d(TAG, "Playing LC3 audio directly through LC3 player: " + dataLen + " bytes");
//                         } else if (!isLc3AudioEnabled) {
//                             Log.d(TAG, "LC3 audio disabled - skipping LC3 audio output");
//                         } else {
//                             Log.d(TAG, "LC3 player not available - skipping LC3 audio output");
//                         }

//                         // Still decode for callback compatibility
//                         if (lc3DecoderPtr != 0) {
//                             final byte[] pcmData = L3cCpp.decodeLC3(lc3DecoderPtr, lc3Data);
//                             Log.d(TAG, "pcmData size:" + pcmData.length);
//                             if (audioProcessingCallback != null) {
//                                 if (pcmData != null && pcmData.length > 0) {
//                                     // Log.d(TAG, "set onAudioDataAvailable pcmData");
//                                     audioProcessingCallback.onAudioDataAvailable(pcmData);
//                                 }
//                             } else {
//                                 // If we get here, it means the callback wasn't properly registered
//                                 Log.e(TAG, "Audio processing callback is null - callback registration failed!");
//                             }
//                         }
//                     }
//                 }
//                 break;
//                 case PACKET_TYPE_IMAGE:
//                     break;
//                 default:
//                     Log.d(TAG, "unknown packetType: " + String.format("%02X ", packetType));
//                     break;
//             }
//         }
//     }

//     private void decodeJsons(byte[] jsonBytes) {
//         final String jsoString = new String(jsonBytes, Charset.defaultCharset());
//         try {
//             JSONObject commandObject = new JSONObject(jsoString);
//             String type = commandObject.getString("type");
//             switch (type) {
//                 case "image_transfer_complete":
//                     break;
//                 case "disconnect":
//                     break;
//                 case "request_battery_state":
//                     break;
//                 case "charging_state":
//                     break;
//                 case "device_info":
//                     // final DeviceInfo deviceInfo = gson.fromJson(jsoString, DeviceInfo.class);
//                     break;
//                 case "enter_pairing_mode":
//                     break;
//                 case "request_head_position":
//                     break;
//                 case "set_head_up_angle":
//                     break;
//                 case "ping":
//                     break;
//                 case "vad_event":
//                     break;
//                 case "imu_data":
//                     break;
//                 case "button_event":
//                     break;
//                 case "head_gesture":
//                     break;
//                 default:
//                     break;
//             }
//         } catch (Exception e) {
//         }
//     }

//     private void decodeProtobufsByWrite(byte[] protobufBytes, String packetHex) {
//         try {
//             final PhoneToGlasses phoneToGlasses = PhoneToGlasses.parseFrom(protobufBytes);
//             Log.d(TAG, "decodeProtobufsByWrite phoneToGlasses: " + phoneToGlasses.toString());
//             Log.d(TAG, "decodeProtobufsByWrite phoneToGlasses payloadCase: " + phoneToGlasses.getPayloadCase());
//             final String payloadCase = phoneToGlasses.getPayloadCase().toString();

//             if (isDebugMode) {
//                 EventBus.getDefault()
//                         .post(new BleCommandSender(payloadCase, packetHex));
//             }
//         } catch (Exception e) {
//         }
//     }

//     // decodeProtobufs from binary bytes
//     private void decodeProtobufs(byte[] protobufBytes, String packetHex) {
//         try {
//             final GlassesToPhone glassesToPhone = GlassesToPhone.parseFrom(protobufBytes);
//             final String payloadCase = glassesToPhone.getPayloadCase().toString();
//             Log.d(TAG, "decodeProtobufs glassesToPhone: " + glassesToPhone.toString());
//             Log.d(TAG, "decodeProtobufs glassesToPhone payloadCase: " + payloadCase);
//             if (isDebugMode) {
//                 EventBus.getDefault()
//                         .post(new BleCommandReceiver(payloadCase, packetHex));
//             }
//             switch (glassesToPhone.getPayloadCase()) {
//                 case BATTERY_STATUS: {
//                     final BatteryStatus batteryStatus = glassesToPhone.getBatteryStatus();
//                     batteryMain = batteryStatus.getLevel();
//                     EventBus.getDefault()
//                             .post(new BatteryLevelEvent(batteryStatus.getLevel(), batteryStatus.getCharging()));
//                     // EventBus.getDefault().post(new CaseEvent(caseBatteryLevel, caseCharging,
//                     // caseOpen, caseRemoved));
//                     Log.d(TAG, "batteryStatus: " + batteryStatus.toString());
//                 }
//                 break;
//                 case CHARGING_STATE: {
//                     final ChargingState chargingState = glassesToPhone.getChargingState();

//                     EventBus.getDefault()
//                             .post(new BatteryLevelEvent(batteryMain, chargingState.getState() == State.CHARGING));
//                     Log.d(TAG, "chargingState: " + chargingState.toString());

//                 }
//                 break;
//                 case DEVICE_INFO: {
//                     final DeviceInfo deviceInfo = glassesToPhone.getDeviceInfo();
//                     Log.d(TAG, "deviceInfo: " + deviceInfo.toString());
//                 }
//                 break;
//                 case HEAD_POSITION: {
//                     final HeadPosition headPosition = glassesToPhone.getHeadPosition();
//                     EventBus.getDefault().post(new HeadUpAngleEvent(headPosition.getAngle()));
//                     Log.d(TAG, "headPosition: " + headPosition.toString());
//                 }
//                 break;
//                 case HEAD_UP_ANGLE_SET: {
//                     final HeadUpAngleResponse headUpAngleResponse = glassesToPhone.getHeadUpAngleSet();
//                     final boolean setResult = headUpAngleResponse.getSuccess();
//                     // EventBus.getDefault().post(new
//                     // HeadUpAngleEvent(headUpAngleResponse.getHeadUpAngle()));
//                     // EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));
//                     Log.d(TAG, "headUpAngleResponse: " + headUpAngleResponse.toString());
//                 }
//                 break;
//                 case PING: {
//                     lastHeartbeatReceivedTime = System.currentTimeMillis();
//                     Log.d(TAG, "=== RECEIVED PING FROM GLASSES === (Time: " + lastHeartbeatReceivedTime + ")");
//                     // Respond to ping with pong
//                     sendPongResponse();
//                 }
//                 break;
//                 case VAD_EVENT: {
//                     // final VadEvent vadEvent = glassesToPhone.getVadEvent();
//                     // EventBus.getDefault().post(new VadEvent(vadEvent.getVad()));
//                 }
//                 break;
//                 case IMAGE_TRANSFER_COMPLETE: {
//                     final ImageTransferComplete transferComplete = glassesToPhone.getImageTransferComplete();
//                     Log.d(TAG, "transferComplete: " + transferComplete.toString());
//                     // EventBus.getDefault().post(new
//                     // ImageTransferCompleteEvent(transferComplete.getImageTransferComplete()));
//                     final ImageTransferComplete.Status status = transferComplete.getStatus();
//                     switch (status) {
//                         case OK:
//                             currentImageChunks.clear();
//                             isImageSendProgressing = false;
//                             break;
//                         case INCOMPLETE:
//                             List<Integer> missingChunksList = transferComplete.getMissingChunksList();
//                             reSendImageMissingChunks(missingChunksList);
//                             break;
//                     }
//                 }
//                 break;
//                 case IMU_DATA: {
//                     final ImuData imuData = glassesToPhone.getImuData();
//                     Log.d(TAG, "imuData: " + imuData.toString());
//                 }
//                 break;
//                 case BUTTON_EVENT: {
//                     final ButtonEvent buttonEvent = glassesToPhone.getButtonEvent();
//                     Log.d(TAG, "buttonEvent: " + buttonEvent.toString());
//                     // buttonEvent.getButton().getNumber()
//                     // EventBus.getDefault().post(new ButtonPressEvent(
//                     // smartGlassesDevice.deviceModelName,
//                     // buttonId,
//                     // pressType,
//                     // timestamp));
//                 }
//                 break;
//                 case HEAD_GESTURE: {
//                     final HeadGesture headGesture = glassesToPhone.getHeadGesture();
//                     Log.d(TAG, "headGesture: " + headGesture.toString());
//                     // EventBus.getDefault().post(new GlassesHeadUpEvent());
//                     // EventBus.getDefault().post(new GlassesHeadDownEvent());
//                     // EventBus.getDefault().post(new GlassesTapOutputEvent(2, isRight,
//                     // System.currentTimeMillis()));
//                 }
//                 break;
//                 case VERSION_RESPONSE: {
//                     final VersionResponse versionResponse = glassesToPhone.getVersionResponse();
//                     Log.d(TAG, "=== RECEIVED GLASSES PROTOBUF VERSION RESPONSE ===");
//                     Log.d(TAG, "Glasses Protobuf Version: " + versionResponse.getVersion());
//                     Log.d(TAG, "Message ID: " + versionResponse.getMsgId());
//                     if (!versionResponse.getCommit().isEmpty()) {
//                         Log.d(TAG, "Commit: " + versionResponse.getCommit());
//                     }
//                     if (!versionResponse.getBuildDate().isEmpty()) {
//                         Log.d(TAG, "Build Date: " + versionResponse.getBuildDate());
//                     }
                    
//                     // Post glasses protobuf version event to update UI
//                     EventBus.getDefault().post(new ProtocolVersionResponseEvent(
//                         versionResponse.getVersion(),
//                         versionResponse.getCommit(),
//                         versionResponse.getBuildDate(),
//                         versionResponse.getMsgId()
//                     ));
//                 }
//                 break;
//                 case PAYLOAD_NOT_SET: {
//                 }
//                 break;
//                 default:
//                     Log.d(TAG, "unknown payloadCase: " + payloadCase);
//                     break;
//             }

//         } catch (InvalidProtocolBufferException e) {
//             e.printStackTrace(); // Handle parsing error
//         }

//     }

//     /**
//      * Decodes serial number from manufacturer data bytes
//      *
//      * @param manufacturerData The manufacturer data bytes
//      * @return Decoded serial number string or null if not found
//      */
//     private String decodeSerialFromManufacturerData(byte[] manufacturerData) {
//         if (manufacturerData == null || manufacturerData.length < 10) {
//             return null;
//         }

//         try {
//             // Convert hex bytes to ASCII string
//             StringBuilder serialBuilder = new StringBuilder();
//             for (int i = 0; i < manufacturerData.length; i++) {
//                 byte b = manufacturerData[i];
//                 if (b == 0x00) {
//                     // Stop at null terminator
//                     break;
//                 }
//                 if (b >= 0x20 && b <= 0x7E) {
//                     // Only include printable ASCII characters
//                     serialBuilder.append((char) b);
//                 }
//             }

//             String decodedString = serialBuilder.toString().trim();

//             // Check if it looks like a valid Even NexGlasses serial number
//             if (decodedString.length() >= 12 && (decodedString.startsWith("S1") || decodedString.startsWith("100")
//                     || decodedString.startsWith("110"))) {
//                 return decodedString;
//             }

//             return null;
//         } catch (Exception e) {
//             Log.e(TAG, "Error decoding manufacturer data: " + e.getMessage());
//             return null;
//         }
//     }

//     private Boolean isDebug(Context context) {
//         return BuildConfig.DEBUG;
//     }

//     public void setLc3AudioEnabled(boolean enabled) {
//         Log.d(TAG, "setLc3AudioEnabled: " + enabled);
//         this.isLc3AudioEnabled = enabled;
        
//         if (lc3AudioPlayer != null) {
//             if (enabled) {
//                 // Start LC3 audio player
//                 try {
//                     lc3AudioPlayer.startPlay();
//                     Log.d(TAG, "LC3 audio player started");
//                 } catch (Exception e) {
//                     Log.e(TAG, "Failed to start LC3 audio player", e);
//                 }
//             } else {
//                 // Stop LC3 audio player
//                 try {
//                     lc3AudioPlayer.stopPlay();
//                     Log.d(TAG, "LC3 audio player stopped");
//                     // Re-initialize for next use
//                     lc3AudioPlayer.init();
//                 } catch (Exception e) {
//                     Log.e(TAG, "Failed to stop LC3 audio player", e);
//                 }
//             }
//         }
//     }

//     public void setVadEnabled(boolean enabled) {
//         Log.d(TAG, "setVadEnabled: " + enabled);
//         this.isVadEnabled = enabled;

//         VadEnabledRequest vadEnabledRequest = VadEnabledRequest.newBuilder().setEnabled(enabled).build();
        
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//             .setSetVadEnabled(vadEnabledRequest)
//             .build();

//         byte[] versionQueryPacket = generateProtobufCommandBytes(phoneToGlasses);
//         sendDataSequentially(versionQueryPacket, 100);
//     }

//     public void setVadSensitivity(int sensitivity) {
//         Log.d(TAG, "setVadSensitivity: " + sensitivity);
//         this.vadSensitivity = sensitivity;

//         VadConfigRequest vadConfigRequest = VadConfigRequest.newBuilder().setSensitivity(sensitivity).build();
        
//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//             .setSetVadConfig(vadConfigRequest)
//             .build();

//         byte[] versionQueryPacket = generateProtobufCommandBytes(phoneToGlasses);
//         sendDataSequentially(versionQueryPacket, 100);
//     }

//     public void requestVadConfig() {
//         Log.d(TAG, "requestVadConfig");

//         MentraosBle.VadStatusRequest request = MentraosBle.VadStatusRequest.newBuilder().build();

//         PhoneToGlasses phoneToGlasses = PhoneToGlasses.newBuilder()
//             .setRequestVadStatus(request)
//             .build();

//         byte[] versionQueryPacket = generateProtobufCommandBytes(phoneToGlasses);
//         sendDataSequentially(versionQueryPacket, 100);
//     }

//     public boolean isLc3AudioEnabled() {
//         return isLc3AudioEnabled;
//     }

//     private class DisplayTextJson {
//         private String type;
//         private String msg_id;
//         private String text;
//         private String color;
//         private String font_code;
//         private int x;
//         private int y;
//         private int size;

//         public String getType() {
//             return type;
//         }

//         public void setType(String type) {
//             this.type = type;
//         }

//         public String getMsg_id() {
//             return msg_id;
//         }

//         public void setMsg_id(String msg_id) {
//             this.msg_id = msg_id;
//         }

//         public String getColor() {
//             return color;
//         }

//         public void setColor(String color) {
//             this.color = color;
//         }

//         public String getFont_code() {
//             return font_code;
//         }

//         public void setFont_code(String font_code) {
//             this.font_code = font_code;
//         }

//         public int getX() {
//             return x;
//         }

//         public void setX(int x) {
//             this.x = x;
//         }

//         public int getY() {
//             return y;
//         }

//         public void setY(int y) {
//             this.y = y;
//         }

//         public int getSize() {
//             return size;
//         }

//         public void setSize(int size) {
//             this.size = size;
//         }

//         public String getText() {
//             return text;
//         }

//         public void setText(String text) {
//             this.text = text;
//         }
//     }

//     // send a test image and display
//     private void startSendingDisplayImageTest(String imageType, String imageSize) {
//         if (isImageSendProgressing) {
//             return;
//         }
//         isImageSendProgressing = true;
//         Log.d(TAG, "startSendingDisplayImageTest - Type: " + imageType + ", Size: " + imageSize);

//         try {
//             // Parse the size dimensions
//             String[] dimensions = imageSize.split("x");
//             int width = Integer.parseInt(dimensions[0]);
//             int height = Integer.parseInt(dimensions[1]);
            
//             // Generate the test image based on type and size
//             byte[] bmpData = generateTestImage(imageType, width, height);
//             if (bmpData != null) {
//                 displayBitmapImageForNexGlasses(bmpData, width, height);
//             } else {
//                 Log.e(TAG, "Failed to generate test image");
//             }
//         } catch (Exception e) {
//             Log.e(TAG, "Error generating test image: " + e.getMessage());
//         } finally {
//             isImageSendProgressing = false;
//         }
//     }

//     /**
//      * Generates a test bitmap image based on the specified type and size
//      */
//     private byte[] generateTestImage(String imageType, int width, int height) {
//         try {
//             // Create a 1-bit bitmap (black and white)
//             Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            
//             // Fill with white background
//             bitmap.eraseColor(Color.WHITE);
            
//             // Create canvas for drawing
//             Canvas canvas = new Canvas(bitmap);
//             Paint paint = new Paint();
//             paint.setColor(Color.BLACK);
//             paint.setStyle(Paint.Style.FILL);
            
//             switch (imageType) {
//                 case "pattern":
//                     // Create continuous horizontal lines pattern
//                     for (int y = 0; y < height; y += 4) {
//                         canvas.drawLine(0, y, width, y, paint);
//                         canvas.drawLine(0, y + 1, width, y + 1, paint);
//                     }
//                     break;
                    
//                 case "gradient":
//                     // Create a gradient from top to bottom
//                     for (int y = 0; y < height; y++) {
//                         int alpha = (int) (255 * (1.0 - (double) y / height));
//                         paint.setAlpha(alpha);
//                         canvas.drawLine(0, y, width, y, paint);
//                     }
//                     break;
                    
//                 case "checkerboard":
//                     // Create a checkerboard pattern
//                     int squareSize = Math.max(1, Math.min(width, height) / 8);
//                     for (int y = 0; y < height; y += squareSize) {
//                         for (int x = 0; x < width; x += squareSize) {
//                             if (((x / squareSize) + (y / squareSize)) % 2 == 0) {
//                                 canvas.drawRect(x, y, x + squareSize, y + squareSize, paint);
//                             }
//                         }
//                     }
//                     break;
                    
//                 case "solid":
//                     // Create a solid black image
//                     canvas.drawRect(0, 0, width, height, paint);
//                     break;
                    
//                 default:
//                     // Default to pattern
//                     for (int i = 0; i < Math.max(width, height); i += 4) {
//                         canvas.drawLine(i, 0, i + 2, height, paint);
//                     }
//                     break;
//             }
            
//             // Convert to 1-bit BMP format
//             return BitmapJavaUtils.convertBitmapTo1BitBmpBytes(bitmap, false);
            
//         } catch (Exception e) {
//             Log.e(TAG, "Error generating test image: " + e.getMessage());
//             return null;
//         }
//     }
    
//     /**
//      * Notify mobile app about heartbeat sent (now used when sending pong responses)
//      */
//     private void notifyHeartbeatSent(long timestamp) {
//         lastHeartbeatSentTime = timestamp;
//         // Send heartbeat event to mobile app via EventBus
//         EventBus.getDefault().post(new HeartbeatSentEvent(timestamp));
//     }
    
//     /**
//      * Notify mobile app about heartbeat received
//      */
//     private void notifyHeartbeatReceived(long timestamp) {
//         // Send heartbeat event to mobile app via EventBus
//         EventBus.getDefault().post(new HeartbeatReceivedEvent(timestamp));
//     }
    
//     /**
//      * Get last heartbeat sent timestamp (pong response time)
//      */
//     public long getLastHeartbeatSentTime() {
//         return lastHeartbeatSentTime;
//     }
    
//     /**
//      * Get last heartbeat received timestamp
//      */
//     public long getLastHeartbeatReceivedTime() {
//         return lastHeartbeatReceivedTime;
//     }
    
//         /**
//      * Gets the current protobuf schema version from the compiled protobuf descriptor
//      */
//     public int getProtobufSchemaVersion() {
//         try {
//             // Get the protobuf descriptor and extract the schema version
//             com.google.protobuf.Descriptors.FileDescriptor fileDescriptor = 
//                 mentraos.ble.MentraosBle.getDescriptor().getFile();
            
//             Log.d(TAG, "Proto file descriptor: " + fileDescriptor.getName());
            
//             // Method 1: Try to access the custom mentra_schema_version option
//             try {
//                 // Get the file options from the descriptor
//                 com.google.protobuf.DescriptorProtos.FileOptions options = fileDescriptor.getOptions();
//                 Log.d(TAG, "Got file options: " + options.toString());
                
//                 // Try to access the custom option using the extension registry
//                 // First, check if the extension is available in the generated code
//                 try {
//                     // Look for the generated extension in the MentraosBle class
//                     java.lang.reflect.Field[] fields = mentraos.ble.MentraosBle.class.getDeclaredFields();
//                     for (java.lang.reflect.Field field : fields) {
//                         if (field.getName().toLowerCase().contains("schema") || 
//                             field.getName().toLowerCase().contains("version")) {
//                             Log.d(TAG, "Found potential version field: " + field.getName());
//                             field.setAccessible(true);
//                             try {
//                                 Object value = field.get(null);
//                                                         if (value instanceof com.google.protobuf.Extension) {
//                                 com.google.protobuf.Extension<com.google.protobuf.DescriptorProtos.FileOptions, Integer> ext = 
//                                     (com.google.protobuf.Extension<com.google.protobuf.DescriptorProtos.FileOptions, Integer>) value;
//                                 if (options.hasExtension(ext)) {
//                                     int version = options.getExtension(ext);
//                                     Log.d(TAG, "Found schema version via extension: " + version);
//                                     return version;
//                                 }
//                             }
//                             } catch (Exception fieldException) {
//                                 Log.d(TAG, "Field access failed for " + field.getName() + ": " + fieldException.getMessage());
//                             }
//                         }
//                     }
//                 } catch (Exception extensionException) {
//                     Log.d(TAG, "Extension search failed: " + extensionException.getMessage());
//                 }
                
//             } catch (Exception optionsException) {
//                 Log.d(TAG, "Options access failed: " + optionsException.getMessage());
//             }
            
//             // Method 2: Try to read from the actual proto file content
//             try {
//                 String protoVersion = readProtoVersionFromProject();
//                 if (protoVersion != null) {
//                     Log.d(TAG, "Read proto version from project: " + protoVersion);
//                     return Integer.parseInt(protoVersion);
//                 }
//             } catch (Exception projectException) {
//                 Log.d(TAG, "Project file reading failed: " + projectException.getMessage());
//             }
            

            
//             Log.w(TAG, "Could not extract protobuf schema version dynamically, using fallback");
//             return 1; // Fallback to version 1
            
//         } catch (Exception e) {
//             Log.e(TAG, "Error getting protobuf schema version: " + e.getMessage(), e);
//             return 1; // Fallback to version 1
//         }
//     }
    
//     /**
//      * Gets detailed protobuf build information
//      */
//     public String getProtobufBuildInfo() {
//         try {
//             int schemaVersion = getProtobufSchemaVersion();
//             String fileDescriptorName = mentraos.ble.MentraosBle.getDescriptor().getFile().getName();
            
//             return String.format("Schema v%d | %s", schemaVersion, fileDescriptorName);
//         } catch (Exception e) {
//             Log.e(TAG, "Error getting protobuf build info: " + e.getMessage(), e);
//             return "Schema v1 | Unknown";
//         }
//     }
    
//     @Override
//     public String getProtobufSchemaVersionInfo() {
//         return getProtobufBuildInfo();
//     }
    
//     /**
//      * Posts protobuf schema version information to EventBus for React Native consumption
//      */
//     public void postProtobufSchemaVersionInfo() {
//         try {
//             // Call the version method only once
//             int schemaVersion = getProtobufSchemaVersion();
            
//             // Build the info string directly instead of calling getProtobufBuildInfo()
//             String fileDescriptorName = mentraos.ble.MentraosBle.getDescriptor().getFile().getName();
//             String buildInfo = String.format("Schema v%d | %s", schemaVersion, fileDescriptorName);
            
//             ProtobufSchemaVersionEvent event = new ProtobufSchemaVersionEvent(
//                 schemaVersion, 
//                 buildInfo, 
//                 smartGlassesDevice != null ? smartGlassesDevice.deviceModelName : "Unknown"
//             );
            
//             EventBus.getDefault().post(event);
//             Log.d(TAG, "Posted protobuf schema version event: " + buildInfo);
//         } catch (Exception e) {
//             Log.e(TAG, "Error posting protobuf schema version event: " + e.getMessage(), e);
//         }
//     }
    
//     /**
//      * Attempts to read the protobuf schema version from the proto file in the project
//      */
//     private String readProtoVersionFromProject() {
//         try {
//             // Try to read from assets first
//             try (InputStream is = context.getAssets().open("mentraos_ble.proto")) {
//                 String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
//                 return extractVersionFromProtoContent(content);
//             }
//         } catch (Exception assetsException) {
//             Log.d(TAG, "Could not read from assets: " + assetsException.getMessage());
//         }
        
//         try {
//             // Try to read from resources
//             try (InputStream is = context.getResources().openRawResource(
//                     context.getResources().getIdentifier("mentraos_ble", "raw", context.getPackageName()))) {
//                 String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
//                 return extractVersionFromProtoContent(content);
//             }
//         } catch (Exception resourcesException) {
//             Log.d(TAG, "Could not read from resources: " + resourcesException.getMessage());
//         }
        
//         // Try to read from the project directory structure
//         try {
//             // Look for the proto file in common project locations relative to Android app
//             String[] projectPaths = {
//                 // Relative to Android project root
//                 "../../mcu_client/mentraos_ble.proto",
//                 "../../../mcu_client/mentraos_ble.proto", 
//                 "../../../../mcu_client/mentraos_ble.proto",
//                 // Absolute paths from common Android locations
//                 "/data/data/" + context.getPackageName() + "/../../mcu_client/mentraos_ble.proto",
//                 // Try external storage
//                 android.os.Environment.getExternalStorageDirectory() + "/MentraOS/mcu_client/mentraos_ble.proto"
//             };
            
//             for (String path : projectPaths) {
//                 try {
//                     java.io.File protoFile = new java.io.File(path);
//                     Log.d(TAG, "Checking path: " + protoFile.getAbsolutePath());
//                     if (protoFile.exists() && protoFile.canRead()) {
//                         Log.d(TAG, "Found proto file at: " + protoFile.getAbsolutePath());
//                         String content = new String(java.nio.file.Files.readAllBytes(protoFile.toPath()), StandardCharsets.UTF_8);
//                         return extractVersionFromProtoContent(content);
//                     }
//                 } catch (Exception pathException) {
//                     Log.d(TAG, "Path check failed for " + path + ": " + pathException.getMessage());
//                 }
//             }
//         } catch (Exception projectException) {
//             Log.d(TAG, "Project file reading failed: " + projectException.getMessage());
//         }
        
//         return null;
//     }
    
//     /**
//      * Extracts version number from proto file content
//      */
//     private String extractVersionFromProtoContent(String content) {
//         try {
//             // Look for the mentra_schema_version option
//             java.util.regex.Pattern pattern = java.util.regex.Pattern.compile(
//                 "option\\s*\\(\\s*mentra_schema_version\\s*\\)\\s*=\\s*(\\d+)\\s*;");
//             java.util.regex.Matcher matcher = pattern.matcher(content);
            
//             if (matcher.find()) {
//                 String version = matcher.group(1);
//                 Log.d(TAG, "Extracted version from proto content: " + version);
//                 return version;
//             }
            
//             Log.d(TAG, "No mentra_schema_version found in proto content");
//             return null;
//         } catch (Exception e) {
//             Log.e(TAG, "Error extracting version from proto content: " + e.getMessage());
//             return null;
//         }
//     }
// }