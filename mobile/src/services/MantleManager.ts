import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import CrustModule from "@mentra/crust"
import {Asset} from "expo-asset"
import * as Calendar from "expo-calendar"
import {router} from "expo-router"

import {bootstrapMentraJS} from "@/services/mentraJsBootstrap"
import {preinstalledMiniappSync} from "@/services/miniapps/preinstalledMiniappSync"
import {deploymentManagedMiniappSync} from "@/services/miniapps/deploymentManagedMiniappSync"
import builtInMiniappCatalog from "@/services/miniapps/BuiltInMiniappCatalog"
import {BUNDLED_MINIAPPS} from "@/generated/bundledMiniapps"
import {CHINA_HIDDEN_APPS, isChinaBuild, notifyPackageName} from "@/constants/miniapps"
import {migrate} from "@/services/Migrations"
import {buildSpokenNotification} from "@/services/notifications/spokenNotification"
import {deploymentCloudConfigValues} from "@/services/cloudClient"
import {requestPhoneQrScan} from "@/services/qrScanRequest"
import {engine, BgTimer, SETTINGS} from "@mentra/engine"
import {
  appRegistry,
  audioPlaybackService,
  displayProcessor,
  gallerySyncService,
  localDisplayManager,
  localMiniappRuntime,
  micStateCoordinator,
  miniappLauncher,
  offlineSpeechModelService,
  phoneLocationService,
  ttsModelManager,
  useAppStatusStore,
} from "@mentra/engine-host-internal"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useDebugStore} from "@/stores/debug"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"
import mentraAuth from "@/utils/auth/authClient"
import {showAlert} from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {Buffer} from "@craftzdog/react-native-buffer"
import {createDeploymentAuthProvider, deploymentStore} from "@/services/deployment"

/**
 * Miniapp bundles shipped inside the app binary, installed on first launch by
 * MantleManager.installBundledMiniapps(). BUNDLED_MINIAPPS is code-generated
 * from every *.zip in assets/miniapps/ by scripts/generate-bundled-miniapps.mjs
 * (Metro can only bundle assets referenced by a literal string require(), so the
 * list must be static) — to ship an update, just drop a new zip in that
 * directory; the generator runs on `bun start`/prebuild.
 *
 * The filename encodes packageName + version (e.g.
 * `com.mentra.navigation-1.0.2.zip`), so we read those straight off the asset
 * name to decide whether the bundle is already installed and up to date — no
 * need to unzip just to check. See src/generated/bundledMiniapps.ts.
 */

/**
 * Parse `<packageName>-<version>` out of a bundled miniapp asset name like
 * `com.mentra.navigation-1.0.2.zip`. Splits on the last hyphen so dotted
 * package names (which contain no hyphens) stay intact. Returns null if the
 * name doesn't match the expected shape.
 */
function parseBundledMiniappName(name: string): {packageName: string; version: string} | null {
  const base = name.replace(/\.zip$/i, "")
  const lastHyphen = base.lastIndexOf("-")
  if (lastHyphen <= 0 || lastHyphen === base.length - 1) return null
  return {
    packageName: base.slice(0, lastHyphen),
    version: base.slice(lastHyphen + 1),
  }
}

// The background phone-location task + its tier control moved into island
// (PhoneLocationService). MantleManager now drives it through the island service
// (setupSubscriptions / cleanup) instead of defining the task here.

/**
 * Longest a spoken notification is assumed to take. Only a backstop for a
 * completion callback that never arrives — not a playback limit.
 */
const SPOKEN_NOTIFICATION_MAX_MS = 30_000

/**
 * Quiet window after an announcement before the next one may be read.
 *
 * Notifications do not arrive politely spaced: apps re-post to update a running
 * download or a music player, and granting notification access replays whatever
 * is already in the shade. Reading each one turns the glasses into a monologue
 * the wearer cannot skip. Anything landing inside this window is counted, not
 * spoken, and summarised once at the end.
 */
const SPOKEN_NOTIFICATION_GAP_MS = 10_000

class MantleManager {
  private static instance: MantleManager | null = null
  private calendarSyncTimer: ReturnType<typeof BgTimer.setInterval> | null = null
  private micDataTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private MIC_TIMEOUT_MS: number = 1000
  private micDataActive: boolean = false
  private lastMicDataAt: number = 0
  private subs: Array<any> = []
  private initialized: boolean = false
  private activePhoneNotificationId: string | null = null
  /** A notification is being read aloud right now. */
  private speakingNotification: boolean = false
  /** When the last announcement finished, for the quiet window. */
  private lastSpokenAt: number = 0
  /** Notifications that arrived during the quiet window, summarised afterwards. */
  private suppressedNotifications: number = 0
  private suppressedSummaryTimer: ReturnType<typeof BgTimer.setTimeout> | null = null
  /** Bumped by cleanup() so in-flight speech work can detect it is stale. */
  private speechGeneration: number = 0

  public static getInstance(): MantleManager {
    if (!MantleManager.instance) {
      MantleManager.instance = new MantleManager()
    }
    return MantleManager.instance
  }

  private constructor() {}

  private isNotifyRunning(): boolean {
    return useAppStatusStore
      .getState()
      .apps.some((miniapp) => miniapp.packageName === notifyPackageName && miniapp.running)
  }

