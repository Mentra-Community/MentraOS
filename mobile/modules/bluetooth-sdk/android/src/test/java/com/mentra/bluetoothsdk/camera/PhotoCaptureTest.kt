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
        val capture = PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM, preview = true), deferred = true, glasses)
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.resume()
        capture.onPreview(PhotoPreview("data:image/jpeg;base64,AA==", 500, 375))
        capture.resume()
        assertThat(calls).containsExactly("preview")
    }

    @Test
    fun `without a preview asked for there is none`(): Unit = runBlocking {
        val capture = PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM), deferred = true, glasses)
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.resume()
        assertThat(calls).isEmpty()
        val error = runCatching { capture.preview() }.exceptionOrNull() as BluetoothSdkException
        assertThat(error.code).isEqualTo("preview_not_requested")
    }

    @Test
    fun `the full photo comes with its thumbnail, made once`(): Unit = runBlocking {
        val made = mutableListOf<String>()
        val capture =
            PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM), deferred = true, glasses) { url ->
                made += url
                PhotoThumbnail("file:///cache/photo.thumb.jpg", 512, 384, size = 30_000)
            }
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.onResponse(saved("p1"))
        val photo = capture.photo()
        assertThat(photo.thumbnail?.url).isEqualTo("file:///cache/photo.thumb.jpg")
        assertThat(photo.values["thumbnail"])
            .isEqualTo(
                mapOf(
                    "fileUri" to "file:///cache/photo.thumb.jpg",
                    "width" to 512,
                    "height" to 384,
                    "mimeType" to "image/jpeg",
                    "size" to 30_000L,
                ),
            )
        assertThat(capture.photo()).isSameAs(photo)
        assertThat(made).containsExactly("file:///cache/photo.jpg")
    }

    @Test
    fun `a photo that can't be read has no thumbnail`(): Unit = runBlocking {
        val capture = PhotoCapture(PhotoRequest(requestId = "p1", size = PhotoSize.MEDIUM), deferred = true, glasses) { null }
        capture.onStatus(PhotoStatusEvent(mapOf("requestId" to "p1", "status" to "captured")))
        capture.onResponse(saved("p1"))
        assertThat(capture.photo().thumbnail).isNull()
        assertThat(capture.photo().values).doesNotContainKey("thumbnail")
    }
}
