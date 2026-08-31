package com.mentra.acsmeeting.telemetry

import android.os.Handler
import android.os.Looper

/** Timer-driven 1 Hz emit so a stall prints sink=0 instead of going silent. */
class PipelineTicker(
  private val stats: PipelineStats,
  looper: Looper = Looper.getMainLooper(),
  private val emit: (String) -> Unit,
) {
  private val handler = Handler(looper)
  private val tick = object : Runnable {
    override fun run() {
      emit(stats.tick())
      handler.postDelayed(this, INTERVAL_MS)
    }
  }

  fun start() {
    handler.removeCallbacks(tick)
    handler.post(tick)
  }

  fun stop() {
    handler.removeCallbacks(tick)
  }

  companion object {
    const val INTERVAL_MS = 1000L
  }
}
