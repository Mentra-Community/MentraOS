package com.mentra.core.sgcs

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.mentra.core.Bridge
import com.mentra.core.CoreManager
import com.mentra.core.utils.ConnTypes
import com.mentra.core.utils.DeviceTypes
import com.mentra.core.utils.G2Protocol
import com.mentra.core.utils.G2Text
import java.util.*
import kotlinx.coroutines.*

/**
 * Even Realities G2 Smart Glasses Controller.
 *
 * Uses the Even Realities custom BLE service protocol:
 * - Service:  00002760-08c2-11e1-9073-0e8ac72e0000
 * - Write:    00002760-08c2-11e1-9073-0e8ac72e5401  (Phone -> Glasses)
 * - Notify:   00002760-08c2-11e1-9073-0e8ac72e5402  (Glasses -> Phone)
 * - AA 21 packet framing with CRC-16/CCITT
 * - 7-packet application-level auth handshake
 * - Teleprompter service (0x06-20) for text display
 */
class G2 : SGCManager() {

    companion object {
        private const val TAG = "G2"

        // Even Realities G2 Custom BLE Service UUIDs
        private val EVEN_SERVICE_UUID = UUID.fromString(G2Protocol.EVEN_SERVICE_UUID)
        private val WRITE_CHAR_UUID = UUID.fromString(G2Protocol.CHAR_WRITE_UUID)
        private val NOTIFY_CHAR_UUID = UUID.fromString(G2Protocol.CHAR_NOTIFY_UUID)
        private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        // Nordic UART Service - used for raw commands (mic enable/disable) and audio data
        private val UART_SERVICE_UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
        private val UART_TX_CHAR_UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
        private val UART_RX_CHAR_UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")

        fun decodeG2SerialNumber(serialNumber: String): Pair<String, String> {
            if (serialNumber.length < 6) return "Unknown" to "Unknown"
            val style = when (serialNumber.getOrNull(2)) {
                '0' -> "Standard"
                '1' -> "Slim"
                else -> "Standard"
            }
            val color = when (serialNumber.getOrNull(5)) {
                'A' -> "Black"
                'B' -> "Grey"
                'C' -> "Brown"
                else -> "Black"
            }
            return style to color
        }
    }

    // Properties
    var deviceSearchId = "NOT_SET"
    private var isDisconnecting = false

    // BLE connections (dual peripheral - left and right)
    private var leftPeripheral: BluetoothDevice? = null
    private var rightPeripheral: BluetoothDevice? = null
    private var leftGatt: BluetoothGatt? = null
    private var rightGatt: BluetoothGatt? = null
    private var leftReady = false
    private var rightReady = false

    // Store write characteristics per side (Even protocol - teleprompter)
    private var leftWriteChar: BluetoothGattCharacteristic? = null
    private var rightWriteChar: BluetoothGattCharacteristic? = null

    // UART characteristics per side (raw commands - mic, audio)
    private var leftUartTxChar: BluetoothGattCharacteristic? = null
    private var rightUartTxChar: BluetoothGattCharacteristic? = null

    // Stored UUIDs for reconnection
    private var leftGlassUUID: String? = null
    private var rightGlassUUID: String? = null

    // Coroutine scope for async operations
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val mainHandler = Handler(Looper.getMainLooper())

    // Timers
    private var reconnectionTimer: Timer? = null
    private var reconnectionAttempts = 0

    // Heartbeat keepalive (prevents BLE supervision timeout)
    private val HEARTBEAT_INTERVAL_MS = 10_000L
    private var heartbeatHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private var heartbeatCount = 0
    private var keepaliveSeq = 0x40  // separate sequence space from teleprompter
    private var keepaliveMsgId = 0x80

    // UART heartbeat (EvenDemoApp sends [0x25, seq] every 8s to keep UART channel alive)
    private val UART_HEARTBEAT_INTERVAL_MS = 8_000L
    private var uartHeartbeatHandler = Handler(Looper.getMainLooper())
    private var uartHeartbeatRunnable: Runnable? = null
    private var uartHeartbeatSeq: Byte = 0

    // Microphone keepalive (re-sends mic enable to prevent glasses turning off mic)
    private val MICBEAT_INTERVAL_MS = 30 * 60 * 1000L  // 30 minutes
    private var micBeatHandler = Handler(Looper.getMainLooper())
    private var micBeatRunnable: Runnable? = null
    private var shouldUseGlassesMic = false
    private var batteryLeft: Int = -1
    private var batteryRight: Int = -1

