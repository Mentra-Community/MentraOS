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
import {onDeferredMiniappUpdateReady} from "../services/deferredMiniappUpdates"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {installMiniappRelease} from "../services/miniappReleaseInstall"
import {miniappRunningRegistry} from "../services/MiniappRunningRegistry"
import {fetchHostedManifest, MiniappUrlUpdater} from "../services/miniappUrlUpdates"
import {
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  type PendingRunningUpdatePrompt,
  type RunningUpdateFailure,
} from "../services/runningUpdatePrompt"
import {isSystemMiniappPackage} from "../services/SystemMiniappPolicy"
import {firstPartyMiniappUrl} from "../services/systemMiniappTrust"
import {useAppStatusStore} from "../stores/apps"
import type {ClientApp} from "../types"
import {MiniappRunningError} from "../utils/storeInstallRuntime"

type AppsState = ReturnType<typeof useAppStatusStore.getState>

const urlUpdater = new MiniappUrlUpdater({
  installedPackages: async () =>
    (await appRegistry.getInstalledMiniapps({includeBackgroundOnly: true})).map((app) => app.packageName),
  activeVersion: (packageName) => appRegistry.getActiveVersion(packageName),
  releaseIdentity: (packageName, version) => appRegistry.getReleaseIdentity(packageName, version),
  isSystemPackage: isSystemMiniappPackage,
  firstPartyUrl: (packageName) => firstPartyMiniappUrl(getConfigValues(), packageName),
  hasDevelopmentSelection: (packageName) => localMiniappRuntime.hasDevelopmentSelection(packageName),
  compatibilityPolicy: () => localMiniappRuntime.currentInstallCompatibilityPolicy(),
  fetchManifest: fetchHostedManifest,
  install: installMiniappRelease,
  keepVersions: (packageName, versions) => appRegistry.gcReleaseVersions(packageName, versions),
  isRunningError: (error) => error instanceof MiniappRunningError,
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
   * Check every installed miniapp's own URL and install newer releases. A
   * running miniapp's update is staged and asked about, or waits until it stops.
   */
  checkForUpdates: (): Promise<void> => urlUpdater.checkAll(),
  /** Check a miniapp the user just opened, unless it was checked within the last minute. */
  checkOpenedForUpdate: (packageName: string): Promise<void> => urlUpdater.checkOpened(packageName),
  /** A miniapp started running. Returns an unsubscribe. */
  onOpened: (listener: (packageName: string) => void): (() => void) => {
    let running = new Set(miniappRunningRegistry.getAll())
    return miniappRunningRegistry.subscribe(() => {
      const now = miniappRunningRegistry.getAll()
      for (const packageName of now) {
        if (running.has(packageName)) continue
        try {
          listener(packageName)
        } catch (error) {
          console.warn("Miniapp opened listener threw", error)
        }
      }
      running = new Set(now)
    })
  },
  /**
   * Render "update now?" prompts for running miniapps and answer each one. The
   * engine decides when one may appear (foreground, one at a time, once per
   * run of a miniapp). Returns an unsubscribe.
   */
  onUpdatePrompt: (listener: (prompt: PendingRunningUpdatePrompt) => void): (() => void) =>
    onRunningUpdatePrompt(listener),
  /** An accepted update failed; the installed version was started again. Returns an unsubscribe. */
  onUpdateFailed: (listener: (failure: RunningUpdateFailure) => void): (() => void) => onRunningUpdateFailed(listener),
  /** A miniapp whose automatic update waited for it has stopped. Returns an unsubscribe. */
  onDeferredUpdateReady: (listener: (packageName: string) => void): (() => void) =>
    onDeferredMiniappUpdateReady(listener),
  /** Stop all running miniapps. */
  stopAll: () => useAppStatusStore.getState().stopAll(),
  /** Install a miniapp from a bundle URL. */
  install: (...args: Parameters<AppsState["install"]>) => useAppStatusStore.getState().install(...args),
  /** Uninstall a miniapp. */
  uninstall: (...args: Parameters<AppsState["uninstall"]>) => useAppStatusStore.getState().uninstall(...args),
  /** Persist a miniapp's captured screenshot (the switcher/card preview). */
  saveScreenshot: (...args: Parameters<AppsState["saveScreenshot"]>) =>
    useAppStatusStore.getState().saveScreenshot(...args),
  /** Hide/show a miniapp on the home surfaces. */
  setHiddenStatus: (...args: Parameters<AppsState["setHiddenStatus"]>) =>
    useAppStatusStore.getState().setHiddenStatus(...args),
}
