package com.mentra.acsmeeting

import java.nio.ByteBuffer

/** Replaceable later by LocalGlassesVideoSource (SoftAP / local WebRTC). */
interface VideoSource {
  fun start(whepUrl: String)
  fun updateUrl(whepUrl: String)
  fun stop()
}

fun interface VideoFrameListener {
  fun onVideoFrame(rgba: ByteBuffer, width: Int, height: Int, timestampNs: Long)
}

fun interface PcmListener {
  fun onPcm(pcm16Le: ByteArray, sampleRate: Int, channels: Int)
}
