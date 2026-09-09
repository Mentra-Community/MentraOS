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
      // CPU is sampled once and shared: the ladder prints it and the verdict uses
      // it to tell an encoder that cannot keep up from one being throttled.
      val percent = samplePercent()
      emit("${stats.tick()} ${ProcessCpu.label(percent, cores)}")
      emit(
        VideoRateVerdict.line(
          advertisedFps = stats.advertisedFps,
          sinkFps = stats.lastSinkFps,
          admittedFps = stats.lastSubFps,
          wireFps = stats.wireFps,
          wireBitrateBps = stats.wireBitrateBps,
          budgetBps = stats.budgetBps,
          cpuPercent = percent,
          codecName = stats.codecName,
        ),
      )
      emit(
        VideoQuality.line(
          wireWidth = stats.wireWidth,
          wireHeight = stats.wireHeight,
          wireFps = stats.wireFps,
          wireBitrateBps = stats.wireBitrateBps,
          budgetBps = stats.budgetBps,
          packetsPerSecond = stats.lastPacketsPerSecond,
          cpuPercent = percent,
          sendQuality = stats.sendQuality,
        ),
      )
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

  private fun samplePercent(): Double? {
    val now = System.currentTimeMillis()
    val cpu = elapsedCpuMs()
    val prevCpu = lastCpuMs
    val prevWall = lastWallMs
    lastCpuMs = cpu
    lastWallMs = now
    if (prevCpu < 0 || prevWall <= 0) return null
    return ProcessCpu.percent(cpu - prevCpu, now - prevWall)
  }

  companion object {
    const val INTERVAL_MS = 1000L
  }
}
