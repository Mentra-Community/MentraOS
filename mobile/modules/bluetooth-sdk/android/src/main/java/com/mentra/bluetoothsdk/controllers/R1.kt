package com.mentra.bluetoothsdk.controllers

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ControllerTypes
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// MARK: - R1 BLE Constants

private object R1BLE {
    val SERVICE_UUID: UUID = UUID.fromString("BAE80001-4F05-4503-8E65-3AF1F7329D1F")
    val WRITE_CHAR_1: UUID = UUID.fromString("BAE80010-4F05-4503-8E65-3AF1F7329D1F")
    val NOTIFY_CHAR_1: UUID = UUID.fromString("BAE80011-4F05-4503-8E65-3AF1F7329D1F")
    val WRITE_CHAR_2: UUID = UUID.fromString("BAE80012-4F05-4503-8E65-3AF1F7329D1F")
    val NOTIFY_CHAR_2: UUID = UUID.fromString("BAE80013-4F05-4503-8E65-3AF1F7329D1F")
    val BATTERY_SERVICE: UUID = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")
    val BATTERY_LEVEL_CHAR: UUID = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    val NAME_FILTERS = arrayOf("EVEN R1", "BCL60")

    val CONFIG_FC = byteArrayOf(0xFC.toByte())
    val CONFIG_11 = byteArrayOf(0x11.toByte())

    // BleRing1 command header (cmd, module, subCmd) for advStart.
    // From RE: BleRing1Cmd_system=0, BleRing1Module_system=0, BleRing1SubCmd_advStart=9
    const val CMD_SYSTEM: Byte = 0x00
    const val MODULE_SYSTEM: Byte = 0x00
    const val SUBCMD_ADV_START: Byte = 0x09

    const val GESTURE_MARKER: Byte = 0xFF.toByte()
}

// MARK: - R1 Gesture Types

private enum class R1Gesture(val rawValue: String) {
    HOLD("hold"),
    SINGLE_TAP("single_tap"),
    DOUBLE_TAP("double_tap"),
    SWIPE_UP("swipe_up"),
    SWIPE_DOWN("swipe_down");

    companion object {
        /** Parse gesture from notification data: [0xFF, type, param] */
        fun parse(data: ByteArray): R1Gesture? {
            if (data.size < 3 || data[0] != R1BLE.GESTURE_MARKER) return null
            return when (data[1]) {
                0x03.toByte() -> HOLD
                0x04.toByte() -> when (data[2]) {
                    0x01.toByte() -> SINGLE_TAP
                    0x02.toByte() -> DOUBLE_TAP
                    else -> null
                }
                0x05.toByte() -> if ((data[2].toInt() and 0xFF) < 0x80) SWIPE_UP else SWIPE_DOWN
                else -> null
            }
        }
    }
}

// MARK: - R1 Controller

class R1 : ControllerManager() {

    // Connection state
    private val appContext: Context = Bridge.getContext()
    private val prefs = appContext.getSharedPreferences("r1_prefs", Context.MODE_PRIVATE)

    private var bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null

    private var ringGatt: BluetoothGatt? = null
    private var isDisconnecting = false

    // BLE characteristics
    private var writeChar1: BluetoothGattCharacteristic? = null
    private var notifyChar1: BluetoothGattCharacteristic? = null
    private var writeChar2: BluetoothGattCharacteristic? = null
    private var notifyChar2: BluetoothGattCharacteristic? = null
    private var batteryLevelChar: BluetoothGattCharacteristic? = null
    private var notifySubscriptionCount = 0
    private var initSequenceRun = false

    // Android serializes CCCD writes and reads — queue and drain in callbacks
    private val pendingDescriptorWrites = ArrayDeque<BluetoothGattDescriptor>()
    private val pendingReads = ArrayDeque<BluetoothGattCharacteristic>()
    private var descriptorWriteInFlight = false
    private var readInFlight = false

