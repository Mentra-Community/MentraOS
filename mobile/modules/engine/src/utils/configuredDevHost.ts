import {getConfigValues} from "../runtime/bootstrap"

/**
 * Explicit Metro / laptop host override used by stale-URL rewrite and launch
 * failover. One source of truth so AppRegistry and decideDevLaunchRoute stay aligned.
 */
export function configuredDevHost(): string | undefined {
  const explicit = process.env.EXPO_PUBLIC_LOCAL_MINIAPP_HOST
  if (explicit) {
    try {
      return new URL(explicit).hostname
    } catch {
      if (/^[\w.-]+$/.test(explicit)) return explicit
    }
  }
  return getConfigValues().devServerHost?.()
}
