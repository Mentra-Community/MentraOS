package com.mentra.acsmeeting

import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.mentra.acsmeeting.network.InternetHold
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector
import com.mentra.acsmeeting.network.ScopedNetworkError
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

  /**
   * Holds cellular up across the hotspot join, and reports what the default network became.
   *
   * Module-scoped for the same reason as [scopedNetwork]: the hold has to outlive the individual
   * `joinScopedNetwork` call and be releasable by the same teardown that releases the scoped join.
   */
  private var internetHold: InternetHold? = null

  /**
   * Put the system Wi-Fi toggle in front of the user.
   *
   * SoftAP calling needs the station radio, but `WifiManager.setWifiEnabled` has been a no-op for
   * non-privileged apps since Android 10, so the app cannot turn it on itself. The inline settings
   * panel overlays the call UI, which keeps a one-tap recovery in the same screen instead of only
   * reporting a failure the user has to go fix elsewhere.
   */
  private fun promptToEnableWifi() {
    val intent =
      Intent(
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Settings.Panel.ACTION_WIFI
        else Settings.ACTION_WIFI_SETTINGS,
      )
    val activity = appContext.currentActivity
    // #region agent log
    com.mentra.acsmeeting.network.DebugTap.log(
      "A",
      "AcsMeetingModule.kt:promptToEnableWifi",
      "prompting user to enable wifi",
      mapOf("hasActivity" to (activity != null), "sdkInt" to Build.VERSION.SDK_INT),
    )
    // #endregion
    runCatching {
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.reactContext?.startActivity(intent)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MentraAcsMeeting")
    // `onScopedNetworkLost` fires only for a hotspot that went away while we still wanted it: the
    // scoped state machine drops the framework's `onLost` for a network we released ourselves, so a
    // normal Leave or End cannot manufacture a mid-call network error.
    Events("onState", "onIncomingPcm", "onScopedNetworkLost")

    // Before any PeerConnectionFactory exists in this process: libwebrtc's network monitor only
    // reads the detector factory when it (re)starts, and without this detector it never sees the
    // internet-less hotspot network, so the phone's WHIP answer has no host candidate.
    OnCreate {
      ScopedNetworkChangeDetector.install { scopedNetwork }
    }

    /**
     * Join the glasses hotspot as a scoped, internet-less network and return this phone's address
     * on it. The address is what the WHIP listener binds to, so a join that produces no address is
     * a failure rather than a network worth keeping.
     */
    AsyncFunction("joinScopedNetwork") { ssid: String, passphrase: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      val scoped = scopedNetwork ?: ScopedSoftApNetwork(context.applicationContext).also { scopedNetwork = it }
      // Cellular first, and validated, because the next line is what takes office Wi-Fi away. A
      // phone whose cellular cannot carry TLS strands the ACS join for its whole timeout with
      // device-wide DNS failures, which reads as a hotspot problem and is not one.
      val hold = internetHold ?: InternetHold(context.applicationContext).also { internetHold = it }
      val cellular = hold.awaitValidatedCellular()
      if (!cellular.validated) {
        hold.release()
        throw IllegalStateException(
          "SOFTAP_NO_CELLULAR_INTERNET: this phone's mobile data did not come up, so Teams would " +
            "lose its connection the moment we join the glasses hotspot. Turn mobile data on and retry.",
        )
      }
      val listener = object : ScopedSoftApNetwork.Listener {
        override fun onAvailable(network: android.net.Network, localIpv4: String) = Unit

        override fun onLost(error: ScopedNetworkError) {
          com.mentra.acsmeeting.trace.SoftApTrace.failure("scoped_network_lost_midcall", "code" to error.code)
          sendEvent(
            "onScopedNetworkLost",
            mapOf("code" to error.code, "message" to (error.message ?: "The glasses hotspot went away")),
          )
        }
      }
      try {
        scoped.join(ssid, passphrase, listener)
      } catch (error: ScopedNetworkError.WifiDisabled) {
        // Open the panel and *wait*. Throwing here used to tear the hotspot down in ~20ms,
        // then a retry reminted ACS after the user turned Wi-Fi on — and Android often made
        // that new Wi-Fi the default route with no internet, so token mint hung on DNS.
        promptToEnableWifi()
        com.mentra.acsmeeting.trace.SoftApTrace.stage("wifi_enable_wait", "timeoutMs" to ScopedSoftApNetwork.WIFI_ENABLE_WAIT_MS)
        val enabled = scoped.awaitWifiEnabled()
        com.mentra.acsmeeting.trace.SoftApTrace.stage(
          "wifi_enable_wait_done",
          "enabled" to enabled,
        )
        if (!enabled) throw error
        Thread.sleep(ScopedSoftApNetwork.WIFI_ENABLE_SETTLE_MS)
        scoped.join(ssid, passphrase, listener)
      }
      scoped.localIpv4() ?: throw IllegalStateException("scoped network has no IPv4 address")
    }

    /**
     * Undo for the `scopedJoin` step, so both network requests are dropped by the one idempotent
     * teardown rather than by separate exit paths. A held cellular request that outlived its call
     * keeps the radio up for nothing.
     */
    AsyncFunction("leaveScopedNetwork") {
      scopedNetwork?.release()
      internetHold?.release()
    }

    /**
     * The app's validated default network, waited for before the ACS join.
     *
     * Separate from the cellular hold on purpose: holding a request asks Android to bring cellular
     * up, it does not say when this app's default route switches to it. Only this answers that, and
     * it is the precondition for a join that has to reach the internet.
     */
    AsyncFunction("awaitValidatedDefaultNetwork") {
      val context = appContext.reactContext ?: throw IllegalStateException("no react context")
      val hold = internetHold ?: InternetHold(context.applicationContext).also { internetHold = it }
      val network = hold.awaitValidatedDefault()
      mapOf(
        "transport" to network.transport,
        "validated" to network.validated,
        "present" to network.present,
        "usable" to network.usable,
        "detail" to network.toString(),
      )
    }

    /**
     * The joined hotspot as the framework describes it. `prefix` is the invariant the media path is
     * checked against: the selected ICE candidate must sit inside it.
     */
    AsyncFunction("scopedNetworkInfo") {
      val scoped = scopedNetwork
      mapOf(
        "available" to (scoped?.isAvailable() == true),
        "localIpv4" to scoped?.localIpv4(),
        "prefix" to scoped?.scopedPrefix()?.toString(),
      )
    }

    // Blocking TCP probe (<= ~6s worst case); AsyncFunction runs it off the JS thread.
    AsyncFunction("probeScopedGateway") {
      val scoped = scopedNetwork ?: return@AsyncFunction mapOf("reachable" to false, "detail" to "no scoped network")
      val verdict = scoped.probeGateway()
      // #region agent log
      com.mentra.acsmeeting.network.DebugTap.log(
        "G",
        "AcsMeetingModule.kt:probeScopedGateway",
        "gateway probe",
        mapOf(
          "reachable" to verdict.reachable,
          "detail" to verdict.detail,
          "localIpv4" to scoped.localIpv4(),
          "gateway" to scoped.gatewayIpv4(),
          "routes" to com.mentra.acsmeeting.network.DebugTap.shell("ip -4 route show table all"),
          "rules" to com.mentra.acsmeeting.network.DebugTap.shell("ip rule"),
        ),
      )
      // #endregion
      mapOf("reachable" to verdict.reachable, "detail" to verdict.detail)
    }

    /**
     * Sign in to ACS before the glasses hotspot is up. SoftAP DNS cannot resolve Teams hosts, so
     * [join] after the scoped network is a media bind, not another `createCallAgent`.
     *
     * Pinned to cellular for the duration, because "before the hotspot" means "on whatever Wi-Fi
     * the phone is already on", and a slow AP is enough to blow the sign-in deadline. The pin is
     * dropped before [join] opens the WHIP listener — see [InternetHold.bindProcessToCellular].
     */
    AsyncFunction("prepareAgent") { options: Map<String, Any?> ->
      val token = options["token"] as? String ?: throw IllegalArgumentException("token is required")
      val displayName = options["displayName"] as? String
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
      val hold = internetHold ?: InternetHold(context.applicationContext).also { internetHold = it }
      // Request cellular rather than trusting it to be up: a phone sitting on Wi-Fi may have the
      // radio asleep, and there is nothing to pin to until it is validated. An unvalidated result
      // is not fatal here — the current default network may still sign in fine, and the scoped
      // join is where a phone with no mobile data gets told so by name.
      hold.awaitValidatedCellular()
      hold.bindProcessToCellular()
      // Deliberately still pinned on the way out. The pin has to survive the hotspot join that
      // follows, because ACS re-binds its signalling when the network moves and keeps whatever
      // route it got. Teardown's `leaveScopedNetwork` is what drops it.
      meeting.prepareAgent(token, displayName)
      meeting.snapshot()
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
      val audioDelayMs = (options["audioDelayMs"] as? Number)?.toInt()
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
      // The process is already pinned to cellular by now (sign-in and the scoped join both pin, and
      // ACS keeps the route its sockets were created with). Lift it only across the WHIP listener
      // bind, which is the one socket that must stay on the hotspot.
      val joined = meeting.join(
        token,
        meetingUrl,
        videoSource,
        displayName,
        dumpWav,
        audioSource,
        video,
        audioDelayMs,
        bindIngestUnpinned = { bind ->
          val hold = internetHold
          if (hold == null) {
            bind()
          } else {
            hold.unbindProcess()
            try {
              bind()
            } finally {
              hold.bindProcessToCellular()
            }
          }
        },
      )
      // Prefer the join snapshot: getState() can race a leave from a respawned miniapp
      // restore and drop the URL the orchestrator needs to tell the glasses.
      joined + buildMap {
        meeting.softApIngestUrl()?.let { put("ingestUrl", it) }
      }
    }

    AsyncFunction("leave") {
      session?.leave()
    }

    /**
     * End the Teams group call for everyone. Rejects when there is no call, when this participant
     * is known not to be allowed to, or when ACS refuses — and tears this device down regardless,
     * so a rejection means "we could not end it for the others", never "you are still in it".
     */
    AsyncFunction("endForEveryone") {
      val meeting = session ?: throw IllegalStateException("no_active_call")
      meeting.endForEveryone()
    }

    /**
     * One buffer of glasses microphone PCM, decoded from BLE LC3 by the host.
     *
     * Synchronous by design. This runs at ~100 calls/s for the length of a call, and a promise per
     * buffer would put more work on the JS thread than the audio itself costs. Returns whether the
     * buffer entered the uplink so the host can count drops rather than guess at them.
     */
    Function("pushOutgoingPcm") { base64: String, sampleRate: Int, channels: Int ->
      session?.pushOutgoingPcm(base64, sampleRate, channels) ?: false
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
      internetHold?.release()
      internetHold = null
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
