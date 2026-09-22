import {expect, test} from "bun:test"
import type {Element, Snapshot} from "./driver"
import {
  runOtaCustomerSequence,
  type OtaCustomerActions,
  type OtaCustomerProgress,
  type OtaCustomerSelection,
} from "./ota-customer-sequence"

function screen(kind: string): Snapshot {
  const rows: Partial<Element>[] = {
    home: [{identifier: "home.miniapp.com.mentra.settings"}],
    offered: [{description: "Mentra Live Update Available"}, {description: "Install"}],
    available: [{identifier: "button-Update Now"}],
    working: [{description: "Installing update on glasses..."}],
    complete: [{description: "Update Complete"}, {description: "Your glasses are running the latest version."}],
    current: [{description: "Up to Date"}, {description: "Your glasses are running the latest version."}],
    pass: [{description: "Update complete!"}, {description: "Your glasses are up to date."}, {description: "Done"}],
    failed: [{description: "Update Failed"}],
    unknown: [{description: "Unrecognized transition"}],
  }[kind]!
  return {
    pid: 10,
    frontmostBundleId: "test",
    window: {x: 0, y: 0, width: 400, height: 600},
    elements: rows.map((row, index) => ({
      path: String(index),
      role: "AXButton",
      subrole: "",
      title: "",
      description: "",
      placeholder: "",
      identifier: "",
      value: "",
      enabled: true,
      focused: false,
      visible: true,
      actions: ["AXPress"],
      ...row,
    })),
  }
}

function harness() {
  let page = "offered"
  let now = 0
  let observedBes = "17.26.1.13"
  const calls: string[] = []
  const progress: OtaCustomerProgress = {started: false, installPasses: 0, finished: false}
  const metadata: Record<string, unknown> = {}
  const selection: OtaCustomerSelection = {
    install: true,
    resume: false,
    minutes: 2,
    before: {bootId: "original", slot: "_a"},
    target: {asgVersion: 291, firmware: "MentraLive_20260921.0", bes: "26.9.21.3"},
  }
  const identity = {
    transport: "10",
    serial: "test-fixture",
    cid: "a".repeat(32),
    bluetooth: "AA:BB:CC:DD:EE:FF",
    firmware: "MentraLive_20260113.0",
    bootId: "original",
    slot: "_a",
    bootCompleted: "1",
    asgVersion: 27,
    shell: async () => {
      throw new Error("No device commands are allowed in this test")
    },
  }
  const hooks = {
    update: () => {
      page = "complete"
    },
    finishPass: () => {
      page = "available"
    },
    sleep: (_ms: number) => {},
  }
  const actions: OtaCustomerActions = {
    snapshot: async () => screen(page),
    hardware: async (active) => {
      calls.push(`hardware:${active ?? false}`)
      return identity
    },
    readBesVersion: async () => {
      calls.push("fresh-bes")
      return observedBes
    },
    observe: async (instruction) => {
      calls.push(`observe:${instruction}`)
    },
    executeStep: async (step) => {
      const action = step.action
      if (!action || typeof action === "function") throw new Error("Unexpected test action")
      calls.push(`step:${action.op}:${action.selector?.description ?? ""}`)
      if (action.op === "relaunch") page = "offered"
      else if (action.selector?.description === "Later") page = "home"
      else if (action.selector?.description === "Install") page = "available"
      else throw new Error("Unexpected test navigation")
      return true
    },
    press: async (identifier) => {
      calls.push(`press:${identifier}`)
      if (identifier === "button-Update Now") hooks.update()
      else if (page === "pass") hooks.finishPass()
      else page = "home"
    },
    verifyAppPair: async () => {
      calls.push("pair")
    },
    verifyTarget: async () => {
      calls.push("target")
    },
    verifyPublishedManifests: async () => {
      calls.push("manifest")
    },
    observeHardware: async (active) => {
      calls.push(`poll:${active}`)
    },
  }
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
      hooks.sleep(ms)
    },
  }
  return {
    selection,
    progress,
    metadata,
    actions,
    calls,
    identity,
    hooks,
    page: (value: string) => {
      page = value
    },
    bes: (value: string) => {
      observedBes = value
    },
    run: () => runOtaCustomerSequence(selection, progress, metadata, actions, clock),
  }
}

test("already-current requires the fresh BES match and independent target proof without installation", async () => {
  const h = harness()
  h.page("home")
  Object.assign(h.identity, {asgVersion: h.selection.target.asgVersion, firmware: h.selection.target.firmware})
  h.bes(h.selection.target.bes)
  await h.run()
  expect(h.progress).toEqual({started: false, installPasses: 0, finished: true})
  expect(h.metadata.otaOutcome).toBe("already-current")
  expect(h.calls.filter((call) => /^(step|press):/.test(call))).toEqual([])
  expect(h.calls.filter((call) => ["fresh-bes", "pair", "target"].includes(call))).toEqual([
    "fresh-bes",
    "pair",
    "target",
  ])
})

