package com.mentra.acsmeeting.source

import java.nio.ByteBuffer

/** Replaceable later by LocalGlassesVideoSource (SoftAP / local WebRTC). */
interface VideoSource {
  fun start(whepUrl: String)
  fun updateUrl(whepUrl: String)
  fun stop()
}

fun interface VideoFrameListener {
  /** [i420] is packed tight I420: Y, then U, then V. */
  fun onVideoFrame(i420: ByteBuffer, width: Int, height: Int, timestampNs: Long)
}

fun interface PcmListener {
  fun onPcm(pcm16Le: ByteArray, sampleRate: Int, channels: Int)
}
