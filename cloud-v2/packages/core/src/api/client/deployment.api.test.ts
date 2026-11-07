import {describe, expect, test} from "bun:test"
import {Hono} from "hono"
import clientDeployment, {DEFAULT_MINIAPP_PACKAGES} from "./deployment.api"
import type {AppEnv} from "../../types/hono.types"

describe("GET /api/client/deployment", () => {
  test("serves Mentra's default miniapps without a session", async () => {
    const app = new Hono<AppEnv>().route("/api/client/deployment", clientDeployment)
    const response = await app.request("/api/client/deployment")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({miniapps: {defaults: [...DEFAULT_MINIAPP_PACKAGES]}})
  })

  test("lists each package once, in the app's package-name form", () => {
    expect(new Set(DEFAULT_MINIAPP_PACKAGES).size).toBe(DEFAULT_MINIAPP_PACKAGES.length)
    for (const name of DEFAULT_MINIAPP_PACKAGES) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/)
  })
})
