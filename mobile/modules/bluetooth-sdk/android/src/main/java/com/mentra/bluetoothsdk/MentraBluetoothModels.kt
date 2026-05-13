package com.mentra.core

import com.mentra.core.utils.ControllerTypes
import com.mentra.core.utils.DeviceTypes

data class MentraBluetoothSdkConfig(
    val deliverCallbacksOnMainThread: Boolean = true,
)

class MentraBluetoothException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

enum class MentraDeviceModel(val deviceType: String) {
    G1(DeviceTypes.G1),
    G2(DeviceTypes.G2),
    MENTRA_LIVE(DeviceTypes.LIVE),
    MENTRA_NEX(DeviceTypes.NEX),
    MACH1(DeviceTypes.MACH1),
    Z100(DeviceTypes.Z100),
    FRAME(DeviceTypes.FRAME),
    SIMULATED(DeviceTypes.SIMULATED),
    R1(ControllerTypes.R1);

    companion object {
        @JvmStatic
        fun fromDeviceType(deviceType: String?): MentraDeviceModel =
            values().firstOrNull { it.deviceType == deviceType } ?: MENTRA_LIVE
    }
}

data class MentraDevice(
    val model: MentraDeviceModel,
    val name: String,
    val address: String? = null,
    val rssi: Int? = null,
    val id: String = address?.takeIf { it.isNotBlank() } ?: "${model.deviceType}:$name",
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            put("id", id)
            put("model", model.deviceType)
            put("name", name)
            address?.takeIf { it.isNotBlank() }?.let {
                put("address", it)
            }
            rssi?.let { put("rssi", it) }
        }

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraDevice? {
            val model = stringValue(values, "model", "deviceModel", "device_model") ?: return null
            val name = stringValue(values, "name", "deviceName", "device_name") ?: return null
            val address = stringValue(values, "address", "deviceAddress", "device_address")?.takeIf { it.isNotBlank() }
            val rssi = numberValue(values, "rssi", "signalStrength", "signal_strength")
            val id = stringValue(values, "id")?.takeIf { it.isNotBlank() } ?: address ?: "${model}:$name"
            return MentraDevice(
                model = MentraDeviceModel.fromDeviceType(model),
                name = name,
                address = address,
                rssi = rssi,
                id = id,
            )
        }
    }
}

data class MentraConnectOptions(
    val saveAsDefault: Boolean = true,
    val cancelExistingConnectionAttempt: Boolean = true,
)

data class MentraWifiScanResult(
    val ssid: String,
    val requiresPassword: Boolean,
    val signalStrength: Int,
    val frequency: Int? = null,
) {
    internal fun toMap(): Map<String, Any> {
        val map =
            mutableMapOf<String, Any>(
                "ssid" to ssid,
                "requiresPassword" to requiresPassword,
                "signalStrength" to signalStrength,
            )
        frequency?.let { map["frequency"] = it }
        return map
    }

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraWifiScanResult =
            MentraWifiScanResult(
                ssid = stringValue(values, "ssid") ?: "",
                requiresPassword =
                    boolValue(values, "requiresPassword", "requires_password", "auth_required") ?: false,
                signalStrength = numberValue(values, "signalStrength", "signal_strength", "rssi") ?: -1,
                frequency = numberValue(values, "frequency"),
            )
    }
}

data class MentraGlassesStatus(
    val fullyBooted: Boolean,
    val connected: Boolean,
    val micEnabled: Boolean,
    val connectionState: String,
    val btcConnected: Boolean,
    val signalStrength: Int,
    val signalStrengthUpdatedAt: Long,
    val deviceModel: String,
    val androidVersion: String,
    val firmwareVersion: String,
    val besFirmwareVersion: String,
    val mtkFirmwareVersion: String,
    val btMacAddress: String,
    val leftMacAddress: String,
    val rightMacAddress: String,
    val macAddress: String,
    val buildNumber: String,
    val otaVersionUrl: String,
    val appVersion: String,
    val bluetoothName: String,
    val serialNumber: String,
    val style: String,
    val color: String,
    val wifi: MentraWifiStatus,
    val batteryLevel: Int,
    val charging: Boolean,
    val caseBatteryLevel: Int,
    val caseCharging: Boolean,
    val caseOpen: Boolean,
    val caseRemoved: Boolean,
    val hotspot: MentraHotspotStatus,
    val headUp: Boolean,
    val controllerConnected: Boolean,
    val controllerFullyBooted: Boolean,
    val controllerMacAddress: String,
    val controllerBatteryLevel: Int,
    val controllerSignalStrength: Int,
    val ringSignalStrength: Int,
) {
    internal fun toMap(): Map<String, Any> =
        mapOf(
            "fullyBooted" to fullyBooted,
            "connected" to connected,
            "micEnabled" to micEnabled,
            "connectionState" to connectionState,
            "btcConnected" to btcConnected,
            "signalStrength" to signalStrength,
            "signalStrengthUpdatedAt" to signalStrengthUpdatedAt,
            "deviceModel" to deviceModel,
            "androidVersion" to androidVersion,
            "fwVersion" to firmwareVersion,
            "besFwVersion" to besFirmwareVersion,
            "mtkFwVersion" to mtkFirmwareVersion,
            "btMacAddress" to btMacAddress,
            "leftMacAddress" to leftMacAddress,
            "rightMacAddress" to rightMacAddress,
            "macAddress" to macAddress,
            "buildNumber" to buildNumber,
            "otaVersionUrl" to otaVersionUrl,
            "appVersion" to appVersion,
            "bluetoothName" to bluetoothName,
            "serialNumber" to serialNumber,
            "style" to style,
            "color" to color,
            "wifi" to wifi.toMap(),
            "batteryLevel" to batteryLevel,
            "charging" to charging,
            "caseBatteryLevel" to caseBatteryLevel,
            "caseCharging" to caseCharging,
            "caseOpen" to caseOpen,
            "caseRemoved" to caseRemoved,
            "hotspot" to hotspot.toMap(),
            "headUp" to headUp,
            "controllerConnected" to controllerConnected,
            "controllerFullyBooted" to controllerFullyBooted,
            "controllerMacAddress" to controllerMacAddress,
            "controllerBatteryLevel" to controllerBatteryLevel,
            "controllerSignalStrength" to controllerSignalStrength,
            "ringSignalStrength" to ringSignalStrength,
        )

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraGlassesStatus =
            MentraGlassesStatus(
                fullyBooted = boolValue(values, "fullyBooted") ?: false,
                connected = boolValue(values, "connected") ?: false,
                micEnabled = boolValue(values, "micEnabled") ?: false,
                connectionState = stringValue(values, "connectionState") ?: "disconnected",
                btcConnected = boolValue(values, "btcConnected") ?: false,
                signalStrength = numberValue(values, "signalStrength") ?: -1,
                signalStrengthUpdatedAt = longValue(values, "signalStrengthUpdatedAt") ?: 0L,
                deviceModel = stringValue(values, "deviceModel") ?: "",
                androidVersion = stringValue(values, "androidVersion") ?: "",
                firmwareVersion = stringValue(values, "firmwareVersion", "fwVersion") ?: "",
                besFirmwareVersion = stringValue(values, "besFwVersion", "besFirmwareVersion") ?: "",
                mtkFirmwareVersion = stringValue(values, "mtkFwVersion", "mtkFirmwareVersion") ?: "",
                btMacAddress = stringValue(values, "btMacAddress") ?: "",
                leftMacAddress = stringValue(values, "leftMacAddress") ?: "",
                rightMacAddress = stringValue(values, "rightMacAddress") ?: "",
                macAddress = stringValue(values, "macAddress") ?: "",
                buildNumber = stringValue(values, "buildNumber") ?: "",
                otaVersionUrl = stringValue(values, "otaVersionUrl") ?: "",
                appVersion = stringValue(values, "appVersion") ?: "",
                bluetoothName = stringValue(values, "bluetoothName") ?: "",
                serialNumber = stringValue(values, "serialNumber") ?: "",
                style = stringValue(values, "style") ?: "",
                color = stringValue(values, "color") ?: "",
                wifi = MentraWifiStatus.fromStoreMap(values) ?: MentraWifiStatus.Disconnected,
                batteryLevel = numberValue(values, "batteryLevel") ?: -1,
                charging = boolValue(values, "charging") ?: false,
                caseBatteryLevel = numberValue(values, "caseBatteryLevel") ?: -1,
                caseCharging = boolValue(values, "caseCharging") ?: false,
                caseOpen = boolValue(values, "caseOpen") ?: true,
                caseRemoved = boolValue(values, "caseRemoved") ?: true,
                hotspot = MentraHotspotStatus.fromMap(values),
                headUp = boolValue(values, "headUp") ?: false,
                controllerConnected = boolValue(values, "controllerConnected") ?: false,
                controllerFullyBooted = boolValue(values, "controllerFullyBooted") ?: false,
                controllerMacAddress = stringValue(values, "controllerMacAddress") ?: "",
                controllerBatteryLevel = numberValue(values, "controllerBatteryLevel") ?: -1,
                controllerSignalStrength = numberValue(values, "controllerSignalStrength") ?: -1,
                ringSignalStrength = numberValue(values, "ringSignalStrength") ?: -1,
            )
    }
}

