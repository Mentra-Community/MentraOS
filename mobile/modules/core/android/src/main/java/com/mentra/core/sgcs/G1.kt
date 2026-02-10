// package com.mentra.core.sgcs

// import android.bluetooth.*
// import android.bluetooth.le.*
// import android.content.Context
// import android.os.Handler
// import android.os.Looper
// import android.util.Log
// import com.mentra.core.utils.ConnTypes
// import java.util.*
// import java.util.concurrent.ConcurrentHashMap
// import java.util.zip.CRC32
// import kotlin.coroutines.resume
// import kotlin.coroutines.suspendCoroutine
// import kotlinx.coroutines.*
// import kotlinx.coroutines.channels.Channel
// import kotlinx.coroutines.flow.MutableStateFlow
// import kotlinx.coroutines.flow.StateFlow

// // Data Extensions
// fun ByteArray.toHexString(separator: String = " "): String =
//         joinToString(separator) { "%02x".format(it) }

// fun ByteArray.crc32(): UInt {
//     val crc = CRC32()
//     crc.update(this)
//     return crc.value.toUInt()
// }

// fun ByteArray.chunked(size: Int): List<ByteArray> {
//     val chunks = mutableListOf<ByteArray>()
//     var index = 0
//     while (index < this.size) {
//         val chunkSize = minOf(size, this.size - index)
//         chunks.add(copyOfRange(index, index + chunkSize))
//         index += chunkSize
//     }
//     return chunks
// }

// fun String.hexToByteArray(): ByteArray? {
//     val cleanHex = replace(" ", "")
//     if (cleanHex.length % 2 != 0) return null

//     return try {
//         ByteArray(cleanHex.length / 2) { i ->
//             cleanHex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
//         }
//     } catch (e: Exception) {
//         null
//     }
// }

// // Data Classes
// data class QuickNote(
//         val id: UUID = UUID.randomUUID(),
//         val text: String,
//         val timestamp: Date = Date()
// )

// data class BufferedCommand(
//         val chunks: List<ByteArray>,
//         val sendLeft: Boolean = true,
//         val sendRight: Boolean = true,
//         val waitTime: Int = -1,
//         val ignoreAck: Boolean = false,
//         val chunkTimeMs: Int = 10,
//         val lastFrameMs: Int = 0
// )

// data class AppInfo(val id: String, val name: String)

// // Enums
// enum class Commands(val value: Byte) {
//     BLE_REQ_INIT(0x01),
//     QUICK_NOTE_ADD(0x02),
//     BLE_REQ_MIC_ON(0x03),
//     BRIGHTNESS(0x04),
//     BLE_EXIT_ALL_FUNCTIONS(0x18),
//     WHITELIST(0x19),
//     DASHBOARD_LAYOUT_COMMAND(0x1A),
//     DASHBOARD_SHOW(0x1B),
//     HEAD_UP_ANGLE(0x1C),
//     CRC_CHECK(0x16),
//     BMP_END(0x20),
//     SILENT_MODE(0x21),
//     BLE_REQ_TRANSFER_MIC_DATA(0x22),
//     UNK_1(0x23),
//     UNK_2(0x24),
//     BLE_REQ_HEARTBEAT(0x25),
//     BLE_REQ_BATTERY(0x2C),
//     BLE_REQ_EVENAI(0x4E),
//     BLE_REQ_DEVICE_ORDER(0x15);

//     companion object {
//         fun fromByte(value: Byte): Commands? = values().find { it.value == value }
//     }
// }

// enum class CommandResponse(val value: Byte) {
//     ACK(0x01)
// }

// enum class DeviceOrders(val value: Byte) {
//     HEAD_UP(0x01),
//     HEAD_UP2(0x02),
//     HEAD_DOWN2(0x03),
//     ACTIVATED(0x04),
//     SILENCED(0x05),
//     DISPLAY_READY(0x06),
//     TRIGGER_FOR_AI(0x07),
//     TRIGGER_FOR_STOP_RECORDING(0x08),
//     TRIGGER_CHANGE_PAGE(0x09),
//     CASE_REMOVED(0x0A),
//     CASE_REMOVED2(0x0B),
//     CASE_OPEN(0x0C),
//     CASE_CLOSED(0x0D),
//     CASE_CHARGING_STATUS(0x0E),
//     CASE_CHARGE_INFO(0x0F),
//     DOUBLE_TAP(0x10);

