package com.mentra.acsmeeting.video

/**
 * ACS [RawVideoFrame.setTimestampInTicks] uses Windows / .NET ticks:
 * 100-nanosecond units. A frame with timestamp 0 is "no time", and a run of
 * those makes the Teams jitter buffer hold the last picture until it decides
 * the stream has moved — which looks like a random freeze.
 *
 * Prefer the stream clock when ACS is advancing it (Microsoft's sample does
 * exactly that). Otherwise convert a capture timestamp. Always emit a tick
 * strictly after [lastTicks] so two frames never share a presentation time.
 */
object AcsTimestamp {
  const val NS_PER_TICK = 100L

  fun resolve(streamTicks: Long, captureNs: Long, lastTicks: Long): Long {
    val fromStream = streamTicks > 0
    val fromCapture = captureNs > 0
    val candidate = when {
      fromStream && streamTicks > lastTicks -> streamTicks
      fromCapture -> captureNs / NS_PER_TICK
      else -> lastTicks + 1
    }
    return if (candidate <= lastTicks) lastTicks + 1 else candidate
  }
}
