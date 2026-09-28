package com.mentra.acsmeeting.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.BitmapFactory
import com.mentra.glassesmedia.source.I420Planes
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
  private var task: ScheduledFuture<*>? = null
  private var planes: HeldPlanes? = null

  fun isActive(): Boolean = running.get()

  /**
   * Begin the hold and report through [onResult] once one card or still frame has been handed to
   * the sender, or `false` if none lands within [HANDED_TIMEOUT_MS].
   *
   * Non-blocking: the wait runs on the hold scheduler, never on the caller's thread, so the RN
   * module thread cannot stall (and risk an ANR) waiting for ACS to accept the first frame.
   */
  fun start(kind: String, imageBytes: ByteArray?, onResult: (Boolean) -> Unit) {
    stop()
    val w = width()
    val h = height()
    val frame = when (kind) {
      "image" -> imageBytes?.let { decode(it, w, h) } ?: card(w, h)
      else -> card(w, h)
    }
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
    canvas.drawText("Taking a photo", w / 2f, h / 2f, paint)
    return HeldPlanes(bitmap)
  }

  /**
   * Decode the still and letterbox it onto a [width]x[height] frame. The frame must match the
   * negotiated size the caller passed, or [send] drops it for a dimension mismatch.
   */
  private fun decode(bytes: ByteArray, width: Int, height: Int): HeldPlanes? {
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    val w = width.coerceAtLeast(16)
    val h = height.coerceAtLeast(16)
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

  fun frame(): I420Planes {
    y.position(0)
    u.position(0)
    v.position(0)
    return I420Planes(y, width, u, chromaWidth, v, chromaWidth, width, height, System.nanoTime())
  }
}
