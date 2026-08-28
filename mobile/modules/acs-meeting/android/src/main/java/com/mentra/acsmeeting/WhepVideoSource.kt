package com.mentra.acsmeeting

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.webrtc.AudioTrack
import org.webrtc.AudioTrackSink
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Recvonly WHEP subscriber. Decoded I420 frames are converted to RGBA for ACS.
 * Remote AudioTrackSink PCM is the P4 hard gate.
 */
class CloudflareWhepSource(
  private val context: Context,
  private val videoListener: VideoFrameListener,
  private val pcmListener: PcmListener,
) : GlassesMediaSource {
  private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
  private var factory: PeerConnectionFactory? = null
  private var egl: EglBase? = null
  private var pc: PeerConnection? = null
  private var currentUrl: String? = null
  private val frames = AtomicInteger(0)
  private var lastFpsLogMs = 0L
  @Volatile private var offerPosted = false
  @Volatile private var pcmEnabled = true
  @Volatile override var state: SourceState = SourceState.IDLE
    private set
  private val audioTracks = mutableListOf<AudioTrack>()
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var pendingOfferPost: Runnable? = null

  override fun start(config: SourceConfig) {
    stop()
    currentUrl = config.url
    offerPosted = false
    state = SourceState.CONNECTING
    ensureFactory()
    val peer = factory!!.createPeerConnection(iceServers(), observer) ?: error("PeerConnection create failed")
    pc = peer
    peer.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, recvOnly())
    peer.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, recvOnly())
    peer.createOffer(
      object : SdpAdapter() {
        override fun onCreateSuccess(sdp: SessionDescription) {
          peer.setLocalDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
              // Cloudflare WHEP wants candidates in the offer. Wait for ICE
              // gathering, with a timeout so trickle-less endpoints still join.
              val runnable = Runnable { postOfferIfNeeded() }
              pendingOfferPost = runnable
              mainHandler.postDelayed(runnable, 2000)
            }
          }, sdp)
        }
      },
      MediaConstraints(),
    )
  }

  override fun restart(config: SourceConfig) {
    if (config.url == currentUrl && config.kind == SourceKind.WHEP) return
    start(config)
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled = enabled
    audioTracks.forEach { it.setEnabled(enabled) }
    Log.i(TAG, "WHEP audio track enabled=$enabled")
  }

  override fun stop() {
    currentUrl = null
    offerPosted = false
    pcmEnabled = true
    // Cancel any pending delayed offer post so a same-instance restart cannot
    // publish a stale peer's SDP before ICE finishes.
    pendingOfferPost?.let { mainHandler.removeCallbacks(it) }
    pendingOfferPost = null
    audioTracks.clear()
    state = SourceState.IDLE
    try {
      pc?.close()
    } catch (_: Exception) {
    }
    pc = null
  }

  private fun ensureFactory() {
    if (factory != null) return
    PeerConnectionFactory.initialize(
      PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
    )
    egl = EglBase.create()
    factory = PeerConnectionFactory.builder()
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
      .createPeerConnectionFactory()
  }

  @Synchronized
  private fun postOfferIfNeeded() {
    if (offerPosted) return
    val url = currentUrl ?: return
    val peer = pc ?: return
    val offer = peer.localDescription?.description ?: return
    offerPosted = true
    postOffer(url, offer, peer)
  }

  private fun postOffer(url: String, offer: String, peer: PeerConnection) {
    val request = Request.Builder()
      .url(url)
      .header("Content-Type", "application/sdp")
      .post(offer.toRequestBody("application/sdp".toMediaType()))
      .build()
    http.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
        Log.e(TAG, "WHEP POST failed", e)
        state = SourceState.FAILED
      }

      override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
        response.use {
          val answer = it.body?.string().orEmpty()
          if (!it.isSuccessful) {
            Log.e(TAG, "WHEP ${it.code}: $answer")
            state = SourceState.FAILED
            return
          }
          Log.i(TAG, "P3 WHEP ${it.code} answer bytes=${answer.length}")
          state = SourceState.LIVE
          peer.setRemoteDescription(
            SdpAdapter(),
            SessionDescription(SessionDescription.Type.ANSWER, answer),
          )
        }
      }
    })
  }

  private val observer = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
      Log.i(TAG, "ICE $state")
      if (state == PeerConnection.IceConnectionState.FAILED ||
        state == PeerConnection.IceConnectionState.DISCONNECTED
      ) {
        this@CloudflareWhepSource.state = SourceState.FAILED
      }
    }
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
      Log.i(TAG, "ICE gathering $state")
      if (state == PeerConnection.IceGatheringState.COMPLETE) postOfferIfNeeded()
    }
    override fun onIceCandidate(candidate: IceCandidate) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
    override fun onAddStream(stream: MediaStream) {
      stream.videoTracks.firstOrNull()?.addSink(videoSink)
      stream.audioTracks.firstOrNull()?.let { attachAudio(it) }
    }
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: org.webrtc.DataChannel) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out MediaStream>) {
      when (val track = receiver.track()) {
        is VideoTrack -> track.addSink(videoSink)
        is AudioTrack -> attachAudio(track)
      }
    }
    override fun onTrack(transceiver: RtpTransceiver) {
      when (val track = transceiver.receiver.track()) {
        is VideoTrack -> track.addSink(videoSink)
        is AudioTrack -> attachAudio(track)
      }
    }
  }

  private val videoSink = VideoSink { frame ->
    val i420 = frame.buffer.toI420() ?: return@VideoSink
    try {
      val rgba = i420ToRgba(i420, frame.rotatedWidth, frame.rotatedHeight)
      countFps(frame.rotatedWidth, frame.rotatedHeight)
      videoListener.onVideoFrame(rgba, frame.rotatedWidth, frame.rotatedHeight, frame.timestampNs)
    } finally {
      i420.release()
    }
  }

  private fun attachAudio(track: AudioTrack) {
    if (!audioTracks.contains(track)) audioTracks.add(track)
    track.setEnabled(pcmEnabled)
    track.addSink(audioSink)
  }

  private val audioSink = AudioTrackSink { audioData, bitsPerSample, sampleRate, numberOfChannels, numberOfFrames, _ ->
    if (!pcmEnabled || bitsPerSample != 16) return@AudioTrackSink
    val bytes = ByteArray(audioData.remaining())
    audioData.get(bytes)
    pcmListener.onPcm(bytes, sampleRate, numberOfChannels)
  }

  private fun countFps(width: Int, height: Int) {
    val n = frames.incrementAndGet()
    val now = System.currentTimeMillis()
    if (lastFpsLogMs == 0L) lastFpsLogMs = now
    if (now - lastFpsLogMs >= 1000) {
      Log.i(TAG, "P3 video ${width}x${height} fps=${n} (window=${now - lastFpsLogMs}ms)")
      frames.set(0)
      lastFpsLogMs = now
    }
  }

  private fun recvOnly() = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)

  private fun iceServers() = PeerConnection.RTCConfiguration(
    listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()),
  )

  companion object {
    private const val TAG = "ACS-SPIKE"

    fun i420ToRgba(i420: VideoFrame.I420Buffer, width: Int, height: Int): ByteBuffer {
      val out = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder())
      val yPlane = i420.dataY
      val uPlane = i420.dataU
      val vPlane = i420.dataV
      val yStride = i420.strideY
      val uStride = i420.strideU
      val vStride = i420.strideV
      for (row in 0 until height) {
        val yOff = row * yStride
        val uvRow = row / 2
        for (col in 0 until width) {
          val y = yPlane.get(yOff + col).toInt() and 0xff
          val u = (uPlane.get(uvRow * uStride + col / 2).toInt() and 0xff) - 128
          val v = (vPlane.get(uvRow * vStride + col / 2).toInt() and 0xff) - 128
          val r = (y + 1.370705 * v).toInt().coerceIn(0, 255)
          val g = (y - 0.337633 * u - 0.698001 * v).toInt().coerceIn(0, 255)
          val b = (y + 1.732446 * u).toInt().coerceIn(0, 255)
          out.put(r.toByte())
          out.put(g.toByte())
          out.put(b.toByte())
          out.put(0xFF.toByte())
        }
      }
      out.rewind()
      return out
    }
  }
}

typealias WhepVideoSource = CloudflareWhepSource

private open class SdpAdapter : SdpObserver {
  override fun onCreateSuccess(sdp: SessionDescription) {}
  override fun onSetSuccess() {}
  override fun onCreateFailure(error: String) {}
  override fun onSetFailure(error: String) {}
}
