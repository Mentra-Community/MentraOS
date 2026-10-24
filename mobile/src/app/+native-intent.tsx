import {isMiniappInstallLinkPath} from "@/services/miniapps/miniappInstallLinks"

/** Reporting and authoring commands, and miniapp install links, are handled by DeeplinkProvider.
 * Keep Expo Router from separately navigating away from the current screen: a warm app stays where it is
 * (the install sheet opens over it), and a cold app completes its normal boot first.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  if (isMiniappInstallLinkPath(path)) return initial ? "/" : null
  try {
    const url = new URL(path)
    if (
      url.protocol === "com.mentra:" &&
      ["/test/submit-incident-report", "/test/load-miniapp", "/test/permissions", "/test/request-permissions"].includes(`/${url.hostname}${url.pathname}`)
    ) {
      return initial ? "/" : null
    }
  } catch {
    // Other providers may pass a relative path, which Expo Router handles itself.
  }
  return path
}
