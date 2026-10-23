import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {reactNativeAppState} from "./reactNativeTestMock"
import {miniappRunningRegistry} from "../MiniappRunningRegistry"
import type {PendingRunningUpdatePrompt} from "../runningUpdatePrompt"

const {
  canShowRunningUpdatePrompt,
  emitRunningUpdateFailed,
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  requestRunningUpdatePrompt,
  setRunningUpdatePromptEnvironmentForTests,
} = await import("../runningUpdatePrompt")

const request = {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0"}
let foreground = true
const prompted = new Set<string>()

beforeEach(() => {
  foreground = true
  prompted.clear()
  setRunningUpdatePromptEnvironmentForTests({
    isForeground: () => foreground,
    wasPromptedThisRun: (packageName) => prompted.has(packageName),
    recordPrompted: (packageName) => prompted.add(packageName),
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
    expect(prompted.has(request.packageName)).toBe(true)
  })

  test("Not now is an answer, and this run of the miniapp is not asked again", async () => {
    const {shown} = answerWith("not_now")
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(false)
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    // Another miniapp is not limited by this one's prompt.
    await expect(requestRunningUpdatePrompt({...request, packageName: "com.acme.other"})).resolves.toBe("not_now")
    expect(shown).toHaveLength(2)
  })

  test("is not shown while the Mentra App is in the background, and that does not count as asking", async () => {
    const {shown} = answerWith("update")
    foreground = false
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    expect(shown).toHaveLength(0)
    expect(prompted.size).toBe(0)
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
    expect(prompted.size).toBe(0)
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
  })

  test("by default, asks again the next time the miniapp is opened, and not before", async () => {
    setRunningUpdatePromptEnvironmentForTests(null)
    reactNativeAppState.currentState = "active"
    answerWith("not_now")
    miniappRunningRegistry.add(request.packageName)
    try {
      await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
      expect(canShowRunningUpdatePrompt(request.packageName)).toBe(false)
      // Stopping and opening it again starts a new run.
      miniappRunningRegistry.remove(request.packageName)
      miniappRunningRegistry.add(request.packageName)
      expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
    } finally {
      miniappRunningRegistry.remove(request.packageName)
    }
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
