/** Reporting is handled by DeeplinkProvider in a modal above the existing UI.
 * Keep Expo Router from separately navigating away from the failed screen.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  try {
    const url = new URL(path)
    if (url.protocol === "com.mentra:" && `/${url.hostname}${url.pathname}` === "/test/submit-incident-report") {
      return initial ? "/" : null
    }
  } catch {
    // Other providers may pass a relative path, which Expo Router handles itself.
  }
  return path
}
