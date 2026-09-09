package com.mentra.acsmeeting.source

import android.content.Context
import android.media.AudioAttributes
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
import org.webrtc.audio.JavaAudioDeviceModule
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
  // Fail closed: the audio policy turns delivery on once the ACS virtual
  // stream is live. Survives restart() so a WHEP rebuild cannot silently
  // re-open the uplink (or the local playout) against the current decision.
  @Volatile private var pcmEnabled = false
  @Volatile override var state: SourceState = SourceState.IDLE
    private set
  @Volatile private var stateListener: SourceStateListener? = null
  // Every generation of the peer gets its own id so a callback from a disposed
  // PeerConnection (ICE FAILED racing a rebuild) cannot mark the new one failed.
  @Volatile private var generation = 0
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
  // LIVE means "ACS is being handed frames", not "the WHEP endpoint answered".
  private val firstFrame = FirstFrameGate()
  @Volatile private var firstFrameDeadline: Runnable? = null
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
    val gen = ++generation
    transition(SourceState.CONNECTING, "start")
    // Timer-driven, not sink-driven: a frame stall must still be sampled, or dec
    // freezes at a stale value during exactly the freezes we are chasing.
    mainHandler.removeCallbacks(statsPoll)
    mainHandler.postDelayed(statsPoll, STATS_POLL_MS)
    ensureFactory()
    val peer = factory!!.createPeerConnection(iceServers(), observerFor(gen)) ?: run {
      transition(SourceState.FAILED, "peer_create_failed")
      error("PeerConnection create failed")
    }
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
    // Reuse the existing subscriber only when the URL is unchanged AND the peer is
    // still healthy. After ICE DISCONNECTED/FAILED (e.g. a Wi-Fi drop that
    // reuses the same Cloudflare WHEP URL) we must rebuild, or glasses video and
    // mic never recover. See canReuseSource for why CONNECTING is reusable.
    if (canReuseSource(currentUrl, state, config)) return
    start(config)
  }

  override fun forceRestart() {
    val url = currentUrl ?: return
    Log.i(TAG, "WHEP forced rebuild state=$state")
    start(SourceConfig(url))
  }

  override fun setStateListener(listener: SourceStateListener?) {
    stateListener = listener
  }

  private fun transition(next: SourceState, reason: String) {
    val previous = state
    state = next
    if (previous == next) return
    Log.i(TAG, "WHEP source $previous -> $next ($reason)")
    try {
      stateListener?.onSourceState(next, reason)
    } catch (error: Exception) {
      Log.w(TAG, "source state listener threw", error)
    }
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    pcmEnabled = enabled
    Log.i(TAG, "WHEP audio PCM delivery enabled=$enabled")
  }

  override fun setTargetSize(size: TargetSize?) {
    targetSize.set(size)
  }

  override fun stop() {
    currentUrl = null
    offerPosted = false
    pendingOfferPost?.let { mainHandler.removeCallbacks(it) }
    pendingOfferPost = null
    // Disarmed before removeSink, so a sink callback already in flight cannot
    // promote the source we are tearing down.
    cancelFirstFrameDeadline()
    firstFrame.reset()
    mainHandler.removeCallbacks(statsPoll)
    try {
      attachedVideo?.removeSink(videoSink)
    } catch (_: Exception) {
    }
    attachedVideo = null
    videoIds.reset()
    audioIds.reset()
    audioTracks.clear()
    // Invalidate callbacks from the peer being disposed below before they can
    // observe the IDLE we are about to set.
    generation++
    transition(SourceState.IDLE, "stop")
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
    // libwebrtc renders every received audio track through its device module.
    // That is the wearer's own mic coming back out of the phone (or, over
    // A2DP, the glasses) — the feedback loop. The mixer must still run so the
    // AudioTrackSink gets PCM, so we keep playout but make it inert: media
    // attributes (never a voice-call route) and per-track volume 0 below.
    val adm = JavaAudioDeviceModule.builder(context)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setUseHardwareAcousticEchoCanceler(false)
      .setUseHardwareNoiseSuppressor(false)
      .setAudioTrackStateCallback(object : JavaAudioDeviceModule.AudioTrackStateCallback {
        override fun onWebRtcAudioTrackStart() {
          Log.i(TAG, "WHEP ADM playout started (silenced; sink-only)")
        }

        override fun onWebRtcAudioTrackStop() {
          Log.i(TAG, "WHEP ADM playout stopped")
        }
      })
      .setAudioRecordStateCallback(object : JavaAudioDeviceModule.AudioRecordStateCallback {
        override fun onWebRtcAudioRecordStart() {
          // recv-only transceivers must never open the phone microphone.
          Log.e(TAG, "WHEP ADM started RECORDING — unexpected phone mic capture")
        }

        override fun onWebRtcAudioRecordStop() {
          Log.i(TAG, "WHEP ADM recording stopped")
        }
      })
      .createAudioDeviceModule()
    // Belt and braces with the per-track volume: the device module zeroes
    // its playout buffer, and recording is disabled outright.
    adm.setSpeakerMute(true)
    adm.setAudioRecordEnabled(false)
    factory = PeerConnectionFactory.builder()
      .setAudioDeviceModule(adm)
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(shared, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(shared))
      .createPeerConnectionFactory()
    adm.release()
    Log.i(TAG, "P3 factory decoderMode=$mode egl=${shared != null} adm=media-silent")
  }

  @Synchronized
  private fun postOfferIfNeeded() {
    if (offerPosted) return
    val url = currentUrl ?: return
    val peer = pc ?: return
    val offer = peer.localDescription?.description ?: return
    offerPosted = true
    postOffer(url, offer, peer, generation)
  }

  private fun postOffer(url: String, offer: String, peer: PeerConnection, gen: Int) {
    val request = Request.Builder()
      .url(url)
      .header("Content-Type", "application/sdp")
      .post(offer.toRequestBody("application/sdp".toMediaType()))
      .build()
    http.newCall(request).enqueue(object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
        if (gen != generation) return
        Log.e(TAG, "WHEP POST failed", e)
        transition(SourceState.FAILED, "whep_post_failed:${e.javaClass.simpleName}")
      }

      override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
        response.use {
          val answer = it.body?.string().orEmpty()
          if (gen != generation) return
          if (!it.isSuccessful) {
            Log.e(TAG, "WHEP ${it.code}: $answer")
            transition(SourceState.FAILED, "whep_http_${it.code}")
            return
          }
          Log.i(TAG, "P3 WHEP ${it.code} answer bytes=${answer.length}")
          // Stay CONNECTING: setRemoteDescription, ICE and the decoder still have
          // to run, and on device that is 3-6 s before ACS submits a frame.
          armFirstFrame(gen)
          peer.setRemoteDescription(
            SdpAdapter(),
            SessionDescription(SessionDescription.Type.ANSWER, answer),
          )
        }
      }
    })
  }

  private fun observerFor(gen: Int) = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
      Log.i(TAG, "ICE $state")
      if (gen != generation) return
      if (state == PeerConnection.IceConnectionState.FAILED ||
        state == PeerConnection.IceConnectionState.DISCONNECTED
      ) {
        transition(SourceState.FAILED, "ice_${state.name.lowercase()}")
      } else if (state == PeerConnection.IceConnectionState.CONNECTED ||
        state == PeerConnection.IceConnectionState.COMPLETED
      ) {
        // ICE can bounce DISCONNECTED → CONNECTED on its own (consent freshness
        // hiccup); only act if the answer already arrived. LIVE now means a frame
        // reached the sink and a recovered candidate pair is only a promise of
        // one, so go back to CONNECTING and let the next frame promote. Frames
        // that were already flowing promote immediately; if none arrive the
        // rearmed deadline fails us again and the session's rebuild backoff runs.
        if (this@CloudflareWhepSource.state == SourceState.FAILED && offerPosted) {
          transition(SourceState.CONNECTING, "ice_recovered")
          armFirstFrame(gen)
        }
      }
    }
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
      Log.i(TAG, "ICE gathering $state")
      if (gen != generation) return
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
      if (gen != generation) return
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

  /**
   * Arms the first-frame gate for [gen] and bounds the wait.
   *
   * An answered WHEP that never delivers a frame used to read LIVE forever
   * behind a frozen image, with nothing above this layer able to see it.
   * Expiring into FAILED hands it to [SourceStateListener], whose rebuild
   * backoff is the only thing that can repair it.
   */
  private fun armFirstFrame(gen: Int) {
    firstFrame.arm(gen)
    cancelFirstFrameDeadline()
    val task = Runnable {
      firstFrameDeadline = null
      if (gen != generation || !firstFrame.expired(gen)) return@Runnable
      Log.w(TAG, "WHEP answered but delivered no frame in ${FIRST_FRAME_TIMEOUT_MS}ms")
      transition(SourceState.FAILED, "no_first_frame")
    }
    firstFrameDeadline = task
    mainHandler.postDelayed(task, FIRST_FRAME_TIMEOUT_MS)
  }

  private fun cancelFirstFrameDeadline() {
    firstFrameDeadline?.let { mainHandler.removeCallbacks(it) }
    firstFrameDeadline = null
  }

  /** The one honest LIVE: a decoded frame is on its way to ACS. */
  private fun notePromotableFrame() {
    if (!firstFrame.onFrame(generation)) return
    cancelFirstFrameDeadline()
    transition(SourceState.LIVE, "first_frame")
  }

  private val videoSink = VideoSink { frame ->
    val sinkStart = System.nanoTime()
    notePromotableFrame()
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
    // Output gain is applied after the raw sink callback in ChannelReceive, so
    // volume 0 silences local playout while the sink still gets full-scale PCM.
    track.setVolume(0.0)
    track.setEnabled(true)
    track.addSink(audioSink)
    Log.i(TAG, "P3 attach kind=audio id=$id attached=${audioIds.size()} skipped=${audioIds.skipped()} playoutVolume=0")
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

    /**
     * How long a WHEP answer has to produce its first frame. Measured on an S22
     * reconnect the gap is ~3.2 s (answer 15:56:47.16 → first frame 15:56:50.36);
     * a cold subscribe on a bad network is slower, so this is deliberately loose.
     * Too tight rebuilds a subscriber that was about to work.
     */
    private const val FIRST_FRAME_TIMEOUT_MS = 9_000L

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