  /**
   * Stop every wearer-facing notification artifact as soon as Notify stops.
   * Event forwarding remains independent and continues for subscribed miniapps.
   */
  private stopPhoneNotificationPresentation(): void {
    this.activePhoneNotificationId = null
    localDisplayManager.dismiss(notifyPackageName)

    // Invalidate synthesis already in flight before stopping active playback.
    // Its completion callback sees the stale generation and cannot reopen the
    // quiet window after this reset.
    this.speechGeneration += 1
    void Promise.resolve(audioPlaybackService.stopForApp(notifyPackageName)).catch((error) =>
      console.warn("MantleManager: failed to stop notification audio", error),
    )

    if (this.suppressedSummaryTimer !== null) {
      BgTimer.clearTimeout(this.suppressedSummaryTimer)
      this.suppressedSummaryTimer = null
    }
    this.suppressedNotifications = 0
    this.speakingNotification = false
    this.lastSpokenAt = 0
  }

  /**
   * Read a phone notification aloud, for glasses that have no screen.
   *
   * Mentra Live has a speaker but no display, so the reference card the display
   * path requests is invisible there and the wearer learns nothing (OS-1821).
   *
   * Deliberately conservative, because a notification written to be *seen* is
   * hostile when read verbatim:
   *  - Silent on glasses that DO have a display; the card is better than speech.
   *  - Needs an on-device TTS voice; no network reach on every notification.
   *  - buildSpokenNotification() strips URLs and emoji, cuts on a word boundary,
   *    and drops low-priority and summary rows entirely.
   *  - A burst is summarised rather than recited (see the quiet window).
   */
  private async speakPhoneNotification(app: string, title: string, content: string, priority?: number): Promise<void> {
    try {
      // The remembered model survives disconnects. Without a live connection,
      // playing Notify-owned audio can fall back to the phone speaker and expose
      // private notification content when the glasses are not being worn.
      if (engine.glasses.status().state !== "connected") return

      const capabilities = engine.glasses.capabilities()
      if (!capabilities || capabilities.hasDisplay || !capabilities.hasSpeaker) return

      const spoken = buildSpokenNotification({app, title, content, priority})
      // Nothing worth hearing: a link-only message, a "3 new messages" summary,
      // or something the app itself marked as do-not-interrupt.
      if (!spoken) return

      // Inside the quiet window (or mid-announcement): count it and let the
      // trailing summary mention it, rather than talking over the wearer.
      if (this.speakingNotification || Date.now() - this.lastSpokenAt < SPOKEN_NOTIFICATION_GAP_MS) {
        this.suppressedNotifications += 1
        this.scheduleSuppressedSummary()
        return
      }

      await this.speakAloud(spoken)
    } catch (error) {
      // Never let a failed announcement break notification capture/storage.
      this.speakingNotification = false
      console.warn("MantleManager: failed to speak phone notification", error)
    }
  }

  /**
   * After the quiet window, say how many arrived during it — once, as a count.
   * "Four more notifications" is useful; four notifications read in full is not.
   */
  private scheduleSuppressedSummary(): void {
    if (this.suppressedSummaryTimer !== null) return
    this.suppressedSummaryTimer = BgTimer.setTimeout(() => {
      this.suppressedSummaryTimer = null
      if (this.suppressedNotifications <= 0) return

      // Still talking, or still inside the quiet window — which only starts when
      // speech ENDS, so this timer (anchored to the first suppressed arrival)
      // routinely fires early. Reschedule and keep the count.
      //
      // This used to zero the count and then return, so a burst landing
      // mid-announcement — the exact case the summary exists for — produced no
      // summary at all.
      if (this.speakingNotification || Date.now() - this.lastSpokenAt < SPOKEN_NOTIFICATION_GAP_MS) {
        this.scheduleSuppressedSummary()
        return
      }

      const count = this.suppressedNotifications
      this.suppressedNotifications = 0
      void this.speakAloud(`${count} more notification${count === 1 ? "" : "s"}.`)
    }, SPOKEN_NOTIFICATION_GAP_MS)
  }

