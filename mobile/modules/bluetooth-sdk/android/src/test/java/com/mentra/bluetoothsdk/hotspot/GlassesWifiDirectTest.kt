package com.mentra.bluetoothsdk.hotspot

import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Test

class GlassesWifiDirectTest {
    @Test
    fun anAppAskingRightAfterConnectingGetsTheGlassesAnswer() {
        GlassesWifiDirect.version = null // asked for version_info, no answer yet
        thread { Thread.sleep(100); GlassesWifiDirect.version = 1 }
        assertEquals(1, GlassesWifiDirect.awaitVersion(5_000))
    }

    @Test
    fun glassesThatNeverAnswerHaveNoWifiDirect() {
        GlassesWifiDirect.version = null
        assertEquals(0, GlassesWifiDirect.awaitVersion(50))
    }
}
