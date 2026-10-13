import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
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

  test("is reached through the ./fleet-ui subpath, not the package root, and bundles for the browser", async () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(manifest.exports["./fleet-ui"]).toBe("./src/fleet-ui.ts")
    expect(Object.keys(root)).not.toContain("FLEET_UI_CONTRACT_VERSION")
    const entrypoint = Bun.resolveSync("./fleet-ui", import.meta.dir)
    const result = await Bun.build({entrypoints: [entrypoint], target: "browser"})
    expect(result.logs.filter((log) => log.level === "error").map((log) => log.message)).toEqual([])
    expect(result.success).toBe(true)
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

  test("a module's handle may offer setRoute, which a host calls instead of mounting again; it is optional", () => {
    const calls: string[] = []
    const ctx: FleetUiContext = {
      contractVersion: 1,
      apiBase: "/api/admin/fleet",
      me,
      route: {path: "/", query: ""},
      navigate: () => {},
      onSessionExpired: () => {},
    }
    const redrawing: FleetUiModule = {
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      mount: () => ({
        unmount: () => calls.push("unmount"),
        setRoute: (route) => calls.push(`route ${route.path}${route.query}`),
      }),
    }
    const remounting: FleetUiModule = {
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      mount: () => ({unmount: () => calls.push("unmount")}),
    }
    const withSetRoute = redrawing.mount({} as unknown as HTMLElement, ctx)
    withSetRoute.setRoute?.({path: "/devices", query: "?tab=phones"})
    const withoutSetRoute = remounting.mount({} as unknown as HTMLElement, ctx)
    withoutSetRoute.setRoute?.({path: "/devices", query: "?tab=phones"})
    expect(typeof withSetRoute.setRoute).toBe("function")
    expect(withoutSetRoute.setRoute).toBeUndefined()
    expect(calls).toEqual(["route /devices?tab=phones"])
  })
})
