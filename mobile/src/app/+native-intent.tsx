/** Reporting and authoring commands are handled by DeeplinkProvider.
 * Keep Expo Router from separately navigating away from the failed screen.
 */
export function redirectSystemPath({path, initial}: {path: string; initial: boolean}): string | null {
  try {
    const url = new URL(path)
    if (
      url.protocol === "com.mentra:" &&
      ["/test/submit-incident-report", "/test/load-miniapp"].includes(`/${url.hostname}${url.pathname}`)
    ) {
      return initial ? "/" : null
    }
  } catch {
    // Other providers may pass a relative path, which Expo Router handles itself.
  }
  return path
}
