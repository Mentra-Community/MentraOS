package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.assertj.core.api.Assertions.assertThat
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BluetoothSdkUpdateCheckTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun result(status: String, latest: String? = "3.2.1", minimum: String? = null) =
        BluetoothSdkUpdateCheckResult(status, "latest", latest, minimum)

    @Test
    fun `parses the Core response, treating null and blank versions as unknown`() {
        val parsed =
            BluetoothSdkUpdateCheckResult.parse(
                """{"status":"update_available","channel":"dev","latestVersion":"3.3.0-dev.821","minimumSupportedVersion":null}""",
            )!!
        assertThat(parsed).isEqualTo(BluetoothSdkUpdateCheckResult("update_available", "dev", "3.3.0-dev.821", null))
        assertThat(BluetoothSdkUpdateCheckResult.parse("""{"status":"current","latestVersion":""}""")!!.latestVersion).isNull()
        assertThat(BluetoothSdkUpdateCheckResult.parse("<html>502</html>")).isNull()
    }

    @Test
    fun `the banner names the installed and latest versions and the surface's update command`() {
        val reactNative = BluetoothSdkUpdateNotice.banner("3.1.0", result("update_available"), "react_native")!!
        assertThat(reactNative)
            .contains("MENTRA BLUETOOTH SDK UPDATE AVAILABLE")
            .contains("Installed: 3.1.0")
            .contains("Latest: 3.2.1")
            .contains("bun add @mentra/bluetooth-sdk@3.2.1")
            .doesNotContain("NO LONGER SUPPORTED")
        assertThat(BluetoothSdkUpdateNotice.banner("3.1.0", result("update_available"), "android")!!)
            .contains("com.mentraglass:bluetooth-sdk:3.2.1")
        assertThat(BluetoothSdkUpdateNotice.banner("3.1.0", result("update_available"), "ios")!!)
            .contains("MentraBluetoothSDK Swift package at 3.2.1")
    }

    @Test
    fun `an unsupported version gets the stronger banner`() {
        val banner = BluetoothSdkUpdateNotice.banner("3.0.5", result("unsupported", minimum = "3.1.0"), "android")!!
        assertThat(banner)
            .contains("MENTRA BLUETOOTH SDK 3.0.5 IS NO LONGER SUPPORTED")
            .contains("known issues")
    }

    @Test
    fun `no banner when current, unknown, or no latest version to point at`() {
        assertThat(BluetoothSdkUpdateNotice.banner("3.2.1", result("current"), "android")).isNull()
        assertThat(BluetoothSdkUpdateNotice.banner("3.2.1", result("unknown", latest = null), "android")).isNull()
        assertThat(BluetoothSdkUpdateNotice.banner("3.2.1", result("update_available", latest = null), "android")).isNull()
    }

    @Test
    fun `the request identifies the install, app and SDK`() {
        val body = BluetoothSdkUpdateCheck(context, "react_native", sdkVersion = "3.1.0", transport = { null }) { _, _ -> }.requestBody()
        assertThat(body.getString("install_id")).isEqualTo(BluetoothSdkInstallId.get(context)).startsWith("mentra-bt-sdk-")
        assertThat(body.getString("app_identifier")).isEqualTo(context.packageName)
        assertThat(body.getString("sdk_version")).isEqualTo("3.1.0")
        assertThat(body.getString("sdk_platform")).isEqualTo("android")
        assertThat(body.getString("sdk_surface")).isEqualTo("react_native")
        assertThat(body.has("app_build_type")).isTrue()
    }

    @Test
    fun `an out-of-date SDK prints the banner once at start and stops on close`() {
        val notices = mutableListOf<String>()
        var sentBody: String? = null
        val check =
            BluetoothSdkUpdateCheck(
                context,
                "android",
                sdkVersion = "3.1.0",
                transport = { body ->
                    sentBody = body
                    """{"status":"update_available","channel":"latest","latestVersion":"3.2.1","minimumSupportedVersion":null}"""
                },
            ) { banner, _ -> notices += banner }
        check.start()
        BluetoothSdkUpdateCheck.awaitIdle()
        assertThat(notices).hasSize(1)
        assertThat(notices.single()).contains("Latest: 3.2.1")
        assertThat(JSONObject(sentBody!!).getString("sdk_version")).isEqualTo("3.1.0")
        check.stop()
    }

    @Test
    fun `failures and unknown versions are silent`() {
        val notices = mutableListOf<String>()
        BluetoothSdkUpdateCheck(context, "android", sdkVersion = "3.1.0", transport = { null }) { banner, _ -> notices += banner }.start()
        BluetoothSdkUpdateCheck(context, "android", sdkVersion = "3.1.0", transport = { throw IllegalStateException("offline") }) { banner, _ -> notices += banner }.start()
        var called = false
        BluetoothSdkUpdateCheck(context, "android", sdkVersion = "unknown", transport = { called = true; null }) { banner, _ -> notices += banner }.start()
        BluetoothSdkUpdateCheck.awaitIdle()
        assertThat(notices).isEmpty()
        assertThat(called).isFalse()
    }

    @Test
    fun `a check stopped before the response arrives prints nothing`() {
        val notices = mutableListOf<String>()
        lateinit var check: BluetoothSdkUpdateCheck
        check =
            BluetoothSdkUpdateCheck(
                context,
                "android",
                sdkVersion = "3.1.0",
                transport = {
                    check.stop()
                    """{"status":"update_available","latestVersion":"3.2.1"}"""
                },
            ) { banner, _ -> notices += banner }
        check.start()
        BluetoothSdkUpdateCheck.awaitIdle()
        assertThat(notices).isEmpty()
    }
}
