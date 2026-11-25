package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.sgcs.SGCManager
import com.mentra.bluetoothsdk.sgcs.SceneFrame
import com.mentra.bluetoothsdk.utils.DeviceTypes
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class VersionInfoRequestTest {
    @Test
    fun glassesThatRestartWhileARequestWaitsAreAskedAgainAndAnswerEveryCaller() {
        withSdk { sdk, glasses ->
            // The first process gets out only its first chunk before it restarts.
            glasses.onRequest = { count, requestId ->
                if (count == 1) sendVersionInfo(requestId, "asg-1", chunks = 1)
                else sendVersionInfo(requestId, "asg-2", chunks = 2)
            }
            runBlocking {
                val poll = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestVersionInfo() }
                // The update check asks while the poll's request is still waiting.
                val check = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestVersionInfo() }
                assertEquals("A joined caller must not send a second request", 1, glasses.requestIds.size)

                Bridge.sendTypedMessage("glasses_session_changed", mapOf("previous_sid" to "asg-1", "sid" to "asg-2"))

                for (result in listOf(poll.await(), check.await())) {
                    assertEquals("303000008", result.buildNumber)
                    assertEquals("26.9.23.0", result.besFirmwareVersion)
                    assertEquals("MentraLive_20260921.0", result.mtkFirmwareVersion)
                }
                assertEquals(2, glasses.requestIds.size)
                assertEquals("The restarted glasses are asked under the same id", 1, glasses.requestIds.toSet().size)
            }
        }
    }

    private fun sendVersionInfo(requestId: String, sid: String, chunks: Int) {
        val common = mapOf<String, Any>("request_id" to requestId, "sid" to sid, "chunkCount" to 2)
        Bridge.sendVersionInfo(
            common + mapOf("chunkIndex" to 1, "final" to false, "build_number" to "303000008", "app_version" to "3.3.0"),
            "version_info_1",
        )
        if (chunks < 2) return
        Bridge.sendVersionInfo(
            common + mapOf("chunkIndex" to 2, "final" to true,
                "bes_fw_version" to "26.9.23.0", "mtk_fw_version" to "MentraLive_20260921.0"),
            "version_info_3",
        )
    }

    private fun withSdk(block: (MentraBluetoothSdk, VersionRequestGlasses) -> Unit) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Bridge.initialize(context)
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val manager = DeviceManager(initializeHardware = false)
        singleton.set(null, manager)
        val sdk = MentraBluetoothSdk.create(
            context,
            MentraBluetoothSdkConfig(analytics = BluetoothSdkAnalyticsConfig(enabled = false)),
            object : MentraBluetoothSdkListener {},
        )
        val glasses = VersionRequestGlasses(sdk)
        manager.sgc = glasses
        try {
            block(sdk, glasses)
        } finally {
            sdk.close()
            manager.cleanup()
            singleton.set(null, previous)
        }
    }

    /** Glasses that answer version requests through [onRequest]; the rest is inert. */
    private class VersionRequestGlasses(private val sdk: MentraBluetoothSdk) : SGCManager() {
        val requestIds = mutableListOf<String>()
        var onRequest: (count: Int, requestId: String) -> Unit = { _, _ -> }

        init { type = DeviceTypes.NIMO }

        override fun requestVersionInfo() {
            // Only Mentra Live carries the id on the wire, so read it from the pending request.
            val pending = MentraBluetoothSdk::class.java.getDeclaredField("pendingVersionInfo")
                .apply { isAccessible = true }.get(sdk)!!
            val requestId = pending.javaClass.getDeclaredField("requestId")
                .apply { isAccessible = true }.get(pending) as String
            requestIds += requestId
            onRequest(requestIds.size, requestId)
        }

        override val showBrightnessConfirmation = false
        override val showConnectionConfirmation = false
        override val sceneHandoffRequiresClear = false
        override fun clearDisplay() {}
        override fun clearSceneElements(elementIds: List<String>) {}
        override fun applySceneFrame(frame: SceneFrame) {}
        override fun sendTextWall(text: String) {}
        override fun disconnect() {}
        override fun cleanup() {}
        override fun setMicEnabled(enabled: Boolean) {}
        override fun sortMicRanking(list: MutableList<String>) = list
        override fun uploadPhoto(request: PhotoRequest) {}
        override fun startStream(message: MutableMap<String, Any>) {}
        override fun stopStream() {}
        override fun sendStreamKeepAlive(message: MutableMap<String, Any>) {}
        override fun startVideoRecording(requestId: String, save: Boolean, sound: Boolean) {}
        override fun stopVideoRecording(requestId: String) {}
        override fun sendButtonPhotoSettings() {}
        override fun sendButtonVideoRecordingSettings() {}
        override fun sendButtonMaxRecordingTime() {}
        override fun sendCameraFovSetting() {}
        override fun setBrightness(level: Int, autoMode: Boolean) {}
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
    }
}
