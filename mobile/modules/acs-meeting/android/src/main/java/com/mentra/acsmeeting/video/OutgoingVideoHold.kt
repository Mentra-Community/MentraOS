package com.mentra.acsmeeting.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
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

  /** Resolves true once one card or still frame has been handed to the sender. */
  fun start(kind: String, imageBytes: ByteArray?): Boolean {
    stop()
    val frame = when (kind) {
      "image" -> imageBytes?.let { decode(it) } ?: card(width(), height())
      else -> card(width(), height())
    }
    planes = frame
    running.set(true)
    val handed = AtomicBoolean(false)
    task = scheduler.scheduleAtFixedRate({
      val current = planes ?: return@scheduleAtFixedRate
      if (!running.get()) return@scheduleAtFixedRate
      if (send(current.frame())) handed.set(true)
    }, 0, 100, TimeUnit.MILLISECONDS)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
    while (!handed.get() && System.nanoTime() < deadline) {
      Thread.sleep(20)
    }
    return handed.get()
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

  private fun decode(bytes: ByteArray): HeldPlanes? {
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    return HeldPlanes(bitmap)
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
