package com.mentra.acsmeeting

import com.mentra.acsmeeting.telemetry.AcsDebugLog
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
      meeting.join(token, meetingUrl, whepUrl, displayName, dumpWav, audioSource)
      val state = meeting.getState()
      // #region agent log
      AcsDebugLog.emit("C", "AcsMeetingModule.kt:join", "native join returned immediately", mapOf(
        "state" to (state["state"] ?: "missing"),
      ))
      // #endregion
      state
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

    AsyncFunction("getState") {
      session?.getState() ?: mapOf("state" to "idle", "muted" to false)
    }

    OnDestroy {
      session?.leave()
      session = null
    }
  }
}
