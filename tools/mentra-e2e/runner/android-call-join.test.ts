import {expect, test} from "bun:test"
import {runInNewContext} from "node:vm"
import {androidJoinCommands, waitForAndroidCallJoin} from "./android-call-join"
import type {AndroidSession} from "./android-session"

const ssid = "MentraLive_b9a02c"
const title = "com.android.settings:id/network_request_title_text"
const node = (id: string, text: string, enabled = true) => ({id, text, enabled})
const prompt = [
  node(title, "Connect to device"),
  node(
    "com.android.settings:id/network_request_summary_text",
    "Mentra app wants to use a temporary Wi‑Fi network to connect to your device",
  ),
  node("android:id/message", ssid),
  node("android:id/button1", "Connect"),
]
const leave = node("", "Leave the call")

// Exercise the generated commands, conditions and JS against a timed UI trace.
// This is a bounded interpreter for the Maestro commands this flow emits; an
// unknown command fails the test instead of being silently skipped.
function replay(screen: (ms: number, taps: number) => ReturnType<typeof node>[], timeout = 90000, tick = 1000) {
  let now = 0,
    taps = 0
  const output = {}
  const evaluate = (script: string) => runInNewContext(script.slice(2, -1), {output, Date: {now: () => now}})
  const visible = (selector: any) =>
    screen(now, taps).some((n) => {
      if (typeof selector === "string") selector = {text: selector}
      return Object.entries(selector).every(([key, value]) =>
        key === "enabled" ? n.enabled === value : new RegExp(`^(?:${value})$`).test(n[key as "id" | "text"]),
      )
    })
  const condition = (when: any) =>
    (!when.true || evaluate(when.true)) &&
    (!when.visible || visible(when.visible)) &&
    (!when.notVisible || !visible(when.notVisible))
  function commands(items: any[]) {
    for (const item of items) {
      const [op, value] = Object.entries(item)[0] as [string, any]
      if (op === "evalScript") evaluate(value)
      else if (op === "assertTrue") {
        if (!evaluate(value)) throw new Error("Deadline or join assertion failed")
      } else if (op === "assertVisible") {
        if (!visible(value)) throw new Error("Required prompt absent")
      } else if (op === "assertNotVisible") {
        if (visible(value)) throw new Error("Terminal error or overlay")
      } else if (op === "runFlow") {
        if (condition(value.when)) commands(value.commands)
      } else if (op === "repeat") {
        while (condition(value.while)) {
          commands(value.commands)
          now += tick
        }
      } else if (op === "tapOn") {
        const {retryTapIfNoChange, ...selector} = value
        if (!visible(selector)) throw new Error("Invalid tap")
        expect(retryTapIfNoChange).toBe(false)
        taps++
      } else if (op !== "takeScreenshot") throw new Error(`Unknown command: ${op}`)
    }
  }
  commands(androidJoinCommands(ssid, timeout))
  return {now, taps}
}

test("generated flow waits through searching and underlying Leave before approving exactly once", () => {
  const result = replay((ms, taps) =>
    ms < 5000
      ? [leave]
      : ms < 12000
      ? [leave, node(title, "Connect to device")]
      : taps === 0
      ? [...prompt, leave]
      : ms < 15000
      ? [...prompt, leave]
      : [leave],
  )
  expect(result.taps).toBe(1)
  expect(result.now).toBeGreaterThanOrEqual(15000)
})

test("generated flow rejects wrong SSID/app and terminal failures during searching or after approval", () => {
  for (const wrong of [
    prompt.map((n) => (n.id === "android:id/message" ? {...n, text: "MentraLive_other"} : n)),
    prompt.map((n) => (n.id.endsWith("summary_text") ? {...n, text: "Another app"} : n)),
  ])
    expect(() => replay(() => wrong)).toThrow("Required prompt")
  for (const error of [
    "No devices found. Make sure devices are turned on and available to connect.",
    "Something came up. The application has cancelled the request to choose a device.",
    "Couldn’t join the meeting",
  ])
    for (const afterApproval of [false, true])
      expect(() =>
        replay((_ms, taps) => (afterApproval && !taps ? prompt : [leave, node("android:id/message", error)])),
      ).toThrow("Terminal")
})

test("generated flow never accepts Leave alone, a searching title, or a reused positive button", () => {
  for (const screen of [
    [leave],
    [leave, node(title, "Connect to device")],
    ...["OK", "Try again"].map((text) => prompt.map((n) => (n.id === "android:id/button1" ? {...n, text} : n))),
  ])
    expect(() => replay(() => screen, 5000)).toThrow("Deadline")
})

test("slow valid join shares one deadline and a second wait cannot extend it", () => {
  expect(replay((ms, taps) => (!taps ? (ms < 80000 ? [] : prompt) : ms < 110000 ? [] : [leave]), 120000).taps).toBe(1)
  expect(() => replay((ms, taps) => (!taps ? (ms < 80000 ? [] : prompt) : ms < 110000 ? [] : [leave]), 90000)).toThrow(
    "Deadline",
  )
})

test("live wrapper passes its whole deadline plus bounded teardown to Maestro", async () => {
  let budget = 0
  const run = {
    step: async (_id: string, _instruction: string, _expected: string, action: () => Promise<void>) => action(),
    flow: async (_id: string, commands: Record<string, unknown>[], timeout: number) => {
      budget = timeout
      expect(commands.some((c) => c.repeat)).toBe(true)
    },
  } as AndroidSession
  await waitForAndroidCallJoin(run, ssid, 120000)
  expect(budget).toBe(125000)
})
