/** The Mentra App's Universal Link and App Link hosts. */
const LINK_HOSTS = ["apps.mentra.glass", "apps.mentraglass.com"]

/** Reset links are handled by DeeplinkProvider, which never takes a session from them: a signed-in person stays on
 * their screen, and a signed-out one goes to the emailed-code reset. */
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

/** Reporting and authoring commands are handled by DeeplinkProvider.
 * Keep Expo Router from separately navigating away from the failed screen.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  if (isResetPasswordLink(path)) return initial ? "/" : null
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
