package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothProfile
import java.lang.reflect.Modifier
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ClassicAudioConnectionTrackerTest {
    @Test
    fun `maps only terminal Android profile states`() {
        assertThat(classicProfileConnectedState(BluetoothProfile.STATE_CONNECTED)).isTrue()
        assertThat(classicProfileConnectedState(BluetoothProfile.STATE_DISCONNECTED)).isFalse()
        assertThat(classicProfileConnectedState(BluetoothProfile.STATE_CONNECTING)).isNull()
        assertThat(classicProfileConnectedState(BluetoothProfile.STATE_DISCONNECTING)).isNull()
    }

    @Test
    fun `serializes every public state access`() {
        val synchronizedMethods =
                setOf("getConnected", "setTarget", "update", "clear", "invalidate", "reset")

        val methods =
                ClassicAudioConnectionTracker::class.java.declaredMethods.associateBy { it.name }

        synchronizedMethods.forEach { name ->
            assertThat(Modifier.isSynchronized(methods.getValue(name).modifiers))
                    .describedAs("%s must synchronize tracker state", name)
                    .isTrue()
        }
    }

    @Test
    fun `publishes A2DP connect and disconnect transitions`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")

        assertThat(
                tracker.update(
                        ClassicAudioProfile.A2DP,
                        "aa:bb:cc:dd:ee:ff",
                        connected = true
                )
        ).isTrue()
        tracker.update(
                ClassicAudioProfile.A2DP,
                "AA:BB:CC:DD:EE:FF",
                connected = false
        )

        assertThat(changes).containsExactly(true, false)
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `stays connected while either A2DP or HFP is connected`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")

        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = true)
        tracker.update(ClassicAudioProfile.HEADSET, "AA:BB:CC:DD:EE:FF", connected = true)
        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = false)

        assertThat(changes).containsExactly(true)
        assertThat(tracker.connected).isTrue()

        tracker.update(ClassicAudioProfile.HEADSET, "AA:BB:CC:DD:EE:FF", connected = false)
        assertThat(changes).containsExactly(true, false)
    }

    @Test
    fun `ignores late callbacks from a previous device`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")
        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = true)

        tracker.setTarget("11:22:33:44:55:66")
        val accepted =
                tracker.update(
                        ClassicAudioProfile.A2DP,
                        "AA:BB:CC:DD:EE:FF",
                        connected = true
                )

        assertThat(accepted).isFalse()
        assertThat(changes).containsExactly(true, false)
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `reset clears a connected profile`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")
        tracker.update(ClassicAudioProfile.HEADSET, "AA:BB:CC:DD:EE:FF", connected = true)

        tracker.reset()

        assertThat(changes).containsExactly(true, false)
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `target teardown clears profiles without an external device reference`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")
        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = true)

        assertThat(tracker.clear("AA:BB:CC:DD:EE:FF")).isTrue()
        assertThat(changes).containsExactly(true, false)
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `profile reset retains target for a reconnect`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")
        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = true)

        assertThat(tracker.clear("AA:BB:CC:DD:EE:FF")).isTrue()
        assertThat(
                        tracker.update(
                                ClassicAudioProfile.HEADSET,
                                "AA:BB:CC:DD:EE:FF",
                                connected = true
                        )
                )
                .isTrue()

        assertThat(changes).containsExactly(true, false, true)
        assertThat(tracker.connected).isTrue()
    }

    @Test
    fun `target teardown rejects delayed callbacks from the invalidated session`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget("AA:BB:CC:DD:EE:FF")
        tracker.update(ClassicAudioProfile.A2DP, "AA:BB:CC:DD:EE:FF", connected = true)

        assertThat(tracker.invalidate("AA:BB:CC:DD:EE:FF")).isTrue()
        val accepted =
                tracker.update(
                        ClassicAudioProfile.HEADSET,
                        "AA:BB:CC:DD:EE:FF",
                        connected = true
                )

        assertThat(accepted).isFalse()
        assertThat(changes).containsExactly(true, false)
        assertThat(tracker.connected).isFalse()
    }
}
