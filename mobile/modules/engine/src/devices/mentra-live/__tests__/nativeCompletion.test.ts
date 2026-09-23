import {expect, test} from "bun:test"
import type {
  NativeFirmwareUpdateSnapshot,
  NativeFirmwareCompletionEvidence,
} from "@mentra/bluetooth-sdk/firmware-updates"
import {LiveNativeCompletion} from "../nativeCompletion"

function fixture(staleFailures = 0) {
  let native: NativeFirmwareUpdateSnapshot = {
    schemaVersion: 1,
    integrationId: "mentra-live",
    deviceId: "live",
    updaterId: "updater",
    sessionId: "session",
    revision: 1,
    connectionGeneration: 1,
    phase: "installing",
    safeToRelease: false,
    canCancel: false,
    canReconcile: true,
    inventory: {},
  }
  let listener: ((value: NativeFirmwareUpdateSnapshot) => void) | null = null
  const proofs: NativeFirmwareCompletionEvidence[] = []
  const completion = new LiveNativeCompletion("live", {
    read: async () => native,
    listen: (value) => {
      listener = value
      return () => {
        listener = null
      }
    },
    complete: async (proof) => {
      proofs.push(proof)
      if (staleFailures-- > 0) {
        native = {...native, revision: native.revision + 1}
        throw Object.assign(new Error("new status arrived"), {code: "stale_evidence"})
      }
      native = {...native, revision: native.revision + 1, safeToRelease: true, phase: "complete"}
      return native
    },
  })
  return {
    completion,
    proofs,
    set: (value: Partial<NativeFirmwareUpdateSnapshot>, emit = true) => {
      native = {...native, ...value, revision: native.revision + 1}
      if (emit) listener?.(native)
    },
  }
}

test("confirmed legacy completion uses the bound native session and latest connection/revision", async () => {
  for (const kind of ["live-bes-reboot", "live-apk-build-increase", "live-apk-target-convergence"] as const) {
    const h = fixture()
    await Promise.resolve()
    h.set({phase: "interrupted", connectionGeneration: 2})
    await h.completion.finish(kind)
    expect(h.proofs).toEqual([
      {deviceId: "live", updaterId: "updater", sessionId: "session", connectionGeneration: 2, revision: 2, kind},
    ])
    h.completion.dispose()
  }
})

test("reconnect without the coordinator verdict cannot release the native owner", async () => {
  const h = fixture()
  h.set({connectionGeneration: 2})
  await expect(h.completion.finish(null)).rejects.toThrow("verification")
  expect(h.proofs).toHaveLength(0)
  h.completion.dispose()
})

test("new or replaced native transactions cannot inherit an old completion verdict", async () => {
  for (const next of [{sessionId: "other"}, {updaterId: "replacement"}]) {
    const h = fixture()
    await Promise.resolve()
    h.set(next)
    await expect(h.completion.finish("live-bes-reboot")).rejects.toThrow("verification")
    expect(h.proofs).toHaveLength(0)
    h.completion.dispose()
  }
})

test("an explicit retry binds its new native session and cannot reuse the old one", async () => {
  const h = fixture()
  await h.completion.beforeStart()
  await expect(h.completion.finish("live-apk-build-increase")).rejects.toThrow("verification")
  h.set({sessionId: "retry", phase: "preparing"})
  await h.completion.finish("live-apk-build-increase")
  expect(h.proofs[0].sessionId).toBe("retry")
  h.completion.dispose()
})

test("terminal read alone cannot bind an unobserved replacement and disposed owners cannot release", async () => {
  const h = fixture()
  await h.completion.beforeStart()
  h.set({sessionId: "unobserved"}, false)
  await expect(h.completion.finish("live-bes-reboot")).rejects.toThrow("verification")
  h.completion.dispose()
  await expect(h.completion.finish("live-bes-reboot")).rejects.toThrow("owner changed")
  expect(h.proofs).toHaveLength(0)
})

test("completion revalidates revision races with a bounded retry budget", async () => {
  const h = fixture(1)
  await h.completion.finish("live-bes-reboot")
  expect(h.proofs.map((value) => value.revision)).toEqual([1, 2])
  expect(h.proofs.map((value) => value.sessionId)).toEqual(["session", "session"])
  h.completion.dispose()
  const stalled = fixture(10)
  await expect(stalled.completion.finish("live-apk-build-increase")).rejects.toThrow("new status arrived")
  expect(stalled.proofs).toHaveLength(3)
  stalled.completion.dispose()
})
