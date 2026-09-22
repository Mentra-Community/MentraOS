package com.mentra.acsmeeting.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import android.util.Log

/**
 * Phone-mic uplink for ACS virtual outgoing. Uses [AudioRecord] MIC at 48 kHz
 * mono PCM16 and never touches [android.media.AudioManager] mode — ACS
 * communication mode stays off so A2DP playback remains on the glasses.
 */
class PhoneMicCapturer(
  private val onPcm: (ByteArray, Int, Int) -> Unit,
) {
  @Volatile private var record: AudioRecord? = null
  private var thread: Thread? = null

  @Synchronized
  fun setEnabled(enabled: Boolean) {
    if (enabled) start() else stop()
  }

  @SuppressLint("MissingPermission")
  private fun start() {
    if (record != null) return
    val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
    if (min == AudioRecord.ERROR || min == AudioRecord.ERROR_BAD_VALUE) {
      Log.w(TAG, "PhoneMicCapturer: bad min buffer $min")
      return
    }
    val bufferSize = maxOf(min, FRAME_BYTES * 4)
    val rec = try {
      AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.MIC)
        .setAudioFormat(
          AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(CHANNEL)
            .setEncoding(ENCODING)
            .build(),
        )
        .setBufferSizeInBytes(bufferSize)
        .build()
    } catch (error: Exception) {
      Log.w(TAG, "PhoneMicCapturer: create failed", error)
      return
    }
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      Log.w(TAG, "PhoneMicCapturer: AudioRecord failed to initialize")
      return
    }
    try {
      rec.startRecording()
    } catch (error: Exception) {
      rec.release()
      Log.w(TAG, "PhoneMicCapturer: startRecording failed", error)
      return
    }
    if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      rec.release()
      Log.w(TAG, "PhoneMicCapturer: did not enter RECORDING")
      return
    }
    record = rec
    thread = Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
      val buf = ByteArray(FRAME_BYTES)
      while (true) {
        val current = record ?: break
        val n = try {
          current.read(buf, 0, buf.size)
        } catch (_: Exception) {
          break
        }
        if (n <= 0) {
          if (n < 0) break
          continue
        }
        val copy = if (n == buf.size) buf.copyOf() else buf.copyOf(n)
        onPcm(copy, SAMPLE_RATE, CHANNELS)
      }
    }, "acs-phone-mic").also { it.start() }
    Log.i(TAG, "PhoneMicCapturer started 48kHz mono PCM16")
  }

  @Synchronized
  fun stop() {
    val rec = record ?: return
    record = null
    thread = null
    try {
      rec.stop()
    } catch (_: Exception) {
    }
    try {
      rec.release()
    } catch (_: Exception) {
    }
    Log.i(TAG, "PhoneMicCapturer stopped")
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    const val SAMPLE_RATE = 48_000
    const val CHANNELS = 1
    private const val FRAME_MS = 20
    private const val FRAME_BYTES = SAMPLE_RATE * CHANNELS * 2 * FRAME_MS / 1000
    private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
  }
}