//     companion object {
//         fun fromByte(value: Byte): DeviceOrders? = values().find { it.value == value }
//     }
// }

// enum class DeviceTypes {
//     G1
// }

// enum class ConnTypes {
//     CONNECTED,
//     DISCONNECTED,
//     CONNECTING
// }

// object AiMode {
//     const val AI_REQUESTED = "AI_REQUESTED"
//     const val AI_MIC_ON = "AI_MIC_ON"
//     const val AI_IDLE = "AI_IDLE"
// }

// sealed class GlassesError : Exception() {
//     data class MissingGlasses(override val message: String) : GlassesError()
// }

// // Command Queue
// class CommandQueue {
//     private val channel = Channel<BufferedCommand>(Channel.UNLIMITED)

//     suspend fun enqueue(command: BufferedCommand) {
//         channel.send(command)
//     }

//     suspend fun dequeue(): BufferedCommand = channel.receive()
// }

// // Main G1 Class
// class G1(private val context: Context) : SGCManager {

//     // Constants
//     companion object {
//         private const val TAG = "G1"
//         private val UART_SERVICE_UUID = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
//         private val UART_TX_CHAR_UUID = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
//         private val UART_RX_CHAR_UUID = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
//         private val CLIENT_CHARACTERISTIC_CONFIG_UUID =
//                 UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

//         private const val DELAY_BETWEEN_CHUNKS_SEND = 16L // ms
//         private const val DELAY_BETWEEN_SENDS_MS = 8L // ms
//         private const val INITIAL_CONNECTION_DELAY_MS = 350L // ms

//         fun decodeEvenG1SerialNumber(serialNumber: String): Pair<String, String> {
//             if (serialNumber.length < 6) return "Unknown" to "Unknown"

//             val style =
//                     when (serialNumber.getOrNull(2)) {
//                         '0' -> "Round"
//                         '1' -> "Rectangular"
//                         else -> "Round"
//                     }

//             val color =
//                     when (serialNumber.getOrNull(5)) {
//                         'A' -> "Grey"
//                         'B' -> "Brown"
//                         'C' -> "Green"
//                         else -> "Grey"
//                     }

//             return style to color
//         }
//     }

//     // Properties - Connection State
//     override var connectionState: String = ConnTypes.DISCONNECTED
//     override val type = DeviceTypes.G1
//     override val hasMic = true

//     var deviceSearchId = "NOT_SET"
//     private var isDisconnecting = false

//     // Properties - Glasses Info
//     var glassesAppVersion = ""
//     var glassesBuildNumber = ""
//     var glassesDeviceModel = ""
//     var glassesAndroidVersion = ""
//     var glassesOtaVersionUrl = ""
//     var glassesSerialNumber = ""
//     var glassesStyle = ""
//     var glassesColor = ""
//     var wifiSsid = ""
//     var wifiConnected = false
//     var wifiLocalIp = ""
//     var isHotspotEnabled = false
//     var hotspotSsid = ""
//     var hotspotPassword = ""
//     var hotspotGatewayIp = ""

//     // Properties - Battery
//     var caseBatteryLevel = -1
//     var batteryLevel = -1
//     private val _leftBatteryLevel = MutableStateFlow(-1)
//     val leftBatteryLevel: StateFlow<Int> = _leftBatteryLevel
//     private val _rightBatteryLevel = MutableStateFlow(-1)
//     val rightBatteryLevel: StateFlow<Int> = _rightBatteryLevel

