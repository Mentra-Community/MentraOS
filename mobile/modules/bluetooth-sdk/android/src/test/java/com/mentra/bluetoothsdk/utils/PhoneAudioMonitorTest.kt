package com.mentra.bluetoothsdk.utils

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PhoneAudioMonitorTest {
    @Test
    fun `keeps explicit playback hint while Android reports active media`() {
        assertThat(
                PhoneAudioMonitor.shouldKeepOwnAppAudioSignal(
                        signalledPlaying = true,
                        systemAudioPlaying = true,
                        nowMs = 10_000,
                        holdoffUntilMs = 1_000,
                )
            )
            .isTrue()
    }

    @Test
    fun `keeps explicit playback hint during codec transition holdoff`() {
        assertThat(
                PhoneAudioMonitor.shouldKeepOwnAppAudioSignal(
                        signalledPlaying = true,
                        systemAudioPlaying = false,
                        nowMs = 500,
                        holdoffUntilMs = 1_000,
                )
            )
            .isTrue()
    }

    @Test
    fun `expires stale playback hint when Android media is inactive`() {
        assertThat(
                PhoneAudioMonitor.shouldKeepOwnAppAudioSignal(
                        signalledPlaying = true,
                        systemAudioPlaying = false,
                        nowMs = 1_000,
                        holdoffUntilMs = 1_000,
                )
            )
            .isFalse()
    }
}
