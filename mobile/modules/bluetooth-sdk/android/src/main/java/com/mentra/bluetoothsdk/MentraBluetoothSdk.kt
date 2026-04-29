package com.mentra.bluetoothsdk

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.mentra.bluetoothsdk.utils.PhoneAudioMonitor
import java.util.Collections

class MentraBluetoothSdk private constructor(
    context: Context,
    private val config: MentraBluetoothSdkConfig,
    listener: MentraBluetoothSdkListener,
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val deviceManager: DeviceManager
    private val listeners =
        Collections.synchronizedSet(mutableSetOf<MentraBluetoothSdkListener>())
    private val discoveredDeviceNames = mutableSetOf<String>()
    private val bridgeEventSinkId: String
    private val storeListenerId: String
    private var scanDiagnosticGeneration = 0

    init {
        listeners.add(listener)
        Bridge.initialize(appContext)
        deviceManager = DeviceManager.getInstance()
        bridgeEventSinkId = Bridge.addEventSink { eventName, data -> dispatchBridgeEvent(eventName, data) }
        storeListenerId = DeviceStore.store.addListener { category, changes -> dispatchStoreUpdate(category, changes) }
    }

    companion object {
        @JvmStatic
        fun create(
            context: Context,
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk = create(context, MentraBluetoothSdkConfig(), listener)

        @JvmStatic
        fun create(
            context: Context,
            config: MentraBluetoothSdkConfig,
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk = MentraBluetoothSdk(context, config, listener)
    }

    fun addListener(listener: MentraBluetoothSdkListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: MentraBluetoothSdkListener) {
        listeners.remove(listener)
    }

    fun getGlassesStatus(): MentraGlassesStatus =
        MentraGlassesStatus(DeviceStore.store.getCategory("glasses"))

    fun getBluetoothStatus(): MentraBluetoothStatus =
        MentraBluetoothStatus(DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY))

    @JvmOverloads
    fun getKnownDevices(model: MentraDeviceModel? = null): List<MentraKnownDevice> =
        collectKnownBluetoothDevices(model)

    fun startScan(model: MentraDeviceModel) {
        discoveredDeviceNames.clear()
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "searching", true)
        deviceManager.findCompatibleDevices(model.deviceType)
        scheduleScanNoResultsDiagnostic(model)
    }

    fun stopScan() {
        scanDiagnosticGeneration += 1
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "searching", false)
        dispatchToListeners { it.onScanStopped(MentraScanStopReason.CANCELLED) }
    }

    fun connect(device: MentraDiscoveredDevice) {
        if (!device.address.isNullOrBlank()) {
            connectByAddress(device.model, device.address, device.name)
            return
        }
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "pending_wearable", device.model.deviceType)
        deviceManager.connectByName(device.name)
    }

    @JvmOverloads
    fun connectByAddress(model: MentraDeviceModel, address: String, name: String? = null) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "pending_wearable", model.deviceType)
        deviceManager.connectByAddress(model.deviceType, address, name)
    }

    fun connectByName(model: MentraDeviceModel, deviceName: String) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "pending_wearable", model.deviceType)
        deviceManager.connectByName(deviceName)
    }

    fun connectByName(deviceName: String) {
        deviceManager.connectByName(deviceName)
    }

    fun connectDefault() {
        deviceManager.connectDefault()
    }

    fun connectSimulated() {
        deviceManager.connectSimulated()
    }

    fun disconnect() {
        deviceManager.disconnect()
    }

    fun forget() {
        deviceManager.forget()
    }

    fun displayText(request: MentraDisplayTextRequest) {
        deviceManager.displayText(request.toMap())
    }

    fun displayEvent(request: MentraDisplayEventRequest) {
        deviceManager.displayEvent(request.toMap())
    }

    fun clearDisplay() {
        deviceManager.clearDisplay()
    }

    fun showDashboard() {
        deviceManager.showDashboard()
    }

    @JvmOverloads
    fun setBrightness(level: Int, autoMode: Boolean? = null) {
        autoMode?.let { DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "auto_brightness", it) }
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "brightness", level)
    }

    fun setAutoBrightness(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "auto_brightness", enabled)
    }

    fun setDashboardPosition(request: MentraDashboardPositionRequest) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "dashboard_height", request.height)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "dashboard_depth", request.depth)
    }

    fun setDashboardMenu(items: List<MentraDashboardMenuItem>) {
        DeviceStore.apply(
            ObservableStore.BLUETOOTH_CATEGORY,
            "dashboard_menu_apps",
            items.map { it.toMap() },
        )
    }

    fun setHeadUpAngle(angleDegrees: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "head_up_angle", angleDegrees)
    }

    fun setScreenDisabled(disabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "screen_disabled", disabled)
    }

    fun setGalleryMode(mode: MentraGalleryMode) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "gallery_mode", mode == MentraGalleryMode.AUTO)
    }

    fun setButtonMode(mode: MentraButtonMode) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_mode", mode.value)
    }

    fun setButtonPhotoSettings(settings: MentraButtonPhotoSettings) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_photo_size", settings.size.value)
    }

    fun setButtonVideoRecordingSettings(settings: MentraButtonVideoRecordingSettings) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_width", settings.width)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_height", settings.height)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_video_fps", settings.fps)
    }

    fun setButtonCameraLed(enabled: Boolean) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_camera_led", enabled)
    }

    fun setButtonMaxRecordingTime(minutes: Int) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "button_max_recording_time", minutes)
    }

    fun setCameraFov(fov: MentraCameraFov) {
        DeviceStore.apply(
            ObservableStore.BLUETOOTH_CATEGORY,
            "camera_fov",
            mapOf("fov" to fov.fov, "roi_position" to fov.roiPosition),
        )
    }

    fun setMicState(config: MentraMicConfig) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_pcm", config.sendPcmData)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_lc3", config.sendLc3Data)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "should_send_transcript", config.sendTranscript)
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "bypass_vad", config.bypassVad)
        deviceManager.setMicState()
    }

    fun setPreferredMic(preferredMic: MentraMicPreference) {
        DeviceStore.apply(ObservableStore.BLUETOOTH_CATEGORY, "preferred_mic", preferredMic.value)
    }

    fun setOwnAppAudioPlaying(playing: Boolean) {
        PhoneAudioMonitor.getInstance(appContext).setOwnAppAudioPlaying(playing)
    }

    fun requestWifiScan() {
        deviceManager.requestWifiScan()
    }

    fun sendWifiCredentials(ssid: String, password: String) {
        deviceManager.sendWifiCredentials(ssid, password)
    }

    fun forgetWifiNetwork(ssid: String) {
        deviceManager.forgetWifiNetwork(ssid)
    }

    fun setHotspotState(enabled: Boolean) {
        deviceManager.setHotspotState(enabled)
    }

    fun requestPhoto(request: MentraPhotoRequest) {
        deviceManager.photoRequest(
            request.requestId,
            request.appId,
            request.size,
            request.webhookUrl,
            request.authToken,
            request.compress,
            request.flash,
            request.sound,
        )
    }

    fun queryGalleryStatus() {
        deviceManager.queryGalleryStatus()
    }

    fun startStream(request: MentraStreamRequest) {
        deviceManager.startStream(request.values.toMutableMap())
    }

    fun keepStreamAlive(request: MentraStreamKeepAliveRequest) {
        deviceManager.keepStreamAlive(request.values.toMutableMap())
    }

    fun stopStream() {
        deviceManager.stopStream()
    }

    fun startVideoRecording(request: MentraVideoRecordingRequest) {
        deviceManager.startVideoRecording(request.requestId, request.save, request.flash, request.sound)
    }

    fun stopVideoRecording(requestId: String) {
        deviceManager.stopVideoRecording(requestId)
    }

    fun requestVersionInfo() {
        deviceManager.requestVersionInfo()
    }

    fun sendOtaStart() {
        deviceManager.sendOtaStart()
    }

    fun sendShutdown() {
        deviceManager.sendShutdown()
    }

    fun sendReboot() {
        deviceManager.sendReboot()
    }

    fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null) {
        deviceManager.sendIncidentId(incidentId, apiBaseUrl)
    }

    override fun close() {
        Bridge.removeEventSink(bridgeEventSinkId)
        DeviceStore.store.removeListener(storeListenerId)
        listeners.clear()
    }

    private fun dispatchStoreUpdate(category: String, changes: Map<String, Any>) {
        when (ObservableStore.normalizeCategory(category)) {
            "glasses" ->
                dispatchToListeners {
                    it.onGlassesStatusChanged(MentraGlassesStatusUpdate(changes))
                }
            ObservableStore.BLUETOOTH_CATEGORY -> {
                dispatchToListeners {
                    it.onBluetoothStatusChanged(MentraBluetoothStatusUpdate(changes))
                }
                dispatchDiscoveredDevices(changes["searchResults"])
            }
        }
    }

    private fun dispatchDiscoveredDevices(rawSearchResults: Any?) {
        val results = rawSearchResults as? List<*> ?: return
        results.forEach { rawResult ->
            val result = rawResult as? Map<*, *> ?: return@forEach
            val name = result["deviceName"] as? String ?: result["name"] as? String ?: return@forEach
            if (!discoveredDeviceNames.add(name)) return@forEach
            val model = MentraDeviceModel.fromDeviceType(result["deviceModel"] as? String)
            val device = MentraDiscoveredDevice(
                model = model,
                name = name,
                address = result["deviceAddress"] as? String ?: result["address"] as? String,
                rssi = (result["rssi"] as? Number)?.toInt(),
            )
            dispatchToListeners { it.onDeviceDiscovered(device) }
        }
    }

    private fun scheduleScanNoResultsDiagnostic(model: MentraDeviceModel) {
        if (config.scanNoResultsDiagnosticDelayMs <= 0) return

        val generation = ++scanDiagnosticGeneration
        mainHandler.postDelayed(
            {
                if (generation != scanDiagnosticGeneration) return@postDelayed
                val bluetoothStatus = DeviceStore.store.getCategory(ObservableStore.BLUETOOTH_CATEGORY)
                val glassesStatus = DeviceStore.store.getCategory("glasses")
                val isSearching = bluetoothStatus["searching"] as? Boolean ?: false
                val isConnected = glassesStatus["connected"] as? Boolean ?: false
                if (!isSearching || isConnected || discoveredDeviceNames.isNotEmpty()) return@postDelayed

                val connectedKnownDevices = getKnownDevices(model).filter { it.connected }
                if (connectedKnownDevices.isEmpty()) return@postDelayed

                val deviceNames = connectedKnownDevices.joinToString { it.name }
                val devices = connectedKnownDevices.map { it.toMap() }
                dispatchToListeners {
                    it.onError(
                        MentraBluetoothError(
                            code = "device_connected_elsewhere",
                            message =
                                "$deviceNames already appears connected at the Android Bluetooth layer. " +
                                    "Only one app can own the glasses BLE connection at a time; close or force-stop " +
                                    "any other app using the glasses, then retry scanning.",
                            values = mapOf(
                                "deviceModel" to model.deviceType,
                                "devices" to devices,
                            ),
                        )
                    )
                }
            },
            config.scanNoResultsDiagnosticDelayMs,
        )
    }

    private fun collectKnownBluetoothDevices(model: MentraDeviceModel?): List<MentraKnownDevice> {
        if (!hasBluetoothConnectPermission()) return emptyList()

        val bluetoothManager =
            appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
                ?: return emptyList()
        val adapter = bluetoothManager.adapter ?: BluetoothAdapter.getDefaultAdapter() ?: return emptyList()
        val devicesByAddress = linkedMapOf<String, BluetoothDevice>()

        try {
            adapter.bondedDevices?.forEach { device ->
                device.address?.let { devicesByAddress[it] = device }
            }
        } catch (_: SecurityException) {
            return emptyList()
        }

        val connectedGattDevices =
            try {
                bluetoothManager.getConnectedDevices(BluetoothProfile.GATT)
            } catch (_: SecurityException) {
                emptyList()
            } catch (_: IllegalArgumentException) {
                emptyList()
            }

        connectedGattDevices.forEach { device ->
            device.address?.let { devicesByAddress[it] = device }
        }
        val connectedAddresses = connectedGattDevices.mapNotNull { it.address }.toSet()

        return devicesByAddress.values.mapNotNull { device ->
            val name = device.safeName() ?: return@mapNotNull null
            val inferredModel = inferModelFromName(name) ?: return@mapNotNull null
            if (model != null && inferredModel != model) return@mapNotNull null

            val address = device.address ?: return@mapNotNull null
            MentraKnownDevice(
                model = inferredModel,
                name = name,
                address = address,
                bonded = device.bondState == BluetoothDevice.BOND_BONDED,
                connected =
                    connectedAddresses.contains(address) ||
                        isDeviceConnected(bluetoothManager, device),
            )
        }
    }

    private fun isDeviceConnected(bluetoothManager: BluetoothManager, device: BluetoothDevice): Boolean =
        try {
            bluetoothManager.getConnectionState(device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
        } catch (_: SecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }

    private fun BluetoothDevice.safeName(): String? =
        try {
            name
        } catch (_: SecurityException) {
            null
        }

    private fun hasBluetoothConnectPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED

    private fun inferModelFromName(name: String): MentraDeviceModel? =
        when {
            isMentraLiveName(name) -> MentraDeviceModel.MENTRA_LIVE
            else -> null
        }

    private fun isMentraLiveName(name: String): Boolean {
        val normalized = name.lowercase()
        return name == "Xy_A" ||
            name.startsWith("XyBLE_") ||
            name.startsWith("MENTRA_LIVE_BLE") ||
            name.startsWith("MENTRA_LIVE_BT") ||
            normalized.startsWith("mentra_live")
    }

    private fun MentraKnownDevice.toMap(): Map<String, Any> =
        mapOf(
            "deviceModel" to model.deviceType,
            "deviceName" to name,
            "deviceAddress" to address,
            "bonded" to bonded,
            "connected" to connected,
        )

    private fun dispatchBridgeEvent(eventName: String, data: Map<String, Any>) {
        when (eventName) {
            "log" -> dispatchToListeners { it.onLog(data["message"] as? String ?: data.toString()) }
            "button_press" ->
                dispatchToListeners {
                    it.onButtonPress(
                        MentraButtonPressEvent(
                            buttonId = data["buttonId"] as? String ?: "",
                            pressType = data["pressType"] as? String ?: "",
                            timestamp = (data["timestamp"] as? Number)?.toLong(),
                        )
                    )
                }
            "touch_event" -> dispatchToListeners { it.onTouch(MentraTouchEvent(data)) }
            "head_up" -> dispatchToListeners { it.onHeadUpChanged(data["up"] as? Boolean ?: false) }
            "battery_status" ->
                dispatchToListeners {
                    it.onBatteryStatus(
                        MentraBatteryStatusEvent(
                            level = (data["level"] as? Number)?.toInt(),
                            charging = data["charging"] as? Boolean,
                            values = data,
                        )
                    )
                }
            "wifi_status_change" -> dispatchToListeners { it.onWifiStatusChanged(MentraWifiStatusEvent(data)) }
            "gallery_status" -> dispatchToListeners { it.onGalleryStatus(MentraGalleryStatusEvent(data)) }
            "photo_response" -> dispatchToListeners { it.onPhotoResponse(MentraPhotoResponseEvent(data)) }
            "stream_status" -> dispatchToListeners { it.onStreamStatus(MentraStreamStatusEvent(data)) }
            "mic_pcm" -> (data["pcm"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicPcm(frame) }
            }
            "mic_lc3" -> (data["lc3"] as? ByteArray)?.let { frame ->
                dispatchToListeners { it.onMicLc3(frame) }
            }
            "local_transcription" ->
                dispatchToListeners {
                    it.onLocalTranscription(
                        MentraLocalTranscriptionEvent(
                            text = data["text"] as? String ?: "",
                            isFinal = data["isFinal"] as? Boolean ?: false,
                            values = data,
                        )
                    )
                }
            "compatible_glasses_search_stop" ->
                dispatchToListeners { it.onScanStopped(MentraScanStopReason.COMPLETED) }
            "pair_failure" ->
                dispatchToListeners {
                    it.onError(
                        MentraBluetoothError(
                            code = "pair_failure",
                            message = data["error"] as? String ?: data.toString(),
                        )
                    )
                }
            else -> dispatchToListeners { it.onRawEvent(eventName, data) }
        }
    }

    private fun dispatchToListeners(callback: (MentraBluetoothSdkListener) -> Unit) {
        val snapshot = synchronized(listeners) { listeners.toList() }
        val deliver = {
            snapshot.forEach { listener ->
                try {
                    callback(listener)
                } catch (error: Throwable) {
                    // Listener exceptions should not crash Bluetooth event delivery.
                }
            }
        }
        if (config.deliverCallbacksOnMainThread && Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(deliver)
        } else {
            deliver()
        }
    }
}
