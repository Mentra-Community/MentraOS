import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

import {TransientActionWakeCoordinator} from "../TransientActionWakeCoordinator"
import type {ClientApp} from "../../types"

// Exercise the actual broker methods without booting native audio/Bluetooth,
// following the runtime's other isolated handler suites.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["actionError", "invokeDeclaredAction", "invokeActionFromHost", "finalizeActionCall"]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:private|public) (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^  }$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

type Action = NonNullable<ClientApp["actions"]>[number]
interface Host {
  actionPayloadTooLarge: () => boolean
  interopApps: () => ClientApp[]
  connectedApps: Map<string, object>
  transientActionWakes: TransientActionWakeCoordinator
  actionCalls: Map<string, unknown>
  actionCallSeq: number
  sendToMiniapp: (target: string, message: {callId: string; actionId: string}) => void
  invokeActionFromHost: (target: string, action: string) => Promise<unknown>
  invokeDeclaredAction: (
    caller: string,
    target: string,
    action: string,
    params: object,
    timeout: number,
    host: boolean,
  ) => Promise<unknown>
  finalizeActionCall: (callId: string, ok: boolean, result: unknown) => Promise<void>
}

const packageName = "com.mentra.store"
const maintenance: Action = {
  id: "reconcile_updates",
  description: "Update installed miniapps",
  audience: "host",
  lifecycle: "transient",
}

function harness(action = maintenance, deploymentAllows = true) {
  const app = {packageName, local: true, actions: [action]} as ClientApp
  const installed = mock(async () => (deploymentAllows ? [app] : []))
  const errors = Object.fromEntries(["APP_NOT_FOUND", "ACTION_NOT_FOUND", "WAKE_FAILED"].map((code) => [code, code]))
  const HostClass = new Function(
    "appRegistry",
    "isMiniappAvailable",
    "isStoreMiniappPackage",
    "MiniappErrorCode",
    "MiniappResponseType",
    "HOST_ACTION_CALLER",
    "BgTimer",
    `${compiled}; return Host`,
  )(
    {getInstalledMiniapps: installed},
    () => false,
    () => true,
    errors,
    {ACTION_CALL: "action"},
    "host",
    {setTimeout, clearTimeout},
  ) as new () => Host
  const host = new HostClass()
  host.actionPayloadTooLarge = () => false
  host.interopApps = () => []
  host.connectedApps = new Map()
  host.actionCalls = new Map()
  host.actionCallSeq = 0
  const wake = mock(async () => {
    host.connectedApps.set(packageName, {})
  })
  const stop = mock(async () => {
    host.connectedApps.delete(packageName)
  })
  host.transientActionWakes = new TransientActionWakeCoordinator({
    isContextRunning: () => host.connectedApps.has(packageName),
    isProjectedRunning: () => false,
    ensureConnectedHidden: wake,
    stopContext: stop,
  })
  const delivered = mock((_target: string, message: {callId: string; actionId: string}) => {
    void host.finalizeActionCall(message.callId, true, {updated: 1})
  })
  host.sendToMiniapp = delivered
  return {host, installed, wake, stop, delivered}
}

describe("background-only miniapp actions", () => {
  test("host maintenance resolves a hidden installation, runs, and releases its context", async () => {
    const h = harness()
    expect(await h.host.invokeActionFromHost(packageName, maintenance.id)).toEqual({updated: 1})
    expect(h.installed).toHaveBeenCalledWith({includeBackgroundOnly: true})
    expect(h.wake).toHaveBeenCalledTimes(1)
    expect(h.delivered).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.host.connectedApps.size).toBe(0)
    expect(h.host.interopApps()).toEqual([])
  })

  test("another miniapp cannot resolve or invoke the hidden worker", async () => {
    const h = harness()
    await expect(
      h.host.invokeDeclaredAction("com.other", packageName, maintenance.id, {}, 6000, false),
    ).rejects.toMatchObject({code: "APP_NOT_FOUND"})
    expect(h.installed).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
  })

  test.each([
    {...maintenance, audience: "system"},
    {...maintenance, lifecycle: "persistent"},
  ] as Action[])(
    "background-only execution requires both host audience and transient lifecycle (%j)",
    async (action) => {
      const h = harness(action)
      await expect(h.host.invokeActionFromHost(packageName, maintenance.id)).rejects.toMatchObject({
        code: "ACTION_NOT_FOUND",
      })
      expect(h.wake).not.toHaveBeenCalled()
    },
  )

  test("host maintenance respects the deployment-filtered inventory", async () => {
    const h = harness(maintenance, false)
    await expect(h.host.invokeActionFromHost(packageName, maintenance.id)).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    })
    expect(h.wake).not.toHaveBeenCalled()
  })
})
