import {expect, test} from "bun:test"
import {type Element, type Snapshot} from "./driver"
import {waitFor} from "./suite"

const checks = [{selector: {identifier: "call.leave"}}]
const state = (active: boolean): Snapshot => ({
  pid: 1,
  frontmostBundleId: "fixture",
  window: {x: 0, y: 0, width: 100, height: 100},
  elements: active ? [{identifier: "call.leave", visible: true} as Element] : [],
})

test("a transient active control followed by failure cannot pass a sustained check", async () => {
  let reads = 0
  await expect(waitFor(checks, 500, 200, async () => state(reads++ === 0))).rejects.toThrow()
  expect(reads).toBeGreaterThan(1)
})

test("an interrupted active state must satisfy a fresh full observation period", async () => {
  let reads = 0
  const result = await waitFor(checks, 1200, 200, async () => state(reads++ !== 1))
  expect(result.elements).toHaveLength(1)
  expect(reads).toBeGreaterThanOrEqual(5)
})

test("ordinary navigation retains immediate checks and rejects impossible observation windows", async () => {
  let reads = 0
  await waitFor(checks, 100, 0, async () => {
    reads++
    return state(true)
  })
  expect(reads).toBe(1)
  await expect(waitFor(checks, 100, 100)).rejects.toThrow("stableForMs")
})

test("an explicit terminal error wins over a stale success control without waiting out the timeout", async () => {
  let reads = 0
  await expect(
    waitFor(
      checks,
      5000,
      0,
      async () => {
        reads++
        return {
          ...state(true),
          elements: [
            ...state(true).elements,
            {role: "AXHeading", description: "Call limit reached", visible: true} as Element,
          ],
        }
      },
      [{selector: {role: "AXHeading", description: "Call limit reached"}, message: "Daily call quota exhausted"}],
    ),
  ).rejects.toThrow("Daily call quota exhausted")
  expect(reads).toBe(1)
})

test("cancellation interrupts sustained observation even while the success control remains visible", async () => {
  const abort = new AbortController()
  let reads = 0
  await expect(
    waitFor(checks, 5000, 1000, async () => {
      reads++
      if (reads === 2) abort.abort(new Error("Cancelled by operator"))
      abort.signal.throwIfAborted()
      return state(true)
    }),
  ).rejects.toThrow("Cancelled by operator")
  expect(reads).toBe(2)
})

test("admission waits for the named enabled host control before a single press", async () => {
  const {executeSteps} = await import("./suite")
  let reads = 0,
    presses = 0
  const selector = {role: "AXButton", description: "Admit Mentra E2E Observer", enabled: true}
  const report = {metadata: {}, record: async (step: any) => step} as any
  const driver = {
    snapshot: async () => {
      reads++
      return {
        ...state(false),
        elements: [
          {role: "AXButton", description: "Admit Another Guest", enabled: true, actions: ["AXPress"], visible: true},
          ...(reads < 3 ? [] : [{...selector, enabled: reads >= 5, actions: ["AXPress"], visible: true}]),
          ...(presses ? [{description: "Guest admitted", visible: true}] : []),
        ],
      } as Snapshot
    },
    command: async () => {
      expect(reads).toBeGreaterThanOrEqual(5)
      presses++
      return {} as any
    },
  }
  expect(
    await executeSteps(
      [
        {
          id: "admit",
          instruction: "Admit selected guest",
          expected: "Admitted",
          preconditions: [{selector, action: "AXPress", count: 1}],
          action: {op: "press", selector},
          checks: [{selector: {description: "Guest admitted"}}],
          timeoutMs: 2000,
        },
      ],
      {fixture: "", email: "", password: ""},
      report,
      driver,
    ),
  ).toBe(true)
  expect(presses).toBe(1)
})

test("admission expiry or cancellation never presses and readiness shares the postcondition budget", async () => {
  const {executeSteps} = await import("./suite")
  for (const scenario of ["timeout", "cancel", "slow-postcondition"]) {
    let presses = 0,
      reads = 0
    const selector = {description: "Admit Mentra E2E Observer", enabled: true}
    const abort = new AbortController()
    const driver = {
      snapshot: async () => {
        reads++
        if (scenario === "cancel" && reads === 2) abort.abort(new Error("Operator stopped"))
        return {
          ...state(false),
          elements:
            scenario === "slow-postcondition" && reads >= 3 ? [{...selector, visible: true, actions: ["AXPress"]}] : [],
        } as unknown as Snapshot
      },
      command: async () => {
        presses++
        return {} as any
      },
    }
    const results: any[] = []
    const report = {
      metadata: {},
      record: async (step: any) => {
        results.push(step)
        return step
      },
    } as any
    const start = performance.now()
    expect(
      await executeSteps(
        [
          {
            id: "admit",
            instruction: "Admit",
            expected: "Admitted",
            preconditions: [{selector}],
            action: {op: "press", selector},
            checks: [{selector: {description: "Not yet admitted"}}],
            timeoutMs: 350,
          },
        ],
        {fixture: "", email: "", password: "", signal: abort.signal},
        report,
        driver,
      ),
    ).toBe(false)
    expect(presses).toBe(scenario === "slow-postcondition" ? 1 : 0)
    expect(performance.now() - start).toBeLessThan(650)
    expect(results[0].status).toBe("failed")
  }
})