    // Text helper
    private val textHelper = G2Text()

    // Active text sending job (cancelled if new text arrives)
    private var currentTextJob: Job? = null

    // Debounce: wait briefly before sending to coalesce rapid updates
    private var pendingText: String? = null
    private var debounceJob: Job? = null
    private val DEBOUNCE_MS = 50L

    // Connection state
    private var isInitialized = false

    init {
        type = DeviceTypes.G2
        hasMic = true
    }

    // =========================================================================
    // BLE Write
    // =========================================================================

    /**
     * Send AA-framed data to one side via Even protocol (5401 characteristic).
     * Used for auth handshake, teleprompter display, keepalive sync.
     */
    private fun sendToSide(data: ByteArray, side: String) {
        val gatt = if (side == "L") leftGatt else rightGatt
        val writeChar = if (side == "L") leftWriteChar else rightWriteChar
        if (gatt == null || writeChar == null) {
            Log.w(TAG, "Cannot send to $side: gatt=${gatt != null}, writeChar=${writeChar != null}")
            return
        }
        bleWrite(gatt, writeChar, data, side)
    }

    /**
     * Send raw command data to one side via UART TX (6E400002 characteristic).
     * Used for mic enable/disable, init command, raw device commands.
     */
    private fun sendToUart(data: ByteArray, side: String) {
        val gatt = if (side == "L") leftGatt else rightGatt
        val uartChar = if (side == "L") leftUartTxChar else rightUartTxChar
        if (gatt == null || uartChar == null) {
            Log.w(TAG, "Cannot send UART to $side: gatt=${gatt != null}, uartChar=${uartChar != null}")
            return
        }
        bleWrite(gatt, uartChar, data, side)
    }

    private fun sendToUartBoth(data: ByteArray) {
        sendToUart(data, "L")
        sendToUart(data, "R")
    }

