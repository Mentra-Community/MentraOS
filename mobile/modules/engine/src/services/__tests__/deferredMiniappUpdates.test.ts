import {afterEach, describe, expect, test} from "bun:test"

import {
  markMiniappUpdateDeferred,
  onDeferredMiniappUpdateReady,
  resetDeferredMiniappUpdatesForTests,
} from "../deferredMiniappUpdates"
import {miniappRunningRegistry} from "../MiniappRunningRegistry"

afterEach(() => {
  resetDeferredMiniappUpdatesForTests()
  for (const packageName of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(packageName)
})

describe("deferred miniapp updates", () => {
  test("announce once when the deferred miniapp stops", () => {
    const ready: string[] = []
    onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    miniappRunningRegistry.add("com.acme.notes")
    miniappRunningRegistry.add("com.acme.other")
    markMiniappUpdateDeferred("com.acme.notes")

    miniappRunningRegistry.remove("com.acme.other")
    expect(ready).toEqual([])
    miniappRunningRegistry.remove("com.acme.notes")
    expect(ready).toEqual(["com.acme.notes"])

    miniappRunningRegistry.add("com.acme.notes")
    miniappRunningRegistry.remove("com.acme.notes")
    expect(ready).toEqual(["com.acme.notes"])
  })

  test("ignore a miniapp that is not running as user activity", () => {
    const ready: string[] = []
    onDeferredMiniappUpdateReady((packageName) => ready.push(packageName))
    markMiniappUpdateDeferred("com.acme.hidden")
    miniappRunningRegistry.add("com.acme.hidden")
    miniappRunningRegistry.remove("com.acme.hidden")
    expect(ready).toEqual([])
  })
})
