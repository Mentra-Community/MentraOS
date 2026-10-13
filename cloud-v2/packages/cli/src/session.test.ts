import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"
import {existsSync, mkdtempSync, readdirSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {refreshTokenGrant} from "openid-client"

import {ensureOidcClient, SessionExpiredError} from "./api"
import type {CliTarget} from "./config"
import {loadStoredLogin, saveCredentials, type CliCredentials} from "./credentials"
import {loopbackLogin} from "./loopback-login"
import {loadFreshCredentials} from "./session"
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
