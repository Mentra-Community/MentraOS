/**
 * @fileoverview Sign in with Mentra for miniapp websites, against Core's real
 * sign-in server (`design_docs/cloud/auth/miniapp-website-sign-in/spec.md`).
 *
 * A registered website is a third-party client bound to one package. These
 * tests run its sign-in as a site would: the authorization request, the
 * person's sign-in and consent, the code exchange and refresh. What must hold:
 *  - W01: a server-type and a browser-type site sign in, after consent, and
 *    receive the person's miniapp token for the package, never a token for
 *    Core's API;
 *  - W02: Deny issues no code; a second sign-in shows no consent, in any browser; after Revoke under Connected
 *    apps the old refresh token fails and the next sign-in asks again;
 *  - W03: a redirect that differs in any way is refused;
 *  - W05: no token for a disabled client or for a private package the person
 *    cannot reach;
 *  - W06: nothing a website holds opens Core's own routes;
 *  - W07: `@mentra/auth` verifies the token as it does the phone's, and
 *    returns the website's client ID.
 *  - W08: logging out everywhere, removing the website and the site's own sign-out each end refresh at once.
 *
 * Core's app runs in-process; the test's `fetch` sends the issuer's and Core's
 * origins to it. Safety: `localTestMongoUrl` (loopback only, random database);
 * the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/miniapp-website-signin.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import * as jose from "jose"
import * as client from "openid-client"

import {createMentraAuth} from "../packages/auth/src/index"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {MiniappRegistryArchiveRuleModel, MiniappRegistryEntryModel} from "../packages/core/src/models/miniapp-registry.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WebsiteClientModel} from "../packages/core/src/models/website-client.model"
import {WorkspaceAssignedPackagesModel} from "../packages/core/src/models/workspace-assigned-packages.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {oidcBridge, stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {verifyCoreAccessToken} from "../packages/core/src/services/oidc/core-access-token"
import {ensureOidcCollections, listGrants} from "../packages/core/src/services/oidc/mongo-adapter"
import {
  createWebsiteClient,
  deleteWebsiteClient,
  regenerateWebsiteClientSecret,
  registerOwnWebsite,
  updateWebsiteClient,
  type WebsiteClientView,
} from "../packages/core/src/services/oidc/website-clients.service"
import * as miniappTokens from "../packages/core/src/services/miniapp-token.service"
import {revokeAllSessionsForUser} from "../packages/core/src/services/session.service"
import {archive, unarchive} from "../packages/core/src/services/registry/registry.service"
import {principalFromToken} from "../packages/core/src/services/signin/principal.service"
import {replaceAssignedPackages} from "../packages/core/src/services/workspaces/assigned-packages.service"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {Browser, CLI_CALLBACK, coreKeyEnv, OIDC_ISSUER, providerEnv, routeOriginsToApp, signedInPerson} from "./support/oidc-harness"
import {applyEnv} from "./support/signin-harness"

setDefaultTimeout(30_000)

const CORE_ORIGIN = "https://core.test"
const PAPERWORK = "com.mentra.paperwork"
const NOTES = "com.mentra.notes"
const CALLBACK = "https://paperwork.test/auth/callback"

const databaseUrl = localTestMongoUrl("miniapp-website")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}

beforeAll(async () => {
  restoreEnv = applyEnv({
    ...coreKeyEnv(),
    ...providerEnv(),
    CLOUD_CORE_SUPABASE_ISSUER: "https://signin.supabase.co/auth/v1",
    CLOUD_CORE_OIDC_PROVIDERS: undefined,
    CLOUD_CORE_ENABLED_FEATURES: undefined,
    REFRESH_TOKEN_PEPPER: "miniapp-website-pepper",
  })
  resetCoreKeyCaches()
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([
    UserModel.syncIndexes(),
    SigninIdentityModel.syncIndexes(),
    AuthRateLimitModel.syncIndexes(),
    AdminActionAuditLogModel.syncIndexes(),
    WebsiteClientModel.syncIndexes(),
    MiniappRegistryEntryModel.syncIndexes(),
    MiniappRegistryArchiveRuleModel.syncIndexes(),
    WorkspaceModel.syncIndexes(),
    WorkspaceMembershipModel.syncIndexes(),
    WorkspaceAssignedPackagesModel.syncIndexes(),
    ensureOidcCollections(),
  ])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
  restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER, CORE_ORIGIN])
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

// Every request here comes from one address, and the sign-in steps are limited per address and minute.
beforeEach(async () => {
  await AuthRateLimitModel.deleteMany({})
})

let counter = 0
async function person(): Promise<string> {
  counter++
  const {mentraUserId} = await signedInPerson({
    subject: `supa-web-${counter}`,
    email: `web${counter}@example.com`,
    emailVerified: true,
    name: `Web Person ${counter}`,
  })
  return mentraUserId
}

/** An active workspace that assigned `packageNames`, with these people in these roles. */
async function workspace(workspaceId: string, packageNames: string[], members: Array<[mentraUserId: string, role: string]>) {
  await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
  for (const [mentraUserId, role] of members) {
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: `wm_web_${counter++}`, workspaceId, mentraUserId, role, status: "active", startedAt: new Date()}),
    )
  }
  if (packageNames.length) await replaceAssignedPackages(workspaceId, {packageNames, revision: 1})
}

interface Site {
  client: WebsiteClientView
  secret: string | null
  redirectUri: string
}

async function register(overrides: Record<string, unknown> = {}): Promise<Site> {
  const created = await createWebsiteClient(
    {
      name: "Paperwork",
      type: "server",
      environment: "production",
      redirectUris: [CALLBACK],
      packageName: PAPERWORK,
      access: "public",
      ...overrides,
    },
    "mu_admin",
  )
  return {...created, redirectUri: created.client.redirectUris[0]!}
}

