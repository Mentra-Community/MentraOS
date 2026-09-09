package com.mentra.acsmeeting

import com.mentra.acsmeeting.video.VideoProfile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AcsMeetingModule : Module() {
  private var session: AcsMeetingSession? = null

  override fun definition() = ModuleDefinition {
    Name("MentraAcsMeeting")
    Events("onState", "onIncomingPcm")

    AsyncFunction("join") { options: Map<String, Any?> ->
      val token = options["token"] as? String ?: throw IllegalArgumentException("token is required")
      val meetingUrl = options["meetingUrl"] as? String ?: throw IllegalArgumentException("meetingUrl is required")
      val whepUrl = options["whepUrl"] as? String ?: throw IllegalArgumentException("whepUrl is required")
      val displayName = options["displayName"] as? String
      val dumpWav = options["dumpPcmWav"] as? Boolean ?: false
      val audioSource = options["audioSource"] as? String ?: "glasses"
      val video = parseVideo(options["video"])
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      val meeting = session ?: AcsMeetingSession(
        context.applicationContext,
        onState = { sendEvent("onState", it) },
        onIncomingPcm = { base64, rate, channels ->
          sendEvent(
            "onIncomingPcm",
            mapOf("base64" to base64, "sampleRate" to rate, "channels" to channels),
          )
        },
      ).also { session = it }
      meeting.join(token, meetingUrl, whepUrl, displayName, dumpWav, audioSource, video)
      meeting.getState()
    }

    AsyncFunction("leave") {
      session?.leave()
    }

    AsyncFunction("setMuted") { muted: Boolean ->
      session?.setMuted(muted) ?: mapOf("state" to "idle", "muted" to muted)
    }

    AsyncFunction("setAudioSource") { source: String ->
      session?.setAudioSource(source) ?: mapOf("state" to "idle", "muted" to false, "audioSource" to source)
    }

    AsyncFunction("updateVideoSource") { whepUrl: String ->
      session?.updateVideoSource(whepUrl)
    }

    AsyncFunction("restartVideoSource") {
      session?.restartVideoSource()
    }

    AsyncFunction("getState") {
      session?.getState() ?: mapOf("state" to "idle", "muted" to false)
    }

    OnDestroy {
      session?.leave()
      session = null
    }
  }

  private fun parseVideo(raw: Any?): VideoProfile {
    if (raw == null) return VideoProfile.DEFAULT
    val map = raw as? Map<*, *> ?: throw IllegalArgumentException("video must be an object")
    val width = (map["width"] as? Number)?.toInt()
    val height = (map["height"] as? Number)?.toInt()
    val fps = (map["fps"] as? Number)?.toInt()
    val bitrate = (map["maxBitrateBps"] as? Number)?.toInt()
    if (width == null || height == null || fps == null || bitrate == null) {
      throw IllegalArgumentException("video requires width, height, fps, and maxBitrateBps")
    }
    return VideoProfile.parse(width, height, fps, bitrate)
      ?: throw IllegalArgumentException("unsupported ACS video ${width}x${height}@${fps}")
  }
}
