package com.mentra.bluetoothsdk

data class MentraBluetoothState(
    val glasses: GlassesRuntimeState,
    val sdk: PhoneSdkRuntimeState,
    val scan: BluetoothScanState,
) {
    internal companion object {
        fun from(
            glassesStatus: GlassesStatus,
            bluetoothStatus: BluetoothStatus,
        ): MentraBluetoothState =
            MentraBluetoothState(
                glasses = GlassesRuntimeState.from(glassesStatus),
                sdk = PhoneSdkRuntimeState.from(bluetoothStatus),
                scan = BluetoothScanState.from(bluetoothStatus),
            )
    }
}

data class GlassesBatteryState(
    val charging: Boolean,
    val level: Int?,
)

data class ConnectedGlassesInfo(
    val appVersion: String?,
    val bluetoothName: String?,
    val buildNumber: String?,
    val color: String?,
    val deviceModel: DeviceModel?,
    val firmwareVersion: String?,
    val serialNumber: String?,
    val style: String?,
)

enum class FirmwareSource {
    APP,
    BES,
    FIRMWARE,
    MTK,
    UNKNOWN,
}

data class FirmwareInfo(
    val appVersion: String?,
    val buildNumber: String?,
    val source: FirmwareSource,
    val version: String?,
)

data class SignalState(
    val strengthDbm: Int?,
    val updatedAt: Long?,
)

sealed interface GlassesRuntimeState {
    val connected: Boolean
    val connection: GlassesConnectionState
    val ready: Boolean

    data class Disconnected(
        override val connection: GlassesConnectionState = GlassesConnectionState.DISCONNECTED,
    ) : GlassesRuntimeState {
        override val connected: Boolean = false
        override val ready: Boolean = false
    }

    data class Connected(
        val battery: GlassesBatteryState,
        override val connection: GlassesConnectionState,
        val device: ConnectedGlassesInfo,
        val firmware: FirmwareInfo,
        val hotspot: HotspotStatus,
        override val ready: Boolean,
        val signal: SignalState,
        val voiceActivityDetectionEnabled: Boolean,
        val wifi: WifiStatus,
    ) : GlassesRuntimeState {
        override val connected: Boolean = true
    }

    companion object {
        internal fun from(status: GlassesStatus): GlassesRuntimeState {
            if (!status.connected && status.connectionState != GlassesConnectionState.CONNECTED) {
                return Disconnected(connection = status.connectionState)
            }
            return Connected(
                battery = batteryState(status),
                connection = GlassesConnectionState.CONNECTED,
                device = connectedGlassesInfo(status),
                firmware = firmwareInfo(status),
                hotspot = status.hotspot,
                ready = status.fullyBooted,
                signal = SignalState(
                    strengthDbm = status.signalStrength.takeUnless { it == -1 },
                    updatedAt = status.signalStrengthUpdatedAt.takeUnless { it <= 0L },
                ),
                voiceActivityDetectionEnabled = status.voiceActivityDetectionEnabled,
                wifi = status.wifi,
            )
        }

        private fun batteryState(status: GlassesStatus): GlassesBatteryState =
            GlassesBatteryState(
                charging = status.charging,
                level = status.batteryLevel.takeUnless { it < 0 },
            )

        private fun connectedGlassesInfo(status: GlassesStatus): ConnectedGlassesInfo =
            ConnectedGlassesInfo(
                appVersion = status.appVersion.nonBlank(),
                bluetoothName = status.bluetoothName.nonBlank(),
                buildNumber = status.buildNumber.nonBlank(),
                color = status.color.nonBlank(),
                deviceModel = status.deviceModel.takeIf { it.isNotBlank() }?.let(DeviceModel::fromDeviceType),
                firmwareVersion = status.firmwareVersion.nonBlank(),
                serialNumber = status.serialNumber.nonBlank(),
                style = status.style.nonBlank(),
            )

        private fun firmwareInfo(status: GlassesStatus): FirmwareInfo {
            val sources =
                listOf(
                    status.firmwareVersion to FirmwareSource.FIRMWARE,
                    status.besFirmwareVersion to FirmwareSource.BES,
                    status.mtkFirmwareVersion to FirmwareSource.MTK,
                    status.appVersion to FirmwareSource.APP,
                )
            val match = sources.firstOrNull { (version, _) -> version.isNotBlank() }
            return FirmwareInfo(
                appVersion = status.appVersion.nonBlank(),
                buildNumber = status.buildNumber.nonBlank(),
                source = match?.second ?: FirmwareSource.UNKNOWN,
                version = match?.first?.nonBlank(),
            )
        }
    }
}

enum class MicMode(val value: String) {
    PHONE("phone"),
    GLASSES("glasses"),
    BLUETOOTH_CLASSIC("bluetoothClassic"),
    BLUETOOTH("bluetooth");

    internal companion object {
        fun fromValue(value: String?): MicMode? =
            values().firstOrNull { it.value == value }
    }
}

data class GalleryModeState(
    val enabled: Boolean,
)

data class PhoneSdkRuntimeState(
    val currentMic: MicMode?,
    val defaultDevice: Device?,
    val galleryMode: GalleryModeState,
    val lastLog: List<String>,
    val micRanking: List<MicMode>,
    val otherBluetoothConnected: Boolean,
    val searching: Boolean,
    val searchingController: Boolean,
    val systemMicUnavailable: Boolean,
    val wifiScanResults: List<WifiScanResult>,
) {
    internal companion object {
        fun from(status: BluetoothStatus): PhoneSdkRuntimeState =
            PhoneSdkRuntimeState(
                currentMic = MicMode.fromValue(status.currentMic),
                defaultDevice = status.defaultDevice,
                galleryMode = GalleryModeState(enabled = status.galleryModeEnabled),
                lastLog = status.lastLog,
                micRanking = status.micRanking.mapNotNull { MicMode.fromValue(it) },
                otherBluetoothConnected = status.otherBtConnected,
                searching = status.searching,
                searchingController = status.searchingController,
                systemMicUnavailable = status.systemMicUnavailable,
                wifiScanResults = status.wifiScanResults,
            )
    }
}

data class BluetoothScanState(
    val active: Boolean,
    val devices: List<Device>,
    val searchingController: Boolean,
) {
    internal companion object {
        fun from(status: BluetoothStatus): BluetoothScanState =
            BluetoothScanState(
                active = status.searching,
                devices = status.searchResults,
                searchingController = status.searchingController,
            )
    }
}

private fun String.nonBlank(): String? = takeIf { it.isNotBlank() }
