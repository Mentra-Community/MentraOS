package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.sgcs.MentraLive
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiAdbPeerIntentTest {
    private val mac = "AA:BB:CC:DD:EE:01"
    @Test fun onlyFullCurrentSessionIdentityCanAdmitACommand() {
        assertTrue(MentraLive.wifiAdbPeerMatches(mac.lowercase(), 7L to mac, 7L, true))
        assertFalse(MentraLive.wifiAdbPeerMatches(mac, 7L to "AA:BB:CC:DD:EE:02", 7L, true))
        assertFalse(MentraLive.wifiAdbPeerMatches(mac, 6L to mac, 7L, true))
        assertFalse(MentraLive.wifiAdbPeerMatches(mac, null, 7L, true))
        assertFalse(MentraLive.wifiAdbPeerMatches(mac, 7L to mac, 7L, false))
        assertFalse(MentraLive.wifiAdbPeerMatches("EE:01", 7L to mac, 7L, true))
        assertFalse(MentraLive.wifiAdbPeerMatches(" " + mac, 7L to mac, 7L, true))
    }
}