  /** Synthesize and play one line. Assumes the caller checked the quiet window. */
  private async speakAloud(text: string): Promise<void> {
    // Claim the slot synchronously, before anything awaits.
    //
    // The caller's quiet-window check reads this flag. Setting it only after
    // `await isModelAvailable()` meant a burst of notifications all passed that
    // check together, synthesized concurrently, and interrupted one another's
    // playback — and the first completion callback then cleared the flag while
    // a later clip was still playing. A check-and-set with no await between the
    // two is atomic here, so this is the whole fix.
    if (this.speakingNotification) return
    this.speakingNotification = true

    // Safety valve: if the completion callback never arrives, the flag would
    // latch and silence every later notification for the rest of the session.
    // Losing one announcement beats going permanently quiet. Armed before the
    // first await so no failure path can leave the flag set without a timer,
    // and cleared on every exit — a guard left running after a synthesis
    // failure fires later and clears the flag for a clip still playing.
    const stuckGuard = BgTimer.setTimeout(() => {
      this.speakingNotification = false
    }, SPOKEN_NOTIFICATION_MAX_MS)
    const release = () => {
      BgTimer.clearTimeout(stuckGuard)
      this.speakingNotification = false
    }

    // Restored if nothing is actually announced. The stamp below marks "speech
    // starting" so the stuck guard has a sane window, but on a failure path it
    // would otherwise persist and suppress the next SPOKEN_NOTIFICATION_GAP_MS
    // of notifications into a summary for speech that never happened.
    const previousSpokenAt = this.lastSpokenAt

    // Generation token: cleanup() bumps this, so work that is already in flight
    // (a synthesis started before logout) can tell it is stale and stop rather
    // than playing into the next session.
    const generation = this.speechGeneration

    let audio: {audioUrl: string; cleanup: () => Promise<void>} | undefined
    try {
      if (!(await ttsModelManager.isModelAvailable())) {
        console.warn("MantleManager: no on-device TTS voice available, notification not spoken")
        release()
        return
      }

      this.lastSpokenAt = Date.now()
      audio = await ttsModelManager.synthesizeToFile(text)

      if (generation !== this.speechGeneration) {
        this.lastSpokenAt = previousSpokenAt
        release()
        void audio?.cleanup?.()
        return
      }
      await audioPlaybackService.play(
        {
          requestId: `phone_notification_${Date.now()}`,
          audioUrl: audio.audioUrl,
          appId: notifyPackageName,
        },
        () => {
          release()
          // Start the quiet window when speech ENDS, not when it started, so a
          // long announcement isn't immediately followed by another. Skipped for
          // a stale generation: cleanup() interrupts playback, which fires this
          // callback, and stamping here would undo the reset it just performed.
          if (generation === this.speechGeneration) this.lastSpokenAt = Date.now()
          void audio?.cleanup?.()
        },
      )
    } catch (error) {
      // Nothing was announced, so roll the stamp back rather than opening a
      // quiet window on a failure.
      this.lastSpokenAt = previousSpokenAt
      release()
      void audio?.cleanup?.()
      console.warn("MantleManager: failed to speak notification audio", error)
    }
  }

  private noteMicDataReceived() {
    this.lastMicDataAt = Date.now()

    if (!this.micDataActive) {
      this.micDataActive = true
      useDebugStore.getState().setDebugInfo({micDataRecvd: true})
    }

    if (this.micDataTimeout) {
      return
    }

    this.micDataTimeout = BgTimer.setTimeout(() => this.checkMicDataStillActive(), this.MIC_TIMEOUT_MS)
  }

  private checkMicDataStillActive() {
    this.micDataTimeout = null
    const staleForMs = Date.now() - this.lastMicDataAt

    if (staleForMs < this.MIC_TIMEOUT_MS) {
      this.micDataTimeout = BgTimer.setTimeout(() => this.checkMicDataStillActive(), this.MIC_TIMEOUT_MS - staleForMs)
      return
    }

    if (this.micDataActive) {
      this.micDataActive = false
      useDebugStore.getState().setDebugInfo({micDataRecvd: false})
    }
  }

