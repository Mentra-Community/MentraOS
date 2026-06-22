package com.mentra.bluetoothsdk.camera

import com.mentra.bluetoothsdk.PhotoRequest
import org.junit.Assert.assertNull
import org.junit.Test

class PhotoRequestTest {
    @Test
    fun `fromMap defaults exposureTimeNs null`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "requestId" to "photo-1",
                    "appId" to "com.test.app",
                    "size" to "medium",
                    "webhookUrl" to "https://example.com/upload",
                    "compress" to "none",
                    "sound" to true,
                )
            )

        assertNull(request.exposureTimeNs)
    }
}