    // Device search
    private var deviceSearchId: String = "NOT_SET"

    // BLE handle used by Android for reconnection (BluetoothDevice.address — may be a
    // resolvable/random address depending on bonding state; not the ring's public MAC).
    private var ringBleAddress: String?
        get() = prefs.getString("r1_ringBleAddress", null)
        set(value) {
            prefs.edit().apply {
                if (value == null) remove("r1_ringBleAddress") else putString("r1_ringBleAddress", value)
                apply()
            }
        }

    // Public ring MAC parsed from advertisement manufacturer data (last 6 bytes), formatted
    // as "AA:BB:CC:DD:EE:FF". This is what gets published to DeviceStore/controllerMacAddress.
    private var ringMacAddress: String?
        get() = prefs.getString("r1_ringMacAddress", null)
        set(value) {
            prefs.edit().apply {
                if (value == null) remove("r1_ringMacAddress") else putString("r1_ringMacAddress", value)
                apply()
            }
        }

    // peripheral name -> 6-byte ring MAC (hex string), populated from mfgData on every scan.
    // Mirrors iOS ringMacAddressMap so reconnects re-validate freshness instead of trusting
    // a stale stored MAC.
    private fun loadRingMacAddressMap(): MutableMap<String, String> {
        val raw = prefs.getString("r1_ringMacAddressMap", null) ?: return mutableMapOf()
        val out = mutableMapOf<String, String>()
        for (entry in raw.split(';')) {
            if (entry.isEmpty()) continue
            val idx = entry.indexOf('=')
            if (idx <= 0) continue
            out[entry.substring(0, idx)] = entry.substring(idx + 1)
        }
        return out
    }

    private fun saveRingMacAddressMap(map: Map<String, String>) {
        val raw = map.entries.joinToString(";") { "${it.key}=${it.value}" }
        prefs.edit().putString("r1_ringMacAddressMap", raw).apply()
    }

    private fun putRingMacInMap(name: String, mac: String) {
        val map = loadRingMacAddressMap()
        map[name] = mac
        saveRingMacAddressMap(map)
    }

    private fun getRingMacFromMap(name: String): String? = loadRingMacAddressMap()[name]

    // Reconnection (defined but currently unwired — matches iOS which leaves it commented)
    private val reconnectionManager = R1ReconnectionManager()

    // Battery
    private var _batteryLevel: Int = -1
        set(value) {
            val old = field
            field = value
            if (value != old && value >= 0) {
                DeviceStore.apply("glasses", "controllerBatteryLevel", value)
            }
        }

    // Heartbeat
    private val mainHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null

    init {
        type = ControllerTypes.R1
        hasMic = false
    }

    // MARK: - Permissions

