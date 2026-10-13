import {describe, expect, test} from "bun:test"
import {FLEET_UI_CONTRACT_VERSION, type FleetUiContext, type FleetUiMe, type FleetUiModule} from "./fleet-ui"
import * as root from "./index"

const me: FleetUiMe = {
  authenticated: true,
  user: {mentraUserId: "mu_1", email: null},
  organization: {capabilities: ["organization.fleet.administer"]},
  fleet: {installed: true},
}

describe("Fleet UI module contract", () => {
  test("is version 1", () => {
    expect(FLEET_UI_CONTRACT_VERSION).toBe(1)
  })

  test("is exported from the browser-safe package root", () => {
    expect(root.FLEET_UI_CONTRACT_VERSION).toBe(1)
  })

  test("a module mounts into a host element with the host's context and unmounts", () => {
    const calls: string[] = []
    const mod: FleetUiModule = {
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      mount(element, ctx) {
        calls.push(`mount ${ctx.apiBase} ${ctx.route.path}${ctx.route.query}`)
        ctx.navigate("/fleet/devices", {replace: true})
        ctx.onSessionExpired()
        return {unmount: () => calls.push("unmount")}
      },
    }
    const ctx: FleetUiContext = {
      contractVersion: 1,
      apiBase: "/api/admin/fleet",
      me,
      route: {path: "/fleet", query: "?range=7d"},
      navigate: (path, opts) => calls.push(`navigate ${path} ${opts?.replace === true}`),
      onSessionExpired: () => calls.push("expired"),
    }
    const handle = mod.mount({} as unknown as HTMLElement, ctx)
    handle.unmount()
    expect(calls).toEqual(["mount /api/admin/fleet /fleet?range=7d", "navigate /fleet/devices true", "expired", "unmount"])
  })
})
