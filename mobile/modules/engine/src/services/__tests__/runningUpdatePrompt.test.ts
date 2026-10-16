import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import "./reactNativeTestMock"
import type {PendingRunningUpdatePrompt} from "../runningUpdatePrompt"

mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
const {
  canShowRunningUpdatePrompt,
  emitRunningUpdateFailed,
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  requestRunningUpdatePrompt,
  RUNNING_UPDATE_PROMPT_INTERVAL_MS,
  setRunningUpdatePromptEnvironmentForTests,
} = await import("../runningUpdatePrompt")

const request = {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0"}
let foreground = true
let now = 1_000_000
const promptedAt = new Map<string, number>()

beforeEach(() => {
  foreground = true
  now = 1_000_000
  promptedAt.clear()
  setRunningUpdatePromptEnvironmentForTests({
    isForeground: () => foreground,
    now: () => now,
    lastPromptedAt: (packageName) => promptedAt.get(packageName) ?? null,
    recordPrompted: (packageName, at) => promptedAt.set(packageName, at),
  })
})

afterEach(() => setRunningUpdatePromptEnvironmentForTests(null))

function answerWith(choice: "update" | "not_now") {
  const shown: PendingRunningUpdatePrompt[] = []
  const unsubscribe = onRunningUpdatePrompt((prompt) => {
    shown.push(prompt)
    prompt.answer(choice)
  })
  return {shown, unsubscribe}
}

describe("running update prompt", () => {
  test("asks the host UI and resolves with the user's answer", async () => {
    const {shown} = answerWith("update")
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("update")
    expect(shown.map(({packageName, displayName, version}) => ({packageName, displayName, version}))).toEqual([request])
    expect(promptedAt.get(request.packageName)).toBe(now)
  })

  test("Not now is an answer, and the prompt returns at most once a day for that miniapp", async () => {
    const {shown} = answerWith("not_now")
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
    now += RUNNING_UPDATE_PROMPT_INTERVAL_MS - 1
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(false)
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    // Another miniapp is not limited by this one's prompt.
    await expect(requestRunningUpdatePrompt({...request, packageName: "com.acme.other"})).resolves.toBe("not_now")
    now += 1
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
    expect(shown).toHaveLength(3)
  })

  test("is not shown while the Mentra App is in the background, and that does not count as asking", async () => {
    const {shown} = answerWith("update")
    foreground = false
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    expect(shown).toHaveLength(0)
    expect(promptedAt.size).toBe(0)
    foreground = true
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("update")
  })

  test("shows one prompt at a time", async () => {
    const pending: PendingRunningUpdatePrompt[] = []
    onRunningUpdatePrompt((prompt) => pending.push(prompt))
    const first = requestRunningUpdatePrompt(request)
    await expect(requestRunningUpdatePrompt({...request, packageName: "com.acme.other"})).resolves.toBe("not_shown")
    pending[0].answer("not_now")
    // A second answer to the same prompt is ignored.
    pending[0].answer("update")
    await expect(first).resolves.toBe("not_now")
    expect(pending).toHaveLength(1)
    await expect(canShowRunningUpdatePrompt("com.acme.other")).toBe(true)
  })

  test("needs a registered host UI", async () => {
    const {unsubscribe} = answerWith("update")
    unsubscribe()
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
  })

  test("a host UI that throws leaves the prompt unshown and unrecorded", async () => {
    onRunningUpdatePrompt(() => {
      throw new Error("no modal")
    })
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    expect(promptedAt.size).toBe(0)
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
  })

  test("a clock moved backwards does not suppress the prompt", async () => {
    answerWith("not_now")
    await requestRunningUpdatePrompt(request)
    now -= 10_000
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
  })

  test("fans update failures out to the host", () => {
    const failures: unknown[] = []
    const unsubscribe = onRunningUpdateFailed((failure) => failures.push(failure))
    emitRunningUpdateFailed({packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"})
    unsubscribe()
    emitRunningUpdateFailed({packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"})
    expect(failures).toEqual([{packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"}])
  })
})
