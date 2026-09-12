package com.mentra.glassesmedia.telemetry

import android.util.Log
import kotlin.math.abs

/**
 * Measures how far glasses audio leads glasses video at ACS ingest.
 *
 * SoftAP video and BLE LC3 do not share a capture clock, so first-frame arrival is startup
 * skew, not lip-sync. This probe watches both paths on [System.nanoTime]: a clap in frame is a
 * loud PCM transient and a luma jump. Their difference is [lastAudioLeadMs] — the number the
 * delay line can cancel. ACS/Teams jitter after ingest is still a receiver recording.
 *
 * Audio is sampled at uplink ingest, in front of any configured delay, so the lead is the raw
 * path offset even when the host already holds PCM for alignment.
 */
class AvSyncProbe(
  private val clock: () -> Long = System::nanoTime,
  private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
  private val lock = Any()
  private var lastMeanAbs = -1
  private var lastLumaY = -1
  private var pendingAudioNs = 0L
  private var pendingVideoNs = 0L
  private var pendingMeanAbs = -1
  private var pendingLumaY = -1
  private var cooldownUntilNs = 0L
  @Volatile private var clapCount = 0
  @Volatile private var lastAudioLeadMs: Int? = null
  @Volatile private var publishedMeanAbs = -1
  @Volatile private var publishedLumaY = -1

  fun onAudio(pcm: ByteArray, nowNs: Long = clock()) {
    onAudioLevel(meanAbs16(pcm), nowNs)
  }

  fun onAudioLevel(meanAbs: Int, nowNs: Long = clock()) {
    publishedMeanAbs = meanAbs
    synchronized(lock) {
      val prev = lastMeanAbs
      lastMeanAbs = meanAbs
      expire(nowNs)
      if (nowNs < cooldownUntilNs) return
      if (!isAudioTransient(prev, meanAbs)) return
      if (pendingVideoNs > 0L) {
        emit(pendingVideoNs - nowNs, meanAbs, pendingLumaY, nowNs)
        return
      }
      pendingAudioNs = nowNs
      pendingMeanAbs = meanAbs
    }
  }

  fun onVideoLuma(y: Int, nowNs: Long = clock()) {
    publishedLumaY = y
    synchronized(lock) {
      val prev = lastLumaY
      lastLumaY = y
      expire(nowNs)
      if (nowNs < cooldownUntilNs) return
      if (!isVideoTransient(prev, y)) return
      if (pendingAudioNs > 0L) {
        emit(nowNs - pendingAudioNs, pendingMeanAbs, y, nowNs)
        return
      }
      pendingVideoNs = nowNs
      pendingLumaY = y
    }
  }

  fun lastAudioLeadMs(): Int? = lastAudioLeadMs

  fun clapCount(): Int = clapCount

  fun tick(videoE2eP50: String, videoAgeP50: String): String {
    val lead = lastAudioLeadMs
    return "AVSYNC live videoE2eP50=$videoE2eP50 " +
      "videoAgeP50=$videoAgeP50 " +
      "lastClapLeadMs=${lead?.toString() ?: "na"} clapN=$clapCount " +
      "meanAbs=$publishedMeanAbs lumaY=$publishedLumaY"
  }

  fun reset() {
    synchronized(lock) {
      lastMeanAbs = -1
      lastLumaY = -1
      pendingAudioNs = 0L
      pendingVideoNs = 0L
      pendingMeanAbs = -1
      pendingLumaY = -1
      cooldownUntilNs = 0L
      clapCount = 0
      lastAudioLeadMs = null
      publishedMeanAbs = -1
      publishedLumaY = -1
    }
  }

  private fun emit(leadNs: Long, meanAbs: Int, lumaY: Int, nowNs: Long) {
    val leadMs = (leadNs / 1_000_000L).toInt()
    lastAudioLeadMs = leadMs
    clapCount += 1
    pendingAudioNs = 0L
    pendingVideoNs = 0L
    pendingMeanAbs = -1
    pendingLumaY = -1
    cooldownUntilNs = nowNs + COOLDOWN_NS
    log("AVSYNC clap audioLeadMs=$leadMs meanAbs=$meanAbs lumaY=$lumaY clapN=$clapCount")
  }

  private fun expire(nowNs: Long) {
    if (pendingAudioNs > 0L && nowNs - pendingAudioNs > MATCH_WINDOW_NS) {
      pendingAudioNs = 0L
      pendingMeanAbs = -1
    }
    if (pendingVideoNs > 0L && nowNs - pendingVideoNs > MATCH_WINDOW_NS) {
      pendingVideoNs = 0L
      pendingLumaY = -1
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    internal const val AUDIO_CLAP = 2_000
    internal const val AUDIO_RISE = 1_500
    internal const val VIDEO_JUMP = 10
    internal const val MATCH_WINDOW_NS = 500L * 1_000_000L
    internal const val COOLDOWN_NS = 750L * 1_000_000L

    fun meanAbs16(pcm: ByteArray): Int {
      var acc = 0L
      var n = 0
      var i = 0
      while (i + 1 < pcm.size) {
        val s = (pcm[i].toInt() and 0xff) or (pcm[i + 1].toInt() shl 8)
        val signed = if (s >= 0x8000) s - 0x10000 else s
        acc += abs(signed)
        n++
        i += 2
      }
      return if (n == 0) 0 else (acc / n).toInt()
    }

    internal fun isAudioTransient(previous: Int, current: Int): Boolean {
      if (previous < 0 || current < AUDIO_CLAP) return false
      return current - previous >= AUDIO_RISE
    }

    internal fun isVideoTransient(previous: Int, current: Int): Boolean {
      if (previous < 0) return false
      return abs(current - previous) >= VIDEO_JUMP
    }
  }
}
