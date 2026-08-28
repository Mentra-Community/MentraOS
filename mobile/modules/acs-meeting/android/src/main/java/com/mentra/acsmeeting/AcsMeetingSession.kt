package com.mentra.acsmeeting

import android.content.Context
import android.util.Log
import com.azure.android.communication.calling.AudioStreamBufferDuration
import com.azure.android.communication.calling.AudioStreamChannelMode
import com.azure.android.communication.calling.AudioStreamFormat
import com.azure.android.communication.calling.AudioStreamSampleRate
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.CallAgent
import com.azure.android.communication.calling.CallAgentOptions
import com.azure.android.communication.calling.CallClient
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.IncomingAudioOptions
import com.azure.android.communication.calling.IncomingMixedAudioEvent
import com.azure.android.communication.calling.JoinCallOptions
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
import java.util.concurrent.atomic.AtomicBoolean

class AcsMeetingSession(
  private val context: Context,
  private val onState: (Map<String, Any>) -> Unit,
  private val onIncomingPcm: (String, Int, Int) -> Unit,
) {
  private val executor = Executors.newSingleThreadExecutor()
  private val outgoingReady = AtomicBoolean(false)
  private val muted = AtomicBoolean(false)
  private val frameSender = AcsFrameSender()
  @Volatile private var lastGatedLogMs = 0L
  @Volatile private var lastSentLogMs = 0L
  private var pcmBridge: PcmBridge? = null
  private var whep: WhepVideoSource? = null
  private var callClient: CallClient? = null
  private var callAgent: CallAgent? = null
  private var call: Call? = null
  private var audioOut: RawOutgoingAudioStream? = null
  private var audioIn: RawIncomingAudioStream? = null
  private var videoOut: VirtualOutgoingVideoStream? = null
  @Volatile private var meetingUrl: String? = null
  @Volatile private var phase = "idle"
  @Volatile private var lastError: String? = null
  /** "glasses" = WHEP PCM into ACS. "phone" = ACS local mic (handset or BT). */
  @Volatile private var audioSource = "glasses"

  fun snapshot(): Map<String, Any> {
    val result = mutableMapOf<String, Any>(
      "state" to phase,
      "muted" to muted.get(),
      "provider" to "acs-teams",
      "audioSource" to audioSource,
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
    this.audioSource = if (audioSource == "phone") "phone" else "glasses"
    executor.execute {
      try {
        leaveLocked()
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

        val joinOptions = JoinCallOptions()
        val ov = OutgoingVideoOptions().setOutgoingVideoStreams(listOf(videoStream))
        joinOptions.setOutgoingVideoOptions(ov)
        val oa = OutgoingAudioOptions()
          .setStream(outgoing)
          .setMuted(true)
          .setCommunicationAudioModeEnabled(this.audioSource == "phone")
        joinOptions.setOutgoingAudioOptions(oa)
        val ia = IncomingAudioOptions()
          .setStream(incoming)
          .setMuted(true)
        joinOptions.setIncomingAudioOptions(ia)

        val locator = TeamsMeetingLinkLocator(teamsUrl)
        val joined = callAgent!!.join(context, locator, joinOptions)
        call = joined
        joined.addOnStateChangedListener { pushCallState(joined.state) }
        pushCallState(joined.state)

        whep = WhepVideoSource(
          context,
          videoListener = { rgba, width, height, _ -> frameSender.sendRgba(rgba, width, height) },
          pcmListener = { pcm, rate, channels -> feedOutgoingPcm(pcm, rate, channels) },
        )
        whep!!.start(whepUrl)
        applyAudioPolicyLocked()
        Log.i(TAG, "P2 ACS join started for Teams locator source=${this.audioSource}")
      } catch (error: Exception) {
        lastError = formatAcsError(error)
        Log.e(TAG, "join failed $lastError", error)
        emit("error")
      }
    }
  }

  fun updateVideoSource(whepUrl: String) {
    executor.execute { whep?.updateUrl(whepUrl) }
  }

  fun setMuted(next: Boolean): Map<String, Any> {
    muted.set(next)
    executor.execute { applyAudioPolicyLocked() }
    val snap = snapshot()
    onState(snap)
    return snap
  }

  fun setAudioSource(source: String): Map<String, Any> {
    audioSource = if (source == "phone") "phone" else "glasses"
    executor.execute { applyAudioPolicyLocked() }
    val snap = snapshot()
    onState(snap)
    return snap
  }

  fun leave() {
    executor.execute { leaveLocked() }
  }

  fun getState(): Map<String, Any> = snapshot()

  private fun applyAudioPolicyLocked() {
    val sendGlasses = !muted.get() && audioSource == "glasses"
    val sendPhone = !muted.get() && audioSource == "phone"
    whep?.setPcmEnabled(sendGlasses)
    Log.i(
      TAG,
      "audio policy source=$audioSource userMuted=${muted.get()} glassesPcm=$sendGlasses phoneMic=$sendPhone",
    )
    try {
      if (sendPhone) call?.unmuteOutgoingAudio(context)?.get() else call?.muteOutgoingAudio(context)?.get()
    } catch (error: Exception) {
      Log.w(TAG, "SDK phone-mic mute policy failed", error)
    }
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
    phase = when (state) {
      CallState.CONNECTING -> "connecting"
      CallState.IN_LOBBY -> "lobby"
      CallState.CONNECTED -> "connected"
      CallState.DISCONNECTING -> "disconnected"
      CallState.DISCONNECTED -> "disconnected"
      else -> phase
    }
    Log.i(TAG, "ACS call state=$state phase=$phase")
    onState(snapshot())
  }

  private fun emit(next: String) {
    phase = next
    onState(snapshot())
  }

  private fun leaveLocked() {
    try {
      pcmBridge?.finishDump()
      whep?.stop()
      frameSender.detach()
      call?.hangUp()?.get()
      callAgent?.dispose()
      callClient = null
    } catch (error: Exception) {
      Log.w(TAG, "leave failed", error)
    } finally {
      whep = null
      call = null
      callAgent = null
      audioOut = null
      audioIn = null
      videoOut = null
      outgoingReady.set(false)
      muted.set(false)
      meetingUrl = null
      emit("idle")
    }
  }

  companion object {
    private const val TAG = "ACS-SPIKE"

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
