package com.mentra.acsmeeting.telemetry

import android.os.Handler
import android.os.Looper
import android.os.Process

/** Timer-driven 1 Hz emit so a stall prints sink=0 instead of going silent. */
class PipelineTicker(
  private val stats: PipelineStats,
  looper: Looper = Looper.getMainLooper(),
  private val elapsedCpuMs: () -> Long = { Process.getElapsedCpuTime() },
  private val cores: Int = Runtime.getRuntime().availableProcessors(),
  private val emit: (String) -> Unit,
) {
  private val handler = Handler(looper)
  private var lastCpuMs = -1L
  private var lastWallMs = 0L
  private val tick = object : Runnable {
    override fun run() {
      emit("${stats.tick()} ${cpuLabel()}")
      handler.postDelayed(this, INTERVAL_MS)
    }
  }

  fun start() {
    lastCpuMs = -1L
    lastWallMs = 0L
    handler.removeCallbacks(tick)
    handler.post(tick)
  }

  fun stop() {
    handler.removeCallbacks(tick)
  }

  private fun cpuLabel(): String {
    val now = System.currentTimeMillis()
    val cpu = elapsedCpuMs()
    val prevCpu = lastCpuMs
    val prevWall = lastWallMs
    lastCpuMs = cpu
    lastWallMs = now
    val percent = if (prevCpu < 0 || prevWall <= 0) null
    else ProcessCpu.percent(cpu - prevCpu, now - prevWall)
    return ProcessCpu.label(percent, cores)
  }

  companion object {
    const val INTERVAL_MS = 1000L
  }
}
