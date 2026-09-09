package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

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
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        val first = tracker.observe(snapshot(connected = true), utcDay = 100)
        assertThat(first.map { it.name }).containsExactly("bluetooth_sdk_glasses_connected")

        val identified = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        assertThat(identified.map { it.name }).containsExactly("bluetooth_sdk_glasses_identified")
        assertThat(identified.single().properties)
            .containsEntry("event_kind", "glasses_identified")
            .containsEntry("glasses_device_id", "MLAB0001")
            .containsEntry("glasses_is_simulated", false)

        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)).isEmpty()
    }

    @Test
    fun `a new connection identifies the same serial again`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        tracker.observe(snapshot(connected = false), utcDay = 100)
        val again = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        assertThat(again.map { it.name })
            .containsExactly("bluetooth_sdk_glasses_connected", "bluetooth_sdk_glasses_identified")
    }

    @Test
    fun `connected waits for the model and is emitted once the model arrives`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, model = ""), utcDay = 100)).isEmpty()
        val withModel = tracker.observe(snapshot(connected = true, model = "Even Realities G2"), utcDay = 100)
        assertThat(withModel.single().name).isEqualTo("bluetooth_sdk_glasses_connected")
        assertThat(withModel.single().properties).containsEntry("glasses_model", "Even Realities G2")
        assertThat(withModel.single().properties).doesNotContainKey("glasses_model_unresolved")
    }

    @Test
    fun `connected without a model is still counted when the connection ends first`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        tracker.observe(snapshot(connected = true, model = ""), utcDay = 100)
        val ended = tracker.observe(snapshot(connected = false, model = ""), utcDay = 100)
        assertThat(ended.single().name).isEqualTo("bluetooth_sdk_glasses_connected")
        assertThat(ended.single().properties).containsEntry("glasses_model_unresolved", true).doesNotContainKey("glasses_model")
    }

    @Test
    fun `a connection that crosses a UTC day boundary heartbeats once per day`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)).isEmpty()

        val nextDay = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 101)
        assertThat(nextDay.single().name).isEqualTo("bluetooth_sdk_glasses_identified")
        assertThat(nextDay.single().properties).containsEntry("event_kind", "glasses_heartbeat")
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 101)).isEmpty()
    }

    @Test
    fun `initializing while already connected and identified suppresses a duplicate identification but not later heartbeats`() {
        tracker.initialize(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        assertThat(tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)).isEmpty()
        val nextDay = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 101)
        assertThat(nextDay.single().properties).containsEntry("event_kind", "glasses_heartbeat")
    }

    @Test
    fun `initializing while connected but before the serial arrives still identifies later`() {
        tracker.initialize(snapshot(connected = true, serial = ""), utcDay = 100)
        val identified = tracker.observe(snapshot(connected = true, serial = "MLAB0001"), utcDay = 100)
        assertThat(identified.single().properties).containsEntry("event_kind", "glasses_identified")
    }

    @Test
    fun `placeholder serials are ignored and simulated glasses are flagged`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
        val events = tracker.observe(snapshot(connected = true, model = "Simulated Glasses", serial = "0000"), utcDay = 100)
        assertThat(events.map { it.name }).containsExactly("bluetooth_sdk_glasses_connected")
        assertThat(events.single().properties).containsEntry("glasses_is_simulated", true)
    }

    @Test
    fun `identification carries the glasses software versions that are known`() {
        tracker.initialize(snapshot(connected = false), utcDay = 100)
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
                utcDay = 100,
            )
        val identified = events.single { it.name == "bluetooth_sdk_glasses_identified" }
        assertThat(identified.properties)
            .containsEntry("glasses_firmware_version", "26.9.3.0")
            .containsEntry("glasses_mtk_firmware_version", "20260709")
            .containsEntry("glasses_app_version", "5.2.1")
            .doesNotContainKeys("glasses_bes_firmware_version", "glasses_android_version", "glasses_build_number")
    }

    @Test
    fun `utc day flooring is stable across the epoch`() {
        assertThat(BluetoothSdkAnalyticsTracker.utcDay(0)).isEqualTo(0)
        assertThat(BluetoothSdkAnalyticsTracker.utcDay(86_399_999)).isEqualTo(0)
        assertThat(BluetoothSdkAnalyticsTracker.utcDay(86_400_000)).isEqualTo(1)
    }
}
