import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import * as root from "./index"
import {
  PORTAL_MODULE_CONTRACT_VERSION,
  type PortalModule,
  type PortalModuleContext,
  type PortalModuleMe,
} from "./portal-module-ui"

const me: PortalModuleMe = {
  authenticated: true,
  user: {mentraUserId: "mu_1", email: "person@example.test", emailVerified: true},
}

describe("portal module UI contract", () => {
  test("is version 1", () => {
    expect(PORTAL_MODULE_CONTRACT_VERSION).toBe(1)
  })

  test("is reached through the ./portal-module-ui subpath, not the package root, and bundles for the browser", async () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(manifest.exports["./portal-module-ui"]).toBe("./src/portal-module-ui.ts")
    expect(Object.keys(root)).not.toContain("PORTAL_MODULE_CONTRACT_VERSION")
    const entrypoint = Bun.resolveSync("./portal-module-ui", import.meta.dir)
    const result = await Bun.build({entrypoints: [entrypoint], target: "browser"})
    expect(result.logs.filter((log) => log.level === "error").map((log) => log.message)).toEqual([])
    expect(result.success).toBe(true)
  })

  test("a module mounts into a host element with the host's context and unmounts", () => {
    const calls: string[] = []
    const mod: PortalModule = {
      contractVersion: PORTAL_MODULE_CONTRACT_VERSION,
      mount(element, ctx) {
        calls.push(`mount ${ctx.apiBase} ${JSON.stringify(ctx.scope)} ${ctx.route.path}${ctx.route.query}`)
        ctx.navigate("/licenses", {replace: true})
        ctx.onSessionExpired()
        return {unmount: () => calls.push("unmount")}
      },
    }
    const ctx: PortalModuleContext = {
      apiBase: "/api/portal/billing",
      me,
      scope: {kind: "workspace", workspaceId: "ws_1"},
      route: {path: "/", query: "?tab=seats"},
      navigate: (path, opts) => calls.push(`navigate ${path} ${opts?.replace === true}`),
      onSessionExpired: () => calls.push("expired"),
    }
    const handle = mod.mount({} as unknown as HTMLElement, ctx)
    handle.unmount()
    expect(calls).toEqual([
      'mount /api/portal/billing {"kind":"workspace","workspaceId":"ws_1"} /?tab=seats',
      "navigate /licenses true",
      "expired",
      "unmount",
    ])
  })

  test("a person's own account is a scope of its own, and a handle's setRoute is optional", () => {
    const calls: string[] = []
    const ctx: PortalModuleContext = {
      apiBase: "/api/portal/billing",
      me,
      scope: {kind: "person"},
      route: {path: "/", query: ""},
      navigate: () => {},
      onSessionExpired: () => {},
    }
    const redrawing: PortalModule = {
      contractVersion: PORTAL_MODULE_CONTRACT_VERSION,
      mount: () => ({
        unmount: () => calls.push("unmount"),
        setRoute: (route) => calls.push(`route ${route.path}${route.query}`),
      }),
    }
    const remounting: PortalModule = {
      contractVersion: PORTAL_MODULE_CONTRACT_VERSION,
      mount: () => ({unmount: () => calls.push("unmount")}),
    }
    const withSetRoute = redrawing.mount({} as unknown as HTMLElement, ctx)
    withSetRoute.setRoute?.({path: "/plans", query: "?x=1"})
    const withoutSetRoute = remounting.mount({} as unknown as HTMLElement, ctx)
    expect(withoutSetRoute.setRoute).toBeUndefined()
    expect(calls).toEqual(["route /plans?x=1"])
  })
})
