package com.mentra.acsmeeting.source

import android.content.Context
import android.util.Log
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.video.FrameGeometry
import com.mentra.acsmeeting.video.I420Packer
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicLong

/**
 * Recvonly WHEP subscriber. Decoded I420 planes are handed to ACS (no RGB
 * convert, no pack-then-split). Scale uses libyuv cropAndScale in buffer
 * coordinates. Remote AudioTrackSink PCM is the P4 hard gate.
 */
class CloudflareWhepSource(
  private val context: Context,
  private val videoListener: VideoFrameListener,
  private val pcmListener: PcmListener,
  private val stats: PipelineStats = PipelineStats(),
) : GlassesMediaSource {
  private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
  private var factory: PeerConnectionFactory? = null
  private var egl: EglBase? = null
  private var pc: PeerConnection? = null
  private var currentUrl: String? = null
  @Volatile private var offerPosted = false
  @Volatile private var pcmEnabled = true
  @Volatile override var state: SourceState = SourceState.IDLE
    private set
  // attachAudio runs on the WebRTC signaling thread, setPcmDeliveryEnabled on the RN
  // bridge thread, stop() on the session thread: a plain list threw CME on mute toggles.
  private val audioTracks = CopyOnWriteArrayList<AudioTrack>()
  private val videoIds = TrackRegistry()
  private val audioIds = TrackRegistry()
  @Volatile private var attachedVideo: VideoTrack? = null
  private val targetSize = AtomicReference<TargetSize?>(null)
  private val rotationLogged = AtomicBoolean(false)
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var pendingOfferPost: Runnable? = null
  private var lastDecodedFrames = -1L
  private var lastDecodedAtMs = 0L
  private var lastReceivedFrames = -1L
  private val statsPoll = object : Runnable {
    override fun run() {
      pollDecodedStats()
      mainHandler.postDelayed(this, STATS_POLL_MS)
    }
  }

  override fun start(config: SourceConfig) {
    stop()
    currentUrl = config.url
    offerPosted = false
    state = SourceState.CONNECTING
    // Timer-driven, not sink-driven: a frame stall must still be sampled, or dec
    // freezes at a stale value during exactly the freezes we are chasing.
    mainHandler.removeCallbacks(statsPoll)
    mainHandler.postDelayed(statsPoll, STATS_POLL_MS)
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
    // Reuse the live subscriber only when the URL is unchanged AND the peer is
    // still healthy. After ICE DISCONNECTED/FAILED (e.g. a Wi-Fi drop that
    // reuses the same Cloudflare WHEP URL) we must rebuild, or glasses video and
    // mic never recover.
    if (config.url == currentUrl && config.kind == SourceKind.WHEP && state != SourceState.FAILED) return
    start(config)
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled = enabled
    audioTracks.forEach { it.setEnabled(enabled) }
    Log.i(TAG, "WHEP audio track enabled=$enabled")
  }

  override fun setTargetSize(size: TargetSize?) {
    targetSize.set(size)
  }

  override fun stop() {
    currentUrl = null
    offerPosted = false
    pcmEnabled = true
    pendingOfferPost?.let { mainHandler.removeCallbacks(it) }
    pendingOfferPost = null
    mainHandler.removeCallbacks(statsPoll)
    try {
      attachedVideo?.removeSink(videoSink)
    } catch (_: Exception) {
    }
    attachedVideo = null
    videoIds.reset()
    audioIds.reset()
    audioTracks.clear()
    state = SourceState.IDLE
    lastDecodedFrames = -1L
    lastDecodedAtMs = 0L
    lastReceivedFrames = -1L
    rotationLogged.set(false)
    // close() stops media; dispose() is what frees the native peer. Without it every
    // WHEP restart leaks a PeerConnection. dispose() also blocks until observer and
    // sink callbacks quiesce, so it must run after removeSink and before dest is reused.
    val peer = pc
    pc = null
    try {
      peer?.close()
      peer?.dispose()
    } catch (error: Exception) {
      Log.w(TAG, "WHEP peer dispose failed", error)
    }
  }

  private fun ensureFactory() {
    if (factory != null) return
    PeerConnectionFactory.initialize(
      PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
    )
    val mode = AcsInvestigation.decoderMode
    val shared = if (mode == DecoderMode.TEXTURE) {
      EglBase.create().also { egl = it }.eglBaseContext
    } else {
      null
    }
    factory = PeerConnectionFactory.builder()
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(shared, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(shared))
      .createPeerConnectionFactory()
    Log.i(TAG, "P3 factory decoderMode=$mode egl=${shared != null}")
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
    // Unified Plan + recv-only transceivers: onTrack is the only attach path.
    // onAddStream / onAddTrack still fire for the same track and used to triple-addSink.
    override fun onAddStream(stream: MediaStream) {}
    override fun onRemoveStream(stream: MediaStream) {}
    override fun onDataChannel(channel: org.webrtc.DataChannel) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out MediaStream>) {}
    override fun onTrack(transceiver: RtpTransceiver) {
      when (val track = transceiver.receiver.track()) {
        is VideoTrack -> attachVideo(track)
        is AudioTrack -> attachAudio(track)
      }
    }
  }

  private fun attachVideo(track: VideoTrack) {
    val id = track.id()
    if (!videoIds.claim(id)) {
      stats.onDup()
      Log.i(TAG, "P3 attach kind=video id=$id attached=${videoIds.size()} skipped=${videoIds.skipped()}")
      return
    }
    attachedVideo = track
    track.addSink(videoSink)
    Log.i(TAG, "P3 attach kind=video id=$id attached=${videoIds.size()} skipped=${videoIds.skipped()}")
  }

  private val videoSink = VideoSink { frame ->
    val sinkStart = System.nanoTime()
    stats.onSink()
    stats.recordGap()
    val buffer = frame.buffer
    stats.onFrameBuffer(classifyBuffer(buffer))
    val geometry = FrameGeometry.packSize(buffer.width, buffer.height, frame.rotation)
    if (geometry.rotationNonZero) {
      stats.onRotation()
      if (rotationLogged.compareAndSet(false, true)) {
        Log.w(
          TAG,
          "P3 rotation=${frame.rotation} using buffer ${geometry.width}x${geometry.height} " +
            "(rotatedWidth=${frame.rotatedWidth}x${frame.rotatedHeight} would overrun I420 planes)",
        )
      }
    }
    val target = targetSize.get()
    var scaled: VideoFrame.Buffer? = null
    val source = if (target != null && (target.width != geometry.width || target.height != geometry.height)) {
      val scaleStart = System.nanoTime()
      scaled = buffer.cropAndScale(0, 0, geometry.width, geometry.height, target.width, target.height)
      stats.scale.record(System.nanoTime() - scaleStart)
      scaled
    } else {
      buffer
    }
    val i420Start = System.nanoTime()
    val i420 = source.toI420()
    stats.toI420.record(System.nanoTime() - i420Start)
    if (i420 == null) {
      stats.onDropNullI420()
      scaled?.release()
      stats.sinkCb.record(System.nanoTime() - sinkStart)
      return@VideoSink
    }
    try {
      val w = i420.width
      val h = i420.height
      stats.onStrides(i420.strideY, i420.strideU, i420.strideV, w)
      stats.setSize(w, h)
      videoListener.onVideoFrame(
        I420Planes(
          y = i420.dataY,
          strideY = i420.strideY,
          u = i420.dataU,
          strideU = i420.strideU,
          v = i420.dataV,
          strideV = i420.strideV,
          width = w,
          height = h,
          timestampNs = frame.timestampNs,
          retain = { i420.retain() },
          release = { i420.release() },
        ),
      )
    } finally {
      i420.release()
      scaled?.release()
      stats.sinkCb.record(System.nanoTime() - sinkStart)
    }
  }

  private fun classifyBuffer(buffer: VideoFrame.Buffer): String = when (buffer) {
    is VideoFrame.TextureBuffer -> "tex"
    is VideoFrame.I420Buffer -> "i420"
    else -> "other"
  }

  private fun attachAudio(track: AudioTrack) {
    val id = track.id()
    if (!audioIds.claim(id)) {
      stats.onDup()
      Log.i(TAG, "P3 attach kind=audio id=$id attached=${audioIds.size()} skipped=${audioIds.skipped()}")
      return
    }
    audioTracks.add(track)
    track.setEnabled(pcmEnabled)
    track.addSink(audioSink)
    Log.i(TAG, "P3 attach kind=audio id=$id attached=${audioIds.size()} skipped=${audioIds.skipped()}")
  }

  private val audioSink = AudioTrackSink { audioData, bitsPerSample, sampleRate, numberOfChannels, numberOfFrames, _ ->
    if (!pcmEnabled || bitsPerSample != 16) return@AudioTrackSink
    val bytes = ByteArray(audioData.remaining())
    audioData.get(bytes)
    pcmListener.onPcm(bytes, sampleRate, numberOfChannels)
  }

  private fun pollDecodedStats() {
    val peer = pc ?: return
    peer.getStats { report ->
      for (statsReport in report.statsMap.values) {
        if (statsReport.type != "inbound-rtp") continue
        if (statsReport.members["kind"]?.toString() != "video") continue
        val members = statsReport.members
        val decoded = (members["framesDecoded"] as? Number)?.toLong() ?: continue
        val received = (members["framesReceived"] as? Number)?.toLong() ?: -1L
        val now = System.currentTimeMillis()
        if (lastDecodedFrames >= 0 && lastDecodedAtMs > 0) {
          val dt = now - lastDecodedAtMs
          if (dt > 0) {
            stats.decodedFps = (decoded - lastDecodedFrames) * 1000.0 / dt
            if (received >= 0 && lastReceivedFrames >= 0) {
              stats.recvFps = (received - lastReceivedFrames) * 1000.0 / dt
            }
          }
        }
        lastDecodedFrames = decoded
        lastReceivedFrames = received
        lastDecodedAtMs = now
        // Receive-side disposition. Separates "the network never delivered it"
        // (packetsLost/nack/pli, recv < 15) from "we got it and stalled"
        // (recv ~15 but dropped/freeze climbing).
        stats.setRecvHealth(
          PipelineStats.RecvHealth(
            assembled = (members["framesAssembledFromMultiplePackets"] as? Number)?.toLong() ?: -1L,
            dropped = (members["framesDropped"] as? Number)?.toLong() ?: -1L,
            packetsLost = (members["packetsLost"] as? Number)?.toLong() ?: -1L,
            nack = (members["nackCount"] as? Number)?.toLong() ?: -1L,
            pli = (members["pliCount"] as? Number)?.toLong() ?: -1L,
            freezes = (members["freezeCount"] as? Number)?.toLong() ?: -1L,
            freezeSec = (members["totalFreezesDuration"] as? Number)?.toDouble() ?: -1.0,
            jitter = (members["jitter"] as? Number)?.toDouble() ?: -1.0,
            decodeSec = (members["totalDecodeTime"] as? Number)?.toDouble() ?: -1.0,
            jitterBufferSec = (members["jitterBufferDelay"] as? Number)?.toDouble() ?: -1.0,
            jitterBufferEmits = (members["jitterBufferEmittedCount"] as? Number)?.toLong() ?: -1L,
            decImpl = members["decoderImplementation"]?.toString().orEmpty(),
          ),
        )
        return@getStats
      }
    }
  }

  private fun recvOnly() = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)

  private fun iceServers() = PeerConnection.RTCConfiguration(
    listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()),
  )

  companion object {
    private const val TAG = "ACS-SPIKE"
    private const val STATS_POLL_MS = 1000L

    fun i420PackedSize(width: Int, height: Int) = I420Packer.packedSize(width, height)

    fun packI420(
      dataY: ByteBuffer,
      strideY: Int,
      dataU: ByteBuffer,
      strideU: Int,
      dataV: ByteBuffer,
      strideV: Int,
      width: Int,
      height: Int,
      dest: ByteBuffer,
    ) = I420Packer.pack(dataY, strideY, dataU, strideU, dataV, strideV, width, height, dest)

    fun percentileMs(samplesNs: LongArray, quantile: Double) = I420Packer.percentileMs(samplesNs, quantile)
  }
}

typealias WhepVideoSource = CloudflareWhepSource

private open class SdpAdapter : SdpObserver {
  override fun onCreateSuccess(sdp: SessionDescription) {}
  override fun onSetSuccess() {}
  override fun onCreateFailure(error: String) {}
  override fun onSetFailure(error: String) {}
}
