/**
 * miniapps facade — `engine.miniapps`: miniapp lifecycle over the engine-owned
 * apps store. Thin forwarding (args via Parameters<>), so the facade never drifts
 * from the store's actions.
 *
 * The miniapp WebView is a HOST component (engine ships the bridge, not the view) —
 * the bridge primitives (`buildMiniappGlobalsScript`, `buildMentraUiShim`, the
 * MentraJS router) are exported from `@mentra/engine` directly; the host mounts a
 * `<WebView>` wired to them. This facade is the lifecycle half.
 */
import {getConfigValues, isDevMiniappAllowed} from "../runtime/bootstrap"
import appRegistry from "../services/AppRegistry"
import {cloudClientService} from "../services/CloudClientService"
import {onDeferredMiniappUpdateReady} from "../services/deferredMiniappUpdates"
import devServerBridge from "../services/DevServerBridge"
import {normalizeCoreUrl} from "../services/fleet/coreUrl"
import {
  installMiniapp,
  readMiniappListing,
  type InstallMiniappOptions,
  type InstallMiniappResult,
} from "../services/installMiniapp"
import {installMiniappFromLink, type InstallMiniappFromLinkOptions} from "../services/installMiniappFromLink"
import {installLocalBuild} from "../services/localBuildInstall"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {fetchMiniappBundle, fetchMiniappJson} from "../services/miniappFetch"
import {miniappPins} from "../services/miniappPins"
import {registryStatusStore} from "../services/miniappRegistryStatusStore"
import {installMiniappRelease} from "../services/miniappReleaseInstall"
import {miniappLauncher, type MiniappStartWait} from "../services/MiniappLauncher"
import {LOCAL_CHECK_TIMEOUT_MS, MiniappUrlUpdater, START_UPDATE_LIMITS} from "../services/miniappUrlUpdates"
import {
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  onRunningUpdatePromptDue,
  type PendingRunningUpdatePrompt,
  type RunningUpdateFailure,
} from "../services/runningUpdatePrompt"
import {isSystemMiniappPackage} from "../services/SystemMiniappPolicy"
import {firstPartyMiniappUrl} from "../services/systemMiniappTrust"
import {launchesWithPairedGlasses, useAppStatusStore} from "../stores/apps"
import type {ClientApp} from "../types"
import {MiniappRunningError} from "../utils/storeInstallRuntime"
import {BgTimer} from "../utils/timers"

type AppsState = ReturnType<typeof useAppStatusStore.getState>

