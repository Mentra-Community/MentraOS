import {expect, test} from "bun:test"
import type {
  NativeFirmwareUpdateSnapshot,
  NativeFirmwareCompletionEvidence,
} from "@mentra/bluetooth-sdk/firmware-updates"
import {LiveNativeCompletion} from "../nativeCompletion"

function fixture(staleFailures = 0, readFailures = 0) {
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
    read: async () => {
      if (readFailures-- > 0) throw new Error("temporary bridge failure")
      return native
    },
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
    failRead: () => {
      readFailures = 1
    },
    notify: (value: Partial<NativeFirmwareUpdateSnapshot>) => listener?.({...native, ...value}),
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

test("explicit Start retries a failed initial bridge read", async () => {
  const h = fixture(0, 1)
  await h.completion.beforeStart()
  h.set({sessionId: "retry", phase: "preparing"})
  await h.completion.finish("live-bes-reboot")
  expect(h.proofs[0].sessionId).toBe("retry")
  expect(h.completion.isSafeToRelease()).toBe(true)
  h.completion.dispose()
})

test.each(["fresh event", "explicit retry"])("%s recovers a transient observation error", async (recovery) => {
  const h = fixture()
  await new Promise((resolve) => setTimeout(resolve, 0))
  h.failRead()
  // A replacement notification forces an authoritative bridge read, which fails once.
  h.notify({updaterId: "other", connectionGeneration: 2})
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(h.completion.isSafeToRelease()).toBe(false)
  if (recovery === "fresh event") {
    h.set({safeToRelease: true, phase: "complete"})
    expect(h.completion.isSafeToRelease()).toBe(true)
  }
  await h.completion.finish("live-bes-reboot")
  expect(h.completion.isSafeToRelease()).toBe(true)
  expect(h.proofs).toHaveLength(recovery === "fresh event" ? 0 : 1)
  if (h.proofs.length) expect(h.proofs[0].updaterId).toBe("updater")
  h.completion.dispose()
})

test("a terminal read refreshes release safety when the native event was missed", async () => {
  const h = fixture()
  await new Promise((resolve) => setTimeout(resolve, 0))
  h.set({safeToRelease: true, phase: "complete"}, false)
  await h.completion.finish(null)
  expect(h.completion.isSafeToRelease()).toBe(true)
  expect(h.proofs).toHaveLength(0)
  h.completion.dispose()
})

test("a healthy terminal read recovers an initially unavailable observation without a completion proof", async () => {
  const h = fixture(0, 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(h.completion.isSafeToRelease()).toBe(false)
  h.set({safeToRelease: true, phase: "complete"}, false)
  await h.completion.finish(null)
  expect(h.completion.isSafeToRelease()).toBe(true)
  expect(h.proofs).toHaveLength(0)
  h.completion.dispose()
})

test("a failed read cannot be cleared by safe evidence from a different device", async () => {
  const h = fixture()
  await new Promise((resolve) => setTimeout(resolve, 0))
  h.failRead()
  await expect(h.completion.finish("live-bes-reboot")).rejects.toThrow("temporary bridge failure")
  h.set({deviceId: "other", phase: "complete", safeToRelease: true}, false)
  await expect(h.completion.finish("live-bes-reboot")).rejects.toThrow("Fresh Live")
  expect(h.completion.isSafeToRelease()).toBe(false)
  expect(h.proofs).toHaveLength(0)
  h.completion.dispose()
})
