package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ScanCompletionTest {
    private val hint = ScanDiagnostic("device_connected_on_phone", "A matching device is connected to this phone.")

    @Test
    fun `empty completed scan delivers diagnostic then completion without error`() {
        val events = mutableListOf<String>()
        val callback = object : MentraBluetoothScanCallback() {
            override fun onDiagnostic(diagnostic: ScanDiagnostic) {
                assertThat(diagnostic).isEqualTo(hint)
                events.add("diagnostic")
            }
            override fun onComplete(devices: List<Device>) {
                assertThat(devices).isEmpty()
                events.add("complete")
            }
            override fun onError(error: BluetoothError) {
                events.add("error")
            }
        }
        callback.completeScan(ScanStopReason.COMPLETED, emptyList()) { hint }
        assertThat(events).containsExactly("diagnostic", "complete")
    }

    @Test
    fun `legacy callbacks complete without querying diagnostics`() {
        var completed = false
        // Implement only the pre-existing interface; it gains no abstract method.
        val callback = object : ScanCallback {
            override fun onComplete(devices: List<Device>) { completed = true }
        }
        callback.completeScan(ScanStopReason.COMPLETED, emptyList()) {
            error("Legacy callbacks must not query diagnostics")
        }
        assertThat(completed).isTrue()
        assertThat(ScanCallback::class.java.declaredMethods.map { it.name })
            .containsExactlyInAnyOrder("onResults", "onComplete", "onError")
    }

    @Test
    fun `cancelled scans and nonempty scans never query diagnostics`() {
        val device = Device(DeviceModel.MENTRA_LIVE, "XyBLE_1234")
        val completed = mutableListOf<List<Device>>()
        val callback = object : MentraBluetoothScanCallback() {
            override fun onComplete(devices: List<Device>) { completed.add(devices) }
            override fun onDiagnostic(diagnostic: ScanDiagnostic) { error("Unexpected diagnostic") }
        }
        for ((reason, devices) in listOf(
            ScanStopReason.CANCELLED to emptyList(),
            ScanStopReason.COMPLETED to listOf(device),
        )) {
            callback.completeScan(reason, devices) { error("Unexpected diagnostic query") }
        }
        assertThat(completed).containsExactly(emptyList(), listOf(device))
    }

    @Test
    fun `missing diagnostic leaves an ordinary empty completion`() {
        val events = mutableListOf<String>()
        val callback = object : MentraBluetoothScanCallback() {
            override fun onComplete(devices: List<Device>) { events.add("complete") }
            override fun onDiagnostic(diagnostic: ScanDiagnostic) { events.add("diagnostic") }
            override fun onError(error: BluetoothError) { events.add("error") }
        }
        callback.completeScan(ScanStopReason.COMPLETED, emptyList()) { null }
        assertThat(events).containsExactly("complete")
    }

    @Test
    fun `completion still runs if the diagnostic handler throws`() {
        var completed = false
        val failure = IllegalStateException("consumer diagnostic handler failed")
        val callback = object : MentraBluetoothScanCallback() {
            override fun onComplete(devices: List<Device>) { completed = true }
            override fun onDiagnostic(diagnostic: ScanDiagnostic) { throw failure }
        }
        val thrown = runCatching {
            callback.completeScan(ScanStopReason.COMPLETED, emptyList()) { hint }
        }.exceptionOrNull()
        assertThat(thrown).isSameAs(failure)
        assertThat(completed).isTrue()
    }
}