data class MentraBluetoothStatus(
    val searching: Boolean,
    val searchingController: Boolean,
    val systemMicUnavailable: Boolean,
    val micEnabled: Boolean,
    val currentMic: String,
    val micRanking: List<String>,
    val searchResults: List<MentraDevice>,
    val wifiScanResults: List<MentraWifiScanResult>,
    val lastLog: List<String>,
    val otherBtConnected: Boolean,
    val defaultWearable: String,
    val pendingWearable: String,
    val deviceName: String,
    val deviceAddress: String,
    val defaultController: String,
    val pendingController: String,
    val controllerDeviceName: String,
    val screenDisabled: Boolean,
    val preferredMic: String,
    val sensingEnabled: Boolean,
    val powerSavingMode: Boolean,
    val brightness: Int,
    val autoBrightness: Boolean,
    val dashboardHeight: Int,
    val dashboardDepth: Int,
    val headUpAngle: Int,
    val contextualDashboard: Boolean,
    val galleryModeAuto: Boolean,
    val buttonPhotoSize: MentraButtonPhotoSize,
    val buttonCameraLed: Boolean,
    val buttonMaxRecordingTime: Int,
    val buttonVideoWidth: Int,
    val buttonVideoHeight: Int,
    val buttonVideoFps: Int,
    val shouldSendPcm: Boolean,
    val shouldSendLc3: Boolean,
    val shouldSendTranscript: Boolean,
    val bypassVad: Boolean,
    val offlineCaptionsRunning: Boolean,
    val localSttFallbackActive: Boolean,
    val shouldSendBootingMessage: Boolean,
) {
    val defaultDevice: MentraDevice?
        get() =
            defaultWearable.takeIf { it.isNotBlank() }?.let {
                MentraDevice(
                    model = MentraDeviceModel.fromDeviceType(it),
                    name = deviceName,
                    address = deviceAddress.takeIf(String::isNotBlank),
                )
            }

    internal fun toMap(): Map<String, Any> =
        mapOf(
            "searching" to searching,
            "searchingController" to searchingController,
            "systemMicUnavailable" to systemMicUnavailable,
            "micEnabled" to micEnabled,
            "currentMic" to currentMic,
            "micRanking" to micRanking,
            "searchResults" to searchResults.map(MentraDevice::toMap),
            "wifiScanResults" to wifiScanResults.map { it.toMap() },
            "lastLog" to lastLog,
            "otherBtConnected" to otherBtConnected,
            "default_wearable" to defaultWearable,
            "pending_wearable" to pendingWearable,
            "device_name" to deviceName,
            "device_address" to deviceAddress,
            "default_controller" to defaultController,
            "pending_controller" to pendingController,
            "controller_device_name" to controllerDeviceName,
            "screen_disabled" to screenDisabled,
            "preferred_mic" to preferredMic,
            "sensing_enabled" to sensingEnabled,
            "power_saving_mode" to powerSavingMode,
            "brightness" to brightness,
            "auto_brightness" to autoBrightness,
            "dashboard_height" to dashboardHeight,
            "dashboard_depth" to dashboardDepth,
            "head_up_angle" to headUpAngle,
            "contextual_dashboard" to contextualDashboard,
            "gallery_mode" to galleryModeAuto,
            "button_photo_size" to buttonPhotoSize.value,
            "button_camera_led" to buttonCameraLed,
            "button_max_recording_time" to buttonMaxRecordingTime,
            "button_video_width" to buttonVideoWidth,
            "button_video_height" to buttonVideoHeight,
            "button_video_fps" to buttonVideoFps,
            "should_send_pcm" to shouldSendPcm,
            "should_send_lc3" to shouldSendLc3,
            "should_send_transcript" to shouldSendTranscript,
            "bypass_vad" to bypassVad,
            "offline_captions_running" to offlineCaptionsRunning,
            "local_stt_fallback_active" to localSttFallbackActive,
            "shouldSendBootingMessage" to shouldSendBootingMessage,
        )

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraBluetoothStatus =
            MentraBluetoothStatus(
                searching = boolValue(values, "searching") ?: false,
                searchingController = boolValue(values, "searchingController") ?: false,
                systemMicUnavailable = boolValue(values, "systemMicUnavailable") ?: false,
                micEnabled = boolValue(values, "micEnabled") ?: false,
                currentMic = stringValue(values, "currentMic") ?: "",
                micRanking = stringListValue(values, "micRanking"),
                searchResults =
                    mapListValue(values, "searchResults").mapNotNull(MentraDevice::fromMap),
                wifiScanResults =
                    mapListValue(values, "wifiScanResults").map(MentraWifiScanResult::fromMap),
                lastLog = stringListValue(values, "lastLog"),
                otherBtConnected = boolValue(values, "otherBtConnected") ?: false,
                defaultWearable = stringValue(values, "default_wearable") ?: "",
                pendingWearable = stringValue(values, "pending_wearable") ?: "",
                deviceName = stringValue(values, "device_name") ?: "",
                deviceAddress = stringValue(values, "device_address") ?: "",
                defaultController = stringValue(values, "default_controller") ?: "",
                pendingController = stringValue(values, "pending_controller") ?: "",
                controllerDeviceName = stringValue(values, "controller_device_name") ?: "",
                screenDisabled = boolValue(values, "screen_disabled") ?: false,
                preferredMic = stringValue(values, "preferred_mic") ?: "auto",
                sensingEnabled = boolValue(values, "sensing_enabled") ?: true,
                powerSavingMode = boolValue(values, "power_saving_mode") ?: false,
                brightness = numberValue(values, "brightness") ?: 50,
                autoBrightness = boolValue(values, "auto_brightness") ?: true,
                dashboardHeight = numberValue(values, "dashboard_height") ?: 4,
                dashboardDepth = numberValue(values, "dashboard_depth") ?: 2,
                headUpAngle = numberValue(values, "head_up_angle") ?: 30,
                contextualDashboard = boolValue(values, "contextual_dashboard") ?: true,
                galleryModeAuto = boolValue(values, "gallery_mode") ?: false,
                buttonPhotoSize = MentraButtonPhotoSize.fromValue(stringValue(values, "button_photo_size")),
                buttonCameraLed = boolValue(values, "button_camera_led") ?: true,
                buttonMaxRecordingTime = numberValue(values, "button_max_recording_time") ?: 10,
                buttonVideoWidth = numberValue(values, "button_video_width") ?: 1280,
                buttonVideoHeight = numberValue(values, "button_video_height") ?: 720,
                buttonVideoFps = numberValue(values, "button_video_fps") ?: 30,
                shouldSendPcm = boolValue(values, "should_send_pcm") ?: false,
                shouldSendLc3 = boolValue(values, "should_send_lc3") ?: false,
                shouldSendTranscript = boolValue(values, "should_send_transcript") ?: false,
                bypassVad = boolValue(values, "bypass_vad") ?: false,
                offlineCaptionsRunning = boolValue(values, "offline_captions_running") ?: false,
                localSttFallbackActive = boolValue(values, "local_stt_fallback_active") ?: false,
                shouldSendBootingMessage = boolValue(values, "shouldSendBootingMessage") ?: true,
            )
    }
}

