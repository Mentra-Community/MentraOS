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
import {getConfigValues} from "../runtime/bootstrap"
import appRegistry from "../services/AppRegistry"
import {cloudClientService} from "../services/CloudClientService"
import {onDeferredMiniappUpdateReady} from "../services/deferredMiniappUpdates"
import {normalizeCoreUrl} from "../services/fleet/coreUrl"
import {installMiniapp, type InstallMiniappOptions, type InstallMiniappResult} from "../services/installMiniapp"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {fetchMiniappBundle, fetchMiniappJson} from "../services/miniappFetch"
import {registryStatusStore} from "../services/miniappRegistryStatusStore"
import {installMiniappRelease} from "../services/miniappReleaseInstall"
import {MiniappUrlUpdater} from "../services/miniappUrlUpdates"
import {
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  onRunningUpdatePromptDue,
  type PendingRunningUpdatePrompt,
  type RunningUpdateFailure,
} from "../services/runningUpdatePrompt"
import {isSystemMiniappPackage} from "../services/SystemMiniappPolicy"
import {firstPartyMiniappUrl} from "../services/systemMiniappTrust"
import {onMiniappOpenedByUser, useAppStatusStore} from "../stores/apps"
import type {ClientApp} from "../types"
import {MiniappRunningError} from "../utils/storeInstallRuntime"

type AppsState = ReturnType<typeof useAppStatusStore.getState>

// A named function alias lets declaration inference choose the excluded internal
// barrel. Keep its identity, but describe this public member with public DTOs.
const install: (url: string, options: InstallMiniappOptions) => Promise<InstallMiniappResult> = installMiniapp

const urlUpdater = new MiniappUrlUpdater({
  installedPackages: async () =>
    (await appRegistry.getInstalledMiniapps({includeBackgroundOnly: true})).map((app) => app.packageName),
  activeVersion: (packageName) => appRegistry.getActiveVersion(packageName),
  releaseIdentity: (packageName, version) => appRegistry.getReleaseIdentity(packageName, version),
  isSystemPackage: isSystemMiniappPackage,
  firstPartyUrl: (packageName) => firstPartyMiniappUrl(getConfigValues(), packageName),
  hasDevelopmentSelection: (packageName) => localMiniappRuntime.hasDevelopmentSelection(packageName),
  compatibilityPolicy: () => {
    const policy = localMiniappRuntime.currentInstallCompatibilityPolicy()
    return policy ? {hostVersion: policy.hostVersion, supportedSdkRange: policy.supportedSdkRange} : null
  },
  // Redirects come back to the updater, which follows moves itself.
  fetchManifest: (url, {etag, packageName}) =>
    fetchMiniappJson(url, {...(etag ? {etag} : {}), packageForChallenge: packageName, redirect: "manual"}),
  fetchBundle: (url, options) => fetchMiniappBundle(url, options),
  install: installMiniappRelease,
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
  log: (message) => console.log(`MiniappUpdates: ${message}`),
  warn: (message, error) => console.warn(`MiniappUpdates: ${message}`, error ?? ""),
})

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
   * Check every installed miniapp's own URL and install newer releases,
   * silently. A running miniapp's update waits until it stops.
   */
  checkForUpdates: (): Promise<void> => urlUpdater.checkAll(),
  /**
   * Check a miniapp a person just opened, unless it was checked within the
   * last minute. Its update is staged and asked about.
   */
  checkOpenedForUpdate: (packageName: string): Promise<void> => urlUpdater.checkOpened(packageName),
  /**
   * A person opened a miniapp: started it themselves, or opened one again after answering Not now to its update.
   * Automatic starts (restoring what ran before, an update's restart) are not announced. Returns an unsubscribe.
   */
  onOpened: (listener: (packageName: string) => void): (() => void) => {
    const unsubscribeStarted = onMiniappOpenedByUser(listener)
    const unsubscribeDue = onRunningUpdatePromptDue(listener)
    return () => {
      unsubscribeStarted()
      unsubscribeDue()
    }
  },
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
  /** Uninstall a miniapp. */
  uninstall: (...args: Parameters<AppsState["uninstall"]>) => useAppStatusStore.getState().uninstall(...args),
  /** Persist a miniapp's captured screenshot (the switcher/card preview). */
  saveScreenshot: (...args: Parameters<AppsState["saveScreenshot"]>) =>
    useAppStatusStore.getState().saveScreenshot(...args),
  /** Hide/show a miniapp on the home surfaces. */
  setHiddenStatus: (...args: Parameters<AppsState["setHiddenStatus"]>) =>
    useAppStatusStore.getState().setHiddenStatus(...args),
}
