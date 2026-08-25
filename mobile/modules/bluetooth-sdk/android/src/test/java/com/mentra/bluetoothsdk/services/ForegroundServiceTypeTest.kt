package com.mentra.bluetoothsdk.services

import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundServiceTypeTest {
    @Test
    fun `bootstrap starts as dataSync`() {
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            ForegroundService.bootstrapServiceType(),
        )
    }

    @Test
    fun `preferred types remove dataSync once connectedDevice is available`() {
        val serviceType =
            ForegroundService.preferredServiceType(
                hasConnectedDeviceAccess = true,
                hasMicrophoneAccess = false,
                hasLocationAccess = false,
                includeMediaPlayback = false,
            )

        assertTrue(
            serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE != 0,
        )
        assertEquals(
            0,
            serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    @Test
    fun `preferred types retain dataSync only when no better type is available`() {
        val serviceType =
            ForegroundService.preferredServiceType(
                hasConnectedDeviceAccess = false,
                hasMicrophoneAccess = false,
                hasLocationAccess = false,
                includeMediaPlayback = false,
            )

        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            serviceType,
        )
    }

    @Test
    fun `production mask never carries dataSync with media playback`() {
        val serviceType =
            ForegroundService.preferredServiceType(
                hasConnectedDeviceAccess = true,
                hasMicrophoneAccess = true,
                hasLocationAccess = true,
            )

        assertEquals(
            0,
            serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
        assertTrue(
            serviceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK != 0,
        )
    }
}