function rp(site: Site, secret = site.secret): Promise<client.Configuration> {
  return client.discovery(
    new URL(OIDC_ISSUER),
    site.client.clientId,
    secret ? {client_secret: secret, id_token_signed_response_alg: "EdDSA"} : {id_token_signed_response_alg: "EdDSA"},
    secret ? client.ClientSecretPost(secret) : client.None(),
    // A development client redirects to this computer over plain HTTP.
    {execute: [client.allowInsecureRequests]},
  )
}

/** Sign the person in at the provider, as the sign-in page's hand-off does, and return its continuation. */
async function finishLogin(interactionUrl: URL, accountId: string): Promise<URL> {
  const bridge = await oidcBridge()
  const uid = interactionUrl.pathname.split("/")[2]!
  const interaction = await bridge!.provider.Interaction.find(uid)
  interaction!.result = {login: {accountId}}
  await interaction!.save(interaction!.exp - Math.floor(Date.now() / 1000))
  return new URL(interaction!.returnTo, OIDC_ISSUER)
}

/** What the consent screen is given to show. */
interface ConsentShown {
  prompt: string
  client: {name: string; packageName: string | null}
  redirectUri: string
  scopes: string[]
}

type Outcome =
  | {kind: "code"; callback: URL; consented: boolean; shown: ConsentShown | null; browser: Browser}
  | {kind: "denied"; callback: URL; browser: Browser}
  | {kind: "page"; status: number; browser: Browser}

/**
 * The site's authorization request in a browser. The person signs in when asked. At the consent screen
 * (`/consent?interaction=…` on the sign-in site) they choose `decision`, through the same endpoint the page
 * posts to.
 */
async function authorize(
  site: Site,
  mentraUserId: string,
  opts: {decision?: "allow" | "deny"; browser?: Browser; redirectUri?: string; scope?: string; verifier?: string; state?: string; nonce?: string} = {},
): Promise<Outcome & {verifier: string; state: string; nonce: string; config: client.Configuration}> {
  const config = await rp(site)
  const verifier = opts.verifier ?? client.randomPKCECodeVerifier()
  const state = opts.state ?? client.randomState()
  const nonce = opts.nonce ?? client.randomNonce()
  const redirectUri = opts.redirectUri ?? site.redirectUri
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: opts.scope ?? "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  })
  const browser = opts.browser ?? new Browser(app)
  const flow = {verifier, state, nonce, config}
  const atSite = (location: URL) => location.href.startsWith(redirectUri)
  const atStep = (location: URL) =>
    atSite(location) || location.pathname === "/consent" || location.pathname === "/login" || location.pathname.startsWith("/interaction/")
  let consented = false
  let shown: ConsentShown | null = null
  let step = await browser.follow(url.href, atStep)
  for (let hops = 0; hops < 6; hops++) {
    if (!("stoppedAt" in step)) return {kind: "page", status: step.page.status, browser, ...flow}
    const at = step.stoppedAt
    if (atSite(at)) {
      return at.searchParams.get("error")
        ? {kind: "denied", callback: at, browser, ...flow}
        : {kind: "code", callback: at, consented, shown, browser, ...flow}
    }
    if (at.pathname === "/login") {
      // The sign-in page: the person signs in, and the page's hand-off finishes the provider's login step.
      const uid = at.searchParams.get("interaction")!
      step = await browser.follow((await finishLogin(new URL(`/interaction/${uid}`, OIDC_ISSUER), mentraUserId)).href, atStep)
    } else if (at.pathname === "/consent") {
      consented = true
      const uid = at.searchParams.get("interaction")!
      const details = await browser.request(`${OIDC_ISSUER}/interaction/${uid}/details`)
      expect(details.status).toBe(200)
      shown = (await details.json()) as ConsentShown
      const decided = await browser.request(`${OIDC_ISSUER}/interaction/${uid}/consent`, {
        method: "POST",
        headers: {"content-type": "application/json", "origin": OIDC_ISSUER},
        body: JSON.stringify({decision: opts.decision ?? "allow"}),
      })
      expect(decided.status).toBe(200)
      step = await browser.follow(((await decided.json()) as {redirectTo: string}).redirectTo, atStep)
    } else {
      step = await browser.follow(at.href, location => atStep(location) && location.href !== at.href)
    }
  }
  throw new Error("the sign-in did not settle")
}

async function signIn(site: Site, mentraUserId: string, browser?: Browser) {
  const flow = await authorize(site, mentraUserId, {browser})
  if (flow.kind !== "code") throw new Error(`no code: ${flow.kind}`)
  const tokens = await client.authorizationCodeGrant(flow.config, flow.callback, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  })
  return {tokens, flow}
}