  // run at app start on the init.tsx screen:
  // should only ever be run once
  // sets up the bridge and initializes app state
  public async init() {
    console.log("MANTLE: init()")

    if (this.initialized) {
      console.log("MANTLE: already initialized")
      return
    }
    this.initialized = true

    // Island front door: hand island the host's auth provider and config, then
    // start the runtime. The remaining work below is Mentra-app UI/v1-cloud
    // startup, not an island configuration seam.
    const deployment = deploymentStore.getActive()
    const workspaceAuth = deployment.kind === "workspace" ? createDeploymentAuthProvider(deployment) : null
    engine.configure({
      auth: workspaceAuth
        ? {
            getSubjectToken: async () => ({
              token: await workspaceAuth.getAccessToken({
                scopes:
                  deployment.kind === "workspace" && deployment.manifest.auth.mode === "microsoft-entra"
                    ? deployment.manifest.auth.sessionScopes
                    : [],
              }),
              type: "oidc",
            }),
            getUserId: async () => {
              const current = await workspaceAuth.getSession()
              if (!current) throw new Error("engine.configure: no workspace identity available")
              const {identity} = current
              return `workspace:${identity.deploymentId}:${encodeURIComponent(identity.issuer)}:${identity.subject}`
            },
            onStateChange: (callback) => ({
              unsubscribe: workspaceAuth.onStateChange((session) =>
                callback(session ? "SIGNED_IN" : "SIGNED_OUT", session ? {token: session.accessToken ?? null} : null),
              ),
            }),
          }
        : {
            getSubjectToken: async () => {
              // Cloud V2 (issue 019): the provider mints a fresh `mentra` OEM subject
              // token which cloud-client exchanges at /api/client/auth/exchange.
              const res = await mentraAuth.getSubjectToken()
              if (res.is_error() || !res.value.token) {
                throw new Error("engine.configure: no subject token available")
              }
              return {token: res.value.token, type: res.value.type}
            },
            // Hand back a synchronous handle with a real unsubscribe.
            //
            // mentraAuth is a lazy Proxy whose every method returns a Promise, so
            // this call resolves to the Result rather than being one. The engine
            // (CloudClientService.ensureAuthWatch) inspects the return value
            // synchronously, finds no `unsubscribe` on a Promise, and keeps its
            // no-op placeholder — so stopAuthWatch() never removed the listener.
            //
            // That used to be invisible: the provider held one callback slot, so
            // the orphan was overwritten by whoever registered next. Now that every
            // listener is retained, each engine.start() would stack another one, and
            // a later SIGNED_IN would have several callbacks calling reconnect() on
            // the same client. Resolve the real unsubscribe out of the promise, and
            // honour an unsubscribe that arrives before it settles.
            onStateChange: (callback) => {
              const pending = Promise.resolve(
                mentraAuth.onAuthStateChange((event: string, session: any) => callback(event, session)),
              )
              let resolved: (() => void) | null = null
              let cancelled = false

              void pending
                .then((res: any) => {
                  const handle = res?.value ?? res
                  resolved = typeof handle?.unsubscribe === "function" ? handle.unsubscribe : null
                  if (cancelled) resolved?.()
                })
                .catch(() => {
                  resolved = null
                })

              return {
                unsubscribe: () => {
                  cancelled = true
                  resolved?.()
                },
              }
            },
          },
      // Resolved cloud endpoints + LC3 frame size. island builds its cloud
      // client from these; the host keeps the dev/settings URL resolution.
      config: deploymentCloudConfigValues(deployment),
      // Named host-UI seams: island dispatches the miniapp request, the host
      // owns the screen (branding/navigation).
      ui: {
        requestWifiSetup: (reason?: string, packageName?: string) =>
          new Promise<void>((resolve) => {
            // Wi-Fi setup drives the glasses over Bluetooth (scan, credentials,
            // status), so with the link down the wizard cannot succeed and the
            // reconnecting overlay would cover it anyway. Tell the user the real
            // blocker instead of sending them into a flow that ends at Home.
            if (engine.glasses.status().state !== "connected") {
              showAlert(
                translate("glasses:wifiSetupNeedsGlassesTitle"),
                translate("glasses:wifiSetupNeedsGlassesMessage"),
                [{text: translate("common:ok"), onPress: resolve}],
              )
              return
            }
            showAlert("Connect to Wi-Fi", reason || "This miniapp needs your glasses to be connected to Wi-Fi.", [
              {text: "Cancel", style: "cancel", onPress: resolve},
              {
                text: "OK",
                onPress: () => {
                  // The Compositor is an app-wide overlay, so navigating
                  // without clearing foreground leaves the Wi-Fi route
                  // rendered underneath the requesting miniapp.
                  engine.miniapps.clearForeground()
                  router.push({
                    pathname: "/wifi/scan" as any,
                    params: packageName ? {returnToMiniapp: packageName} : {},
                  })
                  resolve()
                },
              },
            ])
          }),
        // Overlay only — never clearForeground. UI_CLOSE hangs up live calls.
        scanQr: (options) => requestPhoneQrScan(options),
      },
    })
    await engine.start()

    // iOS: require a second swipe across the bottom edge to invoke the Home
    // indicator / app switcher, so users don't accidentally background the
    // app mid-glasses-session. No-op on Android.
    // CrustModule.setDeferredSystemGestures(["bottom"]).catch((e) =>
    //   console.warn("MANTLE: setDeferredSystemGestures failed", e),
    // )

    // Wire the runtime's status fanout (now subscribes the island coordinator directly).
    localMiniappRuntime.wireStreamingStatusFanout()

    // DisplayProcessor's singleton was constructed at module load, before app
    // services hydrated the island stores. Re-attach so captions are wrapped with
    // the current profile (e.g. NEX_PROFILE for Mentra Display) instead of the G1 default.
    displayProcessor.attachToRuntime()

    // Same late-attach for the local display manager's reconnect-replay hook:
    // after a glasses reconnect it re-pushes the current owner's frame (scenes
    // replay from retained state — apps never re-send on reconnect).
    localDisplayManager.attachToRuntime()

    // Register the offline-app catalog with island's AppRegistry before
    // anything triggers an apps refresh.
    builtInMiniappCatalog.init()

    await migrate() // do any local migrations here

    // Cloud V1 settings pull removed with the login cutover: the endpoint only
    // exists on V1 and authenticated with a token the app no longer mints.
    // Settings are local-first until a V2 sync lands (tracked in the ripout
    // issue; island's per-change server write is the island-side cleanup).

    if (deployment.kind === "consumer") {
      const userRes = await mentraAuth.getUser()
      if (userRes.is_ok()) {
        await ensureDevModeForUser(userRes.value.email)
      }
    }

    if (deployment.kind === "consumer" || deployment.manifest.features.onDeviceSpeech) {
      offlineSpeechModelService.startBackgroundDownloads()
    }

    // Spacing only, not a correctness barrier: engine.start() already awaited
    // the device-store hydration (the persisted-settings seed to native), so the
    // reconnect decision's hasDefaultDevice read is trustworthy whenever this
    // fires. The delay just keeps auto-connect off the critical boot path.
    BgTimer.setTimeout(() => {
      attemptReconnectToDefaultWearable()
    }, 1000)
    // (Initial notification-config push now happens in island's
    // PhoneNotificationsSync, started by engine.start().)

    this.initServices()
    this.initMiniapps()
    this.setupPeriodicTasks()
    this.setupSubscriptions()
  }

