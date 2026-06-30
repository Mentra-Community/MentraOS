package com.mentra.bluetoothsdk.camera

import com.mentra.bluetoothsdk.PhotoCompression
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.PhotoSize
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PhotoRequestTest {
    @Test
    fun `constructor generates requestId when omitted`() {
        val request =
            PhotoRequest(
                size = PhotoSize.MEDIUM,
                webhookUrl = "https://example.com/upload",
                compress = PhotoCompression.NONE,
                sound = true,
            )

        assertTrue(request.requestId.startsWith("photo-"))
    }

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

    @Test
    fun `fromMap generates requestId when omitted or blank`() {
        val withoutRequestId =
            PhotoRequest.fromMap(
                mapOf(
                    "size" to "medium",
                    "webhookUrl" to "https://example.com/upload",
                    "compress" to "none",
                    "sound" to true,
                )
            )
        val blankRequestId =
            PhotoRequest.fromMap(
                mapOf(
                    "requestId" to "  ",
                    "size" to "medium",
                    "webhookUrl" to "https://example.com/upload",
                    "compress" to "none",
                    "sound" to true,
                )
            )

        assertTrue(withoutRequestId.requestId.startsWith("photo-"))
        assertTrue(blankRequestId.requestId.startsWith("photo-"))
    }

    @Test
    fun `fromMap preserves explicit requestId`() {
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

        assertEquals("photo-1", request.requestId)
    }
}
