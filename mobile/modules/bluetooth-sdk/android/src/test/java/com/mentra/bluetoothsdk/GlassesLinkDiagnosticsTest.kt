package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.sgcs.GlassesLinkDiagnostics
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GlassesLinkDiagnosticsTest {

    @Before
    fun resetSession() {
        GlassesLinkDiagnostics.onSessionStart(nowMs = 0L)
    }

    @Test
    fun `summary separates a fading link from an abrupt drop`() {
        // Walking out of range: RSSI decays, then the glasses go quiet before GATT notices.
        GlassesLinkDiagnostics.recordRssi(-62, nowMs = 1_000L)
        GlassesLinkDiagnostics.recordRssi(-78, nowMs = 2_000L)
        GlassesLinkDiagnostics.recordRssi(-92, nowMs = 3_000L)
        GlassesLinkDiagnostics.recordInbound(nowMs = 3_200L)
        GlassesLinkDiagnostics.recordMicPacket(nowMs = 3_400L)

        val summary =
                GlassesLinkDiagnostics.summary(
                        reason = "gatt_error",
                        status = 8,
                        streamActive = true,
                        nowMs = 12_000L
                )

        assertTrue(summary.startsWith("LINK_DEATH "))
        assertTrue(summary.contains("reason=gatt_error"))
        assertTrue(summary.contains("status=8"))
        assertTrue(summary.contains("sessionMs=12000"))
        assertTrue(summary.contains("msSinceInbound=8800"))
        assertTrue(summary.contains("msSinceMicPacket=8600"))
        assertTrue(summary.contains("lastRssi=-92"))
        assertTrue(summary.contains("minRssi=-92"))
        assertTrue(summary.contains("rssiTrend=-62,-78,-92"))
        assertTrue(summary.contains("streamActive=true"))
    }

    @Test
    fun `summary marks never-seen signals rather than reporting a bogus age`() {
        val summary = GlassesLinkDiagnostics.summary(reason = "gatt_disconnected", nowMs = 5_000L)

        assertTrue(summary.contains("msSinceInbound=-1"))
        assertTrue(summary.contains("msSinceMicPacket=-1"))
        assertTrue(summary.contains("lastRssi=-1"))
        assertTrue(summary.contains("rssiTrend=none"))
        assertTrue(!summary.contains("status="))
        assertTrue(!summary.contains("streamActive="))
    }

    @Test
    fun `rssi history is bounded and keeps the newest samples`() {
        repeat(30) { i -> GlassesLinkDiagnostics.recordRssi(-40 - i, nowMs = i.toLong()) }

        val summary = GlassesLinkDiagnostics.summary(reason = "gatt_error", nowMs = 100L)

        assertTrue(summary.contains("lastRssi=-69"))
        assertTrue(summary.contains("minRssi=-69"))
        assertTrue(summary.contains("rssiTrend=-58,-59,-60,-61,-62,-63,-64,-65,-66,-67,-68,-69"))
    }

    @Test
    fun `a new session forgets the previous link`() {
        GlassesLinkDiagnostics.recordRssi(-91, nowMs = 1_000L)
        GlassesLinkDiagnostics.recordInbound(nowMs = 1_000L)

        GlassesLinkDiagnostics.onSessionStart(nowMs = 2_000L)
        val summary = GlassesLinkDiagnostics.summary(reason = "gatt_error", nowMs = 2_500L)

        assertTrue(summary.contains("sessionMs=500"))
        assertTrue(summary.contains("rssiTrend=none"))
        assertTrue(summary.contains("msSinceInbound=-1"))
    }
}