data class MentraGlassesStatusUpdate(
    val fullyBooted: Boolean? = null,
    val connected: Boolean? = null,
    val micEnabled: Boolean? = null,
    val connectionState: String? = null,
    val btcConnected: Boolean? = null,
    val signalStrength: Int? = null,
    val signalStrengthUpdatedAt: Long? = null,
    val deviceModel: String? = null,
    val androidVersion: String? = null,
    val firmwareVersion: String? = null,
    val besFirmwareVersion: String? = null,
    val mtkFirmwareVersion: String? = null,
    val btMacAddress: String? = null,
    val leftMacAddress: String? = null,
    val rightMacAddress: String? = null,
    val macAddress: String? = null,
    val buildNumber: String? = null,
    val otaVersionUrl: String? = null,
    val appVersion: String? = null,
    val bluetoothName: String? = null,
    val serialNumber: String? = null,
    val style: String? = null,
    val color: String? = null,
    val wifi: MentraWifiStatus? = null,
    val batteryLevel: Int? = null,
    val charging: Boolean? = null,
    val caseBatteryLevel: Int? = null,
    val caseCharging: Boolean? = null,
    val caseOpen: Boolean? = null,
    val caseRemoved: Boolean? = null,
    val hotspot: MentraHotspotStatus? = null,
    val headUp: Boolean? = null,
    val controllerConnected: Boolean? = null,
    val controllerFullyBooted: Boolean? = null,
    val controllerMacAddress: String? = null,
    val controllerBatteryLevel: Int? = null,
    val controllerSignalStrength: Int? = null,
    val ringSignalStrength: Int? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            putIfNotNull("fullyBooted", fullyBooted)
            putIfNotNull("connected", connected)
            putIfNotNull("micEnabled", micEnabled)
            putIfNotNull("connectionState", connectionState)
            putIfNotNull("btcConnected", btcConnected)
            putIfNotNull("signalStrength", signalStrength)
            putIfNotNull("signalStrengthUpdatedAt", signalStrengthUpdatedAt)
            putIfNotNull("deviceModel", deviceModel)
            putIfNotNull("androidVersion", androidVersion)
            putIfNotNull("fwVersion", firmwareVersion)
            putIfNotNull("besFwVersion", besFirmwareVersion)
            putIfNotNull("mtkFwVersion", mtkFirmwareVersion)
            putIfNotNull("btMacAddress", btMacAddress)
            putIfNotNull("leftMacAddress", leftMacAddress)
            putIfNotNull("rightMacAddress", rightMacAddress)
            putIfNotNull("macAddress", macAddress)
            putIfNotNull("buildNumber", buildNumber)
            putIfNotNull("otaVersionUrl", otaVersionUrl)
            putIfNotNull("appVersion", appVersion)
            putIfNotNull("bluetoothName", bluetoothName)
            putIfNotNull("serialNumber", serialNumber)
            putIfNotNull("style", style)
            putIfNotNull("color", color)
            wifi?.let {
                put("wifi", it.toMap())
            }
            putIfNotNull("batteryLevel", batteryLevel)
            putIfNotNull("charging", charging)
            putIfNotNull("caseBatteryLevel", caseBatteryLevel)
            putIfNotNull("caseCharging", caseCharging)
            putIfNotNull("caseOpen", caseOpen)
            putIfNotNull("caseRemoved", caseRemoved)
            hotspot?.let {
                put("hotspot", it.toMap())
            }
            putIfNotNull("headUp", headUp)
            putIfNotNull("controllerConnected", controllerConnected)
            putIfNotNull("controllerFullyBooted", controllerFullyBooted)
            putIfNotNull("controllerMacAddress", controllerMacAddress)
            putIfNotNull("controllerBatteryLevel", controllerBatteryLevel)
            putIfNotNull("controllerSignalStrength", controllerSignalStrength)
            putIfNotNull("ringSignalStrength", ringSignalStrength)
        }

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraGlassesStatusUpdate =
            MentraGlassesStatusUpdate(
                fullyBooted = optionalBoolValue(values, "fullyBooted"),
                connected = optionalBoolValue(values, "connected"),
                micEnabled = optionalBoolValue(values, "micEnabled"),
                connectionState = optionalStringValue(values, "connectionState"),
                btcConnected = optionalBoolValue(values, "btcConnected"),
                signalStrength = optionalNumberValue(values, "signalStrength"),
                signalStrengthUpdatedAt = optionalLongValue(values, "signalStrengthUpdatedAt"),
                deviceModel = optionalStringValue(values, "deviceModel"),
                androidVersion = optionalStringValue(values, "androidVersion"),
                firmwareVersion = optionalStringValue(values, "firmwareVersion", "fwVersion"),
                besFirmwareVersion = optionalStringValue(values, "besFwVersion", "besFirmwareVersion"),
                mtkFirmwareVersion = optionalStringValue(values, "mtkFwVersion", "mtkFirmwareVersion"),
                btMacAddress = optionalStringValue(values, "btMacAddress"),
                leftMacAddress = optionalStringValue(values, "leftMacAddress"),
                rightMacAddress = optionalStringValue(values, "rightMacAddress"),
                macAddress = optionalStringValue(values, "macAddress"),
                buildNumber = optionalStringValue(values, "buildNumber"),
                otaVersionUrl = optionalStringValue(values, "otaVersionUrl"),
                appVersion = optionalStringValue(values, "appVersion"),
                bluetoothName = optionalStringValue(values, "bluetoothName"),
                serialNumber = optionalStringValue(values, "serialNumber"),
                style = optionalStringValue(values, "style"),
                color = optionalStringValue(values, "color"),
                wifi =
                    if (hasAnyKey(values, "wifi")) {
                        MentraWifiStatus.fromMap(values)
                    } else if (hasAnyKey(values, "wifiConnected", "wifiSsid", "wifiLocalIp")) {
                        MentraWifiStatus.fromStoreMap(values)
                    } else {
                        null
                    },
                batteryLevel = optionalNumberValue(values, "batteryLevel"),
                charging = optionalBoolValue(values, "charging"),
                caseBatteryLevel = optionalNumberValue(values, "caseBatteryLevel"),
                caseCharging = optionalBoolValue(values, "caseCharging"),
                caseOpen = optionalBoolValue(values, "caseOpen"),
                caseRemoved = optionalBoolValue(values, "caseRemoved"),
                hotspot =
                    if (hasAnyKey(values, "hotspot", "enabled", "hotspotEnabled", "hotspotSsid", "hotspotPassword", "hotspotGatewayIp", "hotspotLocalIp")) {
                        MentraHotspotStatus.fromMap(values)
                    } else {
                        null
                    },
                headUp = optionalBoolValue(values, "headUp"),
                controllerConnected = optionalBoolValue(values, "controllerConnected"),
                controllerFullyBooted = optionalBoolValue(values, "controllerFullyBooted"),
                controllerMacAddress = optionalStringValue(values, "controllerMacAddress"),
                controllerBatteryLevel = optionalNumberValue(values, "controllerBatteryLevel"),
                controllerSignalStrength = optionalNumberValue(values, "controllerSignalStrength"),
                ringSignalStrength = optionalNumberValue(values, "ringSignalStrength"),
            )
    }
}

