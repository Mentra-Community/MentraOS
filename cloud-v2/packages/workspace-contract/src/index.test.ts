import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import * as root from "./index"
import * as server from "./server"

describe("package entry points", () => {
  test("the package root bundles for the browser", async () => {
    // Resolved rather than hard-coded so the compiled copy under dist/ finds its own index.js.
    const entrypoint = Bun.resolveSync("./index", import.meta.dir)
    const result = await Bun.build({entrypoints: [entrypoint], target: "browser"})
    expect(result.logs.filter((log) => log.level === "error").map((log) => log.message)).toEqual([])
    expect(result.success).toBe(true)
  })

  test("the package root exposes only capabilities and types, not the server helpers", () => {
    expect(typeof root.capabilitiesForRole).toBe("function")
    expect(typeof root.canChangeRole).toBe("function")
    expect(root.WORKSPACE_ROLES).toContain("owner")
    expect(root.INVALID_TOKEN_ERROR).toBe("invalid_token")
    expect(root.SERVICE_UNAUTHORIZED_ERROR).toBe("service_unauthorized")
    expect(root.WORKSPACE_NOT_FOUND_ERROR).toBe("workspace_not_found")
    expect(root.USER_NOT_FOUND_ERROR).toBe("user_not_found")
    expect(root.WORKSPACE_HAS_HOLDS_ERROR).toBe("workspace_has_holds")
    expect(root.OWNS_MINIAPPS_HOLD_REASON).toBe("owns_miniapps")
    // The portals put holds in words with the same function Core uses for its 409.
    expect(typeof root.describeDeletionHold).toBe("function")
    expect(typeof root.describeDeletionHolds).toBe("function")
    expect(root.FORWARDED_PRINCIPAL_HEADERS).toEqual({
      principal: "x-mentra-principal",
      principalSignature: "x-mentra-principal-signature",
    })
    expect(root.FORWARDING_SERVICE).toBe("core")
    // The license types and their error codes, for the portals and billing alike.
    expect(root.STALE_REVISION_ERROR).toBe("stale_revision")
    expect(root.OWNER_NOT_FOUND_ERROR).toBe("owner_not_found")
    // A license is a workspace's: there is no other owner.
    expect(root.LICENSE_OWNER_TYPES).toEqual(["workspace"])
    expect(root.LICENSE_ENDED_REASONS).toEqual(["workspace_deleted"])
    expect(Object.keys(root)).not.toContain("signServiceRequest")
    expect(Object.keys(root)).not.toContain("createCoreWorkspaceClient")
    // The Fleet UI contract names DOM types, so it has its own subpath and server packages never see it.
    expect(Object.keys(root)).not.toContain("FLEET_UI_CONTRACT_VERSION")
    expect(Object.keys(root)).not.toContain("PORTAL_MODULE_CONTRACT_VERSION")
    for (const name of ["signForwardedPrincipal", "verifyForwardedPrincipal", "parseForwardedPrincipal"]) {
      expect(Object.keys(root)).not.toContain(name)
    }
  })

  test("a license write may carry a seat request, and a license view never shows one", () => {
    const write: root.LicenseWrite = {
      licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
      revision: 2,
      owner: {type: "workspace", workspaceId: "ws_1"},
      product: "mentra.call.unlimited",
      features: [{key: "call.unlimited", packages: ["com.mentra.call"]}],
      quantity: 6,
      validFrom: "2026-10-01T00:00:00Z",
      paidThrough: "2026-11-01T00:00:00Z",
      seatRequest: {requestId: "01JZWY3V8N0F2E9GQ4T6KXH5RE", mentraUserId: "mu_1", quantity: 6},
    }
    const {licenseId, seatRequest: _seatRequest, assignTo: _assignTo, ...rest} = write
    const view: root.LicenseView = {...rest, licenseId, seatsUsed: 6, endedAt: null}
    // @ts-expect-error A view leaves the seat request out, as it leaves out the buyer.
    const withRequest: root.LicenseView = {...view, seatRequest: write.seatRequest}
    // @ts-expect-error
    const withBuyer: root.LicenseView = {...view, assignTo: {mentraUserId: "mu_1"}}
    expect(write.seatRequest).toEqual({requestId: "01JZWY3V8N0F2E9GQ4T6KXH5RE", mentraUserId: "mu_1", quantity: 6})
    expect([withRequest.licenseId, withBuyer.licenseId]).toEqual([licenseId, licenseId])
  })

  test("the server entry exposes signing and the Core client", () => {
    expect(typeof server.signServiceRequest).toBe("function")
    expect(typeof server.verifyServiceRequest).toBe("function")
    expect(typeof server.createCoreWorkspaceClient).toBe("function")
    expect(typeof server.CoreWorkspaceClientError).toBe("function")
    expect(typeof server.signForwardedPrincipal).toBe("function")
    expect(typeof server.verifyForwardedPrincipal).toBe("function")
    expect(typeof server.parseForwardedPrincipal).toBe("function")
    expect(server.FORWARDING_SERVICE).toBe("core")
    expect(server.SERVICE_HEADERS.service).toBe("x-mentra-service")
    expect(server.INVALID_TOKEN_ERROR).toBe("invalid_token")
    expect(server.WORKSPACE_HAS_HOLDS_ERROR).toBe("workspace_has_holds")
    expect(typeof server.describeDeletionHolds).toBe("function")
    expect(server.STALE_REVISION_ERROR).toBe("stale_revision")
    expect(server.OWNER_NOT_FOUND_ERROR).toBe("owner_not_found")
  })

  test("package.json maps the root to the browser-safe entry and ./server to the Node entry", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./server": "./src/server.ts",
      "./fleet-ui": "./src/fleet-ui.ts",
      "./portal-module-ui": "./src/portal-module-ui.ts",
      "./portal-billing": "./src/portal-billing.ts",
      "./portal-billing-icons": "./src/portal-billing-icons.ts",
    })
  })
})
