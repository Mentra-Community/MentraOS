import {describe, expect, test} from "bun:test"

import {DeviceIntegrationRegistry} from "../../devices/types"
import {RevisionedSnapshot} from "../RevisionedSnapshot"
import {FirmwareUpdateService} from "../UpdateService"
import type {FirmwareActionRequest, FirmwareProvider, FirmwareSnapshot, FirmwareTarget} from "../types"

const target: FirmwareTarget = {
  integrationId: "example.fourth-device",
  deviceId: "native-123",
  displayName: "Test glasses",
}

class TestProvider implements FirmwareProvider {
  calls: string[] = []
  wait: Promise<void> = Promise.resolve()
  readonly state: RevisionedSnapshot<FirmwareSnapshot>

  constructor(readonly target: FirmwareTarget) {
    this.state = new RevisionedSnapshot({
      target,
      flowId: "flow-1",
      attemptId: null,
      nativeSessionId: null,
      revision: 0,
      phase: "available",
      active: false,
      safeToRelease: true,
      offer: {id: "offer-1", required: true, observedVersion: "1", targetVersion: "2"},
      error: null,
      presentation: {
        title: {text: "Update"},
        busy: false,
        success: false,
        actions: [{id: "install", label: {text: "Install"}}],
      },
    })
  }
  snapshot = () => this.state.snapshot()
  subscribe = (listener: (snapshot: FirmwareSnapshot) => void) => this.state.subscribe(listener)
  async open() {
    this.calls.push("open")
    await this.wait
  }
  async perform(request: FirmwareActionRequest) {
    this.calls.push(request.action)
    await this.wait
    this.update({phase: "installing", active: true, safeToRelease: false})
    return {kind: "none" as const}
  }
  suspendNewWork() {}
  dispose() {
    this.calls.push("dispose")
  }
  update(patch: Partial<FirmwareSnapshot>) {
    this.state.publish({...this.snapshot(), ...patch})
  }
}

function fixture() {
  const providers: TestProvider[] = []
  const registry = new DeviceIntegrationRegistry([
    {
      id: target.integrationId,
      models: ["Unrelated model"],
      firmware: {
        entryPoints: ["settings", "recovery"],
        createProvider: (device) => {
          const provider = new TestProvider(device)
          providers.push(provider)
          return provider
        },
      },
    },
  ])
  const service = new FirmwareUpdateService(registry)
  const provider = service.provider(target) as TestProvider
  return {service, provider, registry, providers}
}

