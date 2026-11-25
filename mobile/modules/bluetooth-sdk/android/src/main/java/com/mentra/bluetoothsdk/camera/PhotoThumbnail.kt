package com.mentra.bluetoothsdk

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.util.Log
import java.io.File
import java.net.URI
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A small copy of a full photo, made on the phone: a JPEG at most [PhotoThumbnails.MAX_SIDE] px on
 * its long side, upright (EXIF orientation applied), next to the photo in the app's cache folder.
 * Like the photo, it is the caller's to move or delete.
 */
data class PhotoThumbnail(
    /** A `file://` URI. */
    val url: String,
    val width: Int,
    val height: Int,
    val mimeType: String = "image/jpeg",
    /** The file's size in bytes. */
    val size: Long,
) {
    val values: Map<String, Any>
        get() = mapOf("fileUri" to url, "width" to width, "height" to height, "mimeType" to mimeType, "size" to size)
}

/** Makes [PhotoThumbnail]s without decoding the full photo. */
object PhotoThumbnails {
    private const val TAG = "PhotoThumbnails"
    const val MAX_SIDE = 512
    const val JPEG_QUALITY = 80

    /** The thumbnail's size for a photo of [width]×[height]: the long side at most [maxSide], never upscaled. */
    fun targetSize(width: Int, height: Int, maxSide: Int = MAX_SIDE): Pair<Int, Int> {
        val long = max(width, height)
        if (long <= maxSide) return width to height
        val scale = maxSide.toDouble() / long
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /** The thumbnail's file for the photo at [photoPath]: beside it, with `.thumb.jpg` in place of its extension. */
    fun fileFor(photoPath: String): File {
        val photo = File(photoPath)
        return File(photo.parentFile, "${photo.nameWithoutExtension}.thumb.jpg")
    }

    /**
     * The thumbnail of the photo at [photoUrl] (a `file://` URI or a path), or null when it isn't a
     * readable image. ImageDecoder decodes at the target size (sampled, not the full photo) and
     * applies the EXIF orientation.
     */
    fun make(photoUrl: String): PhotoThumbnail? {
        val path = (if (photoUrl.startsWith("file:")) runCatching { URI(photoUrl).path }.getOrNull() else photoUrl) ?: return null
        val photo = File(path)
        if (!photo.isFile) return null
        val out = fileFor(path)
        return try {
            val bitmap =
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(photo)) { decoder, info, _ ->
                    val (w, h) = targetSize(info.size.width, info.size.height)
                    decoder.setTargetSize(w, h)
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                }
            try {
                out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
                PhotoThumbnail("file://${out.absolutePath}", bitmap.width, bitmap.height, size = out.length())
            } finally {
                bitmap.recycle()
            }
        } catch (e: Exception) {
            Log.w(TAG, "No thumbnail for $path: ${e.message}")
            out.delete()
            null
        }
    }
}