test("a BES-only change still runs the normal flow and checks the pinned manifest before Update Now", async () => {
  const h = harness()
  Object.assign(h.identity, {asgVersion: h.selection.target.asgVersion, firmware: h.selection.target.firmware})
  await h.run()
  expect(h.progress).toEqual({started: true, installPasses: 1, finished: true})
  expect(h.metadata).toEqual({installPasses: 1, otaOutcome: "updated"})
  expect(h.calls.filter((call) => /^(step|press):/.test(call))).toEqual([
    "step:press:Later",
    "step:relaunch:",
    "step:press:Install",
    "press:button-Update Now",
    "press:button-Done",
  ])
  const update = h.calls.indexOf("press:button-Update Now")
  expect(h.calls.slice(update - 2, update)).toEqual(["manifest", "hardware:false"])
  expect(h.calls.indexOf("target")).toBeLessThan(h.calls.indexOf("press:button-Done"))
  expect(h.calls.filter((call) => call === "pair")).toHaveLength(2)
})

test("pass completion can continue the owned chain but never qualifies the final target", async () => {
  const h = harness()
  h.hooks.update = () => h.page(h.progress.installPasses === 1 ? "pass" : "complete")
  await h.run()
  expect(h.progress.installPasses).toBe(2)
  expect(h.calls.filter((call) => call === "target")).toHaveLength(1)
  expect(h.calls.filter((call) => call === "manifest")).toHaveLength(2)
  expect(h.calls.filter((call) => call === "press:button-Done")).toHaveLength(2)
})

test("a failed installation press preserves attempted progress and is never resent", async () => {
  const h = harness()
  h.hooks.update = () => {
    throw new Error("simulated ambiguous press failure")
  }
  await expect(h.run()).rejects.toThrow("ambiguous press failure")
  expect(h.progress).toEqual({started: true, installPasses: 1, finished: false})
  expect(h.calls.filter((call) => call === "press:button-Update Now")).toHaveLength(1)
  expect(h.calls).not.toContain("target")
  expect(h.metadata.otaOutcome).toBeUndefined()
})

test("changed manifest or initial boot stops before an installation action", async () => {
  const h = harness()
  h.actions.verifyPublishedManifests = async () => {
    throw new Error("manifest changed")
  }
  await expect(h.run()).rejects.toThrow("manifest changed")
  expect(h.calls).not.toContain("press:button-Update Now")
  expect(h.progress.started).toBe(false)
  const other = harness()
  other.identity.bootId = "unexpected"
  await expect(other.run()).rejects.toThrow("Initial boot or slot differs")
  expect(other.calls.filter((call) => /^(step|press):/.test(call))).toEqual([])
})

test("resume only observes an existing update and refuses a newly offered pass", async () => {
  const h = harness()
  h.selection.resume = true
  h.page("working")
  h.hooks.sleep = () => h.page("complete")
  await h.run()
  expect(h.metadata.otaOutcome).toBe("resumed-and-verified")
  expect(h.progress).toEqual({started: false, installPasses: 0, finished: true})
  expect(h.calls[0]).toBe("hardware:true")
  expect(h.calls).not.toContain("press:button-Update Now")
  expect(h.calls.some((call) => call.startsWith("step:"))).toBe(false)
  const next = harness()
  next.selection.resume = true
  next.page("available")
  await expect(next.run()).rejects.toThrow("--install is required")
  expect(next.calls).not.toContain("press:button-Update Now")
})

test("the owned chain stops at eight passes without dispatching a ninth", async () => {
  const h = harness()
  h.hooks.update = () => h.page("pass")
  await expect(h.run()).rejects.toThrow("exceeded eight installation passes")
  expect(h.progress).toEqual({started: true, installPasses: 8, finished: false})
  expect(h.calls.filter((call) => call === "press:button-Update Now")).toHaveLength(8)
  expect(h.calls.filter((call) => call === "manifest")).toHaveLength(8)
})

test("failure screens and target-proof failure never become completion", async () => {
  const h = harness()
  h.hooks.update = () => h.page("failed")
  await expect(h.run()).rejects.toThrow("OTA stopped on Update Failed")
  expect(h.progress.finished).toBe(false)
  expect(h.calls).not.toContain("target")
  const other = harness()
  other.actions.verifyTarget = async () => {
    throw new Error("wrong active APK")
  }
  await expect(other.run()).rejects.toThrow("wrong active APK")
  expect(other.progress.finished).toBe(false)
  expect(other.calls).not.toContain("press:button-Done")
})

test("a deadline preserves the active attempt; hardware observation errors propagate without resend", async () => {
  const h = harness()
  h.selection.minutes = 1
  h.hooks.update = () => h.page("working")
  await expect(h.run()).rejects.toThrow("observation deadline reached")
  expect(h.calls).toContain("poll:true")
  expect(h.progress).toEqual({started: true, installPasses: 1, finished: false})
  expect(h.calls.filter((call) => call === "press:button-Update Now")).toHaveLength(1)
  const other = harness()
  other.hooks.update = () => other.page("working")
  other.actions.observeHardware = async () => {
    throw new Error("wrong physical identity")
  }
  await expect(other.run()).rejects.toThrow("wrong physical identity")
  expect(other.calls.filter((call) => call === "press:button-Update Now")).toHaveLength(1)
})

test("an unrecognized screen has the same 60-second bound and never triggers an extra action", async () => {
  const h = harness()
  h.hooks.update = () => h.page("unknown")
  await expect(h.run()).rejects.toThrow("Unrecognized OTA screen persisted for 60 seconds")
  expect(h.progress.finished).toBe(false)
  expect(h.calls.filter((call) => call === "press:button-Update Now")).toHaveLength(1)
})
