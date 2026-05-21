package com.mentra.videostreamreceiver

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class MentraVideoStreamReceiverView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val imageView = ImageView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    scaleType = ImageView.ScaleType.FIT_CENTER
    setBackgroundColor(Color.BLACK)
  }

  init {
    addView(imageView)
    VideoStreamReceiverFrameRegistry.register(this)
  }

  override fun onDetachedFromWindow() {
    VideoStreamReceiverFrameRegistry.unregister(this)
    super.onDetachedFromWindow()
  }

  fun setFrame(bitmap: Bitmap) {
    imageView.setImageBitmap(bitmap)
  }

  fun clearFrame() {
    imageView.setImageDrawable(null)
  }
}

object VideoStreamReceiverFrameRegistry {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val views = LinkedHashSet<MentraVideoStreamReceiverView>()
  private var latestFrame: Bitmap? = null

  fun register(view: MentraVideoStreamReceiverView) {
    mainHandler.post {
      views.add(view)
      latestFrame?.let(view::setFrame)
    }
  }

  fun unregister(view: MentraVideoStreamReceiverView) {
    mainHandler.post {
      views.remove(view)
    }
  }

  fun update(bitmap: Bitmap) {
    mainHandler.post {
      latestFrame = bitmap
      for (view in views) {
        view.setFrame(bitmap)
      }
    }
  }

  fun clear() {
    mainHandler.post {
      latestFrame = null
      for (view in views) {
        view.clearFrame()
      }
    }
  }
}
