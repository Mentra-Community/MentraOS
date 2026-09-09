package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.time.Instant

class BluetoothSdkAnalyticsTrackerTest {
    private val tracker = BluetoothSdkAnalyticsTracker(simulatedModel = "Simulated Glasses")

    private fun snapshot(
        connected: Boolean,
        model: String = "Mentra Live",
        serial: String = "",
        fullyBooted: Boolean = connected,
    ) = AnalyticsGlassesSnapshot(connected = connected, fullyBooted = fullyBooted, model = model, serialNumber = serial)

    @Test
    fun `connect then serial emits connected and identified once, reconnects do not repeat identification within a connection`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        val first = tracker.observe(snapshot(connected = true), reportingDay = 100)
        assertThat(first.map { it.name }).containsExactly("bluetooth_sdk_glasses_connected")

        val identified = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        assertThat(identified.map { it.name }).containsExactly("bluetooth_sdk_glasses_identified")
        assertThat(identified.single().properties)
            .containsEntry("event_kind", "glasses_identified")
            .containsEntry("glasses_device_id", "MLAB0001")
            .containsEntry("glasses_is_simulated", false)

        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)).isEmpty()
    }

    @Test
    fun `a new connection identifies the same serial again`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        tracker.observe(snapshot(connected = false), reportingDay = 100)
        val again = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        assertThat(again.map { it.name })
            .containsExactly("bluetooth_sdk_glasses_connected", "bluetooth_sdk_glasses_identified")
    }

    @Test
    fun `connected waits for the model and is emitted once the model arrives`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, model = ""), reportingDay = 100)).isEmpty()
        val withModel = tracker.observe(snapshot(connected = true, model = "Even Realities G2"), reportingDay = 100)
        assertThat(withModel.single().name).isEqualTo("bluetooth_sdk_glasses_connected")
        assertThat(withModel.single().properties).containsEntry("glasses_model", "Even Realities G2")
        assertThat(withModel.single().properties).doesNotContainKey("glasses_model_unresolved")
    }

    @Test
    fun `connected without a model is still counted when the connection ends first`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        tracker.observe(snapshot(connected = true, model = ""), reportingDay = 100)
        val ended = tracker.observe(snapshot(connected = false, model = ""), reportingDay = 100)
        assertThat(ended.single().name).isEqualTo("bluetooth_sdk_glasses_connected")
        assertThat(ended.single().properties).containsEntry("glasses_model_unresolved", true).doesNotContainKey("glasses_model")
    }

    @Test
    fun `a connection that crosses a UTC day boundary heartbeats once per day`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)).isEmpty()

        val nextDay = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 101)
        assertThat(nextDay.single().name).isEqualTo("bluetooth_sdk_glasses_identified")
        assertThat(nextDay.single().properties).containsEntry("event_kind", "glasses_heartbeat")
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 101)).isEmpty()
    }

    @Test
    fun `initializing while already connected and identified suppresses a duplicate identification but not later heartbeats`() {
        tracker.initialize(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)).isEmpty()
        val nextDay = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 101)
        assertThat(nextDay.single().properties).containsEntry("event_kind", "glasses_heartbeat")
    }

    @Test
    fun `initializing while connected but before the serial arrives still identifies later`() {
        tracker.initialize(snapshot(connected = true, serial = ""), reportingDay = 100)
        val identified = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = 100)
        assertThat(identified.single().properties).containsEntry("event_kind", "glasses_identified")
    }

    @Test
    fun `placeholder serials are ignored and simulated glasses are flagged`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        val events = tracker.observe(snapshot(connected = true, model = "Simulated Glasses", serial = "0000"), reportingDay = 100)
        assertThat(events.map { it.name }).containsExactly("bluetooth_sdk_glasses_connected")
        assertThat(events.single().properties).containsEntry("glasses_is_simulated", true)
    }

    @Test
    fun `identification carries the glasses software versions that are known`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 100)
        val events =
            tracker.observe(
                AnalyticsGlassesSnapshot(
                    connected = true,
                    fullyBooted = true,
                    model = "Mentra Live",
                    serialNumber = "MLAB0001",
                    firmwareVersion = "26.9.3.0",
                    mtkFirmwareVersion = "20260709",
                    appVersion = "5.2.1",
                ),
                reportingDay = 100,
            )
        val identified = events.single { it.name == "bluetooth_sdk_glasses_identified" }
        assertThat(identified.properties)
            .containsEntry("glasses_firmware_version", "26.9.3.0")
            .containsEntry("glasses_mtk_firmware_version", "20260709")
            .containsEntry("glasses_app_version", "5.2.1")
            .doesNotContainKeys("glasses_bes_firmware_version", "glasses_android_version", "glasses_build_number")
    }

    @Test
    fun `reporting day follows the Los Angeles calendar, not UTC`() {
        val sundayEveningPacific = Instant.parse("2026-09-14T00:30:00Z").toEpochMilli() // Sun 2026-09-13 17:30 PDT
        val mondayEarlyPacific = Instant.parse("2026-09-14T08:00:00Z").toEpochMilli() // Mon 2026-09-14 01:00 PDT
        assertThat(Math.floorDiv(sundayEveningPacific, 86_400_000L)).isEqualTo(Math.floorDiv(mondayEarlyPacific, 86_400_000L))
        assertThat(BluetoothSdkAnalyticsTracker.reportingDay(sundayEveningPacific))
            .isEqualTo(BluetoothSdkAnalyticsTracker.reportingDay(mondayEarlyPacific) - 1)

        // Spring-forward day: 01:30 PST and 03:30 PDT are the same Pacific day.
        val beforeDst = Instant.parse("2026-03-08T09:30:00Z").toEpochMilli()
        val afterDst = Instant.parse("2026-03-08T10:30:00Z").toEpochMilli()
        assertThat(BluetoothSdkAnalyticsTracker.reportingDay(beforeDst)).isEqualTo(BluetoothSdkAnalyticsTracker.reportingDay(afterDst))
        // Pacific midnight is the boundary.
        val justBeforeMidnight = Instant.parse("2026-09-14T06:59:59Z").toEpochMilli()
        val midnight = Instant.parse("2026-09-14T07:00:00Z").toEpochMilli()
        assertThat(BluetoothSdkAnalyticsTracker.reportingDay(justBeforeMidnight) + 1).isEqualTo(BluetoothSdkAnalyticsTracker.reportingDay(midnight))
    }

    @Test
    fun `a connection across the Pacific Sunday to Monday boundary heartbeats on Monday`() {
        tracker.initialize(snapshot(connected = false), reportingDay = 0)
        val sunday = BluetoothSdkAnalyticsTracker.reportingDay(Instant.parse("2026-09-14T00:30:00Z").toEpochMilli())
        val monday = BluetoothSdkAnalyticsTracker.reportingDay(Instant.parse("2026-09-14T08:00:00Z").toEpochMilli())
        tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = sunday)
        val onMonday = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), reportingDay = monday)
        assertThat(onMonday.single().properties).containsEntry("event_kind", "glasses_heartbeat")
    }
}