  public async cleanup() {
    // Stop timers
    if (this.calendarSyncTimer) {
      clearInterval(this.calendarSyncTimer)
      this.calendarSyncTimer = null
    }
    // Remove all event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []
    this.activePhoneNotificationId = null

    phoneLocationService.stopPhoneLocation()

    // Spoken notifications: a queued summary would otherwise synthesize and play
    // after the subscriptions that produced it are gone, or carry its count and
    // speaking flag into the next login in the same process. engine.stop() does
    // not stop playback, so the notify-owned audio has to be stopped explicitly.
    // Bump first so anything already in flight — a synthesis started before
    // logout — sees a stale generation and drops out instead of playing into
    // the next session.
    this.speechGeneration += 1

    // Stop playback BEFORE resetting the timestamps. stopForApp() interrupts the
    // current clip and, by design, notifies its completion callback; that
    // callback stamps lastSpokenAt, so resetting first left the quiet window
    // armed across a logout→login in the same process and the first
    // notifications of the new session were summarised instead of read.
    await audioPlaybackService.stopForApp(notifyPackageName)

    if (this.suppressedSummaryTimer !== null) {
      BgTimer.clearTimeout(this.suppressedSummaryTimer)
      this.suppressedSummaryTimer = null
    }
    this.suppressedNotifications = 0
    this.speakingNotification = false
    this.lastSpokenAt = 0

    localMiniappRuntime.cleanup()
    micStateCoordinator.cleanup()

    // Allow a later init() to rebuild everything this cleanup tore down — the
    // logout→login-in-the-same-process path and the dev backend-URL
    // cleanup()→init() cycle both depend on init() re-running after cleanup().
    this.initialized = false
  }

  private async initServices() {
    gallerySyncService.initialize()

    // Bootstrap MentraJS — wires MentraJSRouter + MentraUIRouter +
    // MentraJSCrashController. The /applet/local route binds the UI
    // router to its inline WebView via getMentraJS().uiRouter directly.
    try {
      bootstrapMentraJS()
    } catch (e) {
      console.warn("mentraJsBootstrap failed:", e)
    }
  }

  private async initMiniapps() {
    // Warm the local miniapp registry by reading lmas/ off disk. Cheap call —
    // it populates AppRegistry's cache so the first refreshApplets() doesn't
    // pay the disk-walk cost in the UI thread.
    await appRegistry.getInstalledMiniapps()

    // Initialize local miniapp runtime
    localMiniappRuntime.initialize()

    // Install any bundled miniapps that ship with the app and aren't on disk
    // yet (or are an older version). Runs after the registry is warm so the
    // already-installed check below sees the real on-disk state.
    await this.installBundledMiniapps()

    // Reconcile customer-owned userland bundles independently from SYSTEM
    // miniapps embedded in the Mentra App binary.
    await deploymentManagedMiniappSync.sync(deploymentStore.getActive())

    // Then reconcile the admin-managed preinstall registry from Cloud V2. This
    // lets Core move users to newer bundled miniapp releases without shipping a
    // new mobile binary.
    if (deploymentStore.getActive().kind === "consumer") {
      await preinstalledMiniappSync.sync()
    }

    // Re-spawn local miniapps that were running when the app was last killed.
    // Cloud apps get resurrected by the cloud on reconnect; local (phone-hosted)
    // miniapps have no server to bring them back, so the launcher restarts them
    // here from the persisted running flags. Runs last so newly installed/
    // upgraded bundles are on disk first. Best-effort — never block miniapp
    // init on it.
    miniappLauncher.autostartLocalMiniapps().catch((e) => console.warn("MANTLE: autostartLocalMiniapps failed", e))
  }

  /**
   * Install the miniapp zips bundled into the app binary under
   * @assets/miniapps. Metro's `require` needs static string literals, so the
   * BUNDLED_MINIAPPS require() list is code-generated from the directory
   * (see src/generated/bundledMiniapps.ts) rather than globbed at runtime.
   *
   * The asset name carries packageName + version, so we read those off the
   * filename and skip the bundle entirely when that exact version is already
   * installed — no unzip needed to check. Otherwise we materialize the asset
   * to disk (expo-asset gives us a file:// URI, but `File.downloadFileAsync`
   * is HTTP-only) and hand the local zip to AppRegistry, which unzips and
   * installs it.
   */
  private async installBundledMiniapps() {
    const deployment = deploymentStore.getActive()
    const approved =
      deployment.kind === "workspace" ? deployment.manifest.systemMiniapps.approvedPackageNamesOverride : null
    for (const module of BUNDLED_MINIAPPS) {
      try {
        const asset = Asset.fromModule(module)
        const parsed = parseBundledMiniappName(asset.name)
        if (parsed && approved !== null && !approved.includes(parsed.packageName)) {
          console.log(`MANTLE: skipping bundled miniapp outside workspace allowlist: ${parsed.packageName}`)
          continue
        }
        if (!parsed) {
          console.warn(`MANTLE: bundled miniapp asset name "${asset.name}" is not <packageName>-<version>`)
          continue
        }
        const {packageName, version} = parsed

        // China build: don't install hidden bundled miniapps (e.g. Mentra Map).
        if (isChinaBuild() && CHINA_HIDDEN_APPS.includes(packageName)) {
          continue
        }

        if (appRegistry.getInstalledVersions(packageName).includes(version)) {
          continue
        }

        let superMode = await engine.settings.get(SETTINGS.super_mode.key)
        if (!superMode && packageName === "com.mentra.example") {
          // skip installing the example miniapp if super mode is not enabled
          continue
        }

        await asset.downloadAsync()
        if (!asset.localUri) {
          console.warn(`MANTLE: bundled miniapp ${packageName} has no localUri after download`)
          continue
        }

        const res = await appRegistry.installFromLocalZip(asset.localUri)
        if (res.is_error()) {
          console.error(`MANTLE: failed to install bundled miniapp ${packageName}@${version}:`, res.error)
          continue
        }
        console.log(`MANTLE: installed bundled miniapp ${res.value.packageName}@${res.value.version}`)
      } catch (error) {
        console.error(`MANTLE: error installing bundled miniapp:`, error)
      }
    }
  }

