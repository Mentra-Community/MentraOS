package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test

class PhotoCaptureTest {
    private val calls = mutableListOf<String>()
    private val glasses =
        object : PhotoCapture.Glasses {
            override fun fetch(request: PhotoRequest, preview: Boolean) {
                calls += if (preview) "preview" else "fetch"
            }

            override fun release(requestId: String) {
                calls += "release"
            }

            override fun forget(requestId: String) {
                calls += "forget"
            }
        }

    private fun saved(requestId: String) =
        PhotoResponseEvent(
            mapOf(
                "requestId" to requestId,
                "state" to "success",
                "photoUrl" to "file:///cache/photo.jpg",
                "timestamp" to 1L,
            ),
        )

    @Test
    fun `a fetched photo is still deleted from the glasses on release`(): Unit = runBlocking {
        val capture = PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM), deferred = true, glasses)
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.onResponse(saved("p1"))
        assertThat(capture.photo().requestId).isEqualTo("p1")
        capture.release()
        assertThat(calls).containsExactly("fetch", "forget", "release")
    }

    @Test
    fun `after a reconnect only what is still awaited is asked again`() {
        val capture = PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM), deferred = true, glasses)
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.resume()
        capture.onPreview(PhotoPreview("data:image/jpeg;base64,AA==", 500, 375))
        capture.resume()
        assertThat(calls).containsExactly("preview")
    }
}
