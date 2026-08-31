import {afterEach, describe, expect, test} from "bun:test"
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
