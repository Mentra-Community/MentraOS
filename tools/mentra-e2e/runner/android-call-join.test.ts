import {expect, test} from "bun:test"
import {runInNewContext} from "node:vm"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {androidJoinCommands, waitForAndroidCallJoin} from "./android-call-join"
import {nativeJoinLog, traceFixture} from "./android-join-proof.fixture"
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
function replay(
  screen: (ms: number, taps: number) => ReturnType<typeof node>[],
  timeout = 90000,
  tick = 1000,
  nativeProof = (_ms: number, taps: number) => taps > 0,
) {
  let now = 0,
    taps = 0
  const output = {}
  const evaluate = (script: string) =>
    runInNewContext(script.slice(2, -1), {
      output,
      Date: {now: () => now},
      http: {get: () => ({body: JSON.stringify({proof: nativeProof(now, taps) ? {verified: true} : null})})},
    })
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
  commands(androidJoinCommands(ssid, timeout, "http://127.0.0.1:1234/abcd"))
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

test("remembered approval needs native proof; a pending prompt still prevents early success", () => {
  expect(
    replay(
      () => [leave],
      90000,
      1000,
      (ms) => ms >= 15000,
    ),
  ).toEqual({now: 16000, taps: 0})
  expect(
    replay(
      (ms) => (ms < 10000 ? [leave, node(title, "Connect to device")] : [leave]),
      90000,
      1000,
      () => true,
    ).now,
  ).toBe(11000)
  expect(() =>
    replay(
      (_ms, taps) => (taps ? [leave] : prompt),
      5000,
      1000,
      () => false,
    ),
  ).toThrow("Deadline")
  expect(() =>
    replay(
      () => [leave, node("android:id/message", "No devices found.")],
      5000,
      1000,
      () => true,
    ),
  ).toThrow("Terminal")
})

test("live wrapper serves native proof, bounds the flow, saves evidence and closes its server on success or failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "android-join-"))
  try {
    for (const fail of [false, true]) {
      const startedAtMs = Date.now() - 10000
      const trace = {...traceFixture, logPath: join(directory, "phone.log"), startedAtMs}
      await writeFile(trace.logPath, nativeJoinLog(startedAtMs))
      let url = ""
      const run = {
        directory,
        step: async (_id: string, _instruction: string, _expected: string, action: () => Promise<void>) => action(),
        flow: async (_id: string, commands: Record<string, unknown>[], timeout: number) => {
          expect(timeout).toBe(125000)
          const poll = commands.find((c) => typeof c.evalScript === "string" && c.evalScript.includes("http.get"))!
          url = /http.get\("([^"]+)"\)/.exec(poll.evalScript as string)![1]
          expect((await (await fetch(url)).json()).proof.ssid).toBe(ssid)
          expect((await fetch(url + "-wrong")).status).toBe(404)
          expect((await fetch(url, {method: "POST"})).status).toBe(404)
          if (fail) throw new Error("Flow failed")
        },
      } as AndroidSession
      if (fail) await expect(waitForAndroidCallJoin(run, trace, 120000)).rejects.toThrow("Flow failed")
      else {
        await waitForAndroidCallJoin(run, trace, 120000)
        expect(JSON.parse(await readFile(join(directory, "android-join-proof.json"), "utf8")).traceId).toBe(
          trace.traceId,
        )
      }
      await expect(fetch(url)).rejects.toThrow()
    }
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
