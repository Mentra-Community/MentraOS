package com.mentra.acsmeeting

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import com.mentra.acsmeeting.network.InternetHold
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector
import com.mentra.acsmeeting.network.ScopedNetworkError
import com.mentra.acsmeeting.network.ScopedSoftApNetwork
import com.mentra.acsmeeting.source.MeetingVideoSourceSpec
import com.mentra.acsmeeting.trace.SoftApTrace
import com.mentra.acsmeeting.video.VideoProfile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AcsMeetingModule : Module() {
  private var session: AcsMeetingSession? = null

  /**
   * Wrap one `AsyncFunction` body in an entry/exit trace.
   *
   * Every function here is a boundary the host awaits, and the host cannot see which side of it a
   * stall is on. An entry line with no exit line names the native call that never came back, which
   * is the one diagnosis the JS-side duration alone can never give.
   */
  private inline fun <T> traced(name: String, vararg fields: Pair<String, Any?>, body: () -> T): T {
    val startedAt = SystemClock.elapsedRealtime()
    SoftApTrace.stage("native_${name}_begin", *fields)
    try {
      val result = body()
      SoftApTrace.stage("native_${name}_end", "durationMs" to (SystemClock.elapsedRealtime() - startedAt))
      return result
    } catch (error: Throwable) {
      SoftApTrace.failure(
        "native_${name}_failed",
        "durationMs" to (SystemClock.elapsedRealtime() - startedAt),
        "reason" to "${error.javaClass.simpleName}: ${error.message ?: ""}",
      )
      throw error
    }
  }

  /**
   * Held by the module, not the session, because the orchestrator joins the hotspot *before* the
   * ACS join: the ingest source has to bind to a network that already exists. One instance means
   * the session's ingest source and this join agree on the same [android.net.Network].
   */
  private var scopedNetwork: ScopedSoftApNetwork? = null

  // prepareAgent creates the session before joinScopedNetwork runs. Give it the same holder
  // now, so its ingest source sees the network populated later instead of retaining null.
  @Synchronized
  private fun getOrCreateScopedNetwork(context: Context): ScopedSoftApNetwork =
    scopedNetwork ?: ScopedSoftApNetwork(context.applicationContext).also { scopedNetwork = it }

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

    AsyncFunction("beginTrace") { traceId: String ->
      require(traceId.matches(Regex("[A-Za-z0-9]*"))) { "invalid trace id" }
      com.mentra.acsmeeting.trace.SoftApTrace.begin(traceId)
      Unit
    }

    /**
     * Join the glasses hotspot as a scoped, internet-less network and return this phone's address
     * on it. The address is what the WHIP listener binds to, so a join that produces no address is
     * a failure rather than a network worth keeping.
     */
    AsyncFunction("joinScopedNetwork") { ssid: String, passphrase: String ->
      traced("join_scoped_network", "ssid" to ssid) {
        val context = appContext.reactContext ?: throw IllegalStateException("no react context")
        val scoped = getOrCreateScopedNetwork(context)
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
        } catch (error: ScopedNetworkError.Unavailable) {
          // The first specifier steals wlan0 from the phone's current Wi-Fi (iPhone X, office
          // AP). Samsung then assoc-rejects the glasses SoftAP (status 1025) and fires
          // onUnavailable. After that request dies the STA is idle — the same join from idle
          // is what succeeded at 17:43:20 after a failed switch.
          com.mentra.acsmeeting.trace.SoftApTrace.stage(
            "scoped_join_unavailable_retry",
            "ssid" to ssid,
            "settleMs" to ScopedSoftApNetwork.UNAVAILABLE_RETRY_SETTLE_MS,
          )
          Thread.sleep(ScopedSoftApNetwork.UNAVAILABLE_RETRY_SETTLE_MS)
          scoped.join(ssid, passphrase, listener)
        }
        scoped.localIpv4() ?: throw IllegalStateException("scoped network has no IPv4 address")
      }
    }

    /**
     * Undo for the `scopedJoin` step. Drops only the hotspot bind.
     *
     * The cellular pin is a preflight resource (`prepareAgent`), not a scoped-join one. Releasing
     * it here is what turned Cancel-during-hotspot into `Request failed (503)`: the AP was still
     * up, Android made it the default Wi-Fi, and the next Teams create had no internet. The pin
     * is dropped by [leaveAndAwait] / [leave] once a validated default route exists.
     */
    AsyncFunction("leaveScopedNetwork") {
      traced("leave_scoped_network", "hasScopedNetwork" to (scopedNetwork != null)) {
        scopedNetwork?.release()
      }
    }

    /**
     * The app's validated default network, waited for before the ACS join.
     *
     * Separate from the cellular hold on purpose: holding a request asks Android to bring cellular
     * up, it does not say when this app's default route switches to it. Only this answers that, and
     * it is the precondition for a join that has to reach the internet.
     */
    AsyncFunction("awaitValidatedDefaultNetwork") {
      traced("await_validated_default_network") {
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
      traced("prepare_agent", "hasSession" to (session != null)) {
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
          scopedNetwork = getOrCreateScopedNetwork(context),
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
        // route it got. Teardown's `leaveAndAwait` is what drops it, and only once a validated
        // default internet exists — not `leaveScopedNetwork`, which used to unpin onto SoftAP.
        meeting.prepareAgent(token, displayName)
        meeting.snapshot()
      }
    }

    AsyncFunction("join") { options: Map<String, Any?> ->
      traced("join", "hasSession" to (session != null)) {
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
        SoftApTrace.stage(
          "native_join_options",
          "transport" to videoSource.kind,
          "audioSource" to audioSource,
          "audioDelayMs" to (audioDelayMs ?: -1),
          "video" to "${video.width}x${video.height}@${video.fps}",
          "dumpWav" to dumpWav,
        )
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
          scopedNetwork = getOrCreateScopedNetwork(context),
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
              // No hold means no pin to lift, so the listener binds on whatever the default route
              // is. Worth naming: that is also the state in which ACS's own sockets are unpinned.
              SoftApTrace.stage("native_ingest_bind", "unpinned" to false, "reason" to "no cellular hold")
              bind()
            } else {
              hold.unbindProcess()
              try {
                SoftApTrace.stage("native_ingest_bind", "unpinned" to true)
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
    }

    AsyncFunction("leave") {
      traced("leave", "hasSession" to (session != null)) {
        session?.leave()
        internetHold?.releaseWhenDefaultInternetReady()
      }
    }

    /**
     * Leave, and resolve only once the cleanup has actually finished.
     *
     * `leave` queues its work and returns, which is fine for a wearer who is done but useless to a
     * host that has to know when the next call may safely start. This also drops the cellular
     * process pin — but only once the phone has a validated default internet again. Unpinning
     * onto a leftover glasses hotspot is what made the next `teams:create` return 503.
     */
    AsyncFunction("leaveAndAwait") { options: Map<String, Any?> ->
      val timeoutMs = (options["timeoutMs"] as? Number)?.toLong() ?: 20_000L
      traced("leave_and_await", "timeoutMs" to timeoutMs, "hasSession" to (session != null)) {
        val completed = try {
          session?.leaveAndAwait(timeoutMs) ?: true
        } finally {
          // In the `finally` so a cleanup that timed out still drops the pin. The pin is the one
          // resource whose leak breaks the *next* call rather than this one.
          internetHold?.releaseWhenDefaultInternetReady()
        }
        mapOf("completed" to completed)
      }
    }

    /**
     * End the Teams group call for everyone. Rejects when there is no call, when this participant
     * is known not to be allowed to, or when ACS refuses — and tears this device down regardless,
     * so a rejection means "we could not end it for the others", never "you are still in it".
     */
    AsyncFunction("endForEveryone") {
      traced("end_for_everyone", "hasSession" to (session != null)) {
        val meeting = session ?: throw IllegalStateException("no_active_call")
        meeting.endForEveryone()
      }
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
      // The one teardown no wearer asked for: a reloaded JS bundle or a killed module drops the
      // session while a call may still be up, and nothing on the host side will ever report it.
      SoftApTrace.stage(
        "native_module_destroyed",
        "hasSession" to (session != null),
        "hasScopedNetwork" to (scopedNetwork != null),
        "hasCellularHold" to (internetHold != null),
      )
      session?.leave()
      session = null
      scopedNetwork?.release()
      scopedNetwork = null
      val hold = internetHold
      if (hold != null && hold.defaultNetwork().usable) {
        hold.release()
      } else if (hold != null) {
        SoftApTrace.failure(
          "cellular_hold_kept_on_destroy",
          "reason" to "default network is leftover SoftAP; unpinning would strand the next teams:create",
          "default" to hold.defaultNetwork().toString(),
        )
      }
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