//     // Properties - Case Status
//     private val _caseCharging = MutableStateFlow(false)
//     val caseCharging: StateFlow<Boolean> = _caseCharging
//     private val _caseOpen = MutableStateFlow(false)
//     val caseOpen: StateFlow<Boolean> = _caseOpen
//     private val _caseRemoved = MutableStateFlow(true)
//     val caseRemoved: StateFlow<Boolean> = _caseRemoved

//     // Properties - AI & Voice
//     private val _compressedVoiceData = MutableStateFlow(ByteArray(0))
//     val compressedVoiceData: StateFlow<ByteArray> = _compressedVoiceData
//     private val _aiListening = MutableStateFlow(false)
//     val aiListening: StateFlow<Boolean> = _aiListening
//     private var aiMode = AiMode.AI_IDLE
//         set(value) {
//             field = value
//             _aiListening.value = value == AiMode.AI_MIC_ON
//         }

//     // Properties - Quick Notes
//     private val _quickNotes = MutableStateFlow<List<QuickNote>>(emptyList())
//     val quickNotes: StateFlow<List<QuickNote>> = _quickNotes

//     // Properties - Head Position
//     private val _isHeadUp = MutableStateFlow(false)
//     val isHeadUp: StateFlow<Boolean> = _isHeadUp

//     // Properties - Readiness
//     private var _ready = false
//     var ready: Boolean
//         get() = _ready
//         set(value) {
//             val oldValue = _ready
//             _ready = value
//             if (oldValue != value) {
//                 // CoreManager.shared.handleConnectionStateChanged()
//             }
//             if (!value) {
//                 batteryLevel = -1
//                 _leftBatteryLevel.value = -1
//                 _rightBatteryLevel.value = -1
//             }
//         }

//     private var leftReady = false
//     private var rightReady = false
//     private var leftInitialized = false
//     private var rightInitialized = false

//     // Bluetooth
//     private val bluetoothManager: BluetoothManager =
//             context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
//     private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager.adapter
//     private var bluetoothGatt: BluetoothGatt? = null
//     private var leftPeripheral: BluetoothDevice? = null
//     private var rightPeripheral: BluetoothDevice? = null
//     private var leftGatt: BluetoothGatt? = null
//     private var rightGatt: BluetoothGatt? = null

//     // Command Queue & Synchronization
//     private val commandQueue = CommandQueue()
//     private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
//     private val mainHandler = Handler(Looper.getMainLooper())
//     private val pendingAckCompletions = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()

//     // Counters
//     private var globalCounter: Byte = 0
//     private var heartbeatCounter: Byte = 0
//     private var msgId = 100
//     private var writeCompletionCount = 0

//     // Timers
//     private var heartbeatTimer: Timer? = null
//     private var reconnectionTimer: Timer? = null
//     private var reconnectionAttempts = 0
//     private val maxReconnectionAttempts = -1 // unlimited
//     private val reconnectionInterval = 30_000L // 30 seconds

//     // Frame tracking
//     private var lastFrameTime = System.currentTimeMillis()
//     private var frameSequence = 0

//     // Animation
//     private var animationFrames = listOf<String>()
//     private var animationTimer: Timer? = null
//     private var currentFrameIndex = 0
//     private var animationInterval = 1650.0 // ms
//     private var animationRepeat = false
//     private var isAnimationRunning = false

//     // BMP Display
//     private var isDisplayingBMP = false
//     private var lastBMPStartTime = System.currentTimeMillis()

//     // Stored UUIDs for reconnection
//     private var leftGlassUUID: String?
//         get() =
//                 context.getSharedPreferences("G1Prefs", Context.MODE_PRIVATE)
//                         .getString("leftGlassUUID", null)
//         set(value) {
//             context.getSharedPreferences("G1Prefs", Context.MODE_PRIVATE)
//                     .edit()
//                     .putString("leftGlassUUID", value)
//                     .apply()
//         }

//     private var rightGlassUUID: String?
//         get() =
//                 context.getSharedPreferences("G1Prefs", Context.MODE_PRIVATE)
//                         .getString("rightGlassUUID", null)
//         set(value) {
//             context.getSharedPreferences("G1Prefs", Context.MODE_PRIVATE)
//                     .edit()
//                     .putString("rightGlassUUID", value)
//                     .apply()
//         }

