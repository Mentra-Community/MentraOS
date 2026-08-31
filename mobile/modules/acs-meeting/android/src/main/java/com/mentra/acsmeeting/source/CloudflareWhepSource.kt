package com.mentra.acsmeeting.source

import android.content.Context
import android.util.Log
import com.mentra.acsmeeting.telemetry.AcsDebugLog
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
 * Recvonly WHEP subscriber. Decoded I420 is packed tight and handed to ACS
 * as native I420 (no RGB convert). Scale uses libyuv cropAndScale in buffer
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
  // Written by ensureDest on the decode thread, cleared by stop() on the session thread.
  @Volatile private var dest: ByteBuffer? = null
  @Volatile private var destWidth = 0
  @Volatile private var destHeight = 0
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
    if (config.url == currentUrl && config.kind == SourceKind.WHEP) return
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
    dest = null
    destWidth = 0
    destHeight = 0
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
    stats.onSink()
    stats.recordGap()
    val buffer = frame.buffer
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
    val i420 = source.toI420() ?: run {
      stats.onDropNullI420()
      scaled?.release()
      return@VideoSink
    }
    try {
      val w = i420.width
      val h = i420.height
      val dest = ensureDest(w, h)
      val packStart = System.nanoTime()
      I420Packer.pack(i420.dataY, i420.strideY, i420.dataU, i420.strideU, i420.dataV, i420.strideV, w, h, dest)
      stats.pack.record(System.nanoTime() - packStart)
      stats.setSize(w, h)
      videoListener.onVideoFrame(dest, w, h, frame.timestampNs)
    } finally {
      i420.release()
      scaled?.release()
    }
  }

  private fun ensureDest(width: Int, height: Int): ByteBuffer {
    val needed = I420Packer.packedSize(width, height)
    val existing = dest
    if (existing != null && destWidth == width && destHeight == height && existing.capacity() >= needed) {
      existing.clear()
      return existing
    }
    destWidth = width
    destHeight = height
    val next = ByteBuffer.allocateDirect(needed)
    dest = next
    return next
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
      // #region agent log
      emitDebugStats(report)
      // #endregion
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
          ),
        )
        return@getStats
      }
    }
  }

  // #region agent log
  private var dbgTick = 0L

  /**
   * Hypotheses D/E: is the loss we see on the phone the Cloudflare->phone hop, or
   * a shadow of the glasses->Cloudflare hop? Dump the raw members so no field we
   * did not think of is missing at analysis time.
   */
  private fun emitDebugStats(report: org.webrtc.RTCStatsReport) {
    val tick = ++dbgTick
    for (entry in report.statsMap.values) {
      val members = entry.members
      val kind = members["kind"]?.toString()
      val where = "CloudflareWhepSource.kt:pollDecodedStats"
      when (entry.type) {
        "inbound-rtp" -> if (kind == "video") {
          AcsDebugLog.emitJson(
            "D,E", where, "phone whep inbound-rtp",
            AcsDebugLog.toJson(members).put("tick", tick).put("statsTsUs", entry.timestampUs),
          )
        }
        "candidate-pair" -> if (members["nominated"] == true) {
          AcsDebugLog.emitJson(
            "E,B", where, "phone whep candidate-pair",
            AcsDebugLog.toJson(members).put("tick", tick).put("statsTsUs", entry.timestampUs),
          )
        }
        "track" -> if (kind == "video") {
          AcsDebugLog.emitJson(
            "D", where, "phone whep track",
            AcsDebugLog.toJson(members).put("tick", tick),
          )
        }
      }
    }
    AcsDebugLog.emitJson("B", "CloudflareWhepSource.kt:wifi", "phone wifi radio", wifiJson().put("tick", tick))
  }

  /** Hypothesis B: does the phone's own radio degrade at the same moment? */
  private fun wifiJson(): org.json.JSONObject {
    val out = org.json.JSONObject()
    try {
      val manager = context.applicationContext
        .getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
      val info = manager?.connectionInfo ?: return out.put("available", false)
      out.put("available", true)
      out.put("rssi", info.rssi)
      out.put("linkSpeedMbps", info.linkSpeed)
      out.put("frequencyMhz", info.frequency)
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
        out.put("txLinkSpeedMbps", info.txLinkSpeedMbps)
        out.put("rxLinkSpeedMbps", info.rxLinkSpeedMbps)
      }
    } catch (error: Exception) {
      out.put("error", error.javaClass.simpleName)
    }
    return out
  }
  // #endregion

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
