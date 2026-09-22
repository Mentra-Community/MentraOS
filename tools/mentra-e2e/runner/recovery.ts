import {snapshot, visible, type Snapshot} from "./driver"
import {executeSteps, type Context, type Step} from "./suite"
import {Report} from "./report"
import {noGlasses} from "../flows/no-glasses"

// Recovery has its own evidence and never changes the original failure result.
// It uses normal lifecycle/navigation only; app storage and pairings are retained.
export async function recoverUnpaired(context: Context, report: Report): Promise<boolean> {
  const recoveryStep = (step: Step): Step => ({...step, id: `RECOVERY-${step.id}`})
  const relaunch: Step = {
    id: "RECOVERY-relaunch",
    instruction: "Relaunch normally to dismiss transient test UI after a failure.",
    expected: "The same app process restarts without forced termination or cleared storage.",
    action: {op: "relaunch"},
    checks: [],
  }
  if (!(await executeSteps([relaunch], context, report))) return false
  let state: Snapshot | undefined
  const deadline = performance.now() + 30000
  let screen = "unknown"
  while (performance.now() < deadline) {
    state = await snapshot()
    if (visible(state, {role: "AXButton", description: "Pair glasses"}).length) screen = "home"
    else if (visible(state, {description: "The future of smart glasses starts here"}).length) screen = "start"
    else if (visible(state, {description: "Welcome to MentraOS"}).length) screen = "onboarding"
    if (screen !== "unknown") break
    await Bun.sleep(150)
  }
  if (screen === "unknown") {
    await report.record(
      {
        id: "RECOVERY-state",
        instruction: "Recognize the restarted app state.",
        expected: "Home, authentication start, or onboarding is visible.",
        status: "failed",
        durationMs: 30000,
        error: "Unrecognized state; no guessed UI action performed",
      },
      state,
    )
    return false
  }
  const loginStart = noGlasses.findIndex((step) => step.id === "AUTH-07-reopen")
  const onboardingStart = noGlasses.findIndex((step) => step.id === "SETUP-01")
  const identityStart = noGlasses.findIndex((step) => step.id === "AUTH-10-settings")
  const start = screen === "start" ? loginStart : screen === "onboarding" ? onboardingStart : identityStart
  return executeSteps(noGlasses.slice(start).map(recoveryStep), context, report)
}
