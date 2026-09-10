package com.mentra.bluetoothsdk.sgcs

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ClassicAudioConnectionTrackerTest {
    private val address = "AA:BB:CC:DD:EE:FF"

    private fun snapshot(tracker: ClassicAudioConnectionTracker, vararg profiles: ClassicAudioProfile) {
        val ticket = tracker.beginSnapshot(address)!!
        assertThat(tracker.applySnapshot(ticket, address, profiles.toSet())).isTrue()
    }

    @Test
    fun `publishes complete A2DP and HFP snapshots without intermediate false negative`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget(address)
        snapshot(tracker, ClassicAudioProfile.A2DP)
        snapshot(tracker, ClassicAudioProfile.HEADSET)
        snapshot(tracker)
        assertThat(changes).containsExactly(true, false)
    }

    @Test
    fun `address comparison is case insensitive`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address.lowercase())
        snapshot(tracker, ClassicAudioProfile.A2DP)
        assertThat(tracker.connected).isTrue()
    }

    @Test
    fun `another device cannot request a snapshot`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        assertThat(tracker.beginSnapshot("11:22:33:44:55:66")).isNull()
    }

    @Test
    fun `late result for previous device cannot replace current profiles`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val ticket = tracker.beginSnapshot(address)!!
        tracker.setTarget("11:22:33:44:55:66")
        assertThat(tracker.applySnapshot(ticket, address, setOf(ClassicAudioProfile.A2DP))).isFalse()
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `old response cannot resurrect reconnected session with same MAC`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val ticket = tracker.beginSnapshot(address)!!
        tracker.invalidate(address)
        tracker.setTarget(address)
        snapshot(tracker)
        assertThat(tracker.applySnapshot(ticket, address, setOf(ClassicAudioProfile.A2DP))).isFalse()
        assertThat(tracker.connected).isFalse()
    }

    @Test
    fun `newer query invalidates in flight snapshot even before its response arrives`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val first = tracker.beginSnapshot(address)!!
        val second = tracker.beginSnapshot(address)!!
        assertThat(tracker.applySnapshot(first, address, setOf(ClassicAudioProfile.A2DP))).isFalse()
        assertThat(tracker.applySnapshot(second, address, emptySet())).isTrue()
    }

    @Test
    fun `late disconnect snapshot cannot overwrite newer connected snapshot`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val old = tracker.beginSnapshot(address)!!
        snapshot(tracker, ClassicAudioProfile.HEADSET)
        assertThat(tracker.applySnapshot(old, address, emptySet())).isFalse()
        assertThat(tracker.connected).isTrue()
    }

    @Test
    fun `clear invalidates queries but retains target for retry`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val old = tracker.beginSnapshot(address)!!
        assertThat(tracker.clear(address)).isTrue()
        assertThat(tracker.applySnapshot(old, address, setOf(ClassicAudioProfile.A2DP))).isFalse()
        snapshot(tracker, ClassicAudioProfile.A2DP)
        assertThat(tracker.connected).isTrue()
    }

    @Test
    fun `reset clears truth and prevents pending results from applying`() {
        val changes = mutableListOf<Boolean>()
        val tracker = ClassicAudioConnectionTracker(changes::add)
        tracker.setTarget(address)
        snapshot(tracker, ClassicAudioProfile.A2DP)
        val ticket = tracker.beginSnapshot(address)!!
        tracker.reset()
        assertThat(tracker.applySnapshot(ticket, address, setOf(ClassicAudioProfile.A2DP))).isFalse()
        assertThat(tracker.beginSnapshot(address)).isNull()
        assertThat(changes).containsExactly(true, false)
    }

    @Test
    fun `stale snapshot cannot emit audio routing notifications`() {
        val tracker = ClassicAudioConnectionTracker {}
        tracker.setTarget(address)
        val old = tracker.beginSnapshot(address)!!
        tracker.setTarget(address)
        var notifications = 0
        tracker.applySnapshot(old, address, setOf(ClassicAudioProfile.A2DP)) { notifications++ }
        assertThat(notifications).isZero()
    }
}
