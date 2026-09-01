package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ClassicAudioConnectionTrackerTest {
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
}
