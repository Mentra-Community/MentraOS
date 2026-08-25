package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class HeldDeviceMatcherTest {
    private val savedLive =
        Device(
            model = DeviceModel.MENTRA_LIVE,
            name = "Mentra Live 4X2A",
            address = "AA:BB:CC:DD:EE:FF",
        )

    @Test
    fun `matches Mentra Live advertised name prefixes`() {
        for (name in listOf("Xy_A", "XyBLE_1234", "MENTRA_LIVE_BLE_9", "MENTRA_LIVE_BT_9", "mentra_live_abc")) {
            assertThat(
                HeldDeviceMatcher.matches(
                    model = DeviceModel.MENTRA_LIVE,
                    defaultDevice = null,
                    candidateName = name,
                    candidateAddress = null,
                ),
            ).describedAs(name).isTrue()
        }
    }

    @Test
    fun `matches Mentra Nex advertised name prefixes`() {
        for (name in listOf("Nex1-77", "MENTRA_DISPLAY_02")) {
            assertThat(
                HeldDeviceMatcher.matches(
                    model = DeviceModel.MENTRA_NEX,
                    defaultDevice = null,
                    candidateName = name,
                    candidateAddress = null,
                ),
            ).describedAs(name).isTrue()
        }
    }

    @Test
    fun `name prefixes are scoped to the scanned model`() {
        // A held Mentra Live can never explain an empty Nex (or G1) scan.
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.MENTRA_NEX,
                defaultDevice = null,
                candidateName = "XyBLE_1234",
                candidateAddress = null,
            ),
        ).isFalse()
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.G1,
                defaultDevice = null,
                candidateName = "MENTRA_LIVE_BT_9",
                candidateAddress = null,
            ),
        ).isFalse()
    }

    @Test
    fun `rejects non-Mentra peripherals`() {
        for (name in listOf("Even G1_22_L_", "Pixel Watch", "MX Master 3S")) {
            assertThat(
                HeldDeviceMatcher.matches(
                    model = DeviceModel.MENTRA_LIVE,
                    defaultDevice = savedLive,
                    candidateName = name,
                    candidateAddress = "11:22:33:44:55:66",
                ),
            ).describedAs(name).isFalse()
        }
    }

    @Test
    fun `matches the saved default by exact name`() {
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.MENTRA_LIVE,
                defaultDevice = savedLive,
                candidateName = "Mentra Live 4X2A",
                candidateAddress = null,
            ),
        ).isTrue()
    }

    @Test
    fun `matches the saved default by address ignoring case`() {
        // Stored addresses can arrive lowercase from the JS side.
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.MENTRA_LIVE,
                defaultDevice = savedLive.copy(address = "aa:bb:cc:dd:ee:ff"),
                candidateName = null,
                candidateAddress = "AA:BB:CC:DD:EE:FF",
            ),
        ).isTrue()
    }

    @Test
    fun `saved default only counts for its own model`() {
        // Scanning for G1 while the saved default is a Mentra Live.
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.G1,
                defaultDevice = savedLive,
                candidateName = "Mentra Live 4X2A",
                candidateAddress = "AA:BB:CC:DD:EE:FF",
            ),
        ).isFalse()
    }

    @Test
    fun `models without a branded name rely on the saved default`() {
        val savedG1 = Device(model = DeviceModel.G1, name = "Even G1_22_L_", address = null)
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.G1,
                defaultDevice = savedG1,
                candidateName = "Even G1_22_L_",
                candidateAddress = null,
            ),
        ).isTrue()
    }

    @Test
    fun `simulated model never matches`() {
        assertThat(
            HeldDeviceMatcher.matches(
                model = DeviceModel.SIMULATED,
                defaultDevice = savedLive,
                candidateName = "Mentra Live 4X2A",
                candidateAddress = "AA:BB:CC:DD:EE:FF",
            ),
        ).isFalse()
    }
}
