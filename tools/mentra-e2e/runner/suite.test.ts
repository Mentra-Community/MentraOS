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
  await waitFor(checks, 100, 0, async () => { reads++; return state(true) })
  expect(reads).toBe(1)
  await expect(waitFor(checks, 100, 100)).rejects.toThrow("stableForMs")
})
