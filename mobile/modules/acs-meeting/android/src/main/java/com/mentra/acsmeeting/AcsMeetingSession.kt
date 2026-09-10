package com.mentra.acsmeeting

import android.content.Context
import android.util.Base64
import android.util.Log
import com.azure.android.communication.calling.AudioStreamBufferDuration
import com.azure.android.communication.calling.AudioStreamChannelMode
import com.azure.android.communication.calling.AudioStreamFormat
import com.azure.android.communication.calling.AudioStreamSampleRate
import com.azure.android.communication.calling.AudioStreamState
import com.azure.android.communication.calling.AudioStreamType
import com.azure.android.communication.calling.CapabilitiesCallFeature
import com.azure.android.communication.calling.CapabilitiesChangedListener
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.CallAgent
import com.azure.android.communication.calling.CallAgentOptions
import com.azure.android.communication.calling.CallClient
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.Features
import com.azure.android.communication.calling.HangUpOptions
import com.azure.android.communication.calling.ParticipantCapabilityType
import com.azure.android.communication.calling.DiagnosticFlagChangedListener
import com.azure.android.communication.calling.DiagnosticQualityChangedListener
import com.azure.android.communication.calling.LocalUserDiagnosticsCallFeature
import com.azure.android.communication.calling.MediaStatisticsCallFeature
import com.azure.android.communication.calling.MediaStatisticsReportReceivedListener
import com.azure.android.communication.calling.NetworkDiagnostics
import com.azure.android.communication.calling.IncomingAudioOptions
import com.azure.android.communication.calling.IncomingMixedAudioEvent
import com.azure.android.communication.calling.JoinCallOptions
import com.azure.android.communication.calling.LocalOutgoingAudioStream
import com.azure.android.communication.calling.OutgoingAudioOptions
import com.azure.android.communication.calling.OutgoingVideoConstraints
import com.azure.android.communication.calling.OutgoingVideoOptions
import com.azure.android.communication.calling.RawIncomingAudioStream
import com.azure.android.communication.calling.RawIncomingAudioStreamOptions
import com.azure.android.communication.calling.RawIncomingAudioStreamProperties
import com.azure.android.communication.calling.RawOutgoingAudioStream
import com.azure.android.communication.calling.RawOutgoingAudioStreamOptions
import com.azure.android.communication.calling.RawOutgoingAudioStreamProperties
import com.azure.android.communication.calling.RawOutgoingVideoStreamOptions
import com.azure.android.communication.calling.TeamsMeetingLinkLocator
import com.azure.android.communication.calling.VirtualOutgoingVideoStream
import com.azure.android.communication.common.CommunicationTokenCredential
import com.mentra.acsmeeting.audio.AcsAudioPolicy
import com.mentra.acsmeeting.audio.ActiveStreamKind
import com.mentra.acsmeeting.audio.JoinAudioPlan
import com.mentra.acsmeeting.audio.AudioPolicyApplier
import com.mentra.acsmeeting.audio.AudioSafety
import com.mentra.acsmeeting.audio.AudioSourceKind
import com.mentra.acsmeeting.audio.AudioStreamController
import com.mentra.acsmeeting.audio.AudioUplinkChain
import com.mentra.acsmeeting.audio.CallGuard
import com.mentra.acsmeeting.audio.ExecutorPolicyScheduler
import com.mentra.acsmeeting.audio.GlassesPcmRouting
import com.mentra.acsmeeting.audio.AcsUplinkTransport
import com.mentra.acsmeeting.audio.IncomingAudioPump
import com.mentra.acsmeeting.audio.IncomingRateProbe
import com.mentra.acsmeeting.audio.PcmBridge
import com.mentra.acsmeeting.audio.PhoneMicCapturer
import com.mentra.acsmeeting.audio.UplinkPacer
import com.mentra.acsmeeting.audio.UplinkSender
import com.mentra.acsmeeting.source.AcsInvestigation
import com.mentra.acsmeeting.source.CloudflareWhepSource
import com.mentra.acsmeeting.source.DecoderMode
import com.mentra.acsmeeting.source.OutgoingRateArm
import com.mentra.acsmeeting.source.PixelFormatArm
import com.mentra.acsmeeting.source.GlassesMediaController
import com.mentra.acsmeeting.network.ScopedSoftApNetwork
import com.mentra.acsmeeting.source.GlassesMediaSourceFactory
import com.mentra.acsmeeting.source.LocalWhipIngestSource
import com.mentra.acsmeeting.source.MeetingVideoSourceSpec
import com.mentra.acsmeeting.source.SourceConfig
import com.mentra.acsmeeting.source.SourceKind
import com.mentra.acsmeeting.source.SourceState
import com.mentra.acsmeeting.source.SyntheticI420Source
import com.mentra.acsmeeting.source.TargetSize
import com.mentra.acsmeeting.source.VideoSourceArm
import com.mentra.acsmeeting.telemetry.AvSyncProbe
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.telemetry.PipelineTicker
import com.mentra.acsmeeting.video.AcsFrameSender
import com.mentra.acsmeeting.video.VideoProfile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