data class MentraBluetoothStatusUpdate(
    val searching: Boolean? = null,
    val searchingController: Boolean? = null,
    val systemMicUnavailable: Boolean? = null,
    val micEnabled: Boolean? = null,
    val currentMic: String? = null,
    val micRanking: List<String>? = null,
    val searchResults: List<MentraDevice>? = null,
    val wifiScanResults: List<MentraWifiScanResult>? = null,
    val lastLog: List<String>? = null,
    val otherBtConnected: Boolean? = null,
    val defaultWearable: String? = null,
    val pendingWearable: String? = null,
    val deviceName: String? = null,
    val deviceAddress: String? = null,
    val defaultController: String? = null,
    val pendingController: String? = null,
    val controllerDeviceName: String? = null,
    val screenDisabled: Boolean? = null,
    val preferredMic: String? = null,
    val sensingEnabled: Boolean? = null,
    val powerSavingMode: Boolean? = null,
    val brightness: Int? = null,
    val autoBrightness: Boolean? = null,
    val dashboardHeight: Int? = null,
    val dashboardDepth: Int? = null,
    val headUpAngle: Int? = null,
    val contextualDashboard: Boolean? = null,
    val galleryModeAuto: Boolean? = null,
    val buttonPhotoSize: MentraButtonPhotoSize? = null,
    val buttonCameraLed: Boolean? = null,
    val buttonMaxRecordingTime: Int? = null,
    val buttonVideoWidth: Int? = null,
    val buttonVideoHeight: Int? = null,
    val buttonVideoFps: Int? = null,
    val shouldSendPcm: Boolean? = null,
    val shouldSendLc3: Boolean? = null,
    val shouldSendTranscript: Boolean? = null,
    val bypassVad: Boolean? = null,
    val offlineCaptionsRunning: Boolean? = null,
    val localSttFallbackActive: Boolean? = null,
    val shouldSendBootingMessage: Boolean? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            putIfNotNull("searching", searching)
            putIfNotNull("searchingController", searchingController)
            putIfNotNull("systemMicUnavailable", systemMicUnavailable)
            putIfNotNull("micEnabled", micEnabled)
            putIfNotNull("currentMic", currentMic)
            putIfNotNull("micRanking", micRanking)
            searchResults?.let { put("searchResults", it.map(MentraDevice::toMap)) }
            wifiScanResults?.let { put("wifiScanResults", it.map(MentraWifiScanResult::toMap)) }
            putIfNotNull("lastLog", lastLog)
            putIfNotNull("otherBtConnected", otherBtConnected)
            putIfNotNull("default_wearable", defaultWearable)
            putIfNotNull("pending_wearable", pendingWearable)
            putIfNotNull("device_name", deviceName)
            putIfNotNull("device_address", deviceAddress)
            putIfNotNull("default_controller", defaultController)
            putIfNotNull("pending_controller", pendingController)
            putIfNotNull("controller_device_name", controllerDeviceName)
            putIfNotNull("screen_disabled", screenDisabled)
            putIfNotNull("preferred_mic", preferredMic)
            putIfNotNull("sensing_enabled", sensingEnabled)
            putIfNotNull("power_saving_mode", powerSavingMode)
            putIfNotNull("brightness", brightness)
            putIfNotNull("auto_brightness", autoBrightness)
            putIfNotNull("dashboard_height", dashboardHeight)
            putIfNotNull("dashboard_depth", dashboardDepth)
            putIfNotNull("head_up_angle", headUpAngle)
            putIfNotNull("contextual_dashboard", contextualDashboard)
            putIfNotNull("gallery_mode", galleryModeAuto)
            buttonPhotoSize?.let { put("button_photo_size", it.value) }
            putIfNotNull("button_camera_led", buttonCameraLed)
            putIfNotNull("button_max_recording_time", buttonMaxRecordingTime)
            putIfNotNull("button_video_width", buttonVideoWidth)
            putIfNotNull("button_video_height", buttonVideoHeight)
            putIfNotNull("button_video_fps", buttonVideoFps)
            putIfNotNull("should_send_pcm", shouldSendPcm)
            putIfNotNull("should_send_lc3", shouldSendLc3)
            putIfNotNull("should_send_transcript", shouldSendTranscript)
            putIfNotNull("bypass_vad", bypassVad)
            putIfNotNull("offline_captions_running", offlineCaptionsRunning)
            putIfNotNull("local_stt_fallback_active", localSttFallbackActive)
            putIfNotNull("shouldSendBootingMessage", shouldSendBootingMessage)
        }

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraBluetoothStatusUpdate =
            MentraBluetoothStatusUpdate(
                searching = optionalBoolValue(values, "searching"),
                searchingController = optionalBoolValue(values, "searchingController"),
                systemMicUnavailable = optionalBoolValue(values, "systemMicUnavailable"),
                micEnabled = optionalBoolValue(values, "micEnabled"),
                currentMic = optionalStringValue(values, "currentMic"),
                micRanking = optionalStringListValue(values, "micRanking"),
                searchResults =
                    optionalMapListValue(values, "searchResults")
                        ?.mapNotNull(MentraDevice::fromMap),
                wifiScanResults =
                    optionalMapListValue(values, "wifiScanResults")
                        ?.map(MentraWifiScanResult::fromMap),
                lastLog = optionalStringListValue(values, "lastLog"),
                otherBtConnected = optionalBoolValue(values, "otherBtConnected"),
                defaultWearable = optionalStringValue(values, "default_wearable"),
                pendingWearable = optionalStringValue(values, "pending_wearable"),
                deviceName = optionalStringValue(values, "device_name"),
                deviceAddress = optionalStringValue(values, "device_address"),
                defaultController = optionalStringValue(values, "default_controller"),
                pendingController = optionalStringValue(values, "pending_controller"),
                controllerDeviceName = optionalStringValue(values, "controller_device_name"),
                screenDisabled = optionalBoolValue(values, "screen_disabled"),
                preferredMic = optionalStringValue(values, "preferred_mic"),
                sensingEnabled = optionalBoolValue(values, "sensing_enabled"),
                powerSavingMode = optionalBoolValue(values, "power_saving_mode"),
                brightness = optionalNumberValue(values, "brightness"),
                autoBrightness = optionalBoolValue(values, "auto_brightness"),
                dashboardHeight = optionalNumberValue(values, "dashboard_height"),
                dashboardDepth = optionalNumberValue(values, "dashboard_depth"),
                headUpAngle = optionalNumberValue(values, "head_up_angle"),
                contextualDashboard = optionalBoolValue(values, "contextual_dashboard"),
                galleryModeAuto = optionalBoolValue(values, "gallery_mode"),
                buttonPhotoSize =
                    optionalStringValue(values, "button_photo_size")?.let(MentraButtonPhotoSize::fromValue),
                buttonCameraLed = optionalBoolValue(values, "button_camera_led"),
                buttonMaxRecordingTime = optionalNumberValue(values, "button_max_recording_time"),
                buttonVideoWidth = optionalNumberValue(values, "button_video_width"),
                buttonVideoHeight = optionalNumberValue(values, "button_video_height"),
                buttonVideoFps = optionalNumberValue(values, "button_video_fps"),
                shouldSendPcm = optionalBoolValue(values, "should_send_pcm"),
                shouldSendLc3 = optionalBoolValue(values, "should_send_lc3"),
                shouldSendTranscript = optionalBoolValue(values, "should_send_transcript"),
                bypassVad = optionalBoolValue(values, "bypass_vad"),
                offlineCaptionsRunning = optionalBoolValue(values, "offline_captions_running"),
                localSttFallbackActive = optionalBoolValue(values, "local_stt_fallback_active"),
                shouldSendBootingMessage = optionalBoolValue(values, "shouldSendBootingMessage"),
            )
    }
}