//     // Text Helper
//     private val textHelper = G1Text()

//     init {
//         startHeartbeatTimer()
//         setupCommandQueue()
//     }

//     // Lifecycle
//     override fun cleanup() {
//         heartbeatTimer?.cancel()
//         reconnectionTimer?.cancel()
//         scope.cancel()
//         leftGatt?.close()
//         rightGatt?.close()
//     }

//     override fun forget() {
//         leftGlassUUID = null
//         rightGlassUUID = null
//         deviceSearchId = "NOT_SET"

//         heartbeatTimer?.cancel()
//         heartbeatTimer = null

//         stopReconnectionTimer()

//         leftGatt?.close()
//         rightGatt?.close()
//     }

//     // Command Queue Setup
//     private fun setupCommandQueue() {
//         scope.launch {
//             while (isActive) {
//                 val command = commandQueue.dequeue()
//                 processCommand(command)
//             }
//         }
//     }

//     private suspend fun processCommand(command: BufferedCommand) {
//         if (command.chunks.isEmpty()) {
//             Log.w(TAG, "@@@ chunks was empty! @@@")
//             return
//         }

//         // Send to both sides in parallel
//         coroutineScope {
//             if (command.sendLeft) {
//                 launch { attemptSend(command, "L") }
//             }
//             if (command.sendRight) {
//                 launch { attemptSend(command, "R") }
//             }
//         }

//         val waitTime = if (command.waitTime > 0) command.waitTime else 8
//         delay(waitTime.toLong())
//     }

//     private suspend fun attemptSend(cmd: BufferedCommand, side: String) {
//         val maxAttempts = 5
//         var attempts = 0
//         var success = false
//         val chunks = cmd.chunks

//         while (attempts < maxAttempts && !success) {
//             if (attempts > 0) {
//                 Log.d(TAG, "trying again to send to:$side: $attempts")
//             }

//             if (isDisconnecting) break

//             // Send all chunks except the last one without waiting for response
//             for (i in 0 until chunks.size - 1) {
//                 val chunk = chunks[i]
//                 sendCommandToSideWithoutResponse(chunk, side)
//                 delay(cmd.chunkTimeMs.toLong())
//             }

//             val lastChunk = chunks.last()
//             var sequenceNumber = -1

//             // Extract sequence number if applicable
//             if (lastChunk[0] == Commands.BLE_REQ_EVENAI.value) {
//                 sequenceNumber = lastChunk[1].toInt()
//             }
//             if (lastChunk[0] == Commands.CRC_CHECK.value) {
//                 sequenceNumber = lastChunk[1].toInt()
//             }

//             if (cmd.lastFrameMs > 0) {
//                 delay(cmd.lastFrameMs.toLong())
//             }

//             val firstFewBytes = lastChunk.take(8).toByteArray().toHexString().uppercase()
//             if (lastChunk[0] != Commands.BLE_REQ_HEARTBEAT.value) {
//                 Log.d(TAG, "SEND ($side) $firstFewBytes")
//             }

//             // For heartbeats, don't retry and assume success
//             success =
//                     if (lastChunk[0] == Commands.BLE_REQ_HEARTBEAT.value) {
//                         sendCommandToSideWithoutResponse(lastChunk, side)
//                         true
//                     } else {
//                         sendCommandToSide(lastChunk, side, attempts, sequenceNumber)
//                     }

//             attempts++
//             if (!success && attempts >= maxAttempts) {
//                 Log.e(TAG, "❌ Command timed out!")
//                 startReconnectionTimer()
//                 break
//             }

//             if (success) {
//                 stopReconnectionTimer()
//             }
//         }
//     }

//     // BLE Communication
//     private suspend fun sendCommandToSide(
//             command: ByteArray,
//             side: String,
//             attemptNumber: Int = 0,
//             sequenceNumber: Int = -1
//     ): Boolean = suspendCoroutine { continuation ->
//         val gatt = if (side == "L") leftGatt else rightGatt
//         val characteristic =
//                 gatt?.getService(UART_SERVICE_UUID)?.getCharacteristic(UART_TX_CHAR_UUID)

