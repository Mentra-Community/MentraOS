package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class BluetoothSdkAnalyticsHostTest {
    @Test
    fun `maps known store installers and treats a missing installer as sideload`() {
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor("com.android.vending")).isEqualTo("play_store")
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor("com.amazon.venezia")).isEqualTo("amazon_appstore")
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor("com.sec.android.app.samsungapps")).isEqualTo("galaxy_store")
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor("com.example.thirdparty.store")).isEqualTo("other_store")
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor(null)).isEqualTo("sideload")
        assertThat(BluetoothSdkAnalyticsHost.installSourceFor("  ")).isEqualTo("sideload")
    }

    @Test
    fun `normalizes the host environment and rejects values that cannot be filtered on`() {
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment(" Prod ")).isEqualTo("prod")
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment("staging-eu_1")).isEqualTo("staging-eu_1")
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment(null)).isNull()
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment("")).isNull()
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment("-leading")).isNull()
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment("has space")).isNull()
        assertThat(BluetoothSdkAnalyticsHost.normalizedEnvironment("a".repeat(33))).isNull()
    }

    @Test
    fun `serializes only the facts that are known`() {
        val full =
            BluetoothSdkAnalyticsHostProperties(
                appVersion = "3.2.0",
                appBuild = "53356754",
                buildType = "release",
                installSource = "play_store",
                installerPackage = "com.android.vending",
                environment = "prod",
            ).toMap()
        assertThat(full)
            .containsEntry("app_version", "3.2.0")
            .containsEntry("app_build", "53356754")
            .containsEntry("app_build_type", "release")
            .containsEntry("app_install_source", "play_store")
            .containsEntry("app_installer_package", "com.android.vending")
            .containsEntry("app_environment", "prod")

        val sparse =
            BluetoothSdkAnalyticsHostProperties(
                appVersion = null,
                appBuild = null,
                buildType = "debug",
                installSource = "sideload",
                installerPackage = null,
                environment = null,
            ).toMap()
        assertThat(sparse).containsOnlyKeys("app_build_type", "app_install_source")
    }
}
