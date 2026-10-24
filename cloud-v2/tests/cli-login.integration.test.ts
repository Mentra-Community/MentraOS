/**
 * @fileoverview The `mentra` CLI's sign-in against Core's real sign-in server
 * (L09): the CLI's own `loopbackLogin`, `refreshLoginToken` and `revokeLogin`,
 * with the provider's registered `mentra-cli` client, and its workspace
 * requests (`listWorkspaces`, `createWorkspace`) with the token it gets.
 *
 * Core's app runs in-process; the test's `fetch` sends the issuer's origin and
 * the Core's origin to it, as the sign-in site's relay and the network would.
 * A cookie-keeping browser follows the provider's redirects and finishes the
 * sign-in as a person; it then reaches the CLI's loopback listener over the
 * real loopback network.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards. No test leaves a listener
 * on the CLI's ports.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/cli-login.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import type * as client from "openid-client"

import {
  createWorkspace,
  ensureOidcClient,
  listWorkspaces,
  refreshLoginToken,
  revokeLogin,
  SessionExpiredError,
} from "../packages/cli/src/api"
import type {CliCredentials} from "../packages/cli/src/credentials"
import {loopbackLogin, type LoopbackLoginResult} from "../packages/cli/src/loopback-login"
import {expectLoopbackPortsFree, freeLoopbackPorts, occupy} from "../packages/cli/src/testing/loopback"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {verifyCoreAccessToken} from "../packages/core/src/services/oidc/core-access-token"
import {ensureOidcCollections} from "../packages/core/src/services/oidc/mongo-adapter"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {Browser, coreKeyEnv, finishInteraction, OIDC_ISSUER, providerEnv, routeOriginsToApp, signedInPerson} from "./support/oidc-harness"
import {applyEnv} from "./support/signin-harness"

setDefaultTimeout(30_000)

/** The Core the CLI signs in to; its sign-in server is `OIDC_ISSUER`. */
const CORE_ORIGIN = "https://core.test"
const SIGNED_IN = "Signed in to Mentra. You can close this tab."

const databaseUrl = localTestMongoUrl("cli-login")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
const releases: Array<() => Promise<void>> = []

beforeAll(async () => {
  restoreEnv = applyEnv({
    ...coreKeyEnv(),
    ...providerEnv(),
    CLOUD_CORE_SUPABASE_ISSUER: "https://signin.supabase.co/auth/v1",
    CLOUD_CORE_OIDC_PROVIDERS: undefined,
    REFRESH_TOKEN_PEPPER: "cli-login-pepper",
  })
  resetCoreKeyCaches()
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([UserModel.syncIndexes(), SigninIdentityModel.syncIndexes(), ensureOidcCollections()])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
  restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER, CORE_ORIGIN])
})

/** The CLI's ports free when the test starts (a shared runner may hold one): the ones it will use, in order. */
let freePorts: number[] = []
beforeEach(async () => {
  freePorts = await freeLoopbackPorts()
})

afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  await expectLoopbackPortsFree(freePorts)
})

afterAll(async () => {
  restoreFetch()
  await stopOidcBridge()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
  restoreEnv()
  resetCoreKeyCaches()
})

let personCounter = 0
async function person() {
  personCounter++
  return signedInPerson({
    subject: `supa-cli-${personCounter}`,
    email: `cli${personCounter}@example.com`,
    emailVerified: true,
    name: `CLI Person ${personCounter}`,
  })
}

const isLoopbackCallback = (location: URL) =>
  location.protocol === "http:" && location.hostname === "127.0.0.1" && location.pathname === "/callback"

const atSignInPage = (location: URL) => location.origin === OIDC_ISSUER && location.pathname === "/login"

interface BrowserVisit {
  status: number
  text: string
  /** Whether the browser was sent to the sign-in page, rather than signed in by the sign-in server's session. */
  askedToSignIn: boolean
}

/**
 * Play the browser: follow the authorization request through Core's provider
 * and its interaction routes. Where Core sends the browser to the sign-in
 * page, sign in as `mentraUserId` (as the page's hand-off would). Then deliver
 * the redirect to the CLI's loopback listener.
 */
async function approveInBrowser(authorizationUrl: string, mentraUserId: string, browser: Browser): Promise<BrowserVisit> {
  let step = await browser.follow(authorizationUrl, location => isLoopbackCallback(location) || atSignInPage(location))
  let askedToSignIn = false
  if ("stoppedAt" in step && atSignInPage(step.stoppedAt)) {
    askedToSignIn = true
    const uid = step.stoppedAt.searchParams.get("interaction")!
    const resume = await finishInteraction(new URL(`/interaction/${uid}`, OIDC_ISSUER), mentraUserId)
    step = await browser.follow(resume.href, isLoopbackCallback)
  }
  if (!("stoppedAt" in step)) throw new Error(`the provider did not redirect to the CLI: ${step.page.status}`)
  const response = await fetch(step.stoppedAt, {redirect: "manual", keepalive: false, headers: {connection: "close"}})
  return {status: response.status, text: await response.text(), askedToSignIn}
}