async function miniappClaims(token: string, packageName: string): Promise<jose.JWTPayload> {
  const pem = `-----BEGIN PUBLIC KEY-----\n${process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  const {payload, protectedHeader} = await jose.jwtVerify(token, await jose.importSPKI(pem, "EdDSA"), {
    issuer: "cloud-core",
    audience: packageName,
  })
  expect(protectedHeader.kid).toBe("mentra-miniapp-1")
  return payload
}

describe("W01: a website signs a person in after consent and receives the package's miniapp token", () => {
  test("a server-type site", async () => {
    const admin = await person()
    await workspace("ws_fleet", [PAPERWORK], [[admin, "admin"]])
    const site = await register()
    expect(site.secret).toMatch(/^mws_/)
    expect(site.client.clientId).toMatch(/^mwc_/)

    const {tokens, flow} = await signIn(site, admin)
    // A website is never first-party: the person was asked.
    expect(flow.kind === "code" && flow.consented).toBe(true)
    expect(tokens.claims()).toMatchObject({sub: admin, aud: site.client.clientId, iss: OIDC_ISSUER, email_verified: true})
    expect(tokens.token_type.toLowerCase()).toBe("bearer")
    expect(tokens.expires_in).toBe(300)
    expect(tokens.refresh_token).toBeString()

    const claims = await miniappClaims(tokens.access_token, PAPERWORK)
    expect(claims).toMatchObject({
      sub: admin,
      aud: PAPERWORK,
      tenantId: "mentra",
      client_id: site.client.clientId,
      // The person's workspace assigned the package: the token names it and their role, as the phone's does.
      workspaceId: "ws_fleet",
      workspaceRole: "admin",
    })
    expect(claims.exp! - claims.iat!).toBe(300)
    expect("localBuild" in claims).toBe(false)
  })

  test("a browser-type site, with no secret", async () => {
    const who = await person()
    const site = await register({type: "browser", redirectUris: ["https://paperwork.test/spa/callback"]})
    expect(site.secret).toBeNull()
    const {tokens} = await signIn(site, who)
    const claims = await miniappClaims(tokens.access_token, PAPERWORK)
    expect(claims).toMatchObject({sub: who, aud: PAPERWORK, client_id: site.client.clientId})
    // No workspace of theirs assigned the package: the token names none.
    expect("workspaceId" in claims).toBe(false)
    expect("workspaceRole" in claims).toBe(false)
  })

  test("a development client redirects to this computer, on its fixed port only", async () => {
    const who = await person()
    const site = await register({environment: "development", type: "browser", redirectUris: ["http://127.0.0.1:5173/callback"]})
    const {tokens} = await signIn(site, who)
    expect((await miniappClaims(tokens.access_token, PAPERWORK)).sub).toBe(who)
    // Another port is another address: the provider alone would ignore the port of a loopback redirect.
    const elsewhere = await authorize(site, who, {redirectUri: "http://127.0.0.1:5174/callback"})
    expect(elsewhere).toMatchObject({kind: "page", status: 400})
  })
})

describe("W02: consent", () => {
  test("the consent screen is told the site's name, where it sends the person back, what it asks for and whose data it reaches", async () => {
    const who = await person()
    const site = await register({name: "Paperwork"})
    const flow = await authorize(site, who)
    expect(flow.kind === "code" && flow.shown).toEqual({
      prompt: "consent",
      client: {name: "Paperwork", packageName: PAPERWORK},
      redirectUri: CALLBACK,
      scopes: ["openid", "email", "profile"],
    })
  })

  test("Deny issues no code; Allow is remembered for the next sign-in, in any browser", async () => {
    const who = await person()
    const site = await register()
    const browser = new Browser(app)

    const denied = await authorize(site, who, {decision: "deny", browser})
    expect(denied.kind).toBe("denied")
    if (denied.kind === "denied") {
      expect(denied.callback.searchParams.get("error")).toBe("access_denied")
      expect(denied.callback.searchParams.get("code")).toBeNull()
    }

    // The same browser, still signed in to the sign-in server: asked again, since nothing was granted.
    const first = await authorize(site, who, {browser})
    expect(first).toMatchObject({kind: "code", consented: true})
    const second = await authorize(site, who, {browser})
    expect(second).toMatchObject({kind: "code", consented: false})
    // Another browser, signing in afresh: consent is the person's, not the browser's.
    const elsewhere = await authorize(site, who)
    expect(elsewhere).toMatchObject({kind: "code", consented: false})

    // It is theirs alone, and for that website alone.
    expect(await authorize(site, await person())).toMatchObject({kind: "code", consented: true})
    expect(await authorize(await register({redirectUris: ["https://other.test/cb"]}), who)).toMatchObject({kind: "code", consented: true})
  })

  test("a site that asks for more than was allowed is asked about again", async () => {
    const who = await person()
    const site = await register()
    const narrow = await authorize(site, who, {scope: "openid"})
    expect(narrow).toMatchObject({kind: "code", consented: true})
    expect(await authorize(site, who, {scope: "openid"})).toMatchObject({kind: "code", consented: false})
    expect(await authorize(site, who, {scope: "openid email profile"})).toMatchObject({kind: "code", consented: true})
  })
})

describe("Connected apps", () => {
  const connections = (browser: Browser) => browser.request(`${OIDC_ISSUER}/oidc/connections`)
  const revoke = (browser: Browser, clientId: unknown, headers: Record<string, string> = {origin: OIDC_ISSUER}) =>
    browser.request(`${OIDC_ISSUER}/oidc/connections/revoke`, {
      method: "POST",
      headers: {"content-type": "application/json", ...headers},
      body: JSON.stringify({clientId}),
    })

  test("lists the websites a person allowed, once each, and never a first-party client", async () => {
    const who = await person()
    const paperwork = await register({name: "Paperwork"})
    const notes = await register({name: "Notes", packageName: NOTES, redirectUris: ["https://notes.test/cb"]})
    const browser = new Browser(app)
    const before = Date.now()
    await signIn(paperwork, who, browser)
    await signIn(paperwork, who, browser)
    await authorize(notes, who, {browser, scope: "openid"})
    // A first-party sign-in in the same browser: granted without a screen, and not a connected app.
    const cli = await client.discovery(new URL(OIDC_ISSUER), "mentra-cli", {id_token_signed_response_alg: "EdDSA"}, client.None())
    const verifier = client.randomPKCECodeVerifier()
    const firstParty = await browser.follow(
      client.buildAuthorizationUrl(cli, {
        redirect_uri: CLI_CALLBACK,
        scope: "openid email",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state: client.randomState(),
      }).href,
      location => location.href.startsWith(CLI_CALLBACK),
    )
    expect("stoppedAt" in firstParty).toBe(true)

    const listed = await connections(browser)
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    const body = (await listed.json()) as {connections: Array<{clientId: string; name: string; scopes: string[]; grantedAt: string}>}
    expect(body.connections.map(entry => [entry.clientId, entry.name, entry.scopes])).toEqual([
      [paperwork.client.clientId, "Paperwork", ["openid", "email", "profile"]],
      [notes.client.clientId, "Notes", ["openid"]],
    ])
    for (const entry of body.connections) {
      expect(Date.parse(entry.grantedAt)).toBeGreaterThanOrEqual(before - 1000)
      expect(Date.parse(entry.grantedAt)).toBeLessThanOrEqual(Date.now() + 1000)
    }
    // Another person, in another browser, sees none of it.
    const other = new Browser(app)
    await signIn(await register({redirectUris: ["https://third.test/cb"]}), await person(), other)
    const theirs = (await (await connections(other)).json()) as {connections: Array<{clientId: string}>}
    expect(theirs.connections.map(entry => entry.clientId)).not.toContain(paperwork.client.clientId)
  })

  test("Revoke ends the site's refresh tokens at once, and its next sign-in asks again", async () => {
    const who = await person()
    const site = await register()
    const kept = await register({redirectUris: ["https://kept.test/cb"]})
    const browser = new Browser(app)
    const laptop = await signIn(site, who, browser)
    const phone = await signIn(site, who)
    const other = await signIn(kept, who, browser)

    const revoked = await revoke(browser, site.client.clientId)
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({revoked: true})

    // Every sign-in to that site ends, in this browser and any other.
    await expect(client.refreshTokenGrant(laptop.flow.config, laptop.tokens.refresh_token!)).rejects.toThrow()
    await expect(client.refreshTokenGrant(phone.flow.config, phone.tokens.refresh_token!)).rejects.toThrow()
    // The other site is untouched.
    expect((await client.refreshTokenGrant(other.flow.config, other.tokens.refresh_token!)).access_token).toBeString()

    const listed = (await (await connections(browser)).json()) as {connections: Array<{clientId: string}>}
    expect(listed.connections.map(entry => entry.clientId)).toEqual([kept.client.clientId])
    expect(await authorize(site, who, {browser})).toMatchObject({kind: "code", consented: true})
  })

  test("only the signed-in person, from the sign-in site itself", async () => {
    const who = await person()
    const site = await register()
    const browser = new Browser(app)
    const signedIn = await signIn(site, who, browser)

    // No session: nothing is listed and nothing revoked.
    const stranger = new Browser(app)
    expect((await connections(stranger)).status).toBe(401)
    expect((await revoke(stranger, site.client.clientId)).status).toBe(401)
    // Another site's page cannot revoke for the person, with or without their cookies.
    expect((await revoke(browser, site.client.clientId, {origin: "https://evil.test"})).status).toBe(403)
    expect((await revoke(browser, site.client.clientId, {})).status).toBe(403)
    // Only a website can be named.
    expect((await revoke(browser, "mentra-cli")).status).toBe(400)
    expect((await revoke(browser, {$ne: null})).status).toBe(400)
    // A website the person never allowed answers the same as one they did.
    expect(await (await revoke(browser, (await register({redirectUris: ["https://never.test/cb"]})).client.clientId)).json()).toEqual({revoked: true})

    expect((await client.refreshTokenGrant(signedIn.flow.config, signedIn.tokens.refresh_token!)).access_token).toBeString()
  })

  test("the page signs a person in through the sign-in site's own client, whose tokens open nothing", async () => {
    const who = await person()
    const browser = new Browser(app)
    expect((await connections(browser)).status).toBe(401)

    const atPage = (location: URL) => location.origin === OIDC_ISSUER && location.pathname === "/connections"
    const atStep = (location: URL) => atPage(location) || location.pathname === "/login" || location.pathname === "/consent"
    const start = await browser.follow(`${OIDC_ISSUER}/oidc/connections/sign-in`, atStep)
    if (!("stoppedAt" in start)) throw new Error("the sign-in did not start")
    expect(start.stoppedAt.pathname).toBe("/login")
    const uid = start.stoppedAt.searchParams.get("interaction")!
    // First-party: straight back to the page after sign-in, with no consent screen.
    const back = await browser.follow((await finishLogin(new URL(`/interaction/${uid}`, OIDC_ISSUER), who)).href, atStep)
    if (!("stoppedAt" in back)) throw new Error("the sign-in did not return")
    expect(atPage(back.stoppedAt)).toBe(true)
    expect(back.stoppedAt.searchParams.get("code")).toBeString()
    expect((await connections(browser)).status).toBe(200)

    // The page drops that code. Someone who runs the flow themselves and redeems theirs gets nothing usable.
    const account = await client.discovery(new URL(OIDC_ISSUER), "mentra-account", {id_token_signed_response_alg: "EdDSA"}, client.None())
    const verifier = client.randomPKCECodeVerifier()
    const own = await browser.follow(
      client.buildAuthorizationUrl(account, {
        redirect_uri: `${OIDC_ISSUER}/connections`,
        scope: "openid email profile",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state: "s",
      }).href,
      atStep,
    )
    if (!("stoppedAt" in own)) throw new Error("no code")
    const tokens = await client.authorizationCodeGrant(account, own.stoppedAt, {pkceCodeVerifier: verifier, expectedState: "s", idTokenExpected: true})
    expect(tokens.refresh_token).toBeUndefined()
    expect(await verifyCoreAccessToken(tokens.access_token)).toBeNull()
    expect(await verifyCoreAccessToken(tokens.access_token, {website: true})).toBeNull()
    expect(await principalFromToken(tokens.access_token)).toBeNull()
    // It redirects nowhere but the page.
    const elsewhere = await browser.follow(
      client.buildAuthorizationUrl(account, {redirect_uri: "https://evil.test/connections", scope: "openid", code_challenge: "x".repeat(43), code_challenge_method: "S256"}).href,
      () => true,
    )
    expect("page" in elsewhere && elsewhere.page.status).toBe(400)
  })
})

describe("the site's tokens", () => {
  test("refresh rotates and returns a fresh miniapp token; a spent refresh token ends the grant", async () => {
    const who = await person()
    const site = await register()
    const {tokens, flow} = await signIn(site, who)

    const refreshed = await client.refreshTokenGrant(flow.config, tokens.refresh_token!)
    expect(refreshed.refresh_token).toBeString()
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
    expect(refreshed.expires_in).toBe(300)
    const claims = await miniappClaims(refreshed.access_token, PAPERWORK)
    expect(claims).toMatchObject({sub: who, client_id: site.client.clientId})
    expect(claims.jti).not.toBe((await miniappClaims(tokens.access_token, PAPERWORK)).jti)

    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toThrow()
    // Reuse is treated as theft: the rotated token dies with the grant.
    await expect(client.refreshTokenGrant(flow.config, refreshed.refresh_token!)).rejects.toThrow()
  })

  test("W07: @mentra/auth verifies it as it does the phone's, and names the website", async () => {
    const who = await person()
    const site = await register()
    const {tokens} = await signIn(site, who)
    const verifiedByBackend = await createMentraAuth({
      packageName: PAPERWORK,
      jwksUrl: `${CORE_ORIGIN}/.well-known/jwks.json`,
      issuer: "cloud-core",
    }).verifyToken(tokens.access_token)
    expect(verifiedByBackend).toMatchObject({mentraUserId: who, packageName: PAPERWORK, clientId: site.client.clientId, localBuild: false})
    // Another package's backend refuses it.
    await expect(
      createMentraAuth({packageName: NOTES, jwksUrl: `${CORE_ORIGIN}/.well-known/jwks.json`, issuer: "cloud-core"}).verifyToken(tokens.access_token),
    ).rejects.toThrow()
  })

  test("W06: nothing the site holds opens Core's own routes", async () => {
    const who = await person()
    const site = await register()
    const {tokens} = await signIn(site, who)
    for (const token of [tokens.access_token, tokens.id_token!, tokens.refresh_token!]) {
      expect(await verifyCoreAccessToken(token)).toBeNull()
      expect(await principalFromToken(token)).toBeNull()
      expect((await fetch(`${OIDC_ISSUER}/oidc/me`, {headers: {Authorization: `Bearer ${token}`}})).status).toBe(401)
      for (const path of ["/api/workspaces", "/api/cli/workspaces", "/api/admin/me", "/api/account/me"]) {
        const response = await fetch(`${CORE_ORIGIN}${path}`, {headers: {Authorization: `Bearer ${token}`}})
        // Each route refuses in its own way (the phone's routes answer 400 invalid_grant); none answers.
        expect([path, [400, 401, 403, 404].includes(response.status)]).toEqual([path, true])
      }
    }
    // The access token is the miniapp token and nothing else: not the provider's token for Core's API.
    expect(jose.decodeJwt(tokens.access_token).aud).toBe(PAPERWORK)
    expect(jose.decodeProtectedHeader(tokens.access_token).typ).not.toBe("at+jwt")
  })
})

describe("a developer's own website", () => {
  const EXAMPLE = "com.example.notes"
  async function seedRegistry(overrides: Record<string, unknown> = {}) {
    const at = new Date()
    await MiniappRegistryEntryModel.create({
      url: `https://notes${++counter}.example.com/`,
      packageName: EXAMPLE,
      registrableDomain: "example.com",
      name: "Example Notes",
      version: "1.0.0",
      ageRating: "4+",
      iconUrl: null,
      verification: "verified",
      manifest: "{}",
      private: false,
      status: "active",
      firstRegisteredAt: at,
      firstRegisteredBy: "mu_someone",
      lastVerifiedAt: at,
      lastVerifyAttemptAt: at,
      lastSeenVersion: "1.0.0",
      ...overrides,
    })
  }

  test("signs anyone in on the package's own domain, under the miniapp's verified name", async () => {
    await MiniappRegistryEntryModel.deleteMany({packageName: EXAMPLE})
    await seedRegistry()
    const developer = await person()
    const visitor = await person()
    const created = await registerOwnWebsite(
      {mentraUserId: developer, label: "dev@example.com"},
      {packageName: EXAMPLE, type: "server", environment: "production", redirectUris: ["https://app.example.com/auth/callback"]},
    )
    const site: Site = {...created, redirectUri: created.client.redirectUris[0]!}
    expect(site.client).toMatchObject({name: "Example Notes", ownerUserId: developer, access: "public"})

    const flow = await authorize(site, visitor)
    expect(flow.kind === "code" && flow.shown).toMatchObject({client: {name: "Example Notes", packageName: EXAMPLE}, redirectUri: "https://app.example.com/auth/callback"})
    const {tokens} = await signIn(site, visitor)
    expect(await miniappClaims(tokens.access_token, EXAMPLE)).toMatchObject({sub: visitor, aud: EXAMPLE, client_id: site.client.clientId})
  })

  test("a development client signs in its developer on their own computer, and nobody else", async () => {
    await MiniappRegistryEntryModel.deleteMany({packageName: EXAMPLE})
    await seedRegistry()
    const developer = await person()
    const someoneElse = await person()
    const created = await registerOwnWebsite(
      {mentraUserId: developer, label: "dev@example.com"},
      {packageName: EXAMPLE, type: "browser", environment: "development", redirectUris: ["http://127.0.0.1:5173/callback"]},
    )
    const site: Site = {...created, redirectUri: created.client.redirectUris[0]!}
    expect(site.client.name).toBe("Example Notes (development)")

    const mine = await signIn(site, developer)
    expect((await miniappClaims(mine.tokens.access_token, EXAMPLE)).sub).toBe(developer)

    const flow = await authorize(site, someoneElse)
    if (flow.kind !== "code") throw new Error("no code")
    await expect(
      client.authorizationCodeGrant(flow.config, flow.callback, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      }),
    ).rejects.toMatchObject({error: "access_denied"})
  })

  test("archiving the miniapp stops its websites: no new token, and no refresh", async () => {
    await MiniappRegistryEntryModel.deleteMany({packageName: EXAMPLE})
    await seedRegistry()
    const developer = await person()
    const visitor = await person()
    const created = await registerOwnWebsite(
      {mentraUserId: developer, label: "dev@example.com"},
      {packageName: EXAMPLE, type: "server", environment: "production", redirectUris: ["https://app.example.com/cb"]},
    )
    const site: Site = {...created, redirectUri: created.client.redirectUris[0]!}
    const {tokens, flow} = await signIn(site, visitor)

    await archive({kind: "package", value: EXAMPLE}, {reason: "test", createdBy: "admin@mentra.glass"})
    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toMatchObject({error: "access_denied"})
    const again = await authorize(site, visitor)
    if (again.kind !== "code") throw new Error("no code")
    await expect(
      client.authorizationCodeGrant(again.config, again.callback, {
        pkceCodeVerifier: again.verifier,
        expectedState: again.state,
        expectedNonce: again.nonce,
        idTokenExpected: true,
      }),
    ).rejects.toMatchObject({error: "access_denied"})

    // Unarchived, the site works again without anyone registering anything.
    await unarchive({kind: "package", value: EXAMPLE})
    expect((await signIn(site, visitor)).tokens.access_token).toBeString()
  })
})