data class MentraDisplayTextRequest(
    val text: String,
    val x: Int = 0,
    val y: Int = 0,
    val size: Int = 24,
) {
    fun toMap(): Map<String, Any> =
        mapOf(
            "text" to text,
            "x" to x,
            "y" to y,
            "size" to size,
        )
}

data class MentraDisplayEventRequest(
    val values: Map<String, Any>,
) {
    fun toMap(): Map<String, Any> = values
}

data class MentraDashboardPositionRequest(
    val height: Int,
    val depth: Int,
)

data class MentraDashboardMenuItem(
    val title: String,
    val packageName: String,
    val values: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> =
        values + mapOf(
            "title" to title,
            "packageName" to packageName,
        )
}

enum class MentraGalleryMode {
    AUTO,
    MANUAL,
}

enum class MentraPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
    FULL("full");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraPhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class MentraButtonPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraButtonPhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class MentraPhotoCompression(val value: String) {
    NONE("none"),
    MEDIUM("medium"),
    HEAVY("heavy");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraPhotoCompression =
            values().firstOrNull { it.value == value } ?: NONE
    }
}

data class MentraButtonPhotoSettings(
    val size: MentraButtonPhotoSize,
)

data class MentraButtonVideoRecordingSettings(
    val width: Int,
    val height: Int,
    val fps: Int,
)

enum class MentraCameraFov(val fov: Int, val roiPosition: Int) {
    STANDARD(118, 0),
    WIDE(118, 0),
}

data class MentraMicConfig(
    val sendPcmData: Boolean,
    val sendTranscript: Boolean,
    val bypassVad: Boolean,
    val sendLc3Data: Boolean = false,
)

enum class MentraMicPreference(val value: String) {
    AUTO("auto"),
    PHONE("phone"),
    GLASSES("glasses"),
    BT_CLASSIC("btclassic"),
    BT("bt"),
}

data class MentraPhotoRequest @JvmOverloads constructor(
    val requestId: String,
    val appId: String,
    val size: MentraPhotoSize,
    val webhookUrl: String,
    val authToken: String? = null,
    val compress: MentraPhotoCompression = MentraPhotoCompression.MEDIUM,
    val flash: Boolean = false,
    val sound: Boolean = true,
)

data class MentraStreamVideoConfig @JvmOverloads constructor(
    val width: Int? = null,
    val height: Int? = null,
    val bitrate: Int? = null,
    val frameRate: Int? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            width?.let { "width" to it },
            height?.let { "height" to it },
            bitrate?.let { "bitrate" to it },
            frameRate?.let { "frameRate" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<*, *>?): MentraStreamVideoConfig? {
            values ?: return null
            return MentraStreamVideoConfig(
                width = numberValue(values, "width", "w"),
                height = numberValue(values, "height", "h"),
                bitrate = numberValue(values, "bitrate", "br"),
                frameRate = numberValue(values, "frameRate", "fr"),
            )
        }
    }
}

data class MentraStreamAudioConfig @JvmOverloads constructor(
    val bitrate: Int? = null,
    val sampleRate: Int? = null,
    val echoCancellation: Boolean? = null,
    val noiseSuppression: Boolean? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            bitrate?.let { "bitrate" to it },
            sampleRate?.let { "sampleRate" to it },
            echoCancellation?.let { "echoCancellation" to it },
            noiseSuppression?.let { "noiseSuppression" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<*, *>?): MentraStreamAudioConfig? {
            values ?: return null
            return MentraStreamAudioConfig(
                bitrate = numberValue(values, "bitrate", "br"),
                sampleRate = numberValue(values, "sampleRate", "sr"),
                echoCancellation = values["echoCancellation"] as? Boolean ?: values["ec"] as? Boolean,
                noiseSuppression = values["noiseSuppression"] as? Boolean ?: values["ns"] as? Boolean,
            )
        }
    }
}

data class MentraStreamRequest @JvmOverloads constructor(
    val streamUrl: String,
    val streamId: String = "",
    val keepAlive: Boolean = true,
    val keepAliveIntervalSeconds: Int = 15,
    val flash: Boolean = true,
    val sound: Boolean = true,
    val video: MentraStreamVideoConfig? = null,
    val audio: MentraStreamAudioConfig? = null,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        values["flash"] = flash
        values["sound"] = sound
        video?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["video"] = it }
        audio?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["audio"] = it }
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraStreamRequest =
            MentraStreamRequest(
                streamUrl =
                    (values["streamUrl"] ?: values["rtmpUrl"] ?: values["srtUrl"] ?: values["whipUrl"]) as? String
                        ?: "",
                streamId = values["streamId"] as? String ?: "",
                keepAlive = values["keepAlive"] as? Boolean ?: true,
                keepAliveIntervalSeconds = (values["keepAliveIntervalSeconds"] as? Number)?.toInt() ?: 15,
                flash = values["flash"] as? Boolean ?: true,
                sound = values["sound"] as? Boolean ?: true,
                video = MentraStreamVideoConfig.fromMap((values["video"] ?: values["v"]) as? Map<*, *>),
                audio = MentraStreamAudioConfig.fromMap((values["audio"] ?: values["a"]) as? Map<*, *>),
                extraValues = values,
            )
    }
}

data class MentraStreamKeepAliveRequest @JvmOverloads constructor(
    val streamId: String,
    val ackId: String,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraStreamKeepAliveRequest =
            MentraStreamKeepAliveRequest(
                streamId = values["streamId"] as? String ?: "",
                ackId = values["ackId"] as? String ?: "",
                extraValues = values,
            )
    }
}