/** `mentra login` against Core, approved in `browser` as `mentraUserId`. */
async function cliLogin(mentraUserId: string, browser = new Browser(app)) {
  const config = await ensureOidcClient({coreUrl: CORE_ORIGIN})
  let authorizationUrl = ""
  let visit: Promise<BrowserVisit> | undefined
  const result = await loopbackLogin(config, {
    openBrowser: async url => {
      authorizationUrl = url
      visit = approveInBrowser(url, mentraUserId, browser)
      return true
    },
    print: () => {},
  })
  return {config, result, authorizationUrl, page: await visit!}
}

function stored(config: client.Configuration, result: LoopbackLoginResult): CliCredentials {
  return {
    token: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(result.expiresAt).toISOString(),
    mentraUserId: result.subject,
    email: result.email,
    issuer: config.serverMetadata().issuer,
    clientId: config.clientMetadata().client_id,
    coreUrl: CORE_ORIGIN,
    storedAt: new Date().toISOString(),
  }
}

describe("GET /api/cli/config", () => {
  test("names the sign-in server and the CLI client, under the request context", async () => {
    const response = await app.request(`${CORE_ORIGIN}/api/cli/config`, {headers: {"x-request-id": "req-cli-config"}})
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBe("req-cli-config")
    expect(await response.json()).toEqual({issuer: OIDC_ISSUER, clientId: "mentra-cli"})
  })
})

describe("the CLI against Core's sign-in server (L09)", () => {
  test("loopback login: Core accepts the access token as the person, for their workspace", async () => {
    const {mentraUserId} = await person()
    const {config, result, authorizationUrl, page} = await cliLogin(mentraUserId)
    expect(config.serverMetadata().issuer).toBe(OIDC_ISSUER)
    expect(config.clientMetadata().client_id).toBe("mentra-cli")
    const request = new URL(authorizationUrl).searchParams
    expect(request.get("redirect_uri")).toBe(`http://127.0.0.1:${freePorts[0]}/callback`)
    expect(request.get("code_challenge_method")).toBe("S256")
    expect(page).toEqual({status: 200, text: SIGNED_IN, askedToSignIn: true})

    expect(result.subject).toBe(mentraUserId)
    expect(result.email).toBe(`cli${personCounter}@example.com`)
    expect(result.refreshToken).toBeTruthy()
    expect(await verifyCoreAccessToken(result.accessToken)).toMatchObject({mentraUserId, clientId: "mentra-cli"})

    // `mentra workspace show` and `mentra workspace create`, as this person.
    const credentials = {token: result.accessToken, coreUrl: CORE_ORIGIN}
    expect(await listWorkspaces(credentials)).toEqual([])
    const created = await createWorkspace(credentials, "CLI Team")
    expect(created).toMatchObject({name: "CLI Team", membership: {role: "owner"}})
    expect((await listWorkspaces(credentials)).map(workspace => [workspace.workspaceId, workspace.name])).toEqual([
      [created.workspaceId, "CLI Team"],
    ])
  })

  test("refresh rotates; reusing the spent refresh token fails and ends the grant", async () => {
    const {mentraUserId} = await person()
    const {config, result} = await cliLogin(mentraUserId)
    const login = stored(config, result)

    const refreshed = await refreshLoginToken(login)
    expect(refreshed.refreshToken).not.toBe(login.refreshToken)
    expect(refreshed.mentraUserId).toBe(mentraUserId)
    expect(await verifyCoreAccessToken(refreshed.token)).toMatchObject({mentraUserId, clientId: "mentra-cli"})

    await expect(refreshLoginToken(login)).rejects.toBeInstanceOf(SessionExpiredError)
    // Presenting the spent token ended the grant, so the rotated one is gone too.
    await expect(refreshLoginToken(refreshed)).rejects.toBeInstanceOf(SessionExpiredError)
  })

  test("after revokeLogin the refresh token fails", async () => {
    const {mentraUserId} = await person()
    const {config, result} = await cliLogin(mentraUserId)
    const login = stored(config, result)
    expect(await revokeLogin(login)).toEqual({confirmed: true})
    await expect(refreshLoginToken(login)).rejects.toBeInstanceOf(SessionExpiredError)
  })

  test("with its first port taken, the CLI signs in on the next registered one", async () => {
    releases.push(await occupy(freePorts[0]!))
    const {mentraUserId} = await person()
    const {result, authorizationUrl, page} = await cliLogin(mentraUserId)
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${freePorts[1]}/callback`)
    expect(page.status).toBe(200)
    expect(result.subject).toBe(mentraUserId)
  })

  test("logging out of one CLI login leaves the person's other CLI logins signed in", async () => {
    const {mentraUserId} = await person()
    const browser = new Browser(app)
    const first = await cliLogin(mentraUserId, browser)
    // The same browser: the sign-in server's session signs the second login in without asking,
    // through Core's own consent step for a first-party client.
    const second = await cliLogin(mentraUserId, browser)
    // Another browser, another sign-in.
    const third = await cliLogin(mentraUserId)
    expect([first, second, third].map(login => login.page.askedToSignIn)).toEqual([true, false, true])

    expect(await revokeLogin(stored(first.config, first.result))).toEqual({confirmed: true})
    await expect(refreshLoginToken(stored(first.config, first.result))).rejects.toBeInstanceOf(SessionExpiredError)
    expect((await refreshLoginToken(stored(second.config, second.result))).mentraUserId).toBe(mentraUserId)
    expect((await refreshLoginToken(stored(third.config, third.result))).mentraUserId).toBe(mentraUserId)
  })
})
