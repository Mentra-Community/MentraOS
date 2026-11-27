package com.mentra.bluetoothsdk.sgcs

import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.SimulatedDisplayEventKind
import com.mentra.bluetoothsdk.TouchGesture
import com.mentra.bluetoothsdk.utils.ConnTypes
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.MicTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class SimulatedGlassesScriptingTest {
    private fun withSimulated(block: (Simulated) -> Unit) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val saved = listOf("bluetooth", "glasses").associateWith { DeviceStore.store.getCategory(it) }
        val manager = DeviceManager(initializeHardware = false)
        singleton.set(null, manager)
        try {
            block(Simulated())
        } finally {
            manager.cleanup()
            singleton.set(null, previous)
            saved.forEach { (category, values) ->
                DeviceStore.store.getCategory(category).keys.filter { it !in values }.forEach {
                    DeviceStore.store.remove(category, it)
                }
                values.forEach { (key, value) -> DeviceStore.set(category, key, value) }
            }
        }
    }

    @Test
    fun displayTranscriptKeepsDisplayCommandsInOrder() {
        withSimulated { simulated ->
            simulated.clearDisplay()
            simulated.sendText("hello")
            simulated.sendTextWall("wall")
            simulated.sendDoubleTextWall("top", "bottom")
            simulated.displayBitmap("cGl4ZWxz", x = 0, y = 0, width = 64, height = 64)

            val events = simulated.snapshot().displayTranscript()

            assertEquals(
                listOf(
                    SimulatedDisplayEventKind.CLEAR,
                    SimulatedDisplayEventKind.TEXT,
                    SimulatedDisplayEventKind.TEXT_WALL,
                    SimulatedDisplayEventKind.DOUBLE_TEXT_WALL,
                    SimulatedDisplayEventKind.BITMAP,
                ),
                events.map { it.kind },
            )
            assertEquals("hello", events[1].text)
            assertEquals("wall", events[2].text)
            assertEquals("top", events[3].top)
            assertEquals("bottom", events[3].bottom)
            assertEquals("cGl4ZWxz", events[4].base64ImageData)
        }
    }

    @Test
    fun injectMicPcmTagsTheSyntheticSourceAsGlasses() {
        withSimulated { simulated ->
            val events = mutableListOf<Pair<String, Map<String, Any>>>()
            val sinkId = Bridge.addEventSink { name, data -> events.add(name to data) }
            try {
                simulated.snapshot().injectMicPcm(ByteArray(320))

                assertEquals(1, events.size)
                val (name, data) = events.single()
                assertEquals("mic_pcm", name)
                assertEquals(MicTypes.GLASSES_CUSTOM, data["source"])
                assertTrue(data["pcm"] is ByteArray)
            } finally {
                Bridge.removeEventSink(sinkId)
            }
        }
    }

    @Test
    fun injectTouchEmitsThePublicGestureNameForSimulatedGlasses() {
        withSimulated { simulated ->
            val events = mutableListOf<Pair<String, Map<String, Any>>>()
            val sinkId = Bridge.addEventSink { name, data -> events.add(name to data) }
            try {
                simulated.snapshot().injectTouch(TouchGesture.SINGLE_TAP)

                val (name, data) = events.single()
                assertEquals("touch_event", name)
                assertEquals("touch_event", data["type"])
                assertEquals(DeviceTypes.SIMULATED, data["deviceModel"])
                assertEquals(TouchGesture.SINGLE_TAP.wireName, data["gestureName"])
            } finally {
                Bridge.removeEventSink(sinkId)
            }
        }
    }

    @Test
    fun injectHeadUpEmitsTheRequestedOrientation() {
        withSimulated { simulated ->
            val events = mutableListOf<Pair<String, Map<String, Any>>>()
            val sinkId = Bridge.addEventSink { name, data -> events.add(name to data) }
            try {
                val handle = simulated.snapshot()
                handle.injectHeadUp(false)
                handle.injectHeadUp(true)

                assertEquals(listOf("head_up", "head_up"), events.map { it.first })
                assertEquals(false, events[0].second["up"])
                assertEquals(true, events[1].second["up"])
            } finally {
                Bridge.removeEventSink(sinkId)
            }
        }
    }

    @Test
    fun disconnectAndReconnectReflectConnectionStateWithoutDroppingTheHandle() {
        withSimulated { simulated ->
            val handle = simulated.snapshot()

            handle.simulateDisconnect()
            assertEquals(false, DeviceStore.get("glasses", "connected"))
            assertEquals(ConnTypes.DISCONNECTED, DeviceStore.get("glasses", "connectionState"))

            handle.simulateReconnect()
            assertEquals(true, DeviceStore.get("glasses", "connected"))
            assertEquals(ConnTypes.CONNECTED, DeviceStore.get("glasses", "connectionState"))
            assertEquals(true, DeviceStore.get("glasses", "fullyBooted"))
        }
    }
}
