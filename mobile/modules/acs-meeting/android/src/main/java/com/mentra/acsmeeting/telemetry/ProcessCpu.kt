package com.mentra.acsmeeting.telemetry

/**
 * Process CPU percent the same way `top` reports it: CPU-ms / wall-ms * 100.
 * Can exceed 100 on multi-core. Pure so JVM tests stay cheap.
 */
object ProcessCpu {
  fun percent(cpuDeltaMs: Long, wallDeltaMs: Long): Double =
    cpuDeltaMs * 100.0 / wallDeltaMs.coerceAtLeast(1L)

  fun label(percent: Double?, cores: Int): String {
    val proc = percent?.let { PipelineStats.format(it) } ?: "na"
    return "cpu{proc=$proc cores=$cores}"
  }
}
