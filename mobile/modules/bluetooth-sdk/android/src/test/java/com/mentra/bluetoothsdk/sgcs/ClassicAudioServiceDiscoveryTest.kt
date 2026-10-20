package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.time.Duration
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class ClassicAudioServiceDiscoveryTest {
    private val target = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("AA:BB:CC:DD:EE:FF")
    private val sink = ParcelUuid.fromString("0000110b-0000-1000-8000-00805f9b34fb")
    private val zero = ParcelUuid.fromString("00000000-0000-0000-0000-000000000000")
    private val messages = mutableListOf<String>()
    private val discovery = ClassicAudioServiceDiscovery(Handler(Looper.getMainLooper()), 30000, messages::add)
    private var connects = 0

    private fun request(device: BluetoothDevice = target) {
        discovery.connectWhenDiscovered(device) { connects++ }
    }

    @Test fun `bonded Samsung zero UUID inventory waits for real Audio Sink discovery`() {
        shadowOf(target).setBondState(BluetoothDevice.BOND_BONDED)
        shadowOf(target).setUuids(arrayOf(zero))
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        assertThat(connects).isZero()
        assertThat(shadowOf(target).fetchUuidsWithSdpCount).isEqualTo(1)
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        discovery.onUuids(target)
        assertThat(connects).isEqualTo(1)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
        assertThat(messages.none { it.contains("timed out") }).isTrue()
        assertThat(target.bondState).isEqualTo(BluetoothDevice.BOND_BONDED)
    }

    @Test fun `valid cached Audio Sink needs no refresh`() {
        shadowOf(target).setUuids(arrayOf(sink))
        request()
        assertThat(connects).isEqualTo(1)
        assertThat(shadowOf(target).fetchUuidsWithSdpCount).isZero()
    }

    @Test fun `early empty UUID broadcast preserves the wait for the actual SDP result`() {
        shadowOf(target).setUuids(arrayOf(zero))
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        discovery.onUuids(target)
        assertThat(connects).isZero()
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        assertThat(connects).isEqualTo(1)
        assertThat(shadowOf(target).fetchUuidsWithSdpCount).isEqualTo(1)
    }

    @Test fun `unrelated device and duplicate requests cannot complete or multiply discovery`() {
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        request()
        val other = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("11:22:33:44:55:66")
        shadowOf(other).setUuids(arrayOf(sink))
        discovery.onUuids(other)
        assertThat(connects).isZero()
        assertThat(shadowOf(target).fetchUuidsWithSdpCount).isEqualTo(1)
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        assertThat(connects).isEqualTo(1)
    }

    @Test fun `rejected SDP request does not connect on a later unsolicited event`() {
        shadowOf(target).setFetchUuidsWithSdpResult(false)
        request()
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        assertThat(connects).isZero()
        assertThat(messages.last()).contains("rejected")
    }

    @Test fun `missing UUID broadcast times out without connecting on a late event`() {
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(20))
        discovery.onUuids(target)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10))
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        assertThat(connects).isZero()
        assertThat(messages.last()).contains("timed out")
    }

    @Test fun `teardown cancellation invalidates callback and removes its timeout`() {
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        discovery.cancel()
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
        assertThat(connects).isZero()
        assertThat(messages.none { it.contains("timed out") }).isTrue()
    }

    @Test fun `previous session timeout cannot cancel rediscovery for the same glasses`() {
        shadowOf(target).setFetchUuidsWithSdpResult(true)
        request()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(20))
        discovery.cancel()
        request()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10))
        shadowOf(target).setUuids(arrayOf(sink))
        discovery.onUuids(target)
        assertThat(connects).isEqualTo(1)
    }
}
