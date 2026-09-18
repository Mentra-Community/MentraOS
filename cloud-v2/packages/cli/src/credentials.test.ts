import {afterEach, describe, expect, test} from "bun:test"
import {deriveStoreUrl, resolveStoreUrlForCore} from "./config"
import {loadCredentials} from "./credentials"

const saved = {
  token: process.env.MENTRA_CLI_TOKEN,
  coreUrl: process.env.MENTRA_CORE_URL,
  storeUrl: process.env.MENTRA_STORE_URL,
}

afterEach(() => {
  restoreEnv("MENTRA_CLI_TOKEN", saved.token)
  restoreEnv("MENTRA_CORE_URL", saved.coreUrl)
  restoreEnv("MENTRA_STORE_URL", saved.storeUrl)
})

describe("environment credentials", () => {
  test("use the production Core default when no explicit Core URL is configured", async () => {
    process.env.MENTRA_CLI_TOKEN = "test-token"
    delete process.env.MENTRA_CORE_URL
    delete process.env.MENTRA_STORE_URL

    expect(await loadCredentials()).toMatchObject({
      token: "test-token",
      coreUrl: "https://core.mentraglass.com",
      storeUrl: "https://store.mentraglass.com",
    })
  })

  test("derive the Store environment from an explicit Core URL", async () => {
    process.env.MENTRA_CLI_TOKEN = "test-token"
    process.env.MENTRA_CORE_URL = "https://core.staging.us-west-2.mentraglass.com"
    delete process.env.MENTRA_STORE_URL

    expect(await loadCredentials()).toMatchObject({
      coreUrl: "https://core.staging.us-west-2.mentraglass.com",
      storeUrl: "https://store.staging.us-west-2.mentraglass.com",
    })
  })

  test("honor an explicit Store URL for independently named deployments", async () => {
    process.env.MENTRA_CLI_TOKEN = "test-token"
    process.env.MENTRA_CORE_URL = "https://identity.example.test"
    process.env.MENTRA_STORE_URL = "https://catalog.example.test"

    expect(await loadCredentials()).toMatchObject({
      coreUrl: "https://identity.example.test",
      storeUrl: "https://catalog.example.test",
    })
  })

  test("keep an arbitrary custom Core on the same origin when Store is omitted", async () => {
    process.env.MENTRA_CLI_TOKEN = "test-token"
    process.env.MENTRA_CORE_URL = "https://identity.example.test/cloud"
    delete process.env.MENTRA_STORE_URL

    expect(await loadCredentials()).toMatchObject({
      coreUrl: "https://identity.example.test/cloud",
      storeUrl: "https://identity.example.test/cloud",
    })
  })
})

describe("stored logins resolve their own Store", () => {
  test("follow the credential's Core, not whatever Core this process defaults to", () => {
    // A staging login loaded while no MENTRA_CORE_URL is set must not be
    // retargeted at the production Store: that sends its token to the wrong
    // host and looks up signing keys under a slot it never saved.
    delete process.env.MENTRA_CORE_URL
    delete process.env.MENTRA_STORE_URL

    expect(resolveStoreUrlForCore("https://core.staging.us-west-2.mentraglass.com")).toBe(
      "https://store.staging.us-west-2.mentraglass.com",
    )
  })

  test("prefer the Store persisted with the login over re-deriving it", () => {
    delete process.env.MENTRA_STORE_URL

    expect(resolveStoreUrlForCore("https://identity.example.test", "https://catalog.example.test")).toBe(
      "https://catalog.example.test",
    )
  })

  test("let an explicit Store URL override a persisted one for this run", () => {
    process.env.MENTRA_STORE_URL = "https://override.example.test"

    expect(resolveStoreUrlForCore("https://identity.example.test", "https://catalog.example.test")).toBe(
      "https://override.example.test",
    )
  })
})

describe("local Store derivation", () => {
  test.each([
    ["http://localhost:3000", "http://localhost:3003"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3003"],
    // URL.hostname brackets IPv6 literals, so a bare "::1" comparison never matches.
    ["http://[::1]:3000", "http://[::1]:3003"],
  ])("remaps %s to the local Store port", (core, expected) => {
    expect(deriveStoreUrl(core)).toBe(expected)
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
