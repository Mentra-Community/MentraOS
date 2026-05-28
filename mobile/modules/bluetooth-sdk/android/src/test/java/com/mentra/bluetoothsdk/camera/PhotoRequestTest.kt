package com.mentra.bluetoothsdk.camera

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhotoRequestTest {
    @Test
    fun `fromMap defaults includeImu false`() {
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

        assertFalse(request.includeImu)
    }

    @Test
    fun `fromMap parses includeImu true`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "requestId" to "photo-1",
                    "appId" to "com.test.app",
                    "size" to "medium",
                    "webhookUrl" to "https://example.com/upload",
                    "compress" to "none",
                    "sound" to true,
                    "includeImu" to true,
                )
            )

        assertTrue(request.includeImu)
    }
}
