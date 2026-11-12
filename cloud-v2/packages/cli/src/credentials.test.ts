import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {DEFAULT_CORE_URL, getConfig} from "./config"
import {clearCredentials, loadStoredLogin, saveCredentials, type CliCredentials} from "./credentials"

const ENV = [
  "MENTRA_CORE_URL",
  "MENTRA_CLI_OIDC_ISSUER",
  "MENTRA_CLI_CLIENT_ID",
  "MENTRA_CLI_HOME",
] as const
const saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]))
const secrets = new Map<string, string>()
let spies: Array<{mockRestore(): void}> = []
let home = ""

function useKeychain(available: boolean) {
  for (const spy of spies) spy.mockRestore()
  const fail = async () => {
    throw new Error("no keychain")
  }
  spies = [
    spyOn(Bun.secrets, "get").mockImplementation(
      available ? async ({service, name}) => secrets.get(`${service}:${name}`) ?? null : fail,
    ),
    spyOn(Bun.secrets, "set").mockImplementation(
      available
        ? async ({service, name, value}) => {
            secrets.set(`${service}:${name}`, value)
          }
        : fail,
    ),
    spyOn(Bun.secrets, "delete").mockImplementation(
      available ? async ({service, name}) => secrets.delete(`${service}:${name}`) : fail,
    ),
  ]
}

