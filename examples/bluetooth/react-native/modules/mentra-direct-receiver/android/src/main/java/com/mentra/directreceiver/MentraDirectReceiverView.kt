package com.mentra.directreceiver

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.widget.ImageView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class MentraDirectReceiverView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val imageView = ImageView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    scaleType = ImageView.ScaleType.FIT_CENTER
    setBackgroundColor(Color.BLACK)
  }

  init {
    addView(imageView)
    DirectReceiverFrameRegistry.register(this)
  }

  override fun onDetachedFromWindow() {
    DirectReceiverFrameRegistry.unregister(this)
    super.onDetachedFromWindow()
  }

  fun setFrame(bitmap: Bitmap) {
    imageView.setImageBitmap(bitmap)
  }

  fun clearFrame() {
    imageView.setImageDrawable(null)
  }
}

object DirectReceiverFrameRegistry {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val views = LinkedHashSet<MentraDirectReceiverView>()
  private var latestFrame: Bitmap? = null

  fun register(view: MentraDirectReceiverView) {
    mainHandler.post {
      views.add(view)
      latestFrame?.let(view::setFrame)
    }
  }

  fun unregister(view: MentraDirectReceiverView) {
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
