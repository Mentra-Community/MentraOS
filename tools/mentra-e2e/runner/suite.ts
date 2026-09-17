import {command, snapshot, visible, type Command, type Frame, type Selector, type Snapshot} from "./driver"
import {Report} from "./report"

export interface Check {
  selector: Selector
  action?: string
  absent?: boolean
  count?: number
}
export interface Context {
  email: string
  password: string
  fixture: string
}
export interface Step {
  id: string
  instruction: string
  expected: string
  action?: Command | ((context: Context, state: Snapshot) => Command)
  checks: Check[] | ((context: Context) => Check[])
  timeoutMs?: number
  stableForMs?: number
  failOn?: {selector: Selector; message: string}[]
}

export async function waitFor(
  checks: Check[],
  timeoutMs = 10000,
  stableForMs = 0,
  readSnapshot = snapshot,
  failOn: Step["failOn"] = [],
): Promise<Snapshot> {
  if (!Number.isFinite(stableForMs) || stableForMs < 0 || stableForMs >= timeoutMs)
    throw new Error("stableForMs must be nonnegative and shorter than the assertion timeout")
  let matchedSince: number | undefined
  const deadline = performance.now() + timeoutMs
  let last: Snapshot | undefined
  let unmet = ""
  while (performance.now() < deadline) {
    last = await readSnapshot()
    const terminalFailure = failOn.find((failure) => visible(last!, failure.selector).length > 0)
    if (terminalFailure) throw new Error(terminalFailure.message)
    const failure = checks.find((check) => {
      const count = visible(last!, check.selector).filter(
        (element) => !check.action || element.actions.includes(check.action),
      ).length
      const ok = check.absent ? count === 0 : check.count !== undefined ? count === check.count : count > 0
      if (!ok)
        unmet = `Expected ${check.absent ? "no" : check.count ?? "at least one"} match for ${JSON.stringify(
          check.selector,
        )}${check.action ? ` exposing ${check.action}` : ""}, found ${count}`
      return !ok
    })
    if (failure) matchedSince = undefined
    else {
      matchedSince ??= performance.now()
      if (performance.now() - matchedSince >= stableForMs) return last
      unmet = `Expected checks to remain satisfied for ${stableForMs} ms`
    }
    await Bun.sleep(150)
  }
  throw new Error(`${unmet || "No snapshot available"} within ${timeoutMs} ms`)
}

export async function executeSteps(steps: Step[], context: Context, report: Report) {
  const checkSize = (state: Snapshot) => {
    if (state.frontmostBundleId === "com.apple.loginwindow")
      throw new Error("The macOS session is locked; unlock it before starting another replay")
    const initial = report.metadata.window as Frame | undefined
    if (!initial) report.metadata.window = state.window
    else if (Math.abs(initial.width - state.window.width) >= 2 || Math.abs(initial.height - state.window.height) >= 2)
      throw new Error("Window size changed during recording; keep its size fixed or start a new run")
  }
  let failed = false
  for (const step of steps) {
    if (failed) {
      await report.record({
        id: step.id,
        instruction: step.instruction,
        expected: step.expected,
        status: "not-run",
        durationMs: 0,
      })
      continue
    }
    const start = performance.now()
    let state: Snapshot | undefined
    let videoStart: number | undefined
    let focusBefore: string | undefined
    try {
      videoStart = await report.video?.mark()
      state = await snapshot()
      checkSize(state)
      focusBefore = state.frontmostBundleId
      const action = typeof step.action === "function" ? step.action(context, state) : step.action
      if (action?.op === "relaunch") await report.video?.park()
      if (action) await command(action)
      if (action?.op === "relaunch") await report.video?.reattach()
      state = await waitFor(
        typeof step.checks === "function" ? step.checks(context) : step.checks,
        step.timeoutMs,
        step.stableForMs,
        snapshot,
        step.failOn,
      )
      checkSize(state)
      const videoEnd = await report.video?.mark()
      const result = await report.record(
        {
          id: step.id,
          instruction: step.instruction,
          expected: step.expected,
          status: "passed",
          durationMs: Math.round(performance.now() - start),
          videoStart,
          videoEnd,
          focusBefore,
          focusAfter: state.frontmostBundleId,
        },
        state,
      )
      failed = result.status === "failed"
    } catch (error) {
      state = await snapshot().catch(() => state)
      await report.record(
        {
          id: step.id,
          instruction: step.instruction,
          expected: step.expected,
          status: "failed",
          durationMs: Math.round(performance.now() - start),
          error: String(error),
          focusBefore,
          focusAfter: state?.frontmostBundleId,
          videoStart,
          videoEnd: await report.video?.mark().catch(() => undefined),
        },
        state,
      )
      failed = true
    }
  }
  return !failed
}
