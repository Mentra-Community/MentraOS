import {expect, test} from "bun:test"
import type {Snapshot} from "./driver"
import {recordedAction} from "./recorded-action"

test("a command that succeeds cannot conceal an evidence failure", async () => {
  let records = 0
  const report: Parameters<typeof recordedAction>[0] = {
    video: undefined,
    record: async (step) => {
      records++
      return {...step, status: "failed", error: "Recording frame is stale"}
    },
  }
  await expect(
    recordedAction(
      report,
      "network",
      "Check the network.",
      "Healthy",
      async () => {},
      async () => ({frontmostBundleId: "test"} as Snapshot),
    ),
  ).rejects.toThrow("stale")
  expect(records).toBe(1)
})

test("missing app evidence fails the run but does not skip owned cleanup", async () => {
  let cleaned = 0
  const recorded: string[] = []
  const report: Parameters<typeof recordedAction>[0] = {
    record: async (step) => {
      recorded.push(step.status)
      return step
    },
  }
  await expect(
    recordedAction(
      report,
      "cleanup",
      "Stop hotspot.",
      "Stopped",
      async () => {
        cleaned++
      },
      async () => {
        throw new Error("App disappeared")
      },
      true,
    ),
  ).rejects.toThrow("App disappeared")
  expect(cleaned).toBe(1)
  expect(recorded).toEqual(["failed"])
})

test("missing prerequisite evidence prevents ordinary state changes", async () => {
  let actions = 0
  const report: Parameters<typeof recordedAction>[0] = {record: async (step) => step}
  await expect(
    recordedAction(
      report,
      "setup",
      "Start hotspot.",
      "Started",
      async () => {
        actions++
      },
      async () => {
        throw new Error("App disappeared")
      },
    ),
  ).rejects.toThrow("App disappeared")
  expect(actions).toBe(0)
})
