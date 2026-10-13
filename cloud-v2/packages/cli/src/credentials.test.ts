import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {DEFAULT_CONSOLE_URL, DEFAULT_STORE_URL, getConfig, type CliTarget} from "./config"
import {
  clearCredentials,
  isStoredLogin,
  loadCredentials,
  loadStoredLogin,
  saveCredentials,
  type CliCredentials,
} from "./credentials"

const ENV = [
  "MENTRA_CLI_TOKEN",
  "MENTRA_CLI_WORKSPACE_ID",
  "MENTRA_CORE_URL",
  "MENTRA_STORE_URL",
  "MENTRA_CONSOLE_URL",
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

const store = (url: string): CliTarget => ({kind: "store", url})
const core = (url: string): CliTarget => ({kind: "core", url})

function login(target: CliTarget, overrides: Partial<CliCredentials> = {}): CliCredentials {
  return {
    token: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    mentraUserId: "mu_1",
    email: "ada@example.com",
    issuer: "https://account.example.test",
    clientId: "mentra-cli",
    ...(target.kind === "store" ? {storeUrl: target.url} : {coreUrl: target.url}),
    storedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("what the CLI targets", () => {
  test("the production Store and Developer Console by default", () => {
    expect(DEFAULT_STORE_URL).toBe("https://api.apps.mentraglass.com")
    expect(getConfig()).toEqual({
      target: {kind: "store", url: DEFAULT_STORE_URL},
      consoleUrl: DEFAULT_CONSOLE_URL,
      oidcIssuer: "",
      cliClientId: "",
    })
    expect(DEFAULT_CONSOLE_URL).toBe("https://console.mentraglass.com")
  })

  test("MENTRA_STORE_URL selects another Store, and plain HTTP only on this machine", () => {
    process.env.MENTRA_STORE_URL = "http://localhost:3003/"
    expect(getConfig().target).toEqual({kind: "store", url: "http://localhost:3003"})
    for (const url of ["http://store.example.test", "https://user:password@store.example.test", "file:///tmp/store"]) {
      process.env.MENTRA_STORE_URL = url
      expect(getConfig).toThrow("MENTRA_STORE_URL must be an HTTPS URL")
    }
  })

  test("MENTRA_CORE_URL selects Core mode", () => {
    process.env.MENTRA_CORE_URL = "https://core.acme.example/"
    expect(getConfig().target).toEqual({kind: "core", url: "https://core.acme.example"})
  })

  test("MENTRA_STORE_URL and MENTRA_CORE_URL together are refused", () => {
    process.env.MENTRA_STORE_URL = "https://store.example.test"
    process.env.MENTRA_CORE_URL = "https://core.example.test"
    expect(getConfig).toThrow("not both")
  })

  test("the sign-in server comes from MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID", () => {
    process.env.MENTRA_CLI_OIDC_ISSUER = "https://account.example.test"
    process.env.MENTRA_CLI_CLIENT_ID = "mentra-cli"
    expect(getConfig()).toMatchObject({oidcIssuer: "https://account.example.test", cliClientId: "mentra-cli"})
  })
})

describe("stored logins", () => {
  test("a login is stored in the keychain and read back for its Store", async () => {
    const target = store(DEFAULT_STORE_URL)
    expect(await saveCredentials(login(target))).toBe("keychain")
    expect(await loadCredentials(target)).toEqual(login(target, {expiresAt: expect.any(String), storedAt: expect.any(String)}))
    expect(existsSync(join(home, "store-credentials-" + Buffer.from(DEFAULT_STORE_URL).toString("base64url") + ".json"))).toBe(false)
  })

  test("switching Store never forwards another Store's tokens", async () => {
    const one = store("https://store-one.example.test")
    const two = store("https://store-two.example.test")
    await saveCredentials(login(one, {token: "one-token"}))
    expect(await loadCredentials(two)).toBeNull()
    await saveCredentials(login(two, {token: "two-token"}))
    expect((await loadCredentials(one))?.token).toBe("one-token")
    expect((await loadCredentials(two))?.token).toBe("two-token")
    await clearCredentials(one)
    expect(await loadCredentials(one)).toBeNull()
    expect((await loadCredentials(two))?.token).toBe("two-token")
  })

  test("a Core-mode login is kept apart from a Store login at the same URL", async () => {
    const url = "https://cloud.acme.example"
    await saveCredentials(login(store(url), {token: "store-token"}))
    expect(await loadCredentials(core(url))).toBeNull()
    await saveCredentials(login(core(url), {token: "core-token"}))
    expect(await loadStoredLogin(core(url))).toMatchObject({token: "core-token", coreUrl: url})
    expect((await loadStoredLogin(store(url)))?.token).toBe("store-token")
  })

  test("a record naming another Store is refused", async () => {
    const target = store("https://selected.example.test")
    await saveCredentials(login(target))
    for (const key of secrets.keys()) secrets.set(key, JSON.stringify(login(store("https://other.example.test"))))
    expect(await loadCredentials(target)).toBeNull()
  })

  test("a login stored by the older CLI (no issuer) reads as signed out", async () => {
    const target = store(DEFAULT_STORE_URL)
    await saveCredentials(login(target))
    const older = {token: "old", refreshToken: "old-refresh", email: "ada@example.com", storeUrl: DEFAULT_STORE_URL, storedAt: new Date().toISOString()}
    for (const key of secrets.keys()) secrets.set(key, JSON.stringify(older))
    expect(await loadCredentials(target)).toBeNull()
  })

  test("without a keychain, the login is a mode-0600 file under MENTRA_CLI_HOME", async () => {
    useKeychain(false)
    const target = store(DEFAULT_STORE_URL)
    expect(await saveCredentials(login(target))).toBe("file")
    const file = join(home, `store-credentials-${Buffer.from(DEFAULT_STORE_URL).toString("base64url")}.json`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({refreshToken: "refresh-token", issuer: "https://account.example.test"})
    expect(await loadCredentials(target)).toMatchObject({refreshToken: "refresh-token"})

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
    expect(await loadCredentials(target)).toBeNull()
  })

  test("a login written to the file while the keychain failed is not shadowed by an older keychain login", async () => {
    const target = store(DEFAULT_STORE_URL)
    await saveCredentials(login(target, {refreshToken: "older"}))
    useKeychain(false)
    expect(await saveCredentials(login(target, {refreshToken: "newer"}))).toBe("file")
    useKeychain(true)
    expect((await loadStoredLogin(target))?.refreshToken).toBe("newer")
    // Saving again with the keychain back moves the login there and drops the file.
    await saveCredentials(login(target, {refreshToken: "newest"}))
    expect((await loadStoredLogin(target))?.refreshToken).toBe("newest")
  })

  test("a workspace selection saved to the file, with the same login, is not lost to the keychain copy", async () => {
    const target = store(DEFAULT_STORE_URL)
    const stored = login(target, {workspaceId: "ws_1"})
    await saveCredentials(stored)
    useKeychain(false)
    // Same login, same sign-in time: only the selection differs.
    expect(await saveCredentials({...stored, workspaceId: "ws_2"})).toBe("file")
    useKeychain(true)
    expect((await loadStoredLogin(target))?.workspaceId).toBe("ws_2")
  })

  test("a write the keychain refuses removes the older keychain login it would otherwise leave behind", async () => {
    const target = store(DEFAULT_STORE_URL)
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
    const target = store(DEFAULT_STORE_URL)
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
    const target = store(DEFAULT_STORE_URL)
    await saveCredentials(login(target))
    await clearCredentials(target)
    expect(secrets.size).toBe(0)
    expect(await loadCredentials(target)).toBeNull()
  })
})

describe("MENTRA_CLI_TOKEN", () => {
  test("MENTRA_CLI_TOKEN=msk_... bypasses login (L09)", async () => {
    process.env.MENTRA_CLI_TOKEN = "msk_ci_key"
    const target = store(DEFAULT_STORE_URL)
    await saveCredentials(login(target, {token: "stored-token"}))
    const credentials = await loadCredentials(target)
    expect(credentials).toEqual({fromEnvironment: true, token: "msk_ci_key", storeUrl: DEFAULT_STORE_URL, workspaceId: undefined})
    expect(isStoredLogin(credentials!)).toBe(false)
  })

  test("MENTRA_CLI_WORKSPACE_ID selects the token's workspace", async () => {
    process.env.MENTRA_CLI_TOKEN = "msk_ci_key"
    process.env.MENTRA_CLI_WORKSPACE_ID = "ws_ci"
    expect(await loadCredentials(store(DEFAULT_STORE_URL))).toMatchObject({token: "msk_ci_key", workspaceId: "ws_ci"})
  })

  test("in Core mode the token goes to the Core", async () => {
    process.env.MENTRA_CLI_TOKEN = "msk_ci_key"
    expect(await loadCredentials(core("https://core.acme.example"))).toMatchObject({coreUrl: "https://core.acme.example"})
  })

  test("the stored login is still there for logout", async () => {
    process.env.MENTRA_CLI_TOKEN = "msk_ci_key"
    const target = store(DEFAULT_STORE_URL)
    await saveCredentials(login(target, {token: "stored-token"}))
    expect((await loadStoredLogin(target))?.token).toBe("stored-token")
  })
})
