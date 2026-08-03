package com.mentra.bluetoothsdk.sgcs


import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.SparseArray

import java.io.IOException
import java.io.InputStream
import java.util.concurrent.BlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

//BMP
import java.util.ArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.zip.CRC32
import java.nio.ByteBuffer

import com.google.gson.Gson

import org.greenrobot.eventbus.EventBus
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.lang.reflect.Method
import java.nio.charset.StandardCharsets
import java.util.Arrays
import java.util.UUID
import java.util.concurrent.Semaphore
import java.util.regex.Matcher
import java.util.regex.Pattern
import java.util.HashMap
import java.util.HashSet

// Mentra
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.BitmapJavaUtils

import com.mentra.bluetoothsdk.utils.BitmapJavaUtils.convertBitmapTo1BitBmpBytes

import com.mentra.bluetoothsdk.utils.G1Text
import com.mentra.bluetoothsdk.utils.SmartGlassesConnectionState
import com.mentra.lc3Lib.Lc3Cpp
import com.mentra.bluetoothsdk.DeviceStore

class G1 : SGCManager() {

    companion object {
        private const val TAG = "WearableAi_EvenRealitiesG1SGC"
        const val SHARED_PREFS_NAME = "EvenRealitiesPrefs"

        const val LEFT_DEVICE_KEY = "SavedG1LeftName"
        const val RIGHT_DEVICE_KEY = "SavedG1RightName"

        private val UART_SERVICE_UUID: UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
        private val UART_TX_CHAR_UUID: UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
        private val UART_RX_CHAR_UUID: UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
        private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID
            .fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val SAVED_G1_ID_KEY = "SAVED_G1_ID_KEY"

        private const val DELAY_BETWEEN_SENDS_MS = 5L // not using now
        private const val DELAY_BETWEEN_CHUNKS_SEND = 5L // super small just in case
        private const val DELAY_BETWEEN_ACTIONS_SEND = 250L // not using now
        private const val HEARTBEAT_INTERVAL_MS = 15000L
        private const val MICBEAT_INTERVAL_MS = (1000L * 60) * 30 // micbeat every 30 minutes

        private const val BASE_RECONNECT_DELAY_MS = 3000L // Start with 3 seconds
        private const val MAX_RECONNECT_DELAY_MS = 60000L

        private const val BOND_RETRY_DELAY_MS = 5000L // 5-second backoff

        private const val CONNECTION_TIMEOUT_MS = 10000L // 10 seconds

        private const val DEBOUNCE_DELAY_MS = 270L // Minimum time between chunk sends

        private const val RIGHT_CONNECTION_RETRY_DELAY = 1000L // 1 second

        private const val INITIAL_CONNECTION_DELAY_MS = 350L // Adjust this value as needed

        private const val NOTIFICATION = 0x4B // Notification command

        // Constants for text wall display
        private const val TEXT_COMMAND = 0x4E // Text command
        private const val DISPLAY_WIDTH = 488
        private const val DISPLAY_USE_WIDTH = 488 // How much of the display to use
        private const val FONT_MULTIPLIER = 1 / 50.0f
        private const val OLD_FONT_SIZE = 21 // Font size
        private const val FONT_DIVIDER = 2.0f
        private const val LINES_PER_SCREEN = 5 // Lines per screen
        private const val MAX_CHUNK_SIZE = 176 // Maximum chunk size for BLE packets
        // private static final int INDENT_SPACES = 32; // Number of spaces to indent
        // text

        // handle white list stuff
        private const val WHITELIST_CMD = 0x04 // Command ID for whitelist

        // BMP handling

        // Add these class variables
        private const val BMP_CHUNK_SIZE = 194
        private val GLASSES_ADDRESS = byteArrayOf(0x00, 0x1c, 0x00, 0x00)
        private val END_COMMAND = byteArrayOf(0x20, 0x0d, 0x0e)
        private const val MAX_BMP_RETRY_ATTEMPTS = 10
        private const val BMP_RETRY_DELAY_MS = 1000L

        // Platform-specific timing (matching Flutter implementation)
        // private static final long ANDROID_CHUNK_DELAY_MS = 5;
        private const val ANDROID_CHUNK_DELAY_MS = 8L
        private const val IOS_CHUNK_DELAY_MS = 8L
        private const val END_COMMAND_TIMEOUT_MS = 3000L
        private const val CRC_COMMAND_TIMEOUT_MS = 3000L
        private const val CHUNK_SEND_TIMEOUT_MS = 5000L

        // Optimized bitmap display flags
        private const val USE_OPTIMIZED_BITMAP_DISPLAY = true
        private const val USE_PARALLEL_BITMAP_WRITES = true

        @JvmStatic
        fun savePreferredG1DeviceId(context: Context?, deviceName: String?) {
            Bridge.saveSetting("deviceName", deviceName!!)
        }

        @JvmStatic
        fun deleteEvenSharedPreferences(context: Context?) {
            // savePreferredG1DeviceId(context, null);
            // SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME,
            // Context.MODE_PRIVATE);
            // prefs.edit().clear().apply();
            // Bridge.log("G1: Nuked EvenRealities SharedPreferences");
        }

        private fun bytesToHex(bytes: ByteArray): String {
            val sb = StringBuilder()
            for (b in bytes) {
                sb.append(String.format("%02X ", b))
            }
            return sb.toString().trim()
        }

        private fun bytesToUtf8(bytes: ByteArray): String {
            return String(bytes, StandardCharsets.UTF_8)
        }

        /**
         * Decodes Even G1 serial number to extract style and color information
         *
         * @param serialNumber The full serial number (e.g., "S110LABD020021")
         * @return Array containing [style, color] or ["Unknown", "Unknown"] if invalid
         */
        @JvmStatic
        fun decodeEvenG1SerialNumber(serialNumber: String?): Array<String> {
            if (serialNumber == null || serialNumber.length < 6) {
                return arrayOf("Unknown", "Unknown")
            }

            // Style mapping: 3rd character (index 2)
            val style: String
            when (serialNumber[1]) {
                '0' ->
                    style = "Round"
                '1' ->
                    style = "Rectangular"
                else ->
                    style = "Round"
            }

            // Color mapping: 5th character (index 4)
            val color: String
            when (serialNumber[4]) {
                'A' ->
                    color = "Grey"
                'B' ->
                    color = "Brown"
                'C' ->
                    color = "Green"
                else ->
                    color = "Grey"
            }

            return arrayOf(style, color)
        }
    }

    private var heartbeatCount = 0
    private var micBeatCount = 0
    private var bluetoothAdapter: BluetoothAdapter? = null

    private var isKilled = false

    private var context: Context? = null
    private var leftGlassGatt: BluetoothGatt? = null
    private var rightGlassGatt: BluetoothGatt? = null
    private var leftTxChar: BluetoothGattCharacteristic? = null
    private var rightTxChar: BluetoothGattCharacteristic? = null
    private var leftRxChar: BluetoothGattCharacteristic? = null
    private var rightRxChar: BluetoothGattCharacteristic? = null
    // NOTE: named connectionState in G1.java; renamed because Kotlin can't shadow
    // SGCManager's public val connectionState with a private field of another type.
    private var g1ConnectionState = SmartGlassesConnectionState.DISCONNECTED
    // Executor for parallel bitmap operations (declared before init so the
    // constructor body can assign it; in G1.java this field lived in the BMP section)
    private var bitmapExecutor: ExecutorService? = null
    private val handler = Handler(Looper.getMainLooper())
    private val queryBatteryStatusHandler = Handler(Looper.getMainLooper())
    private val sendBrightnessCommandHandler = Handler(Looper.getMainLooper())
    private var connectHandler = Handler(Looper.getMainLooper())
    private var reconnectHandler = Handler(Looper.getMainLooper())
    private var characteristicHandler = Handler(Looper.getMainLooper())
    private val sendSemaphore = Semaphore(1)
    private var isLeftConnected = false
    private var isRightConnected = false
    private var currentSeq = 0
    private var stopper = false
    private var debugStopper = false
    private var shouldUseAutoBrightness = false
    private var updatingScreen = false


    private var batteryLeft = -1
    private var batteryRight = -1
    private var leftReconnectAttempts = 0
    private var rightReconnectAttempts = 0
    private var reconnectAttempts = 0 // Counts the number of reconnect attempts

    // heartbeat sender
    private var heartbeatHandler = Handler()
    private var findCompatibleDevicesHandler: Handler? = null
    private var isScanningForCompatibleDevices = false
    private var isScanning = false

    private var heartbeatRunnable: Runnable? = null

    // mic heartbeat turn on
    private var micBeatHandler = Handler()
    private var micBeatRunnable: Runnable? = null

    // white list sender
    private var whiteListHandler = Handler()
    private var whiteListedAlready = false

    // mic enable Handler
    private var micEnableHandler = Handler()
    private var isMicrophoneEnabled = false // Track current microphone state

    // notification period sender
    private var notificationHandler = Handler()
    private var notificationRunnable: Runnable? = null
    private var notifysStarted = false
    private var notificationNum = 10

    // text wall periodic sender
    private var textWallHandler = Handler()
    private var textWallRunnable: Runnable? = null
    private var textWallsStarted = false
    private var textWallNum = 10

    // pairing logic
    private var isLeftPairing = false
    private var isRightPairing = false
    private var isLeftBonded = false
    private var isRightBonded = false
    private var leftDevice: BluetoothDevice? = null
    private var rightDevice: BluetoothDevice? = null
    private var leftDeviceName: String? = null  // Store name separately since BluetoothDevice.getName() can become null
    private var rightDeviceName: String? = null // Store name separately since BluetoothDevice.getName() can become null
    private var preferredG1Id: String? = null
    private var pendingSavedG1LeftName: String? = null
    private var pendingSavedG1RightName: String? = null
    private var savedG1LeftName: String? = null
    private var savedG1RightName: String? = null
    private var preferredG1DeviceId: String? = null

    // handler to turn off screen
    // Handler goHomeHandler;
    // Runnable goHomeRunnable;

    // Retry handler
    var retryBondHandler: Handler? = null

    // remember when we connected
    private var lastConnectionTimestamp = 0L

    // Handlers for connection timeouts
    private val leftConnectionTimeoutHandler = Handler(Looper.getMainLooper())
    private val rightConnectionTimeoutHandler = Handler(Looper.getMainLooper())

    // Runnable tasks for handling timeouts
    private var leftConnectionTimeoutRunnable: Runnable? = null
    private var rightConnectionTimeoutRunnable: Runnable? = null
    private var isBondingReceiverRegistered = false
    private var shouldUseGlassesMic = false
    private var lastThingDisplayedWasAnImage = false

    // Serial number and style/color information
    // NOTE: G1.java declared public fields serialNumber/style/color here, but they were
    // never read or written; in Kotlin they would clash with SGCManager's val properties,
    // so they are omitted.

    // lock writing until the last write is successful
    // fonts in G1
    private var g1Text: G1Text? = null

    @Volatile private var lastSendTimestamp = 0L
    private var lc3DecoderPtr = 0L

    init {
        this.type = DeviceTypes.G1
        this.hasMic = true  // G1 has a built-in microphone
        DeviceStore.apply("glasses", "micEnabled", false)
        Bridge.log("G1: G1 constructor")
        this.context = Bridge.getContext()
        loadPairedDeviceNames()
        // goHomeHandler = new Handler();
        // this.smartGlassesDevice = smartGlassesDevice;
        preferredG1DeviceId = DeviceStore.get("bluetooth", "device_name") as String?
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()
        this.shouldUseGlassesMic = false

        // Initialize bitmap executor for parallel operations
        if (USE_PARALLEL_BITMAP_WRITES) {
            bitmapExecutor = Executors.newFixedThreadPool(2)
        }

        // setup LC3 decoder
        if (lc3DecoderPtr == 0L) {
            lc3DecoderPtr = Lc3Cpp.initDecoder()
        }

        // setup fonts
        g1Text = G1Text()
        DeviceStore.apply("glasses", "caseRemoved", true)
    }

    private val leftGattCallback: BluetoothGattCallback = createGattCallback("Left")
    private val rightGattCallback: BluetoothGattCallback = createGattCallback("Right")

