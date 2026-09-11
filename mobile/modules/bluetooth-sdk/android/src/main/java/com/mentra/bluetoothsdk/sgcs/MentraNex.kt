package com.mentra.bluetoothsdk.sgcs

import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.DeviceStore

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Message
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.content.Context

import mentraos.ble.MentraosBle.GlassesToPhone
import mentraos.ble.MentraosBle.PhoneToGlasses
import mentraos.ble.MentraosBle.ChargingState
import mentraos.ble.MentraosBle.BatteryStatus
import mentraos.ble.MentraosBle.HeadGesture
import mentraos.ble.MentraosBle.ButtonEvent
import mentraos.ble.MentraosBle.ImuData
import mentraos.ble.MentraosBle.ImageTransferComplete
import mentraos.ble.MentraosBle.HeadUpAngleResponse
import mentraos.ble.MentraosBle.HeadPosition
import mentraos.ble.MentraosBle.DeviceInfo

import com.mentra.bluetoothsdk.sgcs.SGCManager
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.NexProtobufUtils
import com.mentra.bluetoothsdk.utils.NexEventUtils
import com.mentra.bluetoothsdk.utils.NexBluetoothConstants
import com.mentra.bluetoothsdk.utils.NexDisplayConstants
import com.mentra.bluetoothsdk.utils.NexBluetoothPacketTypes
import com.mentra.bluetoothsdk.utils.BitmapJavaUtils
import com.mentra.bluetoothsdk.utils.G1FontLoaderKt
import com.mentra.bluetoothsdk.utils.G1Text
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.lc3Lib.Lc3Cpp
import com.mentra.bluetoothsdk.utils.audio.Lc3Player

import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.nio.charset.Charset
import java.util.Random


import org.json.JSONObject

import com.google.protobuf.InvalidProtocolBufferException

class MentraNex : SGCManager() {
    companion object {
        private const val TAG = "MentraNex";

        private const val MTU_517: Int = 517
        private const val MTU_DEFAULT: Int = 23
        
        private const val MAX_CHUNK_SIZE_DEFAULT: Int = 176 // Maximum chunk size for BLE packets
        private const val DELAY_BETWEEN_CHUNKS_SEND: Long = 5 // Adjust this value as needed
        // Upper bound on waiting for onCharacteristicWrite. A no-response write's
        // callback is normally near-instant; this only guards against a callback that
        // never arrives, so a dropped write can't wedge the send queue forever.
        private const val WRITE_CALLBACK_TIMEOUT_MS: Long = 10
        // Upper bound for an acked (write-with-response) fragment. The callback only
        // fires after the firmware's ATT Write Response — at least one connection
        // interval — so 10ms is far too short here: timing out early would let the
        // worker issue the next write while this one is still outstanding, which the
        // stack rejects (one GATT op at a time) and the fragment is dropped. This is a
        // safety bound only; the ack normally arrives within an interval or two.
        private const val WRITE_ACK_TIMEOUT_MS: Long = 400

        private const val INITIAL_CONNECTION_DELAY_MS = 350L // Adjust this value as needed
        // Window to let a queued DisconnectRequest flush to the glasses before we close GATT.
        private const val DISCONNECT_FLUSH_DELAY_MS = 250L
        private const val MICBEAT_INTERVAL_MS: Long = (1000 * 60) * 30; // micbeat every 30 minutes

        private const val MAIN_TASK_HANDLER_CODE_GATT_STATUS_CHANGED: Int = 110
        private const val MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES: Int = 120
        private const val MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED: Int = 210

        // actions of device or gatt
        private const val MAIN_TASK_HANDLER_CODE_CONNECT_DEVICE: Int = 310
        private const val MAIN_TASK_HANDLER_CODE_DISCONNECT_DEVICE: Int = 320
        private const val MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE: Int = 350
        private const val MAIN_TASK_HANDLER_CODE_CANCEL_RECONNECT_DEVICE: Int = 360
        private const val MAIN_TASK_HANDLER_CODE_RECONNECT_GATT: Int = 370
        private const val MAIN_TASK_HANDLER_CODE_SCAN_START: Int = 410
        private const val MAIN_TASK_HANDLER_CODE_SCAN_END: Int = 420

        // actions of NEX Glasses
        private const val MAIN_TASK_HANDLER_CODE_BATTERY_QUERY: Int = 620
        private const val MAIN_TASK_HANDLER_CODE_HEART_BEAT: Int = 630

        // Fixed rect for the live-captions box (G2-style): a single full-canvas text container
        // reused across caption updates, so each caption is an in-place text change that coexists
        // with any bitmap/other components. Matches the 500x220 Mentra display canvas.
        private const val CAPTION_BOX_X: Int = 0
        private const val CAPTION_BOX_Y: Int = 0
        private const val CAPTION_BOX_W: Int = 500
        private const val CAPTION_BOX_H: Int = 220
    }

    private var heartbeatCount: Int = 0;
    private var micBeatCount: Int = 0;

    private var context: Context? = null
    // private var isDebug: Boolean = true

    // Off by default; toggled from Nex Developer Settings via the nex_lc3_audio_playback flag.
    private val isLc3AudioEnabled: Boolean
        get() = DeviceStore.get("bluetooth", "nex_lc3_audio_playback") as? Boolean ?: false
    private var lc3AudioPlayer: Lc3Player? = null

    private var lc3DecoderPtr: Long = 0

    @Volatile private var isImageSendProgressing: Boolean = false

    private var mainDevice: BluetoothDevice? = null
    private var bluetoothAdapter: BluetoothAdapter = BluetoothAdapter.getDefaultAdapter()

    private var isScanningForCompatibleDevices: Boolean = false

    private var isMainConnected = false
    private var isKilled: Boolean = false
    private var lastConnectionTimestamp: Long = 0
    private var lastSendTimestamp: Long = 0
    private var mainReconnectAttempts: Int = 0

    private var lastReceivedLc3Sequence: Int = -1
    
    private val fontLoader: G1FontLoaderKt = G1FontLoaderKt()
    private val textRenderer: G1Text = G1Text()
    private var preferredMainDeviceId: String? = null
    private var savedNexMainName: String? = null
    private var savedNexMainAddress: String? = null

    private var mainGlassGatt: BluetoothGatt? = null
    private var mainWriteChar: BluetoothGattCharacteristic? = null
    private var mainNotifyChar: BluetoothGattCharacteristic? = null
    private var currentMTU: Int = 0
    private var deviceMaxMTU: Int = 0

    private var maxChunkSize: Int = MAX_CHUNK_SIZE_DEFAULT // Maximum chunk size for BLE packets
    private var bmpChunkSize: Int = 194 // BMP chunk size
    private var protobufSeq: Int = 0 // Rolling sequence for fragmented control messages

    @Volatile private var isWorkerRunning = false
    // Queue to hold pending requests
    private val sendQueue = LinkedBlockingQueue<Array<SendRequest>>()
    private val mainWaiter = BooleanWaiter()
    private val mainServicesWaiter = BooleanWaiter()

    private var shouldUseGlassesMic: Boolean = false
    private var microphoneStateBeforeDisconnection: Boolean = false

    private var whiteListedAlready: Boolean = false
    private var isMicrophoneEnabled: Boolean = true
    private var lastThingDisplayedWasAnImage: Boolean = false
    private var isScanning: Boolean = false

    private var protobufVersionPosted: Boolean = false

    private var bleScanCallback: ScanCallback? = null

    private val modernScanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.getDevice()
            val name = device.getName()

            // Now you can reference the bluetoothAdapter field if needed:
            if (!bluetoothAdapter.isEnabled) {
                Log.e(TAG, "Bluetooth is disabled")
                return
            }
            Bridge.log("=== New Device is Found ===$name ${device.address}")
            Bridge.log("=== New Glasses Device Information ===")

            // Log all available device information for debugging
            Bridge.log("=== Device Information ===")
            Bridge.log("Device Name: $name")
            Bridge.log("Device Address: ${device.address}")
            Bridge.log("Device Type: ${device.type}")
            Bridge.log("Device Class: ${device.bluetoothClass}")
            Bridge.log("Bond State: ${device.bondState}")

            if (name == null || (!name.contains("Nex1-") && !name.contains("MENTRA_DISPLAY_"))) {
                return
            }

            // If we already have saved device names for main...
            if (name != null && preferredMainDeviceId != null) {
                if (!name.contains(preferredMainDeviceId!!)) {
                    return // Not a matching device
                }
            }