    private fun bleWrite(gatt: BluetoothGatt, char: BluetoothGattCharacteristic, data: ByteArray, side: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val result = gatt.writeCharacteristic(
                char, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            )
            if (result != 0) {
                Log.w(TAG, "Write failed $side: result=$result, len=${data.size}")
            }
        } else {
            @Suppress("DEPRECATION")
            char.value = data
            char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            if (!gatt.writeCharacteristic(char)) {
                Log.w(TAG, "Write failed $side: len=${data.size}")
            }
        }
    }

    /**
     * Send the 7-packet auth handshake to one side.
     * Called after CCCD + MTU are set up for that side.
     */
    private fun sendAuthSequence(side: String) {
        scope.launch {
            Log.d(TAG, "Starting auth handshake for $side (via Even 5401)")
            val packets = G2Protocol.buildAuthPackets()
            for ((i, packet) in packets.withIndex()) {
                sendToSide(packet, side)
                Log.d(TAG, "Auth ${i + 1}/7 -> $side (${packet.size} bytes): ${packet.take(10).joinToString(" ") { "%02X".format(it) }}...")
                delay(100)
            }
            delay(500)
            Log.d(TAG, "Auth complete for $side")

            mainHandler.post {
                setReadiness(
                    left = if (side == "L") true else null,
                    right = if (side == "R") true else null
                )
            }
        }
    }

    // =========================================================================
    // BLE Connection
    // =========================================================================

    /**
     * Create a new GATT callback per connection (each side gets its own).
     */
    private fun createGattCallback(side: String): BluetoothGattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    Log.d(TAG, "Connected to ${gatt.device.name} (${gatt.device.address}) [$side]")
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    Log.d(TAG, "Disconnected from ${gatt.device.address} [$side]")
                    if (side == "L") { leftWriteChar = null; leftUartTxChar = null } else { rightWriteChar = null; rightUartTxChar = null }
                    setReadiness(
                        left = if (side == "L") false else null,
                        right = if (side == "R") false else null
                    )
                    if (!isDisconnecting) {
                        startReconnectionTimer()
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "Service discovery failed for $side: $status")
                return
            }
            Log.d(TAG, "Services discovered for $side")

            // Log all services and their characteristics for debugging
            for (service in gatt.services) {
                Log.d(TAG, "  Service: ${service.uuid}")
                for (char in service.characteristics) {
                    Log.d(TAG, "    Char: ${char.uuid} props=0x${"%02X".format(char.properties)}")
                }
            }

            // Find write (5401) and notify (5402) characteristics across all Even-base services.
            // The G2 advertises multiple services under the Even base UUID (1001, 5450, 6450, 7450)
            // rather than a single 0000 service. Search all of them.
            val evenBase = "00002760-08c2-11e1-9073-0e8ac72e"
            var writeChar: BluetoothGattCharacteristic? = null
            var notifyChar: BluetoothGattCharacteristic? = null

            for (service in gatt.services) {
                val svcUuid = service.uuid.toString().lowercase()
                if (!svcUuid.startsWith(evenBase)) continue
                Log.d(TAG, "Scanning Even service ${service.uuid} for chars on $side")

                for (char in service.characteristics) {
                    val charUuid = char.uuid.toString().lowercase()
                    if (charUuid == G2Protocol.CHAR_WRITE_UUID) {
                        writeChar = char
                        Log.d(TAG, "  FOUND write char (5401) in service ${service.uuid}")
                    }
                    if (charUuid == G2Protocol.CHAR_NOTIFY_UUID) {
                        notifyChar = char
                        Log.d(TAG, "  FOUND notify char (5402) in service ${service.uuid}")
                    }
                }
            }

            if (writeChar == null) {
                Log.e(TAG, "Write char (5401) not found in any Even service on $side!")
                return
            }
            if (notifyChar == null) {
                Log.e(TAG, "Notify char (5402) not found in any Even service on $side!")
                return
            }

            if (side == "L") leftWriteChar = writeChar else rightWriteChar = writeChar
            val notifyProps = notifyChar.properties
            Log.d(TAG, "Write char $side: props=0x${"%02X".format(writeChar.properties)}")
            Log.d(TAG, "Notify char $side: props=0x${"%02X".format(notifyProps)} NOTIFY=${notifyProps and 0x10 != 0} INDICATE=${notifyProps and 0x20 != 0}")

            // Also find Nordic UART service for mic/audio
            val uartService = gatt.getService(UART_SERVICE_UUID)
            if (uartService != null) {
                val uartTx = uartService.getCharacteristic(UART_TX_CHAR_UUID)
                val uartRx = uartService.getCharacteristic(UART_RX_CHAR_UUID)
                if (uartTx != null) {
                    if (side == "L") leftUartTxChar = uartTx else rightUartTxChar = uartTx
                    Log.d(TAG, "UART TX char found on $side: props=0x${"%02X".format(uartTx.properties)}")
                }
                if (uartRx != null) {
                    gatt.setCharacteristicNotification(uartRx, true)
                    Log.d(TAG, "UART RX notifications enabled on $side")
                }
            } else {
                Log.w(TAG, "UART service not found on $side")
            }

            // Enable local notification registration for Even protocol
            gatt.setCharacteristicNotification(notifyChar, true)

            // Write CCCD descriptor for Even notify char (use old API for maximum compatibility)
            val descriptor = notifyChar.getDescriptor(CCCD_UUID)
            if (descriptor != null) {
                val cccdValue = if (notifyProps and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                } else {
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                }
                @Suppress("DEPRECATION")
                descriptor.value = cccdValue
                @Suppress("DEPRECATION")
                val result = gatt.writeDescriptor(descriptor)
                Log.d(TAG, "Even CCCD write $side: $result")
            } else {
                Log.e(TAG, "CCCD descriptor not found on Even notify char $side!")
            }
            // Flow continues in onDescriptorWrite -> requestMtu -> onMtuChanged -> auth
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            val charUuid = descriptor.characteristic?.uuid?.toString()?.lowercase() ?: "unknown"
            Log.d(TAG, "onDescriptorWrite $side: char=$charUuid status=$status (0=SUCCESS)")
            if (status != BluetoothGatt.GATT_SUCCESS) return

            // If this was the Even notify CCCD, now write the UART RX CCCD
            if (charUuid == G2Protocol.CHAR_NOTIFY_UUID) {
                val uartService = gatt.getService(UART_SERVICE_UUID)
                val uartRx = uartService?.getCharacteristic(UART_RX_CHAR_UUID)
                val uartCccd = uartRx?.getDescriptor(CCCD_UUID)
                if (uartCccd != null) {
                    @Suppress("DEPRECATION")
                    uartCccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    val result = gatt.writeDescriptor(uartCccd)
                    Log.d(TAG, "UART CCCD write $side: $result")
                } else {
                    Log.w(TAG, "No UART RX CCCD on $side, proceeding to MTU")
                    gatt.requestMtu(512)
                }
            }
            // If this was the UART RX CCCD, proceed to MTU request
            else if (charUuid == UART_RX_CHAR_UUID.toString().lowercase()) {
                Log.d(TAG, "UART CCCD done for $side, requesting MTU")
                gatt.requestMtu(512)
            }
            // Fallback for any other descriptor
            else {
                gatt.requestMtu(512)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            Log.d(TAG, "onMtuChanged $side: mtu=$mtu status=$status")

            // Bond if needed
            val bondState = gatt.device?.bondState ?: -1
            Log.d(TAG, "Bond state $side: $bondState (10=NONE, 11=BONDING, 12=BONDED)")
            if (bondState != BluetoothDevice.BOND_BONDED) {
                gatt.device?.createBond()
            }

            // Send UART init command [0xF4, 0x01] (EvenDemoApp sends this after setup)
            val initCmd = byteArrayOf(0xF4.toByte(), 0x01)
            sendToUart(initCmd, side)
            Log.d(TAG, "UART init [0xF4, 0x01] sent to $side")

            // Send 7-packet auth handshake via Even 5401 (this marks side as ready when done)
            sendAuthSequence(side)
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            super.onCharacteristicChanged(gatt, characteristic, value)
            val charSuffix = characteristic.uuid.toString().takeLast(4)
            if (charSuffix != "5402") {
                Log.d(TAG, "Notify from char $charSuffix on $side (${value.size} bytes)")
            }
            handleNotification(side, value)
        }

        @Deprecated("Deprecated in API 33")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            super.onCharacteristicChanged(gatt, characteristic)
            val charSuffix = characteristic.uuid.toString().takeLast(4)
            @Suppress("DEPRECATION")
            val data = characteristic.value ?: byteArrayOf()
            if (charSuffix != "5402") {
                Log.d(TAG, "Notify from char $charSuffix on $side (${data.size} bytes)")
            }
            handleNotification(side, data)
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val charSuffix = characteristic.uuid.toString().takeLast(4)
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Write callback $side ($charSuffix): status=$status (FAILED)")
            } else {
                Log.d(TAG, "Write callback $side ($charSuffix): SUCCESS")
            }
        }
    }

    private var audioPacketCount = 0

    private fun handleNotification(side: String, data: ByteArray) {
        if (data.isEmpty()) return

        val firstByte = data[0].toInt() and 0xFF

        // Audio data: 0xF1 + seq + LC3 payload
        if (firstByte == 0xF1 && data.size > 2) {
            if (side == "R" && shouldUseGlassesMic) {
                audioPacketCount++
                if (audioPacketCount <= 5) {
                    Log.d(TAG, "Audio packet #$audioPacketCount from $side: seq=${data[1].toInt() and 0xFF}, payload=${data.size - 2} bytes")
                } else if (audioPacketCount % 100 == 0) {
                    Log.d(TAG, "Audio packets received: $audioPacketCount")
                }
                val lc3 = data.copyOfRange(2, data.size)
                CoreManager.getInstance()?.handleGlassesMicData(lc3, 20)
            }
            return
        }

        // Mic enable/disable response: [0x0E, 0xC9]=success or [0x0E, 0xCA]=failure
        // Also handle raw 0xC9/0xCA as first byte (alternate format)
        if (firstByte == 0x0E && data.size >= 2) {
            val statusByte = data[1].toInt() and 0xFF
            val status = if (statusByte == 0xC9) "SUCCESS" else "FAILED(0x${"%02X".format(statusByte)})"
            Log.d(TAG, "Mic command response $side: $status")
            return
        }
        if ((firstByte == 0xC9 || firstByte == 0xCA) && data.size <= 4) {
            val status = if (firstByte == 0xC9) "SUCCESS" else "FAILED"
            Log.d(TAG, "Command response $side: $status (raw)")
            return
        }

        // Battery response: [0x2C, 0x66, level]
        if (firstByte == 0x2C && data.size > 2 && (data[1].toInt() and 0xFF) == 0x66) {
            val level = data[2].toInt() and 0xFF
            if (side == "L") {
                batteryLeft = level
            } else if (side == "R") {
                batteryRight = level
            }
            if (batteryLeft != -1 && batteryRight != -1) {
                batteryLevel = minOf(batteryLeft, batteryRight)
                Log.d(TAG, "Battery L=$batteryLeft R=$batteryRight min=$batteryLevel")
                CoreManager.getInstance()?.getStatus()
            }
            return
        }

        // Head up movement: [0xF5, 0x02] (right sensor only)
        if (firstByte == 0xF5 && data.size > 1 && (data[1].toInt() and 0xFF) == 0x02) {
            if (side == "R") {
                Log.d(TAG, "HEAD UP MOVEMENT DETECTED")
                CoreManager.getInstance()?.updateHeadUp(true)
            }
            return
        }

        // Head down movement: [0xF5, 0x03] (right sensor only)
        if (firstByte == 0xF5 && data.size > 1 && (data[1].toInt() and 0xFF) == 0x03) {
            if (side == "R") {
                Log.d(TAG, "HEAD DOWN MOVEMENT DETECTED")
                CoreManager.getInstance()?.updateHeadUp(false)
            }
            return
        }

        // Case removed: [0xF5, 0x06] or [0xF5, 0x07]
        if (firstByte == 0xF5 && data.size > 1 &&
            ((data[1].toInt() and 0xFF) == 0x06 || (data[1].toInt() and 0xFF) == 0x07)) {
            caseRemoved = true
            Log.d(TAG, "CASE REMOVED")
            CoreManager.getInstance()?.getStatus()
            return
        }

        // Case open: [0xF5, 0x08]
        if (firstByte == 0xF5 && data.size > 1 && (data[1].toInt() and 0xFF) == 0x08) {
            caseOpen = true
            caseRemoved = false
            Log.d(TAG, "CASE OPEN")
            CoreManager.getInstance()?.getStatus()
            return
        }

        // Case closed: [0xF5, 0x0B]
        if (firstByte == 0xF5 && data.size > 1 && (data[1].toInt() and 0xFF) == 0x0B) {
            caseOpen = false
            caseRemoved = false
            Log.d(TAG, "CASE CLOSED")
            CoreManager.getInstance()?.getStatus()
            return
        }

        // Case charging status: [0xF5, 0x0E, charging_flag]
        if (firstByte == 0xF5 && data.size > 2 && (data[1].toInt() and 0xFF) == 0x0E) {
            caseCharging = (data[2].toInt() and 0xFF) == 0x01
            Log.d(TAG, "CASE CHARGING: $caseCharging")
            CoreManager.getInstance()?.getStatus()
            return
        }

        // Case battery level: [0xF5, 0x0F, battery_level]
        if (firstByte == 0xF5 && data.size > 2 && (data[1].toInt() and 0xFF) == 0x0F) {
            caseBatteryLevel = data[2].toInt() and 0xFF
            Log.d(TAG, "CASE BATTERY: $caseBatteryLevel")
            CoreManager.getInstance()?.getStatus()
            return
        }

        // Heartbeat response: [0x25, ...]
        if (firstByte == 0x25) {
            return
        }

        // AA protocol responses and other notifications
        val hexStr = data.joinToString(" ") { "%02X".format(it) }
        Log.d(TAG, ">>> NOTIFY $side (${data.size} bytes): $hexStr")
    }

    private fun setReadiness(left: Boolean? = null, right: Boolean? = null) {
        left?.let { leftReady = it }
        right?.let { rightReady = it }

        val wasReady = ready
        ready = leftReady && rightReady

        if (ready && !wasReady) {
            Log.d(TAG, "Both sides ready! (Even custom protocol authenticated)")
            connectionState = ConnTypes.CONNECTED
            isInitialized = true
            stopReconnectionTimer()

            // Send initial text via teleprompter protocol
            mainHandler.postDelayed({
                Log.d(TAG, "Sending initial display via teleprompter")
                sendTextWall("MentraOS\nConnected")
            }, 1000)

            // Start keepalives
            startHeartbeat()       // Even protocol keepalive (AA-framed sync)
            startUartHeartbeat()   // UART channel keepalive ([0x25, seq])

            CoreManager.getInstance()?.handleConnectionStateChanged()
        } else if (!ready && wasReady) {
            connectionState = ConnTypes.DISCONNECTED
            isInitialized = false
            stopHeartbeat()
            stopUartHeartbeat()
            CoreManager.getInstance()?.handleConnectionStateChanged()
        }
    }

    // =========================================================================
    // Connection Management (SGCManager interface)
    // =========================================================================

    override fun findCompatibleDevices() {
        Log.d(TAG, "findCompatibleDevices()")
        Bridge.sendDiscoveredDevice(DeviceTypes.G2, "NOTREQUIREDSKIP")
    }

    override fun connectById(id: String) {
        Log.d(TAG, "connectById($id)")
        if (id != "NOTREQUIREDSKIP") {
            deviceSearchId = id
        }
        connectionState = ConnTypes.CONNECTING
        startScan()
    }

    private fun startScan() {
        val context = Bridge.getContext()
        val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val bluetoothAdapter = bluetoothManager.adapter ?: return
        val scanner = bluetoothAdapter.bluetoothLeScanner ?: return

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        scanner.startScan(null, settings, scanCallback)
        Log.d(TAG, "BLE scan started")

        mainHandler.postDelayed({ scanner.stopScan(scanCallback) }, 30_000)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val name = device.name ?: return

            // Match G2 devices: "Even G2_XX_L_XXXXX" or "G2_XX_L_XXXXX"
            if (!name.contains("G2")) return

            val parts = name.split("_")
            if (parts.size != 4) return

            Log.d(TAG, "Found G2 device: $name (${device.address})")

            val isLeft = name.contains("_L_")
            val isRight = name.contains("_R_")

            if (!isLeft && !isRight) return

            if (deviceSearchId != "NOT_SET") {
                if (!name.contains(deviceSearchId)) return
            }

            val context = Bridge.getContext()

            if (isLeft && leftGatt == null) {
                Log.d(TAG, "Connecting to left: $name")
                leftPeripheral = device
                leftGlassUUID = device.address
                leftGatt = device.connectGatt(context, false, createGattCallback("L"), BluetoothDevice.TRANSPORT_LE)
            }
            if (isRight && rightGatt == null) {
                Log.d(TAG, "Connecting to right: $name")
                rightPeripheral = device
                rightGlassUUID = device.address
                rightGatt = device.connectGatt(context, false, createGattCallback("R"), BluetoothDevice.TRANSPORT_LE)
            }

            if (leftGatt != null && rightGatt != null) {
                val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
                bluetoothManager.adapter?.bluetoothLeScanner?.stopScan(this)
                Log.d(TAG, "Both sides found, stopping scan")
            }
        }
    }

    override fun disconnect() {
        isDisconnecting = true
        stopReconnectionTimer()
        stopHeartbeat()
        stopUartHeartbeat()
        stopMicBeat()
        shouldUseGlassesMic = false
        micEnabled = false
        audioPacketCount = 0
        batteryLeft = -1
        batteryRight = -1
        batteryLevel = -1
        currentTextJob?.cancel()

        leftGatt?.disconnect()
        rightGatt?.disconnect()
        leftGatt?.close()
        rightGatt?.close()
        leftGatt = null
        rightGatt = null
        leftPeripheral = null
        rightPeripheral = null
        leftWriteChar = null
        rightWriteChar = null
        leftUartTxChar = null
        rightUartTxChar = null

        setReadiness(left = false, right = false)
        isInitialized = false
        isDisconnecting = false
        Log.d(TAG, "Disconnected")
    }

    override fun forget() {
        leftGlassUUID = null
        rightGlassUUID = null
        deviceSearchId = "NOT_SET"
        disconnect()
    }

    override fun getConnectedBluetoothName(): String {
        return leftPeripheral?.name ?: rightPeripheral?.name ?: ""
    }

    override fun cleanup() {
        reconnectionTimer?.cancel()
        stopHeartbeat()
        stopUartHeartbeat()
        stopMicBeat()
        currentTextJob?.cancel()
        scope.cancel()
        leftGatt?.close()
        rightGatt?.close()
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private fun startReconnectionTimer() {
        if (reconnectionTimer != null) return
        Log.d(TAG, "Starting reconnection timer")
        reconnectionTimer = Timer().apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (ready) {
                        stopReconnectionTimer()
                        return
                    }
                    reconnectionAttempts++
                    Log.d(TAG, "Reconnection attempt $reconnectionAttempts")

                    if (!leftReady) {
                        leftGatt?.disconnect()
                        leftGatt?.close()
                        leftGatt = null
                        leftWriteChar = null
                    }
                    if (!rightReady) {
                        rightGatt?.disconnect()
                        rightGatt?.close()
                        rightGatt = null
                        rightWriteChar = null
                    }

                    startScan()
                }
            }, 0, 30_000)
        }
    }

    private fun stopReconnectionTimer() {
        reconnectionTimer?.cancel()
        reconnectionTimer = null
        reconnectionAttempts = 0
    }

    // =========================================================================
    // Heartbeat / Keepalive
    // =========================================================================

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatCount = 0
        heartbeatRunnable = Runnable {
            sendKeepalive()
            heartbeatHandler.postDelayed(heartbeatRunnable!!, HEARTBEAT_INTERVAL_MS)
        }
        heartbeatHandler.postDelayed(heartbeatRunnable!!, HEARTBEAT_INTERVAL_MS)
        Log.d(TAG, "Heartbeat started (${HEARTBEAT_INTERVAL_MS}ms interval)")
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { heartbeatHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    private fun sendKeepalive() {
        if (!ready) return
        val packet = G2Protocol.buildSync(keepaliveSeq++, keepaliveMsgId++)
        sendToSide(packet, "L")
        sendToSide(packet, "R")
        heartbeatCount++
        Log.d(TAG, "Keepalive #$heartbeatCount sent (seq=${keepaliveSeq - 1})")

        if (heartbeatCount % 10 == 0) {
            getBatteryStatus()
        }
    }

    // =========================================================================
    // Mic Beat Keepalive
    // =========================================================================

    private fun startMicBeat() {
        stopMicBeat()
        micBeatRunnable = Runnable {
            if (shouldUseGlassesMic && ready) {
                val command = byteArrayOf(0x0E, 0x01)
                sendToUart(command, "R")
                Log.d(TAG, "Mic beat sent via UART to R")
            }
            micBeatHandler.postDelayed(micBeatRunnable!!, MICBEAT_INTERVAL_MS)
        }
        micBeatHandler.postDelayed(micBeatRunnable!!, MICBEAT_INTERVAL_MS)
        Log.d(TAG, "Mic beat started (${MICBEAT_INTERVAL_MS}ms interval)")
    }

    private fun stopMicBeat() {
        micBeatRunnable?.let { micBeatHandler.removeCallbacks(it) }
        micBeatRunnable = null
    }

    // =========================================================================
    // UART Heartbeat (keeps UART channel alive for mic/audio)
    // =========================================================================

    private fun startUartHeartbeat() {
        stopUartHeartbeat()
        uartHeartbeatSeq = 0
        uartHeartbeatRunnable = Runnable {
            if (ready) {
                val cmd = byteArrayOf(0x25, uartHeartbeatSeq++)
                sendToUart(cmd, "L")
                sendToUart(cmd, "R")
                Log.d(TAG, "UART heartbeat sent (seq=${uartHeartbeatSeq - 1})")
            }
            uartHeartbeatHandler.postDelayed(uartHeartbeatRunnable!!, UART_HEARTBEAT_INTERVAL_MS)
        }
        // Send first one immediately
        uartHeartbeatRunnable!!.run()
        Log.d(TAG, "UART heartbeat started (${UART_HEARTBEAT_INTERVAL_MS}ms interval)")
    }

    private fun stopUartHeartbeat() {
        uartHeartbeatRunnable?.let { uartHeartbeatHandler.removeCallbacks(it) }
        uartHeartbeatRunnable = null
    }

    // =========================================================================
    // Display Control
    // =========================================================================

    override fun sendTextWall(text: String) {
        if (!ready || !isInitialized) {
            Log.w(TAG, "Not ready, cannot send text")
            return
        }

        Log.d(TAG, "sendTextWall: \"${text.take(50)}...\"")

        // Debounce: store latest text and wait for rapid-fire calls to settle
        val wasCoalesced = pendingText != null
        pendingText = text
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(DEBOUNCE_MS)
            val textToSend = pendingText ?: return@launch
            pendingText = null
            if (wasCoalesced) Log.d(TAG, "Debounce coalesced rapid updates")
            sendTeleprompterNow(textToSend)
        }
    }

    private fun sendTeleprompterNow(text: String) {
        // Cancel any in-progress send
        currentTextJob?.cancel()

        currentTextJob = scope.launch {
            val timedPackets = textHelper.buildTeleprompterSequence(text)
            Log.d(TAG, "Sending ${timedPackets.size} teleprompter packets to both sides")

            for ((index, tp) in timedPackets.withIndex()) {
                if (!isActive) break  // Cancelled
                sendToSide(tp.data, "L")
                delay(10)
                sendToSide(tp.data, "R")
                delay(tp.delayAfterMs)
            }

            Log.d(TAG, "Teleprompter sequence complete (${timedPackets.size} packets)")
        }
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        if (!ready || !isInitialized) return
        // Double text wall: combine both texts with separator
        sendTextWall("$top\n---\n$bottom")
    }

    override fun clearDisplay() {
        if (!ready) return
        sendTextWall(" ")
    }

    override fun displayBitmap(base64ImageData: String): Boolean {
        // Bitmap display via Even protocol not yet implemented
        Log.d(TAG, "displayBitmap: not yet supported on Even protocol")
        return false
    }

    override fun setBrightness(level: Int, autoMode: Boolean) {
        if (!ready) return
        val validBrightness = if (level != -1) (level * 63) / 100 else (30 * 63) / 100
        val command = byteArrayOf(
            0x01,
            validBrightness.toByte(),
            if (autoMode) 0x01 else 0x00
        )
        sendToUartBoth(command)
        Log.d(TAG, "setBrightness($level -> $validBrightness/63, auto=$autoMode)")
    }

    override fun showDashboard() {
        if (!ready || !isInitialized) return
        sendTextWall(" ")
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Log.d(TAG, "setDashboardPosition($height, $depth)")
    }

    // =========================================================================
    // Device Control
    // =========================================================================

    override fun getBatteryStatus() {
        if (!ready) return
        val command = byteArrayOf(0x2C, 0x01)
        sendToUartBoth(command)
        Log.d(TAG, "getBatteryStatus() query sent")
    }

    override fun setMicEnabled(enabled: Boolean) {
        if (!ready) return
        Log.d(TAG, "setMicEnabled($enabled)")
        shouldUseGlassesMic = enabled
        micEnabled = enabled
        val command = byteArrayOf(0x0E, if (enabled) 0x01 else 0x00)
        // Mic is on right glass only - send via UART (raw command channel)
        sendToUart(command, "R")
        Log.d(TAG, "Mic command sent via UART to R: ${command.joinToString(" ") { "%02X".format(it) }}")
        if (enabled) startMicBeat() else stopMicBeat()
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        val sorted = mutableListOf<String>()
        if (list.contains("glasses")) sorted.add("glasses")
        for (item in list) {
            if (item != "glasses" && !sorted.contains(item)) sorted.add(item)
        }
        return sorted
    }

    override fun setSilentMode(enabled: Boolean) {
        if (!ready) return
        val command = byteArrayOf(0x03, if (enabled) 0x01 else 0x0A)
        sendToUartBoth(command)
        Log.d(TAG, "setSilentMode($enabled)")
    }

    override fun exit() {
        if (!ready) return
        sendToUartBoth(byteArrayOf(0x18))
        Log.d(TAG, "exit()")
    }

    override fun setHeadUpAngle(angle: Int) {
        if (!ready) return
        val clamped = angle.coerceIn(0, 60)
        val command = byteArrayOf(0x0B, clamped.toByte(), 0x01)
        sendToUartBoth(command)
        Log.d(TAG, "setHeadUpAngle($clamped)")
    }

    // =========================================================================
    // Camera & Media Stubs (G2 has no camera)
    // =========================================================================

    override fun requestPhoto(requestId: String, appId: String, size: String, webhookUrl: String?, authToken: String?, compress: String?, silent: Boolean) {}
    override fun startRtmpStream(message: MutableMap<String, Any>) {}
    override fun stopRtmpStream() {}
    override fun sendRtmpKeepAlive(message: MutableMap<String, Any>) {}
    override fun startBufferRecording() {}
    override fun stopBufferRecording() {}
    override fun saveBufferVideo(requestId: String, durationSeconds: Int) {}
    override fun startVideoRecording(requestId: String, save: Boolean, silent: Boolean) {}
    override fun stopVideoRecording(requestId: String) {}

    // =========================================================================
    // Button Settings Stubs
    // =========================================================================

    override fun sendButtonPhotoSettings() {}
    override fun sendButtonModeSetting() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendButtonCameraLedSetting() {}

    // =========================================================================
    // LED Control Stub
    // =========================================================================

    override fun sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, ontime: Int, offtime: Int, count: Int) {}

    // =========================================================================
    // Network Stubs (G2 has no WiFi)
    // =========================================================================

    override fun requestWifiScan() {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}

    // =========================================================================
    // User Context
    // =========================================================================

    override fun sendUserEmailToGlasses(email: String) {}

    // =========================================================================
    // Gallery Stubs
    // =========================================================================

    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}
}
