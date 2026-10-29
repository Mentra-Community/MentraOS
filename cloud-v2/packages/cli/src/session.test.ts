import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"
import {existsSync, mkdtempSync, readdirSync, rmSync, utimesSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {refreshTokenGrant} from "openid-client"

import {ensureOidcClient, revokeLogin, SessionExpiredError} from "./api"
import type {CliTarget} from "./config"
import {clearCredentials, loadStoredLogin, refreshLockPath, saveCredentials, type CliCredentials} from "./credentials"
import {loopbackLogin} from "./loopback-login"
import {loadFreshCredentials, renewRefusedLogin, selectWorkspace, signOut, storeLogin} from "./session"
import {startFakeOidcIssuer, type FakeOidcIssuer} from "./testing/fake-oidc-issuer"
import {expectLoopbackPortsFree, freeLoopbackPorts} from "./testing/loopback"

const target: CliTarget = {kind: "store", url: "https://store.example.test"}
const savedHome = process.env.MENTRA_CLI_HOME
const savedToken = process.env.MENTRA_CLI_TOKEN
const secrets = new Map<string, string>()
let spies: Array<{mockRestore(): void}> = []
let home = ""
let idp: FakeOidcIssuer
let freePorts: number[] = []

beforeEach(async () => {
  freePorts = await freeLoopbackPorts()
  home = mkdtempSync(join(tmpdir(), "mentra-cli-session-"))
  process.env.MENTRA_CLI_HOME = home
  delete process.env.MENTRA_CLI_TOKEN
  secrets.clear()
  spies = [
    spyOn(Bun.secrets, "get").mockImplementation(async ({service, name}) => secrets.get(`${service}:${name}`) ?? null),
    spyOn(Bun.secrets, "set").mockImplementation(async ({service, name, value}) => {
      secrets.set(`${service}:${name}`, value)
    }),
    spyOn(Bun.secrets, "delete").mockImplementation(async ({service, name}) => secrets.delete(`${service}:${name}`)),
  ]
  idp = await startFakeOidcIssuer({publicClientId: "mentra-cli"})
})

afterEach(async () => {
  idp.stop()
  for (const spy of spies.splice(0)) spy.mockRestore()
  rmSync(home, {recursive: true, force: true})
  if (savedHome === undefined) delete process.env.MENTRA_CLI_HOME
  else process.env.MENTRA_CLI_HOME = savedHome
  if (savedToken === undefined) delete process.env.MENTRA_CLI_TOKEN
  else process.env.MENTRA_CLI_TOKEN = savedToken
  await expectLoopbackPortsFree(freePorts)
})

/** Sign in through the fake issuer and store the login, expiring in `expiresInMs`. */
async function storedLogin(expiresInMs: number): Promise<CliCredentials> {
  const config = await ensureOidcClient({oidcIssuer: idp.issuer, cliClientId: "mentra-cli"})
  let browser: Promise<unknown> | undefined
  const result = await loopbackLogin(config, {
    openBrowser: async url => {
      browser = idp.approveInBrowser(url, {sub: "mu_1", email: "ada@example.com"})
      return true
    },
    print: () => {},
  })
  await browser
  const login: CliCredentials = {
    token: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    mentraUserId: result.subject,
    email: result.email,
    issuer: idp.issuer,
    clientId: "mentra-cli",
    storeUrl: target.url,
    workspaceId: "ws_1",
    storedAt: new Date().toISOString(),
  }
  await saveCredentials(login)
  return login
}

test("a login with time left is used as stored", async () => {
  const login = await storedLogin(10 * 60_000)
  expect(await loadFreshCredentials(target)).toMatchObject({token: login.token, refreshToken: login.refreshToken})
  expect(idp.refreshes).toBe(0)
})

test("refresh rotates the stored refresh token", async () => {
  const login = await storedLogin(30_000)
  const fresh = (await loadFreshCredentials(target)) as CliCredentials
  expect(idp.refreshes).toBe(1)
  expect(fresh.token).not.toBe(login.token)
  expect(fresh.refreshToken).not.toBe(login.refreshToken)
  expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.now() + 3_000_000)
  // The rotated refresh token is what is stored, with the workspace kept.
  expect(await loadStoredLogin(target)).toMatchObject({refreshToken: fresh.refreshToken, token: fresh.token, workspaceId: "ws_1"})
  expect(idp.refreshTokenActive(login.refreshToken)).toBe(false)
  expect(idp.refreshTokenActive(fresh.refreshToken)).toBe(true)
  expect(readdirSync(home).filter(name => name.endsWith(".lock"))).toEqual([])
})

