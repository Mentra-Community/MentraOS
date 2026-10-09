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
    expect(root.HISTORY_WINDOW_EXCEEDED_ERROR).toBe("history_window_exceeded")
    expect(root.USER_DELETED_ACTION).toBe("user.deleted")
    expect(root.FORWARDED_PRINCIPAL_HEADERS).toEqual({
      principal: "x-mentra-principal",
      principalSignature: "x-mentra-principal-signature",
    })
    expect(root.FORWARDING_SERVICE).toBe("core")
    expect(Object.keys(root)).not.toContain("signServiceRequest")
    expect(Object.keys(root)).not.toContain("createCoreWorkspaceClient")
    expect(Object.keys(root)).not.toContain("verifyForwardedPrincipal")
  })

  test("the server entry exposes signing and the Core client", () => {
    expect(typeof server.signServiceRequest).toBe("function")
    expect(typeof server.verifyServiceRequest).toBe("function")
    expect(typeof server.createCoreWorkspaceClient).toBe("function")
    expect(typeof server.CoreWorkspaceClientError).toBe("function")
    expect(typeof server.signForwardedPrincipal).toBe("function")
    expect(typeof server.verifyForwardedPrincipal).toBe("function")
    expect(server.SERVICE_HEADERS.service).toBe("x-mentra-service")
    expect(server.INVALID_TOKEN_ERROR).toBe("invalid_token")
  })

  test("package.json maps the root to the browser-safe entry and ./server to the Node entry", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(manifest.exports).toEqual({".": "./src/index.ts", "./server": "./src/server.ts"})
  })
})