describe("W08: revocation", () => {
  test("logging out everywhere ends every site's refresh at once, and the next sign-in asks for credentials and consent again", async () => {
    const who = await person()
    const site = await register()
    const browser = new Browser(app)
    const {tokens, flow} = await signIn(site, who, browser)
    // A sign-in is "from before" a revocation by its whole second.
    await Bun.sleep(1100)

    await revokeAllSessionsForUser({mentraUserId: who})
    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toThrow()
    // The miniapp token already issued lives out its five minutes and no longer.
    const claims = await miniappClaims(tokens.access_token, PAPERWORK)
    expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300)

    expect((await browser.request(`${OIDC_ISSUER}/oidc/connections`)).status).toBe(401)
    // A new sign-in, a second later (one in the revocation's own second counts as before it), consents again.
    await Bun.sleep(1100)
    expect(await authorize(site, who, {browser})).toMatchObject({kind: "code", consented: true})
  })

  test("a removed website can neither sign anyone in nor refresh", async () => {
    const who = await person()
    const site = await register()
    const {tokens, flow} = await signIn(site, who)
    await deleteWebsiteClient(site.client.clientId, "mu_admin")
    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toThrow()
    expect(await authorize(site, who)).toMatchObject({kind: "page", status: 400})
  })

  test("a site that signs the person out revokes its own refresh token, and no other site's", async () => {
    const who = await person()
    const site = await register()
    const other = await register({redirectUris: ["https://other.test/cb"]})
    const mine = await signIn(site, who)
    const theirs = await signIn(other, who)
    // Another site cannot revoke this one's token, whatever it presents.
    await client.tokenRevocation(theirs.flow.config, mine.tokens.refresh_token!).catch(() => {})
    const stillGood = await client.refreshTokenGrant(mine.flow.config, mine.tokens.refresh_token!)
    await client.tokenRevocation(mine.flow.config, stillGood.refresh_token!)
    await expect(client.refreshTokenGrant(mine.flow.config, stillGood.refresh_token!)).rejects.toThrow()
    expect((await client.refreshTokenGrant(theirs.flow.config, theirs.tokens.refresh_token!)).access_token).toBeString()
  })

  test("signing out of a site is not taking consent back: the next sign-in shows no screen, until Revoke", async () => {
    const who = await person()
    const site = await register()
    const browser = new Browser(app)
    const first = await signIn(site, who, browser)
    expect(first.flow.kind === "code" && first.flow.consented).toBe(true)
    // The site's Sign out: it revokes its refresh token, the only one this person has for it.
    await client.tokenRevocation(first.flow.config, first.tokens.refresh_token!)
    await expect(client.refreshTokenGrant(first.flow.config, first.tokens.refresh_token!)).rejects.toThrow()
    // What they allowed is still on record, and still listed under Connected apps.
    expect((await listGrants(who, site.client.clientId)).length).toBe(1)
    const listed = (await (await browser.request(`${OIDC_ISSUER}/oidc/connections`)).json()) as {connections: Array<{clientId: string}>}
    expect(listed.connections.map(connection => connection.clientId)).toEqual([site.client.clientId])

    // Signing in again, in that browser or a new one, asks nothing.
    const again = await signIn(site, who, browser)
    expect(again.flow.kind === "code" && again.flow.consented).toBe(false)
    const elsewhere = await signIn(site, who)
    expect(elsewhere.flow.kind === "code" && elsewhere.flow.consented).toBe(false)
    // The first browser signed in again on the grant it already had: two browsers, two grants, one entry.
    expect((await listGrants(who, site.client.clientId)).length).toBe(2)
    // Signing out of one of two ends that one's tokens and nobody else's.
    await client.tokenRevocation(again.flow.config, again.tokens.refresh_token!)
    await expect(client.refreshTokenGrant(again.flow.config, again.tokens.refresh_token!)).rejects.toThrow()
    expect((await client.refreshTokenGrant(elsewhere.flow.config, elsewhere.tokens.refresh_token!)).access_token).toBeString()
    const still = (await (await browser.request(`${OIDC_ISSUER}/oidc/connections`)).json()) as {connections: Array<{clientId: string}>}
    expect(still.connections.map(connection => connection.clientId)).toEqual([site.client.clientId])

    // Revoke under Connected apps is what takes it back: every sign-in ends and the next one asks.
    const revoked = await browser.request(`${OIDC_ISSUER}/oidc/connections/revoke`, {
      method: "POST",
      headers: {"content-type": "application/json", "origin": OIDC_ISSUER},
      body: JSON.stringify({clientId: site.client.clientId}),
    })
    expect(await revoked.json()).toEqual({revoked: true})
    expect((await listGrants(who, site.client.clientId)).length).toBe(0)
    const after = await signIn(site, who, browser)
    expect(after.flow.kind === "code" && after.flow.consented).toBe(true)
  })

  test("two browsers signing out of a site at the same moment leave the consent on record", async () => {
    const who = await person()
    const site = await register()
    for (let round = 0; round < 3; round++) {
      const one = await signIn(site, who)
      const two = await signIn(site, who)
      expect(two.flow.kind === "code" && two.flow.consented).toBe(false)
      await Promise.all([
        client.tokenRevocation(one.flow.config, one.tokens.refresh_token!),
        client.tokenRevocation(two.flow.config, two.tokens.refresh_token!),
      ])
      await expect(client.refreshTokenGrant(one.flow.config, one.tokens.refresh_token!)).rejects.toThrow()
      await expect(client.refreshTokenGrant(two.flow.config, two.tokens.refresh_token!)).rejects.toThrow()
      // Asked once, in the first round, and never again.
      const next = await authorize(site, who)
      expect(next).toMatchObject({kind: "code", consented: false})
    }
  })

  test("a replayed refresh token still ends its sign-in, grant and all", async () => {
    const who = await person()
    const site = await register()
    const {tokens, flow} = await signIn(site, who)
    const next = await client.refreshTokenGrant(flow.config, tokens.refresh_token!)
    // The spent token, presented again: the provider ends that sign-in's grant, with the token it issued since.
    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toThrow()
    await expect(client.refreshTokenGrant(flow.config, next.refresh_token!)).rejects.toThrow()
    expect((await listGrants(who, site.client.clientId)).length).toBe(0)
  })
})