enum class MentraRgbLedAction(val value: String) {
    ON("on"),
    OFF("off");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraRgbLedAction =
            values().firstOrNull { it.value == value } ?: OFF
    }
}

enum class MentraRgbLedColor(val value: String) {
    RED("red"),
    GREEN("green"),
    BLUE("blue"),
    ORANGE("orange"),
    WHITE("white");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraRgbLedColor? =
            values().firstOrNull { it.value == value }
    }
}

data class MentraRgbLedRequest @JvmOverloads constructor(
    val requestId: String,
    val packageName: String?,
    val action: MentraRgbLedAction,
    val color: MentraRgbLedColor?,
    val ontime: Int,
    val offtime: Int,
    val count: Int,
)

data class MentraVideoRecordingRequest(
    val requestId: String,
    val save: Boolean,
    val flash: Boolean,
    val sound: Boolean,
)

data class MentraButtonPressEvent(
    val buttonId: String,
    val pressType: String,
    val timestamp: Long? = null,
)

data class MentraTouchEvent(
    val values: Map<String, Any>,
) {
    val deviceModel: String? get() = stringValue(values, "device_model", "deviceModel")
    val gestureName: String? get() = stringValue(values, "gesture_name", "gestureName")
    val timestamp: Long? get() = longValue(values, "timestamp")
    val isSwipe: Boolean get() = gestureName?.contains("swipe", ignoreCase = true) == true
}

data class MentraSwipeEvent(
    val values: Map<String, Any>,
) {
    val deviceModel: String? get() = stringValue(values, "device_model", "deviceModel")
    val gestureName: String? get() = stringValue(values, "gesture_name", "gestureName")
    val timestamp: Long? get() = longValue(values, "timestamp")
}

data class MentraBatteryStatusEvent(
    val level: Int?,
    val charging: Boolean?,
    val values: Map<String, Any>,
)

sealed interface MentraWifiStatus {
    val state: String

    fun toMap(): Map<String, Any> =
        when (this) {
            is Connected -> {
                val values =
                    mutableMapOf<String, Any>(
                        "state" to state,
                        "ssid" to ssid,
                    )
                localIp?.let { values["localIp"] = it }
                values
            }
            Disconnected -> mapOf("state" to state)
        }

    fun toEventMap(): Map<String, Any> =
        toMap() + mapOf("type" to "wifi_status_change")

    object Disconnected : MentraWifiStatus {
        override val state: String = "disconnected"
    }

    data class Connected(
        val ssid: String,
        val localIp: String?,
    ) : MentraWifiStatus {
        override val state: String = "connected"
    }

    companion object {
        internal fun fromMap(values: Map<String, Any>): MentraWifiStatus? {
            val wifiValues = (values["wifi"] as? Map<*, *>)?.stringKeyedMap() ?: values
            return when (stringValue(wifiValues, "state")?.lowercase()) {
                "connected" -> connectedFrom(wifiValues)
                "disconnected" -> Disconnected
                else -> null
            }
        }

        internal fun fromStoreMap(values: Map<String, Any>): MentraWifiStatus? {
            val connected = boolValue(values, "wifiConnected") ?: return null
            return fromStoreFields(
                connected = connected,
                ssid = stringValue(values, "wifiSsid"),
                localIp = stringValue(values, "wifiLocalIp"),
            )
        }

        internal fun fromStoreFields(connected: Boolean, ssid: String?, localIp: String?): MentraWifiStatus? {
            if (!connected) return Disconnected
            val nonEmptySsid = ssid?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyLocalIp = localIp?.trim()?.takeIf { it.isNotEmpty() }
            return nonEmptySsid?.let { Connected(it, nonEmptyLocalIp) }
        }

        private fun connectedFrom(values: Map<String, Any>): MentraWifiStatus? =
            fromStoreFields(
                connected = true,
                ssid = stringValue(values, "ssid"),
                localIp = stringValue(values, "localIp"),
            )
    }
}

data class MentraWifiStatusEvent(
    val status: MentraWifiStatus,
) {
    internal constructor(values: Map<String, Any>) : this(MentraWifiStatus.fromMap(values) ?: MentraWifiStatus.Disconnected)
    internal constructor(connected: Boolean, ssid: String?, localIp: String?) : this(
        MentraWifiStatus.fromStoreFields(connected, ssid, localIp) ?: MentraWifiStatus.Disconnected
    )

    val values: Map<String, Any> get() = status.toEventMap()
}

sealed interface MentraHotspotStatus {
    val state: String

    fun toMap(): Map<String, Any> =
        when (this) {
            is Enabled ->
                mapOf(
                    "state" to state,
                    "ssid" to ssid,
                    "password" to password,
                    "localIp" to localIp,
                )
            Disabled -> mapOf("state" to state)
            Unknown -> mapOf("state" to state)
        }

    fun toEventMap(): Map<String, Any> =
        toMap() + mapOf("type" to "hotspot_status_change")

    object Unknown : MentraHotspotStatus {
        override val state: String = "unknown"
    }

    object Disabled : MentraHotspotStatus {
        override val state: String = "disabled"
    }

    data class Enabled(
        val ssid: String,
        val password: String,
        val localIp: String,
    ) : MentraHotspotStatus {
        override val state: String = "enabled"
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraHotspotStatus {
            val hotspotValues = (values["hotspot"] as? Map<*, *>)?.stringKeyedMap() ?: values
            return when (stringValue(hotspotValues, "state", "hotspotState")?.lowercase()) {
                "enabled" -> enabledFrom(hotspotValues)
                "disabled" -> Disabled
                "unknown" -> Unknown
                else -> {
                    when (boolValue(hotspotValues, "enabled") ?: boolValue(hotspotValues, "hotspotEnabled")) {
                        true -> enabledFrom(hotspotValues)
                        false -> Disabled
                        null -> Unknown
                    }
                }
            }
        }

        @JvmStatic
        fun fromRaw(enabled: Boolean, ssid: String?, password: String?, localIp: String?): MentraHotspotStatus {
            if (!enabled) return Disabled
            val nonEmptySsid = ssid?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyPassword = password?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyLocalIp = localIp?.trim()?.takeIf { it.isNotEmpty() }
            return if (nonEmptySsid != null && nonEmptyPassword != null && nonEmptyLocalIp != null) {
                Enabled(nonEmptySsid, nonEmptyPassword, nonEmptyLocalIp)
            } else {
                Unknown
            }
        }

        private fun enabledFrom(values: Map<String, Any>): MentraHotspotStatus =
            fromRaw(
                enabled = true,
                ssid = stringValue(values, "ssid", "hotspotSsid"),
                password = stringValue(values, "password", "hotspotPassword"),
                localIp = stringValue(values, "localIp", "local_ip", "hotspotGatewayIp", "hotspotLocalIp"),
            )
    }
}

data class MentraHotspotStatusEvent(
    val status: MentraHotspotStatus,
) {
    constructor(values: Map<String, Any>) : this(MentraHotspotStatus.fromMap(values))
    constructor(enabled: Boolean, ssid: String?, password: String?, localIp: String?) : this(
        MentraHotspotStatus.fromRaw(enabled, ssid, password, localIp)
    )

    val values: Map<String, Any> get() = status.toEventMap()
}

