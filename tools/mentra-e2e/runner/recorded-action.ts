import {snapshot, type Snapshot} from "./driver"
import type {Report} from "./report"

/** Record a non-UI prerequisite with the same evidence rules as a UI step. */
export async function recordedAction(
  report: Pick<Report, "video" | "record">,
  id: string,
  instruction: string,
  expected: string,
  action: () => Promise<void>,
  readSnapshot = snapshot,
  runWhenEvidenceUnavailable = false,
) {
  const started = performance.now()
  let before: Snapshot | undefined
  let after: Snapshot | undefined
  let videoStart: number | undefined
  let error: string | undefined
  try {
    before = await readSnapshot()
    videoStart = await report.video?.mark()
  } catch (caught) {
    error = String(caught)
  }
  // Cleanup must still execute when the app or recorder is unavailable. Retain
  // the evidence error so successful resource cleanup cannot make this a pass.
  if (!error || runWhenEvidenceUnavailable) {
    try {
      await action()
    } catch (caught) {
      error = [error, String(caught)].filter(Boolean).join("; ")
    }
  }
  try {
    after = await readSnapshot()
  } catch (caught) {
    error = [error, String(caught)].filter(Boolean).join("; ")
    after = before
  }
  const result = await report.record(
    {
      id,
      instruction,
      expected,
      status: error ? "failed" : "passed",
      error,
      durationMs: Math.round(performance.now() - started),
      videoStart,
      videoEnd: await report.video?.mark().catch(() => undefined),
      focusBefore: before?.frontmostBundleId,
      focusAfter: after?.frontmostBundleId,
    },
    after,
  )
  // A successful command cannot override a failed screenshot or recorder check.
  if (result.status !== "passed") throw new Error(result.error ?? `${id} evidence failed`)
}
