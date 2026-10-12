package com.mentra.bluetoothsdk

import java.util.TimeZone

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
    /** -1 while the glasses have not reported a level. */
    val batteryLevel: Int = -1,
    val charging: Boolean = false,
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
 *   `glasses_heartbeat` re-emission on the first status update of each new
 *   reporting day while still connected, so a connection spanning a week boundary
 *   is visible in both weeks. Reporting days follow `America/Los_Angeles`, the
 *   calendar the WAU weeks are cut on; a UTC day would miss the Sunday-evening to
 *   Monday-morning Pacific boundary, which is one UTC day.
 * - `bluetooth_sdk_glasses_disconnected` when a counted connection ends, with its
 *   length, why it ended, and the battery levels seen during it. The reason is
 *   supplied by the caller: an SDK disconnect/forget/cancel call, the phone's
 *   Bluetooth turning off, or otherwise a lost link.
 */
internal class BluetoothSdkAnalyticsTracker(private val simulatedModel: String) {
    private var lastConnected = false
    private var connectedPendingModel = false
    private var identifiedSerial: String? = null
    private var identifiedReportingDay: Long? = null
    private var connectedAtMs: Long? = null
    private var batteryAtConnect = -1
    private var lastBattery = -1
    private var lastCharging: Boolean? = null
    private var lastModel = ""

    fun initialize(snapshot: AnalyticsGlassesSnapshot, reportingDay: Long) {
        lastConnected = snapshot.connected
        connectedPendingModel = false
        // Only treat identification as already captured when a valid serial is present
        // at init. If the glasses are connected but the serial has not arrived yet
        // (Mentra Live fills it via version_info after connect), leave this null so the
        // identify event still fires once the serial arrives.
        identifiedSerial = if (snapshot.connected) snapshot.serialNumber.validManufacturingSerial() else null
        identifiedReportingDay = identifiedSerial?.let { reportingDay }
    }

    fun observe(
        snapshot: AnalyticsGlassesSnapshot,
        reportingDay: Long,
        nowMs: Long = 0L,
        disconnectReason: () -> String = { DISCONNECT_UNKNOWN },
    ): List<AnalyticsEvent> {
        val events = mutableListOf<AnalyticsEvent>()
        val wasConnected = lastConnected
        lastConnected = snapshot.connected

        if (!snapshot.connected) {
            if (connectedPendingModel) {
                connectedPendingModel = false
                events += connectedEvent(snapshot, modelUnresolved = true)
            }
            connectedAtMs?.let { startedAt ->
                events += disconnectedEvent(nowMs - startedAt, disconnectReason())
            }
            connectedAtMs = null
            identifiedSerial = null
            identifiedReportingDay = null
            return events
        }

        if (snapshot.model.isNotBlank()) lastModel = snapshot.model
        if (snapshot.batteryLevel >= 0) {
            if (batteryAtConnect < 0) batteryAtConnect = snapshot.batteryLevel
            lastBattery = snapshot.batteryLevel
            lastCharging = snapshot.charging
        }

        if (!wasConnected) {
            identifiedSerial = null
            identifiedReportingDay = null
            connectedAtMs = nowMs
            lastModel = snapshot.model
            batteryAtConnect = snapshot.batteryLevel
            lastBattery = snapshot.batteryLevel
            lastCharging = snapshot.charging.takeIf { snapshot.batteryLevel >= 0 }
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
            identifiedReportingDay = reportingDay
            events += identifiedEvent(snapshot, serial, kind = "glasses_identified")
        } else if (identifiedReportingDay != reportingDay) {
            identifiedReportingDay = reportingDay
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

    private fun disconnectedEvent(durationMs: Long, reason: String) =
        AnalyticsEvent(
            "bluetooth_sdk_glasses_disconnected",
            buildMap {
                put("event_kind", "glasses_disconnected")
                put("session_duration_ms", durationMs.coerceAtLeast(0))
                put("disconnect_reason", reason)
                lastModel.takeIf { it.isNotBlank() }?.let { put("glasses_model", it) }
                put("glasses_is_simulated", lastModel == simulatedModel)
                batteryAtConnect.takeIf { it >= 0 }?.let { put("battery_level_at_connect", it) }
                lastBattery.takeIf { it >= 0 }?.let { put("battery_level_at_disconnect", it) }
                lastCharging?.let { put("charging", it) }
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
        const val DISCONNECT_USER = "user_disconnect"
        const val DISCONNECT_FORGET = "forget"
        const val DISCONNECT_CANCEL = "cancel"
        const val DISCONNECT_BLUETOOTH_OFF = "bluetooth_off"
        const val DISCONNECT_LINK_LOST = "link_lost"
        const val DISCONNECT_UNKNOWN = "unknown"
        const val MILLIS_PER_DAY = 86_400_000L
        val REPORTING_ZONE: TimeZone = TimeZone.getTimeZone("America/Los_Angeles")

        /** Calendar day in the reporting zone, as days since the epoch of that zone's midnight. */
        fun reportingDay(epochMillis: Long): Long =
            Math.floorDiv(epochMillis + REPORTING_ZONE.getOffset(epochMillis), MILLIS_PER_DAY)
    }
}

internal fun String.validManufacturingSerial(): String? =
    trim().takeIf { it.isNotEmpty() && !it.matches(Regex("0+")) }
