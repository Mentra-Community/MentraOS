package com.mentra.acsmeeting

import android.content.Context
import android.util.Log
import com.azure.android.communication.calling.AudioStreamBufferDuration
import com.azure.android.communication.calling.AudioStreamChannelMode
import com.azure.android.communication.calling.AudioStreamFormat
import com.azure.android.communication.calling.AudioStreamSampleRate
import com.azure.android.communication.calling.AudioStreamState
import com.azure.android.communication.calling.AudioStreamType
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.CallAgent
import com.azure.android.communication.calling.CallAgentOptions
import com.azure.android.communication.calling.CallClient
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.Features
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
import com.azure.android.communication.calling.RawAudioBuffer
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
import com.mentra.acsmeeting.audio.CallGuard
import com.mentra.acsmeeting.audio.ExecutorPolicyScheduler
import com.mentra.acsmeeting.audio.PcmBridge
import com.mentra.acsmeeting.source.AcsInvestigation
import com.mentra.acsmeeting.source.CloudflareWhepSource
import com.mentra.acsmeeting.source.GlassesMediaController
import com.mentra.acsmeeting.source.GlassesMediaSourceFactory
import com.mentra.acsmeeting.source.SourceConfig
import com.mentra.acsmeeting.source.SourceKind
import com.mentra.acsmeeting.source.SyntheticI420Source
import com.mentra.acsmeeting.source.TargetSize
import com.mentra.acsmeeting.source.VideoSourceArm
import com.mentra.acsmeeting.telemetry.AcsDebugLog
import com.mentra.acsmeeting.telemetry.PipelineStats
import com.mentra.acsmeeting.telemetry.PipelineTicker
import com.mentra.acsmeeting.video.AcsFrameSender
import com.mentra.acsmeeting.video.VideoProfile
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.atomic.AtomicBoolean

