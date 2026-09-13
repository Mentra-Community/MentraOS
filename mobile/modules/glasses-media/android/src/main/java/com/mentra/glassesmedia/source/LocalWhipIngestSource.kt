package com.mentra.glassesmedia.source

import android.content.Context
import android.media.AudioAttributes
import android.util.Log
import com.mentra.glassesmedia.network.NetworkFacts
import com.mentra.glassesmedia.network.ScopedNetworkChangeDetector
import com.mentra.glassesmedia.network.ScopedSoftApNetwork
import com.mentra.glassesmedia.telemetry.PipelineStats
import com.mentra.glassesmedia.trace.SoftApTrace
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.Logging
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
 *  - [com.mentra.glassesmedia.network.ScopedNetworkChangeDetector], so libwebrtc sees the hotspot at
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
  @Volatile private var selectedPairTask: Runnable? = null

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
   * the peer all belong to one publish attempt, and [SourceReusePolicy] excludes this kind for that
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
    cancelSelectedPairProof()
    firstFrame.reset()
    detachTracks()
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
    scopedNetwork?.let { ScopedNetworkChangeDetector.releaseReceiverNetwork(it) }
  }

  /** Terminal teardown for owners that discard this receiver instead of reusing its factory. */
  fun close() {
    generation++
    check(server?.closeAndAwait() != false) { "Local WHIP requests are still draining" }
    stop()
    factory?.dispose()
    factory = null
    egl?.release()
    egl = null
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

    val prefix = scopedNetwork?.scopedPrefix()
    when (val verdict = SoftApSdpGuard.inspect(offer, prefix)) {
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

    // A glasses WHIP reconnect POSTs a new offer on the same listener. The previous peer's
    // `video0` claim must not survive: that is the 17:48:28 miss where ICE came back, the
    // decoder produced frames, and the ACS sink never saw one.
    detachTracks()
    if (state == SourceState.FAILED || state == SourceState.LIVE) {
      transition(SourceState.CONNECTING, "renegotiate")
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
          if (gen != generation) { answered.countDown(); return }
          peer.createAnswer(
            object : SdpAdapter() {
              override fun onCreateSuccess(sdp: SessionDescription) {
                if (gen != generation) { answered.countDown(); return }
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

    val gatheredSdp = peer.localDescription?.description
      ?: return negotiationFailed(sessionId, "no_local_description")
    val scopedAddress = scopedNetwork?.localIpv4()
    // Real handle marks the ICE sockets onto the SoftAP. libwebrtc then advertises the default
    // route (cellular) as the candidate address. The glasses cannot reach that, so the answer they
    // get is pinned to the scoped IP. No-op when gathering already told the truth.
    val pinned =
      if (prefix != null && scopedAddress != null) {
        SoftApSdpGuard.pinHostAddresses(gatheredSdp, scopedAddress, prefix)
      } else {
        SoftApSdpGuard.PinResult(gatheredSdp, emptyList())
      }
    if (pinned.rewritten.isNotEmpty()) {
      SoftApTrace.stage(
        "ingest_answer_pinned",
        "session" to sessionId,
        "scopedAddress" to scopedAddress,
        "replaced" to pinned.rewritten.joinToString(","),
      )
    }
    val local = pinned.sdp
    answer.set(local)

    // The full gathered set, attributed to real interfaces, captured at the moment of judgement.
    // A missing hotspot candidate is the failure, and every observation that separates its causes
    // exists only here: the kernel table, the inventory libwebrtc actually holds, and the address
    // each candidate ended up carrying. Reconstructing any of it from later logs has already
    // produced one wrong conclusion, so it is recorded together.
    val table = NetworkFacts.snapshot()
    val candidateFacts =
      local.lineSequence()
        .filter { it.contains("candidate:") }
        .map { line ->
          val address = SoftApSdpGuard.candidateAddress(line)
          SoftApIceDiagnosis.CandidateFact(
            address,
            address?.let { NetworkFacts.ownerOf(it, table) },
            SoftApSdpGuard.isSoftApHostCandidate(line.trim().removePrefix("a="), prefix),
          )
        }
        .toList()
    SoftApTrace.stage(
      "ingest_answer_candidates",
      "count" to candidateFacts.size,
      "hotspotPrefix" to (prefix?.toString() ?: "unknown"),
      "candidates" to candidateFacts.joinToString(" | ") { it.toString() },
      "table" to NetworkFacts.render(NetworkFacts.gatherable(table)),
    )

    // The answer is checked with the same guard as the offer. If libwebrtc gathered nothing on the
    // hotspot, returning this answer would produce a call that negotiates and then never carries a
    // frame — the exact silent failure the feasibility gate exists to rule out.
    when (val verdict = SoftApSdpGuard.inspect(local, prefix)) {
      is SoftApSdpGuard.Verdict.Rejected -> {
        val diagnosis =
          SoftApIceDiagnosis.diagnose(
            scopedAddress,
            scopedAddress?.let { NetworkFacts.ownerOf(it, table) },
            prefix,
            ScopedNetworkChangeDetector.lastPublished,
            candidateFacts,
          )
        SoftApTrace.failure(
          "ingest_answer_rejected",
          "detail" to verdict.detail,
          *diagnosis.fields(),
        )
        return negotiationFailed(sessionId, verdict.code)
      }

      is SoftApSdpGuard.Verdict.Ok -> SoftApTrace.stage(
        "ingest_answer_ready",
        "session" to sessionId,
        "hostCandidates" to verdict.hostCandidates.size,
        "scopedPrefix" to prefix?.toString(),
      )
    }

    armFirstFrame(gen)
    return Result.success(local)
  }

  override fun publisherFailed(): Boolean = state == SourceState.FAILED

  override fun terminate(sessionId: String) {
    SoftApTrace.stage("ingest_session_terminated", "session" to sessionId)
    generation++
    cancelFirstFrameDeadline()
    cancelSelectedPairProof()
    detachTracks()
    disposePeer()
    if (state != SourceState.IDLE) transition(SourceState.FAILED, "publisher_terminated")
  }

  /**
   * Drop sink attachments and id claims so the next peer can attach `video0` again.
   *
   * Glasses WHIP reconnect keeps the same track ids. [TrackRegistry.claim] then returns false,
   * [attachVideo] skips `addSink`, WebRTC still decodes, and the first-frame gate expires.
   */
  private fun detachTracks() {
    runCatching { attachedVideo?.removeSink(relay.videoSink) }
    attachedVideo = null
    for (track in audioTracks) {
      runCatching { track.removeSink(relay.audioSink) }
    }
    audioTracks.clear()
    videoIds.reset()
    audioIds.reset()
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
    // Standalone receivers can supply a fallback without replacing the owner's live registration.
    scopedNetwork?.let { ScopedNetworkChangeDetector.registerReceiverNetwork(it) }
    if (factory != null) return
    PeerConnectionFactory.initialize(
      PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
    )
    // The decision we cannot otherwise see is libwebrtc's own: at LS_INFO the native stack logs each
    // interface BasicNetworkManager kept and the adapter type it assigned, the ports it allocated,
    // and every BindSocketToNetwork result. That is what showed the hotspot entry being erased by a
    // handle collision. Loud, so it is behind a flag to flip once the path is green on device.
    if (MediaDiagnostics.LIBWEBRTC_VERBOSE) {
      runCatching { Logging.enableLogToDebugOutput(Logging.Severity.LS_INFO) }
        .onFailure { Log.w(TAG, "libwebrtc verbose logging unavailable: ${it.message}") }
    }
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
      } else if (state == PeerConnection.IceConnectionState.CONNECTED ||
        state == PeerConnection.IceConnectionState.COMPLETED
      ) {
        // Same bounce WHEP already handles: consent freshness can DISCONNECTED → CONNECTED
        // without a new offer. Stay FAILED and the UI never leaves Reconnecting even after
        // media is flowing again.
        if (this@LocalWhipIngestSource.state == SourceState.FAILED) {
          transition(SourceState.CONNECTING, "ice_recovered")
          armFirstFrame(gen)
        }
        armSelectedPairProof(gen)
      }
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
      Log.i(TAG, "SoftAP ingest ICE gathering $state")
      if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown()
    }

    override fun onIceCandidate(candidate: IceCandidate) {
      // Attribute the candidate to a real interface. `network-cost` in the SDP is libwebrtc's own
      // verdict on the adapter type (10 wifi, 900 cellular, 50 unknown), so printing it next to
      // the interface the kernel says owns the address shows exactly where the labels diverged.
      val address = SoftApSdpGuard.candidateAddress(candidate.sdp)
      SoftApTrace.stage(
        "ingest_host_candidate",
        "onHotspot" to SoftApSdpGuard.isSoftApHostCandidate(candidate.sdp, scopedNetwork?.scopedPrefix()),
        "address" to (address ?: "none"),
        "owner" to (address?.let { NetworkFacts.ownerOf(it) } ?: "ABSENT"),
        "candidate" to candidate.sdp,
      )
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

  /**
   * Prove media is on the hotspot, not merely that the SDP mentioned it.
   *
   * [SoftApSdpGuard] checks what each side *offered*; ICE then picks a pair, and nothing so far says
   * it picked one on the network we joined. A call running over cellular or home Wi-Fi is the exact
   * failure SoftAP exists to avoid, and it does not announce itself — the tile is either black or
   * looks fine while taking the long way round. Two samples rather than one so the byte counter has
   * something to be compared against.
   */
  private fun armSelectedPairProof(gen: Int) {
    cancelSelectedPairProof()
    val first = Runnable {
      if (gen != generation) return@Runnable
      sampleIcePath(gen) { firstSample ->
        val second = Runnable {
          if (gen != generation) return@Runnable
          sampleIcePath(gen) { secondSample -> reportIcePath(gen, firstSample, secondSample) }
        }
        selectedPairTask = second
        mainHandler.postDelayed(second, SELECTED_PAIR_SAMPLE_GAP_MS)
      }
    }
    selectedPairTask = first
    mainHandler.postDelayed(first, SELECTED_PAIR_FIRST_SAMPLE_MS)
  }

  private fun cancelSelectedPairProof() {
    selectedPairTask?.let { mainHandler.removeCallbacks(it) }
    selectedPairTask = null
  }

  /** Reads the prefix per sample: the phone can lose and rejoin the hotspot mid-call. */
  private fun sampleIcePath(gen: Int, onSample: (IcePathVerdict) -> Unit) {
    val peer = pc ?: return
    val prefix = scopedNetwork?.scopedPrefix()
    runCatching {
      peer.getStats { report ->
        if (gen != generation) return@getStats
        onSample(
          SelectedIcePair.verdict(
            iceTransports(report),
            candidatePairs(report),
            iceCandidates(report),
            prefix,
            gen,
          ),
        )
      }
    }.onFailure { Log.w(TAG, "SoftAP ingest stats read failed", it) }
  }

  private fun reportIcePath(gen: Int, first: IcePathVerdict, second: IcePathVerdict) {
    if (gen != generation) return
    when (second) {
      is IcePathVerdict.OnHotspot -> {
        val flow = SelectedIcePair.flow(first, second)
        val compared = flow as? SelectedIcePair.Flow.Compared
        SoftApTrace.stage(
          "ingest_selected_pair",
          "pairId" to second.pairId,
          "local" to second.local,
          "remote" to second.remote,
          "bytesReceived" to second.bytesReceived,
          // Only ever true off a same-pair comparison. An incomparable sample reports the reason
          // instead of a verdict, because growth across a pair change is not evidence.
          "bytesFlowing" to (compared?.flowing ?: false),
          "comparable" to (compared != null),
          "notComparable" to (flow as? SelectedIcePair.Flow.NotComparable)?.reason,
        )
        Log.i(
          TAG,
          "SoftAP ingest selected pair ${second.pairId} local=${second.local} " +
            "remote=${second.remote} bytes=${second.bytesReceived} flow=$flow",
        )
        if (compared != null && !compared.flowing) {
          // The pair is right but nothing is arriving yet. Named so the log says so, and left
          // non-terminal on purpose: the first-frame gate already owns that verdict, and one slow
          // sample must not kill a call that is about to paint.
          SoftApTrace.failure(
            "ingest_selected_pair_idle",
            "pairId" to second.pairId,
            "local" to second.local,
            "bytesReceived" to second.bytesReceived,
          )
        }
      }

      is IcePathVerdict.OffHotspot -> {
        SoftApTrace.failure(
          "ingest_selected_pair_off_hotspot",
          "pairId" to second.pairId,
          "local" to second.local,
          "prefix" to second.prefix,
        )
        Log.e(TAG, "SoftAP ingest selected a pair off the hotspot: ${second.local} not in ${second.prefix}")
        transition(SourceState.FAILED, "ice_off_hotspot")
      }

      is IcePathVerdict.Unknown ->
        SoftApTrace.stage("ingest_selected_pair_unknown", "reason" to second.reason)
    }
  }

  /**
   * The transport entries, for `selectedCandidatePairId`.
   *
   * Read from the report rather than inferred, because inference is what made the previous verifier
   * untrustworthy. `RTCStatsReport` also carries the pre-spec `selectedCandidatePairId` under the
   * same name on this build, so no aliasing is needed.
   */
  private fun iceTransports(report: org.webrtc.RTCStatsReport): List<IceTransportStats> =
    report.statsMap.values
      .filter { it.type == "transport" }
      .map { stats ->
        IceTransportStats(
          id = stats.id,
          selectedCandidatePairId = stats.members["selectedCandidatePairId"] as? String,
        )
      }

  private fun candidatePairs(report: org.webrtc.RTCStatsReport): List<IceCandidatePairStats> =
    report.statsMap.values
      .filter { it.type == "candidate-pair" }
      .map { stats ->
        IceCandidatePairStats(
          id = stats.id,
          state = stats.members["state"] as? String,
          nominated = stats.members["nominated"] as? Boolean ?: false,
          localCandidateId = stats.members["localCandidateId"] as? String,
          remoteCandidateId = stats.members["remoteCandidateId"] as? String,
          // libwebrtc reports 64-bit counters as BigInteger, which is a Number but not a Long.
          bytesReceived = (stats.members["bytesReceived"] as? Number)?.toLong() ?: 0L,
        )
      }

  private fun iceCandidates(report: org.webrtc.RTCStatsReport): Map<String, IceCandidateStats> =
    report.statsMap.values
      .filter { it.type == "local-candidate" || it.type == "remote-candidate" }
      .associate { stats ->
        stats.id to IceCandidateStats(
          id = stats.id,
          address = (stats.members["address"] ?: stats.members["ip"]) as? String,
          candidateType = stats.members["candidateType"] as? String,
        )
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
     * feasibility gate and [com.mentra.glassesmedia.network.ScopedNetworkChangeDetector] address.
     */
    private const val GATHER_TIMEOUT_MS = 4_000L

    /**
     * Shorter than the Cloudflare path's 9 s: there is no CDN ingest, no transcode and no WAN hop
     * here, so a first frame that has not arrived in 6 s is not late, it is not coming.
     */
    private const val FIRST_FRAME_TIMEOUT_MS = 6_000L

    /** Let the nominated pair settle before reading it; ICE reports CONNECTED as it is choosing. */
    private const val SELECTED_PAIR_FIRST_SAMPLE_MS = 500L

    /** Long enough that a healthy 15 fps feed cannot show a flat byte counter across the two reads. */
    private const val SELECTED_PAIR_SAMPLE_GAP_MS = 1_200L
  }
}
