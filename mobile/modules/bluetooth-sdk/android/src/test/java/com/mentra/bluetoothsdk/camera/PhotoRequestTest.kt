package com.mentra.bluetoothsdk.camera

import com.mentra.bluetoothsdk.PhotoCaptureDefaults
import com.mentra.bluetoothsdk.PhotoCompression
import com.mentra.bluetoothsdk.PhotoMode
import com.mentra.bluetoothsdk.PhotoRequest
import com.mentra.bluetoothsdk.PhotoSize
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

class PhotoRequestTest {
    @Test
    fun `compression has four exact wire values and defaults to none`() {
        assertThat(PhotoCompression.values().map { it.value }).containsExactly("none", "low", "medium", "high")
        for (compression in PhotoCompression.values()) {
            assertThat(PhotoRequest.fromMap(mapOf("compress" to compression.value)).compress).isEqualTo(compression)
        }
        assertThat(PhotoRequest(size = PhotoSize.MEDIUM, webhookUrl = "https://example.com/upload", sound = true).compress).isEqualTo(PhotoCompression.NONE)
        assertThat(PhotoRequest.fromMap(emptyMap()).compress).isEqualTo(PhotoCompression.NONE)
        for (invalid in listOf("heavy", "", "HIGH", 1, false, null)) {
            assertThatThrownBy { PhotoRequest.fromMap(mapOf("compress" to invalid)) }
                .isInstanceOf(IllegalArgumentException::class.java)
            assertThatThrownBy { PhotoCaptureDefaults.fromMap(mapOf("compress" to invalid)) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThat(PhotoCaptureDefaults.fromMap(emptyMap()).compress).isNull()
        for (compression in PhotoCompression.values()) {
            assertThat(PhotoCaptureDefaults.fromMap(mapOf("compress" to compression.value)).compress).isEqualTo(compression)
        }
        // Nullable non-compression fields still follow the existing omission convention.
        assertThat(PhotoRequest.fromMap(mapOf("authToken" to null)).compress).isEqualTo(PhotoCompression.NONE)
    }

    @Test
    fun `thumbnail is opt in and survives request routing copies`() {
        val fields = mapOf("size" to "medium", "webhookUrl" to "https://example.com/upload")
        assertThat(PhotoRequest.fromMap(fields).presendThumbnail).isFalse()
        assertThat(PhotoRequest.fromMap(fields + ("presend_thumbnail" to false)).presendThumbnail).isFalse()
        val request = PhotoRequest.fromMap(fields + ("presend_thumbnail" to true))
        assertThat(request.copy(requestId = "routed").presendThumbnail).isTrue()
        assertThat(request.transferMethod).isEqualTo("auto")
    }
    @Test
    fun `constructor generates requestId when omitted`() {
        val request =
            PhotoRequest(
                size = PhotoSize.MEDIUM,
                webhookUrl = "https://example.com/upload",
                compress = PhotoCompression.NONE,
                sound = true,
            )

        assertThat(request.requestId).startsWith("photo-")
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

        assertThat(request.exposureTimeNs).isNull()
        assertThat(request.mode).isEqualTo(PhotoMode.PHOTO)
        assertThat(request.transferMethod).isEqualTo("auto")
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

        assertThat(withoutRequestId.requestId).startsWith("photo-")
        assertThat(blankRequestId.requestId).startsWith("photo-")
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

        assertThat(request.requestId).isEqualTo("photo-1")
    }

    @Test
    fun `fromMap preserves text mode`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "size" to "medium",
                    "mode" to "text",
                    "webhookUrl" to "https://example.com/upload",
                )
            )

        assertThat(request.mode).isEqualTo(PhotoMode.TEXT)
    }

    @Test
    fun `fromMap preserves forced BLE transfer`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "size" to "medium",
                    "transferMethod" to "ble",
                    "webhookUrl" to "https://example.com/upload",
                )
            )

        assertThat(request.transferMethod).isEqualTo("ble")
    }

    @Test
    fun `fromMap preserves direct transfer without BLE fallback`() {
        val request =
            PhotoRequest.fromMap(
                mapOf(
                    "size" to "medium",
                    "transferMethod" to "direct",
                    "webhookUrl" to "https://example.com/upload",
                )
            )

        assertThat(request.transferMethod).isEqualTo("direct")
    }

    @Test
    fun `fromMap rejects an unknown transfer method`() {
        assertThatThrownBy {
            PhotoRequest.fromMap(
                mapOf(
                    "size" to "medium",
                    "transferMethod" to "wifi",
                    "webhookUrl" to "https://example.com/upload",
                )
            )
        }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessage("Invalid transferMethod \"wifi\". Expected auto, direct, or ble.")
    }
}
