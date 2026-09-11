/**
 * The wait a new SoftAP call does on the previous one's cleanup.
 *
 * Starting a call, stopping it before it finishes, and starting it again used to report "Cannot
 * start glasses hotspot" and then fail the scoped join with the SSID missing from the scan. Both
 * symptoms are the same cause: the second attempt raised a hotspot while the first attempt's
 * `setHotspotState(false)` was still in flight, so the teardown of call N landed on call N+1.
 *
 * The rule this encodes is that the barrier is the *only* thing that decides when the next call
 * may proceed, and it opens on evidence rather than on a clock. A timeout that says "long enough,
 * probably safe" reintroduces exactly the race it was added to prevent, so there is deliberately
 * no deadline here: a cleanup that never finishes holds the next call back forever, visibly,
 * which is a bug someone can see and fix. The only thing time is used for is deciding whether the
 * wait is worth mentioning — the common restart clears in a microtask, and a status line that
 * flashed on every Start would teach the wearer to ignore the one time it mattered.
 */
export interface CleanupBarrierOptions {
  /** Opens when the previous attempt's teardown *and* its in-flight join body have both finished. */
  settled: Promise<void>
  /** Already open: the caller can skip the wait, and the narration, entirely. */
  settledDone: boolean
  /** Told to the wearer only if the wait outlasts {@link narrateAfterMs}. */
  narrate: (detail: string) => void
  narrateAfterMs: number
  /** Injectable for tests; a real timer everywhere else. */
  delay?: (ms: number) => Promise<void>
}

export const CLEANUP_BARRIER_COPY = "Still cleaning up the last call…"

/**
 * Resolves once the previous attempt has genuinely finished, narrating if the wait is noticeable.
 *
 * Returns whether the wearer was told, so a caller can assert on it and a log can record that the
 * restart was held rather than instant.
 */
export async function awaitCleanupBarrier(options: CleanupBarrierOptions): Promise<{narrated: boolean}> {
  if (options.settledDone) return {narrated: false}
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const promptly = await Promise.race([
    options.settled.then(() => true),
    delay(options.narrateAfterMs).then(() => false),
  ])
  if (promptly) return {narrated: false}
  options.narrate(CLEANUP_BARRIER_COPY)
  // The race decided what to say. It does not decide whether to proceed: that is this line, and
  // it has no escape.
  await options.settled
  return {narrated: true}
}