    private fun createGattCallback(side: String): BluetoothGattCallback {
        return object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                // Bridge.log("G1: ConnectionStateChanged");
                // Cancel the connection timeout
                if ("Left" == side && leftConnectionTimeoutRunnable != null) {
                    leftConnectionTimeoutHandler.removeCallbacks(leftConnectionTimeoutRunnable!!)
                    leftConnectionTimeoutRunnable = null
                } else if ("Right" == side && rightConnectionTimeoutRunnable != null) {
                    rightConnectionTimeoutHandler.removeCallbacks(rightConnectionTimeoutRunnable!!)
                    rightConnectionTimeoutRunnable = null
                }

                if (status == BluetoothGatt.GATT_SUCCESS) {

                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Bridge.log("G1: " + side + " glass connected, discovering services...")
                        if ("Left" == side) {
                            isLeftConnected = true
                            leftReconnectAttempts = 0
                        } else {
                            isRightConnected = true
                            rightReconnectAttempts = 0
                        }

                        if (isLeftConnected && isRightConnected) {
                            stopScan()
                            Bridge.log("G1: Both glasses connected. Stopping BLE scan.")
                        }

                        Bridge.log("G1: Discover services calling...")
                        gatt.discoverServices()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        Bridge.log("G1: Glass disconnected, stopping heartbeats")
                        Bridge.log("G1: Entering STATE_DISCONNECTED branch for side: " + side)

                        // Mark both sides as not ready (you could also clear both if one disconnects)
                        leftServicesWaiter.setTrue()
                        rightServicesWaiter.setTrue()
                        Bridge.log("G1: Set leftServicesWaiter and rightServicesWaiter to true.")

                        forceSideDisconnection()
                        Bridge.log("G1: Called forceSideDisconnection().")

                        // Stop any periodic transmissions
                        stopHeartbeat()
                        stopMicBeat()
                        sendQueue.clear()
                        Bridge.log("G1: Stopped heartbeat and mic beat; cleared sendQueue.")

                        updateConnectionState()
                        Bridge.log("G1: Updated connection state after disconnection.")

                        // Compute reconnection delay for both sides (here you could choose the maximum
                        // of the two delays or a new delay)
                        // long delayLeft = Math.min(BASE_RECONNECT_DELAY_MS * (1L <<
                        // leftReconnectAttempts), MAX_RECONNECT_DELAY_MS);
                        // long delayRight = Math.min(BASE_RECONNECT_DELAY_MS * (1L <<
                        // rightReconnectAttempts), MAX_RECONNECT_DELAY_MS);
                        val delay = 2000L // or choose another strategy
                        // Bridge.log("G1: Computed delayLeft: " + delayLeft + " ms, delayRight: " +
                        // delayRight + " ms. Using delay: " + delay + " ms.");

                        Bridge.log("G1: " +
                            side + " glass disconnected. Scheduling reconnection for both glasses in " + delay
                            + " ms (Left attempts: " + leftReconnectAttempts + ", Right attempts: "
                            + rightReconnectAttempts + ")")

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
                        reconnectHandler.postDelayed({
                            Bridge.log("G1: Reconnect handler triggered after delay.")
                            if (gatt.device != null && !isKilled) {
                                Bridge.log("G1: Reconnecting to both glasses. isKilled = " + isKilled)
                                // Assuming you have stored references to both devices:
                                if (leftDevice != null) {
                                    Bridge.log("G1: Attempting to reconnect to leftDevice: " + leftDevice!!.address)
                                    reconnectToGatt(leftDevice!!)
                                } else {
                                    Bridge.log("G1: Left device reference is null.")
                                }
                                if (rightDevice != null) {
                                    Bridge.log("G1: Attempting to reconnect to rightDevice: " + rightDevice!!.address)
                                    reconnectToGatt(rightDevice!!)
                                } else {
                                    Bridge.log("G1: Right device reference is null.")
                                }
                            } else {
                                Bridge.log("G1: Reconnect handler aborted: either no GATT device or system is killed.")
                            }
                        }, delay)
                    }
                } else {
                    Log.e(TAG, "Unexpected connection state encountered for " + side + " glass: " + newState)
                    stopHeartbeat()
                    stopMicBeat()
                    sendQueue.clear()

                    // Mark both sides as not ready (you could also clear both if one disconnects)
                    leftServicesWaiter.setTrue()
                    rightServicesWaiter.setTrue()

                    Bridge.log("G1: Stopped heartbeat and mic beat; cleared sendQueue due to connection failure.")

                    Log.e(TAG, side + " glass connection failed with status: " + status)
                    if ("Left" == side) {
                        isLeftConnected = false
                        leftReconnectAttempts++
                        if (leftGlassGatt != null) {
                            leftGlassGatt!!.disconnect()
                            leftGlassGatt!!.close()
                        }
                        leftGlassGatt = null
                    } else {
                        isRightConnected = false
                        rightReconnectAttempts++
                        if (rightGlassGatt != null) {
                            rightGlassGatt!!.disconnect()
                            rightGlassGatt!!.close()
                        }
                        rightGlassGatt = null
                    }

                    forceSideDisconnection()
                    Bridge.log("G1: Called forceSideDisconnection() after connection failure.")

                    // Update connection state and notify frontend of disconnection
                    updateConnectionState()
                    Bridge.log("G1: Updated connection state after connection failure.")

                    connectHandler.postDelayed({
                        Bridge.log("G1: Attempting GATT connection for leftDevice immediately.")
                        attemptGattConnection(leftDevice)
                    }, 0L)

                    connectHandler.postDelayed({
                        Bridge.log("G1: Attempting GATT connection for rightDevice after 2000 ms delay.")
                        attemptGattConnection(rightDevice)
                    }, 400L)
                }
            }

            private fun forceSideDisconnection() {
                Bridge.log("G1: forceSideDisconnection() called for side: " + side)
                // Force disconnection from the other side if necessary
                if ("Left" == side) {
                    isLeftConnected = false
                    leftReconnectAttempts++
                    Bridge.log("G1: Left glass: Marked as disconnected and incremented leftReconnectAttempts to "
                        + leftReconnectAttempts)
                    if (leftGlassGatt != null) {
                        Bridge.log("G1: Left glass GATT exists. Disconnecting and closing leftGlassGatt.")
                        leftGlassGatt!!.disconnect()
                        leftGlassGatt!!.close()
                        leftGlassGatt = null
                    } else {
                        Bridge.log("G1: Left glass GATT is already null.")
                    }
                    // If right is still connected, disconnect it too
                    if (rightGlassGatt != null) {
                        Bridge.log("G1: Left glass disconnected - forcing disconnection from right glass.")
                        rightGlassGatt!!.disconnect()
                        rightGlassGatt!!.close()
                        rightGlassGatt = null
                        isRightConnected = false
                        rightReconnectAttempts++
                        Bridge.log("G1: Right glass marked as disconnected and rightReconnectAttempts incremented to "
                            + rightReconnectAttempts)
                    } else {
                        Bridge.log("G1: Right glass GATT already null, no action taken.")
                    }
                } else { // side equals "Right"
                    isRightConnected = false
                    rightReconnectAttempts++
                    Bridge.log("G1: Right glass: Marked as disconnected and incremented rightReconnectAttempts to "
                        + rightReconnectAttempts)
                    if (rightGlassGatt != null) {
                        Bridge.log("G1: Right glass GATT exists. Disconnecting and closing rightGlassGatt.")
                        rightGlassGatt!!.disconnect()
                        rightGlassGatt!!.close()
                        rightGlassGatt = null
                    } else {
                        Bridge.log("G1: Right glass GATT is already null.")
                    }
                    // If left is still connected, disconnect it too
                    if (leftGlassGatt != null) {
                        Bridge.log("G1: Right glass disconnected - forcing disconnection from left glass.")
                        leftGlassGatt!!.disconnect()
                        leftGlassGatt!!.close()
                        leftGlassGatt = null
                        isLeftConnected = false
                        leftReconnectAttempts++
                        Bridge.log("G1: Left glass marked as disconnected and leftReconnectAttempts incremented to "
                            + leftReconnectAttempts)
                    } else {
                        Bridge.log("G1: Left glass GATT already null, no action taken.")
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    Handler(Looper.getMainLooper()).post { initG1s(gatt, side) }
                }
            }

            override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic,
                                               status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // Bridge.log("G1: PROC_QUEUE - " + side + " glass write successful");
                } else {
                    Bridge.log("G1: " + side + " glass write failed with status: " + status)

                    if (status == 133) {
                        Bridge.log("G1: GOT THAT 133 STATUS!")

                    }
                }

                // clear the waiter
                if ("Left" == side) {
                    leftWaiter.setFalse()
                } else {
                    rightWaiter.setFalse()
                }
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                Bridge.log("G1: PROC - GOT DESCRIPTOR WRITE: " + status)

                // clear the waiter
                if ("Left" == side) {
                    leftServicesWaiter.setFalse()
                } else {
                    rightServicesWaiter.setFalse()
                }
            }

            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                characteristicHandler.post {
                    if (characteristic.uuid == UART_RX_CHAR_UUID) {
                        val data = characteristic.value
                        val deviceName = gatt.device.name
                        if (deviceName == null)
                            return@post

                        // Handle MIC audio data
                        if (data.isNotEmpty() && (data[0].toInt() and 0xFF) == 0xF1) {
                            // Bridge.log("G1: Lc3 Audio data received. Data: " + Arrays.toString(data) + ",
                            // from: " + deviceName);
                            val seq = data[1].toInt() and 0xFF // Sequence number
                            // eg. LC3 to PCM
                            val lc3 = Arrays.copyOfRange(data, 2, 202)
                            // byte[] pcmData = L3cCpp.decodeLC3(lc3);
                            // if (pcmData == null) {
                            // throw new IllegalStateException("Failed to decode LC3 data");
                            // }

                            if (deviceName.contains("R_")) {
                                // Forward raw LC3 to DeviceManager (matches iOS behavior)
                                // G1 uses 20-byte LC3 frames (default canonical config)
                                if (shouldUseGlassesMic) {
                                    DeviceManager.getInstance().handleGlassesMicData(lc3, 20)
                                }
                            } else {
                                // Bridge.log("G1: Lc3 Audio data received. Seq: " + seq + ", Data: " +
                                // Arrays.toString(lc3) + ", from: " + deviceName);
                            }
                        }
                        // HEAD UP MOVEMENTS
                        else if (data.size > 1 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x02) {
                            // Only check head movements from the right sensor
                            if (deviceName.contains("R_")) {
                                // Check for head down movement - initial F5 02 signal
                                Bridge.log("G1: HEAD UP MOVEMENT DETECTED")
                                DeviceStore.apply("glasses", "headUp", true)
                            }
                        }
                        // HEAD DOWN MOVEMENTS
                        else if (data.size > 1 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x03) {
                            if (deviceName.contains("R_")) {
                                Bridge.log("G1: HEAD DOWN MOVEMENT DETECTED")
                                // clearBmpDisplay();
                                DeviceStore.apply("glasses", "headUp", false)
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
                        else if (data.size > 2 && data[0] == 0x2C.toByte() && data[1] == 0x66.toByte()) {
                            if (deviceName.contains("L_")) {
                                // Bridge.log("G1: LEFT Battery response received");
                                batteryLeft = data[2].toInt()
                            } else if (deviceName.contains("R_")) {
                                // Bridge.log("G1: RIGHT Battery response received");
                                batteryRight = data[2].toInt()
                            }

                            if (batteryLeft != -1 && batteryRight != -1) {
                                val minBatt = Math.min(batteryLeft, batteryRight)
                                // Bridge.log("G1: Minimum Battery Level: " + minBatt);
                                // EventBus.getDefault().post(new BatteryLevelEvent(minBatt, false));
                                DeviceStore.apply("glasses", "batteryLevel", minBatt)
                            }
                        }
                        // CASE REMOVED
                        else if (data.size > 1 && (data[0].toInt() and 0xFF) == 0xF5
                            && ((data[1].toInt() and 0xFF) == 0x07 || (data[1].toInt() and 0xFF) == 0x06)) {
                            DeviceStore.apply("glasses", "caseRemoved", true)
                            Bridge.log("G1: CASE REMOVED")
                        }
                        // CASE OPEN
                        else if (data.size > 1 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x08) {
                            DeviceStore.apply("glasses", "caseOpen", true)
                            DeviceStore.apply("glasses", "caseRemoved", false)
                            // EventBus.getDefault()
                            // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                        }
                        // CASE CLOSED
                        else if (data.size > 1 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x0B) {
                            DeviceStore.apply("glasses", "caseOpen", false)
                            DeviceStore.apply("glasses", "caseRemoved", false)
                            // EventBus.getDefault()
                            // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                        }
                        // CASE CHARGING STATUS
                        else if (data.size > 3 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x0E) {
                            DeviceStore.apply("glasses", "caseCharging", (data[2].toInt() and 0xFF) == 0x01)// TODO: verify this is correct
                            // EventBus.getDefault()
                            // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                        }
                        // CASE CHARGING INFO
                        else if (data.size > 3 && (data[0].toInt() and 0xFF) == 0xF5 && (data[1].toInt() and 0xFF) == 0x0F) {
                            val newCaseBatteryLevel = (data[2].toInt() and 0xFF)// TODO: verify this is correct
                            DeviceStore.apply("glasses", "caseBatteryLevel", newCaseBatteryLevel)
                            // EventBus.getDefault()
                            // .post(new CaseEvent(caseBatteryLevel, caseCharging, caseOpen, caseRemoved));
                        }
                        // HEARTBEAT RESPONSE
                        else if (data.isNotEmpty() && data[0] == 0x25.toByte()) {
                            Bridge.log("G1: Heartbeat response received")
                        }
                        // TEXT RESPONSE
                        else if (data.isNotEmpty() && data[0] == 0x4E.toByte()) {
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
                }
            }

        }
    }

    private fun initG1s(gatt: BluetoothGatt, side: String) {
        gatt.requestMtu(251) // Request a higher MTU size
        Bridge.log("G1: Requested MTU size: 251")

        val uartService = gatt.getService(UART_SERVICE_UUID)

        if (uartService != null) {
            val txChar = uartService.getCharacteristic(UART_TX_CHAR_UUID)
            val rxChar = uartService.getCharacteristic(UART_RX_CHAR_UUID)

            if (txChar != null) {
                if ("Left" == side)
                    leftTxChar = txChar
                else
                    rightTxChar = txChar
                // enableNotification(gatt, txChar, side);
                // txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Bridge.log("G1: " + side + " glass TX characteristic found")
            }

            if (rxChar != null) {
                if ("Left" == side)
                    leftRxChar = rxChar
                else
                    rightRxChar = rxChar
                enableNotification(gatt, rxChar, side)
                // rxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                Bridge.log("G1: " + side + " glass RX characteristic found")
            }

            // Mark as connected but wait for setup below to update connection state
            if ("Left" == side) {
                isLeftConnected = true
                Bridge.log("G1: PROC_QUEUE - left side setup complete")

                // Manufacturer data decoding moved to connection start
            } else {
                isRightConnected = true
                // Bridge.log("G1: PROC_QUEUE - right side setup complete");
            }

            // setup the G1s
            if (isLeftConnected && isRightConnected) {
                Bridge.log("G1: Sending firmware request Command")
                sendDataSequentially(byteArrayOf(0x6E.toByte(), 0x74.toByte()))

                Bridge.log("G1: Sending init 0x4D Command")
                sendDataSequentially(byteArrayOf(0x4D.toByte(), 0xFB.toByte())) // told this is only left

                Bridge.log("G1: Sending turn off wear detection command")
                sendDataSequentially(byteArrayOf(0x27.toByte(), 0x00.toByte()))

                Bridge.log("G1: Sending turn off silent mode Command")
                sendDataSequentially(byteArrayOf(0x03.toByte(), 0x0A.toByte()))

                // debug command
                // Bridge.log("G1: Sending debug 0xF4 Command");
                // sendDataSequentially(new byte[]{(byte) 0xF4, (byte) 0x01});

                // no longer need to be staggered as we fixed the sender
                // do first battery status query
                queryBatteryStatusHandler.postDelayed({ queryBatteryStatus() }, 10L)

                // setup brightness
                val brightnessValue = (DeviceStore.get("bluetooth", "brightness") as Number).toInt()
                val shouldUseAutoBrightness = DeviceStore.get("bluetooth", "auto_brightness") as Boolean
                sendBrightnessCommandHandler
                    .postDelayed({ sendBrightnessCommand(brightnessValue, shouldUseAutoBrightness) }, 10L)

                // MIC state is handled by DeviceManager.updateMicState() after reconnection
                // Don't hardcode mic state here - let DeviceManager restore the user's preference

                // enable our AugmentOS notification key
                sendWhiteListCommand(10)

                // start heartbeat
                startHeartbeat(10000)

                // start mic beat
                // startMicBeat(30000);

                showHomeScreen() // turn on the g1 display

                updateConnectionState()

                // start sending debug notifications
                // startPeriodicNotifications(302);
                // start sending debug notifications
                // startPeriodicTextWall(302);
            }
        } else {
            Bridge.log("G1: " + side + " glass UART service not found")
        }
    }

    // working on all phones - must keep the delay
    private fun enableNotification(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, side: String) {
        Bridge.log("G1: PROC_QUEUE - Starting notification setup for " + side)

        // Simply enable notifications
        Bridge.log("G1: PROC_QUEUE - setting characteristic notification on side: " + side)
        val result = gatt.setCharacteristicNotification(characteristic, true)
        Bridge.log("G1: PROC_QUEUE - setCharacteristicNotification result for " + side + ": " + result)

        // Set write type for the characteristic
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        Bridge.log("G1: PROC_QUEUE - write type set for " + side)

        // wait
        Bridge.log("G1: PROC_QUEUE - waiting to enable it on this side: " + side)

        try {
            Thread.sleep(500)
        } catch (e: InterruptedException) {
            Bridge.log("G1: Error sending data: " + e.message)
        }

        Bridge.log("G1: PROC_QUEUE - get descriptor on side: " + side)
        val descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID)
        if (descriptor != null) {
            Bridge.log("G1: PROC_QUEUE - setting descriptor on side: " + side)
            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            val r_result = gatt.writeDescriptor(descriptor)
            Bridge.log("G1: PROC_QUEUE - set descriptor on side: " + side + " with result: " + r_result)
        }
    }

    private fun updateConnectionState() {
        val previousConnectionState = connectionState
        if (isLeftConnected && isRightConnected) {
            g1ConnectionState = SmartGlassesConnectionState.CONNECTED
            Bridge.log("G1: Both glasses connected")
            lastConnectionTimestamp = System.currentTimeMillis()
            DeviceStore.apply("glasses", "fullyBooted", true)
            DeviceStore.apply("glasses", "connected", true)
        } else if (isLeftConnected || isRightConnected) {
            g1ConnectionState = SmartGlassesConnectionState.CONNECTING
            Bridge.log("G1: One glass connected")
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
        } else {
            g1ConnectionState = SmartGlassesConnectionState.DISCONNECTED
            Bridge.log("G1: No glasses connected")
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
        }
    }

    private val bondingReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val action = intent.action
            if (BluetoothDevice.ACTION_BOND_STATE_CHANGED == action) {
                val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)

                // Use device address to match with stored devices instead of relying on getName()
                // which can be null in the bonding broadcast
                val deviceAddress = device!!.address
                var isLeft = false
                var isRight = false
                var deviceName = device.name

                // Match by address with stored left/right devices from scanning
                if (leftDevice != null && leftDevice!!.address == deviceAddress) {
                    isLeft = true
                    // Use stored name string (more reliable than BluetoothDevice.getName())
                    if (deviceName == null) {
                        deviceName = leftDeviceName
                    }
                } else if (rightDevice != null && rightDevice!!.address == deviceAddress) {
                    isRight = true
                    // Use stored name string (more reliable than BluetoothDevice.getName())
                    if (deviceName == null) {
                        deviceName = rightDeviceName
                    }
                }

                // If we couldn't match this device, it's not one we're pairing with
                if (!isLeft && !isRight) {
                    Bridge.log("G1: Bond state changed for unknown device: " + deviceAddress)
                    return
                }

                // If name is still null after checking stored devices, log and return
                if (deviceName == null) {
                    Bridge.log("G1: Could not determine device name for address: " + deviceAddress)
                    return
                }

                val bondState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1)

                if (bondState == BluetoothDevice.BOND_BONDED) {
                    Bridge.log("G1: Bonded with device: " + deviceName + " (address: " + deviceAddress + ")")
                    if (isLeft) {
                        isLeftBonded = true
                        isLeftPairing = false
                        pendingSavedG1LeftName = deviceName
                    } else if (isRight) {
                        isRightBonded = true
                        isRightPairing = false
                        pendingSavedG1RightName = deviceName
                    }

                    // Reset both pairing flags when a device bonds successfully
                    // This prevents the other device from being blocked when scan restarts
                    isLeftPairing = false
                    isRightPairing = false

                    // Restart scan for the next device
                    if (!isLeftBonded || !isRightBonded) {
                        // if (!(isLeftBonded && !isRightBonded)){// || !doPendingPairingIdsMatch()) {
                        Bridge.log("G1: Restarting scan to find remaining device...")
                        // Add delay for vendor-specific timing issues (e.g., Motorola devices)
                        Handler(Looper.getMainLooper()).postDelayed({
                            startScan()
                        }, 500L) // 500ms delay
                    } else if (isLeftBonded && isRightBonded && !doPendingPairingIdsMatch()) {
                        // We've connected to two different G1s...
                        // Let's unpair the right, try to pair to a different one
                        isRightBonded = false
                        isRightConnected = false
                        isRightPairing = false
                        pendingSavedG1RightName = null
                        Bridge.log("G1: Connected to two different G1s - retry right G1 arm")
                    } else {
                        Bridge.log("G1: Both devices bonded. Proceeding with connections...")
                        savedG1LeftName = pendingSavedG1LeftName
                        savedG1RightName = pendingSavedG1RightName
                        savePairedDeviceNames()
                        stopScan()

                        connectHandler.postDelayed({
                            connectToGatt(leftDevice!!)
                        }, 0L)

                        connectHandler.postDelayed({
                            connectToGatt(rightDevice!!)
                        }, 2000L)
                    }
                } else if (bondState == BluetoothDevice.BOND_NONE) {
                    Bridge.log("G1: Bonding failed for device: " + deviceName + " (address: " + deviceAddress + ")")
                    if (isLeft)
                        isLeftPairing = false
                    if (isRight)
                        isRightPairing = false

                    // Restart scanning to retry bonding
                    if (retryBondHandler == null) {
                        retryBondHandler = Handler(Looper.getMainLooper())
                    }

                    retryBondHandler!!.postDelayed({
                        Bridge.log("G1: Retrying scan after bond failure...")
                        startScan()
                    }, BOND_RETRY_DELAY_MS)
                }
            }
        }
    }

    fun doPendingPairingIdsMatch(): Boolean {
        val leftId = parsePairingIdFromDeviceName(pendingSavedG1LeftName)
        val rightId = parsePairingIdFromDeviceName(pendingSavedG1RightName)
        Bridge.log("G1: LeftID: " + leftId)
        Bridge.log("G1: RightID: " + rightId)

        // ok, HACKY, but if one of them is null, that means that we connected to the
        // other on a previous connect
        // this whole function shouldn't matter anymore anyway as we properly filter for
        // the device name, so it should be fine
        // in the future, the way to actually check this would be to check the final ID
        // string, which is the only one guaranteed to be unique
        if (leftId == null || rightId == null) {
            return true
        }

        return leftId != null && leftId == rightId
    }

    fun parsePairingIdFromDeviceName(input: String?): String? {
        if (input == null || input.isEmpty())
            return null
        // Regular expression to match the number after "G1_"
        val pattern = Pattern.compile("G1_(\\d+)_")
        val matcher = pattern.matcher(input)

        if (matcher.find()) {
            return matcher.group(1) // Group 1 contains the number
        }
        return null // Return null if no match is found
    }

    private fun savePairedDeviceNames() {
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

    private fun loadPairedDeviceNames() {
        // SharedPreferences prefs = context.getSharedPreferences(SHARED_PREFS_NAME,
        // Context.MODE_PRIVATE);
        // savedG1LeftName = prefs.getString(LEFT_DEVICE_KEY, null);
        // savedG1RightName = prefs.getString(RIGHT_DEVICE_KEY, null);
        // Bridge.log("G1: Loaded paired device names: Left=" + savedG1LeftName + ", Right="
        // + savedG1RightName);
    }

    private fun connectToGatt(device: BluetoothDevice?) {
        if (device == null) {
            Bridge.log("G1: Cannot connect to GATT: device is null")
            return
        }

        Bridge.log("G1: connectToGatt called for device: " + device.name + " (" + device.address + ")")
        val bluetoothAdapter = BluetoothAdapter.getDefaultAdapter()
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            Bridge.log("G1: Bluetooth is disabled or not available. Cannot reconnect to glasses.")
            return
        }

        // Reset the services waiter based on device name
        if (device.name.contains("_L_")) {
            Bridge.log("G1: Device identified as left side. Resetting leftServicesWaiter.")
            leftServicesWaiter.setTrue()
        } else {
            Bridge.log("G1: Device identified as right side. Resetting rightServicesWaiter.")
            rightServicesWaiter.setTrue()
        }

        // Establish GATT connection based on device name and current connection state
        if (device.name.contains("_L_") && leftGlassGatt == null) {
            Bridge.log("G1: Connecting GATT to left side.")
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback)
            isLeftConnected = false // Reset connection state
            Bridge.log("G1: Left GATT connection initiated. isLeftConnected set to false.")
        } else if (device.name.contains("_R_") && rightGlassGatt == null && isLeftConnected) {
            Bridge.log("G1: Connecting GATT to right side.")
            rightGlassGatt = device.connectGatt(context, false, rightGattCallback)
            isRightConnected = false // Reset connection state
            Bridge.log("G1: Right GATT connection initiated. isRightConnected set to false.")
        } else {
            Bridge.log("G1: Tried to connect to incorrect or already connected device: " + device.name)
        }
    }

    private fun reconnectToGatt(device: BluetoothDevice) {
        if (isKilled) {
            return
        }
        connectToGatt(device) // Reuse the connectToGatt method
    }

    private val seenDevices: MutableSet<String?> = HashSet()

    private val modernScanCallback: ScanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val name = device.name

            // Now you can reference the bluetoothAdapter field if needed:
            if (!bluetoothAdapter!!.isEnabled()) {
                Bridge.log("G1: Bluetooth is disabled")
                return
            }

            // Check if G1 arm
            if (name == null || !name.contains("Even G1_")) {
                return
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
                val getAliasMethod = device.javaClass.getMethod("getAlias")
                val alias = getAliasMethod.invoke(device) as String?
                // add alias to seen device set:
                if (!seenDevices.contains(alias)) {
                    seenDevices.add(alias)
                } else {
                    return
                }
                Bridge.log("G1: Device Alias: " + alias)
            } catch (e: Exception) {
                Bridge.log("G1: Could not get device alias: " + e.message)
            }

            // Capture manufacturer data for left device during scanning
            if (name != null && name.contains("_L_") && result.scanRecord != null) {
                val allManufacturerData = result.scanRecord!!.manufacturerSpecificData
                for (i in 0 until allManufacturerData.size()) {
                    val parsedDeviceName = parsePairingIdFromDeviceName(name)
                    if (parsedDeviceName != null) {
                        // Bridge.log("G1: Parsed Device Name: " + parsedDeviceName);
                    }

                    val manufacturerId = allManufacturerData.keyAt(i)
                    val data = allManufacturerData.valueAt(i)
                    // Bridge.log("G1: Left Device Manufacturer ID " + manufacturerId + ": " + bytesToHex(data));

                    // Try to decode serial number from this manufacturer data
                    val decodedSerial = decodeSerialFromManufacturerData(data)
                    if (decodedSerial != null) {
                        // Bridge.log("G1: LEFT DEVICE DECODED SERIAL NUMBER from ID " + manufacturerId + ": " + decodedSerial);
                        val decoded = decodeEvenG1SerialNumber(decodedSerial)
                        // Bridge.log("G1: LEFT DEVICE Style: " + decoded[0] + ", Color: " + decoded[1]);

                        if (preferredG1DeviceId != null && preferredG1DeviceId == parsedDeviceName) {
                            // Store the information (matching iOS implementation)
                            DeviceStore.apply("glasses", "serialNumber", decodedSerial)
                            DeviceStore.apply("glasses", "style", decoded[0])
                            DeviceStore.apply("glasses", "color", decoded[1])

                            // Emit the serial number information to React Native
                            emitSerialNumberInfo(decodedSerial, decoded[0], decoded[1])
                        }
                        break
                    }
                }
            }

            // Bridge.log("G1: PREFERRED ID: " + preferredG1DeviceId);
            if (preferredG1DeviceId == null || !name.contains("_" + preferredG1DeviceId + "_")) {
                // Bridge.log("G1: NOT PAIRED GLASSES");
                return
            }

            Bridge.log("G1: FOUND OUR PREFERRED ID: " + preferredG1DeviceId)

            val isLeft = name.contains("_L_")

            // // If we already have saved device names for left/right...
            // if (savedG1LeftName != null && savedG1RightName != null) {
            //     if (!(name.contains(savedG1LeftName) || name.contains(savedG1RightName))) {
            //         return; // Not a matching device
            //     }
            // }

            // Identify which side (left/right) and store both device and name
            if (isLeft) {
                leftDevice = device
                leftDeviceName = name  // Store name now since getName() can return null later
            } else {
                rightDevice = device
                rightDeviceName = name  // Store name now since getName() can return null later
            }

            val bondState = device.bondState
            if (bondState != BluetoothDevice.BOND_BONDED) {
                if (isLeft && !isLeftPairing && !isLeftBonded) {
                    // Stop scan before initiating bond
                    stopScan()
                    // Bridge.log("G1: Bonding with Left Glass...");
                    isLeftPairing = true
                    g1ConnectionState = SmartGlassesConnectionState.BONDING
                    // connectionEvent(g1ConnectionState);
                    bondDevice(device)
                } else if (!isLeft && !isRightPairing && !isRightBonded) {
                    // Stop scan before initiating bond
                    stopScan()
                    Bridge.log("G1: Attempting to bond with right device. isRightPairing=" + isRightPairing
                        + ", isRightBonded=" + isRightBonded)
                    isRightPairing = true
                    g1ConnectionState = SmartGlassesConnectionState.BONDING
                    // connectionEvent(g1ConnectionState);
                    bondDevice(device)
                } else {
                    Bridge.log("G1: Not running bonding - isLeft=" + isLeft + ", isLeftPairing=" + isLeftPairing +
                        ", isLeftBonded=" + isLeftBonded + ", isRightPairing=" + isRightPairing +
                        ", isRightBonded=" + isRightBonded + " - continuing scan for other side")
                }
            } else {
                // Already bonded
                if (isLeft) {
                    isLeftBonded = true
                } else {
                    isRightBonded = true
                }

                // Both are bonded => connect to GATT
                if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
                    Bridge.log("G1: Both sides bonded. Ready to connect to GATT.")
                    stopScan()

                    connectHandler.postDelayed({
                        attemptGattConnection(leftDevice)
                    }, 0L)

                    connectHandler.postDelayed({
                        attemptGattConnection(rightDevice)
                    }, 2000L)
                } else {
                    Bridge.log("G1: Not running a63dd")
                    Bridge.log("G1: leftBonded=" + isLeftBonded + ", rightBonded=" + isRightBonded)
                    Bridge.log("G1: leftDevice=" + leftDevice + ", rightDevice=" + rightDevice)
                }
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Bridge.log("G1: Scan failed with error: " + errorCode)
        }
    }

    private fun resetAllBondsAndState() {
        Bridge.log("G1: Resetting ALL bonds and internal state for complete fresh start")

        // Remove both bonds if devices exist
        if (leftDevice != null) {
            removeBond(leftDevice!!)
        }

        if (rightDevice != null) {
            removeBond(rightDevice!!)
        }

        // Reset all internal state
        isLeftBonded = false
        isRightBonded = false
        isLeftPairing = false
        isRightPairing = false
        isLeftConnected = false
        isRightConnected = false

        // Clear saved device names
        pendingSavedG1LeftName = null
        pendingSavedG1RightName = null

        // Close any existing GATT connections
        if (leftGlassGatt != null) {
            leftGlassGatt!!.disconnect()
            leftGlassGatt!!.close()
            leftGlassGatt = null
        }

        if (rightGlassGatt != null) {
            rightGlassGatt!!.disconnect()
            rightGlassGatt!!.close()
            rightGlassGatt = null
        }

        // Wait briefly for bond removal to complete
        Handler(Looper.getMainLooper()).postDelayed({
            Bridge.log("G1: Restarting scan after complete bond/state reset")
            g1ConnectionState = SmartGlassesConnectionState.SCANNING
            // connectionEvent(g1ConnectionState);
            startScan()
        }, 2000L)
    }

    /**
     * Handles a device with a valid bond
     */
    private fun handleValidBond(device: BluetoothDevice, isLeft: Boolean) {
        Bridge.log("G1: Handling valid bond for " + (if (isLeft) "left" else "right") + " glass")

        // Update state
        if (isLeft) {
            isLeftBonded = true
        } else {
            isRightBonded = true
        }

        // If both glasses are bonded, connect to GATT
        if (leftDevice != null && rightDevice != null && isLeftBonded && isRightBonded) {
            Bridge.log("G1: Both glasses have valid bonds - ready to connect to GATT")

            connectHandler.postDelayed({
                attemptGattConnection(leftDevice)
            }, 0L)

            connectHandler.postDelayed({
                attemptGattConnection(rightDevice)
            }, 2000L)
        } else {
            // Continue scanning for the other glass
            Bridge.log("Still need to find " + (if (isLeft) "right" else "left") + " glass - resuming scan")
            startScan()
        }
    }

    /**
     * Removes an existing bond with a Bluetooth device to force fresh pairing
     */
    private fun removeBond(device: BluetoothDevice?): Boolean {
        try {
            if (device == null) {
                Bridge.log("G1: Cannot remove bond: device is null")
                return false
            }

            val method = device.javaClass.getMethod("removeBond")
            val result = method.invoke(device) as Boolean
            Bridge.log("G1: Removing bond for device " + device.name + ", result: " + result)
            return result
        } catch (e: Exception) {
            Bridge.log("G1: Error removing bond: " + e.message)
            return false
        }
    }

    fun connectToSmartGlasses() {
        // Register bonding receiver
        val filter = IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
        context!!.registerReceiver(bondingReceiver, filter)
        isBondingReceiverRegistered = true

        preferredG1DeviceId = DeviceStore.get("bluetooth", "device_name") as String?

        if (!bluetoothAdapter!!.isEnabled()) {
            return
        }

        // Start scanning for devices
        g1ConnectionState = SmartGlassesConnectionState.SCANNING
        // connectionEvent(g1ConnectionState);
        startScan()
    }

    private fun startScan() {
        val scanner = bluetoothAdapter!!.bluetoothLeScanner
        if (scanner == null) {
            Bridge.log("G1: BluetoothLeScanner not available.")
            return
        }

        // Optionally, define filters if needed
        val filters = ArrayList<ScanFilter>()
        // For example, to filter by device name:
        // filters.add(new ScanFilter.Builder().setDeviceName("Even G1_").build());

        // Set desired scan settings
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        // Start scanning
        isScanning = true
        try {
            scanner.startScan(filters, settings, modernScanCallback)
        } catch (e: SecurityException) {
            // Auto-reconnect paths may fire before BLUETOOTH_SCAN is granted on Android 12+
            Bridge.log("G1: startScan SecurityException — bluetooth permission missing: " + e.message)
            isScanning = false
            g1ConnectionState = SmartGlassesConnectionState.DISCONNECTED
            return
        } catch (e: Exception) {
            Bridge.log("G1: startScan failed: " + e.message)
            isScanning = false
            g1ConnectionState = SmartGlassesConnectionState.DISCONNECTED
            return
        }
        Bridge.log("G1: CALL START SCAN - Started scanning for devices...")

        // Ensure scanning state is immediately communicated to UI
        g1ConnectionState = SmartGlassesConnectionState.SCANNING
        // connectionEvent(g1ConnectionState);

        // Stop the scan after some time (e.g., 10-15s instead of 60 to avoid
        // throttling)
        // handler.postDelayed(() -> stopScan(), 10000);
    }

    override fun stopScan() {
        val scanner = bluetoothAdapter!!.bluetoothLeScanner
        if (scanner != null) {
            scanner.stopScan(modernScanCallback)
        }
        isScanning = false
        Bridge.log("G1: Stopped scanning for devices")
    }

    private fun bondDevice(device: BluetoothDevice) {
        try {
            Bridge.log("G1: Attempting to bond with device: " + device.name)
            val method = device.javaClass.getMethod("createBond")
            method.invoke(device)
        } catch (e: Exception) {
            Bridge.log("G1: Bonding failed: " + e.message)
        }
    }

    private var rightConnectionRetryRunnable: Runnable? = null

    private fun attemptGattConnection(device: BluetoothDevice?) {
        // if (!isKilled)

        if (device == null) {
            Bridge.log("G1: Cannot connect to GATT: Device is null")
            return
        }

        val deviceName = device.name
        if (deviceName == null) {
            Bridge.log("G1: Skipping null device name: " + device.address
                + "... this means something horriffic has occured. Look into this.")
            return
        }

        Bridge.log("G1: attemptGattConnection called for device: " + deviceName + " (" + device.address + ")")

        // Check if both devices are bonded before attempting connection
        if (!isLeftBonded || !isRightBonded) {
            Bridge.log("G1: Cannot connect to GATT: Both devices are not bonded yet (isLeftBonded: " + isLeftBonded
                + ", isRightBonded: " + isRightBonded + ")")
            return
        }

        g1ConnectionState = SmartGlassesConnectionState.CONNECTING
        Bridge.log("G1: Setting g1ConnectionState to CONNECTING. Notifying connectionEvent.")
        // connectionEvent(g1ConnectionState);

        val isLeftDevice = deviceName.contains("_L_")
        val isRightDevice = deviceName.contains("_R_")

        if (isLeftDevice) {
            connectLeftDevice(device)
        } else if (isRightDevice) {
            connectRightDevice(device)
        } else {
            Bridge.log("G1: Unknown device type: " + deviceName)
        }
    }

    private fun connectLeftDevice(device: BluetoothDevice) {
        if (leftGlassGatt == null) {
            Bridge.log("G1: Attempting GATT connection for Left Glass...")
            leftGlassGatt = device.connectGatt(context, false, leftGattCallback)
            isLeftConnected = false
            Bridge.log("G1: Left GATT connection initiated. isLeftConnected set to false.")
        } else {
            Bridge.log("G1: Left Glass GATT already exists")
        }
    }

    private fun connectRightDevice(device: BluetoothDevice) {
        // Only connect right after left is fully connected
        if (isLeftConnected) {
            if (rightGlassGatt == null) {
                Bridge.log("G1: Attempting GATT connection for Right Glass...")
                rightGlassGatt = device.connectGatt(context, false, rightGattCallback)
                isRightConnected = false
                Bridge.log("G1: Right GATT connection initiated. isRightConnected set to false.")

                // Cancel any pending retry attempts since we're now connecting
                if (rightConnectionRetryRunnable != null) {
                    connectHandler.removeCallbacks(rightConnectionRetryRunnable!!)
                    rightConnectionRetryRunnable = null
                }
            } else {
                Bridge.log("G1: Right Glass GATT already exists")
            }
        } else {
            Bridge.log("G1: Waiting for left glass before connecting right. Scheduling retry in "
                + RIGHT_CONNECTION_RETRY_DELAY + "ms")

            // Cancel any existing retry attempts to avoid duplicate retries
            if (rightConnectionRetryRunnable != null) {
                connectHandler.removeCallbacks(rightConnectionRetryRunnable!!)
            }

            // Create new retry runnable
            rightConnectionRetryRunnable = Runnable {
                if (!isKilled) {
                    Bridge.log("G1: Retrying right glass connection...")
                    attemptGattConnection(device)
                } else {
                    Bridge.log("G1: Connection cancelled, stopping retry attempts")
                }
            }

            // Schedule retry
            connectHandler.postDelayed(rightConnectionRetryRunnable!!, RIGHT_CONNECTION_RETRY_DELAY)
        }
    }

    private fun createTextPackage(text: String, currentPage: Int, totalPages: Int, screenStatus: Int): ByteArray {
        val textBytes = text.toByteArray()
        val buffer = ByteBuffer.allocate(9 + textBytes.size)
        buffer.put(0x4E.toByte())
        buffer.put((currentSeq++ and 0xFF).toByte())
        buffer.put(1.toByte())
        buffer.put(0.toByte())
        buffer.put(screenStatus.toByte())
        buffer.put(0.toByte())
        buffer.put(0.toByte())
        buffer.put(currentPage.toByte())
        buffer.put(totalPages.toByte())
        buffer.put(textBytes)

        return buffer.array()
    }

    private fun sendDataSequentially(data: ByteArray) {
        sendDataSequentially(data, false)
    }

    private fun sendDataSequentially(data: List<ByteArray>) {
        sendDataSequentially(data, false)
    }

    fun sendJson(jsonOriginal: Map<String, Any>, wakeUp: Boolean) {

    }

    override fun requestPhoto(request: PhotoRequest) {

    }

    override fun startStream(message: MutableMap<String, Any>) {

    }

    override fun stopStream() {

    }

    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {

    }

    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {

    }

    override fun stopVideoRecording(requestId: String) {

    }

    override fun sendButtonPhotoSettings() {

    }

    override fun sendButtonVideoRecordingSettings() {

    }

    override fun sendCameraFovSetting() {
    }

    override fun sendButtonMaxRecordingTime() {

    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        Bridge.log("G1: setBrightness() - level: " + level + "%, autoMode: " + autoMode)
        sendBrightnessCommand(level, autoMode)
    }

    override fun clearDisplay() {
        Bridge.log("G1: clearDisplay() - sending space")
        // Bypass the throttle (a clear must always land) and drop any pending caption so it can't
        // overwrite the clear after the fact.
        cancelPendingThrottledText()
        displayTextWall(" ")
    }

    // G1-specific display throttle (300ms, last-wins) — see G1.swift. G1 firmware can't absorb
    // rapid text-wall updates; coalesce to the latest within a 300ms window. Belongs in the G1 SGC
    // (G1 hardware quirk); G2 deliberately does NOT throttle (it must show every caption). The
    // trailing flush always sends the most recent text, so the final caption is never dropped —
    // only intermediate frames within a window are coalesced.
    private val textThrottleHandler = Handler(Looper.getMainLooper())
    private var textThrottlePending: String? = null
    private var textThrottleLastSent: Long = 0L
    private var textThrottleScheduled = false
    private val TEXT_THROTTLE_WINDOW_MS = 300L

    /** Drop any pending throttled text-wall flush so it can't later overwrite a newer, non-text
     *  display write (a clear, double-text-wall, or bitmap). The posted flush no-ops when
     *  `textThrottlePending` is null. Called from every G1 display path that bypasses the throttle. */
    private fun cancelPendingThrottledText() {
        textThrottlePending = null
    }

    private fun throttledTextWall(text: String) {
        val now = android.os.SystemClock.uptimeMillis()
        val sinceLast = now - textThrottleLastSent
        if (sinceLast >= TEXT_THROTTLE_WINDOW_MS) {
            // Past the window — send now.
            textThrottleLastSent = now
            textThrottlePending = null
            displayTextWall(text)
        } else {
            // Inside the window — keep only the latest and schedule one trailing flush.
            textThrottlePending = text
            if (!textThrottleScheduled) {
                textThrottleScheduled = true
                textThrottleHandler.postDelayed({
                    textThrottleScheduled = false
                    val pending = textThrottlePending ?: return@postDelayed
                    textThrottlePending = null
                    textThrottleLastSent = android.os.SystemClock.uptimeMillis()
                    displayTextWall(pending)
                }, TEXT_THROTTLE_WINDOW_MS - sinceLast)
            }
        }
    }

    override fun sendText(text: String) {
        Bridge.log("G1: sendText() - text: " + text)
        throttledTextWall(text)
    }

    override fun sendTextWall(text: String) {
        // Bridge.log("G1: sendTextWall() - text: " + text);
        throttledTextWall(text)
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        cancelPendingThrottledText() // a newer layout supersedes any pending caption text
        Bridge.log("G1: sendDoubleTextWall() - top: " + top + ", bottom: " + bottom)
        displayDoubleTextWall(top, bottom)
    }

    override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?): Boolean {
        cancelPendingThrottledText() // a bitmap supersedes any pending caption text
        try {
            // Decode base64 to byte array
            val bmpData = android.util.Base64.decode(base64ImageData, android.util.Base64.DEFAULT)

            if (bmpData == null || bmpData.isEmpty()) {
                Log.e(TAG, "Failed to decode base64 image data")
                return false
            }

            // Call internal implementation
            displayBitmapImage(bmpData)
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Error displaying bitmap from base64", e)
            return false
        }
    }

    override fun showDashboard() {
        exit()
    }

    override fun ping() {
        Bridge.log("G1: ping()")
    }

    override fun dbg1() {
    }

    override fun dbg2() {
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("G1: setDashboardPosition() - height: " + height + ", depth: " + depth)
        sendDashboardPositionCommand(height, depth)
    }

    override fun setHeadUpAngle(angle: Int) {
        Bridge.log("G1: setHeadUpAngle() - angle: " + angle)
        sendHeadUpAngleCommand(angle)
    }

    override fun getBatteryStatus() {
        Bridge.log("G1: Requesting battery status")
        queryBatteryStatus()
    }

    override fun setSilentMode(enabled: Boolean) {

    }

    override fun exit() {
        sendExitCommand()
    }

    override fun sendShutdown() {
        Bridge.log("sendShutdown - not supported on G1")
    }

    override fun sendReboot() {
        Bridge.log("sendReboot - not supported on G1")
    }

    override fun sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        Bridge.log("sendRgbLedControl - not supported on G1")
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported")
    }

    override fun disconnect() {
        DeviceStore.apply("glasses", "fullyBooted", false)
        destroy()
    }

    override fun forget() {
        DeviceStore.apply("glasses", "fullyBooted", false)
        destroy()
    }

    override fun connectById(id: String) {
        preferredG1DeviceId = id
        connectToSmartGlasses()
    }

    override fun getConnectedBluetoothName(): String {
        // Return left device name if available, otherwise right device name
        if (leftDevice != null && leftDevice!!.name != null) {
            return leftDevice!!.name
        } else if (rightDevice != null && rightDevice!!.name != null) {
            return rightDevice!!.name
        }
        return ""
    }

    override fun requestWifiScan(scanId: String?) {

    }

    override fun sendWifiCredentials(ssid: String, password: String) {

    }

    override fun forgetWifiNetwork(ssid: String) {
        // G1 doesn't support WiFi
    }

    override fun sendHotspotState(enabled: Boolean) {
        // G1 doesn't support hotspot
    }

    override fun sendUserEmailToGlasses(email: String) {
        // G1 doesn't support user email (no ASG client)
    }

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {
        // G1 doesn't support incident reporting (no ASG client)
    }

    override fun queryGalleryStatus() {

    }

    override fun sendGalleryMode() {
        // G1 doesn't have a built-in camera/gallery system
        Bridge.log("G1: sendGalleryModeActive - not supported on G1")
    }

    override fun requestVersionInfo() {
        // G1 doesn't support version info requests
        Bridge.log("G1: requestVersionInfo - not supported on G1")
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
    private class SendRequest {
        val data: ByteArray
        val onlyLeft: Boolean
        val onlyRight: Boolean
        var waitTime = -1

        constructor(data: ByteArray, onlyLeft: Boolean, onlyRight: Boolean) {
            this.data = data
            this.onlyLeft = onlyLeft
            this.onlyRight = onlyRight
        }

        constructor(data: ByteArray, onlyLeft: Boolean, onlyRight: Boolean, waitTime: Int) {
            this.data = data
            this.onlyLeft = onlyLeft
            this.onlyRight = onlyRight
            this.waitTime = waitTime
        }
    }

    // Queue to hold pending requests
    private val sendQueue: BlockingQueue<Array<SendRequest?>> = LinkedBlockingQueue()

    @Volatile private var isWorkerRunning = false

    // Non-blocking function to add new send request
    private fun sendDataSequentially(data: ByteArray, onlyLeft: Boolean) {
        val chunks = arrayOf<SendRequest?>(SendRequest(data, onlyLeft, false))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    // Non-blocking function to add new send request
    private fun sendDataSequentially(data: ByteArray, onlyLeft: Boolean, waitTime: Int) {
        val chunks = arrayOf<SendRequest?>(SendRequest(data, onlyLeft, false, waitTime))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    // Overloaded function to handle multiple chunks (List<byte[]>)
    private fun sendDataSequentially(data: List<ByteArray>, onlyLeft: Boolean) {
        sendDataSequentially(data, onlyLeft, false)
    }

    private fun sendDataSequentially(data: ByteArray, onlyLeft: Boolean, onlyRight: Boolean) {
        val chunks = arrayOf<SendRequest?>(SendRequest(data, onlyLeft, onlyRight))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    private fun sendDataSequentially(data: ByteArray, onlyLeft: Boolean, onlyRight: Boolean, waitTime: Int) {
        val chunks = arrayOf<SendRequest?>(SendRequest(data, onlyLeft, onlyRight, waitTime))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    private fun sendDataSequentially(data: List<ByteArray>, onlyLeft: Boolean, onlyRight: Boolean) {
        val chunks = arrayOfNulls<SendRequest>(data.size)
        for (i in 0 until data.size) {
            chunks[i] = SendRequest(data[i], onlyLeft, onlyRight)
        }
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    // Start the worker thread if it's not already running
    @Synchronized
    private fun startWorkerIfNeeded() {
        if (!isWorkerRunning) {
            isWorkerRunning = true
            Thread(this::processQueue, "EvenRealitiesG1SGCProcessQueue").start()
        }
    }

    // Fast send method for bitmap chunks - doesn't wait for write confirmation
    private fun sendBitmapChunkNoWait(data: ByteArray?, sendLeft: Boolean, sendRight: Boolean) {
        if (data == null || data.isEmpty())
            return

        // IMPORTANT: Set write type to NO_RESPONSE for fire-and-forget behavior
        // This prevents waiting for BLE acknowledgments

        // Send to right glass without waiting
        if (sendRight && rightGlassGatt != null && rightTxChar != null && isRightConnected) {
            rightTxChar!!.value = data
            rightTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            rightGlassGatt!!.writeCharacteristic(rightTxChar)
            // Restore default write type
            rightTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }

        // Send to left glass without waiting
        if (sendLeft && leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
            leftTxChar!!.value = data
            leftTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            leftGlassGatt!!.writeCharacteristic(leftTxChar)
            // Restore default write type
            leftTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
    }

    class BooleanWaiter {
        private var flag = true // initially true

        @Synchronized
        @Throws(InterruptedException::class)
        fun waitWhileTrue() {
            while (flag) {
                (this as java.lang.Object).wait()
            }
        }

        @Synchronized
        fun setTrue() {
            flag = true
        }

        @Synchronized
        fun setFalse() {
            flag = false
            (this as java.lang.Object).notifyAll()
        }
    }

    private val leftWaiter = BooleanWaiter()
    private val rightWaiter = BooleanWaiter()
    private val leftServicesWaiter = BooleanWaiter()
    private val rightServicesWaiter = BooleanWaiter()

    private fun processQueue() {
        // First wait until the services are setup and ready to receive data
        Bridge.log("G1: PROC_QUEUE - waiting on services waiters")
        try {
            leftServicesWaiter.waitWhileTrue()
            rightServicesWaiter.waitWhileTrue()
        } catch (e: InterruptedException) {
            Bridge.log("G1: Interrupted waiting for descriptor writes: " + e.toString())
        }
        Bridge.log("G1: PROC_QUEUE - DONE waiting on services waiters")

        while (!isKilled) {
            try {
                // Make sure services are ready before processing requests
                leftServicesWaiter.waitWhileTrue()
                rightServicesWaiter.waitWhileTrue()

                // This will block until data is available - no CPU spinning!
                val requests = sendQueue.take()

                for (request in requests) {
                    if (request == null) {
                        isWorkerRunning = false
                        break
                    }

                    try {
                        // Force an initial delay so BLE gets all setup
                        val timeSinceConnection = System.currentTimeMillis() - lastConnectionTimestamp
                        if (timeSinceConnection < INITIAL_CONNECTION_DELAY_MS) {
                            Thread.sleep(INITIAL_CONNECTION_DELAY_MS - timeSinceConnection)
                        }

                        var leftSuccess = true
                        var rightSuccess = true

                        // Start both writes without waiting
                        var leftStarted = false
                        var rightStarted = false

                        // Start right glass write (non-blocking)
                        if (!request.onlyLeft && rightGlassGatt != null && rightTxChar != null && isRightConnected) {
                            rightWaiter.setTrue()
                            rightTxChar!!.value = request.data
                            rightSuccess = rightGlassGatt!!.writeCharacteristic(rightTxChar)
                            if (rightSuccess) {
                                rightStarted = true
                                lastSendTimestamp = System.currentTimeMillis()
                            }
                        }

                        // Start left glass write immediately (non-blocking)
                        if (!request.onlyRight && leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
                            leftWaiter.setTrue()
                            leftTxChar!!.value = request.data
                            leftSuccess = leftGlassGatt!!.writeCharacteristic(leftTxChar)
                            if (leftSuccess) {
                                leftStarted = true
                                lastSendTimestamp = System.currentTimeMillis()
                            }
                        }

                        // Now wait for both to complete
                        if (rightStarted) {
                            rightWaiter.waitWhileTrue()
                        }
                        if (leftStarted) {
                            leftWaiter.waitWhileTrue()
                        }

                        Thread.sleep(DELAY_BETWEEN_CHUNKS_SEND)

                        // If the packet asked us to do a delay, then do it
                        if (request.waitTime != -1) {
                            Thread.sleep(request.waitTime.toLong())
                        }
                    } catch (e: InterruptedException) {
                        Bridge.log("G1: Error sending data: " + e.message)
                        if (isKilled)
                            break
                    }
                }
            } catch (e: InterruptedException) {
                if (isKilled) {
                    Bridge.log("G1: Process queue thread interrupted - shutting down")
                    break
                }
                Bridge.log("G1: Error in queue processing: " + e.message)
            }
        }

        Bridge.log("G1: Process queue thread exiting")
    }

    // @Override
    // public void displayReferenceCardSimple(String title, String body, int
    // lingerTimeMs) {
    // displayReferenceCardSimple(title, body, lingerTimeMs);
    // }

    private fun createNotificationJson(appIdentifier: String, title: String, subtitle: String, message: String): String {
        val currentTime = System.currentTimeMillis() / 1000L // Unix timestamp in seconds
        val currentDate = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(java.util.Date()) // Date
        // format
        // for
        // 'date'
        // field

        val ncsNotification = NCSNotification(
            notificationNum++, // Increment sequence ID for uniqueness
            1, // type (e.g., 1 = notification type)
            appIdentifier,
            title,
            subtitle,
            message,
            currentTime.toInt(), // Cast long to int to match Python
            currentDate, // Add the current date to the notification
            "AugmentOS" // display_name
        )

        val notification = Notification(ncsNotification, "Add")

        val gson = Gson()
        return gson.toJson(notification)
    }

    internal class Notification {
        var ncs_notification: NCSNotification? = null
        var type: String? = null

        constructor() {
            // Default constructor
        }

        constructor(ncs_notification: NCSNotification?, type: String?) {
            this.ncs_notification = ncs_notification
            this.type = type
        }
    }

    internal class NCSNotification(
        var msg_id: Int,
        var type: Int,
        var app_identifier: String,
        var title: String,
        var subtitle: String,
        var message: String,
        var time_s: Int, // Changed from long to int for consistency
        var date: String, // Added to match Python's date field
        var display_name: String
    )

    private fun createNotificationChunks(json: String): List<ByteArray> {
        val MAX_CHUNK_SIZE = 176 // 180 - 4 header bytes
        val jsonBytes = json.toByteArray(StandardCharsets.UTF_8)
        val totalChunks = Math.ceil(jsonBytes.size.toDouble() / MAX_CHUNK_SIZE).toInt()

        val chunks = ArrayList<ByteArray>()
        for (i in 0 until totalChunks) {
            val start = i * MAX_CHUNK_SIZE
            val end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.size)
            val payloadChunk = Arrays.copyOfRange(jsonBytes, start, end)

            // Create the header
            val header = byteArrayOf(
                NOTIFICATION.toByte(),
                0x00, // notify_id (can be updated as needed)
                totalChunks.toByte(),
                i.toByte()
            )

            // Combine header and payload
            val chunk = ByteBuffer.allocate(header.size + payloadChunk.size)
            chunk.put(header)
            chunk.put(payloadChunk)

            chunks.add(chunk.array())
        }

        return chunks
    }

    fun displayReferenceCardSimple(title: String, body: String) {
        if (!isConnected()) {
            Bridge.log("G1: Not connected to glasses")
            return
        }

        if (title.trim().isEmpty() && body.trim().isEmpty()) {
            if (DeviceManager.getInstance().powerSavingMode) {
                sendExitCommand()
                return
            }
        }

        val chunks = createTextWallChunks(title + "\n\n" + body)
        for (i in 0 until chunks.size) {
            val chunk = chunks[i]
            val isLastChunk = (i == chunks.size - 1)

            if (isLastChunk) {
                sendDataSequentially(chunk, false)
            } else {
                sendDataSequentially(chunk, false, 300)
            }
        }
        Bridge.log("G1: Send simple reference card")
    }

    fun destroy() {
        Bridge.log("G1: EvenRealitiesG1SGC ONDESTROY")
        showHomeScreen()
        isKilled = true
        DeviceStore.apply("glasses", "fullyBooted", false)

        // Reset battery levels
        batteryLeft = -1
        batteryRight = -1
        DeviceStore.apply("glasses", "batteryLevel", -1)

        // stop BLE scanning
        stopScan()

        // Shutdown bitmap executor
        if (bitmapExecutor != null) {
            bitmapExecutor!!.shutdown()
            try {
                if (!bitmapExecutor!!.awaitTermination(1, TimeUnit.SECONDS)) {
                    bitmapExecutor!!.shutdownNow()
                }
            } catch (e: InterruptedException) {
                bitmapExecutor!!.shutdownNow()
            }
        }

        if (bondingReceiver != null && isBondingReceiverRegistered) {
            context!!.unregisterReceiver(bondingReceiver)
            isBondingReceiverRegistered = false
        }

        if (rightConnectionRetryRunnable != null) {
            connectHandler.removeCallbacks(rightConnectionRetryRunnable!!)
            rightConnectionRetryRunnable = null
        }

        // disable the microphone
        sendSetMicEnabled(false, 0)

        // stop sending heartbeat
        stopHeartbeat()

        // stop sending micbeat
        stopMicBeat()

        // Stop periodic notifications
        stopPeriodicNotifications()

        // Stop periodic text wall
        // stopPeriodicNotifications();

        if (leftGlassGatt != null) {
            leftGlassGatt!!.disconnect()
            leftGlassGatt!!.close()
            leftGlassGatt = null
        }
        if (rightGlassGatt != null) {
            rightGlassGatt!!.disconnect()
            rightGlassGatt!!.close()
            rightGlassGatt = null
        }

        if (handler != null)
            handler.removeCallbacksAndMessages(null)
        if (heartbeatHandler != null && heartbeatRunnable != null)
            heartbeatHandler.removeCallbacks(heartbeatRunnable!!)
        if (whiteListHandler != null)
            whiteListHandler.removeCallbacksAndMessages(null)
        if (micEnableHandler != null)
            micEnableHandler.removeCallbacksAndMessages(null)
        if (notificationHandler != null && notificationRunnable != null)
            notificationHandler.removeCallbacks(notificationRunnable!!)
        if (textWallHandler != null && textWallRunnable != null)
            textWallHandler.removeCallbacks(textWallRunnable!!)
        // if (goHomeHandler != null)
        // goHomeHandler.removeCallbacks(goHomeRunnable);
        if (findCompatibleDevicesHandler != null)
            findCompatibleDevicesHandler!!.removeCallbacksAndMessages(null)
        if (connectHandler != null)
            connectHandler.removeCallbacksAndMessages(null)
        if (retryBondHandler != null)
            retryBondHandler!!.removeCallbacksAndMessages(null)
        if (characteristicHandler != null) {
            characteristicHandler.removeCallbacksAndMessages(null)
        }
        if (reconnectHandler != null) {
            reconnectHandler.removeCallbacksAndMessages(null)
        }
        if (leftConnectionTimeoutHandler != null && leftConnectionTimeoutRunnable != null) {
            leftConnectionTimeoutHandler.removeCallbacks(leftConnectionTimeoutRunnable!!)
        }
        if (rightConnectionTimeoutHandler != null && rightConnectionTimeoutRunnable != null) {
            rightConnectionTimeoutHandler.removeCallbacks(rightConnectionTimeoutRunnable!!)
        }
        if (reconnectHandler != null) {
            reconnectHandler.removeCallbacksAndMessages(null)
        }
        if (queryBatteryStatusHandler != null && queryBatteryStatusHandler != null) {
            queryBatteryStatusHandler.removeCallbacksAndMessages(null)
        }

        // free LC3 decoder
        if (lc3DecoderPtr != 0L) {
            Lc3Cpp.freeDecoder(lc3DecoderPtr)
            lc3DecoderPtr = 0
        }

        sendQueue.clear()

        // Add a dummy element to unblock the take() call if needed
        sendQueue.offer(arrayOfNulls<SendRequest>(0)) // is this needed?

        isWorkerRunning = false

        isLeftConnected = false
        isRightConnected = false

        // Clear device references and stored names
        leftDevice = null
        rightDevice = null
        leftDeviceName = null
        rightDeviceName = null

        Bridge.log("G1: EvenRealitiesG1SGC cleanup complete")
    }

    fun isConnected(): Boolean {
        return g1ConnectionState == SmartGlassesConnectionState.CONNECTED
    }

    // Remaining methods
    fun showNaturalLanguageCommandScreen(prompt: String, naturalLanguageInput: String) {
    }

    fun updateNaturalLanguageCommandScreen(naturalLanguageArgs: String) {
    }

    fun scrollingTextViewIntermediateText(text: String) {
    }

    fun scrollingTextViewFinalText(text: String) {
    }

    fun stopScrollingTextViewMode() {
    }

    fun displayPromptView(title: String, options: Array<String>) {
    }

    fun displayTextLine(text: String) {
    }

    fun displayBitmap(bmp: Bitmap) {
        try {
            val bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false)
            displayBitmapImage(bmpBytes)
        } catch (e: Exception) {
            Log.e(TAG, e.message!!)
        }
    }

    /**
     * Convert arbitrary image data (PNG/JPEG bytes) to G1-compatible 1-bit BMP format.
     * Mirrors G2.convertToG2Bmp() for local miniapp bitmap display support.
     *
     * @param imageData Raw image bytes (PNG, JPEG, etc.)
     * @return 1-bit BMP byte array, or null on failure
     */
    fun convertToG1Bmp(imageData: ByteArray): ByteArray? {
        try {
            val bmp = BitmapFactory.decodeByteArray(imageData, 0, imageData.size)
            if (bmp == null) {
                Bridge.log("G1: convertToG1Bmp - could not decode image data")
                return null
            }
            val bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false)
            bmp.recycle()
            Bridge.log("G1: convertToG1Bmp - produced " + bmpBytes.size + " byte BMP")
            return bmpBytes
        } catch (e: Exception) {
            Log.e(TAG, "G1: convertToG1Bmp error: " + e.message)
            return null
        }
    }

    fun blankScreen() {
    }

    /**
     * Display pre-composed double text wall (two columns) on the glasses.
     *
     * NOTE: DisplayProcessor now composes double_text_wall into a single text_wall
     * with pixel-precise column alignment using ColumnComposer. This method may
     * not be called anymore for new flows, but is kept for backwards compatibility.
     *
     * Column composition is handled by DisplayProcessor in React Native.
     * This method is a "dumb pipe" - it just combines and sends the text.
     */
    fun displayDoubleTextWall(textTop: String, textBottom: String) {
        // Text is already composed by DisplayProcessor's ColumnComposer
        // Just combine and send as a text wall - no custom wrapping logic needed
        val combinedText = textTop + "\n" + textBottom
        displayTextWall(combinedText)
    }

    fun showHomeScreen() {
        displayTextWall(" ")

        // if (lastThingDisplayedWasAnImage) {
        //     // clearG1Screen();
        //     lastThingDisplayedWasAnImage = false;
        // }
    }

    fun clearG1Screen() {
        Bridge.log("G1: Clearing G1 screen")
        val exitCommand = byteArrayOf(0x18.toByte())
        // sendDataSequentially(exitCommand, false);
        val theClearBitmapOrSomething = loadEmptyBmpFromAssets()
        val bmp = BitmapJavaUtils.bytesToBitmap(theClearBitmapOrSomething)
        try {
            val bmpBytes = convertBitmapTo1BitBmpBytes(bmp, false)
            displayBitmapImage(bmpBytes)
        } catch (e: Exception) {
            Log.e(TAG, "Error displaying clear bitmap: " + e.message)
        }
    }


    fun displayRowsCard(rowStrings: Array<String>) {
    }

    fun displayBulletList(title: String, bullets: Array<String>) {
    }

    fun displayReferenceCardImage(title: String, body: String, imgUrl: String) {
    }

    fun displayTextWall(a: String) {
        val chunks = createTextWallChunks(a)
        sendChunks(chunks)
    }

    fun setUpdatingScreen(updatingScreen: Boolean) {
        this.updatingScreen = updatingScreen
    }

    fun setFontSizes() {
    }

    // Heartbeat methods
    private fun constructHeartbeat(): ByteArray {
        val buffer = ByteBuffer.allocate(6)
        buffer.put(0x25.toByte())
        buffer.put(6.toByte())
        buffer.put((currentSeq and 0xFF).toByte())
        buffer.put(0x00.toByte())
        buffer.put(0x04.toByte())
        buffer.put((currentSeq++ and 0xFF).toByte())
        return buffer.array()
    }

    private fun constructBatteryLevelQuery(): ByteArray {
        val buffer = ByteBuffer.allocate(2)
        buffer.put(0x2C.toByte()) // Command
        buffer.put(0x01.toByte()) // use 0x02 for iOS
        return buffer.array()
    }

    private fun startHeartbeat(delay: Int) {
        Bridge.log("G1: Starting heartbeat")
        if (heartbeatCount > 0)
            stopHeartbeat()

        heartbeatRunnable = object : Runnable {
            override fun run() {
                sendHeartbeat()
                // sendLoremIpsum();

                // quickRestartG1();

                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }

        heartbeatHandler.postDelayed(heartbeatRunnable!!, delay.toLong())
    }

    // periodically send a mic ON request so it never turns off
    private fun startMicBeat(delay: Int) {
        Bridge.log("G1: Starting micbeat")
        if (micBeatCount > 0)
            stopMicBeat()
        sendSetMicEnabled(true, 10)

        micBeatRunnable = object : Runnable {
            override fun run() {
                Bridge.log("G1: SENDING MIC BEAT")
                sendSetMicEnabled(shouldUseGlassesMic, 1)
                micBeatHandler.postDelayed(this, MICBEAT_INTERVAL_MS)
            }
        }

        micBeatHandler.postDelayed(micBeatRunnable!!, delay.toLong())
    }

    override fun findCompatibleDevices() {
        Bridge.log("G1: findCompatibleDevices called")
        if (isScanningForCompatibleDevices) {
            Bridge.log("G1: Scan already in progress, skipping...")
            return
        }
        isScanningForCompatibleDevices = true

        val scanner = bluetoothAdapter!!.bluetoothLeScanner
        if (scanner == null) {
            Log.e(TAG, "BluetoothLeScanner not available")
            isScanningForCompatibleDevices = false
            return
        }

        val foundDeviceNames = ArrayList<String>()
        if (findCompatibleDevicesHandler == null) {
            findCompatibleDevicesHandler = Handler(Looper.getMainLooper())
        }

        // Optional: add filters if you want to narrow the scan
        val filters = ArrayList<ScanFilter>()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .build()

        // Create a modern ScanCallback instead of the deprecated LeScanCallback
        val bleScanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                val name = device.name
                if (name != null && name.contains("Even G1_") && name.contains("_L_")) {
                    synchronized(foundDeviceNames) {
                        if (!foundDeviceNames.contains(name)) {
                            foundDeviceNames.add(name)
                            Bridge.log("Found smart glasses: " + name)
                            var adjustedName = parsePairingIdFromDeviceName(name)
                            // If parsing failed, use the full name as fallback
                            if (adjustedName == null) {
                                adjustedName = name
                                Bridge.log("G1: Failed to parse device ID from name: " + name)
                            }
                            Bridge.sendDiscoveredDevice("Even Realities G1", adjustedName)
                        }
                    }
                }
            }

            override fun onBatchScanResults(results: List<ScanResult>) {
                // If needed, handle batch results here
            }

            override fun onScanFailed(errorCode: Int) {
                Log.e(TAG, "BLE scan failed with code: " + errorCode)
            }
        }

        // Start scanning
        try {
            scanner.startScan(filters, settings, bleScanCallback)
        } catch (e: SecurityException) {
            Bridge.log("G1: findCompatibleDevices startScan SecurityException — bluetooth permission missing: " + e.message)
            isScanningForCompatibleDevices = false
            return
        } catch (e: Exception) {
            Bridge.log("G1: findCompatibleDevices startScan failed: " + e.message)
            isScanningForCompatibleDevices = false
            return
        }
        Bridge.log("G1: Started scanning for smart glasses with BluetoothLeScanner...")

        // Stop scanning after 10 seconds (adjust as needed)
        findCompatibleDevicesHandler!!.postDelayed({
            scanner.stopScan(bleScanCallback)
            isScanningForCompatibleDevices = false
            Bridge.log("G1: Stopped scanning for smart glasses.")
            // EventBus.getDefault().post(
            // new GlassesBluetoothSearchStopEvent(
            // smartGlassesDevice.deviceModelName
            // )
            // );
        }, 10000L)
    }

    private fun sendWhiteListCommand(delay: Int) {
        if (whiteListedAlready) {
            return
        }
        whiteListedAlready = true

        Bridge.log("G1: Sending whitelist command")
        whiteListHandler.postDelayed({
            val chunks = getWhitelistChunks()
            sendDataSequentially(chunks, false)
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
        }, delay.toLong())
    }

    private fun stopHeartbeat() {
        Bridge.log("G1: stopHeartbeat()")
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacksAndMessages(null)
            heartbeatHandler.removeCallbacksAndMessages(heartbeatRunnable)
            heartbeatCount = 0
        }
    }

    private fun stopMicBeat() {
        Bridge.log("G1: stopMicBeat()")
        sendSetMicEnabled(false, 10)
        if (micBeatHandler != null) {
            micBeatHandler.removeCallbacksAndMessages(null)
            micBeatHandler.removeCallbacksAndMessages(micBeatRunnable)
            micBeatRunnable = null
            micBeatCount = 0
        }
    }

    private fun sendHeartbeat() {
        val heartbeatPacket = constructHeartbeat()
        // Bridge.log("G1: Sending heartbeat: " + bytesToHex(heartbeatPacket));

        sendDataSequentially(heartbeatPacket, false, 100)

        if (batteryLeft == -1 || batteryRight == -1 || heartbeatCount % 10 == 0) {
            queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500L)
        }
        // queryBatteryStatusHandler.postDelayed(this::queryBatteryStatus, 500);

        heartbeatCount++
    }

    private fun queryBatteryStatus() {
        val batteryQueryPacket = constructBatteryLevelQuery()
        // Bridge.log("G1: Sending battery status query: " +
        // bytesToHex(batteryQueryPacket));

        sendDataSequentially(batteryQueryPacket, false, 250)
    }

    fun sendBrightnessCommand(brightness: Int, autoLight: Boolean) {
        // Validate brightness range

        val validBrightness: Int
        if (brightness != -1) {
            validBrightness = (brightness * 63) / 100
        } else {
            validBrightness = (30 * 63) / 100
        }

        // Construct the command
        val buffer = ByteBuffer.allocate(3)
        buffer.put(0x01.toByte()) // Command
        buffer.put(validBrightness.toByte()) // Brightness level (0~63)
        buffer.put((if (autoLight) 1 else 0).toByte()) // Auto light (0 = close, 1 = open)

        sendDataSequentially(buffer.array(), false, 100)

        Bridge.log("G1: Sent auto light brightness command => Brightness: " + brightness + ", Auto Light: "
            + (if (autoLight) "Open" else "Close"))

        // send to AugmentOS core
        // if (autoLight) {
        // EventBus.getDefault().post(new BrightnessLevelEvent(autoLight));
        // } else {
        // EventBus.getDefault().post(new BrightnessLevelEvent(brightness));
        // }
    }

    fun sendHeadUpAngleCommand(headUpAngle: Int) {
        // Validate headUpAngle range (0 ~ 60)
        var headUpAngleValue = headUpAngle
        if (headUpAngleValue < 0) {
            headUpAngleValue = 0
        } else if (headUpAngleValue > 60) {
            headUpAngleValue = 60
        }

        // Construct the command
        val buffer = ByteBuffer.allocate(3)
        buffer.put(0x0B.toByte()) // Command for configuring headUp angle
        buffer.put(headUpAngleValue.toByte()) // Angle value (0~60)
        buffer.put(0x01.toByte()) // Level (fixed at 0x01)

        sendDataSequentially(buffer.array(), false, 100)

        Bridge.log("G1: Sent headUp angle command => Angle: " + headUpAngleValue)
        // EventBus.getDefault().post(new HeadUpAngleEvent(headUpAngle));
    }

    fun sendDashboardPositionCommand(height: Int, depth: Int) {
        // clamp height and depth to 0-8 and 1-9 respectively:
        val heightValue = Math.max(0, Math.min(height, 8))
        val depthValue = Math.max(1, Math.min(depth, 9))

        val globalCounter = 0 // TODO: must be incremented each time this command is sent!

        val buffer = ByteBuffer.allocate(8)
        buffer.put(0x26.toByte()) // Command for dashboard height
        buffer.put(0x08.toByte()) // Length
        buffer.put(0x00.toByte()) // Sequence
        buffer.put((globalCounter and 0xFF).toByte()) // counter
        buffer.put(0x02.toByte()) // Fixed value
        buffer.put(0x01.toByte()) // State ON
        buffer.put(heightValue.toByte()) // Height value (0-8)
        buffer.put(depthValue.toByte()) // Depth value (0-9)

        sendDataSequentially(buffer.array(), false, 100)

        Bridge.log("G1: Sent dashboard height/depth command => Height: " + heightValue + ", Depth: " + depthValue)
        // EventBus.getDefault().post(new DashboardPositionEvent(height, depth));
    }

    fun updateGlassesBrightness(brightness: Int) {
        Bridge.log("G1: Updating glasses brightness: " + brightness)
        sendBrightnessCommand(brightness, false)
    }

    fun updateGlassesAutoBrightness(autoBrightness: Boolean) {
        Bridge.log("G1: Updating glasses auto brightness: " + autoBrightness)
        sendBrightnessCommand(-1, autoBrightness)
    }

    fun updateGlassesHeadUpAngle(headUpAngle: Int) {
        sendHeadUpAngleCommand(headUpAngle)
    }

    fun updateGlassesDepthHeight(depth: Int, height: Int) {
        sendDashboardPositionCommand(height, depth)
    }

    fun sendExitCommand() {
        sendDataSequentially(byteArrayOf(0x18.toByte()), false, 100)
    }

    // microphone stuff
    fun sendSetMicEnabled(enable: Boolean, delay: Int) {
        Bridge.log("G1: sendSetMicEnabled(): " + enable)

        isMicrophoneEnabled = enable // Update the state tracker
        DeviceStore.apply("glasses", "micEnabled", enable)
        micEnableHandler.postDelayed({
            if (!isConnected()) {
                Bridge.log("G1: Tryna start mic: Not connected to glasses")
                return@postDelayed
            }

            val command: Byte = 0x0E // Command for MIC control
            val enableByte = (if (enable) 1 else 0).toByte() // 1 to enable, 0 to disable

            val buffer = ByteBuffer.allocate(2)
            buffer.put(command)
            buffer.put(enableByte)

            sendDataSequentially(buffer.array(), false, true, 300) // wait some time to setup the mic
            Bridge.log("G1: Sent MIC command: " + bytesToHex(buffer.array()))
        }, delay.toLong())
    }

    // notifications
    private fun startPeriodicNotifications(delay: Int) {
        if (notifysStarted) {
            return
        }
        notifysStarted = true

        notificationRunnable = object : Runnable {
            override fun run() {
                // Send notification
                sendPeriodicNotification()

                // Schedule the next notification
                notificationHandler.postDelayed(this, 12000L)
            }
        }

        // Start the first notification after 5 seconds
        notificationHandler.postDelayed(notificationRunnable!!, delay.toLong())
    }

    private fun sendPeriodicNotification() {
        if (!isConnected()) {
            Bridge.log("G1: Cannot send notification: Not connected to glasses")
            return
        }

        // Example notification data (replace with your actual data)
        // String json = createNotificationJson("com.augment.os", "QuestionAnswerer",
        // "How much caffeine in dark chocolate?", "25 to 50 grams per piece");
        val json = createNotificationJson("com.augment.os", "QuestionAnswerer",
            "How much caffeine in dark chocolate?", "25 to 50 grams per piece")
        Bridge.log("G1: the JSON to send: " + json)
        val chunks = createNotificationChunks(json)
        for (chunk in chunks) {
            Bridge.log("G1: Sent chunk to glasses: " + bytesToUtf8(chunk))
        }

        // Send each chunk with a short sleep between each send
        sendDataSequentially(chunks, false)

        Bridge.log("G1: Sent periodic notification")
    }

    // text wall debug
    private fun startPeriodicTextWall(delay: Int) {
        if (textWallsStarted) {
            return
        }
        textWallsStarted = true

        textWallRunnable = object : Runnable {
            override fun run() {
                // Send notification
                sendPeriodicTextWall()

                // Schedule the next notification
                textWallHandler.postDelayed(this, 12000L)
            }
        }

        // Start the first text wall send after 5 seconds
        textWallHandler.postDelayed(textWallRunnable!!, delay.toLong())
    }

    private var textSeqNum = 0 // Sequence number for text packets

    /**
     * Creates BLE chunks for pre-wrapped text.
     *
     * IMPORTANT: Text is expected to come pre-wrapped from the DisplayProcessor in React Native.
     * This function does NOT perform any text wrapping - it only chunks the text for BLE transmission.
     * The DisplayProcessor handles all pixel-accurate wrapping using @mentra/display-utils.
     *
     * @param text Pre-wrapped text with newlines already in place
     * @return List of BLE chunks ready for transmission
     */
    private fun createTextWallChunks(text: String): List<ByteArray> {
        // Text comes pre-wrapped from DisplayProcessor - just chunk it for transmission
        return chunkTextForTransmission(text)
    }

    /**
     * Chunks text into BLE packets for transmission to glasses.
     * This is a low-level function that handles BLE protocol framing.
     *
     * @param text Text to chunk (should already be formatted/wrapped)
     * @return List of BLE chunks with headers
     */
    private fun chunkTextForTransmission(text: String?): List<ByteArray> {
        // Handle empty or whitespace-only text by sending at least a space
        // This ensures the display gets updated/cleared properly
        val textToSend = if (text == null || text.trim().isEmpty()) " " else sanitizeG1DisplayText(text)
        val textBytes = textToSend.toByteArray(StandardCharsets.UTF_8)
        val totalChunks = Math.ceil(textBytes.size.toDouble() / MAX_CHUNK_SIZE).toInt()

        val allChunks = ArrayList<ByteArray>()
        for (i in 0 until totalChunks) {
            val start = i * MAX_CHUNK_SIZE
            val end = Math.min(start + MAX_CHUNK_SIZE, textBytes.size)
            val payloadChunk = Arrays.copyOfRange(textBytes, start, end)

            // Create header with protocol specifications
            val screenStatus: Byte = 0x71 // New content (0x01) + Text Show (0x70)
            val header = byteArrayOf(
                TEXT_COMMAND.toByte(), // Command type
                textSeqNum.toByte(), // Sequence number
                totalChunks.toByte(), // Total packages
                i.toByte(), // Current package number
                screenStatus, // Screen status
                0x00.toByte(), // new_char_pos0 (high)
                0x00.toByte(), // new_char_pos1 (low)
                0x00.toByte(), // Current page number (always 0)
                0x01.toByte() // Max page number (always 1)
            )

            // Combine header and payload
            val chunk = ByteBuffer.allocate(header.size + payloadChunk.size)
            chunk.put(header)
            chunk.put(payloadChunk)

            allChunks.add(chunk.array())
        }

        // Increment sequence number for next transmission
        textSeqNum = (textSeqNum + 1) % 256

        return allChunks
    }

    private fun calculateSpacesForAlignment(currentWidth: Int, targetPosition: Int, spaceWidth: Int): Int {
        // Calculate space needed in pixels
        val pixelsNeeded = targetPosition - currentWidth

        // Calculate spaces needed (with minimum of 1 space for separation)
        if (pixelsNeeded <= 0) {
            return 1 // Ensure at least one space between columns
        }

        // Calculate the exact number of spaces needed
        val spaces = Math.ceil(pixelsNeeded.toDouble() / spaceWidth).toInt()

        // Cap at a reasonable maximum
        return Math.min(spaces, 100)
    }

    private fun sendPeriodicTextWall() {
        if (!isConnected()) {
            Bridge.log("G1: Cannot send text wall: Not connected to glasses")
            return
        }

        Bridge.log("G1: ^^^^^^^^^^^^^ SENDING DEBUG TEXT WALL")

        // Example text wall content - replace with your actual text content
        val sampleText = "This is an example of a text wall that will be displayed on the glasses. " +
            "It demonstrates how text can be split into multiple pages and displayed sequentially. " +
            "Each page contains multiple lines, and each line is carefully formatted to fit the display width. " +
            "The text continues across multiple pages, showing how longer content can be handled effectively."

        val chunks = createTextWallChunks(sampleText)

        // Send each chunk with a delay between sends
        for (chunk in chunks) {
            sendDataSequentially(chunk)

            // try {
            // Thread.sleep(150); // 150ms delay between chunks
            // } catch (InterruptedException e) {
            // e.printStackTrace();
            // }
        }

        // Bridge.log("G1: Sent text wall");
    }

    private fun stopPeriodicNotifications() {
        if (notificationHandler != null && notificationRunnable != null) {
            notificationHandler.removeCallbacks(notificationRunnable!!)
            Bridge.log("G1: Stopped periodic notifications")
        }
    }

    fun getWhitelistChunks(): List<ByteArray> {
        // Define the hardcoded whitelist JSON
        val apps = ArrayList<AppInfo>()
        apps.add(AppInfo("com.augment.os", "AugmentOS"))
        val whitelistJson = createWhitelistJson(apps)

        Bridge.log("G1: Creating chunks for hardcoded whitelist: " + whitelistJson)

        // Convert JSON to bytes and split into chunks
        return createWhitelistChunks(whitelistJson)
    }

    private fun createWhitelistJson(apps: List<AppInfo>): String {
        val appList = JSONArray()
        try {
            // Add each app to the list
            for (app in apps) {
                val appJson = JSONObject()
                appJson.put("id", app.id)
                appJson.put("name", app.name)
                appList.put(appJson)
            }

            val whitelistJson = JSONObject()
            whitelistJson.put("calendar_enable", false)
            whitelistJson.put("call_enable", false)
            whitelistJson.put("msg_enable", false)
            whitelistJson.put("ios_mail_enable", false)

            val appObject = JSONObject()
            appObject.put("list", appList)
            appObject.put("enable", true)

            whitelistJson.put("app", appObject)

            return whitelistJson.toString()
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating whitelist JSON: " + e.message)
            return "{}"
        }
    }

    // Simple class to hold app info
    internal class AppInfo(val id: String, val name: String)

    // Helper function to split JSON into chunks
    private fun createWhitelistChunks(json: String): List<ByteArray> {
        val MAX_CHUNK_SIZE = 180 - 4 // Reserve space for the header
        val jsonBytes = json.toByteArray(StandardCharsets.UTF_8)
        val totalChunks = Math.ceil(jsonBytes.size.toDouble() / MAX_CHUNK_SIZE).toInt()

        val chunks = ArrayList<ByteArray>()
        for (i in 0 until totalChunks) {
            val start = i * MAX_CHUNK_SIZE
            val end = Math.min(start + MAX_CHUNK_SIZE, jsonBytes.size)
            val payloadChunk = Arrays.copyOfRange(jsonBytes, start, end)

            // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
            val header = byteArrayOf(
                WHITELIST_CMD.toByte(), // Command ID
                totalChunks.toByte(), // Total number of chunks
                i.toByte() // Current chunk index
            )

            // Combine header and payload
            val buffer = ByteBuffer.allocate(header.size + payloadChunk.size)
            buffer.put(header)
            buffer.put(payloadChunk)

            chunks.add(buffer.array())
        }

        return chunks
    }

    fun displayCustomContent(content: String) {
        Bridge.log("G1: DISPLAY CUSTOM CONTENT")
    }

    private fun sendChunks(chunks: List<ByteArray>) {
        // Send each chunk with a delay between sends
        for (chunk in chunks) {
            // Bridge.log("G1: Sending chunk: " + Arrays.toString(chunk));
            sendDataSequentially(chunk)

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

    @Volatile private var isSendingBitmap = false

    // Progress callback interface
    interface BmpProgressCallback {
        fun onProgress(side: String, offset: Int, chunkIndex: Int, totalSize: Int)

        fun onSuccess(side: String)

        fun onError(side: String, error: String)
    }

    /**
     * Inverts BMP pixel data by flipping all bits after the header.
     * Matches iOS implementation exactly (G1.swift line 1790-1811)
     *
     * @param bmpData The original BMP data
     * @return Inverted BMP data with pixel bits flipped
     */
    private fun invertBmpPixels(bmpData: ByteArray?): ByteArray? {
        if (bmpData == null || bmpData.size <= 62) {
            Bridge.log("G1: BMP data too small to contain pixel data")
            return bmpData
        }

        // BMP header is 62 bytes (14 byte file header + 40 byte DIB header + 8 byte color table)
        val headerSize = 62
        val invertedData = ByteArray(bmpData.size)

        // Copy header unchanged
        System.arraycopy(bmpData, 0, invertedData, 0, headerSize)

        // Invert the pixel data (everything after the header)
        for (i in headerSize until bmpData.size) {
            // Invert each byte (flip all bits)
            invertedData[i] = bmpData[i].toInt().inv().toByte()
        }

        Bridge.log("G1: Inverted BMP pixels: " + (bmpData.size - headerSize) + " bytes processed")
        return invertedData
    }

    fun displayBitmapImage(bmpData: ByteArray?) {
        displayBitmapImage(bmpData, null)
    }

    fun displayBitmapImage(bmpData: ByteArray?, callback: BmpProgressCallback?) {
        // Invert BMP pixels to match iOS implementation
        val invertedBmpData = invertBmpPixels(bmpData)

        if (USE_OPTIMIZED_BITMAP_DISPLAY) {
            displayBitmapImageOptimized(invertedBmpData, callback)
        } else {
            displayBitmapImageLegacy(invertedBmpData, callback)
        }
    }

    // Optimized bitmap display using iOS-like approach
    private fun displayBitmapImageOptimized(bmpData: ByteArray?, callback: BmpProgressCallback?) {
        Bridge.log("G1: Starting OPTIMIZED BMP display process")

        try {
            if (bmpData == null || bmpData.isEmpty()) {
                Log.e(TAG, "Invalid BMP data provided")
                if (callback != null)
                    callback.onError("both", "Invalid BMP data")
                return
            }

            isSendingBitmap = true
            val startTime = System.currentTimeMillis()

            Bridge.log("G1: Processing BMP data, size: " + bmpData.size + " bytes")
            val chunks = createBmpChunks(bmpData)
            Bridge.log("G1: Created " + chunks.size + " chunks")

            // Send chunks using optimized method
            val chunksSuccess = sendBmpChunksOptimized(chunks, callback)
            if (!chunksSuccess) {
                Log.e(TAG, "Failed to send BMP chunks")
                if (callback != null)
                    callback.onError("both", "Failed to send chunks")
                return
            }

            // Send end command - this needs confirmation
            val endSuccess = sendBmpEndCommandOptimized()
            if (!endSuccess) {
                Log.e(TAG, "Failed to send BMP end command")
                if (callback != null)
                    callback.onError("both", "Failed to send end command")
                return
            }

            // Send CRC - this needs confirmation
            val crcSuccess = sendBmpCrcOptimized(bmpData)
            if (!crcSuccess) {
                Log.e(TAG, "Failed to send BMP CRC")
                if (callback != null)
                    callback.onError("both", "CRC check failed")
                return
            }

            lastThingDisplayedWasAnImage = true

            val totalTime = System.currentTimeMillis() - startTime
            Bridge.log("G1: BMP display completed in " + totalTime + "ms")

            if (callback != null) {
                callback.onSuccess("both")
            }

        } catch (e: Exception) {
            Log.e(TAG, "Error in displayBitmapImageOptimized: " + e.message)
            if (callback != null)
                callback.onError("both", "Exception: " + e.message)
        } finally {
            isSendingBitmap = false
        }
    }

    // Legacy method for fallback
    private fun displayBitmapImageLegacy(bmpData: ByteArray?, callback: BmpProgressCallback?) {
        Bridge.log("G1: Starting LEGACY BMP display process")

        try {
            if (bmpData == null || bmpData.isEmpty()) {
                Log.e(TAG, "Invalid BMP data provided")
                if (callback != null)
                    callback.onError("both", "Invalid BMP data")
                return
            }
            Bridge.log("G1: Processing BMP data, size: " + bmpData.size + " bytes")
            // Split into chunks and send
            val chunks = createBmpChunks(bmpData)
            Bridge.log("G1: Created " + chunks.size + " chunks")

            // Send all chunks
            sendBmpChunks(chunks)
            // Send all chunks with progress
            val chunksSuccess = sendBmpChunksWithProgress(chunks, callback)
            if (!chunksSuccess) {
                Log.e(TAG, "Failed to send BMP chunks")
                if (callback != null)
                    callback.onError("both", "Failed to send chunks")
                return
            }

            // Send end command with retry
            val endSuccess = sendBmpEndCommandWithRetry()
            if (!endSuccess) {
                Log.e(TAG, "Failed to send BMP end command")
                if (callback != null)
                    callback.onError("both", "Failed to send end command")
                return
            }

            // Calculate and send CRC with proper algorithm
            val crcSuccess = sendBmpCrcWithRetry(bmpData)
            if (!crcSuccess) {
                Log.e(TAG, "Failed to send BMP CRC")
                if (callback != null)
                    callback.onError("both", "CRC check failed")
                return
            }

            lastThingDisplayedWasAnImage = true

            if (callback != null) {
                callback.onSuccess("both")
            }

            Bridge.log("G1: BMP display process completed successfully")

        } catch (e: Exception) {
            Log.e(TAG, "Error in displayBitmapImage: " + e.message)
            if (callback != null)
                callback.onError("both", "Exception: " + e.message)
        }
    }

    private fun createBmpChunks(bmpData: ByteArray): List<ByteArray> {
        val chunks = ArrayList<ByteArray>()
        val totalChunks = Math.ceil(bmpData.size.toDouble() / BMP_CHUNK_SIZE).toInt()
        Bridge.log("G1: Creating " + totalChunks + " chunks from " + bmpData.size + " bytes")

        for (i in 0 until totalChunks) {
            val start = i * BMP_CHUNK_SIZE
            val end = Math.min(start + BMP_CHUNK_SIZE, bmpData.size)
            val chunk = Arrays.copyOfRange(bmpData, start, end)

            // First chunk needs address bytes
            if (i == 0) {
                val headerWithAddress = ByteArray(2 + GLASSES_ADDRESS.size + chunk.size)
                headerWithAddress[0] = 0x15 // Command
                headerWithAddress[1] = (i and 0xFF).toByte() // Sequence
                System.arraycopy(GLASSES_ADDRESS, 0, headerWithAddress, 2, GLASSES_ADDRESS.size)
                System.arraycopy(chunk, 0, headerWithAddress, 6, chunk.size)
                chunks.add(headerWithAddress)
            } else {
                val header = ByteArray(2 + chunk.size)
                header[0] = 0x15 // Command
                header[1] = (i and 0xFF).toByte() // Sequence
                System.arraycopy(chunk, 0, header, 2, chunk.size)
                chunks.add(header)
            }
        }
        return chunks
    }

    private fun sendBmpChunksWithProgress(chunks: List<ByteArray>, callback: BmpProgressCallback?): Boolean {
        if (updatingScreen)
            return false

        for (i in 0 until chunks.size) {
            val chunk = chunks[i]
            Bridge.log("G1: Sending chunk " + i + " of " + chunks.size + ", size: " + chunk.size)

            val success = sendDataSequentiallyWithTimeout(chunk, CHUNK_SEND_TIMEOUT_MS)
            if (!success) {
                Log.e(TAG, "Failed to send chunk " + i)
                return false
            }

            // Report progress
            if (callback != null) {
                val offset = i * BMP_CHUNK_SIZE
                callback.onProgress("both", offset, i, chunks.size * BMP_CHUNK_SIZE)
            }

            // Platform-specific delay between chunks (matching Flutter implementation)
            try {
                Thread.sleep(ANDROID_CHUNK_DELAY_MS)
            } catch (e: InterruptedException) {
                Log.e(TAG, "Sleep interrupted: " + e.message)
                return false
            }
        }
        return true
    }

    // Optimized chunk sending - mimics iOS approach
    private fun sendBmpChunksOptimized(chunks: List<ByteArray>, callback: BmpProgressCallback?): Boolean {
        if (updatingScreen)
            return false

        Bridge.log("G1: Sending " + chunks.size + " chunks using OPTIMIZED method")

        // Send all chunks except last without waiting for response
        for (i in 0 until chunks.size - 1) {
            val chunk = chunks[i]
            val chunkIndex = i

            if (USE_PARALLEL_BITMAP_WRITES && bitmapExecutor != null) {
                // Send to both glasses in parallel using executor
                val latch = CountDownLatch(2)

                // Send to left glass
                bitmapExecutor!!.execute {
                    try {
                        if (leftGlassGatt != null && leftTxChar != null && isLeftConnected) {
                            synchronized(leftTxChar!!) {
                                leftTxChar!!.value = chunk
                                leftTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                                leftGlassGatt!!.writeCharacteristic(leftTxChar)
                                leftTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                            }
                        }
                    } finally {
                        latch.countDown()
                    }
                }

                // Send to right glass
                bitmapExecutor!!.execute {
                    try {
                        if (rightGlassGatt != null && rightTxChar != null && isRightConnected) {
                            synchronized(rightTxChar!!) {
                                rightTxChar!!.value = chunk
                                rightTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                                rightGlassGatt!!.writeCharacteristic(rightTxChar)
                                rightTxChar!!.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                            }
                        }
                    } finally {
                        latch.countDown()
                    }
                }

                // Wait for both to complete (but don't wait for BLE response)
                try {
                    latch.await(50, TimeUnit.MILLISECONDS) // Short timeout
                } catch (e: InterruptedException) {
                    // Continue anyway
                }
            } else {
                // Fall back to sequential but still no wait
                sendBitmapChunkNoWait(chunk, true, true)
            }

            // Report progress
            if (callback != null) {
                val offset = chunkIndex * BMP_CHUNK_SIZE
                callback.onProgress("both", offset, chunkIndex, chunks.size * BMP_CHUNK_SIZE)
            }

            // Small delay between chunks (iOS uses 8ms)
            try {
                Thread.sleep(ANDROID_CHUNK_DELAY_MS)
            } catch (e: InterruptedException) {
                Log.e(TAG, "Sleep interrupted: " + e.message)
                return false
            }
        }

        // Last chunk - wait for confirmation (like iOS)
        if (!chunks.isEmpty()) {
            val lastChunk = chunks[chunks.size - 1]
            Bridge.log("G1: Sending last chunk with confirmation")

            val success = sendDataSequentiallyWithTimeout(lastChunk, 2000) // Shorter timeout for last chunk
            if (!success) {
                Log.e(TAG, "Failed to send last chunk")
                return false
            }

            if (callback != null) {
                val offset = (chunks.size - 1) * BMP_CHUNK_SIZE
                callback.onProgress("both", offset, chunks.size - 1, chunks.size * BMP_CHUNK_SIZE)
            }
        }

        return true
    }

    // Optimized end command sending
    private fun sendBmpEndCommandOptimized(): Boolean {
        Bridge.log("G1: Sending BMP end command (optimized)")

        // End command needs confirmation, but with shorter timeout
        val success = sendDataSequentiallyWithTimeout(END_COMMAND, 1000)
        if (success) {
            Bridge.log("G1: BMP end command sent successfully")

            // Small delay after end command
            try {
                Thread.sleep(10)
            } catch (e: InterruptedException) {
                // Ignore
            }
        }
        return success
    }

    // Optimized CRC sending
    private fun sendBmpCrcOptimized(bmpData: ByteArray): Boolean {
        // Create data with address for CRC calculation
        val dataWithAddress = ByteArray(GLASSES_ADDRESS.size + bmpData.size)
        System.arraycopy(GLASSES_ADDRESS, 0, dataWithAddress, 0, GLASSES_ADDRESS.size)
        System.arraycopy(bmpData, 0, dataWithAddress, GLASSES_ADDRESS.size, bmpData.size)

        // Calculate CRC32
        val crc = CRC32()
        crc.update(dataWithAddress)
        val crcValue = crc.value

        // Create CRC command packet
        val crcCommand = ByteArray(5)
        crcCommand[0] = 0x16 // CRC command
        crcCommand[1] = ((crcValue shr 24) and 0xFF).toByte()
        crcCommand[2] = ((crcValue shr 16) and 0xFF).toByte()
        crcCommand[3] = ((crcValue shr 8) and 0xFF).toByte()
        crcCommand[4] = (crcValue and 0xFF).toByte()

        Bridge.log("G1: Sending CRC command (optimized), CRC value: " + java.lang.Long.toHexString(crcValue))

        // CRC needs confirmation, but with shorter timeout
        val success = sendDataSequentiallyWithTimeout(crcCommand, 1000)
        if (success) {
            Bridge.log("G1: CRC command sent successfully")
        }
        return success
    }

    private fun sendDataSequentiallyWithTimeout(data: ByteArray, timeoutMs: Long): Boolean {
        // Create a future to track the send operation
        val success = booleanArrayOf(false)
        val latch = CountDownLatch(1)

        // Send the data asynchronously
        Thread {
            try {
                sendDataSequentially(data)
                success[0] = true
            } catch (e: Exception) {
                Log.e(TAG, "Error sending data: " + e.message)
                success[0] = false
            } finally {
                latch.countDown()
            }
        }.start()

        // Wait for completion or timeout
        try {
            val completed = latch.await(timeoutMs, TimeUnit.MILLISECONDS)
            return completed && success[0]
        } catch (e: InterruptedException) {
            Log.e(TAG, "Timeout waiting for data send")
            return false
        }
    }

    private fun sendBmpEndCommandWithRetry(): Boolean {
        if (updatingScreen)
            return false

        for (attempt in 0 until MAX_BMP_RETRY_ATTEMPTS) {
            Bridge.log("G1: Sending BMP end command, attempt " + (attempt + 1))

            val success = sendDataSequentiallyWithTimeout(END_COMMAND, END_COMMAND_TIMEOUT_MS)
            if (success) {
                Bridge.log("G1: BMP end command sent successfully")
                return true
            }

            Log.w(TAG, "BMP end command failed, attempt " + (attempt + 1))

            // Wait before retry
            try {
                Thread.sleep(BMP_RETRY_DELAY_MS)
            } catch (e: InterruptedException) {
                Log.e(TAG, "Sleep interrupted during retry")
                return false
            }
        }

        Log.e(TAG, "Failed to send BMP end command after " + MAX_BMP_RETRY_ATTEMPTS + " attempts")
        return false
    }

    private fun sendBmpCrcWithRetry(bmpData: ByteArray): Boolean {
        // Create data with address for CRC calculation
        val dataWithAddress = ByteArray(GLASSES_ADDRESS.size + bmpData.size)
        System.arraycopy(GLASSES_ADDRESS, 0, dataWithAddress, 0, GLASSES_ADDRESS.size)
        System.arraycopy(bmpData, 0, dataWithAddress, GLASSES_ADDRESS.size, bmpData.size)

        // Calculate CRC32-XZ (using standard CRC32 for now, but should be Crc32Xz)
        val crc = CRC32()
        crc.update(dataWithAddress)
        val crcValue = crc.value

        // Create CRC command packet
        val crcCommand = ByteArray(5)
        crcCommand[0] = 0x16 // CRC command
        crcCommand[1] = ((crcValue shr 24) and 0xFF).toByte()
        crcCommand[2] = ((crcValue shr 16) and 0xFF).toByte()
        crcCommand[3] = ((crcValue shr 8) and 0xFF).toByte()
        crcCommand[4] = (crcValue and 0xFF).toByte()

        Bridge.log("G1: Sending CRC command, CRC value: " + java.lang.Long.toHexString(crcValue))

        // Send CRC with retry
        for (attempt in 0 until MAX_BMP_RETRY_ATTEMPTS) {
            val success = sendDataSequentiallyWithTimeout(crcCommand, CRC_COMMAND_TIMEOUT_MS)
            if (success) {
                Bridge.log("G1: CRC command sent successfully")
                return true
            }

            Log.w(TAG, "CRC command failed, attempt " + (attempt + 1))

            try {
                Thread.sleep(BMP_RETRY_DELAY_MS)
            } catch (e: InterruptedException) {
                Log.e(TAG, "Sleep interrupted during CRC retry")
                return false
            }
        }

        Log.e(TAG, "Failed to send CRC command after " + MAX_BMP_RETRY_ATTEMPTS + " attempts")
        return false
    }

    // Legacy methods for backward compatibility
    private fun sendBmpChunks(chunks: List<ByteArray>) {
        sendBmpChunksWithProgress(chunks, null)
    }

    private fun sendBmpEndCommand() {
        sendBmpEndCommandWithRetry()
    }

    private fun sendBmpCRC(bmpData: ByteArray) {
        sendBmpCrcWithRetry(bmpData)
    }

    private fun sendBmpToSide(bmpData: ByteArray, side: String) {
        // For now, send to both sides but could be modified for side-specific sending
        displayBitmapImage(bmpData, object : BmpProgressCallback {
            override fun onProgress(side: String, offset: Int, chunkIndex: Int, totalSize: Int) {
                Bridge.log("G1: BMP progress for " + side + ": " + offset + "/" + totalSize)
            }

            override fun onSuccess(side: String) {
                Bridge.log("G1: BMP sent successfully to " + side)
            }

            override fun onError(side: String, error: String) {
                Log.e(TAG, "BMP error for " + side + ": " + error)
            }
        })
    }

    private fun loadBmpFromFile(filePath: String): ByteArray? {
        try {
            val file = java.io.File(filePath)
            if (!file.exists()) {
                Log.e(TAG, "BMP file does not exist: " + filePath)
                return null
            }

            // Read file into byte array
            val fileData = ByteArray(file.length().toInt())
            java.io.FileInputStream(file).use { fis ->
                fis.read(fileData)
            }

            // Convert to 1-bit BMP format if needed
            return convertTo1BitBmp(fileData)

        } catch (e: Exception) {
            Log.e(TAG, "Error loading BMP file: " + e.message)
            return null
        }
    }

    private fun convertTo1BitBmp(originalBmp: ByteArray): ByteArray {
        // This is a placeholder - in a real implementation, you'd convert the BMP to
        // 1-bit format
        // For now, we'll assume the input is already in the correct format
        return originalBmp
    }

    private fun loadEmptyBmpFromAssets(): ByteArray? {
        try {
            context!!.assets.open("empty_bmp.bmp").use { iss ->
                return iss.readAllBytes()
            }
        } catch (e: IOException) {
            Log.e(TAG, "Failed to load BMP from assets: " + e.message)
            return null
        }
    }

    fun clearBmpDisplay() {
        if (updatingScreen)
            return
        Bridge.log("G1: Clearing BMP display with EXIT command")
        val exitCommand = byteArrayOf(0x18)
        sendDataSequentially(exitCommand)
    }

    fun exitBmp() {
        clearBmpDisplay()
    }

    // Enhanced error handling and validation
    fun validateBmpFormat(bmpData: ByteArray?): Boolean {
        if (bmpData == null || bmpData.size < 54) { // Minimum BMP header size
            Log.e(TAG, "Invalid BMP data: null or too short")
            return false
        }

        // Check BMP signature
        if (bmpData[0] != 'B'.code.toByte() || bmpData[1] != 'M'.code.toByte()) {
            Log.e(TAG, "Invalid BMP signature")
            return false
        }

        // Check if it's 1-bit format (simplified check)
        val bitsPerPixel = bmpData[28].toInt() and 0xFF
        if (bitsPerPixel != 1) {
            Log.w(TAG, "BMP is not 1-bit format (bits per pixel: " + bitsPerPixel + ")")
        }

        return true
    }

    // Batch processing with progress
    fun sendBmpBatch(bmpPaths: List<String>, callback: BmpProgressCallback?) {
        for (i in 0 until bmpPaths.size) {
            val path = bmpPaths[i]

            if (callback != null) {
                callback.onProgress("batch", i, i, bmpPaths.size)
            }

            try {
                val bmpData = loadBmpFromFile(path)
                if (bmpData != null && validateBmpFormat(bmpData)) {
                    displayBitmapImage(bmpData, object : BmpProgressCallback {
                        override fun onProgress(side: String, offset: Int, chunkIndex: Int, totalSize: Int) {
                            // Individual image progress
                        }

                        override fun onSuccess(side: String) {
                            Bridge.log("G1: Successfully sent BMP: " + path)
                        }

                        override fun onError(side: String, error: String) {
                            Log.e(TAG, "Failed to send BMP " + path + ": " + error)
                            if (callback != null) {
                                callback.onError("batch", "Failed to send " + path + ": " + error)
                            }
                        }
                    })

                    // Delay between images
                    Thread.sleep(2000)
                } else {
                    Log.e(TAG, "Invalid BMP format: " + path)
                    if (callback != null) {
                        callback.onError("batch", "Invalid BMP format: " + path)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error processing BMP " + path + ": " + e.message)
                if (callback != null) {
                    callback.onError("batch", "Error processing " + path + ": " + e.message)
                }
            }
        }

        if (callback != null) {
            callback.onSuccess("batch")
        }
    }

    private fun sendLoremIpsum() {
        if (updatingScreen)
            return
        val text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. "
        sendDataSequentially(createTextWallChunks(text))
    }

    // Enhanced clearing with state management
    fun clearBmpDisplayWithState() {
        if (updatingScreen) {
            Bridge.log("G1: Screen update in progress, queuing clear command")
            // Queue the clear command for later
            handler.postDelayed(this::clearBmpDisplay, 1000L)
            return
        }

        Bridge.log("G1: Clearing BMP display with EXIT command")
        updatingScreen = true

        try {
            val exitCommand = byteArrayOf(0x18)
            val success = sendDataSequentiallyWithTimeout(exitCommand, 2000)
            if (success) {
                lastThingDisplayedWasAnImage = false
                Bridge.log("G1: BMP display cleared successfully")
            } else {
                Log.e(TAG, "Failed to clear BMP display")
            }
        } finally {
            updatingScreen = false
        }
    }

    // Optimized batch clearing
    fun clearAndDisplayBmp(bmpData: ByteArray?, callback: BmpProgressCallback?) {
        if (updatingScreen) {
            Bridge.log("G1: Screen update in progress, cannot clear and display")
            if (callback != null)
                callback.onError("both", "Screen update in progress")
            return
        }

        // Clear first, then display
        clearBmpDisplayWithState()

        // Small delay to ensure clear completes
        handler.postDelayed({
            displayBitmapImage(bmpData, callback)
        }, 500L)
    }

    // Efficient multiple image display with clearing
    fun displayBmpSequence(bmpDataList: List<ByteArray>?, callback: BmpProgressCallback?) {
        if (bmpDataList == null || bmpDataList.isEmpty()) {
            Log.e(TAG, "No BMP data provided for sequence")
            if (callback != null)
                callback.onError("sequence", "No BMP data provided")
            return
        }

        displayBmpSequenceInternal(bmpDataList, 0, callback)
    }

    private fun displayBmpSequenceInternal(bmpDataList: List<ByteArray>, index: Int, callback: BmpProgressCallback?) {
        if (index >= bmpDataList.size) {
            Bridge.log("G1: BMP sequence completed")
            if (callback != null)
                callback.onSuccess("sequence")
            return
        }

        val bmpData = bmpDataList[index]
        displayBitmapImage(bmpData, object : BmpProgressCallback {
            override fun onProgress(side: String, offset: Int, chunkIndex: Int, totalSize: Int) {
                if (callback != null) {
                    // Calculate overall progress including sequence position
                    val overallProgress = (index * 100) / bmpDataList.size
                    callback.onProgress("sequence", overallProgress, index, bmpDataList.size)
                }
            }

            override fun onSuccess(side: String) {
                Bridge.log("G1: BMP " + (index + 1) + " of " + bmpDataList.size + " displayed successfully")

                // Schedule next image with delay
                handler.postDelayed({
                    displayBmpSequenceInternal(bmpDataList, index + 1, callback)
                }, 2000L) // 2 second delay between images
            }

            override fun onError(side: String, error: String) {
                Log.e(TAG, "Failed to display BMP " + (index + 1) + ": " + error)
                if (callback != null) {
                    callback.onError("sequence", "Failed to display BMP " + (index + 1) + ": " + error)
                }
            }
        })
    }

    private fun quickRestartG1() {
        Bridge.log("G1: Sending restart 0x23 0x72 Command")
        sendDataSequentially(byteArrayOf(0x23.toByte(), 0x72.toByte())) // quick restart comand
    }

    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("G1: setMicEnabled(): " + enabled)

        // Update the shouldUseGlassesMic flag to reflect the current state
        this.shouldUseGlassesMic = enabled
        Bridge.log("G1: Updated shouldUseGlassesMic to: " + shouldUseGlassesMic)

        if (enabled) {
            Bridge.log("G1: Microphone enabled, starting audio input handling")
            sendSetMicEnabled(true, 10)
            startMicBeat(MICBEAT_INTERVAL_MS.toInt())
        } else {
            Bridge.log("G1: Microphone disabled, stopping audio input handling")
            sendSetMicEnabled(false, 10)
            stopMicBeat()
        }
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    /**
     * Emits serial number information to React Native (matching iOS implementation)
     */
    private fun emitSerialNumberInfo(serialNumber: String, style: String, color: String) {
        try {
            val eventBody = JSONObject()
            eventBody.put("serialNumber", serialNumber)
            eventBody.put("style", style)
            eventBody.put("color", color)

            // Bridge.sendTypedMessage("glasses_serial_number", eventBody);
            Bridge.log("G1: 📱 Emitted serial number info: " + serialNumber + ", Style: " + style + ", Color: " + color)
            DeviceStore.apply("glasses", "serialNumber", serialNumber)
            DeviceStore.apply("glasses", "style", style)
            DeviceStore.apply("glasses", "color", color)

        } catch (e: Exception) {
            Bridge.log("G1: Error emitting serial number info: " + e.message)
        }
    }

    /**
     * Decodes serial number from manufacturer data bytes
     *
     * @param manufacturerData The manufacturer data bytes
     * @return Decoded serial number string or null if not found
     */
    private fun decodeSerialFromManufacturerData(manufacturerData: ByteArray?): String? {
        if (manufacturerData == null || manufacturerData.size < 10) {
            return null
        }

        try {
            // Convert hex bytes to ASCII string
            val serialBuilder = StringBuilder()
            for (i in 0 until manufacturerData.size) {
                val b = manufacturerData[i]
                if (b.toInt() == 0x00) {
                    // Stop at null terminator
                    break
                }
                if (b.toInt() >= 0x20 && b.toInt() <= 0x7E) {
                    // Only include printable ASCII characters
                    serialBuilder.append(b.toInt().toChar())
                }
            }

            val decodedString = serialBuilder.toString().trim()

            // Check if it looks like a valid Even G1 serial number
            if (decodedString.length >= 12 &&
                (decodedString.startsWith("S1") || decodedString.startsWith("100")
                    || decodedString.startsWith("110"))) {
                return decodedString
            }

            return null
        } catch (e: Exception) {
            Log.e(TAG, "Error decoding manufacturer data: " + e.message)
            return null
        }
    }

    override fun cleanup() {
        // TODO:
    }
}
