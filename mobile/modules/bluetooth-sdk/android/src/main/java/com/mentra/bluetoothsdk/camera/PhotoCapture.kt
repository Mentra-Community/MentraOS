package com.mentra.bluetoothsdk

import android.graphics.BitmapFactory
import android.net.Uri
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One photo kept on the phone, in stages. [captured]: the camera is done and free for the next
 * one. [preview]: the glasses' at most 500 px preview. [photo]: the full photo as a file; the first
 * call asks the glasses to send it, and until then it waits on the glasses ("deferred delivery").
 * [release]: the full photo isn't needed, and the glasses delete it. Glasses without deferred
 * photos send the whole photo at once; it is then also the preview.
 */
class PhotoCapture internal constructor(
    val request: PhotoRequest,
    private val deferred: Boolean,
    private val glasses: Glasses,
) {
    internal interface Glasses {
        fun fetch(request: PhotoRequest, preview: Boolean)

        fun release(requestId: String)

        fun forget(requestId: String)
    }

    val requestId: String get() = request.requestId
    internal val createdAtMs = System.currentTimeMillis()
    private val capturedStage = CompletableDeferred<Unit>()
    private val previewStage = CompletableDeferred<PhotoPreview>()
    private val photoStage = CompletableDeferred<PhotoResponseEvent>()
    private val photoAsked = AtomicBoolean(!deferred)

    /** Resolves once the glasses wrote the photo: the camera takes the next request. */
    suspend fun captured() = await(capturedStage, CAPTURED_TIMEOUT_MS, "capture")

    suspend fun preview(): PhotoPreview = await(previewStage, STAGE_TIMEOUT_MS, "preview")

    /** The full photo; `photoUrl` is a `file://` URI in the app's cache folder, the caller's to move. */
    suspend fun photo(): PhotoResponseEvent {
        if (photoAsked.compareAndSet(false, true)) glasses.fetch(request, preview = false)
        return await(photoStage, STAGE_TIMEOUT_MS, "photo")
    }

    /** The full photo isn't needed: the glasses delete it. Stages not reached yet fail. */
    fun release() {
        glasses.forget(requestId)
        // The glasses keep the photo after sending it, so a released one goes even once fetched.
        if (deferred) glasses.release(requestId)
        fail(BluetoothSdkException("photo_released", "The photo was released."))
    }

    internal val done: Boolean
        get() = capturedStage.isCompleted && previewStage.isCompleted && photoStage.isCompleted

    internal fun onStatus(event: PhotoStatusEvent) {
        if (event.status == "captured") capturedStage.complete(Unit)
    }

    internal fun onPreview(preview: PhotoPreview) {
        previewStage.complete(preview)
    }

    internal fun onResponse(event: PhotoResponseEvent) {
        when (val response = event.response) {
            is PhotoResponse.Success -> {
                capturedStage.complete(Unit)
                if (!deferred) previewStage.complete(previewOf(response))
                photoStage.complete(event)
            }
            is PhotoResponse.Error -> {
                val error = BluetoothSdkException(response.errorCode ?: "photo_request_failed", response.errorMessage)
                when {
                    !capturedStage.isCompleted -> fail(error)
                    // Only the preview failed: the photo is still on the glasses.
                    response.errorCode == "PREVIEW_FAILED" -> previewStage.completeExceptionally(error)
                    else -> photoStage.completeExceptionally(error)
                }
            }
        }
    }

    /** The glasses are back after a reconnect or restart: ask again for what is still awaited. */
    internal fun resume() {
        if (!deferred || !capturedStage.isCompleted) return
        if (!previewStage.isCompleted) glasses.fetch(request, preview = true)
        if (photoAsked.get() && !photoStage.isCompleted) glasses.fetch(request, preview = false)
    }

    private fun fail(error: Throwable) {
        capturedStage.completeExceptionally(error)
        previewStage.completeExceptionally(error)
        photoStage.completeExceptionally(error)
    }

    private suspend fun <T> await(stage: CompletableDeferred<T>, timeoutMs: Long, name: String): T =
        withTimeoutOrNull(timeoutMs) { stage.await() }
            ?: throw BluetoothSdkException("request_timeout", "Photo $name timed out waiting for the glasses.")

    /** Older glasses send no preview: the whole photo stands in, with its pixel size. */
    private fun previewOf(response: PhotoResponse.Success): PhotoPreview {
        val url = response.photoUrl.orEmpty()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        Uri.parse(url).path?.let { BitmapFactory.decodeFile(it, bounds) }
        return PhotoPreview(url, bounds.outWidth.takeIf { it > 0 }, bounds.outHeight.takeIf { it > 0 })
    }

    private companion object {
        const val CAPTURED_TIMEOUT_MS = 45_000L
        // Capture, preview ACK and retries, then the send queue's wait behind other photos.
        const val STAGE_TIMEOUT_MS = 110_000L
    }
}