class AcsMeetingSession(
  private val context: Context,
  private val onState: (Map<String, Any>) -> Unit,
  private val onIncomingPcm: (String, Int, Int) -> Unit,
  mediaSourceFactory: GlassesMediaSourceFactory? = null,
  /**
   * The joined glasses hotspot, when the call is a SoftAP call. Held so libwebrtc can be shown a
   * network Android hides from it; null for every Cloudflare call.
   */
  private val scopedNetwork: ScopedSoftApNetwork? = null,
) {
  internal val stats = PipelineStats()
  private val avSync = AvSyncProbe()
  private val ticker = PipelineTicker(stats, avSync) {
    Log.i(TAG, it)
  }
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val scheduler = ExecutorPolicyScheduler(executor)
  private val outgoingReady = AtomicBoolean(false)
  private val muted = AtomicBoolean(false)
  private val frameSender = AcsFrameSender(stats, avSync)
  private var profile = VideoProfile.DEFAULT
  private val resolvedFactory = mediaSourceFactory ?: GlassesMediaSourceFactory { video, pcm, config ->
    // The synthetic diagnostic arm overrides everything; otherwise the requested kind decides.
    when {
      AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC ->
        SyntheticI420Source(video, stats, frameSender::isReady)

      config.kind == SourceKind.SOFTAP ->
        LocalWhipIngestSource(context, video, pcm, stats, scopedNetwork)

      else -> CloudflareWhepSource(context, video, pcm, stats)
    }
  }
  @Volatile private var lastGatedLogMs = 0L
  private var pcmBridge: PcmBridge? = null
  /**
   * Ingest, delay, resample and pacing behind one lock, so mute means the same thing at every
   * stage. Built by [join] alongside the bridge it owns.
   */
  @Volatile private var uplinkChain: AudioUplinkChain? = null
  /**
   * Whether the *host* is feeding this call's outgoing audio, rather than the decoded glasses
   * track. Set by the audio policy for a SoftAP call on the glasses microphone: the wearer's voice
   * arrives over BLE LC3 through [pushOutgoingPcm], and the WHIP peer publishes video only.
   *
   * Also a drop gate. Without it a host that pushes PCM at a call which is taking audio from the
   * media relay would put the same room on the call twice.
   */
  private val externalPcmEnabled = AtomicBoolean(false)
  private val incomingProbe = IncomingRateProbe()
  // Clock-domain adapter: the WebRTC audio thread only ever fills the pacer,
  // and a dedicated monotonic-deadline thread drains it into ACS.
  private val pacer = UplinkPacer(log = { Log.i(TAG, it) })
  @Volatile private var uplinkSender: UplinkSender? = null
  private val phoneMic = PhoneMicCapturer { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) }
  // Emits already-normalized 16 kHz mono; the host opens its PCM player with
  // exactly that format, so whatever ACS actually delivers cannot change pitch.
  private val incomingPump = IncomingAudioPump { chunk ->
    onIncomingPcm(PcmBridge.encodeBase64(chunk), IncomingAudioPump.OUT_RATE, IncomingAudioPump.OUT_CHANNELS)
  }
  // isSpeaking flips several times a second per participant; coalesce so the
  // host and miniapp see one roster snapshot per burst instead of a storm.
  private val rosterPushPending = AtomicBoolean(false)
  private val roster = RemoteRoster {
    if (rosterPushPending.compareAndSet(false, true)) {
      executor.schedule({
        rosterPushPending.set(false)
        if (call != null) onState(snapshot())
      }, ROSTER_COALESCE_MS, TimeUnit.MILLISECONDS)
    }
  }
  private val media = GlassesMediaController(resolvedFactory)
  private var mediaStatsListener: MediaStatisticsReportReceivedListener? = null
  private var mediaStatsFeature: MediaStatisticsCallFeature? = null
  private var capabilitiesFeature: CapabilitiesCallFeature? = null
  private var capabilitiesListener: CapabilitiesChangedListener? = null
  /**
   * Whether this participant may end the meeting for everyone. Teams grants it to presenters only,
   * and ACS can deliver it after admission, so it is a live value rather than a join-time fact.
   */
  @Volatile private var hangUpForEveryone = CapabilityStatus()
  private val mediaStatsReports = AtomicInteger(0)
  /** Last wire size reported by ACS, so adaptation is logged on transition rather than every 1 Hz report. */
  @Volatile private var lastWireSizeKey: String? = null
  private var netDiagnostics: NetworkDiagnostics? = null
  private var sendQualityListener: DiagnosticQualityChangedListener? = null
  private var reconnectListener: DiagnosticQualityChangedListener? = null
  private var noNetworkListener: DiagnosticFlagChangedListener? = null
  private var relaysListener: DiagnosticFlagChangedListener? = null
  private var callClient: CallClient? = null
  private var callAgent: CallAgent? = null
  private var call: Call? = null
  private var audioOut: RawOutgoingAudioStream? = null
  private var localOut: LocalOutgoingAudioStream? = null
  private var audioIn: RawIncomingAudioStream? = null
  private var videoOut: VirtualOutgoingVideoStream? = null
  @Volatile private var meetingUrl: String? = null
  @Volatile private var phase = "idle"
  @Volatile private var lastError: String? = null
  @Volatile private var audioSource = "glasses"
  @Volatile private var configuredAudioDelayMs = AcsInvestigation.acsAudioDelayMs
  @Volatile private var lastSafety = AudioSafety.DEGRADED
  // Health of the glasses WHEP feed, reported alongside the ACS phase so the host
  // can tell "call is up, glasses video is dead" from a healthy call.
  @Volatile private var mediaSource = SourceState.IDLE
  // The transport of the active call. A SoftAP source must not be auto-rebuilt: its URL is an
  // output of binding, so a rebuild rebinds a new port and strands the glasses on the old one.
  @Volatile private var currentSourceKind = SourceKind.WHEP
  private var mediaRestartAttempts = 0
  private var mediaRestartTask: ScheduledFuture<*>? = null

  /**
   * Bumped by every join and every leave, so a bounded ACS operation that completes late cannot
   * attach its result to a session that has already moved on.
   *
   * Same pattern as the ingest source's generation. It exists because `createCallAgent` is a future
   * with no timeout of its own: on device it stalled for 30 s while cellular was still validating,
   * and a cancelled join that later succeeds would otherwise leave a live agent nobody owns.
   */
  @Volatile private var joinGeneration = 0
  /**
   * `createCallAgent` Future we stopped waiting on. ACS still finishes signing in; this is the only
   * handle that can dispose that leftover agent before the next join.
   */
  private var abandonedAgent: Future<CallAgent>? = null
  /**
   * Agent signed in before the glasses hotspot came up. SoftAP DNS cannot resolve ACS hosts, so
   * `createCallAgent` after the scoped join stalls until the hotspot is torn down. Join reuses this
   * instead of signing in again on the broken resolver.
   */
  @Volatile private var agentPrepared = false
  private val controller = SessionAudioController()
  private val applier = AudioPolicyApplier(controller, scheduler) { Log.i(TAG, it) }

  fun snapshot(): Map<String, Any> {
    val result = mutableMapOf<String, Any>(
      "state" to phase,
      "muted" to muted.get(),
      "provider" to "acs-teams",
      "audioSource" to audioSource,
      "activeStream" to controller.readActive().name.lowercase(),
      "audioSafety" to lastSafety.name.lowercase(),
      "mediaSource" to mediaSource.name.lowercase(),
      "participants" to roster.snapshot(),
      // Nullable members inside, so the miniapp can tell "denied" from "not known yet" and only
      // offer End when it is actually allowed.
      "capabilities" to mapOf("hangUpForEveryone" to hangUpForEveryone.toMap()),
    )
    meetingUrl?.let { result["meetingUrl"] = it }
    lastError?.let { result["error"] = it }
    media.ingestUrl?.let { result["ingestUrl"] = it }
    describeEndReason(call).forEach { (key, value) ->
      if (value != null) result["endReason_$key"] = value
    }
    return result
  }

  /**
   * Sign in to ACS before the glasses hotspot exists.
   *
   * On device, `createCallAgent` after the scoped join sat for the full 20 s deadline and only
   * completed once SoftAP was released. Token mint already proved the internet works *before* that
   * join. Doing this step on that same network is what makes the later SoftAP join a media bind
   * plus a Teams meeting join, not another sign-in through glasses dnsmasq.
   *
   * Waits [PREPARE_AGENT_WAIT_MS], not [CALL_AGENT_WAIT_MS]. The tight budget only ever existed
   * because sign-in used to run inside the SoftAP join, where overrunning cost the wearer the
   * hotspot too. Here nothing is torn down while we wait, and a cold sign-in on a slow AP measured
   * 35 s on device — under the old 20 s cap that agent arrived just in time to be thrown away.
   */
  fun prepareAgent(token: String, displayName: String?) {
    val done = CountDownLatch(1)
    val error = AtomicReference<Exception?>(null)
    phase = "connecting"
    lastError = null
    executor.execute {
      try {
        leaveLocked(emitIdle = false)
        val generation = joinGeneration
        lastError = null
        emit("connecting")
        val credential = CommunicationTokenCredential(token)
        callClient = CallClient()
        val agentOptions = CallAgentOptions()
        agentOptions.displayName = displayName ?: "Mentra Call"
        callAgent = obtainCallAgent(callClient!!, credential, agentOptions, generation, PREPARE_AGENT_WAIT_MS)
        agentPrepared = true
        Log.i(TAG, "ACS call agent prepared before SoftAP")
      } catch (failed: Exception) {
        agentPrepared = false
        lastError = formatAcsError(failed)
        Log.e(TAG, "prepare agent failed $lastError", failed)
        leaveLocked(emitIdle = false)
        emit("error")
        error.set(failed)
      } finally {
        done.countDown()
      }
    }
    if (!done.await(PREPARE_AGENT_WAIT_MS + ABANDONED_AGENT_REJOIN_WAIT_MS + 5_000L, TimeUnit.MILLISECONDS)) {
      throw IllegalStateException(
        "ACS_AGENT_TIMEOUT: Teams did not finish signing this phone in within " +
          "${PREPARE_AGENT_WAIT_MS / 1000}s.",
      )
    }
    error.get()?.let { throw it }
  }

  fun join(
    token: String,
    teamsUrl: String,
    videoSource: MeetingVideoSourceSpec,
    displayName: String?,
    dumpWav: Boolean,
    audioSource: String = "glasses",
    video: VideoProfile = VideoProfile.DEFAULT,
    audioDelayMs: Int? = null,
    /**
     * Runs the WHIP listener bind, and exists so the caller can lift a process-wide network pin
     * across exactly that call. Takes the block rather than being a pair of before/after hooks so
     * the pin cannot be left off if the bind throws. See [network.InternetHold.bindProcessToCellular].
     */
    bindIngestUnpinned: (() -> Unit) -> Unit = { bind -> bind() },
  ): Map<String, Any> {
    // Both glasses and phone feed RawOutgoingAudioStream so ACS never owns
    // the phone audio route (no MODE_IN_COMMUNICATION, no forced speaker).
    // Phone PCM comes from AudioRecord; glasses PCM still arrives via WHEP.
    val parsed = AcsAudioPolicy.parseSource(audioSource) ?: AudioSourceKind.GLASSES
    if (parsed == AudioSourceKind.PHONE) {
      Log.i(TAG, "audioSource=phone: AudioRecord → virtual outgoing; communication mode off")
    }
    this.audioSource = if (parsed == AudioSourceKind.PHONE) "phone" else "glasses"
    // The ACS work below is queued, so callers must not receive the pre-join
    // phase. Reflect the intent synchronously so the resolved snapshot is
    // "connecting" and cannot overwrite a fresher onState with a stale idle.
    phase = "connecting"
    lastError = null
    meetingUrl = teamsUrl
    // SoftAP needs the WHIP listener bound before this method returns: the JS
    // orchestrator reads ingestUrl off the join result and tears the scoped
    // network down if it is missing. ACS join itself stays on the executor.
    val softApReady = if (videoSource is MeetingVideoSourceSpec.SoftAp) CountDownLatch(1) else null
    val softApBindError = AtomicReference<Exception?>(null)
    executor.execute {
      try {
        // Tear down any previous call without announcing idle: the caller already
        // holds a "connecting" snapshot, and an idle event landing after it made
        // the host and miniapp flash out of "joining" on every join.
        // A SoftAP join that already signed in on cellular must keep that agent:
        // recreating it on the glasses hotspot is the ACS_AGENT_TIMEOUT we just hit.
        val reuseAgent = agentPrepared && callAgent != null
        leaveLocked(emitIdle = false, keepAgent = reuseAgent)
        // After the teardown, because that teardown bumps the generation itself. Everything that
        // moves it runs on this executor, so the value is stable for the rest of this join.
        val generation = joinGeneration
        val requested = video
        this.profile = when (AcsInvestigation.outgoingRate) {
          OutgoingRateArm.CLAMP_TO_SOFTWARE_CEILING -> requested.forSoftwareEncoder()
          OutgoingRateArm.ADVERTISE_REQUESTED -> requested
        }
        if (this.profile.fps != requested.fps) {
          Log.i(
            TAG,
            "ACS software-encoder clamp ${requested.width}x${requested.height}@${requested.fps} -> " +
              "@${this.profile.fps} (h264 sw holds ~${VideoProfile.SOFTWARE_ENCODER_FPS} fps; " +
              "advertising faster starves the wire)",
          )
        } else {
          Log.i(
            TAG,
            "ACS rate arm=${AcsInvestigation.outgoingRate} advertising " +
              "${this.profile.width}x${this.profile.height}@${this.profile.fps} unclamped; " +
              "P7 rate names what binds",
          )
        }
        // Read by the 1 Hz verdict, which scores the wire against what we declared.
        stats.advertisedFps = this.profile.fps.toDouble()
        stats.budgetBps = this.profile.maxBitrateBps
        this.audioSource = if (parsed == AudioSourceKind.PHONE) "phone" else "glasses"
        meetingUrl = teamsUrl
        lastError = null
        emit("connecting")
        val bridge = PcmBridge(context.cacheDir, dumpWav)
        pcmBridge = bridge
        val delayMs = (audioDelayMs ?: AcsInvestigation.acsAudioDelayMs)
          .coerceIn(0, AudioUplinkChain.MAX_DELAY_MS)
        configuredAudioDelayMs = delayMs
        avSync.reset()
        uplinkChain = AudioUplinkChain(
          bridge,
          pacer,
          delayMs,
          onIngest = { pcm, nowNs -> avSync.onAudio(pcm, nowNs) },
        )
        if (reuseAgent) {
          Log.i(TAG, "reusing call agent prepared before SoftAP")
          agentPrepared = false
        } else {
          val credential = CommunicationTokenCredential(token)
          callClient = CallClient()
          val agentOptions = CallAgentOptions()
          agentOptions.displayName = displayName ?: "Mentra Call"
          callAgent = obtainCallAgent(callClient!!, credential, agentOptions, generation)
        }

        val videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = listOf(AcsFrameSender.outgoingFormat(profile))
        val videoStream = VirtualOutgoingVideoStream(videoOptions)
        videoOut = videoStream
        frameSender.attach(videoStream) { size -> media.setTargetSize(size) }

        val audioProperties = RawOutgoingAudioStreamProperties()
          .setFormat(AudioStreamFormat.PCM16_BIT)
          .setSampleRate(AudioStreamSampleRate.HZ_48000)
          .setChannelMode(AudioStreamChannelMode.MONO)
          .setBufferDuration(AudioStreamBufferDuration.MS20)
        val outAudioOptions = RawOutgoingAudioStreamOptions().setProperties(audioProperties)
        val outgoing = RawOutgoingAudioStream(outAudioOptions)
        audioOut = outgoing
        outgoing.addOnStateChangedListener {
          val ready = outgoing.state.toString().contains("STARTED", ignoreCase = true)
          outgoingReady.set(ready)
          Log.i(TAG, "raw outgoing audio state=${outgoing.state}")
          if (ready) startUplink(outgoing) else stopUplink()
          applyAudioPolicy("virtual-stream-state")
        }

        val synthetic = AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC
        if (synthetic) muted.set(true)
        val desired = desiredKind()
        val plan = if (synthetic) {
          JoinAudioPlan(armVirtual = true, transportMuted = true)
        } else {
          AcsAudioPolicy.planJoin(desired, muted.get(), GLASSES_REQUIRES_UNMUTED_TRANSPORT)
        }

        // Virtual outgoing stays armed for phone and glasses. A LocalOutgoing
        // stream would make ACS own the phone route and open an echo loop.
        val local = if (plan.armVirtual) null else LocalOutgoingAudioStream()
        localOut = local
        local?.addOnStateChangedListener {
          Log.i(TAG, "local outgoing audio state=${local.state}")
          applyAudioPolicy("local-stream-state")
        }

        val incomingProperties = RawIncomingAudioStreamProperties()
          .setFormat(AudioStreamFormat.PCM16_BIT)
          .setSampleRate(AudioStreamSampleRate.HZ_16000)
          .setChannelMode(AudioStreamChannelMode.MONO)
        val inAudioOptions = RawIncomingAudioStreamOptions().setProperties(incomingProperties)
        val incoming = RawIncomingAudioStream(inAudioOptions)
        audioIn = incoming
        incomingPump.reset()
        incomingProbe.reset()
        incoming.addOnStateChangedListener {
          Log.i(TAG, "raw incoming audio state=${incoming.state}")
        }
        incoming.addOnMixedAudioBufferReceivedListener { event: IncomingMixedAudioEvent ->
          if (AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC) return@addOnMixedAudioBufferReceivedListener
          try {
            val data = event.audioBuffer?.buffer ?: return@addOnMixedAudioBufferReceivedListener
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            // Trust the event's format over what we asked for.
            val props = event.streamProperties
            val rate = sampleRateHz(props?.sampleRate) ?: 16000
            val channels = if (props?.channelMode == AudioStreamChannelMode.STEREO) 2 else 1
            incomingPump.push(bytes, rate, channels)
            logIncomingRate(rate, channels, bytes.size)
          } catch (error: Exception) {
            Log.w(TAG, "incoming PCM callback failed", error)
          }
        }
        val joinOptions = JoinCallOptions()
        val constraints = OutgoingVideoConstraints()
          .setMaxWidth(profile.width)
          .setMaxHeight(profile.height)
          .setMaxFrameRate(profile.fps)
          .setMaxBitrateInBps(profile.maxBitrateBps)
        val ov = OutgoingVideoOptions()
          .setOutgoingVideoStreams(listOf(videoStream))
          .setConstraints(constraints)
        joinOptions.setOutgoingVideoOptions(ov)
        // Virtual outgoing and MODE_IN_COMMUNICATION off for glasses and phone.
        // Communication mode makes the ACS SDK call setMode(3) on connect and
        // request the phone speaker, which yanks A2DP off the glasses.
        val oa = OutgoingAudioOptions()
          .setStream(if (plan.armVirtual) outgoing else requireNotNull(local))
          .setMuted(plan.transportMuted)
          .setCommunicationAudioModeEnabled(!plan.armVirtual)
        joinOptions.setOutgoingAudioOptions(oa)
        // Raw incoming replaces SDK playout: buffers come to us, the SDK plays
        // nothing. Do not start it "speaker muted" — that flag gates the very
        // stream we read from.
        val ia = IncomingAudioOptions()
          .setStream(incoming)
          .setMuted(false)
        joinOptions.setIncomingAudioOptions(ia)

        stats.arm = when {
          synthetic -> "synthetic"
          videoSource is MeetingVideoSourceSpec.SoftAp -> "softap"
          else -> "whep"
        }
        stats.pathMode = if (AcsInvestigation.decoderMode == DecoderMode.BYTE_BUFFER) "bytebuf" else "texture"
        stats.pathCopy = when {
          AcsInvestigation.pixelFormat == PixelFormatArm.NV12 -> "nv12"
          AcsInvestigation.zeroCopy -> "zerocopy"
          else -> "planes"
        }
        stats.pix = AcsInvestigation.pixelFormat.name.lowercase()
        stats.zcOn = if (AcsInvestigation.zeroCopy) 1 else 0
        mediaRestartAttempts = 0
        currentSourceKind = if (synthetic) SourceKind.DIRECT else videoSource.kind
        media.setStateListener { state, reason ->
          // Fired from WebRTC/OkHttp threads; hop to the session executor so it
          // serializes with join/leave/policy like everything else.
          executor.execute { onMediaSourceState(state, reason) }
        }
        // SoftAP: bind the listener before the Teams join so the Expo promise can
        // return an ingest URL while 192.168.43.x is still assigned. WHEP still
        // attaches after the call exists — it has a URL going in, not coming out.
        if (videoSource is MeetingVideoSourceSpec.SoftAp) {
          // #region agent log
          com.mentra.acsmeeting.network.DebugTap.log(
            "F",
            "AcsMeetingSession.kt:softap-attach",
            "binding whip listener before acs join",
            mapOf(
              "bindAddress" to (videoSource as MeetingVideoSourceSpec.SoftAp).bindAddress,
              "scopedIpv4" to scopedNetwork?.localIpv4(),
              "scopedAvailable" to (scopedNetwork?.isAvailable() == true),
            ),
          )
          // #endregion
          // Unpinned for the bind only: this socket is a ServerSocket on 192.168.43.79 and cannot
          // be re-scoped afterwards, so a cellular mark here leaves the glasses' SYN unanswered.
          // The pin is back on by the time the Teams join below runs.
          bindIngestUnpinned {
            media.attach(
              video = { planes ->
                frameSender.sendPlanes(planes)
              },
              pcm = { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) },
              config = videoSource.toConfig(),
            )
          }
          // #region agent log
          com.mentra.acsmeeting.network.DebugTap.log(
            "F",
            "AcsMeetingSession.kt:softap-bound",
            "whip listener bound",
            mapOf("ingestUrl" to media.ingestUrl),
          )
          // #endregion
        }

        val locator = TeamsMeetingLinkLocator(teamsUrl)
        val joined = callAgent!!.join(context, locator, joinOptions)
        call = joined
        roster.attach(joined)
        joined.addOnStateChangedListener { pushCallState(joined.state) }
        joined.addOnOutgoingAudioStateChangedListener {
          Log.i(TAG, "outgoing audio state changed muted=${joined.isOutgoingAudioMuted}")
          applyAudioPolicy("outgoing-audio-state")
        }
        pushCallState(joined.state)

        if (videoSource !is MeetingVideoSourceSpec.SoftAp) {
          media.attach(
            video = { planes ->
              frameSender.sendPlanes(planes)
            },
            pcm = { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) },
            config = if (synthetic) SourceConfig("", SourceKind.DIRECT) else videoSource.toConfig(),
          )
        }
        media.setTargetSize(TargetSize(profile.width, profile.height))
        ticker.start()
        Log.i(
          TAG,
          "CPU probe: 1 Hz P6 ladder includes path{mode copy}, buf{tex i420}, stride{tight padded}, " +
            "copyP95, zc{}, cpu{proc}. i420P95 is toI420; copyP95 is the single plane copy. " +
            "BYTE_BUFFER should drop i420P95 and set buf{tex=0}. zerocopy should drop copyP95.",
        )
        applyAudioPolicy("join")
        Log.i(
          TAG,
          "ACS join started arm=${AcsInvestigation.videoArm.name.lowercase()} " +
            "profile=${profile.width}x${profile.height}@${profile.fps} " +
            "maxBitrate=${profile.maxBitrateBps} bitsPerFrame=${profile.bitsPerFrame()} " +
            "syntheticFps=${AcsInvestigation.syntheticFps} entropy=${AcsInvestigation.syntheticEntropy} " +
            "decoderMode=${AcsInvestigation.decoderMode} zeroCopy=${AcsInvestigation.zeroCopy} " +
            "pixelFormat=${AcsInvestigation.pixelFormat} " +
            "source=${this.audioSource} audio=${if (synthetic) "off" else "on"} " +
            "armVirtual=${plan.armVirtual} transportMuted=${plan.transportMuted}",
        )
        softApReady?.countDown()
      } catch (error: Exception) {
        val message = formatAcsError(error)
        Log.e(TAG, "join failed $message", error)
        // A step after a successful ACS join (e.g. WHEP start) can throw. Record
        // the failure before tearing the call down: lastError makes pushCallState
        // ignore the hang-up's async disconnected callbacks, and emitIdle=false
        // keeps the terminal state as error instead of resetting to idle. Either
        // would otherwise let Mentra Call treat the failed join as a clean end.
        lastError = message
        softApBindError.compareAndSet(null, error)
        // #region agent log
        com.mentra.acsmeeting.network.DebugTap.log(
          "F",
          "AcsMeetingSession.kt:join-failed",
          "join executor failed",
          mapOf("message" to message, "ingestUrl" to media.ingestUrl),
        )
        // #endregion
        leaveLocked(emitIdle = false)
        emit("error")
        softApReady?.countDown()
      }
    }
    if (softApReady != null) {
      if (!softApReady.await(SOFTAP_JOIN_WAIT_MS, TimeUnit.MILLISECONDS)) {
        throw IllegalStateException("SoftAP ingest listener did not bind in ${SOFTAP_JOIN_WAIT_MS}ms")
      }
      softApBindError.get()?.let { throw it }
      if (media.ingestUrl == null) {
        throw IllegalStateException("SoftAP ingest listener bound but produced no URL")
      }
    }
    // #region agent log
    com.mentra.acsmeeting.network.DebugTap.log(
      "F",
      "AcsMeetingSession.kt:join-return",
      "join returning to js",
      mapOf(
        "softap" to (videoSource is MeetingVideoSourceSpec.SoftAp),
        "ingestUrl" to media.ingestUrl,
        "phase" to phase,
      ),
    )
    // #endregion
    return snapshot()
  }

  /**
   * Point the subscriber at a different WHEP URL. WHEP only: a SoftAP listener has no URL to
   * update, since the URL is an output of binding, and its recovery is a full rebuild through
   * [restartVideoSource].
   */
  fun updateVideoSource(whepUrl: String) {
    executor.execute {
      // The host has a fresher opinion about where the glasses publish; drop
      // any automatic retry against the old URL.
      cancelMediaRestart()
      media.restart(SourceConfig(whepUrl))
    }
  }

  /**
   * The URL the glasses must POST their offer to, for a SoftAP call. Null until the listener has
   * bound, and null for every other transport. The orchestrator reads this after join and sends it
   * to the glasses in `start_stream`.
   */
  fun softApIngestUrl(): String? = media.ingestUrl

  /**
   * Rebuild the WHEP subscription on the current URL even when it looks healthy.
   * The host calls this when the phone changed networks: ICE may not have noticed
   * yet, but the old candidate pair is dead.
   */
  fun restartVideoSource() {
    executor.execute {
      // A SoftAP source cannot be rebuilt in place: forceRestart() rebinds a new OS-chosen port and
      // mints a fresh ingestUrl, but the glasses keep POSTing to the old port and nothing re-pushes
      // the new URL, which permanently strands the call in CONNECTING. Leaving the listener bound on
      // its stable port instead lets the glasses' own WHIP reconnect recover against the same URL;
      // a network-level recovery is the orchestrator's job (re-run the SoftapCallTransport sequence).
      if (currentSourceKind == SourceKind.SOFTAP) {
        Log.w(TAG, "restartVideoSource ignored for SoftAP; a rebuild would strand the glasses on a dead port")
        return@execute
      }
      cancelMediaRestart()
      media.forceRestart()
    }
  }

  private fun onMediaSourceState(state: SourceState, reason: String?) {
    val previous = mediaSource
    mediaSource = state
    if (state == SourceState.LIVE) mediaRestartAttempts = 0
    if (state == SourceState.FAILED) scheduleMediaRestart(reason)
    // start() emits IDLE then CONNECTING back to back; one snapshot per real change.
    if (previous != state && call != null && phase != "idle") onState(snapshot())
  }

  /**
   * Native owns first-line recovery: nothing above this layer can see ICE fail, and
   * a Teams call with a frozen last frame looks healthy from every other angle.
   * Exponential backoff capped at MEDIA_RESTART_MAX_MS; runs as long as the call is
   * alive. The host resets it whenever it hands us a new URL.
   */
  private fun scheduleMediaRestart(reason: String?) {
    if (call == null || phase == "idle" || phase == "disconnected" || phase == "error") return
    // SoftAP recovery must never rebuild the source from here: forceRestart() rebinds a new port and
    // ingestUrl the glasses are never told about, so the call would strand in CONNECTING. The
    // FAILED state is still surfaced to the host (onMediaSourceState emits a snapshot), and the
    // still-bound listener lets the glasses' own WHIP reconnect recover on the unchanged URL.
    if (currentSourceKind == SourceKind.SOFTAP) {
      Log.w(TAG, "SoftAP media source failed ($reason); session-level rebuild suppressed, listener left bound for glasses reconnect")
      return
    }
    if (mediaRestartTask?.isDone == false) return
    val attempt = mediaRestartAttempts++
    val delayMs = minOf(MEDIA_RESTART_BASE_MS shl minOf(attempt, 4), MEDIA_RESTART_MAX_MS)
    Log.w(TAG, "glasses media source failed ($reason); WHEP rebuild #${attempt + 1} in ${delayMs}ms")
    mediaRestartTask = executor.schedule({
      mediaRestartTask = null
      if (call == null || mediaSource != SourceState.FAILED) return@schedule
      try {
        media.forceRestart()
      } catch (error: Exception) {
        Log.w(TAG, "WHEP rebuild failed", error)
        scheduleMediaRestart("rebuild_threw")
      }
    }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun cancelMediaRestart() {
    mediaRestartTask?.cancel(false)
    mediaRestartTask = null
    mediaRestartAttempts = 0
  }

  fun setMuted(next: Boolean): Map<String, Any> {
    if (AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC) {
      muted.set(true)
      return snapshot()
    }
    muted.set(next)
    // Before the executor hop, not after it. Muting is the one audio operation whose latency the
    // wearer can hear as a mistake, and the policy queue can be several ACS round trips deep.
    if (next) uplinkChain?.mute() else uplinkChain?.unmute()
    executor.execute { applyAudioPolicy("set-muted") }
    val snap = snapshot()
    onState(snap)
    return snap
  }

  fun setAudioSource(source: String): Map<String, Any> {
    val parsed = AcsAudioPolicy.parseSource(source)
    if (parsed == null) {
      Log.w(TAG, "unknown audioSource=$source ignored; source is locked for this call")
      return snapshot()
    }
    Log.i(TAG, "setAudioSource=$source ignored; audio source is locked for this call at ${audioSource}")
    return snapshot()
  }

  fun leave() {
    executor.execute { leaveLocked() }
  }

  /**
   * End the Teams group call for everyone, then tear this device down.
   *
   * Blocking, unlike [leave], because the caller has to know whether the meeting actually died: the
   * miniapp shows different terminal copy for "ended" and "you left, but the meeting may still be
   * active", and inventing the first would be a lie the wearer cannot check.
   *
   * Local teardown is queued whatever the hang-up did. A refused or failed End must still get the
   * wearer out of the call — the only thing at stake in the failure is what we claim happened.
   *
   * @throws IllegalStateException when there is no call, when the capability is known to be denied,
   *   or when ACS rejects the hang-up
   */
  fun endForEveryone(): Map<String, Any> {
    val done = CountDownLatch(1)
    val failure = AtomicReference<Exception?>(null)
    executor.execute {
      try {
        val active = call ?: throw IllegalStateException("no_active_call")
        // Re-read rather than trusting the cached value: capabilities arrive asynchronously and the
        // last event may predate admission.
        val capability = readHangUpForEveryone()
        EndForEveryonePolicy.refusalFor(capability)?.let { throw IllegalStateException(it) }
        Log.i(TAG, "end for everyone: hangUp(forEveryone=true) allowed=${capability.allowed}")
        active.hangUp(HangUpOptions().setForEveryone(true)).get()
        Log.i(TAG, "end for everyone: ACS accepted the hang-up")
      } catch (error: Exception) {
        Log.w(TAG, "end for everyone failed", error)
        failure.set(error)
      } finally {
        done.countDown()
      }
    }
    val settled = done.await(END_FOR_EVERYONE_WAIT_MS, TimeUnit.MILLISECONDS)
    // Queued unconditionally, and after the await so it cannot dispose the agent out from under the
    // hang-up. A timed-out End still leaves this device.
    executor.execute { leaveLocked() }
    if (!settled) throw IllegalStateException("end_for_everyone_timeout")
    failure.get()?.let { throw it }
    return snapshot()
  }

  /** Latest capability read, for a host that wants to enable or hide End before the user taps it. */
  fun hangUpForEveryoneCapability(): CapabilityStatus = hangUpForEveryone

  fun getState(): Map<String, Any> = snapshot()

  private fun desiredKind(): AudioSourceKind =
    if (audioSource == "phone") AudioSourceKind.PHONE else AudioSourceKind.GLASSES

  /** Queues onto [executor] so ACS callbacks cannot race the applier. */
  private fun applyAudioPolicy(reason: String) {
    executor.execute { applyAudioPolicyOnExecutor(reason) }
  }

  private fun applyAudioPolicyOnExecutor(reason: String) {
    lastSafety = applier.apply(desiredKind(), muted.get(), reason)
    if (lastSafety == AudioSafety.UNSAFE) {
      Log.e(TAG, "audioSafety=unsafe — mute and stopAudio both failed; unintended mic may be live")
    }
    onState(snapshot())
  }

  private fun logIncomingRate(rate: Int, channels: Int, bytes: Int) {
    val reading = incomingProbe.record(System.nanoTime(), bytes, rate, channels) ?: return
    Log.i(
      TAG,
      "P8 audio-in declaredRate=${reading.declaredRate} ch=${reading.channels} " +
        "samplesPerCallback=${reading.samplesPerCallback} " +
        "callbackHz=${"%.2f".format(reading.callbackHz)} " +
        "measuredRate=${reading.measuredRate.roundToInt()} " +
        "prerollMs=${IncomingAudioPump.DEFAULT_PREROLL_MS} events=${incomingPump.eventsIn} " +
        "in=${incomingPump.bytesIn} out16k=${incomingPump.bytesOut} " +
        "formatChanges=${incomingPump.formatChanges}",
    )
  }

  private fun feedOutgoingPcm(pcm: ByteArray, sampleRate: Int, channels: Int) {
    if (muted.get()) {
      val now = System.currentTimeMillis()
      if (now - lastGatedLogMs >= 1000) {
        lastGatedLogMs = now
        Log.i(TAG, "outgoing PCM gated bytes=${pcm.size} (user muted)")
      }
      return
    }
    if (!outgoingReady.get()) return
    // Resample here, but do not touch ACS: sending straight from this thread
    // hands ACS the glasses' audio clock in bursts. The pacer decides when.
    uplinkChain?.ingest(pcm, sampleRate, channels)
  }

  /**
   * Accept one buffer of microphone PCM from the host.
   *
   * The BLE LC3 path: the glasses encode their microphone, the Bluetooth SDK decodes it on the
   * phone, and the host forwards it here rather than the wearer's voice riding the WHIP track. It
   * is deliberately a hard drop rather than a buffer when there is no call to feed — a frame kept
   * for a session that is going away is a frame played into the *next* call.
   *
   * @return true when the buffer entered the uplink
   */
  fun pushOutgoingPcm(base64: String, sampleRate: Int, channels: Int): Boolean {
    if (!externalPcmEnabled.get()) return false
    if (phase == "idle" || phase == "disconnected" || phase == "error") return false
    val pcm = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      Log.w(TAG, "pushOutgoingPcm got undecodable base64 len=${base64.length}", error)
      return false
    }
    if (pcm.isEmpty()) return false
    feedOutgoingPcm(pcm, sampleRate, channels)
    return true
  }

  @Synchronized
  private fun startUplink(stream: RawOutgoingAudioStream) {
    if (uplinkSender != null) return
    pacer.reset()
    val sender = UplinkSender(
      pacer,
      AcsUplinkTransport(stream),
      muted = { muted.get() },
      pcmMeanAbs = { pcmBridge?.lastMeanAbs ?: -1 },
    )
    uplinkSender = sender
    sender.start()
    // The A/V configuration this call ran with, stated once at the top so a receiver recording can
    // be attributed to it. The measured ingest offset is a separate `AVSYNC clap audioLeadMs`
    // line. Never print the two as one number: a delay that is configured is not an offset that
    // was observed, and conflating them is how a calibration gets believed.
    Log.i(
      TAG,
      "P8 audio-up config configuredDelayMs=$configuredAudioDelayMs " +
        "audioTimestamps=${AcsInvestigation.acsAudioTimestamps}",
    )
  }

  @Synchronized
  private fun stopUplink() {
    uplinkSender?.stop()
    uplinkSender = null
    pacer.reset()
  }

  private fun pushCallState(state: CallState) {
    // A failed join has already reported a terminal error and torn the call
    // down; ignore any late ACS state callback so it cannot overwrite error.
    if (lastError != null) return
    val previous = phase
    phase = when (state) {
      CallState.CONNECTING -> "connecting"
      CallState.IN_LOBBY -> "lobby"
      CallState.CONNECTED -> "connected"
      CallState.DISCONNECTING -> "disconnected"
      CallState.DISCONNECTED -> "disconnected"
      else -> phase
    }
    val end = describeEndReason(call)
    Log.i(TAG, "ACS call state=$state phase=$phase previous=$previous end=$end")
    if (phase == "connected" && previous != "connected") {
      call?.let {
        attachMediaStats(it)
        attachDiagnostics(it)
        attachCapabilities(it)
      }
      applyAudioPolicy("call-connected")
    } else {
      onState(snapshot())
    }
  }

  private fun emit(next: String) {
    phase = next
    onState(snapshot())
  }

  private fun attachMediaStats(joined: Call) {
    detachMediaStats()
    mediaStatsReports.set(0)
    lastWireSizeKey = null
    try {
      val feature = joined.feature(Features.MEDIA_STATISTICS)
      val listener = MediaStatisticsReportReceivedListener { event ->
        val outgoing = event.report?.outgoingStatistics
        val videos = outgoing?.videoStatistics
        val n = mediaStatsReports.incrementAndGet()
        val video = videos?.firstOrNull()
        if (n <= 8 || video == null) {
          Log.i(
            TAG,
            "P6 wire report #$n videos=${videos?.size ?: 0} " +
              "audios=${outgoing?.audioStatistics?.size ?: 0} " +
              "codec=${video?.codecName ?: "na"} fps=${video?.frameRate ?: "na"}",
          )
        }
        stats.wireFps = video?.frameRate?.toDouble()
        stats.wireWidth = video?.frameWidth
        stats.wireHeight = video?.frameHeight
        stats.wireBitrateBps = video?.bitrateInBps?.toLong()
        stats.wirePacketCount = video?.packetCount
        val codec = video?.codecName.orEmpty()
        if (codec.isNotBlank() && codec != stats.codecName) {
          Log.i(TAG, "P6 wire codec=$codec ${video?.frameWidth}x${video?.frameHeight} fps=${video?.frameRate}")
        }
        stats.codecName = codec
        reportWireAdaptation(video?.frameWidth, video?.frameHeight, video?.frameRate)
        val width = video?.frameWidth
        val height = video?.frameHeight
        if (width != null && height != null && width > 0 && height > 0) {
          stats.setSize(width, height)
        }
      }
      feature.addOnReportReceivedListener(listener)
      mediaStatsListener = listener
      mediaStatsFeature = feature
      // First attempt often throws while ACS is still spinning up the media
      // stack (S26 Ultra never emitted a default-interval report). Retry after
      // CONNECTED so codecName is not stuck at na.
      scheduleMediaStatsInterval(feature, 0)
      Log.i(TAG, "P6 wire hop attached")
    } catch (error: Exception) {
      Log.w(TAG, "MEDIA_STATISTICS attach failed", error)
    }
  }

  /**
   * Logs a change in what ACS is actually putting on the wire versus the profile we asked for.
   *
   * ACS runs its own rate controller and will trade resolution for frames inside the budget it was
   * given, so the negotiated 1280x720 is a ceiling, not a promise. Without this the ladder prints
   * the adapted size once per second and a permanent downscale reads exactly like a healthy call —
   * the number is right there and nothing ever calls it out. Logged on transition only, because at
   * 1 Hz a warning per report is noise nobody reads.
   */
  private fun reportWireAdaptation(width: Int?, height: Int?, fps: Float?) {
    if (width == null || height == null || width <= 0 || height <= 0) return
    val key = "${width}x$height"
    if (key == lastWireSizeKey) return
    lastWireSizeKey = key
    val askedPixels = profile.width.toLong() * profile.height
    val gotPixels = width.toLong() * height
    if (gotPixels < askedPixels) {
      val percent = (gotPixels * 100 / askedPixels).toInt()
      Log.w(
        TAG,
        "P6 wire ADAPTED_DOWN acs=$key (${percent}% of ${profile.width}x${profile.height}) " +
          "fps=${fps ?: "na"} codec=${stats.codecName.ifBlank { "na" }} " +
          "budget=${profile.maxBitrateBps} bitsPerFrame=${profile.bitsPerFrame()}",
      )
    } else {
      Log.i(TAG, "P6 wire size=$key at or above profile ${profile.width}x${profile.height}")
    }
  }

  private fun scheduleMediaStatsInterval(feature: MediaStatisticsCallFeature, attempt: Int) {
    executor.schedule({
      if (mediaStatsFeature !== feature) return@schedule
      try {
        feature.updateReportIntervalInSeconds(1)
        Log.i(TAG, "P6 wire interval=1s attempt=$attempt")
      } catch (error: Exception) {
        Log.w(
          TAG,
          "P6 wire interval attempt=$attempt failed ${error.javaClass.simpleName}: ${error.message}",
        )
        if (attempt < 5) {
          scheduleMediaStatsInterval(feature, attempt + 1)
        }
      }
    }, if (attempt == 0) 0L else 2L, TimeUnit.SECONDS)
  }

  /**
   * OutgoingVideoStatistics reports frameRate/bitrate/packetCount and nothing
   * about loss or RTT, so `wire` cannot see a bad uplink. Microsoft's own
   * "sender's video is frozen" guidance points at these diagnostics instead:
   * they are the only send-side network signal the SDK exposes.
   */
  private fun attachDiagnostics(joined: Call) {
    detachDiagnostics()
    try {
      val feature = joined.feature(Features.LOCAL_USER_DIAGNOSTICS) as LocalUserDiagnosticsCallFeature
      val network = feature.networkDiagnostics
      val onSend = DiagnosticQualityChangedListener { args ->
        val quality = args.value?.name ?: "null"
        // Latched so `P9 quality` can reprint it every tick; this fires on change only.
        stats.sendQuality = quality
        logDiagnostic("networkSendQuality", quality)
      }
      val onReconnect = DiagnosticQualityChangedListener { args ->
        logDiagnostic("networkReconnectionQuality", args.value?.name ?: "null")
      }
      val onNoNetwork = DiagnosticFlagChangedListener { args ->
        logDiagnostic("networkUnavailable", args.value.toString())
      }
      val onRelays = DiagnosticFlagChangedListener { args ->
        logDiagnostic("networkRelaysUnreachable", args.value.toString())
      }
      network.addOnNetworkSendQualityChangedListener(onSend)
      network.addOnNetworkReconnectionQualityChangedListener(onReconnect)
      network.addOnIsNetworkUnavailableChangedListener(onNoNetwork)
      network.addOnIsNetworkRelaysUnreachableChangedListener(onRelays)
      netDiagnostics = network
      sendQualityListener = onSend
      reconnectListener = onReconnect
      noNetworkListener = onNoNetwork
      relaysListener = onRelays
      Log.i(TAG, "P7 diagnostics attached")
    } catch (error: Exception) {
      Log.w(TAG, "LOCAL_USER_DIAGNOSTICS attach failed", error)
    }
  }

  private fun logDiagnostic(name: String, value: String) {
    Log.i(TAG, "P7 diag $name=$value")
  }

  /**
   * Subscribe to participant capabilities so End can be offered honestly.
   *
   * The capability that matters is `HANG_UP_FOR_EVERYONE`. It can flip mid-call — a presenter role
   * granted or removed — so the listener stays attached rather than reading once at connect.
   */
  private fun attachCapabilities(joined: Call) {
    detachCapabilities()
    try {
      val feature = joined.feature(Features.CAPABILITIES)
      val listener = CapabilitiesChangedListener { event ->
        val changed = event.changedCapabilities.orEmpty()
          .any { it.type == ParticipantCapabilityType.HANG_UP_FOR_EVERYONE }
        if (!changed) return@CapabilitiesChangedListener
        val next = readHangUpForEveryone(feature)
        if (next == hangUpForEveryone) return@CapabilitiesChangedListener
        hangUpForEveryone = next
        Log.i(TAG, "capability hangUpForEveryone allowed=${next.allowed} reason=${next.reason} (changed)")
        onState(snapshot())
      }
      feature.addOnCapabilitiesChangedListener(listener)
      capabilitiesFeature = feature
      capabilitiesListener = listener
      hangUpForEveryone = readHangUpForEveryone(feature)
      Log.i(
        TAG,
        "capability hangUpForEveryone allowed=${hangUpForEveryone.allowed} reason=${hangUpForEveryone.reason}",
      )
    } catch (error: Exception) {
      // Unknown, not denied: an End is still attempted and ACS gets to answer.
      Log.w(TAG, "CAPABILITIES attach failed", error)
      hangUpForEveryone = CapabilityStatus(reason = "capabilities_unavailable")
    }
  }

  private fun readHangUpForEveryone(
    feature: CapabilitiesCallFeature? = capabilitiesFeature,
  ): CapabilityStatus {
    val current = feature ?: return CapabilityStatus(reason = "capabilities_unavailable")
    return try {
      val capability = current.capabilities.orEmpty()
        .firstOrNull { it.type == ParticipantCapabilityType.HANG_UP_FOR_EVERYONE }
        ?: return CapabilityStatus(reason = "not_reported")
      CapabilityStatus(capability.isAllowed, capability.reason?.name?.lowercase())
    } catch (error: Exception) {
      Log.w(TAG, "capabilities read failed", error)
      CapabilityStatus(reason = "capabilities_unavailable")
    }
  }

  private fun detachCapabilities() {
    val feature = capabilitiesFeature
    val listener = capabilitiesListener
    capabilitiesFeature = null
    capabilitiesListener = null
    if (feature == null || listener == null) return
    try {
      feature.removeOnCapabilitiesChangedListener(listener)
    } catch (_: Exception) {
    }
  }

  private fun detachDiagnostics() {
    val network = netDiagnostics ?: return
    try {
      sendQualityListener?.let { network.removeOnNetworkSendQualityChangedListener(it) }
      reconnectListener?.let { network.removeOnNetworkReconnectionQualityChangedListener(it) }
      noNetworkListener?.let { network.removeOnIsNetworkUnavailableChangedListener(it) }
      relaysListener?.let { network.removeOnIsNetworkRelaysUnreachableChangedListener(it) }
    } catch (_: Exception) {
    }
    netDiagnostics = null
    sendQualityListener = null
    reconnectListener = null
    noNetworkListener = null
    relaysListener = null
  }

  private fun detachMediaStats() {
    val listener = mediaStatsListener ?: return
    val feature = mediaStatsFeature
    mediaStatsListener = null
    mediaStatsFeature = null
    try {
      // Must be the same feature instance we added to: call.feature() can hand back a
      // fresh wrapper, and removing from that leaves the listener live on a leaving call.
      feature?.removeOnReportReceivedListener(listener)
    } catch (_: Exception) {
    }
  }

  /**
   * Sign in to ACS with a deadline, and make sure nothing survives a missed one.
   *
   * `createCallAgent` returns a future with no timeout of its own, and it is the first thing after
   * the hotspot join that needs the internet. Unbounded, a cellular route that had not validated
   * yet turned into a 30 s stall followed by the join step's own timeout — one opaque failure
   * covering a specific, nameable cause.
   *
   * Do not cancel that future. Cancel marks it done without a value, so the sweeper can no longer
   * recover the native agent ACS still creates. The next join then dies with "CallAgent associated
   * with this identity already exists".
   */
  private fun obtainCallAgent(
    client: CallClient,
    credential: CommunicationTokenCredential,
    options: CallAgentOptions,
    generation: Int,
    waitMs: Long = CALL_AGENT_WAIT_MS,
  ): CallAgent {
    disposeAbandonedAgent(waitMs = ABANDONED_AGENT_REJOIN_WAIT_MS)
    return try {
      awaitCallAgent(client, credential, options, generation, waitMs)
    } catch (error: Exception) {
      if (!AbandonedCallAgent.isExistingAgentError(error)) throw error
      Log.w(TAG, "createCallAgent hit leftover identity; disposing abandoned agent and retrying")
      disposeAbandonedAgent(waitMs = ABANDONED_AGENT_REJOIN_WAIT_MS)
      awaitCallAgent(client, credential, options, generation, waitMs)
    }
  }

  private fun awaitCallAgent(
    client: CallClient,
    credential: CommunicationTokenCredential,
    options: CallAgentOptions,
    generation: Int,
    waitMs: Long,
  ): CallAgent {
    val pending = client.createCallAgent(context, credential, options)
    val agent = try {
      pending.get(waitMs, TimeUnit.MILLISECONDS)
    } catch (timeout: TimeoutException) {
      abandonedAgent = pending
      sweepLateAgent(pending, 0)
      throw IllegalStateException(
        "ACS_AGENT_TIMEOUT: Teams did not finish signing this phone in within " +
          "${waitMs / 1000}s. This step needs the internet, so it usually means mobile " +
          "data had not taken over yet after joining the glasses hotspot.",
        timeout,
      )
    }
    // Belt and braces. Generation only moves on this executor, so a leave cannot land while we are
    // blocked above — but that is an invariant of the current threading, not of this function.
    if (generation != joinGeneration) {
      runCatching { agent.dispose() }
      throw IllegalStateException("ACS_AGENT_STALE: the call was torn down before Teams signed in")
    }
    return agent
  }

  /**
   * Dispose an agent that turns up after its wait was abandoned.
   *
   * Polls rather than chaining a completion callback because the SDK hands back a bare [Future].
   * Gives up after a bounded number of sweeps: by then the process has either got the agent or the
   * future is never completing, and an endless timer is its own leak.
   */
  private fun sweepLateAgent(pending: Future<CallAgent>, sweep: Int) {
    if (sweep >= LATE_AGENT_SWEEPS) {
      Log.w(TAG, "abandoned call agent never completed; stopping sweep")
      return
    }
    executor.schedule({
      if (abandonedAgent !== pending) return@schedule
      val late = AbandonedCallAgent.takeIfDone(pending)
      if (late == null) {
        if (!pending.isDone) sweepLateAgent(pending, sweep + 1)
        return@schedule
      }
      abandonedAgent = null
      Log.w(TAG, "disposing call agent that arrived after its join was abandoned")
      runCatching { late.dispose() }
    }, LATE_AGENT_SWEEP_MS, TimeUnit.MILLISECONDS)
  }

  /**
   * Best-effort dispose of a leftover agent before the next `createCallAgent`.
   *
   * [waitMs] is for rejoin: the previous sign-in may still be finishing, and that is the only
   * handle that can free the identity ACS refuses to share.
   */
  private fun disposeAbandonedAgent(waitMs: Long) {
    val pending = abandonedAgent ?: return
    val late = AbandonedCallAgent.take(pending, waitMs)
    if (late != null) {
      abandonedAgent = null
      Log.w(TAG, "disposing abandoned call agent before the next join")
      runCatching { late.dispose() }
      return
    }
    if (pending.isDone) abandonedAgent = null
  }

  private fun leaveLocked(emitIdle: Boolean = true, keepAgent: Boolean = false) {
    // Invalidate first: a bounded ACS operation still in flight has to find a stale generation
    // rather than attach an agent to a session that is being torn down.
    joinGeneration++
    try {
      ticker.stop()
      detachDiagnostics()
      detachMediaStats()
      detachCapabilities()
      roster.detach()
      phoneMic.setEnabled(false)
      stopUplink()
      incomingPump.reset()
      incomingProbe.reset()
      applier.reset()
      scheduler.cancelPending()
      // Drop buffered voice before the dump: whatever is still in the chain belongs to a call that
      // is over, and the next call builds its own chain rather than inheriting this one.
      uplinkChain?.reset()
      uplinkChain = null
      externalPcmEnabled.set(false)
      pcmBridge?.finishDump()
      // Detach before stop so the teardown's own IDLE transition does not emit a
      // snapshot (or schedule a rebuild) for a call that is going away.
      cancelMediaRestart()
      media.setStateListener(null)
      mediaSource = SourceState.IDLE
      currentSourceKind = SourceKind.WHEP
      media.stop()
      frameSender.detach()
    } catch (error: Exception) {
      Log.w(TAG, "leave cleanup failed", error)
    }
    // Hang up and dispose must be independent: a failed hang-up must not skip
    // dispose, or the ACS agent leaks and the guest stays in the Teams roster.
    if (!keepAgent) {
      try {
        call?.hangUp()?.get()
      } catch (error: Exception) {
        Log.w(TAG, "leave hangUp failed", error)
      }
      try {
        callAgent?.dispose()
      } catch (error: Exception) {
        Log.w(TAG, "leave dispose failed", error)
      }
      disposeAbandonedAgent(waitMs = 0)
      callClient = null
      call = null
      callAgent = null
      agentPrepared = false
    }
    media.stop()
    audioOut = null
    localOut = null
    audioIn = null
    videoOut = null
    outgoingReady.set(false)
    muted.set(false)
    hangUpForEveryone = CapabilityStatus()
    audioSource = "glasses"
    lastSafety = AudioSafety.DEGRADED
    meetingUrl = null
    // Clearing lastError is scoped to the clean idle reset. A failed join tears
    // down with emitIdle=false and relies on lastError staying set so emit("error")
    // still carries it and pushCallState keeps ignoring late disconnected callbacks.
    if (emitIdle) {
      lastError = null
      emit("idle")
    }
  }

  private inner class SessionAudioController : AudioStreamController {
    override fun readActive(): ActiveStreamKind {
      val stream = call?.activeOutgoingAudioStream ?: return ActiveStreamKind.NONE
      if (stream.state != AudioStreamState.STARTED) return ActiveStreamKind.NONE
      return when (stream.type) {
        AudioStreamType.VIRTUAL_OUTGOING -> ActiveStreamKind.VIRTUAL
        AudioStreamType.LOCAL_OUTGOING -> ActiveStreamKind.LOCAL
        else -> ActiveStreamKind.NONE
      }
    }

    override fun isPhysicallyMuted(): Boolean? = call?.isOutgoingAudioMuted

    override fun setGlassesPcmEnabled(enabled: Boolean) {
      val routing = GlassesPcmRouting.decide(softap = currentSourceKind == SourceKind.SOFTAP, enabled = enabled)
      externalPcmEnabled.set(routing.externalPcm)
      media.setPcmDeliveryEnabled(routing.relayPcm)
    }

    override fun setPhonePcmEnabled(enabled: Boolean) {
      phoneMic.setEnabled(enabled)
    }

    override fun mutePhysical(): Result<Unit> {
      val c = CallGuard.require(call).getOrElse { return Result.failure(it) }
      return runCatching { c.muteOutgoingAudio(context).get() }
    }

    override fun unmutePhysical(): Result<Unit> {
      val c = CallGuard.require(call).getOrElse { return Result.failure(it) }
      return runCatching { c.unmuteOutgoingAudio(context).get() }
    }

    override fun stopActive(): Result<Unit> {
      val c = CallGuard.require(call).getOrElse { return Result.failure(it) }
      val stream = c.activeOutgoingAudioStream
        ?: return Result.failure(IllegalStateException("no active stream"))
      return runCatching { c.stopAudio(context, stream).get() }
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    const val GLASSES_REQUIRES_UNMUTED_TRANSPORT = true
    private const val ROSTER_COALESCE_MS = 150L
    private const val MEDIA_RESTART_BASE_MS = 1_000L
    private const val MEDIA_RESTART_MAX_MS = 10_000L
    /** SoftAP join() blocks until the WHIP listener is bound and ACS join is queued. */
    private const val SOFTAP_JOIN_WAIT_MS = 45_000L

    /**
     * How long End waits for ACS to accept the hang-up before reporting it unconfirmed. Local
     * teardown runs either way; this only bounds how long the wearer stares at a confirm sheet.
     */
    private const val END_FOR_EVERYONE_WAIT_MS = 15_000L

    /**
     * How long to wait for ACS to hand back a call agent.
     *
     * Well inside [SOFTAP_JOIN_WAIT_MS] on purpose: this step needs the internet, and the hotspot
     * join just changed which network provides it. On device it stalled 30 s here and then blew the
     * whole join budget, so the wearer got one useless timeout instead of a nameable failure.
     */
    private const val CALL_AGENT_WAIT_MS = 20_000L

    /**
     * How long [prepareAgent] waits, which is longer than [CALL_AGENT_WAIT_MS] and does not need to
     * fit any other budget: nothing is joined or held while it runs, so overrunning costs a slower
     * join rather than a hotspot the wearer then has to leave.
     *
     * Sized off a cold sign-in measured at ~35 s on a 544 ms-RTT AP.
     */
    private const val PREPARE_AGENT_WAIT_MS = 60_000L

    /** How long to keep sweeping for an agent that arrives after its wait was abandoned. */
    private const val LATE_AGENT_SWEEP_MS = 5_000L
    private const val LATE_AGENT_SWEEPS = 12
    /**
     * How long a rejoin waits for the abandoned sign-in to finish so we can dispose it. Shorter
     * than [CALL_AGENT_WAIT_MS]: the leftover agent is usually already done, and blocking the
     * wearer again for a full sign-in would hide a stuck Future.
     */
    private const val ABANDONED_AGENT_REJOIN_WAIT_MS = 8_000L

    fun sampleRateHz(rate: AudioStreamSampleRate?): Int? = when (rate) {
      AudioStreamSampleRate.HZ_16000 -> 16000
      AudioStreamSampleRate.HZ_22050 -> 22050
      AudioStreamSampleRate.HZ_24000 -> 24000
      AudioStreamSampleRate.HZ_32000 -> 32000
      AudioStreamSampleRate.HZ_44100 -> 44100
      AudioStreamSampleRate.HZ_48000 -> 48000
      null -> null
    }

    private fun describeEndReason(call: Call?): Map<String, Any?> {
      if (call == null) return mapOf("hasCall" to false)
      return try {
        val getter = call.javaClass.methods.firstOrNull {
          it.name == "getCallEndReason" || it.name == "getEndReason"
        }
        val reason = getter?.invoke(call) ?: return mapOf("hasCall" to true, "endReason" to "null")
        val methods = reason.javaClass.methods
        fun pick(vararg names: String): Any? =
          names.firstNotNullOfOrNull { name -> methods.firstOrNull { it.name == name && it.parameterCount == 0 }?.invoke(reason) }
        val message = pick("getMessage")?.toString()?.take(120)
        mapOf(
          "hasCall" to true,
          "code" to pick("getCode"),
          "subcode" to pick("getSubcode", "getSubCode"),
          "message" to message,
        )
      } catch (error: Throwable) {
        mapOf("hasCall" to true, "endReasonError" to "${error.javaClass.simpleName}:${error.message ?: ""}")
      }
    }

    private fun formatAcsError(error: Throwable): String {
      val parts = linkedSetOf<String>()
      var current: Throwable? = error
      var depth = 0
      while (current != null && depth < 4) {
        val message = current.message?.trim().orEmpty()
        val piece = if (message.isNotEmpty()) "${current.javaClass.simpleName}: $message" else current.javaClass.simpleName
        parts.add(piece)
        current = current.cause
        depth += 1
      }
      return parts.joinToString(" | ").ifBlank { "ACS join failed" }
    }
  }
}
