import {NativeModule, requireNativeModule} from "expo"

import {CrustModuleEvents, InstalledApp} from "./Crust.types"

declare class CrustModule extends NativeModule<CrustModuleEvents> {
  PI: number
  hello(): string
  setValueAsync(value: string): Promise<void>
  nativeHttpRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | null,
  ): Promise<{status: number; statusText: string; headers: Record<string, string>; body: string}>
  showAVRoutePicker(tintColor?: string | null): void

  /**
   * iOS: configure `preferredScreenEdgesDeferringSystemGestures`. When an
   * edge is deferred, the first swipe across that edge is consumed by the
   * app and the system gesture (Control Center, Notification Center, Home
   * indicator) only fires on a second swipe — i.e. a two-swipe-to-exit UX.
   *
   * Pass `[]` to restore default behavior. Android: no-op (Android has no
   * per-app equivalent; system gestures are configured at the OS level).
   */
  setDeferredSystemGestures(edges: Array<"top" | "bottom" | "left" | "right" | "all">): Promise<void>

  // MentraOS Notification Commands
  setNotificationConfig(listenerEnabled: boolean, blocklist: string[]): Promise<void>
  getInstalledApps(): Promise<InstalledApp[]>
  getInstalledAppsForNotifications(): Promise<InstalledApp[]>
  hasNotificationListenerPermission(): Promise<boolean>
  openNotificationListenerSettings(): Promise<boolean>
  isBetaBuild(): Promise<boolean>
  // location services commands
  showLocationServicesDialog(): Promise<boolean>
  isLocationServicesEnabled(): Promise<boolean>
  openLocationSettings(): Promise<boolean>
  openAppSettings(): Promise<boolean>
  openBluetoothSettings(): Promise<boolean>

  // Image Processing Commands
  processGalleryImage(
    inputPath: string,
    outputPath: string,
    options: {
      lensCorrection?: boolean
      colorCorrection?: boolean
    },
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  mergeHdrBrackets(
    underPath: string,
    normalPath: string,
    overPath: string,
    outputPath: string,
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  stabilizeVideo(
    inputPath: string,
    imuPath: string,
    outputPath: string,
  ): Promise<{
    success: boolean
    outputPath?: string
    processingTimeMs?: number
    error?: string
  }>

  // Media Library Commands
  saveToGalleryWithDate(
    filePath: string,
    captureTimeMillis?: number,
    displayName?: string,
  ): Promise<{
    success: boolean
    uri?: string
    identifier?: string
    existing?: boolean
    error?: string
  }>

  // Navigation (Android only — iOS stubs return error)
  startNavigation(
    lat: number,
    lng: number,
    options?: {
      simulate?: boolean
      speedMultiplier?: number
      /** Optional multi-stop list. When present takes precedence over lat/lng. Last entry is the final destination. */
      stops?: Array<{lat: number; lng: number}>
      /** "walking" | "driving" | "cycling" | "two_wheeler". Defaults driving. */
      mode?: string
      avoid?: {highways?: boolean; tolls?: boolean; ferries?: boolean}
      /** Force a reroute when the user is more than N meters past a pivot they didn't take. */
      missedTurnRerouteMeters?: number
    },
  ): Promise<{ok: boolean; error?: string}>
  stopNavigation(): Promise<{ok: boolean; error?: string}>

  /**
   * Show the Google Nav SDK Terms & Conditions dialog if not already
   * accepted. Idempotent — resolves immediately with `{accepted: true}`
   * when the user has already accepted (cached in-process / on-disk /
   * inside the SDK).
   */
  requestNavigationPermission(): Promise<{ok: boolean; accepted: boolean; error?: string}>

  /**
   * Dev-only: clear cached T&C acceptance (SDK flag + on-disk pref +
   * in-process flag) so the next requestNavigationPermission() re-shows
   * the dialog. Android only; iOS returns {ok: false, error: "not
   * supported on iOS"}.
   */
  resetNavigationPermission(): Promise<{ok: boolean; error?: string}>

  /**
   * Dev-only: nudge the simulated user position ~offsetMeters perpendicular
   * to the route so the Nav SDK reroutes. Default 20m. Android only.
   */
  simulateDeviation(offsetMeters?: number): Promise<{ok: boolean; error?: string}>

  /**
   * Dev toggle. When enabled, the native NavigationManager shifts every
   * reported location ~8m perpendicular to the route bearing, simulating
   * a pedestrian walking on the wrong sidewalk. Only meaningful in
   * simulate mode; lets us verify the SDK's along-path pivot trigger
   * fires even when the user never crosses the 7m pivot point radius.
   * Android-only today; iOS is a no-op stub.
   */
  setWrongSidewalkOffset(enabled: boolean): Promise<{ok: boolean; error?: string}>

  /**
   * Dev toggle. When enabled, the native NavigationManager takes over
   * from the Google simulator and walks the user along a modified
   * polyline that omits crossing micro-steps — reproducing the
   * wrong-sidewalk-then-missed-the-turn scenario. Android-only today;
   * iOS is a no-op stub.
   */
  setSkipCrossings(enabled: boolean): Promise<{ok: boolean; error?: string}>

  // Heading / compass (Android only)
  startHeading(): Promise<{ok: boolean; error?: string}>
  stopHeading(): Promise<{ok: boolean; error?: string}>

  // MentraJS Runtime — per-miniapp JSContext lifecycle.
  /**
   * Spawn a per-miniapp JS context. Re-spawn is allowed: a live context
   * with the same packageName is killed first. Returns true if the
   * polyfill bundle + miniapp source evaluated without throwing.
   *
   * The polyfill bundle is `mobile/modules/mentrajs-runtime/dist/startup.js`
   * (shipped inside the host binary). It installs window-style globals
   * (console, timers, fetch, localStorage, crypto) atop the JSC runtime.
   */
  mentraJsSpawn(packageName: string, polyfillBundle: string, miniappJs: string): Promise<boolean>
  mentraJsEvaluate(packageName: string, source: string): Promise<unknown>
  mentraJsKill(packageName: string): Promise<void>
  /**
   * Push a `{kind: "event"|"response", …}` envelope into the named
   * context's globalThis.__deliver. Returns when the underlying
   * evaluateScript completes (the JS handler runs synchronously on the
   * context's queue).
   */
  mentraJsDispatchToJs(packageName: string, envelope: Record<string, unknown>): Promise<void>
  mentraJsSetManifest(packageName: string, permissions: string[]): Promise<void>
  /** Diagnostic — returns the packageNames of every live JSContext. */
  mentraJsAlivePackages(): string[]
  /** Diagnostic — force a GC cycle on the named context. */
  mentraJsDebugForceGC(packageName: string): Promise<boolean>
  /**
   * Read the bundled MentraJS polyfill (startup.js) shipped inside the
   * host binary. Synchronous — host RN code calls this once on app boot
   * and caches the string, then passes it to every mentraJsSpawn so
   * every JSContext starts with the same polyfill ABI.
   */
  mentraJsLoadPolyfillBundle(): string
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CrustModule>("Crust")
