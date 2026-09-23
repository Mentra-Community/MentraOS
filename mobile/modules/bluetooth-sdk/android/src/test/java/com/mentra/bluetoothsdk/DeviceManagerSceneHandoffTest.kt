package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import android.os.Looper
import com.mentra.bluetoothsdk.sgcs.Nimo
import com.mentra.bluetoothsdk.sgcs.SGCManager
import com.mentra.bluetoothsdk.sgcs.SceneFrame
import com.mentra.bluetoothsdk.utils.DeviceTypes
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DeviceManagerSceneHandoffTest {
    @Before fun setup() { Bridge.initialize(ApplicationProvider.getApplicationContext()) }

    @Test fun firmwareReconnectRetainsOwnerAndRejectsAnotherDefaultIdentity() {
        Shadows.shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).grantPermissions(
            android.Manifest.permission.BLUETOOTH_CONNECT, android.Manifest.permission.BLUETOOTH_SCAN)
        val manager = DeviceManager(initializeHardware = false)
        val device = RecordingSGC(false)
        val directory = java.nio.file.Files.createTempDirectory("firmware-reconnect-test").toFile()
        val previousAddress = DeviceStore.get("bluetooth", "device_address") as? String ?: ""
        try {
            val updater = com.mentra.bluetoothsdk.sgcs.firmware.LiveFirmwareUpdater("native-owner", 1, { false }, {}, directory)
            updater.status("active", "install", "in_progress", 40, 1)
            device.firmware = updater
            manager.sgc = device
            DeviceStore.set("bluetooth", "device_address", "native-owner")
            manager.connectDefault()
            assertEquals(listOf("firmware-reconnect"), device.calls)
            assertSame(device, manager.sgc)
            assertFalse(manager.firmwareReplacementAllowed)
            DeviceStore.set("bluetooth", "device_address", "different-device")
            manager.connectDefault()
            assertEquals(listOf("firmware-reconnect"), device.calls)
            assertSame(device, manager.sgc)
        } finally {
            manager.sgc = null
            manager.cleanup()
            DeviceStore.set("bluetooth", "device_address", previousAddress)
            directory.deleteRecursively()
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun nimoBrightnessChangesDoNotReplaceTheSelectedScene() {
        for (headUp in listOf(false, true)) for ((key, value) in brightnessChanges()) {
            withSharedRecordingDevice { manager, device ->
                DeviceStore.set("glasses", "headUp", headUp)
                manager.displayEvent(scene("main", "main-app"))
                manager.displayEvent(scene("dashboard", "dashboard-app"))
                device.calls.clear()

                DeviceStore.apply("bluetooth", key, value)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)

                assertEquals(listOf(if (key == "brightness") "65:true" else "50:false"), device.brightnessCalls)
                assertTrue("Changing $key must not replace or clear the NIMO canvas: ${device.calls}", device.calls.isEmpty())
                manager.sendCurrentState()
                assertEquals(listOf("scene:${if (headUp) "dashboard-app" else "main-app"}:true"), device.calls)
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun repeatedNimoBrightnessChangesDoNotLeaveTimersThatEraseNewerFrames() {
        withSharedRecordingDevice { manager, device ->
            DeviceStore.set("glasses", "headUp", false)
            manager.displayEvent(scene("main", "old"))
            device.calls.clear()
            DeviceStore.apply("bluetooth", "brightness", 65)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(400, TimeUnit.MILLISECONDS)
            manager.displayEvent(scene("main", "latest"))
            DeviceStore.apply("bluetooth", "auto_brightness", false)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(400, TimeUnit.MILLISECONDS)
            DeviceStore.apply("bluetooth", "auto_brightness", true)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)

            assertEquals(listOf("65:true", "65:false", "65:true"), device.brightnessCalls)
            assertEquals(listOf("scene:latest:true"), device.calls)
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun nimoBrightnessChangesDoNotWakeSuppressedDisplays() {
        for (gate in listOf("screen-disabled", "not-ready", "no-device")) {
            for ((key, value) in brightnessChanges()) withSharedRecordingDevice { manager, device ->
                when (gate) {
                    "screen-disabled" -> DeviceStore.set("bluetooth", "screen_disabled", true)
                    "not-ready" -> DeviceStore.set("glasses", "fullyBooted", false)
                    "no-device" -> manager.sgc = null
                }
                DeviceStore.apply("bluetooth", key, value)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
                assertTrue("Unexpected display mutation with $gate", device.calls.isEmpty())
                assertEquals(if (gate == "no-device") 0 else 1, device.brightnessCalls.size)
                manager.sgc = device
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun defaultDevicesKeepTheirBrightnessConfirmation() {
        for ((key, value) in brightnessChanges()) {
            withSharedRecordingDevice(RecordingSGC(true)) { _, device ->
                DeviceStore.apply("bluetooth", key, value)
                Shadows.shadowOf(Looper.getMainLooper()).idle()
                val confirmation = if (key == "brightness") "Set brightness to 65%" else "Disabled auto brightness"
                assertEquals(listOf("text:$confirmation"), device.calls)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(799, TimeUnit.MILLISECONDS)
                assertEquals(listOf("text:$confirmation"), device.calls)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.MILLISECONDS)
                assertEquals(listOf("text:$confirmation", "clear"), device.calls)
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun oldBrightnessConfirmationDoesNotClearAReplacementDevice() {
        for ((key, value) in brightnessChanges()) {
            withSharedRecordingDevice(RecordingSGC(true)) { manager, device ->
                DeviceStore.apply("bluetooth", key, value)
                Shadows.shadowOf(Looper.getMainLooper()).idle()
                assertEquals(1, device.calls.size)
                val replacement = NimoRecordingSGC()
                manager.sgc = replacement
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
                assertEquals("The disconnected device must not be cleared either", 1, device.calls.size)
                assertTrue("A previous device's timer must not touch NIMO", replacement.calls.isEmpty())
                manager.sgc = device
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun unchangedBrightnessSettingsDoNotDispatchForEitherPolicy() {
        for (device in listOf(RecordingSGC(true), NimoRecordingSGC())) {
            withSharedRecordingDevice(device) { _, current ->
                DeviceStore.apply("bluetooth", "brightness", 50)
                DeviceStore.apply("bluetooth", "auto_brightness", true)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
                assertTrue(current.brightnessCalls.isEmpty())
                assertTrue(current.calls.isEmpty())
            }
        }
    }

    @Test fun nimoOptsOutOfBrightnessConfirmationIndependentlyOfSceneHandoffPolicy() {
        val nimo = Nimo()
        try {
            assertFalse(nimo.showBrightnessConfirmation)
            assertTrue(RecordingSGC(false).showBrightnessConfirmation)
            assertTrue(RecordingSGC(true).showBrightnessConfirmation)
        } finally { nimo.cleanup() }
    }

    private fun brightnessChanges(): List<Pair<String, Any>> =
        listOf("brightness" to 65, "auto_brightness" to false)

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun nimoReconnectDoesNotEraseReplayedMainSceneAfterReady() {
        assertNimoReconnectPreservesReplayedScene(headUp = false)
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun nimoReconnectDoesNotEraseReplayedDashboardSceneAfterReady() {
        assertNimoReconnectPreservesReplayedScene(headUp = true)
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun nimoReadyWithoutASceneDoesNotScheduleAWelcomeOrClear() {
        withReadyRecordingDevice { manager, _, executor ->
            manager.disconnect()
            val replacement = NimoRecordingSGC()
            manager.sgc = replacement
            DeviceStore.apply("glasses", "fullyBooted", true)
            executor.submit {}.get(5, TimeUnit.SECONDS)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(4, TimeUnit.SECONDS)
            assertTrue(replacement.calls.isEmpty())
            assertEquals(false, DeviceStore.get("bluetooth", "shouldSendBootingMessage"))
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun defaultDeviceReadyKeepsItsThreeSecondWelcome() {
        withReadyRecordingDevice { manager, _, executor ->
            manager.disconnect()
            val replacement = RecordingSGC(true)
            manager.sgc = replacement
            DeviceStore.apply("glasses", "fullyBooted", true)
            executor.submit {}.get(5, TimeUnit.SECONDS)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(4, TimeUnit.SECONDS)
            assertEquals(listOf("text:// MentraOS Connected", "clear"), replacement.calls)
            assertTrue("Welcome must remain for at least three seconds",
                replacement.lastClearNanos - replacement.lastTextNanos >= TimeUnit.SECONDS.toNanos(3))
            assertEquals(false, DeviceStore.get("bluetooth", "shouldSendBootingMessage"))
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun queuedWelcomeDoesNotReachAReplacementCommunicator() {
        assertTrue("The welcome executor must observe communicator replacement writes",
            java.lang.reflect.Modifier.isVolatile(DeviceManager::class.java.getDeclaredField("sgc").modifiers))
        withReadyRecordingDevice { manager, _, executor ->
            manager.disconnect()
            val original = RecordingSGC(true)
            manager.sgc = original
            val executorEntered = CountDownLatch(1)
            val releaseExecutor = CountDownLatch(1)
            executor.execute { executorEntered.countDown(); releaseExecutor.await(5, TimeUnit.SECONDS) }
            assertTrue(executorEntered.await(1, TimeUnit.SECONDS))
            try {
                DeviceStore.apply("glasses", "fullyBooted", true)
                val replacement = NimoRecordingSGC()
                manager.sgc = replacement
                releaseExecutor.countDown()
                executor.submit {}.get(5, TimeUnit.SECONDS)
                Shadows.shadowOf(Looper.getMainLooper()).idleFor(4, TimeUnit.SECONDS)
                assertTrue("The retired communicator must not receive a queued welcome", original.calls.isEmpty())
                assertTrue("The replacement must not receive another communicator's welcome", replacement.calls.isEmpty())
            } finally { releaseExecutor.countDown() }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun welcomeClearDoesNotEraseAReplacementCommunicatorsScene() {
        withReadyRecordingDevice { manager, _, executor ->
            manager.disconnect()
            val original = RecordingSGC(true)
            manager.sgc = original
            DeviceStore.apply("glasses", "fullyBooted", true)
            assertTrue(original.textSent.await(1, TimeUnit.SECONDS))
            val replacement = NimoRecordingSGC()
            manager.sgc = replacement
            manager.displayEvent(scene("main", "replacement-app", replay = true))
            executor.submit {}.get(5, TimeUnit.SECONDS)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(4, TimeUnit.SECONDS)
            assertEquals(listOf("text:// MentraOS Connected"), original.calls)
            assertEquals(listOf("scene:replacement-app:true"), replacement.calls)
        }
    }

    @Test fun nimoOptsOutOfConnectionConfirmationIndependentlyOfOtherPolicies() {
        val nimo = Nimo()
        try {
            assertFalse(nimo.showConnectionConfirmation)
            assertTrue(RecordingSGC(false).showConnectionConfirmation)
            assertTrue(RecordingSGC(true).showConnectionConfirmation)
            assertTrue(object : RecordingSGC(false) {
                override val showBrightnessConfirmation = false
            }.showConnectionConfirmation)
        } finally { nimo.cleanup() }
    }

    private fun assertNimoReconnectPreservesReplayedScene(headUp: Boolean) {
        withReadyRecordingDevice { manager, original, executor ->
            DeviceStore.set("glasses", "headUp", headUp)
            manager.displayEvent(scene("main", "main-app"))
            manager.displayEvent(scene("dashboard", "dashboard-app"))
            val selectedView = if (headUp) "dashboard" else "main"
            val selectedApp = "$selectedView-app"
            val selectedScene = "scene:$selectedApp:true"
            assertEquals("scene:$selectedApp:false", original.calls.last())
            original.calls.clear()

            // Use the public disconnect, not a manually armed boot flag.
            manager.disconnect()
            assertEquals(listOf("clear", "disconnect"), original.calls)
            assertNull(manager.sgc)
            assertEquals(true, DeviceStore.get("bluetooth", "shouldSendBootingMessage"))
            val replacement = NimoRecordingSGC()
            manager.sgc = replacement
            // Disconnect resets headUp; restore the selected orientation
            // before readiness without injecting a new miniapp frame.
            DeviceStore.set("glasses", "headUp", headUp)
            DeviceStore.apply("glasses", "fullyBooted", true)
            // Model LocalDisplayManager's connected-edge replay through
            // its actual native ingress. The miniapp content is unchanged;
            // the host sends a fresh epoch with all elements created.
            manager.displayEvent(scene(selectedView, selectedApp, replay = true, epoch = 2))

            // The old welcome slept on this real executor. A submitted
            // barrier waits for any such task; paused Main alone cannot.
            executor.submit {}.get(5, TimeUnit.SECONDS)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(4, TimeUnit.SECONDS)
            val readyCalls = replacement.calls.toList()

            // Positive control: the scene remains retained for later replay.
            replacement.calls.clear()
            manager.sendCurrentState()
            assertEquals(listOf(selectedScene), replacement.calls)
            assertEquals("Reconnect must not erase the host replay: $readyCalls", selectedScene, readyCalls.last())
        }
    }

    private fun withReadyRecordingDevice(block: (DeviceManager, RecordingSGC, ExecutorService) -> Unit) {
        // Disconnect and readiness also mutate identity/mic state. Restore both
        // categories, including keys that were absent before this test.
        val saved = listOf("bluetooth", "glasses").associateWith { DeviceStore.store.getCategory(it) }
        try {
            withSharedRecordingDevice { manager, original ->
                val executor = DeviceManager::class.java.getDeclaredField("executor").run {
                    isAccessible = true
                    get(manager) as ExecutorService
                }
                try { block(manager, original, executor) } finally {
                    executor.shutdownNow()
                    assertTrue(executor.awaitTermination(1, TimeUnit.SECONDS))
                }
            }
        } finally {
            saved.forEach { (category, values) ->
                (DeviceStore.store.getCategory(category).keys - values.keys).forEach {
                    DeviceStore.store.remove(category, it)
                }
                values.forEach { (key, value) -> DeviceStore.set(category, key, value) }
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun contextualDashboardToggleReplaysSelectedViewWithoutNewMiniappEvent() {
        withSharedRecordingDevice { manager, device ->
            manager.displayEvent(scene("main", "main-app"))
            manager.displayEvent(scene("dashboard", "dashboard-app"))
            device.calls.clear()

            // Settings arrive from Expo's worker queue, not necessarily Main.
            val worker = Thread { DeviceStore.apply("bluetooth", "contextual_dashboard", false) }
            worker.start(); worker.join(1000)
            assertFalse(worker.isAlive)
            assertTrue("Dispatch must wait for Main", device.calls.isEmpty())
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            assertEquals(listOf("scene:main-app:true"), device.calls)

            device.calls.clear()
            DeviceStore.apply("bluetooth", "contextual_dashboard", true)
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            assertEquals(listOf("scene:dashboard-app:true"), device.calls)
            device.calls.clear()
            DeviceStore.apply("bluetooth", "contextual_dashboard", true)
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            assertTrue("An unchanged setting must not redraw", device.calls.isEmpty())
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun contextualDashboardToggleRetainsHeadDownAndDisplaySuppressionGuards() {
        for (gate in listOf("head-down", "screen-disabled", "not-ready", "no-device")) {
            withSharedRecordingDevice { manager, device ->
                manager.displayEvent(scene("main", "main-app"))
                manager.displayEvent(scene("dashboard", "dashboard-app"))
                device.calls.clear()
                when (gate) {
                    "head-down" -> DeviceStore.set("glasses", "headUp", false)
                    "screen-disabled" -> DeviceStore.set("bluetooth", "screen_disabled", true)
                    "not-ready" -> DeviceStore.set("glasses", "fullyBooted", false)
                    "no-device" -> manager.sgc = null
                }
                DeviceStore.apply("bluetooth", "contextual_dashboard", false)
                Shadows.shadowOf(Looper.getMainLooper()).idle()
                assertTrue("Unexpected dispatch with $gate", device.calls.isEmpty())
                manager.sgc = device
            }
        }
    }

    @Test @LooperMode(LooperMode.Mode.PAUSED)
    fun deferredDashboardHandoffRespectsFullFramePolicy() {
        for (requiresClear in listOf(false, true)) {
            withSharedRecordingDevice(RecordingSGC(requiresClear)) { manager, device ->
                manager.displayEvent(scene("dashboard", "dashboard-app"))
                device.calls.clear()
                manager.setDashboardContent("new dashboard")
                assertEquals(requiresClear, device.calls.any { it.startsWith("remove:") })
                assertTrue(device.calls.last().endsWith("new dashboard"))
            }
        }
    }

    private fun withSharedRecordingDevice(
        device: RecordingSGC = NimoRecordingSGC(),
        block: (DeviceManager, RecordingSGC) -> Unit
    ) {
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val keys = listOf("glasses" to "fullyBooted", "glasses" to "headUp",
            "bluetooth" to "contextual_dashboard", "bluetooth" to "screen_disabled",
            "bluetooth" to "brightness", "bluetooth" to "auto_brightness")
        val saved = keys.associateWith { DeviceStore.get(it.first, it.second)!! }
        val manager = DeviceManager(initializeHardware = false)
        manager.sgc = device
        singleton.set(null, manager)
        DeviceStore.set("glasses", "fullyBooted", true)
        DeviceStore.set("glasses", "headUp", true)
        DeviceStore.set("bluetooth", "contextual_dashboard", true)
        DeviceStore.set("bluetooth", "screen_disabled", false)
        DeviceStore.set("bluetooth", "brightness", 50)
        DeviceStore.set("bluetooth", "auto_brightness", true)
        try { block(manager, device) } finally {
            DeviceStore.set("glasses", "fullyBooted", false)
            manager.cleanup()
            singleton.set(null, previous)
            saved.forEach { (key, value) -> DeviceStore.set(key.first, key.second, value) }
        }
    }

    @Test fun actualDisplayEventHandoffsRespectBothViewsAndDevicePolicy() {
        for (clearRequired in listOf(false, true)) for (headUp in listOf(false, true)) {
            for (contextual in listOf(false, true)) for (view in listOf("main", "dashboard")) {
                val manager = DeviceManager(initializeHardware = false)
                val device = RecordingSGC(clearRequired)
                manager.sgc = device
                DeviceStore.set("glasses", "fullyBooted", true)
                DeviceStore.set("glasses", "headUp", headUp)
                DeviceStore.set("bluetooth", "contextual_dashboard", contextual)
                DeviceStore.set("bluetooth", "screen_disabled", false)
                val visible = (view == "dashboard") == (headUp && contextual)

                manager.displayEvent(legacy(view, "legacy-a"))
                device.calls.clear()
                manager.displayEvent(scene(view, "one"))
                assertEquals(if (!visible) emptyList() else
                    (if (clearRequired) listOf("clear") else emptyList()) + "scene:one:false", device.calls)

                device.calls.clear()
                manager.displayEvent(scene(view, "two"))
                assertEquals(if (!visible) emptyList() else
                    (if (clearRequired) listOf("remove:one-label") else emptyList()) + "scene:two:true", device.calls)

                device.calls.clear()
                manager.displayEvent(legacy(view, "legacy-b"))
                assertEquals(if (!visible) emptyList() else
                    (if (clearRequired) listOf("remove:two-label") else emptyList()) + "text:legacy-b", device.calls)

                // Hidden events update their real replay slot, not the visible display.
                device.calls.clear()
                DeviceStore.set("glasses", "headUp", view == "dashboard")
                DeviceStore.set("bluetooth", "contextual_dashboard", true)
                manager.sendCurrentState()
                assertEquals(listOf("text:legacy-b"), device.calls)
                DeviceStore.set("glasses", "fullyBooted", false)
                manager.cleanup()
            }
        }
    }

    @Test fun suppressedDisplaysNeitherClearNorDispatchButRetainSceneReplay() {
        for (suppression in listOf("screen", "boot", "simulated")) {
            val manager = DeviceManager(initializeHardware = false)
            val device = RecordingSGC(true)
            manager.sgc = device
            DeviceStore.set("glasses", "fullyBooted", suppression != "boot")
            DeviceStore.set("glasses", "headUp", false)
            DeviceStore.set("bluetooth", "contextual_dashboard", true)
            DeviceStore.set("bluetooth", "screen_disabled", suppression == "screen")
            if (suppression == "simulated") device.type = DeviceTypes.SIMULATED
            manager.displayEvent(legacy("main", "legacy"))
            manager.displayEvent(scene("main", "one"))
            manager.displayEvent(scene("main", "two"))
            assertTrue(device.calls.isEmpty())
            DeviceStore.set("glasses", "fullyBooted", true)
            DeviceStore.set("bluetooth", "screen_disabled", false)
            device.type = "Clear-required glasses"
            manager.sendCurrentState()
            assertEquals(listOf("scene:two:true"), device.calls)
            DeviceStore.set("glasses", "fullyBooted", false)
            manager.cleanup()
        }
    }

    @Test fun clearViewDoesNotSweepSceneTwiceAndOtherDeviceDisconnectStaysUnchanged() {
        val manager = DeviceManager(initializeHardware = false)
        val device = RecordingSGC(true)
        manager.sgc = device
        DeviceStore.set("glasses", "fullyBooted", true)
        DeviceStore.set("glasses", "headUp", false)
        DeviceStore.set("bluetooth", "screen_disabled", false)
        manager.displayEvent(scene("main", "one"))
        device.calls.clear()
        manager.displayEvent(mapOf("view" to "main", "layout" to mapOf("layoutType" to "clear_view")))
        assertEquals(listOf("clear"), device.calls)
        DeviceStore.set("glasses", "fullyBooted", false)
        device.calls.clear()
        manager.disconnect()
        assertEquals(listOf("clear", "disconnect"), device.calls)
        assertNull(manager.sgc)
        manager.cleanup()
    }

    @Test fun ordinaryNimoDisconnectStopsItsEncoderThread() {
        val manager = DeviceManager(initializeHardware = false)
        val before = Thread.getAllStackTraces().keys
        val nimo = Nimo()
        manager.sgc = nimo
        val encoder = Thread.getAllStackTraces().keys.single { it.name == "NimoCanvasEncoder" && it !in before }
        try {
            DeviceStore.set("glasses", "fullyBooted", false)
            manager.disconnect()
            encoder.join(1000)
            assertFalse("Discarded communicator left an encoder thread alive", encoder.isAlive)
            assertNull(manager.sgc)
        } finally { nimo.cleanup(); manager.cleanup() }
    }

    private fun legacy(view: String, text: String): Map<String, Any> =
        mapOf("view" to view, "layout" to mapOf("layoutType" to "text_wall", "text" to text))

    private fun scene(view: String, app: String, replay: Boolean = false, epoch: Int = 1): Map<String, Any> = mapOf("view" to view, "scene" to mapOf(
        "appId" to app, "sceneEpoch" to epoch, "replay" to replay, "elements" to listOf(mapOf(
            "id" to "$app-label", "type" to "text", "text" to app, "change" to "created",
            "box" to mapOf("x" to 0, "y" to 0, "w" to 100, "h" to 20)))))

    private class NimoRecordingSGC : RecordingSGC(false) {
        override val showBrightnessConfirmation = false
        override val showConnectionConfirmation = false
    }

    private open class RecordingSGC(override val sceneHandoffRequiresClear: Boolean) : SGCManager() {
        var firmware: com.mentra.bluetoothsdk.sgcs.firmware.FirmwareUpdater? = null
        override val firmwareUpdater get() = firmware
        override val firmwareUpdateOwnsDevice get() = firmware?.snapshot?.safeToRelease == false
        override fun reconnectFirmwareOwner() { calls += "firmware-reconnect" }
        val calls = CopyOnWriteArrayList<String>()
        val brightnessCalls = mutableListOf<String>()
        val textSent = CountDownLatch(1)
        var lastTextNanos = 0L
        var lastClearNanos = 0L
        init { type = if (sceneHandoffRequiresClear) "Clear-required glasses" else DeviceTypes.NIMO }
        override fun clearDisplay() { lastClearNanos = System.nanoTime(); calls += "clear" }
        override fun clearSceneElements(elementIds: List<String>) { calls += "remove:${elementIds.joinToString()}" }
        override fun applySceneFrame(frame: SceneFrame) { calls += "scene:${frame.appId}:${frame.replay}" }
        override fun sendTextWall(text: String) { lastTextNanos = System.nanoTime(); calls += "text:$text"; textSent.countDown() }
        override fun disconnect() { calls += "disconnect" }
        override fun cleanup() { calls += "cleanup" }
        override fun setMicEnabled(enabled: Boolean) {}
        override fun sortMicRanking(list: MutableList<String>) = list
        override fun requestPhoto(request: PhotoRequest) {}
        override fun startStream(message: MutableMap<String, Any>) {}
        override fun stopStream() {}
        override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {}
        override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {}
        override fun stopVideoRecording(requestId: String) {}
        override fun sendButtonPhotoSettings() {}
        override fun sendButtonVideoRecordingSettings() {}
        override fun sendButtonMaxRecordingTime() {}
        override fun sendCameraFovSetting() {}
        override fun setBrightness(level: Int, autoMode: Boolean) { brightnessCalls += "$level:$autoMode" }
        override fun sendText(text: String) {}
        override fun sendDoubleTextWall(top: String, bottom: String) {}
        override fun displayBitmap(base64ImageData: String, x: Int?, y: Int?, width: Int?, height: Int?) = true
        override fun showDashboard() {}
        override fun setDashboardPosition(height: Int, depth: Int) {}
        override fun setHeadUpAngle(angle: Int) {}
        override fun getBatteryStatus() {}
        override fun setSilentMode(enabled: Boolean) {}
        override fun exit() {}
        override fun sendShutdown() {}
        override fun sendReboot() {}
        override fun sendRgbLedControl(requestId: String, packageName: String?, action: String, color: String?, onDurationMs: Int, offDurationMs: Int, count: Int) {}
        override fun forget() {}
        override fun findCompatibleDevices() {}
        override fun stopScan() {}
        override fun connectById(id: String) {}
        override fun getConnectedBluetoothName() = ""
        override fun ping() {}
        override fun dbg1() {}
        override fun dbg2() {}
        override fun requestWifiScan(scanId: String?) {}
        override fun sendWifiCredentials(ssid: String, password: String) {}
        override fun forgetWifiNetwork(ssid: String) {}
        override fun sendHotspotState(enabled: Boolean) {}
        override fun sendUserEmailToGlasses(email: String) {}
        override fun sendIncidentId(incidentId: String, apiBaseUrl: String?) {}
        override fun queryGalleryStatus() {}
        override fun sendGalleryMode() {}
        override fun requestVersionInfo() {}
    }
}