// A named function alias lets declaration inference choose the excluded internal
// barrel. Keep its identity, but describe this public member with public DTOs.
const install: (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult> = installMiniapp
const installFromLink: (link: string, options: InstallMiniappFromLinkOptions) => Promise<InstallMiniappResult> =
  installMiniappFromLink

const urlUpdater = new MiniappUrlUpdater({
  installedPackages: async () =>
    (await appRegistry.getInstalledMiniapps({includeBackgroundOnly: true})).map((app) => app.packageName),
  activeVersion: (packageName) => appRegistry.getActiveVersion(packageName),
  releaseIdentity: (packageName, version) => appRegistry.getReleaseIdentity(packageName, version),
  isSystemPackage: isSystemMiniappPackage,
  firstPartyUrl: (packageName) => firstPartyMiniappUrl(getConfigValues(), packageName),
  isDevelopmentBuild: (packageName) => appRegistry.isDevelopmentBuild(packageName),
  developmentAllowed: (packageName) => isDevMiniappAllowed(packageName),
  pinFor: miniappPins.pinFor,
  compatibilityPolicy: () => ({hostVersion: getConfigValues().hostVersion}),
  launchesWithPairedGlasses,
  // Redirects come back to the updater, which follows moves itself. A local address is asked nothing more than its
  // files, and has a short time to answer.
  fetchManifest: (url, {etag, packageName, local}) =>
    fetchMiniappJson(url, {
      ...(etag ? {etag} : {}),
      ...(local ? {timeoutMs: LOCAL_CHECK_TIMEOUT_MS} : {packageForChallenge: packageName}),
      redirect: "manual",
    }),
  fetchBundle: (url, {local, ...options}) =>
    fetchMiniappBundle(url, {...options, ...(local ? {answerChallenge: false} : {})}),
  install: installMiniappRelease,
  installLocal: installLocalBuild,
  keepVersions: (packageName, versions) => appRegistry.gcReleaseVersions(packageName, versions),
  isRunningError: (error) => error instanceof MiniappRunningError,
  installSession: () => localMiniappRuntime.installSession(),
  requireRegistry: () => getConfigValues().requireRegistry !== false,
  // The Core this build is configured for, which the kept answer belongs to whether or not its client exists yet.
  registryCore: () => {
    try {
      return normalizeCoreUrl(cloudClientService.getCoreUrl())
    } catch {
      return null
    }
  },
  // Only that Core's client answers; before it exists, or while it speaks for another Core, nothing is asked.
  registryStatus: (core, request) => cloudClientService.core.registry.statusAs(core, request),
  register: (request) => cloudClientService.core.registry.register(request),
  statusStore: registryStatusStore,
  setReleaseSourceUrl: (packageName, version, fromUrl, sourceUrl) =>
    appRegistry.setReleaseSourceUrl(packageName, version, fromUrl, sourceUrl),
  now: () => Date.now(),
  setTimeout: (callback, ms) => BgTimer.setTimeout(callback, ms),
  clearTimeout: (handle) => BgTimer.clearTimeout(handle as number),
  log: (message) => console.log(`MiniappUpdates: ${message}`),
  warn: (message, error) => console.warn(`MiniappUpdates: ${message}`, error ?? ""),
})

// Every start of a miniapp that isn't running waits for this check first, in the launcher.
miniappLauncher.setUpdateCheck((packageName, onInstalling) =>
  urlUpdater.checkBeforeStart(packageName, START_UPDATE_LIMITS, onInstalling),
)
// A local build's server says a new build is ready, or its console connection opened: check its address now.
devServerBridge.onCheck((packageName) => urlUpdater.checkNow(packageName))

export const miniapps = {
  /** All installed miniapps (snapshot). */
  // Copy: the snapshot must not hand callers a mutable reference into the store.
  list: (): ClientApp[] => [...useAppStatusStore.getState().apps],
  /** Subscribe to the installed-app set; fires only when it changes. Returns an unsubscribe. */
  onChanged: (cb: (apps: ClientApp[]) => void): (() => void) => {
    let last = JSON.stringify(useAppStatusStore.getState().apps)
    return useAppStatusStore.subscribe(() => {
      const apps = useAppStatusStore.getState().apps
      const key = JSON.stringify(apps)
      if (key === last) return
      last = key
      cb(apps)
    })
  },

  /** Miniapps actively subscribed to Mentra Live hardware-button events. */
  buttonPressSubscribers: (): string[] => localMiniappRuntime.getButtonPressSubscribers(),
  /** Observe the active Mentra Live hardware-button subscriber set. */
  onButtonPressSubscribersChanged: (cb: (packageNames: string[]) => void): (() => void) =>
    localMiniappRuntime.onButtonPressSubscribersChanged(cb),

  /** Re-fetch the installed-app list from the backend. */
  refresh: () => useAppStatusStore.getState().refresh(),
  /** Start (foreground) a miniapp. */
  start: (...args: Parameters<AppsState["start"]>) => useAppStatusStore.getState().start(...args),
  /** Stop a miniapp. */
  stop: (...args: Parameters<AppsState["stop"]>) => useAppStatusStore.getState().stop(...args),
  /** Bring a running miniapp to the foreground. */
  setForeground: (...args: Parameters<AppsState["setForeground"]>) =>
    useAppStatusStore.getState().setForeground(...args),
  /** Clear the current foreground miniapp. */
  clearForeground: () => useAppStatusStore.getState().clearForeground(),
  /**
   * Invoke a manifest-declared action as the trusted host. Host-audience
   * actions are unavailable through `session.actions.invoke`.
   */
  invokeAction: (
    packageName: string,
    actionId: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> => localMiniappRuntime.invokeActionFromHost(packageName, actionId, params, timeoutMs),
  /**
   * Check every installed miniapp's own URL and install what it serves when
   * that is another build than the one installed, silently. A running
   * miniapp's update is asked about (`onUpdatePrompt`), or waits until it stops.
   */
  checkForUpdates: (): Promise<void> => urlUpdater.checkAll(),
  /**
   * What a start of the miniapp waits for before it runs, or null when none waits. A miniapp that isn't running is
   * checked for an update before it starts, so that another build installs while it is stopped instead of asking
   * to restart it: `"check"` while its URL is checked, for 5 seconds at most, then `"update"` while the build that
   * check found installs, for 30 seconds at most. The host shows the miniapp's splash meanwhile, and says it is
   * updating during `"update"`. `stop` cancels a start that still waits: nothing starts.
   */
  startWait: (packageName: string): MiniappStartWait | null => miniappLauncher.startWait(packageName),
  /** Called whenever `startWait` changes for any miniapp. Returns an unsubscribe. */
  onStartWaitChanged: (listener: () => void): (() => void) => miniappLauncher.onStartWaitChanged(listener),
  /**
   * Render "update now?" prompts for running miniapps and answer each one. The
   * engine decides when one may appear (foreground, one at a time; after Not
   * now, only once the person opens that miniapp again). Returns an unsubscribe.
   */
  onUpdatePrompt: (listener: (prompt: PendingRunningUpdatePrompt) => void): (() => void) =>
    onRunningUpdatePrompt(listener),
  /** An accepted update failed; the installed version was started again. Returns an unsubscribe. */
  onUpdateFailed: (listener: (failure: RunningUpdateFailure) => void): (() => void) => onRunningUpdateFailed(listener),
  /**
   * A miniapp whose automatic update waited for it has stopped, or was opened again after Not now so its update may
   * ask again: run the updater for it. Returns an unsubscribe.
   */
  onDeferredUpdateReady: (listener: (packageName: string) => void): (() => void) => {
    const unsubscribeStopped = onDeferredMiniappUpdateReady(listener)
    const unsubscribeDue = onRunningUpdatePromptDue(listener)
    return () => {
      unsubscribeStopped()
      unsubscribeDue()
    }
  },
  /** Stop all running miniapps. */
  stopAll: () => useAppStatusStore.getState().stopAll(),
  /**
   * Install the miniapp at a miniapp URL: fetch its `miniapp.json` (answering a sign-in challenge), check the domain
   * rule, register the URL, ask through `confirm` unless headless, check the phone can run it, then download, verify
   * and install the ZIP. Resolves `installed`, `opened` (already installed) or `deferred`; throws
   * `InstallMiniappError` with a code.
   */
  install,
  /**
   * Install from what a person opened, scanned or pasted: an open link (`apps.mentraglass.com/open?url=…`, or
   * `<scheme>://open?url=…` on one of the host app's `schemes`), a package link (looked up in `directoryUrl`) or a
   * miniapp URL. Resolves as `install` does; throws `MiniappLinkError` when the link names nothing to install, and
   * `InstallMiniappError` when the install stops.
   */
  installFromLink,
  /**
   * Read what the miniapp at a miniapp URL is called, its icon and version, from its `miniapp.json`, without
   * installing anything. Throws `InstallMiniappError` with a code.
   */
  readListing: (url: string) => readMiniappListing(url),
  /** Uninstall a miniapp. */
  uninstall: (...args: Parameters<AppsState["uninstall"]>) => useAppStatusStore.getState().uninstall(...args),
  /** Persist a miniapp's captured screenshot (the switcher/card preview). */
  saveScreenshot: (...args: Parameters<AppsState["saveScreenshot"]>) =>
    useAppStatusStore.getState().saveScreenshot(...args),
  /** Hide/show a miniapp on the home surfaces. */
  setHiddenStatus: (...args: Parameters<AppsState["setHiddenStatus"]>) =>
    useAppStatusStore.getState().setHiddenStatus(...args),
}
