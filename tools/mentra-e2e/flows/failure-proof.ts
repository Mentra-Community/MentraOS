import type {Step} from "../runner/suite"
import {noGlasses} from "./no-glasses"

// This suite must exit nonzero. It verifies failure evidence and real UI recovery.
export const failureProof: Step[] = [
  noGlasses[0],
  {
    id: "FAILURE-open",
    instruction: "Open Settings before deliberately testing a missing selector.",
    expected: "Account settings is visible.",
    action: {op: "press", selector: {identifier: "home.miniapp.com.mentra.settings"}},
    checks: [{selector: {description: "Account settings"}}],
  },
  {
    id: "FAILURE-missing",
    instruction: "Attempt an intentionally nonexistent named control.",
    expected: "The driver rejects the missing target without guessing another control.",
    action: {op: "press", selector: {identifier: "mentra.e2e.intentionally-missing"}},
    checks: [],
  },
  {
    id: "FAILURE-not-run",
    instruction: "Verify ordinary execution stops after the deliberate failure.",
    expected: "This step remains not-run; recovery is recorded separately.",
    checks: [],
  },
]
