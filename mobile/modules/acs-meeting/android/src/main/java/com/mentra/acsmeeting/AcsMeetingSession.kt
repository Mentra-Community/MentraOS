package com.mentra.acsmeeting

import android.content.Context
import android.util.Log
import com.azure.android.communication.calling.AudioStreamChannelMode
import com.azure.android.communication.calling.AudioStreamSampleRate
import com.azure.android.communication.calling.AudioStreamSampleType
import com.azure.android.communication.calling.Call
import com.azure.android.communication.calling.CallAgent
import com.azure.android.communication.calling.CallAgentOptions
import com.azure.android.communication.calling.CallClient
import com.azure.android.communication.calling.CallState
import com.azure.android.communication.calling.IncomingAudioOptions
import com.azure.android.communication.calling.JoinCallOptions
import com.azure.android.communication.calling.OutgoingAudioOptions
import com.azure.android.communication.calling.OutgoingVideoOptions
import com.azure.android.communication.calling.RawIncomingAudioStream
import com.azure.android.communication.calling.RawIncomingAudioStreamOptions
import com.azure.android.communication.calling.RawOutgoingAudioStream
import com.azure.android.communication.calling.RawOutgoingAudioStreamOptions
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

  fun snapshot(): Map<String, Any> {
    val result = mutableMapOf<String, Any>(
      "state" to phase,
      "muted" to muted.get(),
      "provider" to "acs-teams",
    )
    meetingUrl?.let { result["meetingUrl"] = it }
    lastError?.let { result["error"] = it }
    return result
  }

  fun join(token: String, teamsUrl: String, whepUrl: String, displayName: String?, dumpWav: Boolean) {
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

        val audioFormat = com.azure.android.communication.calling.AudioStreamFormat()
        audioFormat.sampleRate = AudioStreamSampleRate.SAMPLE_RATE_16000
        audioFormat.channelMode = AudioStreamChannelMode.CHANNEL_MODE_MONO
        audioFormat.encodedAudioFormat = AudioStreamSampleType.PCM

        val outAudioOptions = RawOutgoingAudioStreamOptions()
        outAudioOptions.format = audioFormat
        val outgoing = RawOutgoingAudioStream(outAudioOptions)
        audioOut = outgoing
        outgoing.addOnStateChangedListener {
          outgoingReady.set(outgoing.state.toString().contains("STARTED", ignoreCase = true))
          Log.i(TAG, "raw outgoing audio state=${outgoing.state}")
        }

        val inAudioOptions = RawIncomingAudioStreamOptions()
        inAudioOptions.format = audioFormat
        val incoming = RawIncomingAudioStream(inAudioOptions)
        audioIn = incoming
        incoming.addOnRawAudioBufferReceivedListener { args ->
          try {
            val data = args.audioBuffer?.data ?: return@addOnRawAudioBufferReceivedListener
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            onIncomingPcm(PcmBridge.encodeBase64(bytes), 16000, 1)
          } catch (error: Exception) {
            Log.w(TAG, "incoming PCM callback failed", error)
          }
        }

        val joinOptions = JoinCallOptions()
        val ov = OutgoingVideoOptions()
        ov.streams = listOf(videoStream)
        joinOptions.outgoingVideoOptions = ov
        val oa = OutgoingAudioOptions()
        oa.stream = outgoing
        mutePhoneMicrophone(oa)
        joinOptions.outgoingAudioOptions = oa
        val ia = IncomingAudioOptions()
        ia.stream = incoming
        joinOptions.incomingAudioOptions = ia

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
        Log.i(TAG, "P2 ACS join started for Teams locator")
      } catch (error: Exception) {
        Log.e(TAG, "join failed", error)
        lastError = error.message ?: "ACS join failed"
        emit("error")
      }
    }
  }

  fun updateVideoSource(whepUrl: String) {
    executor.execute { whep?.updateUrl(whepUrl) }
  }

  fun setMuted(next: Boolean): Map<String, Any> {
    muted.set(next)
    executor.execute {
      try {
        if (next) call?.mute()?.get() else call?.unmute()?.get()
      } catch (error: Exception) {
        Log.w(TAG, "SDK mute failed (raw PCM gate still applies)", error)
      }
    }
    val snap = snapshot()
    onState(snap)
    return snap
  }

  fun leave() {
    executor.execute { leaveLocked() }
  }

  fun getState(): Map<String, Any> = snapshot()

  private fun feedOutgoingPcm(pcm: ByteArray, sampleRate: Int, channels: Int) {
    if (muted.get()) return
    val stream = audioOut ?: return
    if (!outgoingReady.get()) return
    val frames = pcmBridge?.ingest(pcm, sampleRate, channels) ?: return
    for (frame in frames) {
      try {
        val buffer = com.azure.android.communication.calling.RawAudioBuffer()
        buffer.data = ByteBuffer.wrap(frame)
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

    /** Raw outgoing audio is the wearer mic. Do not also capture the phone mic. */
    private fun mutePhoneMicrophone(options: OutgoingAudioOptions) {
      try {
        val setter = options.javaClass.methods.firstOrNull { method ->
          method.name.equals("setMuted", ignoreCase = true) && method.parameterTypes.size == 1
        }
        setter?.invoke(options, true)
      } catch (error: Exception) {
        Log.w(TAG, "could not mute phone microphone capture", error)
      }
    }
  }
}
