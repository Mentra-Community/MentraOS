import type {Step} from "../runner/suite"
import {backButton} from "./login"

export const onboarding: Step[] = [
  {
    id: "SETUP-01",
    instruction: "Verify that first sign-in reached onboarding.",
    expected: "Welcome to MentraOS and the setup choices are visible.",
    checks: [
      {selector: {description: "Welcome to MentraOS"}},
      {selector: {role: "AXButton", description: "Set up\nwith glasses"}},
    ],
  },
  {
    id: "SETUP-02",
    instruction: "Open the glasses setup choices without selecting or connecting a device.",
    expected: "The glasses model selector is visible.",
    action: {op: "press", selector: {role: "AXButton", description: "Set up\nwith glasses"}},
    checks: [{selector: {contains: "Select"}}, {selector: {contains: "Mentra Live"}}],
  },
  {
    id: "SETUP-03",
    instruction: "Return without choosing a glasses model.",
    expected: "The onboarding welcome screen returns.",
    action: {op: "press", selector: backButton},
    checks: [{selector: {description: "Welcome to MentraOS"}}],
  },
  {
    id: "SETUP-04",
    instruction: "Relaunch after leaving onboarding without a selected device.",
    expected: "The authenticated home exposes Settings and Pair glasses.",
    action: {op: "relaunch"},
    checks: [{selector: {contains: "Settings"}}, {selector: {contains: "Pair glasses"}}],
    timeoutMs: 30000,
  },
]