describe("pluggable firmware update service", () => {
  test.each(["nimo", "ar99"])(
    "%s native ownership protects logout and another device without an open provider",
    async (integrationId) => {
      const {service, provider} = fixture()
      service.noteNativeRecovery({integrationId, deviceId: "cold-session"}, false)
      expect(() => service.assertSafeToRelease()).toThrow("updating")
      await expect(service.open(target, {entryPoint: "settings"})).rejects.toMatchObject({code: "busy"})
      expect(provider.calls).toEqual([])
      service.noteNativeRecovery({integrationId, deviceId: "cold-session"}, true)
      expect(() => service.assertSafeToRelease()).not.toThrow()
    },
  )

  test("global recovery observation retains sessions across suspension without opening or starting work", () => {
    const {service, provider} = fixture()
    const seen: string[][] = []
    const remove = service.subscribeRetained(() => seen.push(service.retainedSnapshots().map((s) => s.phase)))
    const before = service.retainedSnapshots()
    expect(service.retainedSnapshots()).toBe(before)
    provider.update({phase: "installing", active: true, safeToRelease: false})
    service.suspendNewWork()
    expect(service.retainedSnapshots()[0].safeToRelease).toBe(false)
    provider.update({phase: "complete", active: false, safeToRelease: true})
    service.release(target)
    expect(seen).toEqual([["available"], ["installing"], ["complete"], []])
    expect(provider.calls).toEqual(["dispose"])
    remove()
  })

  test("a fourth integration is selected without a built-in model or flow switch", async () => {
    const {service, provider, registry} = fixture()
    expect(registry.forModel("Unrelated model")?.id).toBe(target.integrationId)
    expect(registry.forModel("Unrelated model suffix")).toBeUndefined()
    expect(await service.open(target, {entryPoint: "settings"})).toBe(provider)
    expect(service.provider(target)).toBe(provider)
    expect(provider.calls).toEqual(["open"])
  })

  test("observation and remount replay state without starting or cancelling", () => {
    const {service, provider} = fixture()
    const phases: string[] = []
    const off = service.subscribe(target, (state) => phases.push(state.phase))
    provider.update({phase: "installing", active: true, safeToRelease: false})
    off()
    provider.update({phase: "complete", active: false, safeToRelease: true})
    service.subscribe(target, (state) => phases.push(state.phase))()
    expect(phases).toEqual(["available", "installing", "complete"])
    expect(provider.calls).toEqual([])
  })

  test("duplicate approved starts during preparation share one native operation", async () => {
    const {service, provider} = fixture()
    let resolve!: () => void
    provider.wait = new Promise<void>((done) => {
      resolve = done
    })
    const request = {action: "install" as const, offerId: "offer-1"}
    const first = service.perform(target, request)
    const second = service.perform(target, request)
    await Promise.resolve()
    expect(provider.calls).toEqual(["install"])
    expect(() => service.assertSafeToRelease()).toThrow("updating")
    resolve()
    await Promise.all([first, second])
    provider.update({presentation: {...provider.snapshot().presentation, actions: []}})
    await service.perform(target, request)
    expect(provider.calls).toEqual(["install"])
  })

  test("stale offers and unavailable actions never reach a provider", async () => {
    const {service, provider} = fixture()
    await expect(service.perform(target, {action: "install", offerId: "old"})).rejects.toMatchObject({
      code: "stale_offer",
    })
    await expect(service.perform(target, {action: "cancel"})).rejects.toMatchObject({code: "action_unavailable"})
    expect(provider.calls).toEqual([])
  })

  test("a displayed failure does not release an unsafe device", async () => {
    const {service, provider} = fixture()
    provider.update({phase: "failed", active: false, safeToRelease: false})
    expect(() => service.assertSafeToRelease()).toThrow("updating")
    await expect(service.open({...target, deviceId: "different"}, {entryPoint: "settings"})).rejects.toMatchObject({
      code: "busy",
    })
    provider.update({safeToRelease: true})
    expect(() => service.assertSafeToRelease()).not.toThrow()
  })

  test("pending legacy progress entry reserves the device before initialization resolves", async () => {
    const {service, provider} = fixture()
    let resolve!: () => void
    provider.wait = new Promise<void>((done) => {
      resolve = done
    })
    const open = service.open(target, {entryPoint: "recovery", legacyProgressEntry: true})
    await expect(service.open({...target, deviceId: "different"}, {entryPoint: "recovery"})).rejects.toMatchObject({
      code: "busy",
    })
    resolve()
    await open
  })

  test("unsupported integration and entry points never fall back to another provider", async () => {
    const {service} = fixture()
    await expect(service.open({...target, integrationId: "unknown"}, {entryPoint: "settings"})).rejects.toMatchObject({
      code: "unsupported",
    })
    await expect(service.open(target, {entryPoint: "pairing"})).rejects.toMatchObject({code: "unsupported"})
  })

  test("rejected commands release admission without hiding the failure", async () => {
    const {service, provider} = fixture()
    provider.perform = async () => {
      throw new Error("preflight failed")
    }
    await expect(service.perform(target, {action: "install", offerId: "offer-1"})).rejects.toThrow("preflight failed")
    expect(() => service.assertSafeToRelease()).not.toThrow()
  })
})

describe("revisioned snapshot delivery", () => {
  test("reentrant updates preserve monotonically increasing delivery", () => {
    const state = new RevisionedSnapshot({revision: 0, value: "initial"})
    const observed: number[] = []
    state.subscribe((snapshot) => {
      if (snapshot.value === "first") state.publish({value: "second"})
    })
    state.subscribe((snapshot) => observed.push(snapshot.revision))
    state.publish({value: "first"})
    expect(observed).toEqual([0, 1, 2])
  })

  test("a subscriber added during delivery cannot receive an older queued revision", () => {
    const state = new RevisionedSnapshot({revision: 0, value: "initial"})
    const observed: number[] = []
    state.subscribe((snapshot) => {
      if (snapshot.value === "first") {
        state.publish({value: "second"})
        state.subscribe((next) => observed.push(next.revision))
      }
    })
    state.publish({value: "first"})
    expect(observed).toEqual([2])
  })
})
