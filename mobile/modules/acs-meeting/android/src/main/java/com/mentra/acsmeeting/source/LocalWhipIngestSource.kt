package com.mentra.acsmeeting.source

import android.content.Context
import android.media.AudioAttributes
import android.util.Log
import com.mentra.acsmeeting.network.ScopedSoftApNetwork
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.trace.SoftApTrace
import org.webrtc.AudioTrack
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
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Receives glasses media straight off the SoftAP, with no Cloudflare hop.
 *
 * This is the same job [CloudflareWhepSource] does with the roles reversed. There the phone offers
 * and Cloudflare answers; here the glasses offer — using the WHIP client they already ship — and
 * the phone answers on a listener bound to its own hotspot address. Keeping the glasses as the
 * offerer is deliberate: it is by far the harder device to debug, and this way its publish path is
 * unchanged apart from the URL it POSTs to and the absence of a STUN server.
 *
 * Three things make the local link work, and all three matter:
 *
 *  - an empty ICE server list, so no server-reflexive or relay candidate can even be gathered;
 *  - [SoftApIcePolicy.networkIgnoreMask], so cellular and VPN adapters are excluded from gathering
 *    and cannot be selected over the hotspot;
 *  - [com.mentra.acsmeeting.network.ScopedNetworkChangeDetector], so libwebrtc sees the hotspot at
 *    all — its stock monitor only watches internet-capable networks, and this one deliberately is
 *    not.
 *
 * Past the decoder nothing is special, so frames and PCM go through the shared [DecodedTrackRelay].
 *
 * The session owns this object and this object owns the [WhipIngestServer] and the peer. The
 * orchestrator only sequences; it never holds the listener. That keeps a single answer to "who
 * tears the publisher down", which is what makes leave-during-negotiation safe.
 */
