package com.mentra.bluetoothsdk

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.sgcs.G1PairingTest
import com.mentra.bluetoothsdk.sgcs.MentraLive
import java.nio.charset.StandardCharsets
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class VersionInfoSessionResendTest {
    @Test
    fun `request lost to an asg restart is re-sent when the new glasses session is ready`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Bridge.initialize(context)
        val manager = DeviceManager.getInstance()
        val previous = manager.sgc
        val live = MentraLive()
        manager.sgc = live
        val sdk =
            MentraBluetoothSdk.create(
                context,
                MentraBluetoothSdkConfig(analytics = BluetoothSdkAnalyticsConfig(enabled = false)),
                object : MentraBluetoothSdkListener {},
            )
        try {
            val result = async(Dispatchers.Default) { sdk.requestVersionInfo() }
            val requestId = awaitVersionRequests(live, 1).single()

            // An APK OTA restarts asg_client under the live link: the exiting process answers one
            // chunk, and the new process announces its session without having seen the request.
            Bridge.sendVersionInfo(chunk(requestId, "asg-old", 1, "303000008"), "version_info_1")
            Bridge.sendTypedMessage("wifi_protocol_session_ready", mapOf("sid" to "asg-new"))
            assertEquals(listOf(requestId, requestId), awaitVersionRequests(live, 2))
            Bridge.sendVersionInfo(chunk(requestId, "asg-new", 1, "302010070"), "version_info_1")
            Bridge.sendVersionInfo(chunk(requestId, "asg-new", 2, "302010070"), "version_info_3")

            val info = withTimeout(5_000) { result.await() }
            assertEquals("302010070", info.buildNumber)
            assertEquals("26.10.8.0", info.besFirmwareVersion)
        } finally {
            sdk.close()
            live.destroy()
            manager.sgc = previous
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun chunk(requestId: String, sid: String, index: Int, buildNumber: String): Map<String, Any> {
        val common = mapOf<String, Any>("request_id" to requestId, "sid" to sid, "chunkCount" to 2, "chunkIndex" to index)
        return common +
            if (index == 1) {
                mapOf("final" to false, "build_number" to buildNumber)
            } else {
                mapOf("final" to true, "bes_fw_version" to "26.10.8.0")
            }
    }

    private suspend fun awaitVersionRequests(live: MentraLive, count: Int): List<String> =
        withTimeout(5_000) {
            var ids = versionRequestIds(live)
            while (ids.size < count) {
                delay(10)
                ids = versionRequestIds(live)
            }
            ids
        }

    private fun versionRequestIds(live: MentraLive): List<String> {
        val queue = MentraLive::class.java.getDeclaredField("sendQueue").apply { isAccessible = true }.get(live)
        val wire =
            (queue as Iterable<*>).map { write ->
                val data = write!!.javaClass.getDeclaredField("data").apply { isAccessible = true }.get(write)
                String(data as ByteArray, StandardCharsets.UTF_8)
            }
        val requestId = Regex("""request_id\\*"\s*:\s*\\*"([0-9a-fA-F-]{36})""")
        return wire.filter { it.contains("request_version") }.mapNotNull { requestId.find(it)?.groupValues?.get(1) }
    }
}
