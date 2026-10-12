package com.mentra.crust.preview

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import java.io.File
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** Copies the displayed miniapp pixels without invoking WebView's software renderer. */
object PixelCopyPreview {
  @OptIn(ExperimentalCoroutinesApi::class)
  suspend fun capture(activity: Activity, viewTag: Int): String =
    withContext(Dispatchers.Main.immediate) {
      check(!activity.isFinishing && !activity.isDestroyed) { "Screenshot activity is unavailable" }
      val window = activity.window
      val decor = window.decorView
      val view = decor.findViewById<View>(viewTag)
        ?: error("Screenshot view $viewTag is unavailable")
      check(view.isAttachedToWindow && view.isLaidOut && view.width > 0 && view.height > 0) {
        "Screenshot view is not ready"
      }

      val location = IntArray(2)
      view.getLocationInWindow(location)
      val bounds = Rect(location[0], location[1], location[0] + view.width, location[1] + view.height)
      check(Rect(0, 0, decor.width, decor.height).contains(bounds)) {
        "Screenshot view must be fully inside the window"
      }

      val bitmap = Bitmap.createBitmap(bounds.width(), bounds.height(), Bitmap.Config.ARGB_8888)
      val captured = suspendCancellableCoroutine<Bitmap> { continuation ->
        try {
          PixelCopy.request(window, bounds, bitmap, { result ->
            if (result == PixelCopy.SUCCESS) {
              // A cancelled request still owns its bitmap until PixelCopy finishes.
              continuation.resume(bitmap) { bitmap.recycle() }
            } else {
              bitmap.recycle()
              continuation.resumeWithException(IllegalStateException("PixelCopy failed: $result"))
            }
          }, Handler(Looper.getMainLooper()))
        } catch (error: Exception) {
          bitmap.recycle()
          continuation.resumeWithException(error)
        }
      }

      try {
        withContext(Dispatchers.IO) {
          val file = File.createTempFile("miniapp-preview-", ".jpg", activity.cacheDir)
          try {
            file.outputStream().use { output ->
              check(captured.compress(Bitmap.CompressFormat.JPEG, 50, output)) {
                "Unable to encode miniapp screenshot"
              }
            }
            Uri.fromFile(file).toString()
          } catch (error: Exception) {
            file.delete()
            throw error
          }
        }
      } finally {
        captured.recycle()
      }
    }
}