//         if (gatt == null || characteristic == null) {
//             Log.w(TAG, "⚠️ peripheral/characteristic not found, resuming immediately")
//             continuation.resume(false)
//             return@suspendCoroutine
//         }

//         val key = if (sequenceNumber == -1) side else "$side-$sequenceNumber"
//         val deferred = CompletableDeferred<Boolean>()
//         pendingAckCompletions[key] = deferred

//         characteristic.value = command
//         gatt.writeCharacteristic(characteristic)

//         val waitTime = 300L + (200L * attemptNumber)

//         mainHandler.postDelayed(
//                 {
//                     val pending = pendingAckCompletions.remove(key)
//                     if (pending != null && !pending.isCompleted) {
//                         Log.w(TAG, "⚠️ ACK timeout for $key after ${waitTime}ms")
//                         pending.complete(false)
//                     }
//                 },
//                 waitTime
//         )

//         scope.launch {
//             val result = deferred.await()
//             continuation.resume(result)
//         }
//     }

//     private fun sendCommandToSideWithoutResponse(command: ByteArray, side: String) {
//         val gatt = if (side == "L") leftGatt else rightGatt
//         val characteristic =
//                 gatt?.getService(UART_SERVICE_UUID)?.getCharacteristic(UART_TX_CHAR_UUID)

//         if (gatt != null && characteristic != null) {
//             characteristic.value = command
//             characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
//             gatt.writeCharacteristic(characteristic)
//         }
//     }

//     // Queue Chunks
//     fun queueChunks(
//             chunks: List<ByteArray>,
//             sendLeft: Boolean = true,
//             sendRight: Boolean = true,
//             sleepAfterMs: Int = 0,
//             ignoreAck: Boolean = false,
//             chunkTimeMs: Int = 8,
//             lastFrameMs: Int = 100
//     ) {
//         val bufferedCommand =
//                 BufferedCommand(
//                         chunks = chunks,
//                         sendLeft = sendLeft,
//                         sendRight = sendRight,
//                         waitTime = sleepAfterMs,
//                         ignoreAck = ignoreAck,
//                         chunkTimeMs = chunkTimeMs,
//                         lastFrameMs = lastFrameMs
//                 )
//         scope.launch { commandQueue.enqueue(bufferedCommand) }
//     }

//     // Handle ACK
//     private fun handleAck(gatt: BluetoothGatt, success: Boolean, sequenceNumber: Int = -1) {
//         if (!success) return

//         val side = if (gatt == leftGatt) "L" else "R"
//         val key = if (sequenceNumber == -1) side else "$side-$sequenceNumber"

//         val deferred = pendingAckCompletions.remove(key)
//         deferred?.complete(true)
//     }

//     // Readiness Management
//     private fun setReadiness(left: Boolean? = null, right: Boolean? = null) {
//         val prevLeftReady = leftReady
//         val prevRightReady = rightReady

//         left?.let {
//             leftReady = it
//             if (!prevLeftReady && leftReady) {
//                 Log.d(TAG, "Left ready!")
//             }
//         }

//         right?.let {
//             rightReady = it
//             if (!prevRightReady && rightReady) {
//                 Log.d(TAG, "Right ready!")
//             }
//         }

//         ready = leftReady && rightReady
//         if (ready) {
//             stopReconnectionTimer()
//         }
//     }

//     // Commands
//     fun sendInit() {
//         val initData = byteArrayOf(Commands.BLE_REQ_INIT.value, 0x01)
//         queueChunks(listOf(initData))
//     }

//     override fun exit() {
//         val exitData = byteArrayOf(Commands.BLE_EXIT_ALL_FUNCTIONS.value)
//         queueChunks(listOf(exitData))
//     }

//     private fun sendHeartbeat() {
//         incrementHeartbeatCounter()
//         val heartbeatData =
//                 byteArrayOf(
//                         Commands.BLE_REQ_HEARTBEAT.value,
//                         (heartbeatCounter.toInt() and 0xFF).toByte()
//                 )