            // Identify which side (main)
            stopScan()
            mainDevice = device
            mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0) // 1 second delay
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG,"Scan failed with error: $errorCode")
        }
    }

    init {
        context = Bridge.getContext()
        // isDebug = isDebug(context)
        type = DeviceTypes.NEX
        hasMic = true
        DeviceStore.apply("glasses", "micEnabled", false)
        preferredMainDeviceId = DeviceManager.getInstance().deviceName
        
        // Initialize LC3 audio player
        lc3AudioPlayer = Lc3Player(context)
        lc3AudioPlayer?.init()
        if (isLc3AudioEnabled) {
            lc3AudioPlayer?.startPlay()
        }
    }

    /** Start/stop the LC3 player when the nex_lc3_audio_playback flag changes. */
    override fun applyNexAudioPlaybackSetting() {
        if (isLc3AudioEnabled) {
            Bridge.log("Nex: LC3 audio playback enabled - starting player")
            lc3AudioPlayer?.startPlay()
        } else {
            Bridge.log("Nex: LC3 audio playback disabled - stopping player")
            lc3AudioPlayer?.stopPlay()
        }
    }

    private val random: Random = Random()

    private val mainGattCallback: BluetoothGattCallback = createGattCallback()

    private var mainTaskHandler: Handler = Handler(Looper.getMainLooper(), Handler.Callback(::handleMainTaskMessage))
    private var whiteListHandler: Handler = Handler()
    private var micEnableHandler: Handler = Handler()
    private var micBeatHandler: Handler = Handler()
    private var micBeatRunnable: Runnable? = null
    private var notificationHandler: Handler = Handler()
    private var notificationRunnable: Runnable? = null
    private var textWallHandler: Handler = Handler()
    private val textWallRunnable: Runnable? = null
    private var findCompatibleDevicesHandler: Handler? = null

    private var lastHeartbeatSentTime: Long = 0
    private var lastHeartbeatReceivedTime: Long = 0

    private var currentImageChunks: MutableList<ByteArray> = mutableListOf()

    // Data class to represent a send request
    // ack=true issues the fragment as a write-WITH-response (WRITE_TYPE_DEFAULT): the
    // firmware ATT-acks each write, so the worker knows it landed. ack=false is a
    // no-response write (WRITE_TYPE_NO_RESPONSE) — fire-and-forget, used for captions
    // where the newest frame supersedes the last and throughput matters more than
    // per-packet delivery. See processQueue() for how the write type is applied.
    private data class SendRequest( val data: ByteArray, var waitTime: Int = -1, val ack: Boolean = true) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (javaClass != other?.javaClass) return false

            other as SendRequest

            if (!data.contentEquals(other.data)) return false
            if (waitTime != other.waitTime) return false
            if (ack != other.ack) return false

            return true
        }

        override fun hashCode(): Int {
            var result = data.contentHashCode()
            result = 31 * result + waitTime
            result = 31 * result + ack.hashCode()
            return result
        }
    }

    private class BooleanWaiter {
        @Volatile
        private var flag = true // initially true

        @Synchronized
        fun waitWhileTrue() {
            while (flag) {
                (this as Object).wait()
            }
        }

        /** Bounded wait: returns early if the flag is still set after [timeoutMs]. */
        @Synchronized
        fun waitWhileTrue(timeoutMs: Long) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (flag) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) break
                (this as Object).wait(remaining)
            }
        }

        @Synchronized
        fun setTrue() {
            flag = true
        }

        @Synchronized
        fun setFalse() {
            flag = false
            (this as Object).notifyAll()
        }
    }

    // Network Management
    override fun requestWifiScan (scanId: String?) { Bridge.log("Nex: requestWifiScan operation not supported") }
    override fun sendWifiCredentials(ssid: String, password: String) { Bridge.log("Nex: sendWifiCredentials operation not supported") }
    override fun forgetWifiNetwork(ssid: String) { }
    override fun sendHotspotState(enabled: Boolean) { Bridge.log("Nex: sendHotspotState operation not supported") }

    // Gallery: Not supported on Nex (No camera)
    override fun queryGalleryStatus() { Bridge.log("Nex: queryGalleryStatus operation not supported") }
    override fun sendGalleryMode() { Bridge.log("Nex: sendGalleryMode operation not supported") }

    override fun sendVoiceActivityDetectionSetting() {
        val enabled =
            DeviceStore.get("bluetooth", "voice_activity_detection_enabled") as? Boolean
                ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
        Bridge.log("Nex: 🎤 Sending Voice Activity Detection setting to glasses: $enabled")

        if (connectionState != ConnTypes.CONNECTED) {
            Bridge.log("Nex: Cannot send VAD setting - not connected")
            return
        }

        val bytes = NexProtobufUtils.generateVadEnabledRequestCommandBytes(enabled)
        sendDataSequentially(bytes)
        Bridge.sendVoiceActivityDetectionStatus(enabled)
    }

    // Version info: Not supported on Nex (uses protobuf for version info)
    override fun requestVersionInfo() { Bridge.log("Nex: requestVersionInfo operation not supported") }

    // Camera & Media: Not supported on Nex (No camera)
    override fun requestPhoto(request: PhotoRequest) {
        Bridge.log("Nex: requestPhoto operation not supported")
    }
    override fun startStream(message: MutableMap<String, Any>) { Bridge.log("Nex: startStream operation not supported") }
    override fun stopStream() { Bridge.log("Nex: stopStream operation not supported") }
    override fun sendStreamKeepAlive(message: MutableMap<String, Any>) { Bridge.log("Nex: sendStreamKeepAlive operation not supported") }
    override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) { Bridge.log("Nex: startVideoRecording operation not supported") }
    override fun stopVideoRecording(requestId: String) { Bridge.log("Nex: stopVideoRecording operation not supported") }

    // Button Settings: Not supported on Nex
    override fun sendButtonPhotoSettings() { Bridge.log("Nex: sendButtonPhotoSettings operation not supported") }
    override fun sendButtonVideoRecordingSettings() { Bridge.log("Nex: sendButtonVideoRecordingSettings operation not supported") }
    override fun sendButtonMaxRecordingTime() { Bridge.log("Nex: sendButtonMaxRecordingTime operation not supported") }

    override fun sendCameraFovSetting() { Bridge.log("Nex: sendCameraFovSetting operation not supported") }

    override fun sendUserEmailToGlasses(email: String) {  Bridge.log("Nex: sendUserEmailToGlasses operation not supported") }

    override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {
        Bridge.log("Nex: sendIncidentId operation not supported")
    }

    // Connection
    override fun findCompatibleDevices() {
        if (isScanningForCompatibleDevices) {
            Bridge.log("Scan already in progress, skipping...")
            return
        }
        
        isScanningForCompatibleDevices = true
        val scanner = bluetoothAdapter.bluetoothLeScanner ?: run {
            Log.e(TAG, "BluetoothLeScanner not available")
            isScanningForCompatibleDevices = false
            return
        }

        val foundDeviceNames = mutableListOf<String>()
        if (findCompatibleDevicesHandler == null) {
            findCompatibleDevicesHandler = Handler(Looper.getMainLooper())
        }

        // Optional: add filters if you want to narrow the scan
        val filters = mutableListOf<ScanFilter>()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .build()

        // Create a modern ScanCallback instead of the deprecated LeScanCallback
        bleScanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                val name = device.name
                val address = device.address
                
                name?.let {
                    if (it.startsWith("Nex1-") || it.startsWith("MENTRA_DISPLAY_")) {
                        Bridge.log("bleScanCallback onScanResult: $name address $address")
                        synchronized(foundDeviceNames) {
                            if (!foundDeviceNames.contains(it)) {
                                foundDeviceNames.add(it)
                                Bridge.log("Found smart glasses: $name")
                                Bridge.sendDiscoveredDevice(DeviceTypes.NEX, it);
                            }
                        }
                    }
                }
            }

            override fun onBatchScanResults(results: List<ScanResult>) {
                // If needed, handle batch results here
            }

            override fun onScanFailed(errorCode: Int) {
                Log.e(TAG, "BLE scan failed with code: $errorCode")
            }
        }

        // Start scanning
        scanner.startScan(filters, settings, bleScanCallback)
        Bridge.log("Started scanning for smart glasses with BluetoothLeScanner...")
        scanner.flushPendingScanResults(bleScanCallback)
        
        // Stop scanning after 10 seconds (adjust as needed)
        findCompatibleDevicesHandler?.postDelayed({
            bleScanCallback?.let { scanner.stopScan(it) }
            isScanningForCompatibleDevices = false
            bleScanCallback = null
            Bridge.log("Stopped scanning for smart glasses.")
        }, 10000)
    }

    override fun connectById(id: String) {
        preferredMainDeviceId = id
        connectToSmartGlasses()
    }

    override fun getConnectedBluetoothName(): String {
        return mainDevice?.getName() ?: ""
    }

    override fun disconnect() {
        DeviceStore.apply("glasses", "fullyBooted", false)
        destroy()
    }

    override fun forget() {
        DeviceStore.apply("glasses", "fullyBooted", false)
        destroy()
    }

    override fun cleanup() {
        // TODO: Later
        Bridge.log("To be implemented")
    }

    // Device
    override fun setHeadUpAngle(angle: Int) {
        // Validate headUpAngle range (0 ~ 60)
        val validatedAngle = angle.coerceIn(0, 60)
        Bridge.log("Nex: === SENDING HEAD UP ANGLE COMMAND TO GLASSES ===")
        Bridge.log("Nex: Head Up Angle: $validatedAngle degrees (validated range: 0-60)")
        val cmdBytes = NexProtobufUtils.generateHeadUpAngleConfigCommandBytes(angle)
        sendProtobuf(cmdBytes, 10)
    }

    override fun getBatteryStatus() {
        queryBatteryStatus()
    }

    override fun exit() {
        sendDataSequentially(byteArrayOf(0x18.toByte()), 100)
    }

    override fun sendShutdown() {
        Bridge.log("sendShutdown - not supported on Nex")
    }

    override fun sendReboot() {
        Bridge.log("sendReboot - not supported on Nex")
    }

    override fun sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {
        Bridge.log("sendRgbLedControl - not supported on Nex");
        Bridge.sendRgbLedControlResponse(requestId, false, "device_not_supported");
    }

    // Not supported in Nex
    override fun setSilentMode(enabled: Boolean) { Bridge.log("Nex: setSilentMode operation not supported") }

    // Display
    override fun setBrightness(level: Int, autoMode: Boolean) {
        // TODO: test this logic. Is it correct? Should we send both or just one?
        Bridge.log("Nex: setBrightness() - level: " + level + "%, autoMode: " + autoMode);
        val brightnessCmdBytes = NexProtobufUtils.generateBrightnessConfigCommandBytes(level)
        sendProtobuf(brightnessCmdBytes, 10)

        val autoBrightnessCmdBytes = NexProtobufUtils.generateAutoBrightnessConfigCommandBytes(autoMode)
        sendProtobuf(autoBrightnessCmdBytes, 10)
    }

    override fun clearDisplay() {
        Bridge.log("Nex: clearDisplay() - clearing canvas + caption");
        // Tear down any canvas components (bitmap + positioned text) and forget the element mapping
        // + active layout, then clear the caption text path too so either kind of screen is wiped.
        canvasElements.clear()
        currentLayoutId = null
        sendProtobuf(NexProtobufUtils.generateCanvasClearCommandBytes(), 10)
        val clearDisplayPackets = NexProtobufUtils.generateClearDisplayRequestCommandBytes()
        sendProtobuf(clearDisplayPackets, 10)
        Bridge.log("Nex: clearDisplay() - sent");
    }
    

    override fun sendText(text: String) {
        Bridge.log("Nex: sendText() - text: " + text);
        showCaptionText(text)
    }

    override fun sendTextWall(text: String) {
        Bridge.log("Nex: sendTextWall() - text: " + text);
        showCaptionText(text)
    }

    override fun sendDoubleTextWall(top: String, bottom: String) {
        Bridge.log("Nex: sendDoubleTextWall() - top: " + top + ", bottom: " + bottom);
        val finalText: String = listOf(top, bottom).filter { it.isNotEmpty() }.joinToString("\n")
        showCaptionText(finalText)
    }

    // Live captions / text walls render into a single reused canvas text container (the caption
    // box), like Even G2: the first call creates it, each subsequent call is an in-place text
    // update on the same component (reused by rect via sendPositionedText), so captions can sit
    // alongside a navigation minimap or other canvas components instead of owning the screen.
    private fun showCaptionText(text: String) {
        // Captions are high-frequency, replace-in-place updates where the newest frame
        // supersedes the last, so they go out WITHOUT ATT acks (write-no-response) for
        // throughput — every other command uses acked writes. Route through upsertText
        // directly (rather than the public sendPositionedText override, which can't take
        // an ack flag) using the same rect-synthesized element id so reuse still works.
        val elementId = "text@$CAPTION_BOX_X,$CAPTION_BOX_Y,${CAPTION_BOX_W}x$CAPTION_BOX_H,0,0"
        upsertText(elementId, null, text, CAPTION_BOX_X, CAPTION_BOX_Y, CAPTION_BOX_W, CAPTION_BOX_H, 0, 0, ack = false)
    }

    // ---- Canvas text containers (G2-style) -------------------------------------------------
    // Positioned text is drawn as canvas TEXTBOX components so it coexists with the bitmap
    // component (a navigation screen = minimap + several text boxes shown together). Components
    // are keyed by their rect+border and reused so repeated updates don't recreate the LVGL
    // object; ids come from the firmware's text pool (1..6) with oldest-out eviction.
    // Retained-mode canvas registry: elementId -> firmware component. The layout path (nav HUD)
    // passes explicit element ids; legacy callers (captions, one-off bitmaps) synthesize an id from
    // their rect, so reuse/update works for them through the same path. Text ids come from the
    // firmware pool 1..6, bitmaps from 10..13.
    private data class CanvasElement(val firmwareId: Int, val isBitmap: Boolean, val rect: String)
    private val canvasElements = LinkedHashMap<String, CanvasElement>()
    private val canvasTextIdPool: List<Int> = listOf(1, 2, 3, 4, 5, 6)
    private val canvasBitmapIdPool: List<Int> = listOf(10, 11, 12, 13)
    // Active layout/scene id. A display call carrying a DIFFERENT layoutId clears the previous scene
    // first (retained-mode contract); legacy calls (null layoutId) leave it untouched.
    private var currentLayoutId: String? = null

    /**
     * Handle a scene/layout change. DeviceManager sweeps the previous app's
     * elements before a cross-app frame arrives, so the registry is usually
     * empty here and switching costs nothing. Only when stale components remain
     * (e.g. legacy callers with no sweep) do we delete them — individually, NOT
     * via CanvasClear: clear also exits the canvas VIEW (the first create
     * re-activates it), which reads as a full-screen flash.
     */
    private fun ensureLayout(layoutId: String?) {
        if (layoutId != null && layoutId != currentLayoutId) {
            if (canvasElements.isNotEmpty()) {
                for (el in canvasElements.values) {
                    sendProtobuf(NexProtobufUtils.generateCanvasDeleteComponentCommandBytes(el.firmwareId))
                }
                canvasElements.clear()
            }
            currentLayoutId = layoutId
        }
    }

    /**
     * A replay frame (reconnect / firmware recovery / re-dispatch) repaints from
     * scratch: forget the registry so every element takes the CREATE path.
     * Create-on-existing-id is replace in firmware, so repainting over a live
     * canvas is safe, and updates-to-dead-ids (which firmware drops silently)
     * can never happen.
     */
    override fun onSceneReplay(appId: String) {
        canvasElements.clear()
        currentLayoutId = appId
    }

    /**
     * Free firmware id from the type's pool. When the pool is exhausted the
     * OLDEST registered element of that type is evicted for real: its firmware
     * component is deleted and its id reused (LinkedHashMap preserves insertion
     * order).
     */
    private fun allocFirmwareId(isBitmap: Boolean): Int? {
        val pool = if (isBitmap) canvasBitmapIdPool else canvasTextIdPool
        val used = canvasElements.values.filter { it.isBitmap == isBitmap }.map { it.firmwareId }.toSet()
        pool.firstOrNull { it !in used }?.let {
            return it
        }
        // Pool full — evict the oldest same-type element.
        val oldest = canvasElements.entries.firstOrNull { it.value.isBitmap == isBitmap } ?: return null
        Bridge.log("Nex: pool full — evicting oldest ${if (isBitmap) "bitmap" else "text"} element '${oldest.key}' (fw id ${oldest.value.firmwareId})")
        sendProtobuf(NexProtobufUtils.generateCanvasDeleteComponentCommandBytes(oldest.value.firmwareId))
        canvasElements.remove(oldest.key)
        return oldest.value.firmwareId
    }

    // Legacy positioned text: identity is the rect, so repeated updates reuse the component.
    override fun sendPositionedText(
        text: String, x: Int, y: Int, width: Int, height: Int, borderWidth: Int, borderRadius: Int
    ) {
        upsertText("text@$x,$y,${width}x$height,$borderWidth,$borderRadius", null,
            text, x, y, width, height, borderWidth, borderRadius)
    }

    override fun drawLayoutText(
        text: String, x: Int, y: Int, width: Int, height: Int,
        borderWidth: Int, borderRadius: Int, elementId: String, layoutId: String?
    ) {
        upsertText(elementId, layoutId, text, x, y, width, height, borderWidth, borderRadius)
    }

    private fun upsertText(
        elementId: String, layoutId: String?, text: String,
        x: Int, y: Int, width: Int, height: Int, borderWidth: Int, borderRadius: Int,
        ack: Boolean = true
    ) {
        ensureLayout(layoutId)
        val rect = "$x,$y,${width}x$height,$borderWidth,$borderRadius"
        val existing = canvasElements[elementId]
        if (existing != null && !existing.isBitmap) {
            if (existing.rect != rect) {
                // Geometry moved/resized — recreate the box at the SAME firmware id, then set text.
                sendProtobuf(NexProtobufUtils.generateCanvasCreateTextboxCommandBytes(
                    existing.firmwareId, x, y, width, height, borderWidth, borderRadius), ack = ack)
                canvasElements[elementId] = existing.copy(rect = rect)
            }
            sendProtobuf(NexProtobufUtils.generateCanvasUpdateTextCommandBytes(existing.firmwareId, text), ack = ack)
            return
        }
        val fid = allocFirmwareId(false)
        if (fid == null) {
            Bridge.log("Nex: text pool full (>6) — dropping element '$elementId'")
            return
        }
        canvasElements[elementId] = CanvasElement(fid, false, rect)
        sendProtobuf(NexProtobufUtils.generateCanvasCreateTextboxCommandBytes(
            fid, x, y, width, height, borderWidth, borderRadius), ack = ack)
        sendProtobuf(NexProtobufUtils.generateCanvasUpdateTextCommandBytes(fid, text), ack = ack)
    }

    override fun removeLayoutElement(elementId: String, layoutId: String?) {
        val slot = canvasElements.remove(elementId) ?: return
        sendProtobuf(NexProtobufUtils.generateCanvasDeleteComponentCommandBytes(slot.firmwareId))
    }

    private data class NexBmp(val data: ByteArray, val w: Int, val h: Int)

    /**
     * Decode a base64 image to the glasses-native 1-bit BMP at the requested size. The panel is
     * 1-bpp and renders white-on-black, so we scale to the rect, invert, then Floyd–Steinberg dither
     * (preserving gradients as dot patterns instead of a hard 50% threshold) before the 1-bit encode.
     */
    private fun decodeBitmapForNex(base64ImageData: String, width: Int?, height: Int?): NexBmp? {
        return try {
            val bmpData = android.util.Base64.decode(base64ImageData, android.util.Base64.DEFAULT)
            if (bmpData == null || bmpData.isEmpty()) {
                Log.e(TAG, "Failed to decode base64 image data")
                return null
            }
            val bmp = BitmapFactory.decodeByteArray(bmpData, 0, bmpData.size)
            val destW = width ?: bmp.width
            val destH = height ?: bmp.height
            val scaled = Bitmap.createScaledBitmap(bmp, destW, destH, true)
            val inverted = invertBitmap(scaled)
            val dithered = floydSteinbergDither(inverted)
            NexBmp(BitmapJavaUtils.convertBitmapTo1BitBmpBytes(dithered, false), destW, destH)
        } catch (e: Exception) {
            Log.e(TAG, "Error decoding bitmap: " + e.message)
            null
        }
    }

    // Legacy one-off bitmap: identity is the rect (no layout scene).
    override fun displayBitmap(
            base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?
    ): Boolean {
        val nb = decodeBitmapForNex(base64ImageData, width, height) ?: return false
        upsertBitmap("bmp@${x ?: 0},${y ?: 0},${nb.w}x${nb.h}", null, nb.data, x ?: 0, y ?: 0, nb.w, nb.h)
        return true
    }

    override fun drawLayoutBitmap(
            base64ImageData: String, x: Int, y: Int, width: Int, height: Int,
            elementId: String, layoutId: String?
    ): Boolean {
        val nb = decodeBitmapForNex(base64ImageData, width, height) ?: return false
        upsertBitmap(elementId, layoutId, nb.data, x, y, nb.w, nb.h)
        return true
    }

    private fun upsertBitmap(
        elementId: String, layoutId: String?, bmpData: ByteArray, x: Int, y: Int, w: Int, h: Int
    ) {
        ensureLayout(layoutId)
        val rect = "$x,$y,${w}x$h"
        val existing = canvasElements[elementId]
        val fid: Int
        if (existing != null && existing.isBitmap) {
            fid = existing.firmwareId
            if (existing.rect != rect) {
                sendProtobuf(NexProtobufUtils.generateCanvasCreateBitmapCommandBytes(fid, x, y, w, h))
                canvasElements[elementId] = existing.copy(rect = rect)
            }
        } else {
            val alloc = allocFirmwareId(true)
            if (alloc == null) {
                Bridge.log("Nex: bitmap pool full (>4) — dropping element '$elementId'")
                return
            }
            fid = alloc
            canvasElements[elementId] = CanvasElement(fid, true, rect)
            sendProtobuf(NexProtobufUtils.generateCanvasCreateBitmapCommandBytes(fid, x, y, w, h))
        }
        streamBitmapPixels(fid, bmpData)
    }
    override fun showDashboard() {
        exit()
    }

    override fun setDashboardPosition(height: Int, depth: Int) {
        Bridge.log("Nex: setDashboardPosition() - height: " + height + ", depth: " + depth)
        // Send display_height then display_distance; adjust order if Nex firmware requires otherwise.
        val heightBytes = NexProtobufUtils.generateDisplayHeightCommandBytes(height)
        sendProtobuf(heightBytes, 10)
        val distanceCm = NexProtobufUtils.dashboardDepthToDistanceCm(depth)
        val distanceBytes = NexProtobufUtils.generateDisplayDistanceCommandBytes(distanceCm)
        sendProtobuf(distanceBytes, 10)
    }

    override fun setDashboardHeightOnly(height: Int) {
        Bridge.log("Nex: setDashboardHeightOnly() - height: $height")
        val heightBytes = NexProtobufUtils.generateDisplayHeightCommandBytes(height)
        sendProtobuf(heightBytes, 10)
    }

    override fun setDashboardDepthOnly(depth: Int) {
        Bridge.log("Nex: setDashboardDepthOnly() - depth: $depth")
        val distanceCm = NexProtobufUtils.dashboardDepthToDistanceCm(depth)
        val distanceBytes = NexProtobufUtils.generateDisplayDistanceCommandBytes(distanceCm)
        sendProtobuf(distanceBytes, 10)
    }

    override fun ping() {
        Bridge.log("Nex: ping()");
    }

    override fun dbg1() {}
    override fun dbg2() {}

    // Audio Control
    // TODO: Validate this logic. looks weird.
    override fun setMicEnabled(enabled: Boolean) {
        Bridge.log("Nex: setMicEnabled(): $enabled")
        // Update the shouldUseGlassesMic flag to reflect the current state
        shouldUseGlassesMic = enabled
        Bridge.log("Nex: Updated shouldUseGlassesMic to: $shouldUseGlassesMic")
        if (enabled) {
            Bridge.log("Nex: Microphone enabled, starting audio input handling")
            startMicBeat(MICBEAT_INTERVAL_MS.toInt())
        } else {
            Bridge.log("Nex: Microphone disabled, stopping audio input handling")
            stopMicBeat()
        }
    }

    override fun sortMicRanking(list: MutableList<String>): MutableList<String> {
        return list
    }

    //==================== HELPER FUNCTIONS =================================================
    private fun createGattCallback(): BluetoothGattCallback {
        return object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                Bridge.log("onConnectionStateChange status State ${status == BluetoothGatt.GATT_SUCCESS}")
                Bridge.log("onConnectionStateChange connected State ${newState == BluetoothProfile.STATE_CONNECTED}")

                if (status == BluetoothGatt.GATT_SUCCESS) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Bridge.log("glass connected, discovering services...")
                        gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                        gatt.setPreferredPhy(
                            BluetoothDevice.PHY_LE_2M_MASK, 
                            BluetoothDevice.PHY_LE_2M_MASK,
                            BluetoothDevice.PHY_OPTION_NO_PREFERRED
                        )

                        isMainConnected = true
                        mainReconnectAttempts = 0
                        Bridge.log("Both glasses connected. Stopping BLE scan.")
                        stopScan()

                        if (!isWorkerRunning) {
                            Bridge.log("Worker thread is not running. Starting it.")
                            startWorkerIfNeeded()
                        }

                        Bridge.log("Discover services calling...")
                        gatt.discoverServices()
                        updateConnectionState()
                        mainDevice?.let { device ->
                            savedNexMainName = device.name
                            savedNexMainAddress = device.address
                            // savePairedDeviceNames()
                            // savePairedDeviceAddress()
                        }
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        handleDisconnection(gatt)
                    }
                } else {
                    handleConnectionFailure(gatt, status)
                }
            }

            private fun handleDisconnection(gatt: BluetoothGatt) {
                Bridge.log("glass disconnected, stopping heartbeats")
                Bridge.log("Entering STATE_DISCONNECTED branch")

                // The glasses lose their canvas on disconnect — forget the
                // component registry so post-reconnect frames take the CREATE
                // path (firmware silently drops updates to dead component ids).
                // The host replays the current scene after reconnect.
                canvasElements.clear()
                currentLayoutId = null

                // Save current microphone state before disconnection
                microphoneStateBeforeDisconnection = isMicrophoneEnabled
                Bridge.log("Saved microphone state before disconnection: $microphoneStateBeforeDisconnection")
                
                // Reset protobuf version posted flag for next connection
                protobufVersionPosted = false
                
                // Reset chunk sizes to defaults
                maxChunkSize = MAX_CHUNK_SIZE_DEFAULT
                bmpChunkSize = MAX_CHUNK_SIZE_DEFAULT
                mainServicesWaiter.setTrue()
                mainWaiter.setFalse()
                Bridge.log("[BLE] Disconnect: reset mainServicesWaiter=true, mainWaiter=false (unblock any in-flight write). isWorkerRunning=$isWorkerRunning")
                forceSideDisconnection()
                Bridge.log("Called forceSideDisconnection()")
                currentMTU = 0
                
                // Stop any periodic transmissions
                stopMicBeat()
                sendQueue.clear()
                Bridge.log("Stopped heartbeat monitoring and mic beat; cleared sendQueue")
                updateConnectionState()
                Bridge.log("Updated connection state after disconnection")

                // gatt.device?.let {
                //     Bridge.log("Closing GATT connection for device: ${it.address}")
                //     gatt.disconnect()
                //     gatt.close()
                //     Bridge.log("GATT connection closed")
                // } ?: run {
                //     Bridge.log("No GATT device available to disconnect")
                // }

                mainTaskHandler?.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 2000)
            }

            private fun handleConnectionFailure(gatt: BluetoothGatt, status: Int) {
                // Same as handleDisconnection: the glasses lose their canvas —
                // forget the component registry so post-reconnect frames take
                // the CREATE path (fw silently drops updates to dead ids).
                canvasElements.clear()
                currentLayoutId = null

                // Save current microphone state before connection failure
                microphoneStateBeforeDisconnection = isMicrophoneEnabled
                Bridge.log("Saved microphone state before connection failure: $microphoneStateBeforeDisconnection")
                
                currentMTU = 0
                maxChunkSize = MAX_CHUNK_SIZE_DEFAULT
                bmpChunkSize = MAX_CHUNK_SIZE_DEFAULT
                Bridge.log("Unexpected connection state encountered for glass: $status")
                stopMicBeat()
                sendQueue.clear()

                // Mark as not ready
                mainServicesWaiter.setTrue()
                mainWaiter.setFalse()
                Bridge.log("[BLE] ConnectionFailure: reset mainServicesWaiter=true, mainWaiter=false (unblock any in-flight write). isWorkerRunning=$isWorkerRunning")
                Bridge.log("Stopped heartbeat monitoring and mic beat; cleared sendQueue due to connection failure")
                Bridge.log("glass connection failed with status: $status")
                
                isMainConnected = false
                mainReconnectAttempts++
                
                mainGlassGatt?.let {
                    it.disconnect()
                    it.close()
                    mainGlassGatt = null
                }

                forceSideDisconnection()
                Bridge.log("Called forceSideDisconnection() after connection failure")
                Bridge.log("GATT connection disconnected and closed due to failure")
                updateConnectionState()

                mainTaskHandler?.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 2000)
            }

            private fun forceSideDisconnection() {
                Bridge.log("forceSideDisconnection() called")
                isMainConnected = false
                mainReconnectAttempts++
                Bridge.log("Main glass: Marked as disconnected and incremented mainReconnectAttempts to $mainReconnectAttempts")
                
                mainGlassGatt?.let {
                    Bridge.log("Main glass GATT exists. Disconnecting and closing mainGlassGatt")
                    it.disconnect()
                    it.close()
                    mainGlassGatt = null
                } ?: run {
                    Bridge.log("Main glass GATT is already null")
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val statusBool = status == BluetoothGatt.GATT_SUCCESS
                mainTaskHandler?.obtainMessage(
                    MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES,
                    statusBool
                )?.sendToTarget()
            }

            override fun onCharacteristicWrite(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                mainWaiter.setFalse()
            }

            override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
                val statusStr = if (status == BluetoothGatt.GATT_SUCCESS) "SUCCESS" else "FAILED($status)"
                Bridge.log("[BLE] onDescriptorWrite: $statusStr — releasing mainServicesWaiter, worker can now send")
                mainServicesWaiter.setFalse()
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                val statusBool = status == BluetoothGatt.GATT_SUCCESS
                Bridge.log("🔄 MTU Negotiation Result: Success=$statusBool, Device MTU=$mtu, Status=$status")
                
                if (statusBool) {
                    // Store device capability and calculate actual negotiated MTU
                    deviceMaxMTU = mtu // Record what device actually supports
                    // The actual negotiated MTU is the minimum of our request and device capability
                    currentMTU = MTU_517.coerceAtMost(mtu)
                    
                    Bridge.log("🎯 MTU Negotiation Complete:")
                    Bridge.log("   📱 App Requested: $MTU_517 bytes")
                    Bridge.log("   📡 Device Supports: $deviceMaxMTU bytes")
                    Bridge.log("   🤝 Negotiated MTU: $currentMTU bytes")
                    
                    // Calculate optimal chunk sizes based on negotiated MTU
                    maxChunkSize = currentMTU - 10
                    bmpChunkSize = currentMTU - 20 // BMP has more config bytes
                    
                    Bridge.log("✅ MTU Configuration Complete:")
                    Bridge.log("   📊 Final MTU: $currentMTU bytes")
                    Bridge.log("   📦 Data Chunk Size: $maxChunkSize bytes")
                    Bridge.log("   🖼️ Image Chunk Size: $bmpChunkSize bytes")
                    Bridge.log("   🔧 Device Maximum: $deviceMaxMTU bytes")
                } else {
                    Bridge.log("❌ MTU Request Failed - Status: $status, Requested: $mtu")
                    
                    // Simple fallback strategy: 247 → 23
                    if (mtu == MTU_517) {
                        Bridge.log("🔄 247 bytes failed, trying default: $MTU_DEFAULT bytes...")
                        Bridge.log("📤 Requesting MTU: $MTU_DEFAULT bytes (fallback)")
                        gatt.requestMtu(MTU_DEFAULT)
                    } else {
                        Bridge.log("⚠️ All MTU requests failed, using defaults")
                        currentMTU = MTU_DEFAULT
                        deviceMaxMTU = MTU_DEFAULT
                        maxChunkSize = MAX_CHUNK_SIZE_DEFAULT
                        bmpChunkSize = MAX_CHUNK_SIZE_DEFAULT
                        
                        Bridge.log("📋 Fallback Configuration:")
                        Bridge.log("   📊 Default MTU: $MTU_DEFAULT bytes")
                        Bridge.log("   📦 Data Chunk Size: $maxChunkSize bytes")
                        Bridge.log("   🖼️ Image Chunk Size: $bmpChunkSize bytes")
                    }
                }
            }

            override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                val msg = Message.obtain().apply {
                    what = MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED
                    obj = characteristic // Attach any object you want
                }
                mainTaskHandler.sendMessage(msg)
            }
        }
    }

    private fun handleMainTaskMessage(msg: Message): Boolean {
        val msgCode = msg.what
        // NOTE: do not log here. Every incoming BLE notification (including
        // ~50 audio packets/sec) is dispatched through this handler on the
        // main looper, and Bridge.log marshals an event across the RN bridge
        // to JS. Per-message logging here floods the main thread and backs up
        // the audio queue when the CPU downclocks at screen-off. (Matches G1,
        // which does not log per audio packet.)
        when (msgCode) {
            MAIN_TASK_HANDLER_CODE_GATT_STATUS_CHANGED -> {}
            MAIN_TASK_HANDLER_CODE_DISCOVER_SERVICES -> {
                val statusBool = msg.obj as? Boolean ?: false
                if (statusBool) {
                    mainGlassGatt?.let { initNexGlasses(it) }
                }
            }
            MAIN_TASK_HANDLER_CODE_CHARACTERISTIC_VALUE_NOTIFIED -> {
                val characteristic = msg.obj as? BluetoothGattCharacteristic
                characteristic?.let { onCharacteristicChangedHandler(it) }
            }
            MAIN_TASK_HANDLER_CODE_CONNECT_DEVICE -> {}
            MAIN_TASK_HANDLER_CODE_DISCONNECT_DEVICE -> {}
            MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE -> {
                mainDevice?.let { attemptGattConnection(it) }
            }
            MAIN_TASK_HANDLER_CODE_CANCEL_RECONNECT_DEVICE -> {}
            MAIN_TASK_HANDLER_CODE_RECONNECT_GATT -> {}
            MAIN_TASK_HANDLER_CODE_SCAN_START -> {}
            MAIN_TASK_HANDLER_CODE_SCAN_END -> {}
            MAIN_TASK_HANDLER_CODE_BATTERY_QUERY -> {
                queryBatteryStatus()
            }
            MAIN_TASK_HANDLER_CODE_HEART_BEAT -> {
                // Note: Heartbeat is now handled by receiving ping from glasses
                // This case is kept for backward compatibility but no longer used
            }
            else -> { }
        }

        return true
    }

    private fun initNexGlasses(gatt: BluetoothGatt) {
        // Start MTU discovery with our maximum target
        Bridge.log("Nex: 🔍 MTU Discovery: Requesting maximum MTU size: $MTU_517")
        Bridge.log("Nex: 🎯 Target: Use $MTU_517 bytes max, or $MTU_DEFAULT bytes default")
        Bridge.log("Nex: 📤 Requesting MTU: $MTU_517 bytes")
        gatt.requestMtu(MTU_517) // Request our maximum MTU

        val uartService: BluetoothGattService? = gatt.getService(NexBluetoothConstants.MAIN_SERVICE_UUID)

        if (uartService != null) {
            val writeChar = uartService.getCharacteristic(NexBluetoothConstants.WRITE_CHAR_UUID)
            val notifyChar = uartService.getCharacteristic(NexBluetoothConstants.NOTIFY_CHAR_UUID)

            writeChar?.let {
                mainWriteChar = it
                // Write type is now chosen PER FRAGMENT in processQueue (acked for
                // everything except captions), so it's set there right before each
                // write rather than once here. Captions still use write-without-
                // response — which unblocks TX from the ~1-packet-per-connection-
                // interval ATT round-trip when the phone sleeps and the interval is
                // relaxed — while every other command is acked for reliable delivery.
                Bridge.log("Nex: glass TX characteristic found (write type set per-fragment)")
            }

            notifyChar?.let {
                mainNotifyChar = it
                enableNotification(gatt, it)
                Bridge.log("Nex: glass RX characteristic found")
            }

            // Mark as connected but wait for setup below to update connection state
            isMainConnected = true
            Bridge.log("Nex: PROC_QUEUE - left side setup complete")

            if (isMainConnected) {
                // Do first battery status query
                mainTaskHandler.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_BATTERY_QUERY, 10)

                // Restore previous microphone state or disable if this is the first connection
                val shouldRestoreMic = microphoneStateBeforeDisconnection
                Bridge.log("Nex: `Restoring microphone state to: $shouldRestoreMic (previous state: $microphoneStateBeforeDisconnection)")

                if (shouldRestoreMic) {
                    startMicBeat(MICBEAT_INTERVAL_MS.toInt())
                }

                // Enable our AugmentOS notification key
                sendWhiteListCommand(10)

                showHomeScreen() // Turn on the NexGlasses display
                updateConnectionState()

                // Post protobuf schema version information (only once)
                if (!protobufVersionPosted) {
                    postProtobufSchemaVersionInfo()
                    protobufVersionPosted = true
                }

                // Query glasses protobuf version from firmware
                Bridge.log("=== SENDING GLASSES PROTOBUF VERSION REQUEST ===")
                val versionQueryPacket = NexProtobufUtils.generateVersionRequestCommandBytes()
                if (versionQueryPacket.isNotEmpty()) {
                    sendProtobuf(versionQueryPacket, 100)
                    Bridge.log("Sent glasses protobuf version request")
                } else {
                    Bridge.log("Skipping version request: schema removed VersionRequest")
                }

                // Push current glasses-side Voice Activity Detection setting
                sendVoiceActivityDetectionSetting()
            }
        } else {
            Log.e(TAG, " glass UART service not found")
        }
    }

    private fun enableNotification(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        Bridge.log("Nex: PROC_QUEUE - Starting notification setup")
        
        // Enable notifications
        val result = gatt.setCharacteristicNotification(characteristic, true)
        Bridge.log("Nex: PROC_QUEUE - setCharacteristicNotification result: $result")

        // NOTE: write type is NOT set here. This receives the *notify*
        // characteristic, which the phone never writes to — setting writeType
        // on it had no effect. The write characteristic (mainWriteChar) is
        // configured for WRITE_TYPE_NO_RESPONSE at its assignment instead.

        // Add delay
        Bridge.log("Nex: PROC_QUEUE - waiting to enable notification...")
        try {
            Thread.sleep(100)
        } catch (e: InterruptedException) {
            Log.e(TAG, "Error sending data: ${e.message}")
        }

        // Get and configure descriptor
        val descriptor = characteristic.getDescriptor(NexBluetoothConstants.CLIENT_CHARACTERISTIC_CONFIG_UUID)
        descriptor?.let {
            it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            val writeResult = gatt.writeDescriptor(it)
            Bridge.log("Nex: PROC_QUEUE - set descriptor with result: $writeResult")
        }
    }

    private fun onCharacteristicChangedHandler(characteristic: BluetoothGattCharacteristic) {
        if (characteristic.uuid == NexBluetoothConstants.NOTIFY_CHAR_UUID) {
            val data = characteristic.value
            val deviceName = mainGlassGatt?.device?.name ?: return
            // NOTE: this runs on the main looper for every notification, audio
            // included (~50/sec). Do not log or stringify the whole packet to
            // hex on this hot path — Bridge.log crosses the RN bridge to JS and
            // packetHex is O(n) per packet. Both back up the audio queue at
            // screen-off. packetHex is only needed by the protobuf branch, so
            // compute it lazily there.
            if (data.isEmpty()) return

            val packetType = data[0]

            when (packetType) {
                NexBluetoothPacketTypes.PACKET_TYPE_JSON -> {
                    val jsonData = data.copyOfRange(1, data.size)
                    decodeJsons(jsonData)
                }
                NexBluetoothPacketTypes.PACKET_TYPE_PROTOBUF -> {
                    val protobufData = data.copyOfRange(1, data.size)
                    val packetHex = data.joinToString("") { "%02X".format(it) }
                    decodeProtobufs(protobufData, packetHex)
                }
                NexBluetoothPacketTypes.PACKET_TYPE_AUDIO -> {
                    // Check for audio packet header
                    if (data[0] == 0xA0.toByte()) {
                        val sequenceNumber = data[1]
                        val receiveTime = System.currentTimeMillis()

                        // Basic sequence validation
                        if (lastReceivedLc3Sequence != -1 && (lastReceivedLc3Sequence + 1).toByte() != sequenceNumber) {
                            Bridge.log("LC3 packet sequence mismatch. Expected: ${lastReceivedLc3Sequence + 1}, Got: $sequenceNumber")
                        }
                        lastReceivedLc3Sequence = sequenceNumber.toInt()

                        val lc3Data = data.copyOfRange(2, data.size)

                        // No per-packet log here: this fires ~50x/sec and each
                        // Bridge.log crosses the RN bridge to JS. (Matches G1.)

                        // Play LC3 audio directly through LC3 player.
                        // No logging in any branch: this runs per audio packet
                        // (~50/sec) and Bridge.log crosses the RN bridge to JS.
                        // With isLc3AudioEnabled hardcoded off, the disabled
                        // branch would otherwise log on every single packet.
                        if (lc3AudioPlayer != null && isLc3AudioEnabled) {
                            // Use the original packet format that LC3 player expects
                            lc3AudioPlayer?.write(data, 0, data.size)
                        }

                        DeviceManager.getInstance().handleGlassesMicData(lc3Data);

                        // Still decode for callback compatibility
                        // TODO: (Verify) Commenting because commented in G1
                        // if (lc3DecoderPtr != 0L) {
                        //     val pcmData = Lc3Cpp.decodeLC3(lc3DecoderPtr, lc3Data)
                        //     Bridge.log("pcmData size:${pcmData?.size ?: 0}")
                        //     audioProcessingCallback?.let { callback ->
                        //         if (!pcmData.isNullOrEmpty()) {
                        //             callback.onAudioDataAvailable(pcmData)
                        //         }
                        //     } ?: run {
                        //         // If we get here, it means the callback wasn't properly registered
                        //         Log.e(TAG,"Audio processing callback is null - callback registration failed!")
                        //     }
                        // }
                    }
                }
                NexBluetoothPacketTypes.PACKET_TYPE_IMAGE -> {
                    // Handle image packet if needed
                }
                else -> {
                    Bridge.log("unknown packetType: ${String.format("%02X ", packetType)}")
                }
            }
        }
    }

    private fun attemptGattConnection(device: BluetoothDevice) {
        if (device == null) {
            Bridge.log("Cannot connect to GATT: Device is null")
            return
        }

        val deviceName = device.name
        if (deviceName.isNullOrEmpty()) {
            Log.e(TAG,"Skipping null/empty device name: ${device.address}... this means something horrific has occurred. Look into this.")
            return
        }

        Bridge.log("attemptGattConnection called for device: $deviceName (${device.address})")

        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        Bridge.log("Setting connectionState to CONNECTING. Notifying connectionEvent.")
        // connectionEvent(connectionState)

        if (mainGlassGatt == null) {
            Bridge.log("Attempting GATT connection for Main Glass...")
            mainGlassGatt = device.connectGatt(context, false, mainGattCallback)
            isMainConnected = false
            Bridge.log("Main GATT connection initiated. isMainConnected set to false.")
        } else {
            Bridge.log("Main Glass GATT already exists")
        }
    }

    private fun postProtobufSchemaVersionInfo() {
        try {
            // Call the version method only once
            val schemaVersion = NexProtobufUtils.getProtobufSchemaVersion(context!!)
            
            // Build the info string directly instead of calling getProtobufBuildInfo()
            val fileDescriptorName = mentraos.ble.MentraosBle.getDescriptor().file.name
            val buildInfo = "Schema v$schemaVersion | $fileDescriptorName"

            // protobufSchemaVersion = schemaVersion.toString()
            
            // val event = ProtobufSchemaVersionEvent(
            //     schemaVersion, 
            //     buildInfo, 
            //     smartGlassesDevice?.deviceModelName ?: "Unknown"
            // )
            
            // EventBus.getDefault().post(event)
            Bridge.log("Posted protobuf schema version event: $buildInfo")
        } catch (e: Exception) {
            Log.e(TAG,"Error posting protobuf schema version event: ${e.message}", e)
        }
    }

    private fun connectToSmartGlasses() {
        val deviceModelName = DeviceManager.getInstance().deviceName
        val deviceAddress = DeviceManager.getInstance().deviceAddress

        // Register bonding receiver
        Bridge.log("connectToSmartGlasses start")
        Bridge.log("try to ConnectToSmartGlassesing deviceModelName: ${deviceModelName} deviceAddress: ${deviceAddress}")
        preferredMainDeviceId = DeviceManager.getInstance().deviceName
        if (!bluetoothAdapter.isEnabled) {
            return
        }
        when {
            !deviceModelName.isNullOrEmpty() && !deviceAddress.isNullOrEmpty() -> {
                stopScan()
                mainDevice = bluetoothAdapter.getRemoteDevice(deviceAddress)
                mainTaskHandler?.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0)
            }
            savedNexMainAddress != null -> {
                mainDevice = bluetoothAdapter.getRemoteDevice(savedNexMainAddress)
                mainTaskHandler?.sendEmptyMessageDelayed(MAIN_TASK_HANDLER_CODE_RECONNECT_DEVICE, 0)
            }
            else -> {
                // Start scanning for devices
                stopScan()
                DeviceStore.apply("glasses", "connectionState", ConnTypes.SCANNING)
                // connectionEvent(connectionState) // TODO: Figure out where is connection event defined????
                startScan()
            }
        }
    }

    private fun destroy() {
        // Tell the glasses this teardown is intentional so they return to the welcome
        // screen immediately instead of holding the last frame through the firmware's
        // unexpected-disconnect grace period. Best-effort: if the write can't be sent
        // or doesn't flush in time, the firmware grace period is the safety net.
        val canSend = mainGlassGatt != null && mainWriteChar != null && isMainConnected
        if (!canSend) {
            performDestroy()
            return
        }
        Bridge.log("Nex: Sending DisconnectRequest before teardown")
        sendProtobuf(NexProtobufUtils.generateDisconnectRequestCommandBytes(), 100)
        mainTaskHandler.postDelayed({ performDestroy() }, DISCONNECT_FLUSH_DELAY_MS)
    }

    private fun performDestroy() {
        Bridge.log("Nex: MentraNexSGC ONDESTROY")
        showHomeScreen()
        isKilled = true
        // stop BLE scanning
        stopScan()
        // Save current microphone state before destroying
        microphoneStateBeforeDisconnection = isMicrophoneEnabled
        Bridge.log("Nex: Saved microphone state during destroy: $microphoneStateBeforeDisconnection")
        // disable the microphone and stop sending micbeat
        stopMicBeat()
        // Stop periodic notifications
        stopPeriodicNotifications()
        mainGlassGatt?.let { gatt ->
            gatt.disconnect()
            gatt.close()
            mainGlassGatt = null
        }
        lc3AudioPlayer?.let { player ->
            try {
                player.stopPlay()
                Bridge.log("Nex: LC3 audio player stopped and cleaned up")
            } catch (e: Exception) {
                Log.e(TAG,"Nex: Error stopping LC3 audio player during destroy: ${e.message}")
            } finally {
                lc3AudioPlayer = null
            }
        }
        // Clean up handlers
        mainTaskHandler?.removeCallbacksAndMessages(null)
        whiteListHandler?.removeCallbacksAndMessages(null)
        micEnableHandler?.removeCallbacksAndMessages(null)
        notificationRunnable?.let {
            notificationHandler?.removeCallbacks(it)
        }

        textWallRunnable?.let {
            textWallHandler?.removeCallbacks(it)
        }
        findCompatibleDevicesHandler?.removeCallbacksAndMessages(null)
        // Free LC3 decoder
        if (lc3DecoderPtr != 0L) {
            Lc3Cpp.freeDecoder(lc3DecoderPtr)
            lc3DecoderPtr = 0L
        }
        currentImageChunks.clear()
        isImageSendProgressing = false
        sendQueue.clear()
        // Add a dummy element to unblock the take() call if needed
        sendQueue.offer(emptyArray()) // is this needed?
        isWorkerRunning = false
        isMainConnected = false
        Bridge.log("Nex: MentraNexSGC cleanup complete")
    }

    private fun startScan() {
        val scanner: BluetoothLeScanner = bluetoothAdapter.bluetoothLeScanner
        if (scanner == null) {
            Log.e(TAG,"BluetoothLeScanner not available.")
            return
        }

        // Optionally, define filters if needed
        val filters = mutableListOf<ScanFilter>()
        // For example, to filter by device name:
        // filters.add(ScanFilter.Builder().setDeviceName("Even G1_").build())

        // Set desired scan settings
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        // Start scanning
        isScanning = true
        scanner.startScan(filters, settings, modernScanCallback)
        scanner.flushPendingScanResults(modernScanCallback)
        Bridge.log("CALL START SCAN - Started scanning for devices...")

        // Ensure scanning state is immediately communicated to UI
        DeviceStore.apply("glasses", "connectionState", ConnTypes.SCANNING)
        // connectionEvent(connectionState)

        // Stop the scan after some time (e.g., 10-15s instead of 60 to avoid
        // throttling)
        // handler.postDelayed({ stopScan() }, 10000)
    }

    override fun stopScan() {
        val scanner = bluetoothAdapter.bluetoothLeScanner
        scanner?.stopScan(modernScanCallback)
        isScanning = false
        Bridge.log("Stopped scanning for devices")
        
        if (bleScanCallback != null && isScanningForCompatibleDevices) {
            scanner?.stopScan(bleScanCallback)
            isScanningForCompatibleDevices = false
        }
    }

    /**
     * Returns a colour-inverted copy of [src] (white <-> black). The firmware decoder normalises
     * BMP palette polarity, so the only way to flip the on-glass result from the SGC is to invert
     * the actual pixel content here.
     */
    private fun invertBitmap(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val paint = Paint().apply {
            colorFilter = ColorMatrixColorFilter(
                ColorMatrix(
                    floatArrayOf(
                        -1f, 0f, 0f, 0f, 255f,
                        0f, -1f, 0f, 0f, 255f,
                        0f, 0f, -1f, 0f, 255f,
                        0f, 0f, 0f, 1f, 0f
                    )
                )
            )
        }
        Canvas(out).drawBitmap(src, 0f, 0f, paint)
        return out
    }

    /**
     * Floyd-Steinberg error-diffusion dithering to monochrome. Returns a copy of [src] whose pixels
     * are pure black or white but whose dot density approximates the original luminance, preserving
     * far more perceived detail on a 1-bpp panel than a flat threshold. Luminance uses Rec. 601
     * weights; quantization error is pushed to the right/below neighbours (7/3/5/1 over 16).
     */
    private fun floydSteinbergDither(src: Bitmap): Bitmap {
        val w = src.width
        val h = src.height
        val px = IntArray(w * h)
        src.getPixels(px, 0, w, 0, 0, w, h)

        // Working luminance buffer (float so diffused error can over/undershoot 0..255).
        val lum = FloatArray(w * h)
        for (i in 0 until w * h) {
            val c = px[i]
            val r = (c shr 16) and 0xFF
            val g = (c shr 8) and 0xFF
            val b = c and 0xFF
            lum[i] = 0.299f * r + 0.587f * g + 0.114f * b
        }

        for (y in 0 until h) {
            for (x in 0 until w) {
                val idx = y * w + x
                val old = lum[idx]
                val newVal = if (old < 128f) 0f else 255f
                val err = old - newVal
                px[idx] = if (newVal >= 128f) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()

                if (x + 1 < w) lum[idx + 1] += err * 7f / 16f
                if (y + 1 < h) {
                    if (x - 1 >= 0) lum[idx + w - 1] += err * 3f / 16f
                    lum[idx + w] += err * 5f / 16f
                    if (x + 1 < w) lum[idx + w + 1] += err * 1f / 16f
                }
            }
        }

        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(px, 0, w, 0, 0, w, h)
        return out
    }

    /** Stream 1-bit BMP pixels into an already-created canvas bitmap component [componentId]. */
    private fun streamBitmapPixels(componentId: Int, bmpData: ByteArray) {
        try {
            if (bmpData.isEmpty()) {
                Log.e(TAG, "Invalid BMP data provided")
                return
            }
            // 4-digit hex stream id per the canvas image protocol.
            val totalChunks = (bmpData.size + bmpChunkSize - 1) / bmpChunkSize
            val streamId = "%04X".format(random.nextInt(0x10000))

            sendProtobuf(NexProtobufUtils.generateCanvasUpdateImageCommandBytes(
                componentId, streamId, totalChunks))

            val chunks = NexProtobufUtils.createBmpChunksForNexGlasses(streamId, bmpData, totalChunks, bmpChunkSize)
            currentImageChunks.clear()
            currentImageChunks.addAll(chunks)
            sendDataSequentially(chunks)
        } catch (e: Exception) {
            Log.e(TAG, "Error streaming bitmap pixels: ${e.message}")
        }
    }

    private fun stopPeriodicNotifications() {
        notificationRunnable?.let { runnable ->
            notificationHandler?.removeCallbacks(runnable)
            Bridge.log("Stopped periodic notifications")
        }
    }
    private fun startMicBeat(delay: Int) {
        Bridge.log("Nex: Starting micbeat")
        if (micBeatCount > 0) {
            stopMicBeat()
        }
        sendSetMicEnabled(true, 10)
        micBeatRunnable = Runnable {
            sendSetMicEnabled(shouldUseGlassesMic, 1)
            micBeatHandler.postDelayed(micBeatRunnable!!, MICBEAT_INTERVAL_MS)
        }
        micBeatHandler.postDelayed(micBeatRunnable!!, delay.toLong())
    }

    private fun stopMicBeat() {
        sendSetMicEnabled(false, 10)
        if (micBeatHandler != null) {
            micBeatHandler.removeCallbacksAndMessages(null);
            micBeatHandler.removeCallbacksAndMessages(micBeatRunnable);
            micBeatRunnable = null;
            micBeatCount = 0;
        }
    }

    private fun sendWhiteListCommand(delay: Int) {
        if (whiteListedAlready) return
        
        whiteListedAlready = true
        Bridge.log("Nex: Sending whitelist command")
        
        whiteListHandler.postDelayed({
            val chunks = NexProtobufUtils.getWhitelistChunks(maxChunkSize)
            sendDataSequentially(chunks)
            
            // Uncomment if needed for debugging:
            // chunks.forEach { chunk ->
            //     Bridge.log("Nex: Sending this chunk for white list: ${bytesToUtf8(chunk)}")
            //     sendDataSequentially(chunk)
            //     // Thread.sleep(150) // Uncomment if delay between chunks is needed
            // }
        }, delay.toLong())
    }

    private fun showHomeScreen() {
        Bridge.log("Nex: showHomeScreen")
        
        if (lastThingDisplayedWasAnImage) {
            // clearNexScreen()
            lastThingDisplayedWasAnImage = false
        }
    }

    private fun updateConnectionState() {
        if (isMainConnected) {
            DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            Bridge.log("Nex: Main glasses connected")
            lastConnectionTimestamp = System.currentTimeMillis()
            DeviceStore.apply("glasses", "fullyBooted", true)
            DeviceStore.apply("glasses", "connected", true)
            // Removed commented sleep code as it's not needed
            // connectionEvent(it)
        } else {
            DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
            Bridge.log("Nex: No Main glasses connected")
            DeviceStore.apply("glasses", "fullyBooted", false)
            DeviceStore.apply("glasses", "connected", false)
            // connectionEvent(it)
        }
    }

    private fun decodeJsons(jsonBytes: ByteArray) {
        val jsonString = String(jsonBytes, Charset.defaultCharset())
        try {
            val commandObject = JSONObject(jsonString)
            when (val type = commandObject.getString("type")) {
                "image_transfer_complete" -> {
                    // Handle image transfer complete
                }
                "disconnect" -> {
                    // Handle disconnect
                }
                "request_battery_state" -> {
                    // Handle battery state request
                }
                "charging_state" -> {
                    // Handle charging state
                }
                "device_info" -> {
                    // val deviceInfo = gson.fromJson(jsonString, DeviceInfo::class.java)
                }
                "enter_pairing_mode" -> {
                    // Handle pairing mode
                }
                "request_head_position" -> {
                    // Handle head position request
                }
                "set_head_up_angle" -> {
                    // Handle head up angle
                }
                "ping" -> {
                    // Handle ping
                }
                "vad_event" -> {
                    // Handle VAD event
                }
                "imu_data" -> {
                    // Handle IMU data
                }
                "button_event" -> {
                    // Handle button event
                }
                "head_gesture" -> {
                    // Handle head gesture
                }
            }
        } catch (e: Exception) {
            Log.e(TAG,"Error decoding JSON: ${e.message}")
        }
    }

    private fun decodeProtobufs(protobufBytes: ByteArray, packetHex: String) {
        try {
            val glassesToPhone = GlassesToPhone.parseFrom(protobufBytes)
            val payloadCase = glassesToPhone.payloadCase.toString()
            
            Bridge.log("decodeProtobufs glassesToPhone: $glassesToPhone")
            Bridge.log("decodeProtobufs glassesToPhone payloadCase: $payloadCase")
            
            NexEventUtils.sendBleCommandReceivedEvent(payloadCase, packetHex, System.currentTimeMillis())
            // if (isDebugMode) {
            //     EventBus.getDefault().post(BleCommandReceiver(payloadCase, packetHex))
            // }

            when (glassesToPhone.payloadCase) {
                GlassesToPhone.PayloadCase.BATTERY_STATUS -> {
                    val batteryStatus: BatteryStatus = glassesToPhone.batteryStatus
                    DeviceStore.apply("glasses", "batteryLevel", batteryStatus.level)
                    // EventBus.getDefault().post(BatteryLevelEvent(batteryStatus.level, batteryStatus.charging))
                }
                GlassesToPhone.PayloadCase.CHARGING_STATE -> {
                    val chargingState: ChargingState = glassesToPhone.chargingState
                    // EventBus.getDefault().post(BatteryLevelEvent(batteryLevel, chargingState.state == State.CHARGING))
                    Bridge.log("chargingState: $chargingState")
                }
                GlassesToPhone.PayloadCase.DEVICE_INFO -> {
                    val deviceInfo: DeviceInfo = glassesToPhone.deviceInfo
                    Bridge.log("deviceInfo: $deviceInfo")
                }
                GlassesToPhone.PayloadCase.HEAD_POSITION -> {
                    val headPosition: HeadPosition = glassesToPhone.headPosition
                    // EventBus.getDefault().post(HeadUpAngleEvent(headPosition.angle))
                    Bridge.log("headPosition: $headPosition")
                }
                GlassesToPhone.PayloadCase.HEAD_UP_ANGLE_SET -> {
                    val headUpAngleResponse: HeadUpAngleResponse = glassesToPhone.headUpAngleSet
                    Bridge.log("headUpAngleResponse: $headUpAngleResponse")
                }
                GlassesToPhone.PayloadCase.VAD_EVENT -> {
                    // val vadEvent = glassesToPhone.vadEvent
                    // EventBus.getDefault().post(VadEvent(vadEvent.vad))
                }
                GlassesToPhone.PayloadCase.IMAGE_TRANSFER_COMPLETE -> {
                    val transferComplete: ImageTransferComplete = glassesToPhone.imageTransferComplete
                    Bridge.log("transferComplete: $transferComplete")
                    
                    when (transferComplete.status) {
                        ImageTransferComplete.Status.OK -> {
                            currentImageChunks.clear()
                            isImageSendProgressing = false
                        }
                        ImageTransferComplete.Status.INCOMPLETE -> {
                            val missingChunksList = transferComplete.missingChunksList
                            reSendImageMissingChunks(missingChunksList)
                        }
                        else -> {}
                    }
                }
                GlassesToPhone.PayloadCase.IMU_DATA -> {
                    val imuData: ImuData = glassesToPhone.imuData
                    Bridge.log("imuData: $imuData")
                }
                GlassesToPhone.PayloadCase.BUTTON_EVENT -> {
                    val buttonEvent: ButtonEvent = glassesToPhone.buttonEvent
                    Bridge.log("buttonEvent: $buttonEvent")
                    // buttonEvent.button.number
                    // EventBus.getDefault().post(ButtonPressEvent(
                    //     smartGlassesDevice.deviceModelName,
                    //     buttonId,
                    //     pressType,
                    //     timestamp
                    // ))
                }
                GlassesToPhone.PayloadCase.HEAD_GESTURE -> {
                    val headGesture: HeadGesture = glassesToPhone.headGesture
                    Bridge.log("headGesture: $headGesture")
                    // EventBus.getDefault().post(GlassesHeadUpEvent())
                    // EventBus.getDefault().post(GlassesHeadDownEvent())
                    // EventBus.getDefault().post(GlassesTapOutputEvent(2, isRight, System.currentTimeMillis()))
                }
                GlassesToPhone.PayloadCase.CANVAS_RESULT -> {
                    // Ack for CanvasCreateComponent / CanvasClear (updates are
                    // unacked). Firmware codes: OK / INVALID (bad id for type) /
                    // OVERSIZE (bitmap > 200x200) / OOM (no backing storage).
                    // Consumed for observability — a silent blank screen becomes
                    // a diagnosable log line. Non-OK codes also invalidate the
                    // registry entry so the next frame recreates the component.
                    val canvasResult = glassesToPhone.canvasResult
                    if (canvasResult.code != mentraos.ble.MentraosBle.CanvasResult.ResultCode.OK) {
                        Bridge.log("Nex: CANVAS_RESULT id=${canvasResult.id} code=${canvasResult.code} — dropping registry entry for recreate")
                        canvasElements.entries.removeAll { it.value.firmwareId == canvasResult.id.toInt() }
                    }
                }
                GlassesToPhone.PayloadCase.PAYLOAD_NOT_SET,
                null -> {
                    // Do nothing
                }
                else -> {

                }
            }
        } catch (e: InvalidProtocolBufferException) {
            Log.e(TAG,"Error decoding protobuf: ${e.message}")
        }
    }

    private fun decodeProtobufsByWrite(protobufBytes: ByteArray, packetHex: String) {
        try {
            val phoneToGlasses = PhoneToGlasses.parseFrom(protobufBytes)
            Bridge.log("decodeProtobufsByWrite phoneToGlasses: $phoneToGlasses")
            Bridge.log("decodeProtobufsByWrite phoneToGlasses payloadCase: ${phoneToGlasses.payloadCase}")
            val payloadCase = phoneToGlasses.payloadCase.toString()
            NexEventUtils.sendBleCommandSentEvent(payloadCase, packetHex, System.currentTimeMillis())
            // if (isDebugMode) {
            //     EventBus.getDefault().post(BleCommandSender(payloadCase, packetHex))
            // }
        } catch (e: Exception) {
            Log.e(TAG,"Error in decodeProtobufsByWrite: ${e.message}")
        }
    }

    private fun reSendImageMissingChunks(missingChunksIndexList: List<Int>) {
        if (!isImageSendProgressing || currentImageChunks.isEmpty() || missingChunksIndexList.isEmpty()) {
            return
        }
        val missingChunks = missingChunksIndexList.map { index -> 
            currentImageChunks[index] 
        }
        
        sendDataSequentially(missingChunks)
    }

    private fun createTextWallChunksForNex(text: String): ByteArray {
        // Create the PhoneToGlasses using its builder and set the DisplayText
        return NexProtobufUtils.generateDisplayTextCommandBytes(text)
    }

    private fun sendSetMicEnabled(enable: Boolean, delay: Long) {
        Bridge.log("Nex: setMicEnabled called with enable: $enable and delay: $delay")
        Bridge.log("Nex: Running set mic enabled: $enable")
        isMicrophoneEnabled = enable // Update the state tracker
        DeviceStore.apply("glasses", "micEnabled", enable)

        micEnableHandler?.postDelayed({
            if (connectionState != ConnTypes.CONNECTED) {
                Bridge.log("Nex: Tryna start mic: Not connected to glasses")
                return@postDelayed
            }
            Bridge.log("Nex: === SENDING MICROPHONE STATE COMMAND TO GLASSES ===")
            val micConfigBytes = NexProtobufUtils.generateMicStateConfigCommandBytes(enable)
            sendProtobuf(micConfigBytes, 10) // wait some time to setup the mic
            Bridge.log("Nex: Sent MIC command: ${micConfigBytes.joinToString("") { "%02x".format(it) }}")
        }, delay)
    }

    private fun queryBatteryStatus() {
        val batteryQueryPacket = NexProtobufUtils.generateBatteryStateRequestCommandBytes()
        sendProtobuf(batteryQueryPacket, 250)
    }

    ///// PROCESSING THREAD /////////////////

    // Start the worker thread if it's not already running
    @Synchronized
    private fun startWorkerIfNeeded() {
        if (!isWorkerRunning) {
            isWorkerRunning = true
            Thread({ processQueue() }, "MentraNexSGCProcessQueue").start()
        }
    }

    // Non-blocking function to add new send request
    private fun sendDataSequentially(data: ByteArray) {
        val chunks = arrayOf(SendRequest(data))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    // Non-blocking function to add new send request with wait time
    private fun sendDataSequentially(data: ByteArray, waitTime: Int) {
        val chunks = arrayOf(SendRequest(data, waitTime))
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    private fun sendDataSequentially(data: List<ByteArray>) {
        val chunks = Array(data.size) { i -> SendRequest(data[i]) }
        sendQueue.offer(chunks)
        startWorkerIfNeeded()
    }

    /**
     * Frames a serialized protobuf message onto the 0x02 control channel and sends it.
     *
     * The message is split into fragments that each fit the negotiated MTU, prefixed with a
     * 4-byte transport header: [0x02][seq][totalChunks][chunkIndex]. The firmware reassembles
     * fragments by seq/index before decoding. Single-fragment messages (totalChunks == 1) are
     * decoded directly by the firmware fast path.
     *
     * @param protobufBytes raw serialized PhoneToGlasses bytes (no framing)
     * @param waitTime optional post-message delay in ms applied after the last fragment (-1 = none)
     * @param ack when true (default) each fragment is a write-with-response; captions pass false
     */
    private fun sendProtobuf(protobufBytes: ByteArray, waitTime: Int = -1, ack: Boolean = true) {
        val headerSize = 4 // [0x02][seq][totalChunks][chunkIndex]
        val maxFragment = (maxChunkSize - headerSize).coerceAtLeast(1)
        val totalChunks =
            if (protobufBytes.isEmpty()) 1 else (protobufBytes.size + maxFragment - 1) / maxFragment

        if (totalChunks > 255) {
            Log.e(TAG, "Nex: Protobuf message too large to fragment ($totalChunks chunks) - dropping")
            return
        }

        val seq = protobufSeq
        protobufSeq = (protobufSeq + 1) and 0xFF

        val frames = Array(totalChunks) { index ->
            val start = index * maxFragment
            val end = minOf(start + maxFragment, protobufBytes.size)
            val fragLen = end - start
            val frame = ByteArray(headerSize + fragLen)
            frame[0] = NexBluetoothPacketTypes.PACKET_TYPE_PROTOBUF
            frame[1] = seq.toByte()
            frame[2] = totalChunks.toByte()
            frame[3] = index.toByte()
            if (fragLen > 0) {
                System.arraycopy(protobufBytes, start, frame, headerSize, fragLen)
            }
            // Carry the post-message delay on the final fragment only.
            SendRequest(frame, if (index == totalChunks - 1) waitTime else -1, ack)
        }

        sendQueue.offer(frames)
        startWorkerIfNeeded()
    }

    private fun processQueue() {
        // First wait until the services are ready to receive data
        Bridge.log("[BLE] PROC_QUEUE started — waiting for descriptor write (mainServicesWaiter)")
        try {
            mainServicesWaiter.waitWhileTrue()
        } catch (e: InterruptedException) {
            Log.e(TAG,"Nex: Interrupted waiting for descriptor writes: $e")
        }
        Bridge.log("[BLE] PROC_QUEUE ready — descriptor write done, entering send loop")

        while (!isKilled) {
            try {
                // Make sure services are ready before processing requests
                mainServicesWaiter.waitWhileTrue()

                // This will block until data is available
                val requests = sendQueue.take()

                for (request in requests) {
                    if (isKilled) {
                        isWorkerRunning = false
                        break
                    }

                    try {
                        // Force an initial delay so BLE gets all setup
                        val timeSinceConnection = System.currentTimeMillis() - lastConnectionTimestamp
                        if (timeSinceConnection < INITIAL_CONNECTION_DELAY_MS) {
                            Thread.sleep(INITIAL_CONNECTION_DELAY_MS - timeSinceConnection)
                        }

                        // Send to main glass
                        val canSend = mainGlassGatt != null && mainWriteChar != null && isMainConnected
                        var writeStarted = false
                        if (canSend) {
                            mainWaiter.setTrue()
                            // Per-request write type: acked fragments go out WITH response
                            // (firmware ATT-acks each), captions go out WITHOUT response for
                            // throughput. Set on the shared char just before the write — the
                            // worker is single-threaded so there's no concurrent write to race.
                            mainWriteChar?.writeType = if (request.ack) {
                                BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                            } else {
                                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                            }
                            mainWriteChar?.value = request.data
                            // Honor the return value: writeCharacteristic returns false when the
                            // stack is busy / out of buffers, and in that case no callback fires.
                            // Only wait for the callback if the write actually started, otherwise
                            // the waiter would block until the next disconnect.
                            val issued = mainGlassGatt?.writeCharacteristic(mainWriteChar) ?: false
                            if (issued) {
                                writeStarted = true
                                lastSendTimestamp = System.currentTimeMillis()
                            } else {
                                mainWaiter.setFalse()
                                Log.e(TAG, "[BLE] PROC_QUEUE writeCharacteristic returned false — stack busy, dropping fragment")
                            }
                        } else {
                            Bridge.log("[BLE] PROC_QUEUE skipping write — not ready, packet dropped")
                        }

                        if (writeStarted) {
                            // Acked writes need to wait for the real ATT response (a
                            // connection interval or two); no-response writes get the
                            // near-instant fast-path bound.
                            val timeout = if (request.ack) WRITE_ACK_TIMEOUT_MS else WRITE_CALLBACK_TIMEOUT_MS
                            mainWaiter.waitWhileTrue(timeout)
                        }


                        // If the packet asked us to do a delay, then do it
                        if (request.waitTime != -1) {
                            Thread.sleep(request.waitTime.toLong())
                        }
                    } catch (e: InterruptedException) {
                        Log.e(TAG,"Nex: Error sending data: ${e.message}")
                        if (isKilled) break
                    }
                }
            } catch (e: InterruptedException) {
                if (isKilled) {
                    Bridge.log("Nex: Process queue thread interrupted - shutting down")
                    break
                }
                Log.e(TAG,"Nex: Error in queue processing: ${e.message}")
            }
        }

        Bridge.log("Nex: Process queue thread exiting")
        isWorkerRunning = false
    }
}
