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
import com.azure.android.communication.calling.IncomingAudioOptions
import com.azure.android.communication.calling.IncomingMixedAudioEvent
import com.azure.android.communication.calling.JoinCallOptions
import com.azure.android.communication.calling.LocalOutgoingAudioStream
import com.azure.android.communication.calling.OutgoingAudioOptions
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
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.atomic.AtomicBoolean

class AcsMeetingSession(
  private val context: Context,
  private val onState: (Map<String, Any>) -> Unit,
  private val onIncomingPcm: (String, Int, Int) -> Unit,
  mediaSourceFactory: GlassesMediaSourceFactory = GlassesMediaSourceFactory { video, pcm ->
    CloudflareWhepSource(context, video, pcm)
  },
) {
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val scheduler = ExecutorPolicyScheduler(executor)
  private val outgoingReady = AtomicBoolean(false)
  private val muted = AtomicBoolean(false)
  private val frameSender = AcsFrameSender()
  @Volatile private var lastGatedLogMs = 0L
  @Volatile private var lastSentLogMs = 0L
  private var pcmBridge: PcmBridge? = null
  private val media = GlassesMediaController(mediaSourceFactory)
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

        val videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = listOf(AcsFrameSender.rgbaFormat())
        val videoStream = VirtualOutgoingVideoStream(videoOptions)
        videoOut = videoStream
        frameSender.attach(videoStream)

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
          try {
            val data = event.audioBuffer?.buffer ?: return@addOnMixedAudioBufferReceivedListener
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            onIncomingPcm(PcmBridge.encodeBase64(bytes), 16000, 1)
          } catch (error: Exception) {
            Log.w(TAG, "incoming PCM callback failed", error)
          }
        }

        val desired = desiredKind()
        val plan = AcsAudioPolicy.planJoin(desired, muted.get(), GLASSES_REQUIRES_UNMUTED_TRANSPORT)
        val joinOptions = JoinCallOptions()
        val ov = OutgoingVideoOptions().setOutgoingVideoStreams(listOf(videoStream))
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
        val joined = callAgent!!.join(context, locator, joinOptions)
        call = joined
        joined.addOnStateChangedListener { pushCallState(joined.state) }
        joined.addOnOutgoingAudioStateChangedListener {
          Log.i(TAG, "outgoing audio state changed muted=${joined.isOutgoingAudioMuted}")
          applyAudioPolicy("outgoing-audio-state")
        }
        pushCallState(joined.state)

        media.attach(
          video = { rgba, width, height, _ -> frameSender.sendRgba(rgba, width, height) },
          pcm = { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) },
          config = SourceConfig(whepUrl),
        )
        applyAudioPolicy("join")
        Log.i(TAG, "ACS join started source=${this.audioSource} armVirtual=${plan.armVirtual} transportMuted=${plan.transportMuted}")
      } catch (error: Exception) {
        lastError = formatAcsError(error)
        Log.e(TAG, "join failed $lastError", error)
        emit("error")
      }
    }
  }

  fun updateVideoSource(whepUrl: String) {
    executor.execute { media.restart(SourceConfig(whepUrl)) }
  }

  fun setMuted(next: Boolean): Map<String, Any> {
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
    Log.i(TAG, "ACS call state=$state phase=$phase")
    if (phase == "connected" && previous != "connected") {
      applyAudioPolicy("call-connected")
    } else {
      onState(snapshot())
    }
  }

  private fun emit(next: String) {
    phase = next
    onState(snapshot())
  }

  private fun leaveLocked() {
    try {
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
