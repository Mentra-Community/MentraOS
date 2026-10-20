package com.mentra.bluetoothsdk

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.sgcs.MentraLivePairingState
import com.mentra.bluetoothsdk.sgcs.MentraLivePairingStateMachine
import com.mentra.bluetoothsdk.sgcs.MentraLivePairingStateStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class DeviceManagerOwnerLossTest {
    private val device = "MENTRA_LIVE_BLE_ABCD"
    private lateinit var savedBluetooth: Map<String, Any>
    private lateinit var savedGlasses: Map<String, Any>

    @Before fun setUp() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        savedBluetooth = DeviceStore.store.getCategory("bluetooth")
        savedGlasses = DeviceStore.store.getCategory("glasses")
        prefs().edit().clear().commit()
        MentraLivePairingStateStore.resetForTest()
    }

    @After fun tearDown() {
        MentraLivePairingStateStore.resetForTest()
        prefs().edit().clear().commit()
        restore("bluetooth", savedBluetooth)
        restore("glasses", savedGlasses)
    }

    @Test fun `forgetting glasses clears the saved secure firmware flag`() {
        val manager = DeviceManager(initializeHardware = false)
        try {
            DeviceStore.set("bluetooth", "mentra_live_secure_firmware", true)
            manager.clearSecureFirmware()
            assertFalse(DeviceStore.store.get("bluetooth", "mentra_live_secure_firmware") as Boolean)
        } finally {
            manager.cleanup()
        }
    }

    @Test fun `bluetooth-on still reaches the manager while rejected so Pair Again stays possible`() {
        val manager = DeviceManager(initializeHardware = false)
        try {
            DeviceStore.set("bluetooth", "default_wearable", "Mentra Live")
            DeviceStore.set("bluetooth", "device_name", device)
            rejectViaFlagOffNotice()
            assertTrue(manager.shouldReconnectAfterBluetoothOn())
        } finally {
            manager.cleanup()
        }
    }

    @Test fun `a pause and its window id survive a process restart`() {
        MentraLivePairingStateStore.ensureRestored(device)
        val now = System.currentTimeMillis()
        MentraLivePairingStateStore.update("test") {
            it.onEnteringPairingMode(120_000L, 99, true, false, device, now)
        }
        assertTrue(MentraLivePairingStateStore.isPaused)

        MentraLivePairingStateStore.resetForTest()
        assertEquals(MentraLivePairingState.Normal, MentraLivePairingStateStore.state)
        MentraLivePairingStateStore.ensureRestored(device)

        val state = MentraLivePairingStateStore.state as MentraLivePairingState.PairingMode
        assertEquals(99, state.windowId)
        assertEquals(now + 150_000L, state.endsAtMs)
        @Suppress("UNCHECKED_CAST")
        val published = DeviceStore.store.get("glasses", "pairingState") as Map<String, Any>
        assertEquals("pairing_mode", published["state"])
        assertEquals(99, published["windowId"])
    }

    @Test fun `a rejection survives a restart and is not touched by the replayed owner-lost setting`() {
        MentraLivePairingStateStore.ensureRestored(device)
        rejectViaFlagOffNotice()
        // The old app replays mentra_live_owner_lost=false; that must not clear the native state.
        DeviceStore.set("bluetooth", "mentra_live_owner_lost", false)
        MentraLivePairingStateStore.resetForTest()
        MentraLivePairingStateStore.ensureRestored(device)
        assertTrue(MentraLivePairingStateStore.isRejected)
        assertFalse(MentraLivePairingStateStore.allowsAutomaticReconnect)
    }

    @Test fun `forget clears pairing_rejected and the pre-v4 owner-lost setting`() {
        val manager = DeviceManager(initializeHardware = false)
        try {
            MentraLivePairingStateStore.ensureRestored(device)
            rejectViaFlagOffNotice()
            DeviceStore.set("bluetooth", "mentra_live_owner_lost", true)
            manager.clearPairingStateOnForget()
            assertEquals(MentraLivePairingState.Normal, MentraLivePairingStateStore.state)
            assertFalse(DeviceStore.store.get("bluetooth", "mentra_live_owner_lost") as Boolean)
            MentraLivePairingStateStore.resetForTest()
            MentraLivePairingStateStore.ensureRestored(device)
            assertEquals(MentraLivePairingState.Normal, MentraLivePairingStateStore.state)
        } finally {
            manager.cleanup()
        }
    }

    @Test fun `rollback tolerance - legacy keys migrate and unknown keys are ignored`() {
        prefs()
                .edit()
                .putString(MentraLivePairingStateMachine.LEGACY_REJECTION_PHASE_KEY, "inside")
                .putLong("pairing_yield_until_wall_ms", System.currentTimeMillis() + 60_000L)
                .putString("pairing_v9_unknown", "x")
                .commit()
        MentraLivePairingStateStore.ensureRestored(device)
        assertTrue(MentraLivePairingStateStore.isRejected)
        // Legacy keys are removed after migration so an older build cannot re-apply them.
        assertFalse(prefs().contains(MentraLivePairingStateMachine.LEGACY_REJECTION_PHASE_KEY))
        assertFalse(prefs().contains("pairing_yield_until_wall_ms"))
        assertTrue(prefs().contains("pairing_v9_unknown"))
    }

    private fun rejectViaFlagOffNotice() {
        MentraLivePairingStateStore.update("test") {
            it.onEnteringPairingMode(120_000L, null, false, false, device, System.currentTimeMillis())
        }
        assertTrue(MentraLivePairingStateStore.isRejected)
    }

    private fun prefs() =
            ApplicationProvider.getApplicationContext<Context>()
                    .getSharedPreferences("mentra_live_owner", Context.MODE_PRIVATE)

    private fun restore(category: String, saved: Map<String, Any>) {
        (DeviceStore.store.getCategory(category).keys - saved.keys).forEach {
            DeviceStore.store.remove(category, it)
        }
        saved.forEach { (key, value) -> DeviceStore.set(category, key, value) }
    }
}
