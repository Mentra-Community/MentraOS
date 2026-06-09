/**
 * @fileoverview The one source of truth for "where is the dev laptop?".
 *
 * In a Metro-served dev build the phone already knows the dev machine's
 * address — it fetched this very bundle from it. That address is, by
 * construction, reachable on the CURRENT network: it cannot go stale the way a
 * hardcoded IP (in .env or a persisted setting) does, because if it were wrong
 * the bundle would not have loaded.
 *
 * Sources, most to least authoritative (none is reliably populated across
 * every dev-client/Expo version, so we try all three):
 *   1. `SourceCode.scriptURL` — the literal URL this bundle was fetched from.
 *   2. `Constants.expoConfig.hostUri` — Metro's host as recorded in the
 *      manifest.
 *   3. `Constants.expoGoConfig.debuggerHost` — the legacy manifest field.
 * A localhost answer (USB + `adb reverse`) is kept only if no LAN candidate
 * exists, since other devices/services cannot dial the phone's own localhost.
 *
 * Everything that needs the dev machine (the Cloud V2 local endpoints, the
 * local-miniapp dev-server URL rewrite) derives it from here instead of
 * carrying its own copy of someone's LAN IP. Personal IPs must never be
 * committed in .env or code — they strand the next dev (or the same dev on a
 * different network) on yesterday's address.
 */
import Constants from "expo-constants"
import {NativeModules, TurboModuleRegistry} from "react-native"

/**
 * Sentinel stored in the cloud endpoint settings to mean "my dev laptop,
 * resolved live from Metro". Persisting the sentinel (not the resolved URL)
 * is what makes the setting survive network changes: the laptop's IP can
 * change daily, but "the machine serving this bundle" is always current.
 */
export const METRO_AUTO = "metro-auto"

function hostOf(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  try {
    // scriptURL is a full URL; hostUri/debuggerHost are bare host:port. URL()
    // needs a scheme, so give the bare forms one.
    const url = new URL(value.includes("://") ? value : `http://${value}`)
    return url.hostname || undefined
  } catch {
    return undefined
  }
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2"
}

function devServerUrl(): string | undefined {
  // The canonical answer: RN's debug runtime records exactly where it loaded
  // the bundle from (including a user-set debug_http_host). Internal module,
  // but stable across RN versions and what devtools (Reactotron etc.) use.
  try {
    const mod = require("react-native/Libraries/Core/Devtools/getDevServer") as
      | {default?: () => {url?: string; bundleLoadedFromServer?: boolean}}
      | (() => {url?: string; bundleLoadedFromServer?: boolean})
    const getDevServer = typeof mod === "function" ? mod : mod.default
    const info = getDevServer?.()
    if (info?.bundleLoadedFromServer && info.url) return info.url
  } catch {
    /* fall through */
  }
  return undefined
}

function scriptURL(): string | undefined {
  // New architecture (bridgeless): SourceCode is a TurboModule and is NOT
  // mirrored onto NativeModules (verified on-device: NativeModules.SourceCode
  // is undefined there). Some builds lack the module entirely (the lookup
  // throws an invariant) — hence the guards. Old architecture: NativeModules.
  try {
    const tm = TurboModuleRegistry?.get?.("SourceCode") as {getConstants?: () => {scriptURL?: string}} | null
    const fromTurbo = tm?.getConstants?.()?.scriptURL
    if (fromTurbo) return fromTurbo
  } catch {
    /* fall through to the legacy module */
  }
  try {
    return (NativeModules as {SourceCode?: {scriptURL?: string}}).SourceCode?.scriptURL
  } catch {
    return undefined
  }
}

/**
 * The dev machine's host (no port), or undefined outside Metro-served builds.
 *
 * A loopback answer is real, not a failure: over USB + `adb reverse` the
 * bundle is served via localhost, and the local cloud is reachable the same
 * way (reverse tcp:3000/3001). Over Wi-Fi the scriptURL carries the laptop's
 * LAN IP. We prefer a LAN candidate when one exists because other consumers
 * (the dev-miniapp WebView) may not ride the reverse tunnel.
 */
export function devServerHost(): string | undefined {
  const candidates = [
    hostOf(devServerUrl()),
    hostOf(scriptURL()),
    hostOf(Constants.expoConfig?.hostUri),
    hostOf((Constants as {expoGoConfig?: {debuggerHost?: string}}).expoGoConfig?.debuggerHost),
  ].filter((h): h is string => !!h)

  return candidates.find((h) => !isLoopback(h)) ?? candidates[0]
}