test("concurrent commands refresh once and share the result", async () => {
  await storedLogin(30_000)
  const results = await Promise.all(Array.from({length: 4}, () => loadFreshCredentials(target)))
  expect(idp.refreshes).toBe(1)
  const refreshTokens = new Set(results.map(result => (result as CliCredentials).refreshToken))
  expect(refreshTokens.size).toBe(1)
  expect(idp.refreshTokenActive([...refreshTokens][0]!)).toBe(true)
})

test("a refused access token is refreshed at once, although it has not expired", async () => {
  const login = await storedLogin(3_600_000)
  const renewed = (await renewRefusedLogin(target, login.mentraUserId, login.token))!
  expect(idp.refreshes).toBe(1)
  expect(renewed.token).not.toBe(login.token)
  expect(await loadStoredLogin(target)).toMatchObject({token: renewed.token, refreshToken: renewed.refreshToken, workspaceId: "ws_1"})
})

test("a refused access token another request already replaced is not refreshed again", async () => {
  const login = await storedLogin(3_600_000)
  const first = await Promise.all([
    renewRefusedLogin(target, login.mentraUserId, login.token),
    renewRefusedLogin(target, login.mentraUserId, login.token),
  ])
  expect(idp.refreshes).toBe(1)
  expect(first[0]!.token).toBe(first[1]!.token)
  // The refused token is no longer the stored one: the stored login is used as it is.
  expect((await renewRefusedLogin(target, login.mentraUserId, login.token))!.token).toBe(first[0]!.token)
  expect(idp.refreshes).toBe(1)
})

test("a refused access token gives nothing to retry with once signed out or another person's login is stored", async () => {
  const login = await storedLogin(3_600_000)
  expect(await renewRefusedLogin(target, "mu_someone_else", login.token)).toBeNull()
  await clearCredentials(target)
  expect(await renewRefusedLogin(target, login.mentraUserId, login.token)).toBeNull()
  expect(idp.refreshes).toBe(0)
})

test("a refused access token whose sign-in has ended clears the login (SessionExpiredError)", async () => {
  const login = await storedLogin(3_600_000)
  await revokeLogin(login)
  await expect(renewRefusedLogin(target, login.mentraUserId, login.token)).rejects.toBeInstanceOf(SessionExpiredError)
  expect(await loadStoredLogin(target)).toBeNull()
})

test("signing out waits for a running refresh, revokes the refresh token it produced, and nothing restores the login", async () => {
  await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80) // the refresh holds the lock now
  const signedOut = await signOut(target)
  const refreshed = (await refreshing) as CliCredentials
  expect(signedOut).toEqual({signedIn: true, confirmed: true})
  expect(await loadStoredLogin(target)).toBeNull()
  expect(idp.refreshTokenActive(refreshed.refreshToken)).toBe(false)
  expect(await signOut(target)).toEqual({signedIn: false, confirmed: false})
})

test("selecting a workspace keeps the tokens a concurrent refresh rotated", async () => {
  const login = await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80)
  expect(await selectWorkspace(target, "ws_2", {mentraUserId: login.mentraUserId})).not.toBeNull()
  const refreshed = (await refreshing) as CliCredentials
  const stored = (await loadStoredLogin(target))!
  expect(stored.workspaceId).toBe("ws_2")
  expect(stored.refreshToken).toBe(refreshed.refreshToken)
  expect(stored.refreshToken).not.toBe(login.refreshToken)
  expect(idp.refreshTokenActive(stored.refreshToken)).toBe(true)
})