//         if (ready) {
//             queueChunks(listOf(heartbeatData))
//         }
//     }

//     override fun getBatteryStatus() {
//         Log.d(TAG, "getBatteryStatus()")
//         val command = byteArrayOf(Commands.BLE_REQ_BATTERY.value, 0x01)
//         queueChunks(listOf(command))
//     }

//     override fun setBrightness(level: Int, autoMode: Boolean = false) {
//         val mappedLevel = minOf(41, maxOf(0, (level.toDouble() / 100.0 * 41.0).toInt()))
//         scope.launch { setBrightnessRaw(mappedLevel.toByte(), autoMode) }
//     }

//     private suspend fun setBrightnessRaw(level: Byte, autoMode: Boolean = false): Boolean {
//         Log.d(TAG, "setBrightness()")
//         val lvl = if (level > 0x29) 0x29.toByte() else level
//         val command = byteArrayOf(Commands.BRIGHTNESS.value, lvl, if (autoMode) 0x01 else 0x00)
//         queueChunks(listOf(command))
//         return true
//     }

//     override fun setHeadUpAngle(angle: Int) {
//         val agl = angle.coerceIn(0, 60)
//         scope.launch { setHeadUpAngleRaw(agl.toByte()) }
//     }

//     private suspend fun setHeadUpAngleRaw(angle: Byte): Boolean {
//         Log.d(TAG, "setHeadUpAngle()")
//         val command = byteArrayOf(Commands.HEAD_UP_ANGLE.value, angle, 0x01)
//         queueChunks(listOf(command))
//         return true
//     }

//     override fun setMicEnabled(enabled: Boolean) {
//         Log.d(TAG, "setMicEnabled() $enabled")
//         val micOnData = byteArrayOf(Commands.BLE_REQ_MIC_ON.value, if (enabled) 0x01 else 0x00)
//         queueChunks(listOf(micOnData), sendLeft = false, sendRight = true)
//     }

//     override fun setSilentMode(enabled: Boolean) {
//         val command = byteArrayOf(Commands.SILENT_MODE.value, if (enabled) 0x0C else 0x0A, 0x00)
//         queueChunks(listOf(command))
//     }

//     // Counter Management
//     private fun incrementGlobalCounter() {
//         globalCounter = ((globalCounter.toInt() + 1) and 0xFF).toByte()
//     }

//     private fun incrementHeartbeatCounter() {
//         heartbeatCounter = ((heartbeatCounter.toInt() + 1) and 0xFF).toByte()
//     }

//     // Timers
//     private fun startHeartbeatTimer() {
//         heartbeatTimer?.cancel()
//         heartbeatTimer =
//                 Timer().apply {
//                     scheduleAtFixedRate(
//                             object : TimerTask() {
//                                 override fun run() {
//                                     sendHeartbeat()
//                                 }
//                             },
//                             20_000,
//                             20_000
//                     )
//                 }
//     }

//     private fun startReconnectionTimer() {
//         Log.d(TAG, "Starting reconnection timer")
//         stopReconnectionTimer()
//         reconnectionAttempts = 0

//         reconnectionTimer =
//                 Timer().apply {
//                     scheduleAtFixedRate(
//                             object : TimerTask() {
//                                 override fun run() {
//                                     attemptReconnection()
//                                 }
//                             },
//                             0,
//                             reconnectionInterval
//                     )
//                 }
//     }

//     private fun stopReconnectionTimer() {
//         reconnectionTimer?.cancel()
//         reconnectionTimer = null
//     }

//     private fun attemptReconnection() {
//         Log.d(TAG, "Attempting reconnection (attempt $reconnectionAttempts)...")

//         if (ready) {
//             Log.d(TAG, "G1 is already ready, cancelling reconnection attempt (& timer)")
//             stopReconnectionTimer()
//             return
//         }

