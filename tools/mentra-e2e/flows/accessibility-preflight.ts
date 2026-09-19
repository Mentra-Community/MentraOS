import type {Step} from "../runner/suite"

// Run with a miniapp open. This only observes; it never changes navigation.
export const accessibilityPreflight: Step[] = [
  {
    id: "AX-01",
    instruction: "Check that the open miniapp exposes its minimize and close controls.",
    expected:
      "Each capsule control has a unique stable identifier, a readable label, and an enabled accessibility press action.",
    checks: [
      {
        selector: {identifier: "miniapp.minimize", description: "Minimize miniapp", enabled: true},
        action: "AXPress",
        count: 1,
      },
      {
        selector: {identifier: "miniapp.close", description: "Close miniapp", enabled: true},
        action: "AXPress",
        count: 1,
      },
    ],
    timeoutMs: 2000,
  },
]