class AcsMeetingSession(
  private val context: Context,
  private val onState: (Map<String, Any>) -> Unit,
  private val onIncomingPcm: (String, Int, Int) -> Unit,
  mediaSourceFactory: GlassesMediaSourceFactory? = null,
) {
  internal val stats = PipelineStats()
  private val ticker = PipelineTicker(stats) {
    Log.i(TAG, it)
    // #region agent log
    AcsDebugLog.emitJson(
      "F", "AcsMeetingSession.kt:ticker", "phone pipeline ladder",
      org.json.JSONObject()
        .put("ladder", it)
        .put("sinkCum", stats.sinkCount())
        .put("subCum", stats.subCount())
        .put("dropCum", stats.dropCount())
        .put("abandonedCum", stats.abandonedCount())
        .put("inFlight", stats.inFlightCount()),
    )
    // #endregion
  }
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val scheduler = ExecutorPolicyScheduler(executor)
  private val outgoingReady = AtomicBoolean(false)
  private val muted = AtomicBoolean(false)
  private val frameSender = AcsFrameSender(stats)
  private val profile = VideoProfile.DEFAULT
  private val resolvedFactory = mediaSourceFactory ?: GlassesMediaSourceFactory { video, pcm ->
    when (AcsInvestigation.videoArm) {
      VideoSourceArm.SYNTHETIC -> SyntheticI420Source(video, stats, frameSender::isReady)
      VideoSourceArm.WHEP -> CloudflareWhepSource(context, video, pcm, stats)
    }
  }
  @Volatile private var lastGatedLogMs = 0L
  @Volatile private var lastSentLogMs = 0L
  private var pcmBridge: PcmBridge? = null
  private val media = GlassesMediaController(resolvedFactory)
  private var mediaStatsListener: MediaStatisticsReportReceivedListener? = null
  private var mediaStatsFeature: MediaStatisticsCallFeature? = null
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
  @Volatile private var lastSafety = AudioSafety.DEGRADED
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
    )
    meetingUrl?.let { result["meetingUrl"] = it }
    lastError?.let { result["error"] = it }
    describeEndReason(call).forEach { (key, value) ->
      if (value != null) result["endReason_$key"] = value
    }
    return result
  }

  fun join(
    token: String,
    teamsUrl: String,
    whepUrl: String,
    displayName: String?,
    dumpWav: Boolean,
    audioSource: String = "glasses",
  ) {
    val parsed = AcsAudioPolicy.parseSource(audioSource)
    if (parsed == null) {
      Log.w(TAG, "unknown audioSource=$audioSource, arming glasses (no local mic)")
    }
    this.audioSource = if (parsed == AudioSourceKind.PHONE) "phone" else "glasses"
    executor.execute {
      try {
        val t0 = System.currentTimeMillis()
        // #region agent log
        AcsDebugLog.emit("B", "AcsMeetingSession.kt:join", "executor start before leaveLocked", mapOf(
          "phase" to phase,
          "hasCall" to (call != null),
          "audioSource" to this.audioSource,
        ))
        // #endregion
        leaveLocked()
        this.audioSource = if (parsed == AudioSourceKind.PHONE) "phone" else "glasses"
        meetingUrl = teamsUrl
        lastError = null
        emit("connecting")
        pcmBridge = PcmBridge(context.cacheDir, dumpWav)
        val credential = CommunicationTokenCredential(token)
        callClient = CallClient()
        val agentOptions = CallAgentOptions()
        agentOptions.displayName = displayName ?: "Mentra Call"
        callAgent = callClient!!.createCallAgent(context, credential, agentOptions).get()
        // #region agent log
        AcsDebugLog.emit("C", "AcsMeetingSession.kt:join", "createCallAgent ok", mapOf(
          "elapsedMs" to (System.currentTimeMillis() - t0),
          "tokenChars" to token.length,
        ))
        // #endregion

        val videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = listOf(AcsFrameSender.i420Format(profile))
        val videoStream = VirtualOutgoingVideoStream(videoOptions)
        videoOut = videoStream
        frameSender.attach(videoStream) { size -> media.setTargetSize(size) }

        val audioProperties = RawOutgoingAudioStreamProperties()
          .setFormat(AudioStreamFormat.PCM16_BIT)
          .setSampleRate(AudioStreamSampleRate.HZ_16000)
          .setChannelMode(AudioStreamChannelMode.MONO)
          .setBufferDuration(AudioStreamBufferDuration.MS20)
        val outAudioOptions = RawOutgoingAudioStreamOptions().setProperties(audioProperties)
        val outgoing = RawOutgoingAudioStream(outAudioOptions)
        audioOut = outgoing
        outgoing.addOnStateChangedListener {
          outgoingReady.set(outgoing.state.toString().contains("STARTED", ignoreCase = true))
          Log.i(TAG, "raw outgoing audio state=${outgoing.state}")
          applyAudioPolicy("virtual-stream-state")
        }

        val local = LocalOutgoingAudioStream()
        localOut = local
        local.addOnStateChangedListener {
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
        incoming.addOnMixedAudioBufferReceivedListener { event: IncomingMixedAudioEvent ->
          if (AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC) return@addOnMixedAudioBufferReceivedListener
          try {
            val data = event.audioBuffer?.buffer ?: return@addOnMixedAudioBufferReceivedListener
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            onIncomingPcm(PcmBridge.encodeBase64(bytes), 16000, 1)
          } catch (error: Exception) {
            Log.w(TAG, "incoming PCM callback failed", error)
          }
        }

        val synthetic = AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC
        if (synthetic) muted.set(true)
        val desired = desiredKind()
        val plan = if (synthetic) {
          JoinAudioPlan(armVirtual = true, transportMuted = true)
        } else {
          AcsAudioPolicy.planJoin(desired, muted.get(), GLASSES_REQUIRES_UNMUTED_TRANSPORT)
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
        val oa = OutgoingAudioOptions()
          .setStream(if (plan.armVirtual) outgoing else local)
          .setMuted(plan.transportMuted)
          .setCommunicationAudioModeEnabled(!plan.armVirtual)
        joinOptions.setOutgoingAudioOptions(oa)
        val ia = IncomingAudioOptions()
          .setStream(incoming)
          .setMuted(true)
        joinOptions.setIncomingAudioOptions(ia)

        val locator = TeamsMeetingLinkLocator(teamsUrl)
        val host = try { java.net.URI(teamsUrl).host ?: "none" } catch (_: Exception) { "parse-fail" }
        val joined = callAgent!!.join(context, locator, joinOptions)
        call = joined
        // #region agent log
        Log.i(TAG, "ACS teams meeting link=$teamsUrl")
        AcsDebugLog.emit("A", "AcsMeetingSession.kt:join", "callAgent.join returned", mapOf(
          "acsState" to joined.state.toString(),
          "host" to host,
          "teamsUrl" to teamsUrl,
          "urlChars" to teamsUrl.length,
          "armVirtual" to plan.armVirtual,
          "transportMuted" to plan.transportMuted,
          "elapsedMs" to (System.currentTimeMillis() - t0),
        ))
        // #endregion
        joined.addOnStateChangedListener { pushCallState(joined.state) }
        joined.addOnOutgoingAudioStateChangedListener {
          Log.i(TAG, "outgoing audio state changed muted=${joined.isOutgoingAudioMuted}")
          applyAudioPolicy("outgoing-audio-state")
        }
        pushCallState(joined.state)

        stats.arm = if (synthetic) "synthetic" else "whep"
        media.attach(
          video = { i420, width, height, timestampNs ->
            frameSender.sendI420(i420, width, height, timestampNs)
          },
          pcm = { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) },
          config = SourceConfig(
            url = whepUrl,
            kind = if (synthetic) SourceKind.DIRECT else SourceKind.WHEP,
          ),
        )
        media.setTargetSize(TargetSize(profile.width, profile.height))
        ticker.start()
        applyAudioPolicy("join")
        Log.i(
          TAG,
          "ACS join started arm=${AcsInvestigation.videoArm.name.lowercase()} " +
            "profile=${profile.width}x${profile.height}@${profile.fps} " +
            "maxBitrate=${profile.maxBitrateBps} bitsPerFrame=${profile.bitsPerFrame()} " +
            "syntheticFps=${AcsInvestigation.syntheticFps} entropy=${AcsInvestigation.syntheticEntropy} " +
            "source=${this.audioSource} audio=${if (synthetic) "off" else "on"} " +
            "armVirtual=${plan.armVirtual} transportMuted=${plan.transportMuted}",
        )
      } catch (error: Exception) {
        lastError = formatAcsError(error)
        Log.e(TAG, "join failed $lastError", error)
        // #region agent log
        AcsDebugLog.emit("C", "AcsMeetingSession.kt:join", "join threw", mapOf("error" to lastError))
        // #endregion
        emit("error")
      }
    }
  }

  fun updateVideoSource(whepUrl: String) {
    executor.execute { media.restart(SourceConfig(whepUrl)) }
  }

  fun setMuted(next: Boolean): Map<String, Any> {
    if (AcsInvestigation.videoArm == VideoSourceArm.SYNTHETIC) {
      muted.set(true)
      return snapshot()
    }
    muted.set(next)
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

  private fun feedOutgoingPcm(pcm: ByteArray, sampleRate: Int, channels: Int) {
    if (muted.get() || audioSource != "glasses") {
      val now = System.currentTimeMillis()
      if (now - lastGatedLogMs >= 1000) {
        lastGatedLogMs = now
        val why = if (muted.get()) "user muted" else "audioSource=$audioSource"
        Log.i(TAG, "outgoing PCM gated bytes=${pcm.size} ($why)")
      }
      return
    }
    val stream = audioOut ?: return
    if (!outgoingReady.get()) return
    val frames = pcmBridge?.ingest(pcm, sampleRate, channels) ?: return
    val now = System.currentTimeMillis()
    if (now - lastSentLogMs >= 1000) {
      lastSentLogMs = now
      Log.i(TAG, "outgoing PCM sent bytes=${pcm.size} rate=$sampleRate (glasses WHEP)")
    }
    for (frame in frames) {
      try {
        val buffer = RawAudioBuffer()
        val direct = ByteBuffer.allocateDirect(frame.size)
        direct.put(frame)
        direct.flip()
        buffer.buffer = direct
        stream.sendRawAudioBuffer(buffer)
      } catch (error: Exception) {
        Log.w(TAG, "sendRawAudioBuffer failed", error)
        break
      }
    }
  }

  private fun pushCallState(state: CallState) {
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
    // #region agent log
    AcsDebugLog.emit(
      if (state == CallState.DISCONNECTED || state == CallState.DISCONNECTING) "A" else "D",
      "AcsMeetingSession.kt:pushCallState",
      "call state",
      mapOf("acsState" to state.toString(), "phase" to phase, "previous" to previous) + end,
    )
    // #endregion
    if (phase == "connected" && previous != "connected") {
      call?.let {
        attachMediaStats(it)
        attachDiagnostics(it)
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
    try {
      val feature = joined.feature(Features.MEDIA_STATISTICS)
      val listener = MediaStatisticsReportReceivedListener { event ->
        val video = event.report?.outgoingStatistics?.videoStatistics?.firstOrNull()
        stats.wireFps = video?.frameRate?.toDouble()
        val width = video?.frameWidth
        val height = video?.frameHeight
        if (width != null && height != null && width > 0 && height > 0) {
          stats.setSize(width, height)
        }
        // #region agent log
        // Hypothesis F: is the `wire` collapse real ACS backpressure, or just a
        // slow report interval? Stamp every report arrival with its own clock.
        AcsDebugLog.emitJson(
          "F", "AcsMeetingSession.kt:attachMediaStats", "acs media statistics report",
          org.json.JSONObject()
            .put("frameRate", video?.frameRate ?: org.json.JSONObject.NULL)
            .put("frameWidth", width ?: org.json.JSONObject.NULL)
            .put("frameHeight", height ?: org.json.JSONObject.NULL)
            .put("bitrateInBps", video?.bitrateInBps ?: org.json.JSONObject.NULL)
            .put("packetCount", video?.packetCount ?: org.json.JSONObject.NULL)
            .put("codecName", video?.codecName ?: org.json.JSONObject.NULL)
            .put("videoStreamCount", event.report?.outgoingStatistics?.videoStatistics?.size ?: -1)
            .put("lastUpdatedAt", event.report?.lastUpdatedAt?.toString() ?: "na"),
        )
        // #endregion
      }
      feature.addOnReportReceivedListener(listener)
      mediaStatsListener = listener
      mediaStatsFeature = feature
      // Interval is a tuning knob, not a prerequisite. It throws while the call is
      // still CONNECTING; losing it must not cost us the listener.
      val interval = try {
        feature.updateReportIntervalInSeconds(1)
        "1s"
      } catch (error: Exception) {
        "default (${error.javaClass.simpleName})"
      }
      Log.i(TAG, "P6 wire hop attached interval=$interval")
    } catch (error: Exception) {
      Log.w(TAG, "MEDIA_STATISTICS attach failed", error)
    }
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
        logDiagnostic("networkSendQuality", args.value?.name ?: "null")
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
    // #region agent log
    AcsDebugLog.emit("G", "AcsMeetingSession.kt:attachDiagnostics", "acs user facing diagnostic", mapOf(
      "diagnostic" to name,
      "value" to value,
    ))
    // #endregion
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

  private fun leaveLocked() {
    // #region agent log
    AcsDebugLog.emit("B", "AcsMeetingSession.kt:leaveLocked", "leaveLocked", mapOf(
      "phase" to phase,
      "hasCall" to (call != null),
      "hasAgent" to (callAgent != null),
    ))
    // #endregion
    try {
      ticker.stop()
      detachDiagnostics()
      detachMediaStats()
      applier.reset()
      scheduler.cancelPending()
      pcmBridge?.finishDump()
      media.stop()
      frameSender.detach()
    } catch (error: Exception) {
      Log.w(TAG, "leave cleanup failed", error)
    }
    // Hang up and dispose must be independent: a failed hang-up must not skip
    // dispose, or the ACS agent leaks and the guest stays in the Teams roster.
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
    callClient = null
    media.stop()
    call = null
    callAgent = null
    audioOut = null
    localOut = null
    audioIn = null
    videoOut = null
    outgoingReady.set(false)
    muted.set(false)
    audioSource = "glasses"
    lastSafety = AudioSafety.DEGRADED
    meetingUrl = null
    emit("idle")
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
      media.setPcmDeliveryEnabled(enabled)
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