//         if (maxReconnectionAttempts > 0 && reconnectionAttempts >= maxReconnectionAttempts) {
//             Log.d(TAG, "Maximum reconnection attempts reached. Stopping reconnection timer.")
//             stopReconnectionTimer()
//             return
//         }

//         reconnectionAttempts++
//         startScan()
//     }

//     // Placeholder methods for SGCManager interface
//     override fun sendButtonMaxRecordingTime() {}
//     override fun requestPhoto(p0: String, appId: String, size: String?, webhookUrl: String?) {}
//     override fun startRtmpStream(p0: Map<String, Any>) {}
//     override fun stopRtmpStream() {}
//     override fun sendRtmpKeepAlive(p0: Map<String, Any>) {}
//     override fun startBufferRecording() {}
//     override fun stopBufferRecording() {}
//     override fun saveBufferVideo(requestId: String, durationSeconds: Int) {}
//     override fun startVideoRecording(requestId: String, save: Boolean) {}
//     override fun stopVideoRecording(requestId: String) {}
//     override fun sendButtonPhotoSettings() {}
//     override fun sendButtonModeSetting() {}
//     override fun sendButtonVideoRecordingSettings() {}
//     override fun sendButtonMaxRecordingTime(p0: Int) {}
//     override fun sendButtonCameraLedSetting() {}
//     override fun showDashboard() {}
//     // override fun setSilentMode(p0: Boolean) {}
//     override fun requestWifiScan() {}
//     override fun sendWifiCredentials(p0: String, p1: String) {}
//     override fun sendHotspotState(p0: Boolean) {}
//     override fun queryGalleryStatus() {}
//     override fun sendJson(p0: Map<String, Any>, wakeUp: Boolean, requireAck: Boolean) {}

//     // Scan and connection methods would go here
//     fun startScan() {
//         // Implementation for BLE scanning
//     }

//     fun disconnect() {
//         isDisconnecting = true
//         leftGlassUUID = null
//         rightGlassUUID = null
//         stopReconnectionTimer()

//         leftGatt?.disconnect()
//         rightGatt?.disconnect()
//         leftGatt?.close()
//         rightGatt?.close()

//         leftPeripheral = null
//         rightPeripheral = null
//         setReadiness(left = false, right = false)
//         Log.d(TAG, "Disconnected from glasses")
//     }
// }

// // Placeholder interfaces and classes
// interface SGCManager {
//     val connectionState: String
//     val type: DeviceTypes
//     val hasMic: Boolean
//     fun sendButtonMaxRecordingTime()
//     fun requestPhoto(p0: String, appId: String, size: String?, webhookUrl: String?)
//     fun startRtmpStream(p0: Map<String, Any>)
//     fun stopRtmpStream()
//     fun sendRtmpKeepAlive(p0: Map<String, Any>)
//     fun startBufferRecording()
//     fun stopBufferRecording()
//     fun saveBufferVideo(requestId: String, durationSeconds: Int)
//     fun startVideoRecording(requestId: String, save: Boolean)
//     fun stopVideoRecording(requestId: String)
//     fun sendButtonPhotoSettings()
//     fun sendButtonModeSetting()
//     fun sendButtonVideoRecordingSettings()
//     fun sendButtonMaxRecordingTime(p0: Int)
//     fun sendButtonCameraLedSetting()
//     fun showDashboard()
//     fun setSilentMode(p0: Boolean)
//     fun requestWifiScan()
//     fun sendWifiCredentials(p0: String, p1: String)
//     fun sendHotspotState(p0: Boolean)
//     fun queryGalleryStatus()
//     fun sendJson(p0: Map<String, Any>, wakeUp: Boolean, requireAck: Boolean)
// }

// // Placeholder for G1Text helper class
// class G1Text {
//     fun createTextWallChunks(text: String): List<ByteArray> {
//         // Implementation for creating text wall chunks
//         return emptyList()
//     }

//     fun createDoubleTextWallChunks(textTop: String, textBottom: String): List<ByteArray> {
//         // Implementation for creating double text wall chunks
//         return emptyList()
//     }
// }
