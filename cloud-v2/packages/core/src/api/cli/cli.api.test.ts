import {afterEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"

import type {AppEnv} from "../../types/hono.types"
import cliApi from "./cli.api"

const NAMES = ["CLOUD_CORE_OIDC_ISSUER", "CLOUD_CORE_OIDC_CLIENTS"] as const
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const CLI_CLIENT = {clientId: "mentra-cli", kind: "cli", redirectUris: ["http://127.0.0.1:53682/callback"]}
const ADMIN_CLIENT = {
  clientId: "admin-portal",
  kind: "admin_portal",
  secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
  redirectUris: ["https://admin.example.com/api/admin/auth/callback"],
}

function set(issuer: string | undefined, clients: unknown[] | undefined) {
  if (issuer === undefined) delete process.env.CLOUD_CORE_OIDC_ISSUER
  else process.env.CLOUD_CORE_OIDC_ISSUER = issuer
  if (clients === undefined) delete process.env.CLOUD_CORE_OIDC_CLIENTS
  else process.env.CLOUD_CORE_OIDC_CLIENTS = JSON.stringify(clients)
}

async function getConfig(): Promise<Response> {
  const app = new Hono<AppEnv>()
  app.route("/api/cli", cliApi)
  return app.request("/api/cli/config")
}

describe("GET /api/cli/config", () => {
  test("answers the issuer and the CLI's client ID, uncached", async () => {
    set("https://account.example.com/", [ADMIN_CLIENT, CLI_CLIENT])
    const response = await getConfig()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({issuer: "https://account.example.com", clientId: "mentra-cli"})
  })

  test("answers 404 not_configured while the sign-in server is off", async () => {
    set(undefined, [CLI_CLIENT])
    const response = await getConfig()
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({error: "not_configured", error_description: expect.any(String)})
  })

  test("answers 404 not_configured when no CLI client is registered", async () => {
    set("https://account.example.com", [ADMIN_CLIENT])
    const response = await getConfig()
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({error: "not_configured"})
  })
})
