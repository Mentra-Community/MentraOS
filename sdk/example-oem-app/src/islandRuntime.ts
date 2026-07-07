/**
 * The OEM host's island bootstrap — the complete front-door contract an OEM
 * app implements: hand island the auth/config/analytics/UI seams via
 * `toolkit.configure`, then `toolkit.start()` (which resolves only after the
 * device-identity stores hydrate, so the facade reads below are trustworthy).
 *
 * This module doubles as the compile-time contract test for the public
 * `@mentra/island` entry: the "OEM Host Boundary Gate" CI workflow typechecks
 * this app against island's BUILT types, with no `/internal` access.
 */
import {toolkit, type IslandConfigureOptions} from "@mentra/island"

export type IslandLogger = (line: string) => void

/** Configure + start the island runtime; returns an unsubscribe for the demo listeners. */
export async function startIslandRuntime(log: IslandLogger): Promise<() => void> {
  const options: IslandConfigureOptions = {
    auth: {
      // A real OEM host returns its logged-in user's backend token here.
      getSubjectToken: async () => ({token: "example-subject-token", type: "supabase"}),
      onStateChange: (callback) => {
        void callback // a real host forwards its auth-session events
      },
    },
    config: {audioFrameSizeBytes: 20},
    analytics: (event, props) => log(`analytics: ${event}${props ? ` ${JSON.stringify(props)}` : ""}`),
    ui: {
      // Island dispatches miniapp wifi-setup requests here; the OEM owns the screen.
      requestWifiSetup: (reason) => log(`wifi setup requested (${reason ?? "no reason"})`),
    },
  }
  toolkit.configure(options)
  await toolkit.start()
  log("island runtime started (device identity hydrated)")

  // Representative read-model subscriptions an OEM home screen renders from.
  // Island decides; this host only renders.
  const unsubs = [
    toolkit.glasses.onStatus((status) => log(`glasses: ${status.state}${status.fullyBooted ? " (booted)" : ""}`)),
    toolkit.pairing.onReadiness((readiness) => log(`pairing readiness: ${JSON.stringify(readiness)}`)),
    toolkit.notifications.onNotification((notification) =>
      log(`island notification: ${notification.kind} — ${notification.reason}`),
    ),
    toolkit.gallery.onNotice((notice) => log(`gallery notice: ${notice.code}`)),
    toolkit.ota.installSession.onSnapshot((snapshot) => log(`ota install: ${snapshot.displayState}`)),
  ]

  const hasDefault = await toolkit.glasses.hasDefaultDevice()
  log(`paired device on record: ${hasDefault ? "yes" : "no"}`)
  log(`ota update available: ${toolkit.ota.updateAvailable()?.versionName ?? "none"}`)

  return () => unsubs.forEach((unsub) => unsub())
}