data class MentraHotspotErrorEvent(
    val values: Map<String, Any>,
) {
    val message: String? get() = stringValue(values, "error_message", "message", "error")
    val timestamp: Long? get() = longValue(values, "timestamp")
}

data class MentraGalleryStatusEvent(
    val values: Map<String, Any>,
)

sealed interface MentraPhotoResponse {
    val state: String
    val requestId: String
    val timestamp: Long

    fun toMap(): Map<String, Any> =
        when (this) {
            is Success -> mapOf(
                "state" to state,
                "requestId" to requestId,
                "photoUrl" to photoUrl,
                "timestamp" to timestamp,
            )

            is Error -> mutableMapOf<String, Any>(
                "state" to state,
                "requestId" to requestId,
                "timestamp" to timestamp,
                "errorMessage" to errorMessage,
            ).apply {
                if (!errorCode.isNullOrBlank()) {
                    this["errorCode"] = errorCode
                }
            }
        }

    fun toEventMap(): Map<String, Any> = toMap() + mapOf("type" to "photo_response")

    data class Success(
        override val requestId: String,
        val photoUrl: String,
        override val timestamp: Long,
    ) : MentraPhotoResponse {
        override val state: String = "success"
    }

    data class Error(
        override val requestId: String,
        val errorCode: String?,
        val errorMessage: String,
        override val timestamp: Long,
    ) : MentraPhotoResponse {
        override val state: String = "error"
    }

    companion object {
        fun fromMap(values: Map<String, Any>): MentraPhotoResponse {
            val requestId = stringValue(values, "requestId", "request_id").orEmpty()
            val timestamp = longValue(values, "timestamp") ?: System.currentTimeMillis()
            val state = stringValue(values, "state", "status")?.lowercase()
            val success = boolValue(values, "success")
            return if (state == "success" || success == true) {
                val photoUrl = stringValue(values, "photoUrl", "photo_url").orEmpty()
                Success(requestId = requestId, photoUrl = photoUrl, timestamp = timestamp)
            } else {
                Error(
                    requestId = requestId,
                    errorCode = stringValue(values, "errorCode", "error_code"),
                    errorMessage = stringValue(values, "errorMessage", "error_message", "error")
                        ?: "Unknown photo error",
                    timestamp = timestamp,
                )
            }
        }
    }
}

data class MentraPhotoResponseEvent(
    val response: MentraPhotoResponse,
) {
    constructor(values: Map<String, Any>) : this(MentraPhotoResponse.fromMap(values))

    val requestId: String get() = response.requestId
    val values: Map<String, Any> get() = response.toEventMap()
}

enum class MentraStreamState(val value: String) {
    INITIALIZING("initializing"),
    STREAMING("streaming"),
    STOPPING("stopping"),
    STOPPED("stopped"),
    RECONNECTING("reconnecting"),
    RECONNECTED("reconnected"),
    RECONNECT_FAILED("reconnect_failed"),
    ERROR("error");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): MentraStreamState? =
            when (value?.lowercase()) {
                "initializing", "starting", "connecting" -> INITIALIZING
                "streaming", "streaming_started", "active" -> STREAMING
                "stopping" -> STOPPING
                "stopped", "not_streaming", "disconnected", "timeout" -> STOPPED
                "reconnecting" -> RECONNECTING
                "reconnected" -> RECONNECTED
                "reconnect_failed" -> RECONNECT_FAILED
                "error", "error_not_streaming" -> ERROR
                else -> null
            }
    }
}

enum class MentraStreamStatusKind(val value: String) {
    LIFECYCLE("lifecycle"),
    RECONNECT("reconnect"),
    ERROR("error"),
    SNAPSHOT("snapshot"),
}

sealed interface MentraStreamStatus {
    val kind: MentraStreamStatusKind
    val state: MentraStreamState
    val streamId: String?
    val timestamp: Long?

    fun toMap(): Map<String, Any> {
        val values = mutableMapOf<String, Any>(
            "kind" to kind.value,
            "status" to state.value,
        )
        streamId?.takeIf { it.isNotBlank() }?.let { values["streamId"] = it }
        timestamp?.let { values["timestamp"] = it }

        when (this) {
            is Lifecycle -> Unit
            is Reconnecting -> {
                values["attempt"] = attempt
                values["maxAttempts"] = maxAttempts
                values["reason"] = reason
            }
            is Reconnected -> values["attempt"] = attempt
            is ReconnectFailed -> values["maxAttempts"] = maxAttempts
            is Error -> values["errorDetails"] = errorDetails
            is Snapshot -> {
                values["streaming"] = streaming
                values["reconnecting"] = reconnecting
                attempt?.let { values["attempt"] = it }
            }
        }

        return values
    }

    fun toEventMap(): Map<String, Any> = toMap() + mapOf("type" to "stream_status")

    data class Lifecycle(
        override val state: MentraStreamState,
        override val streamId: String?,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.LIFECYCLE
    }

    data class Reconnecting(
        override val streamId: String?,
        val attempt: Int,
        val maxAttempts: Int,
        val reason: String,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.RECONNECT
        override val state: MentraStreamState = MentraStreamState.RECONNECTING
    }

    data class Reconnected(
        override val streamId: String?,
        val attempt: Int,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.RECONNECT
        override val state: MentraStreamState = MentraStreamState.RECONNECTED
    }

    data class ReconnectFailed(
        override val streamId: String?,
        val maxAttempts: Int,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.RECONNECT
        override val state: MentraStreamState = MentraStreamState.RECONNECT_FAILED
    }

    data class Error(
        override val streamId: String?,
        val errorDetails: String,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.ERROR
        override val state: MentraStreamState = MentraStreamState.ERROR
    }

    data class Snapshot(
        override val state: MentraStreamState,
        val streaming: Boolean,
        val reconnecting: Boolean,
        override val streamId: String?,
        val attempt: Int?,
        override val timestamp: Long?,
    ) : MentraStreamStatus {
        override val kind: MentraStreamStatusKind = MentraStreamStatusKind.SNAPSHOT
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): MentraStreamStatus {
            val rawState = stringValue(values, "status")
            val streaming = boolValue(values, "streaming")
            val reconnecting = boolValue(values, "reconnecting") ?: false
            val streamId = stringValue(values, "streamId", "stream_id")
            val timestamp = longValue(values, "timestamp")
            val attempt = numberValue(values, "attempt")
            val maxAttempts = numberValue(values, "maxAttempts", "max_attempts") ?: 0

            if (streaming != null || hasAnyKey(values, "reconnecting")) {
                return Snapshot(
                    state = when {
                        reconnecting -> MentraStreamState.RECONNECTING
                        streaming == true -> MentraStreamState.STREAMING
                        else -> MentraStreamState.STOPPED
                    },
                    streaming = streaming == true,
                    reconnecting = reconnecting,
                    streamId = streamId,
                    attempt = attempt,
                    timestamp = timestamp,
                )
            }

            val state = MentraStreamState.fromValue(rawState)
                ?: return Error(
                    streamId = streamId,
                    errorDetails = rawState?.let { "Unknown stream status: $it" } ?: "Missing stream status",
                    timestamp = timestamp,
                )

            return when (state) {
                MentraStreamState.RECONNECTING -> Reconnecting(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    maxAttempts = maxAttempts,
                    reason = stringValue(values, "reason") ?: "",
                    timestamp = timestamp,
                )
                MentraStreamState.RECONNECTED -> Reconnected(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    timestamp = timestamp,
                )
                MentraStreamState.RECONNECT_FAILED -> ReconnectFailed(
                    streamId = streamId,
                    maxAttempts = maxAttempts,
                    timestamp = timestamp,
                )
                MentraStreamState.ERROR -> Error(
                    streamId = streamId,
                    errorDetails = stringValue(values, "errorDetails", "error_details", "details", "error", "errorMessage")
                        ?: if (rawState == "error_not_streaming") "not_streaming" else "Unknown stream error",
                    timestamp = timestamp,
                )
                else -> Lifecycle(
                    state = state,
                    streamId = streamId,
                    timestamp = timestamp,
                )
            }
        }
    }
}