  private async setupPeriodicTasks() {
    this.sendCalendarEvents()
    // Calendar sync every hour
    this.calendarSyncTimer = BgTimer.setInterval(
      () => {
        this.sendCalendarEvents()
      },
      60 * 60 * 1000,
    ) // 1 hour

    try {
      // only start location updates if we have the location permission (host UI gate);
      // the island PhoneLocationService owns the background task + accuracy at the saved tier.
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
      if (hasLocation) {
        const savedTier = await engine.settings.get<string>(SETTINGS.location_tier.key)
        await phoneLocationService.setLocationTier(savedTier as string)
      }
    } catch (error) {
      console.error("MANTLE: Error starting location updates", error)
    }

    // check for requirements immediately, but only if we've passed through onboarding:
    // const onboardingCompleted = await engine.settings.get(SETTINGS.onboarding_completed.key)
    // if (onboardingCompleted) {
    //   try {
    //     const requirementsCheck = await checkConnectivityRequirementsUI()
    //     if (!requirementsCheck) {
    //       return
    //     }
    //     // give some time for the glasses to be fully ready:
    //     BgTimer.setTimeout(async () => {
    //       await BluetoothSdk.connectDefault()
    //     }, 3000)
    //   } catch (error) {
    //     console.error("connect to glasses error:", error)
    //     showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    //   }
    // }
  }