describe("W04: clients come only from registration", () => {
  test("dynamic client registration is refused", async () => {
    const response = await fetch(`${OIDC_ISSUER}/oidc/reg`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({redirect_uris: ["https://evil.test/cb"], client_name: "Mentra"}),
    })
    expect(response.status).toBe(404)
    const discovery = (await (await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`)).json()) as Record<string, unknown>
    expect(discovery.registration_endpoint).toBeUndefined()
  })
})

describe("a browser-type site calls the token endpoint from its own page", () => {
  const ORIGIN = "https://paperwork.test"

  async function exchange(site: Site, flow: {callback: URL; verifier: string}, origin: string) {
    return fetch(`${OIDC_ISSUER}/oidc/token`, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", origin},
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: site.client.clientId,
        code: flow.callback.searchParams.get("code")!,
        code_verifier: flow.verifier,
        redirect_uri: site.redirectUri,
      }),
    })
  }

  test("the rewritten answer keeps the provider's CORS headers, so the page can read its tokens", async () => {
    const who = await person()
    const site = await register({type: "browser", redirectUris: [`${ORIGIN}/spa/callback`]})

    // The browser asks first.
    const preflight = await fetch(`${OIDC_ISSUER}/oidc/token`, {
      method: "OPTIONS",
      headers: {origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type"},
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST")

    const flow = await authorize(site, who)
    if (flow.kind !== "code") throw new Error("no code")
    const response = await exchange(site, flow, ORIGIN)
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("cache-control")).toBe("no-store")
    const tokens = (await response.json()) as {access_token: string; refresh_token: string}
    expect((await miniappClaims(tokens.access_token, PAPERWORK)).sub).toBe(who)

    // And so does a refresh, and a refusal the page has to be able to read.
    const refreshed = await fetch(`${OIDC_ISSUER}/oidc/token`, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", origin: ORIGIN},
      body: new URLSearchParams({grant_type: "refresh_token", client_id: site.client.clientId, refresh_token: tokens.refresh_token}),
    })
    expect([refreshed.status, refreshed.headers.get("access-control-allow-origin")]).toEqual([200, ORIGIN])
  })

  test("a refusal keeps them too; another origin is given none", async () => {
    const outsider = await person()
    await workspace("ws_cors_private", [], [])
    const site = await register({type: "browser", redirectUris: [`${ORIGIN}/spa/callback`], access: "private", accessWorkspaceIds: ["ws_cors_private"]})
    const refusedFlow = await authorize(site, outsider)
    if (refusedFlow.kind !== "code") throw new Error("no code")
    const refused = await exchange(site, refusedFlow, ORIGIN)
    expect([refused.status, refused.headers.get("access-control-allow-origin")]).toEqual([400, ORIGIN])
    expect(await refused.json()).toMatchObject({error: "access_denied"})

    // A page on another origin gets no permission to read the answer, whatever it sends.
    const open = await register({type: "browser", redirectUris: [`${ORIGIN}/spa/callback2`]})
    const flow = await authorize(open, await person())
    if (flow.kind !== "code") throw new Error("no code")
    const elsewhere = await exchange(open, flow, "https://evil.test")
    expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("when the miniapp token can't be minted just now", () => {
  const mocks: Array<{mockRestore(): void}> = []
  afterEach(() => {
    for (const mock of mocks.splice(0)) mock.mockRestore()
  })
  /** The next `times` mints fail the way a lookup past its deadline does. */
  function failMinting(times: number) {
    const real = miniappTokens.mintMiniappTokenFor
    let left = times
    mocks.push(
      spyOn(miniappTokens, "mintMiniappTokenFor").mockImplementation(async args => {
        if (left-- > 0) throw new miniappTokens.MiniappTokenUnavailableError("workspace_unavailable")
        return real(args)
      }),
    )
  }
  const refreshTokensOf = async (clientId: string) =>
    UserModel.db.collection("oidc_refresh_token").countDocuments({"payload.clientId": clientId, consumedAt: {$exists: false}})

  test("a refresh answers 503 and leaves the site's refresh token working: its retry succeeds", async () => {
    const who = await person()
    const site = await register()
    const {tokens, flow} = await signIn(site, who)
    failMinting(2)

    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await client.refreshTokenGrant(flow.config, tokens.refresh_token!).then(
        () => null,
        (error: unknown) => error as {cause?: Response},
      )
      expect(failed?.cause).toBeInstanceOf(Response)
      expect(failed!.cause!.status).toBe(503)
      // The token the provider issued for the answer nobody got is gone: one live refresh token, the site's.
      expect(await refreshTokensOf(site.client.clientId)).toBe(1)
    }

    const retried = await client.refreshTokenGrant(flow.config, tokens.refresh_token!)
    expect((await miniappClaims(retried.access_token, PAPERWORK)).sub).toBe(who)
    // From here on it rotates as usual: the old one is spent, and using it again ends the grant.
    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
    await expect(client.refreshTokenGrant(flow.config, retried.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
  })

  test("a code exchange answers 503 and the same code still works on the retry", async () => {
    const who = await person()
    const site = await register()
    const flow = await authorize(site, who)
    if (flow.kind !== "code") throw new Error("no code")
    const redeem = () =>
      client.authorizationCodeGrant(flow.config, flow.callback, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      })
    failMinting(1)
    const failed = await redeem().then(
      () => null,
      (error: unknown) => error as {cause?: Response},
    )
    expect(failed?.cause).toBeInstanceOf(Response)
    expect(failed!.cause!.status).toBe(503)
    expect(await refreshTokensOf(site.client.clientId)).toBe(0)

    const tokens = await redeem()
    expect((await miniappClaims(tokens.access_token, PAPERWORK)).sub).toBe(who)
    // The code is spent now.
    await expect(redeem()).rejects.toThrow()
  })
})

describe("W03: redirects and client credentials", () => {
  test("a redirect that differs in path, port, trailing slash, scheme or subdomain is refused", async () => {
    const who = await person()
    const site = await register()
    for (const redirectUri of [
      "https://paperwork.test/auth/callback/",
      "https://paperwork.test/auth/other",
      "https://paperwork.test:8443/auth/callback",
      "http://paperwork.test/auth/callback",
      "https://www.paperwork.test/auth/callback",
      "https://evil.test/auth/callback",
    ]) {
      const outcome = await authorize(site, who, {redirectUri})
      expect([redirectUri, outcome.kind, outcome.kind === "page" ? outcome.status : 0]).toEqual([redirectUri, "page", 400])
    }
  })

  test("the code is redeemed only with the site's own secret, and a regenerated secret replaces the old", async () => {
    const who = await person()
    const site = await register()
    const redeem = async (secret: string) => {
      const flow = await authorize(site, who)
      if (flow.kind !== "code") throw new Error("no code")
      return client.authorizationCodeGrant(await rp(site, secret), flow.callback, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      })
    }
    await expect(redeem("mws_not-the-secret-0123456789abcdef0123456789")).rejects.toThrow()
    // Only the hash is stored, and presenting the hash itself is not presenting the secret.
    const stored = await WebsiteClientModel.findOne({clientId: site.client.clientId}).lean()
    expect(stored!.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(site.secret!)
    await expect(redeem(stored!.secretHash!)).rejects.toThrow()

    const rotated = await regenerateWebsiteClientSecret(site.client.clientId, "mu_admin")
    await expect(redeem(site.secret!)).rejects.toThrow()
    expect((await redeem(rotated.secret)).access_token).toBeString()
  })
})

describe("W05: a disabled client and a private package", () => {
  test("a disabled website can neither sign anyone in nor refresh", async () => {
    const who = await person()
    const site = await register()
    const {tokens, flow} = await signIn(site, who)
    await updateWebsiteClient(site.client.clientId, {status: "disabled"}, "mu_admin")

    await expect(client.refreshTokenGrant(flow.config, tokens.refresh_token!)).rejects.toThrow()
    const again = await authorize(site, who)
    expect(again).toMatchObject({kind: "page", status: 400})

    await updateWebsiteClient(site.client.clientId, {status: "active"}, "mu_admin")
    expect((await signIn(site, who)).tokens.access_token).toBeString()
  })

  test("a private website admits only active members of the workspaces on its list", async () => {
    const member = await person()
    const outsider = await person()
    await workspace("ws_private", [], [[member, "member"]])
    const site = await register({access: "private", accessWorkspaceIds: ["ws_private"]})

    const admitted = await signIn(site, member)
    expect((await miniappClaims(admitted.tokens.access_token, PAPERWORK)).sub).toBe(member)

    // An outsider signs in at the sign-in server and consents, and still gets no token: the answer says why,
    // and carries nothing else.
    const flow = await authorize(site, outsider)
    expect(flow.kind).toBe("code")
    if (flow.kind === "code") {
      const refused = await client
        .authorizationCodeGrant(flow.config, flow.callback, {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        })
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(refused).toBeInstanceOf(client.ResponseBodyError)
      expect(refused).toMatchObject({error: "access_denied", status: 400})
      expect(Object.keys((refused as client.ResponseBodyError).cause as object).sort()).toEqual(["error", "error_description"])
    }

    // Membership ends: the next refresh is refused, for the same reason.
    await WorkspaceMembershipModel.updateOne({mentraUserId: member, workspaceId: "ws_private"}, {$set: {status: "ended", endedAt: new Date()}})
    await expect(client.refreshTokenGrant(admitted.flow.config, admitted.tokens.refresh_token!)).rejects.toMatchObject({error: "access_denied"})
  })
})
