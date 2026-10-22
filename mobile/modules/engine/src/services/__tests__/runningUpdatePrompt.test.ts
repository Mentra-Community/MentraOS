import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import "./reactNativeTestMock"
import type {PendingRunningUpdatePrompt} from "../runningUpdatePrompt"

mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
const {
  canShowRunningUpdatePrompt,
  emitRunningUpdateFailed,
  forgetRunningUpdateDecline,
  noteMiniappOpened,
  onRunningUpdateFailed,
  onRunningUpdatePrompt,
  onRunningUpdatePromptDue,
  requestRunningUpdatePrompt,
  setRunningUpdatePromptEnvironmentForTests,
} = await import("../runningUpdatePrompt")

const request = {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0"}
let foreground = true
const declined = new Set<string>()

beforeEach(() => {
  foreground = true
  declined.clear()
  setRunningUpdatePromptEnvironmentForTests({
    isForeground: () => foreground,
    isDeclined: (packageName) => declined.has(packageName),
    setDeclined: (packageName, value) => void (value ? declined.add(packageName) : declined.delete(packageName)),
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
    // Update leaves nothing that would hold back a later prompt.
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
  })

  test("after Not now it asks again the next time the person opens that miniapp, and not before", async () => {
    const {shown} = answerWith("not_now")
    const due: string[] = []
    onRunningUpdatePromptDue((packageName) => due.push(packageName))
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(false)
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    // Another miniapp is neither held back by this one's answer nor does opening it count.
    await expect(requestRunningUpdatePrompt({...request, packageName: "com.acme.other"})).resolves.toBe("not_now")
    noteMiniappOpened("com.acme.third")
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(false)
    expect(due).toEqual([])

    noteMiniappOpened(request.packageName)
    expect(due).toEqual([request.packageName])
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_now")
    expect(shown).toHaveLength(3)
    // Opening it again only counts once per Not now.
    noteMiniappOpened("com.acme.other")
    noteMiniappOpened("com.acme.other")
    expect(due).toEqual([request.packageName, "com.acme.other"])
  })

  test("once the put-off update installs, a later update asks without waiting for an open", async () => {
    answerWith("not_now")
    await requestRunningUpdatePrompt(request)
    forgetRunningUpdateDecline(request.packageName)
    expect(canShowRunningUpdatePrompt(request.packageName)).toBe(true)
  })

  test("is not shown while the Mentra App is in the background, and that does not count as asking", async () => {
    const {shown} = answerWith("update")
    foreground = false
    await expect(requestRunningUpdatePrompt(request)).resolves.toBe("not_shown")
    expect(shown).toHaveLength(0)
    expect(declined.size).toBe(0)
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
    expect(declined.size).toBe(0)
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
