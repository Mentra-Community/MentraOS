package com.mentra.acsmeeting

import com.mentra.acsmeeting.network.ScopedSoftApNetwork
import com.mentra.acsmeeting.source.MeetingVideoSourceSpec
import com.mentra.acsmeeting.video.VideoProfile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AcsMeetingModule : Module() {
  private var session: AcsMeetingSession? = null

  /**
   * Held by the module, not the session, because the orchestrator joins the hotspot *before* the
   * ACS join: the ingest source has to bind to a network that already exists. One instance means
   * the session's ingest source and this join agree on the same [android.net.Network].
   */
  private var scopedNetwork: ScopedSoftApNetwork? = null

  override fun definition() = ModuleDefinition {
    Name("MentraAcsMeeting")
    Events("onState", "onIncomingPcm")

    /**
     * Join the glasses hotspot as a scoped, internet-less network and return this phone's address
     * on it. The address is what the WHIP listener binds to, so a join that produces no address is
     * a failure rather than a network worth keeping.
     */
    AsyncFunction("joinScopedNetwork") { ssid: String, passphrase: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      val scoped = scopedNetwork ?: ScopedSoftApNetwork(context.applicationContext).also { scopedNetwork = it }
      scoped.join(ssid, passphrase)
      scoped.localIpv4() ?: throw IllegalStateException("scoped network has no IPv4 address")
    }

    AsyncFunction("leaveScopedNetwork") {
      scopedNetwork?.release()
    }

    AsyncFunction("join") { options: Map<String, Any?> ->
      val token = options["token"] as? String ?: throw IllegalArgumentException("token is required")
      val meetingUrl = options["meetingUrl"] as? String ?: throw IllegalArgumentException("meetingUrl is required")
      // Accepts the videoSource union and still honours a bare whepUrl, so a host that predates
      // the union keeps joining unchanged.
      val videoSource = MeetingVideoSourceSpec.parse(
        options["videoSource"] as? Map<*, *>,
        options["whepUrl"] as? String,
      )
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
        scopedNetwork = scopedNetwork,
      ).also { session = it }
      meeting.join(token, meetingUrl, videoSource, displayName, dumpWav, audioSource, video)
      // The SoftAP ingest URL is only known after the listener binds, so it rides back on the join
      // result rather than being an input. The orchestrator forwards it to the glasses.
      meeting.getState() + buildMap {
        meeting.softApIngestUrl()?.let { put("ingestUrl", it) }
      }
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
      scopedNetwork?.release()
      scopedNetwork = null
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
