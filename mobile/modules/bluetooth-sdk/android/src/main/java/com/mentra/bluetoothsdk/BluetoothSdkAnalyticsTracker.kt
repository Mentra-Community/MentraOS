package com.mentra.bluetoothsdk

/** The subset of glasses status the analytics decision logic needs. */
internal data class AnalyticsGlassesSnapshot(
    val connected: Boolean,
    val fullyBooted: Boolean,
    val model: String,
    val serialNumber: String,
    val firmwareVersion: String = "",
    val besFirmwareVersion: String = "",
    val mtkFirmwareVersion: String = "",
    val androidVersion: String = "",
    val appVersion: String = "",
    val buildNumber: String = "",
)

internal data class AnalyticsEvent(
    val name: String,
    val properties: Map<String, Any>,
)

/**
 * Pure decision logic for the SDK usage events. It owns no threads and no I/O so
 * the connection/identification/heartbeat rules can be unit-tested directly.
 *
 * Rules:
 * - `bluetooth_sdk_glasses_connected` once per connection. If the model is not
 *   known yet at connect time the event waits for it (Mentra Live and some Android
 *   paths set the model after the connected flag), and is emitted without a model
 *   only if the connection ends first.
 * - `bluetooth_sdk_glasses_identified` once per connection per serial, plus a
 *   `glasses_heartbeat` re-emission on the first status update of each new UTC day
 *   while still connected, so a connection spanning a week boundary is visible in
 *   both weeks.
 */
internal class BluetoothSdkAnalyticsTracker(private val simulatedModel: String) {
    private var lastConnected = false
    private var connectedPendingModel = false
    private var identifiedSerial: String? = null
    private var identifiedUtcDay: Long? = null

    fun initialize(snapshot: AnalyticsGlassesSnapshot, utcDay: Long) {
        lastConnected = snapshot.connected
        connectedPendingModel = false
        // Only treat identification as already captured when a valid serial is present
        // at init. If the glasses are connected but the serial has not arrived yet
        // (Mentra Live fills it via version_info after connect), leave this null so the
        // identify event still fires once the serial arrives.
        identifiedSerial = if (snapshot.connected) snapshot.serialNumber.validManufacturingSerial() else null
        identifiedUtcDay = identifiedSerial?.let { utcDay }
    }

    fun observe(snapshot: AnalyticsGlassesSnapshot, utcDay: Long): List<AnalyticsEvent> {
        val events = mutableListOf<AnalyticsEvent>()
        val wasConnected = lastConnected
        lastConnected = snapshot.connected

        if (!snapshot.connected) {
            if (connectedPendingModel) {
                connectedPendingModel = false
                events += connectedEvent(snapshot, modelUnresolved = true)
            }
            identifiedSerial = null
            identifiedUtcDay = null
            return events
        }

        if (!wasConnected) {
            identifiedSerial = null
            identifiedUtcDay = null
            if (snapshot.model.isBlank()) {
                connectedPendingModel = true
            } else {
                events += connectedEvent(snapshot, modelUnresolved = false)
            }
        } else if (connectedPendingModel && snapshot.model.isNotBlank()) {
            connectedPendingModel = false
            events += connectedEvent(snapshot, modelUnresolved = false)
        }

        val serial = snapshot.serialNumber.validManufacturingSerial() ?: return events
        if (identifiedSerial != serial) {
            identifiedSerial = serial
            identifiedUtcDay = utcDay
            events += identifiedEvent(snapshot, serial, kind = "glasses_identified")
        } else if (identifiedUtcDay != utcDay) {
            identifiedUtcDay = utcDay
            events += identifiedEvent(snapshot, serial, kind = "glasses_heartbeat")
        }
        return events
    }

    private fun connectedEvent(snapshot: AnalyticsGlassesSnapshot, modelUnresolved: Boolean) =
        AnalyticsEvent(
            "bluetooth_sdk_glasses_connected",
            buildMap {
                put("event_kind", "glasses_connected")
                put("fully_booted", snapshot.fullyBooted)
                snapshot.model.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                if (modelUnresolved) put("glasses_model_unresolved", true)
                put("glasses_is_simulated", snapshot.model == simulatedModel)
            },
        )

    private fun identifiedEvent(snapshot: AnalyticsGlassesSnapshot, serial: String, kind: String) =
        AnalyticsEvent(
            "bluetooth_sdk_glasses_identified",
            buildMap {
                put("event_kind", kind)
                put("fully_booted", snapshot.fullyBooted)
                put("glasses_device_id", serial)
                put("glasses_device_id_type", "manufacturing_serial")
                snapshot.model.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                put("glasses_is_simulated", snapshot.model == simulatedModel)
                snapshot.firmwareVersion.takeIf { it.isNotBlank() }?.let { put("glasses_firmware_version", it) }
                snapshot.besFirmwareVersion.takeIf { it.isNotBlank() }?.let { put("glasses_bes_firmware_version", it) }
                snapshot.mtkFirmwareVersion.takeIf { it.isNotBlank() }?.let { put("glasses_mtk_firmware_version", it) }
                snapshot.androidVersion.takeIf { it.isNotBlank() }?.let { put("glasses_android_version", it) }
                snapshot.appVersion.takeIf { it.isNotBlank() }?.let { put("glasses_app_version", it) }
                snapshot.buildNumber.takeIf { it.isNotBlank() }?.let { put("glasses_build_number", it) }
            },
        )

    companion object {
        const val MILLIS_PER_UTC_DAY = 86_400_000L

        fun utcDay(epochMillis: Long): Long = Math.floorDiv(epochMillis, MILLIS_PER_UTC_DAY)
    }
}

internal fun String.validManufacturingSerial(): String? =
    trim().takeIf { it.isNotEmpty() && !it.matches(Regex("0+")) }