class LocalWhipIngestSource(
  private val context: Context,
  videoListener: VideoFrameListener,
  pcmListener: PcmListener,
  private val stats: PipelineStats = PipelineStats(),
  /**
   * The joined hotspot. Passed so libwebrtc can be shown a network Android is hiding from it;
   * null falls back to the stock monitor, which is only viable if the feasibility gate showed the
   * hotspot is visible without help.
   */
  private val scopedNetwork: ScopedSoftApNetwork? = null,
) : GlassesMediaSource, WhipIngestServer.Negotiator {

  private val relay = DecodedTrackRelay(videoListener, pcmListener, stats) { notePromotableFrame() }
  private val firstFrame = FirstFrameGate()
  private val videoIds = TrackRegistry()
  private val audioIds = TrackRegistry()
  private val audioTracks = CopyOnWriteArrayList<AudioTrack>()
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  private var factory: PeerConnectionFactory? = null
  private var egl: EglBase? = null
  private var server: WhipIngestServer? = null

  @Volatile private var pc: PeerConnection? = null
  @Volatile private var attachedVideo: VideoTrack? = null
  @Volatile private var boundUrl: String? = null
  @Volatile private var stateListener: SourceStateListener? = null
  @Volatile private var firstFrameDeadline: Runnable? = null

  /**
   * Invalidates callbacks from a peer we are disposing. A negotiation can be mid-gather when the
   * user leaves, and its completion must not resurrect a torn-down source.
   */
  @Volatile private var generation = 0

  @Volatile override var state: SourceState = SourceState.IDLE
    private set

  override val ingestUrl: String?
    get() = boundUrl

  /**
   * Binds the ingest listener. Returns as soon as the phone is ready to be published to — the
   * glasses have not connected yet, so this is `CONNECTING`, not `LIVE`.
   *
   * [SourceConfig.bindAddress] must be the phone's address on the hotspot. Binding to that one
   * address rather than the wildcard is what confines the endpoint to the SoftAP interface.
   */
  override fun start(config: SourceConfig) {
    stop()
    val bindAddress = requireNotNull(config.bindAddress ?: scopedNetwork?.localIpv4()) {
      "SoftAP ingest needs the phone's hotspot address"
    }
    generation++
    transition(SourceState.CONNECTING, "start")
    ensureFactory()

    val ingest = WhipIngestServer(this)
    val endpoint = ingest.start(InetAddress.getByName(bindAddress))
    server = ingest
    boundUrl = "http://${endpoint.host}:${endpoint.port}${WhipIngestProtocol.BASE_PATH}"
    SoftApTrace.stage("ingest_source_listening", "url" to boundUrl)
    Log.i(TAG, "SoftAP ingest listening on $boundUrl")
  }

  /**
   * A SoftAP restart is always a full rebuild. There is no URL to keep: the listener, the port and
   * the peer all belong to one publish attempt, and [canReuseSource] excludes this kind for that
   * reason.
   */
  override fun restart(config: SourceConfig) = start(config)

  override fun forceRestart() {
    val url = boundUrl ?: return
    Log.i(TAG, "SoftAP ingest forced rebuild state=$state url=$url")
    start(SourceConfig("", SourceKind.SOFTAP, scopedNetwork?.localIpv4()))
  }

  override fun setStateListener(listener: SourceStateListener?) {
    stateListener = listener
  }

  override fun setPcmDeliveryEnabled(enabled: Boolean) {
    relay.setPcmDeliveryEnabled(enabled)
    Log.i(TAG, "SoftAP ingest PCM delivery enabled=$enabled")
  }

  override fun setTargetSize(size: TargetSize?) = relay.setTargetSize(size)

  override fun stop() {
    boundUrl = null
    cancelFirstFrameDeadline()
    firstFrame.reset()
    runCatching { attachedVideo?.removeSink(relay.videoSink) }
    attachedVideo = null
    videoIds.reset()
    audioIds.reset()
    audioTracks.clear()
    relay.resetRotationLog()
    // Bump before disposing so in-flight observer callbacks see a stale generation rather than
    // the IDLE we are about to publish.
    generation++
    transition(SourceState.IDLE, "stop")

    // stop() leaves the listener answering 410 for a few seconds, so a POST the glasses already
    // sent gets an answer it can act on instead of a reset it would retry.
    server?.let { runCatching { it.stop() } }
    server = null
    disposePeer()
  }

  // -----------------------------------------------------------------
  // WhipIngestServer.Negotiator — the glasses' offer arrives here
  // -----------------------------------------------------------------

  /**
   * Answers the glasses' offer, blocking until ICE gathering completes.
   *
   * Blocking is correct here, not lazy: neither side implements WHIP's `PATCH` trickle, so the
   * answer we return is the only answer the glasses will ever see and it must be complete. Local
   * gathering with no STUN server takes milliseconds, so the wait is short in every healthy case
   * and [GATHER_TIMEOUT_MS] only bounds the broken ones.
   */
  override fun negotiate(sessionId: String, offer: String): Result<String> {
    val gen = generation
    val currentFactory = factory ?: return Result.failure(IllegalStateException("factory_disposed"))

    when (val verdict = SoftApSdpGuard.inspect(offer)) {
      is SoftApSdpGuard.Verdict.Rejected -> {
        SoftApTrace.failure(
          "ingest_offer_rejected",
          "code" to verdict.code,
          "detail" to verdict.detail,
        )
        transition(SourceState.FAILED, "offer_${verdict.code}")
        return Result.failure(IllegalArgumentException(verdict.code))
      }

      is SoftApSdpGuard.Verdict.Ok -> {
        if (verdict.routableCandidates.isNotEmpty()) {
          // Not fatal: a valid hotspot candidate is present. Worth a line because it means the
          // glasses gathered something they should not have in host-only mode.
          Log.w(TAG, "SoftAP offer carried non-hotspot candidates: ${verdict.routableCandidates}")
        }
        SoftApTrace.stage(
          "ingest_offer_accepted",
          "session" to sessionId,
          "hostCandidates" to verdict.hostCandidates.size,
        )
      }
    }

    val gathered = CountDownLatch(1)
    val peer = currentFactory.createPeerConnection(hostOnlyConfiguration(), observerFor(gen, gathered))
      ?: return Result.failure(IllegalStateException("peer_create_failed"))
    disposePeer()
    pc = peer

    val answer = AtomicReference<String?>(null)
    val failure = AtomicReference<String?>(null)
    val answered = CountDownLatch(1)

    peer.setRemoteDescription(
      object : SdpAdapter() {
        override fun onSetSuccess() {
          peer.createAnswer(
            object : SdpAdapter() {
              override fun onCreateSuccess(sdp: SessionDescription) {
                peer.setLocalDescription(
                  object : SdpAdapter() {
                    override fun onSetSuccess() = answered.countDown()
                    override fun onSetFailure(error: String) {
                      failure.set("set_local_failed:$error")
                      answered.countDown()
                    }
                  },
                  sdp,
                )
              }

              override fun onCreateFailure(error: String) {
                failure.set("create_answer_failed:$error")
                answered.countDown()
              }
            },
            MediaConstraints(),
          )
        }

        override fun onSetFailure(error: String) {
          failure.set("set_remote_failed:$error")
          answered.countDown()
        }
      },
      SessionDescription(SessionDescription.Type.OFFER, offer),
    )

    if (!answered.await(ANSWER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      return negotiationFailed(sessionId, "answer_timeout")
    }
    failure.get()?.let { return negotiationFailed(sessionId, it) }
    if (!gathered.await(GATHER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      return negotiationFailed(sessionId, "gather_timeout")
    }
    if (gen != generation) return negotiationFailed(sessionId, "superseded")

    val local = peer.localDescription?.description
      ?: return negotiationFailed(sessionId, "no_local_description")
    answer.set(local)

    // The answer is checked with the same guard as the offer. If libwebrtc gathered nothing on the
    // hotspot, returning this answer would produce a call that negotiates and then never carries a
    // frame — the exact silent failure the feasibility gate exists to rule out.
    when (val verdict = SoftApSdpGuard.inspect(local)) {
      is SoftApSdpGuard.Verdict.Rejected -> {
        SoftApTrace.failure(
          "ingest_answer_rejected",
          "code" to verdict.code,
          "detail" to verdict.detail,
        )
        return negotiationFailed(sessionId, verdict.code)
      }

      is SoftApSdpGuard.Verdict.Ok -> SoftApTrace.stage(
        "ingest_answer_ready",
        "session" to sessionId,
        "hostCandidates" to verdict.hostCandidates.size,
      )
    }

    armFirstFrame(gen)
    return Result.success(local)
  }

  override fun terminate(sessionId: String) {
    SoftApTrace.stage("ingest_session_terminated", "session" to sessionId)
    generation++
    cancelFirstFrameDeadline()
    disposePeer()
    if (state != SourceState.IDLE) transition(SourceState.FAILED, "publisher_terminated")
  }

  private fun negotiationFailed(sessionId: String, reason: String): Result<String> {
    SoftApTrace.failure("ingest_negotiation_failed", "session" to sessionId, "reason" to reason)
    transition(SourceState.FAILED, reason)
    disposePeer()
    return Result.failure(IllegalStateException(reason))
  }

  // -----------------------------------------------------------------
  // WebRTC plumbing
  // -----------------------------------------------------------------

  /**
   * No ICE servers at all. Host-only is not a preference here, it is the only possibility: there is
   * no route from the hotspot to a STUN server, so a configured one would just add a few seconds of
   * doomed gathering to every call.
   */
  private fun hostOnlyConfiguration() = PeerConnection.RTCConfiguration(emptyList()).apply {
    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
    // Local link, so a candidate pool buys nothing and TCP candidates only add noise.
    iceCandidatePoolSize = 0
    tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
    networkPreference = PeerConnection.AdapterType.WIFI
  }

  private fun ensureFactory() {
    if (factory != null) return
    PeerConnectionFactory.initialize(
      PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
    )
    val shared = EglBase.create().also { egl = it }.eglBaseContext
    // Same silenced device module as the Cloudflare path: libwebrtc renders every received audio
    // track through it, which would be the wearer's own microphone coming back out of the phone.
    // Playout must still run so the AudioTrackSink is fed, so it runs inert.
    val adm = JavaAudioDeviceModule.builder(context)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
      .setUseHardwareAcousticEchoCanceler(false)
      .setUseHardwareNoiseSuppressor(false)
      .setAudioRecordStateCallback(object : JavaAudioDeviceModule.AudioRecordStateCallback {
        override fun onWebRtcAudioRecordStart() {
          Log.e(TAG, "SoftAP ingest ADM started RECORDING — unexpected phone mic capture")
        }

        override fun onWebRtcAudioRecordStop() = Unit
      })
      .createAudioDeviceModule()
    adm.setSpeakerMute(true)
    adm.setAudioRecordEnabled(false)

    factory = PeerConnectionFactory.builder()
      .setOptions(SoftApIcePolicy.factoryOptions())
      .setAudioDeviceModule(adm)
      .setVideoEncoderFactory(DefaultVideoEncoderFactory(shared, true, true))
      .setVideoDecoderFactory(DefaultVideoDecoderFactory(shared))
      .createPeerConnectionFactory()
    adm.release()
    SoftApTrace.stage(
      "ingest_factory_ready",
      "networkIgnoreMask" to SoftApIcePolicy.networkIgnoreMask(),
      "scopedNetwork" to (scopedNetwork?.isAvailable() == true),
    )
  }

  private fun observerFor(gen: Int, gathered: CountDownLatch) = object : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
      Log.i(TAG, "SoftAP ingest ICE $state")
      if (gen != generation) return
      if (state == PeerConnection.IceConnectionState.FAILED ||
        state == PeerConnection.IceConnectionState.DISCONNECTED
      ) {
        transition(SourceState.FAILED, "ice_${state.name.lowercase()}")
      }
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
      Log.i(TAG, "SoftAP ingest ICE gathering $state")
      if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown()
    }

    override fun onIceCandidate(candidate: IceCandidate) {
      if (SoftApSdpGuard.isSoftApHostCandidate(candidate.sdp)) {
        SoftApTrace.stage("ingest_host_candidate", "candidate" to candidate.sdp)
      }
    }

    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out MediaStream>) = Unit

    // Unified Plan: onTrack is the only attach path, and the glasses' offer is what creates the
    // transceivers, so nothing is added here.
    override fun onTrack(transceiver: RtpTransceiver) {
      if (gen != generation) return
      when (val track = transceiver.receiver.track()) {
        is VideoTrack -> attachVideo(track)
        is AudioTrack -> attachAudio(track)
      }
    }
  }

  private fun attachVideo(track: VideoTrack) {
    if (!videoIds.claim(track.id())) {
      stats.onDup()
      return
    }
    attachedVideo = track
    track.addSink(relay.videoSink)
    Log.i(TAG, "SoftAP ingest attach kind=video id=${track.id()}")
  }

  private fun attachAudio(track: AudioTrack) {
    if (!audioIds.claim(track.id())) {
      stats.onDup()
      return
    }
    audioTracks.add(track)
    // Gain is applied after the raw sink callback, so volume 0 kills local playout while the sink
    // still receives full-scale PCM for the ACS uplink.
    track.setVolume(0.0)
    track.setEnabled(true)
    track.addSink(relay.audioSink)
    Log.i(TAG, "SoftAP ingest attach kind=audio id=${track.id()} playoutVolume=0")
  }

  private fun disposePeer() {
    val peer = pc
    pc = null
    try {
      peer?.close()
      peer?.dispose()
    } catch (error: Exception) {
      Log.w(TAG, "SoftAP ingest peer dispose failed", error)
    }
  }

  /**
   * `LIVE` means a frame reached the sink, never that the negotiation succeeded. An answered
   * session that never delivers a frame reads as healthy behind a frozen tile otherwise, and
   * nothing above this layer can tell.
   */
  private fun armFirstFrame(gen: Int) {
    firstFrame.arm(gen)
    cancelFirstFrameDeadline()
    val task = Runnable {
      firstFrameDeadline = null
      if (gen != generation || !firstFrame.expired(gen)) return@Runnable
      Log.w(TAG, "SoftAP ingest answered but delivered no frame in ${FIRST_FRAME_TIMEOUT_MS}ms")
      SoftApTrace.failure("ingest_no_first_frame", "timeoutMs" to FIRST_FRAME_TIMEOUT_MS)
      transition(SourceState.FAILED, "no_first_frame")
    }
    firstFrameDeadline = task
    mainHandler.postDelayed(task, FIRST_FRAME_TIMEOUT_MS)
  }

  private fun cancelFirstFrameDeadline() {
    firstFrameDeadline?.let { mainHandler.removeCallbacks(it) }
    firstFrameDeadline = null
  }

  private fun notePromotableFrame() {
    if (!firstFrame.onFrame(generation)) return
    cancelFirstFrameDeadline()
    SoftApTrace.stage("ingest_first_frame")
    transition(SourceState.LIVE, "first_frame")
  }

  private fun transition(next: SourceState, reason: String) {
    val previous = state
    state = next
    if (previous == next) return
    Log.i(TAG, "SoftAP ingest source $previous -> $next ($reason)")
    try {
      stateListener?.onSourceState(next, reason)
    } catch (error: Exception) {
      Log.w(TAG, "source state listener threw", error)
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"

    /** createAnswer plus setLocalDescription. Local work; generous only to avoid flakiness. */
    private const val ANSWER_TIMEOUT_MS = 5_000L

    /**
     * Local host gathering with no STUN server normally finishes in tens of milliseconds. This only
     * bounds the case where libwebrtc cannot see the hotspot at all, which is the failure the
     * feasibility gate and [com.mentra.acsmeeting.network.ScopedNetworkChangeDetector] address.
     */
    private const val GATHER_TIMEOUT_MS = 4_000L

    /**
     * Shorter than the Cloudflare path's 9 s: there is no CDN ingest, no transcode and no WAN hop
     * here, so a first frame that has not arrived in 6 s is not late, it is not coming.
     */
    private const val FIRST_FRAME_TIMEOUT_MS = 6_000L
  }
}
