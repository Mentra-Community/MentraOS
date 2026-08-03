/**
 * The OEM host's engine bootstrap — the complete front-door contract an OEM
 * app implements: hand engine the auth/config/analytics/UI seams via
 * `engine.configure`, then `engine.start()` (which resolves only after the
 * device-identity stores hydrate, so the facade reads below are trustworthy).
 *
 * This module doubles as the compile-time contract test for the public
 * `@mentra/engine` entry: the "OEM Host Boundary Gate" CI workflow typechecks
 * this app against engine's BUILT types, with no `/internal` access.
 */
import {engine, type IslandConfigureOptions} from "@mentra/engine"

export type EngineLogger = (line: string) => void

/** Configure + start the engine runtime; returns an unsubscribe for the demo listeners. */
export async function startEngineRuntime(log: EngineLogger): Promise<() => void> {
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
      // Engine dispatches miniapp wifi-setup requests here; the OEM owns the screen.
      requestWifiSetup: (reason) => log(`wifi setup requested (${reason ?? "no reason"})`),
    },
  }
  engine.configure(options)
  await engine.start()
  log("engine runtime started (device identity hydrated)")

  // Representative read-model subscriptions an OEM home screen renders from.
  // Engine decides; this host only renders.
  const unsubs = [
    engine.glasses.onStatus((status) => log(`glasses: ${status.state}${status.fullyBooted ? " (booted)" : ""}`)),
    engine.pairing.onReadiness((readiness) => log(`pairing readiness: ${JSON.stringify(readiness)}`)),
    engine.notifications.onNotification((notification) =>
      log(`engine notification: ${notification.kind} — ${notification.reason}`),
    ),
    engine.gallery.onNotice((notice) => log(`gallery notice: ${notice.code}`)),
    engine.ota.installSession.onSnapshot((snapshot) => log(`ota install: ${snapshot.displayState}`)),
  ]

  // From here on we own live subscriptions and a started runtime — if a later
  // bootstrap read fails, release the listeners AND stop the engine before
  // surfacing the error, so "start failed" is actually true and nothing keeps
  // running behind a failed bootstrap.
  try {
    const hasDefault = await engine.glasses.hasDefaultDevice()
    log(`paired device on record: ${hasDefault ? "yes" : "no"}`)
    log(`ota update available: ${engine.ota.updateAvailable()?.versionName ?? "none"}`)
  } catch (error) {
    unsubs.forEach((unsub) => unsub())
    await engine.stop().catch(() => {})
    throw error
  }

  return () => unsubs.forEach((unsub) => unsub())
}
