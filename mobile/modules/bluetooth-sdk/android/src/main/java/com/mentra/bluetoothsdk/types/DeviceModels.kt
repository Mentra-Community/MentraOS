package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.ControllerTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes

data class MentraBluetoothSdkConfig @JvmOverloads constructor(
    val deliverCallbacksOnMainThread: Boolean = true,
    val analytics: BluetoothSdkAnalyticsConfig = BluetoothSdkAnalyticsConfig(),
)

class BluetoothSdkException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

enum class DeviceModel(val deviceType: String) {
    G1(DeviceTypes.G1),
    G2(DeviceTypes.G2),
    MENTRA_LIVE(DeviceTypes.LIVE),
    MENTRA_NEX(DeviceTypes.NEX),
    MACH1(DeviceTypes.MACH1),
    Z100(DeviceTypes.Z100),
    FRAME(DeviceTypes.FRAME),
    NIMO(DeviceTypes.NIMO),
    AR99(DeviceTypes.AR99),
    SIMULATED(DeviceTypes.SIMULATED),
    R1(ControllerTypes.R1);

    companion object {
        @JvmStatic
        fun fromDeviceType(deviceType: String?): DeviceModel =
            values().firstOrNull { it.deviceType == deviceType } ?: MENTRA_LIVE
    }
}

data class Device(
    val model: DeviceModel,
    val name: String,
    /** Android Bluetooth address when available. */
    val address: String? = null,
    val projectName: String? = null,
    val rssi: Int? = null,
    /** Stable app-facing scan-result key. Do not parse; use typed fields instead. */
    val id: String = address?.takeIf { it.isNotBlank() } ?: "${model.deviceType}:$name",
    val pairingMode: Boolean? = null,
    val pairingCode: String? = null,
    val securePairingCapable: Boolean? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            put("id", id)
            put("model", model.deviceType)
            put("name", name)
            address?.takeIf { it.isNotBlank() }?.let {
                put("address", it)
            }
            projectName?.takeIf { it.isNotBlank() }?.let {
                put("projectName", it)
            }
            rssi?.let { put("rssi", it) }
            pairingMode?.let { put("pairingMode", it) }
            pairingCode?.takeIf { it.isNotBlank() }?.let { put("pairingCode", it) }
            securePairingCapable?.let { put("securePairingCapable", it) }
        }

    companion object {
        internal fun fromMap(values: Map<String, Any>): Device? {
            val model = stringValue(values, "model") ?: return null
            val name = stringValue(values, "name") ?: return null
            val address = stringValue(values, "address")?.takeIf { it.isNotBlank() }
            val projectName = stringValue(values, "projectName")?.takeIf { it.isNotBlank() }
            val rssi = numberValue(values, "rssi")
            val id = stringValue(values, "id")?.takeIf { it.isNotBlank() } ?: address ?: "${model}:$name"
            return Device(
                model = DeviceModel.fromDeviceType(model),
                name = name,
                address = address,
                projectName = projectName,
                rssi = rssi,
                id = id,
            )
        }
    }
}

data class ConnectOptions(
    val saveAsDefault: Boolean = true,
    val cancelExistingConnectionAttempt: Boolean = true,
)
