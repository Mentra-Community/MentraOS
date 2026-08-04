export interface NavigationBuildEnvironment {
  NODE_ENV?: string
  PUBLIC_MAPBOX_TOKEN?: string
  EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN?: string
}

/**
 * Resolve the public Mapbox token used by the bundled navigation UI.
 *
 * Standalone miniapp development uses PUBLIC_MAPBOX_TOKEN, while Mentra App
 * builds already expose the same public token as
 * EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN. Released miniapps run from file:// and
 * cannot fall back to the dev server's /api/config endpoint, so production
 * builds must fail instead of silently packaging a permanently blank map.
 */
export function resolveMapboxBuildToken(env: NavigationBuildEnvironment): string {
  const standaloneToken = env.PUBLIC_MAPBOX_TOKEN?.trim()
  const mobileToken = env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim()
  const token = standaloneToken || mobileToken || ""

  if (env.NODE_ENV === "production" && !token.startsWith("pk.")) {
    throw new Error(
      "A valid public Mapbox token is required for production navigation builds. " +
        "Set PUBLIC_MAPBOX_TOKEN or EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN.",
    )
  }

  return token
}
