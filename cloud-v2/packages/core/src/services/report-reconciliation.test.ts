import {expect, test} from "bun:test"
import {startReportReconciliation} from "./report-reconciliation"

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("both report services tick at once and again on the interval", async () => {
  let notifications = 0, logs = 0
  const stop = startReportReconciliation([{async tick() {notifications++}}, {async tick() {logs++}}], 10)
  expect([notifications, logs]).toEqual([1, 1])
  await wait(35)
  await stop()
  expect(notifications).toBeGreaterThan(1)
  expect(logs).toBe(notifications)
})

test("one failing service neither stops the other nor the loop", async () => {
  let logs = 0, failures = 0
  const stop = startReportReconciliation([
    {async tick() {failures++; throw new Error("slack down")}},
    {tick() {logs++; return Promise.resolve()}},
  ], 10)
  await wait(35)
  await stop()
  expect(failures).toBeGreaterThan(1)
  expect(logs).toBe(failures)
})

test("a slow tick never overlaps the next, and stop waits for it and ends the loop", async () => {
  let calls = 0, release!: () => void
  const held = new Promise<void>(resolve => {release = resolve})
  const stop = startReportReconciliation([{async tick() {calls++; await held}}], 5)
  await wait(25)
  expect(calls).toBe(1)
  let stopped = false
  const stopping = stop().then(() => {stopped = true})
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await stopping
  expect(stopped).toBe(true)
  await wait(15)
  expect(calls).toBe(1)
})
