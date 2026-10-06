package com.mentra.acsmeeting.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.BitmapFactory
import android.media.ExifInterface
import com.mentra.glassesmedia.source.I420Planes
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Replaces glasses frames on the outgoing Teams tile.
 *
 * A gap, or a timestamp of zero, makes Teams hold a random freeze. This pump
 * keeps handing the existing frame sender a full-frame card or still, and the
 * sender's own clock keeps the timestamps moving.
 */
class OutgoingVideoHold(
  private val send: (I420Planes) -> Boolean,
  private val width: () -> Int,
  private val height: () -> Int,
) {
  private val running = AtomicBoolean(false)
  private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "acs-photo-hold").apply { isDaemon = true }
  }
  @Volatile private var task: ScheduledFuture<*>? = null
  @Volatile private var planes: HeldPlanes? = null

  fun isActive(): Boolean = running.get()

  /**
   * Begin the hold and report through [onResult] once one card or still frame has been handed to
   * the sender, or `false` if none lands within [HANDED_TIMEOUT_MS].
   *
   * Non-blocking: the wait runs on the hold scheduler, never on the caller's thread, so the RN
   * module thread cannot stall (and risk an ANR) waiting for ACS to accept the first frame.
   */
  fun start(kind: String, imageBytes: ByteArray?, onResult: (Boolean) -> Unit) {
    // Build the replacement before touching the current hold. Card -> still must not open a gap:
    // while `running` is false the session forwards live glasses frames, and right after a photo
    // those are the reopened camera's unexposed first frames.
    val w = width()
    val h = height()
    val frame = when (kind) {
      "image" -> imageBytes?.let { decode(it, w, h) } ?: card(w, h)
      else -> card(w, h)
    }
    task?.cancel(false)
    task = null
    planes = frame
    running.set(true)
    val settled = AtomicBoolean(false)
    task = scheduler.scheduleAtFixedRate({
      val current = planes ?: return@scheduleAtFixedRate
      if (!running.get()) return@scheduleAtFixedRate
      if (send(current.frame()) && settled.compareAndSet(false, true)) onResult(true)
    }, 0, 100, TimeUnit.MILLISECONDS)
    // Fail the hold if no frame lands in the window, without blocking the caller.
    scheduler.schedule({
      if (settled.compareAndSet(false, true)) onResult(false)
    }, HANDED_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  fun stop() {
    running.set(false)
    task?.cancel(false)
    task = null
    planes = null
  }

  private fun card(width: Int, height: Int): HeldPlanes {
    val w = width.coerceAtLeast(16)
    val h = height.coerceAtLeast(16)
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.rgb(18, 18, 22))
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textAlign = Paint.Align.CENTER
      textSize = (h / 12f).coerceAtLeast(24f)
    }
    canvas.drawText("Taking a photo...", w / 2f, h / 2f, paint)
    return HeldPlanes(bitmap)
  }

  /**
   * Decode the still and letterbox it onto a [width]x[height] frame. The frame must match the
   * negotiated size the caller passed, or [send] drops it for a dimension mismatch.
   */
  private fun decode(bytes: ByteArray, width: Int, height: Int): HeldPlanes? {
    val w = width.coerceAtLeast(16)
    val h = height.coerceAtLeast(16)
    val decoded = decodeUpright(bytes, w, h) ?: return null
    val canvasBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(canvasBitmap)
    canvas.drawColor(Color.rgb(18, 18, 22))
    val scale = minOf(w.toFloat() / decoded.width, h.toFloat() / decoded.height)
    val drawWidth = decoded.width * scale
    val drawHeight = decoded.height * scale
    val dst = RectF(
      (w - drawWidth) / 2f,
      (h - drawHeight) / 2f,
      (w + drawWidth) / 2f,
      (h + drawHeight) / 2f,
    )
    canvas.drawBitmap(decoded, null, dst, Paint(Paint.FILTER_BITMAP_FLAG))
    decoded.recycle()
    return HeldPlanes(canvasBitmap)
  }

  /**
   * Decode at no more than twice the frame size, with the EXIF orientation applied. Glasses JPEGs
   * carry their rotation in EXIF rather than in the pixels, and a full 12 MP decode would allocate
   * ~48 MB for a frame that is shown at 1280x720.
   */
  private fun decodeUpright(bytes: ByteArray, frameWidth: Int, frameHeight: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
    val target = maxOf(frameWidth, frameHeight) * 2
    var sample = 1
    while (longEdge / (sample * 2) >= target) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply { inSampleSize = sample },
    ) ?: return null
    val orientation = runCatching {
      ExifInterface(ByteArrayInputStream(bytes))
        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
      else -> return decoded
    }
    val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    if (upright !== decoded) decoded.recycle()
    return upright
  }

  companion object {
    private const val HANDED_TIMEOUT_MS = 2_000L
  }
}

private class HeldPlanes(bitmap: Bitmap) {
  private val y: ByteBuffer
  private val u: ByteBuffer
  private val v: ByteBuffer
  private val width = bitmap.width
  private val height = bitmap.height
  private val chromaWidth = (width + 1) / 2
  private val chromaHeight = (height + 1) / 2

  init {
    val pixels = IntArray(width * height)
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    bitmap.recycle()
    y = ByteBuffer.allocateDirect(width * height)
    u = ByteBuffer.allocateDirect(chromaWidth * chromaHeight)
    v = ByteBuffer.allocateDirect(chromaWidth * chromaHeight)
    for (row in 0 until height) {
      for (col in 0 until width) {
        val color = pixels[row * width + col]
        val r = (color shr 16) and 0xff
        val g = (color shr 8) and 0xff
        val b = color and 0xff
        y.put(row * width + col, (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte())
        if (row % 2 == 0 && col % 2 == 0) {
          val index = (row / 2) * chromaWidth + (col / 2)
          u.put(index, (((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).toByte())
          v.put(index, (((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).toByte())
        }
      }
    }
  }

  /**
   * Fresh views per frame: the preview reads a frame on its own worker after the sender has
   * moved on, so frames must not share buffer positions. The pixels never change while held, so
   * retaining one past the callback is safe and needs no bookkeeping.
   */
  fun frame(): I420Planes = I420Planes(
    y.duplicate().apply { position(0) },
    width,
    u.duplicate().apply { position(0) },
    chromaWidth,
    v.duplicate().apply { position(0) },
    chromaWidth,
    width,
    height,
    System.nanoTime(),
    retain = NO_OP,
    release = NO_OP,
  )

  private companion object {
    val NO_OP: () -> Unit = {}
  }
}