data class MentraStreamStatusEvent(
    val status: MentraStreamStatus,
) {
    constructor(values: Map<String, Any>) : this(MentraStreamStatus.fromMap(values))

    val state: MentraStreamState get() = status.state
    val streamId: String? get() = status.streamId
    val values: Map<String, Any> get() = status.toEventMap()
}

data class MentraKeepAliveAckEvent(
    val streamId: String,
    val ackId: String,
    val timestamp: Long?,
) {
    constructor(values: Map<String, Any>) : this(
        streamId = stringValue(values, "streamId", "stream_id").orEmpty(),
        ackId = stringValue(values, "ackId", "ack_id").orEmpty(),
        timestamp = longValue(values, "timestamp"),
    )

    val values: Map<String, Any>
        get() = buildMap {
            put("type", "keep_alive_ack")
            put("streamId", streamId)
            put("ackId", ackId)
            timestamp?.let { put("timestamp", it) }
        }
}

data class MentraLocalTranscriptionEvent(
    val text: String,
    val isFinal: Boolean,
    val values: Map<String, Any>,
)

data class MentraGlassesMediaVolumeGetResult(
    val volume: Int?,
    val statusCode: Int?,
    val values: Map<String, Any>,
) {
    companion object {
        fun fromMap(values: Map<String, Any>): MentraGlassesMediaVolumeGetResult =
            MentraGlassesMediaVolumeGetResult(
                volume = numberValue(values, "vol", "volume"),
                statusCode = (values["statusCode"] as? Number)?.toInt(),
                values = values,
            )
    }
}

data class MentraGlassesMediaVolumeSetResult(
    val statusCode: Int?,
    val values: Map<String, Any>,
) {
    companion object {
        fun fromMap(values: Map<String, Any>): MentraGlassesMediaVolumeSetResult =
            MentraGlassesMediaVolumeSetResult(
                statusCode = (values["statusCode"] as? Number)?.toInt(),
                values = values,
            )
    }
}

data class MentraBluetoothError(
    val code: String,
    val message: String,
    val cause: Throwable? = null,
)

enum class MentraScanStopReason {
    COMPLETED,
    CANCELLED,
    ERROR,
}

interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDevice) {}
    fun onScanStopped(reason: MentraScanStopReason) {}
    fun onButtonPress(event: MentraButtonPressEvent) {}
    fun onTouch(event: MentraTouchEvent) {}
    fun onSwipe(event: MentraSwipeEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: MentraBatteryStatusEvent) {}
    fun onWifiStatusChanged(event: MentraWifiStatusEvent) {}
    fun onHotspotStatusChanged(event: MentraHotspotStatusEvent) {}
    fun onHotspotError(event: MentraHotspotErrorEvent) {}
    fun onGalleryStatus(event: MentraGalleryStatusEvent) {}
    fun onPhotoResponse(event: MentraPhotoResponseEvent) {}
    fun onStreamStatus(event: MentraStreamStatusEvent) {}
    fun onKeepAliveAck(event: MentraKeepAliveAckEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: MentraDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: MentraBluetoothError) {}
    fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}

abstract class MentraBluetoothSdkCallback : MentraBluetoothSdkListener

private fun numberValue(
    values: Map<*, *>,
    fullKey: String,
    compactKey: String,
): Int? = ((values[fullKey] ?: values[compactKey]) as? Number)?.toInt()

private fun numberValue(
    values: Map<String, Any>,
    vararg keys: String,
): Int? =
    keys.firstNotNullOfOrNull { key ->
        (values[key] as? Number)?.toInt()
    }

private fun stringValue(
    values: Map<String, Any>,
    vararg keys: String,
): String? =
    keys.firstNotNullOfOrNull { key ->
        values[key]?.let { it as? String }
    }

private fun boolValue(
    values: Map<String, Any>,
    vararg keys: String,
): Boolean? =
    keys.firstNotNullOfOrNull { key ->
        values[key] as? Boolean
    }

private fun longValue(
    values: Map<String, Any>,
    vararg keys: String,
): Long? =
    keys.firstNotNullOfOrNull { key ->
        (values[key] as? Number)?.toLong()
    }

private fun hasAnyKey(
    values: Map<String, Any>,
    vararg keys: String,
): Boolean = keys.any(values::containsKey)

private fun Map<*, *>.stringKeyedMap(): Map<String, Any> =
    entries.mapNotNull { (key, value) ->
        val stringKey = key as? String ?: return@mapNotNull null
        val anyValue = value ?: return@mapNotNull null
        stringKey to anyValue
    }.toMap()

private fun optionalNumberValue(
    values: Map<String, Any>,
    vararg keys: String,
): Int? =
    if (hasAnyKey(values, *keys)) {
        numberValue(values, *keys)
    } else {
        null
    }

private fun optionalLongValue(
    values: Map<String, Any>,
    vararg keys: String,
): Long? =
    if (hasAnyKey(values, *keys)) {
        longValue(values, *keys)
    } else {
        null
    }

private fun optionalStringValue(
    values: Map<String, Any>,
    vararg keys: String,
): String? =
    if (hasAnyKey(values, *keys)) {
        stringValue(values, *keys) ?: ""
    } else {
        null
    }

private fun optionalBoolValue(
    values: Map<String, Any>,
    vararg keys: String,
): Boolean? =
    if (hasAnyKey(values, *keys)) {
        boolValue(values, *keys) ?: false
    } else {
        null
    }

private fun stringListValue(
    values: Map<String, Any>,
    key: String,
): List<String> = (values[key] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

private fun optionalStringListValue(
    values: Map<String, Any>,
    key: String,
): List<String>? =
    if (values.containsKey(key)) {
        stringListValue(values, key)
    } else {
        null
    }

private fun mapListValue(
    values: Map<String, Any>,
    key: String,
): List<Map<String, Any>> =
    (values[key] as? List<*>)?.mapNotNull(::stringMapValue) ?: emptyList()

private fun optionalMapListValue(
    values: Map<String, Any>,
    key: String,
): List<Map<String, Any>>? =
    if (values.containsKey(key)) {
        mapListValue(values, key)
    } else {
        null
    }

private fun stringMapValue(value: Any?): Map<String, Any>? =
    (value as? Map<*, *>)?.entries?.mapNotNull { (key, mapValue) ->
        val stringKey = key as? String ?: return@mapNotNull null
        val nonNullValue = mapValue ?: return@mapNotNull null
        stringKey to nonNullValue
    }?.toMap()

private fun MutableMap<String, Any>.putIfNotNull(
    key: String,
    value: Any?,
) {
    if (value != null) {
        put(key, value)
    }
}