  private async setupSubscriptions() {
    // (Device-settings -> glasses BLE sync AND phone-notification config -> the
    // native listener now live in island's GlassesSettingsSync / PhoneNotificationsSync,
    // started by engine.start(), so engine.glasses.settings.set() /
    // engine.phoneNotifications.* reach the device for any host. Removed here to
    // avoid a double-sync.)

    // Remove old event subscriptions
    this.subs.forEach((sub) => sub.remove())
    this.subs = []

    // LocalDisplayManager arbitrates foreground miniapp frames against
    // temporary background frames (notably phone notifications). Keep its
    // core owner projected from the app store so a notification can briefly
    // replace Captions and then restore the latest caption frame.
    let notifyWasRunning = this.isNotifyRunning()
    const syncAppPresentationState = () => {
      const apps = useAppStatusStore.getState().apps
      const coreApp = apps.find((app) => app.running && (app.type === "standard" || !app.type))
      localDisplayManager.onCoreAppChange(coreApp?.packageName ?? null)

      const notifyIsRunning = apps.some((app) => app.packageName === notifyPackageName && app.running)
      if (notifyWasRunning && !notifyIsRunning) {
        this.stopPhoneNotificationPresentation()
      }
      notifyWasRunning = notifyIsRunning
    }
    syncAppPresentationState()
    const unsubscribeAppPresentationState = useAppStatusStore.subscribe(syncAppPresentationState)
    this.subs.push({remove: unsubscribeAppPresentationState})

    // A remembered speaker-capable model survives disconnects, but its audio
    // route does not. Tear down queued and active Notify speech on the
    // connected -> disconnected transition so it cannot continue on the phone
    // speaker. The generation bump also invalidates synthesis already in flight.
    let glassesWereConnected = engine.glasses.status().state === "connected"
    const unsubscribeGlassesPresentationState = engine.glasses.onStatus((status) => {
      const glassesAreConnected = status.state === "connected"
      if (glassesWereConnected && !glassesAreConnected) {
        this.stopPhoneNotificationPresentation()
      }
      glassesWereConnected = glassesAreConnected
    })
    this.subs.push({remove: unsubscribeGlassesPresentationState})

    // (The device-status projection — onBluetoothStatus -> core store and
    // onGlassesStatus -> glasses store — moved into island's GlassesStatusProjection,
    // started by engine.start(), so the device->store feed reaches ANY host. Removed
    // here to avoid a double-projection.)

    // Subscribe to individual Bluetooth SDK events.
    {
      this.subs.push(
        BluetoothSdk.addListener("log", (event) => {
          if (event.message?.startsWith("MAN: displayEvent ")) return
          console.log("CORE:", event.message)
        }),
      )

      // wifi_status_change / glasses_wifi / hotspot_status_change:
      // moved to island DeviceEventRouter (started by engine.start())

      // hotspot_error: moved to island DeviceEventRouter (started by engine.start())

      // gallery_status: moved to island DeviceEventRouter (started by engine.start())

      // photo_response: moved to island DeviceEventRouter (started by engine.start())

      this.subs.push(
        BluetoothSdk.addListener("heartbeat_sent", (event) => {
          console.log("MANTLE: received heartbeat_sent event from Bluetooth SDK", event.heartbeat_sent)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_sent", {
            timestamp: event.heartbeat_sent.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("heartbeat_received", (event) => {
          console.log("MANTLE: received heartbeat_received event from Bluetooth SDK", event.heartbeat_received)
          // TODO: remove the global event emitter and sub directly in the component where needed
          GlobalEventEmitter.emit("heartbeat_received", {
            timestamp: event.heartbeat_received.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("send_command_to_ble", (event) => {
          GlobalEventEmitter.emit("send_command_to_ble", {
            command: event.command,
            commandText: event.commandText,
            timestamp: event.timestamp,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("receive_command_from_ble", (event) => {
          GlobalEventEmitter.emit("receive_command_from_ble", {
            command: event.command,
            commandText: event.commandText,
            timestamp: event.timestamp,
          })
        }),
      )

      // button_press / touch_event / accel_event: local-miniapp forwarding lives in
      // island DeviceEventRouter (started by engine.start()). The Cloud V1 relays
      // (button/touch/swipe/switch/rgb-led-response) were removed with Cloud V1 app
      // end-of-life.

      this.subs.push(
        BluetoothSdk.addListener("pair_failure", (event) => {
          GlobalEventEmitter.emit("pair_failure", event.error)
        }),
      )

      // NOTE: audio_pairing_needed / audio_connected / audio_disconnected / save_setting /
      // head_up were registered a SECOND time below (the duplicate block), so each handler
      // fired twice per event. The duplicates are removed here; the single registrations
      // live further down (head_up there is the superset — it also forwards to miniapps).

      const forwardPhoneNotification = async (event: any) => {
        const notificationId = String(event.notificationId ?? "")
        const app = String(event.app ?? "").trim()
        const title = String(event.title ?? "").trim()
        const content = String(event.content ?? "").trim()

        // Worth logging: priority was hardcoded to "normal" for every
        // notification, which made every consumer's priority handling dead code
        // and gave no way to tell from the outside. Log the value, never the
        // notification text.
        console.log(`MANTLE: phone_notification from ${app}, priority=${event.priority}`)

        // Direct forward to local miniapps subscribed to phone_notification.
        // Gated by READ_NOTIFICATIONS in miniapp.json at subscribe time.
        localMiniappRuntime.forwardEvent("phone_notification", {
          notificationId,
          app,
          title,
          content,
          priority: event.priority?.toString?.() ?? String(event.priority ?? ""),
          timestamp: parseInt(event.timestamp?.toString?.() ?? "0"),
          packageName: event.packageName,
        })

        // Capture/forwarding is independent from presentation. Notify is the
        // user-controlled presentation surface: if it is not running, no card
        // and no speech may interrupt the wearer. This also keeps presentation
        // intentionally unavailable on iOS while Notify is omitted from the
        // built-in catalog there.
        if (!this.isNotifyRunning()) return

        // Cloud V1 used to relay this event to the Notify miniapp, which then
        // painted the glasses. Notify is now an offline built-in, so render the
        // temporary card locally through the same display arbiter as miniapps.
        // As a background owner it overlays the foreground app briefly; expiry
        // restores that app's retained frame instead of stopping it.
        const displayTitle = title && title !== app ? [app, title].filter(Boolean).join(": ") : title || app
        if (displayTitle || content) {
          this.activePhoneNotificationId = notificationId || null
          localDisplayManager.request(notifyPackageName, {
            layout: {
              layoutType: "reference_card",
              title: displayTitle || "Notification",
              text: content,
            },
            durationMs: 5_000,
          })
          // Glasses with no screen (Mentra Live) would otherwise get nothing at
          // all from the card above — the notification arrives and is stored,
          // but the wearer never learns about it. Read it out instead (OS-1821).
          // Pass the raw app/title rather than displayTitle: the speech path
          // builds its own phrasing, and priority lets it skip the notifications
          // an app explicitly marked as non-interrupting.
          const priorityValue = Number(event.priority)
          void this.speakPhoneNotification(
            app,
            title,
            content,
            Number.isFinite(priorityValue) ? priorityValue : undefined,
          )
        }
      }

      // Android: Crust's NotificationListenerService reads notifications.
      this.subs.push((CrustModule.addListener as any)("phone_notification", forwardPhoneNotification))

      // iOS: connected glasses consume ANCS and relay notifications through
      // the Bluetooth SDK, which feeds the identical local event path.
      this.subs.push(BluetoothSdk.addListener("phone_notification", forwardPhoneNotification))

      const forwardPhoneNotificationDismissed = async (event: any) => {
        // Direct forward to local miniapps subscribed to
        // phone_notification_dismissed. Gated by READ_NOTIFICATIONS at
        // subscribe time.
        localMiniappRuntime.forwardEvent("phone_notification_dismissed", {
          notificationId: event.notificationId,
          notificationKey: event.notificationKey,
          packageName: event.packageName,
          timestamp: event.timestamp ?? Date.now(),
        })

        const notificationId = String(event.notificationId ?? "")
        if (notificationId && notificationId === this.activePhoneNotificationId) {
          this.activePhoneNotificationId = null
          localDisplayManager.dismiss(notifyPackageName)
        }
      }

      this.subs.push(
        (CrustModule.addListener as any)("phone_notification_dismissed", forwardPhoneNotificationDismissed),
      )
      this.subs.push(BluetoothSdk.addListener("phone_notification_dismissed", forwardPhoneNotificationDismissed))

      this.subs.push(
        BluetoothSdk.addListener("audio_pairing_needed", (event) => {
          GlobalEventEmitter.emit("audio_pairing_needed", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_connected", (event) => {
          GlobalEventEmitter.emit("audio_connected", {
            deviceName: event.deviceName,
          })
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("audio_disconnected", () => {
          GlobalEventEmitter.emit("audio_disconnected", {})
        }),
      )

      // save_setting: moved to island DeviceEventRouter (started by engine.start())

      this.subs.push(
        BluetoothSdk.addListener("head_up", (event) => {
          mantle.handle_head_up(event.up)
          // forwardEvent("head_up") -> local miniapps moved to island DeviceEventRouter
        }),
      )

      // this.subs.push(
      //   BluetoothSdk.addListener("vad", (event) => {
      //     localMiniappRuntime.forwardEvent("VAD", event)
      //     localSttFallbackCoordinator.onVad(!!event?.status)
      //   }),
      // )

      // miniapp_selected: moved to island DeviceEventRouter (started by engine.start())

      // local_transcription: moved to island DeviceEventRouter (started by engine.start());
      // its offline-captions display path was removed with the pseudo captions renderer.

      // ws_text: was a raw relay onto the Cloud V1 socket — removed with Cloud V1
      // app end-of-life.

      this.subs.push(
        BluetoothSdk.addListener("mic_lc3", (_event) => {
          this.noteMicDataReceived()

          // console.log("MANTLE: Received mic_lc3 event from Bluetooth SDK", event.lc3.length)

          // Cloud upload moved to island's AudioCloudUplink (started by engine.start()).
          // This host-side listener only keeps the debug mic-activity flag current.
        }),
      )

      this.subs.push(
        BluetoothSdk.addListener("mic_pcm", (event) => {
          // mic_pcm events are strictly on-device. Cloud V2 receives LC3 through
          // island's AudioCloudUplink; never forward PCM bytes upstream.
          // Sherpa-ONNX is fed PCM natively inside the BT SDK, not here.
          this.noteMicDataReceived()

          // Fan raw PCM to local miniapps that subscribed to `audio_chunk`
          // (session.mic.onAudioChunk). forwardEvent is subscriber-gated —
          // a no-op when no miniapp is listening — and should_send_pcm is
          // only flipped on by the runtime when a subscription exists.
          // ArrayBuffer can't survive the JSON bridge, so base64-encode.
          // PERF: ~100 events/sec/subscriber, unbatched; revisit with
          // frame batching if a real always-on audio miniapp ships.
          localMiniappRuntime.forwardEvent("audio_chunk", {
            data: Buffer.from(event.pcm).toString("base64"),
            sampleRate: event.sampleRate,
            format: event.encoding,
          })
        }),
      )

      // stream_status / keep_alive_ack: phone-owned streams are handled by the island
      // stream coordinator (DeviceEventRouter). The Cloud V1 relay for non-phone-owned
      // (cloud-SDK app) streams was removed with Cloud V1 app end-of-life.

      // OTA availability (`ota_update_available`) was removed in the OTA-simplify
      // path; update discovery now comes from the phone-side manifest check. The
      // remaining OTA BLE handlers (mtk_update_complete / ota_start_ack /
      // ota_status -> island stores + clock-skew auto-fix) moved into island's
      // OtaService, started by engine.start(), behind the engine.ota read surface.
    }

    // One-time core/glasses status hydration moved into island's
    // GlassesStatusProjection, started by engine.start().
  }

  private async sendCalendarEvents() {
    try {
      // Ungranted CALENDAR permission is the default state — skip quietly
      // instead of letting getCalendarsAsync throw into the catch as an error.
      const {status} = await Calendar.getCalendarPermissionsAsync()
      if (status !== "granted") {
        console.log("MANTLE: sendCalendarEvents() skipped - calendar permission not granted")
        return
      }
      console.log("MANTLE: sendCalendarEvents()")
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const calendarIds = calendars.map((calendar: Calendar.Calendar) => calendar.id)
      // from 2 hours ago to 3 days from now:
      const startDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const endDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      let events = await Calendar.getEventsAsync(calendarIds, startDate, endDate)

      // sort by start date (soonest first)
      events.sort((a: Calendar.Event, b: Calendar.Event) => {
        return new Date(a.startDate as string | Date).getTime() - new Date(b.startDate as string | Date).getTime()
      })

      // limit to first 3 events:
      events = events.slice(0, 3)

      // Shape into the {title, location?, time, endDate} contract the SDK expects.
      // time is a pre-formatted display label; endDate is unix seconds.
      const shapedEvents = events.map((ev: Calendar.Event) => {
        const start = new Date(ev.startDate as string | Date)
        const end = new Date(ev.endDate as string | Date)
        let time: string

        if (ev.allDay) {
          time = "All day"
        } else {
          time = start.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
        }
        // add the duration of the event, i.e. "10:00AM - 11:00AM"
        const duration = end.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
        if (!ev.allDay) {
          time += ` - ${duration}`
        }
        return {
          title: ev.title ?? "",
          ...(ev.location ? {location: ev.location} : {}),
          time,
          endDate: Math.floor(end.getTime() / 1000),
        }
      })
      try {
        await BluetoothSdk.setCalendarEvents(shapedEvents)
      } catch (error) {
        console.warn("MANTLE: Failed to sync calendar events to glasses", error)
      }
    } catch (error) {
      // it's fine if this fails
      console.log("MANTLE: Error sending calendar events", error)
    }
  }

  // getLocationAccuracy + setLocationTier (+ the background location task) moved into
  // island (PhoneLocationService). requestSingleLocation (a one-shot triggered only by
  // the Cloud V1 request_single_location push) was removed with Cloud V1 app
  // end-of-life.

  public async handle_head_up(isUp: boolean) {
    // Only switch to dashboard view if contextual dashboard is enabled
    // Otherwise, always show main view regardless of head position
    const contextualDashboardEnabled = await engine.settings.get(SETTINGS.contextual_dashboard.key)

    if (isUp && contextualDashboardEnabled) {
      engine.display.mirror.setView("dashboard")
    } else {
      engine.display.mirror.setView("main")
    }
  }
}

const mantle = MantleManager.getInstance()
export default mantle