beforeEach(() => {
  for (const name of ENV) delete process.env[name]
  home = mkdtempSync(join(tmpdir(), "mentra-cli-credentials-"))
  process.env.MENTRA_CLI_HOME = home
  secrets.clear()
  useKeychain(true)
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  rmSync(home, {recursive: true, force: true})
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function login(coreUrl: string, overrides: Partial<CliCredentials> = {}): CliCredentials {
  return {
    token: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    mentraUserId: "mu_1",
    email: "ada@example.com",
    issuer: "https://account.example.test",
    clientId: "mentra-cli",
    coreUrl,
    storedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("what the CLI talks to", () => {
  test("production Core by default", () => {
    expect(DEFAULT_CORE_URL).toBe("https://core.mentraglass.com")
    expect(getConfig()).toEqual({coreUrl: DEFAULT_CORE_URL, oidcIssuer: "", cliClientId: ""})
  })

  test("MENTRA_CORE_URL selects another Core, and plain HTTP only on this machine", () => {
    process.env.MENTRA_CORE_URL = "https://core.acme.example/"
    expect(getConfig().coreUrl).toBe("https://core.acme.example")
    process.env.MENTRA_CORE_URL = "http://localhost:8002/"
    expect(getConfig().coreUrl).toBe("http://localhost:8002")
    for (const url of ["http://core.example.test", "https://user:password@core.example.test", "file:///tmp/core"]) {
      process.env.MENTRA_CORE_URL = url
      expect(getConfig).toThrow("MENTRA_CORE_URL must be an HTTPS URL")
    }
  })

  test("the Store's settings are not read: the CLI never talks to it", () => {
    process.env.MENTRA_STORE_URL = "https://api.apps.mentraglass.com"
    try {
      expect(getConfig()).toEqual({coreUrl: DEFAULT_CORE_URL, oidcIssuer: "", cliClientId: ""})
    } finally {
      delete process.env.MENTRA_STORE_URL
    }
  })

  test("the sign-in server comes from MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID", () => {
    process.env.MENTRA_CLI_OIDC_ISSUER = "https://account.example.test"
    process.env.MENTRA_CLI_CLIENT_ID = "mentra-cli"
    expect(getConfig()).toMatchObject({oidcIssuer: "https://account.example.test", cliClientId: "mentra-cli"})
  })
})

describe("stored logins", () => {
  test("a login is stored in the keychain and read back for its Core", async () => {
    const target = DEFAULT_CORE_URL
    expect(await saveCredentials(login(target))).toBe("keychain")
    expect(await loadStoredLogin(target)).toEqual(login(target, {expiresAt: expect.any(String), storedAt: expect.any(String)}))
    expect([...secrets.keys()]).toEqual([`mentra-store-cli:core-credentials:${Buffer.from(DEFAULT_CORE_URL).toString("base64url")}`])
    expect(existsSync(join(home, "core-credentials-" + Buffer.from(DEFAULT_CORE_URL).toString("base64url") + ".json"))).toBe(false)
  })

  test("switching Core never forwards another Core's tokens", async () => {
    const one = "https://core-one.example.test"
    const two = "https://core-two.example.test"
    await saveCredentials(login(one, {token: "one-token"}))
    expect(await loadStoredLogin(two)).toBeNull()
    await saveCredentials(login(two, {token: "two-token"}))
    expect((await loadStoredLogin(one))?.token).toBe("one-token")
    expect((await loadStoredLogin(two))?.token).toBe("two-token")
    await clearCredentials(one)
    expect(await loadStoredLogin(one)).toBeNull()
    expect((await loadStoredLogin(two))?.token).toBe("two-token")
  })

  test("a login an older CLI stored for a Mentra Miniapp Store is not read", async () => {
    const url = "https://cloud.acme.example"
    const key = Buffer.from(url).toString("base64url")
    secrets.set(`mentra-store-cli:credentials:${key}`, JSON.stringify({...login(url), coreUrl: undefined, storeUrl: url}))
    expect(await loadStoredLogin(url)).toBeNull()
  })

  test("a record naming another Core is refused", async () => {
    const target = "https://selected.example.test"
    await saveCredentials(login(target))
    for (const key of secrets.keys()) secrets.set(key, JSON.stringify(login("https://other.example.test")))
    expect(await loadStoredLogin(target)).toBeNull()
  })

  test("a login stored by the older CLI (no issuer) reads as signed out", async () => {
    const target = DEFAULT_CORE_URL
    await saveCredentials(login(target))
    const older = {token: "old", refreshToken: "old-refresh", email: "ada@example.com", coreUrl: DEFAULT_CORE_URL, storedAt: new Date().toISOString()}
    for (const key of secrets.keys()) secrets.set(key, JSON.stringify(older))
    expect(await loadStoredLogin(target)).toBeNull()
  })

  test("without a keychain, the login is a mode-0600 file under MENTRA_CLI_HOME", async () => {
    useKeychain(false)
    const target = DEFAULT_CORE_URL
    expect(await saveCredentials(login(target))).toBe("file")
    const file = join(home, `core-credentials-${Buffer.from(DEFAULT_CORE_URL).toString("base64url")}.json`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({refreshToken: "refresh-token", issuer: "https://account.example.test"})
    expect(await loadStoredLogin(target)).toMatchObject({refreshToken: "refresh-token"})

    // Replacing it keeps the mode, even if the file was loosened meanwhile.
    writeFileSync(file, readFileSync(file), {mode: 0o644})
    await saveCredentials(login(target, {refreshToken: "rotated"}))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect((await loadStoredLogin(target))?.refreshToken).toBe("rotated")

    await clearCredentials(target)
    // No tokens stay on disk. The keychain could not be asked to delete, so the file now records the
    // sign-out, in case the keychain holds an older login.
    expect(readFileSync(file, "utf8")).not.toContain("refresh")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({signedOutAt: expect.any(String)})
    expect(await loadStoredLogin(target)).toBeNull()
  })

  test("a login written to the file while the keychain failed is not shadowed by an older keychain login", async () => {
    const target = DEFAULT_CORE_URL
    await saveCredentials(login(target, {refreshToken: "older"}))
    useKeychain(false)
    expect(await saveCredentials(login(target, {refreshToken: "newer"}))).toBe("file")
    useKeychain(true)
    expect((await loadStoredLogin(target))?.refreshToken).toBe("newer")
    // Saving again with the keychain back moves the login there and drops the file.
    await saveCredentials(login(target, {refreshToken: "newest"}))
    expect((await loadStoredLogin(target))?.refreshToken).toBe("newest")
  })

  test("a write the keychain refuses removes the older keychain login it would otherwise leave behind", async () => {
    const target = DEFAULT_CORE_URL
    await saveCredentials(login(target, {refreshToken: "older"}))
    // The keychain refuses writes but still deletes: the stale record goes with the fallback.
    useKeychain(true)
    const set = spyOn(Bun.secrets, "set").mockImplementation(async () => {
      throw new Error("keychain locked")
    })
    expect(await saveCredentials(login(target, {refreshToken: "newer"}))).toBe("file")
    set.mockRestore()
    expect([...secrets.keys()]).toHaveLength(0)
    expect((await loadStoredLogin(target))?.refreshToken).toBe("newer")
  })

  test("signing out while the keychain cannot delete leaves a dated sign-out that outranks the old keychain login", async () => {
    const target = DEFAULT_CORE_URL
    await saveCredentials(login(target, {refreshToken: "older"}))
    const remove = spyOn(Bun.secrets, "delete").mockImplementation(async () => {
      throw new Error("keychain locked")
    })
    await clearCredentials(target)
    remove.mockRestore()
    expect(secrets.size).toBe(1)
    expect(await loadStoredLogin(target)).toBeNull()
    // A later sign-in still wins.
    await saveCredentials(login(target, {refreshToken: "next"}))
    expect((await loadStoredLogin(target))?.refreshToken).toBe("next")
  })

  test("clearing removes the keychain record", async () => {
    const target = DEFAULT_CORE_URL
    await saveCredentials(login(target))
    await clearCredentials(target)
    expect(secrets.size).toBe(0)
    expect(await loadStoredLogin(target)).toBeNull()
  })
})
