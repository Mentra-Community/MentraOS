import {isMiniappInstallLinkPath} from "@/services/miniapps/miniappInstallLinks"

/** The Mentra App's Universal Link and App Link hosts. */
const LINK_HOSTS = ["apps.mentra.glass", "apps.mentraglass.com"]

/** Reset links are handled by DeeplinkProvider, which never takes a session from them: a signed-in person stays on
 * their screen, and a signed-out one goes to the emailed-code reset. The reset screen itself is code-only. */
function isResetPasswordLink(path: string): boolean {
  let route: string
  if (path.startsWith("/")) {
    route = path.split(/[?#]/)[0]
  } else {
    try {
      const url = new URL(path)
      if (url.protocol === "com.mentra:") route = `/${url.hostname}${url.pathname}`
      else if (url.protocol === "https:" && LINK_HOSTS.includes(url.hostname.replace(/\.$/, ""))) route = url.pathname
      else return false
    } catch {
      return false
    }
  }
  return route.replace(/\/+$/, "") === "/auth/reset-password"
}

/** Reporting and authoring commands, and miniapp install links, are handled by DeeplinkProvider.
 * Keep Expo Router from separately navigating away from the current screen: a warm app stays where it is
 * (the install sheet opens over it), and a cold app completes its normal boot first.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  if (isResetPasswordLink(path)) return initial ? "/" : null
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
