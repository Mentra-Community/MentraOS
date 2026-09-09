package com.mentra.acsmeeting.audio

import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs

/** Downmix/resample PCM16 to 48 kHz mono ~20 ms blocks for ACS raw outgoing audio. */
class PcmBridge(
  private val dumpDir: File?,
  private val dumpWav: Boolean,
) {
  private var dump: ByteArrayOutputStream? = if (dumpWav) ByteArrayOutputStream() else null
  private var dumpRate = 0
  private var dumpChannels = 0
  private var dumped = false
  private val outgoing = ByteArrayOutputStream()
  private val resampler = PcmResampler(TARGET_RATE)
  private var lastRmsLogMs = 0L

  fun ingest(pcm16Le: ByteArray, sampleRate: Int, channels: Int): List<ByteArray> {
    if (dump != null && !dumped) {
      dump!!.write(pcm16Le)
      dumpRate = sampleRate
      dumpChannels = channels
      val needed = 30 * sampleRate * channels * 2
      if (dump!!.size() >= needed) finishDump()
    }
    logLevel(pcm16Le, sampleRate, channels)
    // Stateful: filter history and fractional phase carry across WebRTC's
    // 10 ms callbacks, so there is no seam every 480 samples.
    val mono = resampler.process(pcm16Le, sampleRate, channels)
    outgoing.write(mono)
    val frameBytes = TARGET_RATE * 2 / 50 // 20 ms
    val frames = mutableListOf<ByteArray>()
    val buf = outgoing.toByteArray()
    var offset = 0
    while (buf.size - offset >= frameBytes) {
      frames.add(buf.copyOfRange(offset, offset + frameBytes))
      offset += frameBytes
    }
    outgoing.reset()
    if (offset < buf.size) outgoing.write(buf, offset, buf.size - offset)
    return frames
  }

  @Synchronized
  fun finishDump() {
    if (dumped) return
    val data = dump?.toByteArray() ?: return
    dumped = true
    dump = null
    val dir = dumpDir ?: return
    val file = File(dir, "acs-whep-p4.wav")
    file.writeBytes(wav(data, dumpRate, dumpChannels))
    Log.i(TAG, "P4 wrote ${file.absolutePath} bytes=${data.size} rate=$dumpRate ch=$dumpChannels")
  }

  private fun logLevel(pcm: ByteArray, sampleRate: Int, channels: Int) {
    val now = System.currentTimeMillis()
    if (now - lastRmsLogMs < 1000) return
    lastRmsLogMs = now
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
    val mean = if (n == 0) 0 else acc / n
    Log.i(TAG, "P4 pcm rate=$sampleRate ch=$channels meanAbs=$mean bytes=${pcm.size}")
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    const val TARGET_RATE = 48_000

    /** One-shot convenience (fresh filter state). Streams must use a [PcmResampler] instance. */
    fun toMono(pcm16Le: ByteArray, sampleRate: Int, channels: Int): ByteArray =
      PcmResampler(TARGET_RATE).process(pcm16Le, sampleRate, channels)

    fun wav(pcm: ByteArray, sampleRate: Int, channels: Int): ByteArray {
      val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      header.put("RIFF".toByteArray())
      header.putInt(36 + pcm.size)
      header.put("WAVE".toByteArray())
      header.put("fmt ".toByteArray())
      header.putInt(16)
      header.putShort(1)
      header.putShort(channels.toShort())
      header.putInt(sampleRate)
      header.putInt(sampleRate * channels * 2)
      header.putShort((channels * 2).toShort())
      header.putShort(16)
      header.put("data".toByteArray())
      header.putInt(pcm.size)
      return header.array() + pcm
    }

    fun encodeBase64(pcm: ByteArray): String = Base64.encodeToString(pcm, Base64.NO_WRAP)
  }
}
