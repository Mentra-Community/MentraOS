import type {Step} from "../runner/suite"

// Experimental unpaired fixture probe. It deliberately restarts the app and
// qualifies recorder reattachment independently of the longer smoke routine.
export const lifecycleProof: Step[] = [
  {
    id: "LIFEPROOF-01",
    instruction: "Record the authenticated app before restarting it.",
    expected: "The unpaired fixture has a Pair glasses entry in its home hierarchy.",
    checks: [{selector: {description: "Pair glasses"}}],
  },
  {
    id: "LIFEPROOF-02",
    instruction: "Quit normally and reopen the exact same app binary without requesting desktop focus.",
    expected: "The session restores to unpaired home and video attaches to the new window.",
    action: {op: "relaunch"},
    checks: [
      {selector: {description: "Pair glasses"}},
      {selector: {description: "Do you have smart glasses?"}},
      {selector: {description: "What did you expect to happen?"}, absent: true},
      {selector: {placeholder: "Password"}, absent: true},
    ],
    timeoutMs: 30000,
  },
]
