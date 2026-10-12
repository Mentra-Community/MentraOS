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
import {useAppStatusStore} from "../stores/apps"
import {onDeferredMiniappUpdateReady} from "../services/deferredMiniappUpdates"
import localMiniappRuntime from "../services/LocalMiniappRuntime"
import {
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  type PendingRunningUpdatePrompt,
  type RunningUpdateFailure,
} from "../services/runningUpdatePrompt"
import type {ClientApp} from "../types"

type AppsState = ReturnType<typeof useAppStatusStore.getState>

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
   * Render "update now?" prompts for running miniapps and answer each one. The
   * engine decides when one may appear (foreground, one at a time, at most
   * daily per miniapp). Returns an unsubscribe.
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
