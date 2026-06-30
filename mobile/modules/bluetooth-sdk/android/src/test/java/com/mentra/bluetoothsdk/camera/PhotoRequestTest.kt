package com.mentra.bluetoothsdk.camera

import kotlin.test.Test
import kotlin.test.assertNull

class PhotoRequestTest {
    @Test
    fun `fromMap defaults exposureTimeNs null`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "requestId" to "photo-1",
                    "size" to "medium",
                    "webhookUrl" to "https://example.com/upload",
                    "compress" to "none",
                    "sound" to true,
                )
            )

        assertNull(request.exposureTimeNs)
    }
}
