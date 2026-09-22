import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {DEFAULT_STORE_URL, getConfig} from "./config"
import {clearCredentials, loadCredentials, saveCredentials, type CliCredentials} from "./credentials"

const saved = {...process.env}
const secrets = new Map<string, string>()
let get: ReturnType<typeof spyOn>
let set: ReturnType<typeof spyOn>
beforeEach(() => {
  delete process.env.MENTRA_CLI_TOKEN
  delete process.env.MENTRA_STORE_URL
  secrets.clear()
  get = spyOn(Bun.secrets, "get").mockImplementation(
    async ({service, name}) => secrets.get(`${service}:${name}`) ?? null,
  )
  set = spyOn(Bun.secrets, "set").mockImplementation(async ({service, name, value}) => {
    secrets.set(`${service}:${name}`, value)
  })
})
afterEach(() => {
  get.mockRestore()
  set.mockRestore()
  for (const key of ["MENTRA_CLI_TOKEN", "MENTRA_CORE_URL", "MENTRA_STORE_URL"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const credentials = (storeUrl: string, token = "test-token"): CliCredentials => ({
  storeUrl,
  token,
  workosUserId: "user_test",
  email: "test@example.test",
  storedAt: new Date().toISOString(),
})

describe("independent Store configuration", () => {
  test.each(["https://core.mentraglass.com", "https://core.dev.us-west-2.mentraglass.com", "http://localhost:3000"])(
    "uses the same official Store when Core is %s",
    async (coreUrl) => {
      process.env.MENTRA_CORE_URL = coreUrl
      process.env.MENTRA_CLI_TOKEN = "explicit-ci-token"
      expect(getConfig().storeUrl).toBe(DEFAULT_STORE_URL)
      expect(await loadCredentials()).toMatchObject({storeUrl: DEFAULT_STORE_URL, token: "explicit-ci-token"})
    },
  )
  test("uses an explicit local Store independently of Core", async () => {
    process.env.MENTRA_STORE_URL = "http://localhost:3003/"
    process.env.MENTRA_CLI_TOKEN = "explicit-ci-token"
    expect(await loadCredentials()).toMatchObject({storeUrl: "http://localhost:3003"})
  })
  test("rejects a URL with credentials or a non-HTTP scheme", () => {
    for (const url of ["https://user:password@store.example.test", "file:///tmp/store"]) {
      process.env.MENTRA_STORE_URL = url
      expect(getConfig).toThrow()
    }
  })
})

describe("Store-scoped saved logins", () => {
  test("changing Core preserves the Store login", async () => {
    const original = credentials(DEFAULT_STORE_URL)
    await saveCredentials(original)
    process.env.MENTRA_CORE_URL = "https://core.staging.us-west-2.mentraglass.com"
    expect(await loadCredentials()).toEqual(original)
  })
  test("switching Store never forwards another Store token", async () => {
    const one = "https://store-one.example.test",
      two = "https://store-two.example.test"
    await saveCredentials(credentials(one, "one-token"))
    expect(await loadCredentials(two)).toBeNull()
    await saveCredentials(credentials(two, "two-token"))
    expect((await loadCredentials(one))?.token).toBe("one-token")
    expect((await loadCredentials(two))?.token).toBe("two-token")
    await clearCredentials(one)
    expect(await loadCredentials(one)).toBeNull()
    expect((await loadCredentials(two))?.token).toBe("two-token")
  })
  test("rejects a stored record belonging to a different Store", async () => {
    const url = "https://selected.example.test"
    await saveCredentials(credentials(url))
    for (const key of secrets.keys()) secrets.set(key, JSON.stringify(credentials("https://other.example.test")))
    expect(await loadCredentials(url)).toBeNull()
  })
})
