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

function scriptURL(): string | undefined {
  // New architecture (bridgeless): SourceCode is a TurboModule and is NOT
  // mirrored onto NativeModules (verified on-device: NativeModules.SourceCode
  // is undefined there). Old architecture: NativeModules carries it. Try both.
  try {
    const tm = TurboModuleRegistry?.get?.("SourceCode") as {getConstants?: () => {scriptURL?: string}} | null
    const fromTurbo = tm?.getConstants?.()?.scriptURL
    if (fromTurbo) return fromTurbo
  } catch {
    /* fall through to the legacy module */
  }
  return (NativeModules as {SourceCode?: {scriptURL?: string}}).SourceCode?.scriptURL
}

/**
 * The dev machine's LAN host (no port), or undefined when no non-loopback
 * candidate is available.
 *
 * Over Wi-Fi the scriptURL carries the laptop's LAN IP, which is what we want:
 * other consumers (the dev-miniapp WebView) may not ride the `adb reverse`
 * tunnel, so a loopback address would be useless to them. Over USB the bundle
 * is served via localhost, but we deliberately do NOT fall back to it here —
 * in order to use the loopback address with adb reverse should set the environment variable instead to force it
 */
export function devServerHost(): string | undefined {
  const candidates = [
    hostOf(scriptURL()),
    hostOf(Constants.expoConfig?.hostUri),
    hostOf((Constants as {expoGoConfig?: {debuggerHost?: string}}).expoGoConfig?.debuggerHost),
  ].filter((h): h is string => !!h)

  return candidates.find((h) => !isLoopback(h))
}