test("a workspace chosen for one person is never applied to another person's login stored meanwhile", async () => {
  const login = await storedLogin(3_600_000)
  expect(await selectWorkspace(target, "ws_2", {mentraUserId: "mu_someone_else"})).toBeNull()
  expect((await loadStoredLogin(target))!.workspaceId).toBe(login.workspaceId)
  expect(await selectWorkspace(target, "ws_2", {mentraUserId: login.mentraUserId})).not.toBeNull()
  expect((await loadStoredLogin(target))!.workspaceId).toBe("ws_2")
})

test("a new sign-in stored during a refresh of the previous one is not overwritten by it", async () => {
  const previous = await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80)
  const next: CliCredentials = {...previous, token: "new-access", refreshToken: "new-refresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString()}
  await storeLogin(next)
  await refreshing
  expect((await loadStoredLogin(target))!.refreshToken).toBe("new-refresh")
})

test("a refresh never overwrites a login another command stored while it was in flight", async () => {
  await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80)
  // A command that took over the lock (this one looked stale) stored its own result meanwhile.
  const other = {...(await loadStoredLogin(target))!, token: "other-access", refreshToken: "other-refresh"}
  await saveCredentials(other)
  const result = (await refreshing) as CliCredentials
  expect(result.refreshToken).toBe("other-refresh")
  expect((await loadStoredLogin(target))!.refreshToken).toBe("other-refresh")
  // The tokens this refresh obtained, which nothing will use, are revoked.
  expect(idp.revocations).toHaveLength(1)
})

test("a refresh that finishes after the login was signed out (by a command that took over) stores nothing", async () => {
  await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80)
  await clearCredentials(target)
  expect(await refreshing).toBeNull()
  expect(await loadStoredLogin(target)).toBeNull()
  // The tokens it obtained are revoked, not left live.
  expect(idp.revocations).toHaveLength(1)
  expect(idp.refreshTokenActive(idp.revocations[0]!.token)).toBe(false)
})

test("a refused refresh does not clear a login another command stored meanwhile", async () => {
  const original = await storedLogin(30_000)
  idp.refreshDelayMs = 300
  const refreshing = loadFreshCredentials(target)
  await Bun.sleep(80)
  // Another command (this one looked stale) signed in again, and the old grant ended.
  const other = {...original, token: "other-access", refreshToken: "other-refresh"}
  await saveCredentials(other)
  await revokeLogin(original)
  const result = (await refreshing) as CliCredentials
  expect(result.refreshToken).toBe("other-refresh")
  expect((await loadStoredLogin(target))!.refreshToken).toBe("other-refresh")
})

test("a sign-out that lost the lock while paused leaves the login another command stored", async () => {
  const original = await storedLogin(3_600_000)
  // While its revocation is answered, this command is paused past the stale age and another signs in.
  idp.beforeRevocation = async () => {
    idp.beforeRevocation = null
    const then = new Date(Date.now() - 120_000)
    utimesSync(join(refreshLockPath(target), "holder"), then, then)
    await storeLogin({...original, token: "other-access", refreshToken: "other-refresh"})
  }
  expect((await signOut(target)).signedIn).toBe(true)
  expect((await loadStoredLogin(target))?.refreshToken).toBe("other-refresh")
})

test("a refused refresh token says Session expired and clears the login", async () => {
  const login = await storedLogin(30_000)
  // Spend the stored refresh token elsewhere first, so presenting it again ends the grant.
  const config = await ensureOidcClient({oidcIssuer: idp.issuer, cliClientId: "mentra-cli"})
  await refreshTokenGrant(config, login.refreshToken)
  const error = await loadFreshCredentials(target).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(SessionExpiredError)
  expect((error as Error).message).toBe("Session expired. Run `mentra login`.")
  expect(await loadStoredLogin(target)).toBeNull()
  expect(existsSync(join(home, "store-refresh-" + Buffer.from(target.url).toString("base64url") + ".lock"))).toBe(false)
})

test("MENTRA_CLI_TOKEN is used without any refresh", async () => {
  await storedLogin(30_000)
  process.env.MENTRA_CLI_TOKEN = "msk_ci_key"
  expect(await loadFreshCredentials(target)).toMatchObject({fromEnvironment: true, token: "msk_ci_key"})
  expect(idp.refreshes).toBe(0)
})
