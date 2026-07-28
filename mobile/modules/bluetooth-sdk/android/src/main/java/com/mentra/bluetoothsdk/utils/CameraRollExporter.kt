package com.mentra.bluetoothsdk.utils

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.app.ActivityCompat
import java.io.IOException

/**
 * Exports phone-delivered photos to the OS camera roll via MediaStore, with no
 * dependency on the host app's media modules. Failures throw with a short reason;
 * callers report it as `cameraRollError` on an otherwise successful delivery.
 */
object CameraRollExporter {
    private const val ALBUM_DIR = "MentraLive"

    @JvmStatic
    @Throws(IOException::class)
    fun exportJpeg(context: Context, jpegData: ByteArray, displayName: String) {
        // MediaStore inserts owned by the app need no permission from Android 10 (Q) on;
        // before that WRITE_EXTERNAL_STORAGE is required and may be denied at runtime.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            ActivityCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                PackageManager.PERMISSION_GRANTED
        ) {
            throw IOException("storage permission not granted")
        }

        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, displayName)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/" + ALBUM_DIR)
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val resolver = context.contentResolver
        val collection =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }
        val uri = resolver.insert(collection, values)
            ?: throw IOException("MediaStore insert failed")
        try {
            resolver.openOutputStream(uri)?.use { it.write(jpegData) }
                ?: throw IOException("MediaStore stream unavailable")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
        } catch (e: Exception) {
            // Don't leave a pending/empty MediaStore row behind on a failed write.
            resolver.delete(uri, null, null)
            throw if (e is IOException) e else IOException(e.message ?: e.javaClass.simpleName, e)
        }
    }
}