    private fun hasScanPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            appContext, Manifest.permission.BLUETOOTH_SCAN
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasConnectPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            appContext, Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED
    }

    // MARK: - BLE Scanning

    private fun startScan(): Boolean {
        Bridge.log("R1: startScan()")
        val adapter = bluetoothAdapter ?: BluetoothAdapter.getDefaultAdapter().also { bluetoothAdapter = it }
        if (adapter == null) {
            Bridge.log("R1: No Bluetooth adapter")
            return false
        }
        if (!adapter.isEnabled) {
            Bridge.log("R1: Bluetooth not powered on")
            return false
        }
        if (!hasScanPermission() || !hasConnectPermission()) {
            Bridge.log("R1: Missing Bluetooth permissions")
            return false
        }

        // Already connected — don't start a new scan
        if (ringGatt != null) {
            Bridge.log("R1: Already connected, skipping scan")
            return true
        }

        isDisconnecting = false

        // Stop any prior scan before starting a new one (avoids leaking ScanCallback)
        stopScan()

        // Try address-based reconnection first
        if (connectByBleAddress()) {
            return true
        }

        val s = adapter.bluetoothLeScanner
        if (s == null) {
            Bridge.log("R1: BluetoothLeScanner not available")
            return false
        }
        scanner = s

        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                if (result == null) return
                handleScanResult(result)
            }

            override fun onScanFailed(errorCode: Int) {
                Bridge.log("R1: Scan failed: $errorCode")
            }
        }
        scanCallback = cb
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            s.startScan(null, settings, cb)
        } catch (e: SecurityException) {
            Bridge.log("R1: startScan SecurityException: ${e.message}")
            return false
        }
        return true
    }

    override fun stopScan() {
        val s = scanner ?: return
        val cb = scanCallback ?: return
        try {
            s.stopScan(cb)
        } catch (e: SecurityException) {
            Bridge.log("R1: stopScan SecurityException: ${e.message}")
        }
        scanCallback = null
    }

    private fun connectByBleAddress(): Boolean {
        if (deviceSearchId == "NOT_SET" || deviceSearchId.isEmpty()) {
            Bridge.log("R1: No deviceSearchId set, skipping connect by address")
            return false
        }
        val address = ringBleAddress ?: return false
        val adapter = bluetoothAdapter ?: return false
        if (ringGatt != null) {
            Bridge.log("R1: connectByBleAddress skipped — already connected")
            return true
        }
        val device = try {
            adapter.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            Bridge.log("R1: Invalid stored BLE address: $address")
            return false
        }
        try {
            ringGatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            Bridge.log("R1: Reconnecting by address to ${device.name ?: address}")
        } catch (e: SecurityException) {
            Bridge.log("R1: connectGatt SecurityException: ${e.message}")
            return false
        }
        return true
    }

    private fun matchesNameFilter(name: String?): Boolean {
        if (name == null) return false
        return R1BLE.NAME_FILTERS.any { name.contains(it) }
    }

    /** Extract a device identifier from the ring name (e.g. "EVEN R1_CEC5BA" -> "CEC5BA") */
    private fun extractRingId(name: String): String? {
        val idx = name.indexOf("R1_")
        if (idx < 0) return null
        val id = name.substring(idx + 3)
        return if (id.isEmpty()) null else id
    }

    private fun handleScanResult(result: ScanResult) {
        val device = result.device ?: return
        val advertisedName = result.scanRecord?.deviceName
        val deviceName: String? = try {
            device.name ?: advertisedName
        } catch (e: SecurityException) {
            advertisedName
        }
        mainHandler.post {
            // Already connected — ignore further scan results
            if (ringGatt != null) {
                stopScan()
                return@post
            }
            if (!matchesNameFilter(deviceName)) return@post

            val mfgMap = result.scanRecord?.manufacturerSpecificData
            val mfgBytes: ByteArray? = if (mfgMap != null && mfgMap.size() > 0) mfgMap.valueAt(0) else null
            val mfgHex = mfgBytes?.joinToString(" ") { String.format("%02X", it) } ?: "none"
            Bridge.log("R1: Discovered: ${deviceName ?: "?"} (RSSI: ${result.rssi}) mfgData: $mfgHex")

            // Extract ring MAC from manufacturer data (last 6 bytes) and store name->MAC map.
            // Android's manufacturerSpecificData strips the 2-byte company ID; iOS keeps it. The
            // resulting "last 6 bytes" land in reversed byte order between platforms (verified in
            // the field), so reverse here to match iOS's stored string ("1B:08:26:8E:0E:E6").
            if (deviceName != null && mfgBytes != null && mfgBytes.size >= 6) {
                val tail = mfgBytes.copyOfRange(mfgBytes.size - 6, mfgBytes.size)
                val macStr = tail.joinToString(":") { String.format("%02X", it) }
                putRingMacInMap(deviceName, macStr)
            }

            // Emit discovered device
            val id = deviceName?.let { extractRingId(it) }
            if (id != null) {
                Bridge.sendDiscoveredDevice(ControllerTypes.R1, id)
            }

            // Scan-only mode: don't auto-connect
            if (deviceSearchId == "NOT_SET") return@post

            // If search ID is specific, check it matches
            val name = deviceName ?: return@post
            val parsedId = extractRingId(name)
            if (parsedId != deviceSearchId && !name.contains(deviceSearchId)) return@post

            if (ringGatt == null) {
                ringBleAddress = device.address
                try {
                    ringGatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
                } catch (e: SecurityException) {
                    Bridge.log("R1: connectGatt SecurityException: ${e.message}")
                    return@post
                }
                stopScan()
                Bridge.log("R1: Connecting to ${name}")
            }
        }
    }

    // MARK: - Init Sequence

    private fun runInitSequence() {
        if (initSequenceRun) return
        initSequenceRun = true

        Bridge.log("R1: Running init sequence")

        val writeChars = listOfNotNull(writeChar1, writeChar2)
        if (writeChars.isEmpty()) {
            Bridge.log("R1: No write characteristics found, skipping init")
            markConnected()
            return
        }

        writeChars.forEach { writeNoResponse(it, R1BLE.CONFIG_FC) }

        mainHandler.postDelayed({
            writeChars.forEach { writeNoResponse(it, R1BLE.CONFIG_11) }
            markConnected()
        }, 200)
    }

    private fun writeNoResponse(char: BluetoothGattCharacteristic, data: ByteArray) {
        char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        char.value = data
        try {
            ringGatt?.writeCharacteristic(char)
        } catch (e: SecurityException) {
            Bridge.log("R1: writeCharacteristic SecurityException: ${e.message}")
        }
    }

    private fun markConnected() {
        reconnectionManager.stop()
        Bridge.log("R1: Ring connected")

        val gatt = ringGatt
        val connectedName = try { gatt?.device?.name } catch (e: SecurityException) { null }
        if (connectedName != null) {
            extractRingId(connectedName)?.let {
                DeviceStore.apply("bluetooth", "controller_device_name", it)
            }
        }

        val mac = ringMacAddress
        if (mac == null) {
            Bridge.log("R1: No ring MAC address found")
            return
        }
        DeviceStore.apply("glasses", "controllerMacAddress", mac)
        DeviceStore.apply("glasses", "controllerConnected", true)
        // DeviceStore.apply("glasses", "controllerFullyBooted", true)

        // tell the ring to connect to the glasses if we have its mac address:
        connectToGlasses()

        // after a second, connect the glasses to the controller if needed:
        CoroutineScope(Dispatchers.Main).launch {
            delay(1000)
            DeviceManager.getInstance().sgc?.connectController()
        }

        startHeartbeat()
    }

    /**
     * Tells the ring to start advertising / connect to the glasses.
     * Sends BleRing1 advStart (cmd=0, module=0, subCmd=9) with the 6-byte glasses MAC as payload
     * to WRITE_CHAR_2 (BAE80012-…). Reverse-engineered from the Even Realities mobile app
     * (BleRing1CmdProto::advStart -> BleRing1CmdPublicExt.sendCmd).
     *
     * TODO: BleRing1CmdPublicExt.sendCmd may add additional outer framing (length/seq/CRC) around
     * the 3-byte header + MAC. If the ring rejects this raw payload, decode the wrapper.
     */
    private fun connectToGlasses() {
        // Try DeviceStore first; fall back to cached value in SharedPreferences.
        val glassesMac = (DeviceStore.get("glasses", "bluetoothMacAddress") as? String)
            ?: prefs.getString("glasses_btMacAddress", null)
        if (glassesMac == null) {
            Bridge.log("R1: connectToGlasses: no glasses MAC")
            return
        }
        // Cache so we can reconnect even before the glasses are scanned.
        prefs.edit().putString("glasses_btMacAddress", glassesMac).apply()

        val macBytes = parseMac(glassesMac)
        if (macBytes == null) {
            Bridge.log("R1: connectToGlasses: could not parse glasses MAC")
            return
        }
        val wc = writeChar2 ?: writeChar1
        if (wc == null) {
            Bridge.log("R1: connectToGlasses: no write characteristic")
            return
        }

        val payload = byteArrayOf(R1BLE.CMD_SYSTEM, R1BLE.MODULE_SYSTEM, R1BLE.SUBCMD_ADV_START) + macBytes
        Bridge.log("R1: advStart sent")

        wc.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        wc.value = payload
        try {
            ringGatt?.writeCharacteristic(wc)
        } catch (e: SecurityException) {
            Bridge.log("R1: connectToGlasses writeCharacteristic SecurityException: ${e.message}")
        }
    }

    /** Parse "AA:BB:CC:DD:EE:FF" or "AABBCCDDEEFF" into 6 raw bytes. */
    private fun parseMac(s: String): ByteArray? {
        val cleaned = s.replace(":", "").replace("-", "")
        if (cleaned.length != 12) return null
        val out = ByteArray(6)
        for (i in 0 until 6) {
            val byte = cleaned.substring(i * 2, i * 2 + 2).toIntOrNull(16) ?: return null
            out[i] = byte.toByte()
        }
        return out
    }

    // MARK: - Heartbeat

    private fun startHeartbeat() {
        stopHeartbeat()
        val r = object : Runnable {
            override fun run() {
                mainHandler.postDelayed(this, 30_000L)
                val isConnected = DeviceStore.get("glasses", "controllerConnected") as? Boolean ?: false
                if (!isConnected) return
                val char = batteryLevelChar
                if (char != null) {
                    try {
                        ringGatt?.readCharacteristic(char)
                    } catch (e: SecurityException) {
                        Bridge.log("R1: heartbeat read SecurityException: ${e.message}")
                    }
                }
            }
        }
        heartbeatRunnable = r
        mainHandler.postDelayed(r, 30_000L)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    // MARK: - Incoming Data Handling

    private fun handleNotification(characteristic: BluetoothGattCharacteristic, data: ByteArray) {
        val hex = data.joinToString(" ") { String.format("%02X", it) }
        val shortUuid = characteristic.uuid.toString().takeLast(4)
        Bridge.log("R1: $shortUuid -> $hex")

        val timestamp = System.currentTimeMillis()

        // Gesture: [0xFF, type, param]
        if (data.size >= 3 && data[0] == R1BLE.GESTURE_MARKER) {
            val gesture = R1Gesture.parse(data)
            if (gesture != null) {
                Bridge.log("R1: Gesture: ${gesture.rawValue}")
                Bridge.sendTouchEvent(ControllerTypes.R1, gesture.rawValue, timestamp)
            } else {
                Bridge.log(
                    "R1: Unknown gesture type=0x%02X param=0x%02X".format(data[1], data[2])
                )
            }
            return
        }

        // Battery: 2 bytes, first byte is percentage
        if (data.size == 2 && (data[0].toInt() and 0xFF) <= 100) {
            _batteryLevel = data[0].toInt() and 0xFF
            Bridge.log("R1: Battery: ${_batteryLevel}%")
            return
        }

        // State: single byte (0x01=ready, 0x00=menu)
        if (data.size == 1) {
            val state = when (data[0]) {
                0x01.toByte() -> "ready"
                0x00.toByte() -> "menu"
                else -> "unknown(${data[0].toInt() and 0xFF})"
            }
            Bridge.log("R1: State: $state")
            return
        }

        // Longer data: check for embedded gesture marker
        if (data.size > 3) {
            val ffIndex = data.indexOfFirst { it == R1BLE.GESTURE_MARKER }
            if (ffIndex >= 0 && ffIndex + 2 < data.size) {
                val slice = byteArrayOf(data[ffIndex], data[ffIndex + 1], data[ffIndex + 2])
                val gesture = R1Gesture.parse(slice)
                if (gesture != null) {
                    Bridge.log("R1: Embedded gesture: ${gesture.rawValue}")
                    Bridge.sendTouchEvent(ControllerTypes.R1, gesture.rawValue, timestamp)
                    return
                }
            }
        }
    }

    // MARK: - Connection State Reset

    private fun resetConnectionState() {
        ringGatt = null
        writeChar1 = null
        notifyChar1 = null
        writeChar2 = null
        notifyChar2 = null
        batteryLevelChar = null
        notifySubscriptionCount = 0
        initSequenceRun = false
        pendingDescriptorWrites.clear()
        pendingReads.clear()
        descriptorWriteInFlight = false
        readInFlight = false
        ringMacAddress = null
        ringBleAddress = null
        DeviceStore.apply("glasses", "controllerConnected", false)
        DeviceStore.apply("glasses", "controllerFullyBooted", false)
    }

    // MARK: - GATT Callback

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothGatt.STATE_CONNECTED -> {
                    val name = try { gatt.device.name } catch (e: SecurityException) { null }
                    Bridge.log("R1: Connected to ${name ?: "ring"}")

                    // Validate against the name->MAC map populated during scan. If the connected
                    // peripheral isn't in the map we don't have its true public MAC — drop the
                    // connection and rescan rather than publishing a stale/wrong MAC. Mirrors
                    // iOS R1.swift didConnect.
                    val mappedMac = name?.let { getRingMacFromMap(it) }
                    if (mappedMac == null) {
                        Bridge.log("R1: No MAC stored in map found for ${name ?: "ring"}")
                        mainHandler.post {
                            disconnect()
                            ringBleAddress = null
                            DeviceStore.apply("glasses", "controllerConnected", false)
                            DeviceStore.apply("glasses", "controllerFullyBooted", false)
                            DeviceStore.apply("glasses", "controllerSearching", true)
                            mainHandler.postDelayed({ startScan() }, 1000)
                        }
                        return
                    }
                    ringMacAddress = mappedMac

                    try {
                        gatt.discoverServices()
                    } catch (e: SecurityException) {
                        Bridge.log("R1: discoverServices SecurityException: ${e.message}")
                    }
                }
                BluetoothGatt.STATE_DISCONNECTED -> {
                    Bridge.log("R1: Disconnected (status=$status)")
                    mainHandler.post {
                        stopHeartbeat()
                        try { gatt.close() } catch (e: SecurityException) {}
                        if (isDisconnecting) return@post
                        resetConnectionState()
                        // iOS leaves reconnection timer commented; match that behavior
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Bridge.log("R1: onServicesDiscovered status=$status")
                return
            }
            mainHandler.post {
                val services = gatt.services ?: return@post
                for (service in services) {
                    for (char in service.characteristics) {
                        Bridge.log("R1: char discovered: ${char.uuid}")
                        val props = char.properties
                        val propStr = buildList {
                            if (props and BluetoothGattCharacteristic.PROPERTY_READ != 0) add("read")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) add("write")
                            if (props and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) add("writeNoResp")
                            if (props and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) add("notify")
                            if (props and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) add("indicate")
                        }.joinToString(",")
                        Bridge.log("R1: char ${char.uuid} props=[$propStr]")

                        // Store known characteristics
                        when (char.uuid) {
                            R1BLE.WRITE_CHAR_1 -> writeChar1 = char
                            R1BLE.NOTIFY_CHAR_1 -> notifyChar1 = char
                            R1BLE.WRITE_CHAR_2 -> writeChar2 = char
                            R1BLE.NOTIFY_CHAR_2 -> notifyChar2 = char
                            R1BLE.BATTERY_LEVEL_CHAR -> batteryLevelChar = char
                        }

                        // Subscribe to any notify/indicate characteristic
                        val notifyEligible = props and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
                        val indicateEligible = props and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
                        if (notifyEligible || indicateEligible) {
                            try {
                                gatt.setCharacteristicNotification(char, true)
                            } catch (e: SecurityException) {
                                Bridge.log("R1: setCharacteristicNotification SecurityException: ${e.message}")
                            }
                            val descriptor = char.getDescriptor(R1BLE.CCCD_UUID)
                            if (descriptor != null) {
                                descriptor.value = if (notifyEligible) {
                                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                } else {
                                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                                }
                                pendingDescriptorWrites.addLast(descriptor)
                            }
                        }

                        // Queue reads (run after CCCD queue drains)
                        if (props and BluetoothGattCharacteristic.PROPERTY_READ != 0) {
                            pendingReads.addLast(char)
                        }
                    }
                }
                drainDescriptorQueue(gatt)
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int
        ) {
            mainHandler.post {
                descriptorWriteInFlight = false
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Bridge.log("R1: Descriptor write failed: $status on ${descriptor.characteristic.uuid}")
                } else {
                    Bridge.log("R1: Notify enabled on ${descriptor.characteristic.uuid}")
                    notifySubscriptionCount += 1
                    if (notifySubscriptionCount >= 2 && !initSequenceRun) {
                        mainHandler.postDelayed({ runInitSequence() }, 300)
                    }
                }
                drainDescriptorQueue(gatt)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic
        ) {
            val data = characteristic.value ?: return
            if (data.isEmpty()) return
            mainHandler.post { handleNotification(characteristic, data) }
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int
        ) {
            val data = characteristic.value
            mainHandler.post {
                readInFlight = false
                if (status == BluetoothGatt.GATT_SUCCESS && data != null && data.isNotEmpty()) {
                    if (characteristic.uuid == R1BLE.BATTERY_LEVEL_CHAR) {
                        _batteryLevel = data[0].toInt() and 0xFF
                        Bridge.log("R1: Battery (std): ${_batteryLevel}%")
                    } else {
                        handleNotification(characteristic, data)
                    }
                }
                drainReadQueue(gatt)
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int
        ) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Bridge.log("R1: Write error on ${characteristic.uuid}: $status")
            }
        }
    }

    private fun drainDescriptorQueue(gatt: BluetoothGatt) {
        if (descriptorWriteInFlight) return
        val next = pendingDescriptorWrites.removeFirstOrNull()
        if (next == null) {
            // Once CCCD queue drained, start reads
            drainReadQueue(gatt)
            return
        }
        descriptorWriteInFlight = true
        try {
            gatt.writeDescriptor(next)
        } catch (e: SecurityException) {
            descriptorWriteInFlight = false
            Bridge.log("R1: writeDescriptor SecurityException: ${e.message}")
            drainDescriptorQueue(gatt)
        }
    }

    private fun drainReadQueue(gatt: BluetoothGatt) {
        if (readInFlight) return
        val next = pendingReads.removeFirstOrNull() ?: return
        readInFlight = true
        try {
            gatt.readCharacteristic(next)
        } catch (e: SecurityException) {
            readInFlight = false
            Bridge.log("R1: readCharacteristic SecurityException: ${e.message}")
            drainReadQueue(gatt)
        }
    }

    // MARK: - ControllerManager overrides

    override fun findCompatibleDevices() {
        Bridge.log("R1: findCompatibleDevices()")
        deviceSearchId = "NOT_SET"
        startScan()
    }

    override fun connectById(id: String) {
        Bridge.log("R1: connectById($id)")
        deviceSearchId = id
        startScan()
    }

    override fun disconnect() {
        Bridge.log("R1: disconnect()")
        isDisconnecting = true
        stopHeartbeat()
        reconnectionManager.stop()
        try {
            ringGatt?.disconnect()
            ringGatt?.close()
        } catch (e: SecurityException) {
            Bridge.log("R1: disconnect SecurityException: ${e.message}")
        }
        resetConnectionState()
    }

    override fun forget() {
        disconnect()
        ringMacAddress = null
        ringBleAddress = null
        prefs.edit().remove("r1_ringMacAddressMap").apply()
        deviceSearchId = "NOT_SET"
    }

    override fun cleanup() {
        disconnect()
    }

    override fun getConnectedBluetoothName(): String? {
        return try { ringGatt?.device?.name } catch (e: SecurityException) { null }
    }

    override fun ping() {
        val char = batteryLevelChar ?: return
        try {
            ringGatt?.readCharacteristic(char)
        } catch (e: SecurityException) {
            Bridge.log("R1: ping SecurityException: ${e.message}")
        }
    }

    override fun getBatteryStatus() {
        val char = batteryLevelChar ?: return
        try {
            ringGatt?.readCharacteristic(char)
        } catch (e: SecurityException) {
            Bridge.log("R1: getBatteryStatus SecurityException: ${e.message}")
        }
    }

    // MARK: - No-op implementations (ring has no display/camera/wifi/mic)

    override fun sendIncidentId(incidentId: String) {}
    override fun setMicEnabled(enabled: Boolean) {}
    override fun sortMicRanking(list: MutableList<String>): MutableList<String> = list
    override fun sendJson(jsonOriginal: Map<String, Any>, wakeUp: Boolean, requireAck: Boolean) {}
    override fun requestPhoto(
        requestId: String, appId: String, size: String?, webhookUrl: String?,
        authToken: String?, compress: String?, flash: Boolean, sound: Boolean,
        exposureTimeNs: Long?,
    ) {}
    override fun startVideoRecording(requestId: String, save: Boolean, flash: Boolean, sound: Boolean) {}
    override fun stopVideoRecording(requestId: String) {}
    override fun startStream(message: Map<String, Any>) {}
    override fun stopStream() {}
    override fun sendStreamKeepAlive(message: Map<String, Any>) {}
    override fun sendButtonPhotoSettings() {}
    override fun sendButtonVideoRecordingSettings() {}
    override fun sendButtonMaxRecordingTime() {}
    override fun sendButtonCameraLedSetting() {}
    override fun setBrightness(level: Int, autoMode: Boolean) {}
    override fun clearDisplay() {}
    override fun sendTextWall(text: String) {}
    override fun sendDoubleTextWall(top: String, bottom: String) {}
    override fun displayBitmap(base64ImageData: String): Boolean = false
    override fun showDashboard() {}
    override fun setDashboardPosition(height: Int, depth: Int) {}
    override fun setHeadUpAngle(angle: Int) {}
    override fun setSilentMode(enabled: Boolean) {}
    override fun exit() {}
    override fun sendShutdown() { disconnect() }
    override fun sendReboot() {}
    override fun sendRgbLedControl(
        requestId: String, packageName: String?, action: String, color: String?,
        onDurationMs: Int, offDurationMs: Int, count: Int
    ) {}
    override fun requestWifiScan() {}
    override fun sendWifiCredentials(ssid: String, password: String) {}
    override fun forgetWifiNetwork(ssid: String) {}
    override fun sendHotspotState(enabled: Boolean) {}
    override fun sendOtaStart() {}
    override fun sendUserEmailToGlasses(email: String) {}
    override fun queryGalleryStatus() {}
    override fun sendGalleryMode() {}
    override fun requestVersionInfo() {}
}

// MARK: - R1 Reconnection Manager
// Coroutine-based port of Swift's R1ReconnectionManager actor.
// Currently unwired — matches iOS which leaves the reconnection timer commented out.

private class R1ReconnectionManager(
    private val intervalSeconds: Long = 30L,
    private val maxAttempts: Int = -1
) {
    private var job: Job? = null
    private var attempts = 0

    fun start(onAttempt: suspend () -> Boolean) {
        stop()
        attempts = 0
        job = CoroutineScope(Dispatchers.Default).launch {
            while (isActive) {
                delay(intervalSeconds * 1_000L)
                if (!isActive) break
                attempts += 1
                if (maxAttempts > 0 && attempts > maxAttempts) break
                if (onAttempt()) break
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        attempts = 0
    }
}
