/**
 * @fileoverview Internal workspace service API tests (`/api/internal/workspaces`).
 *
 * The Store and Fleet call this API with the contract's `createCoreWorkspaceClient`.
 * Most tests drive that real client with a `fetch` that hands each request to
 * the real app, so signing, verification, the routes and the response checks
 * the client makes are exercised end to end. Tests of what a client never
 * sends (a forged, stale or tampered request, a route the client has no method
 * for) sign requests by hand with the contract's `signServiceRequest`.
 *
 * People are real: a fake identity provider (`support/fake-idp.ts`) plays
 * Supabase Auth and GoTrue's admin API, so a bearer is a Supabase access token
 * Core verifies, and its email is verified only when the fake GoTrue account's
 * email is confirmed. Email lookups (`users/resolve-email`) ask a small local
 * account directory served on 127.0.0.1. Memberships, credentials and audit
 * events are real rows on a local replica set.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspaces-internal-api.integration.test.ts`
 */

import {createHash, createHmac, generateKeyPairSync} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createSession} from "../packages/core/src/services/session.service"
import {recordOrganizationEvent, recordWorkspaceEvent} from "../packages/core/src/services/workspaces/audit.service"
import {resetCoreKeyCaches} from "./support/key-caches"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {createWorkspaceCredential, revokeCredential} from "../packages/core/src/services/workspaces/credential.service"
import {
  changeRole,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  leaveWorkspace,
  removeMember,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {
  CoreWorkspaceClientError,
  createCoreWorkspaceClient,
  SERVICE_HEADERS,
  signServiceRequest,
  type CoreWorkspaceClient,
} from "../packages/workspace-contract/src/server"
import {capabilitiesForRole} from "../packages/workspace-contract/src/index"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {nextHoldAsOf} from "./support/hold-as-of"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
  coreAccessToken,
  ADMIN_EMAIL,
  applyEnv,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  RefreshTokenModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const SERVICE_SECRETS = {store: ["store-s1", "store-s0"], fleet: ["fleet-f1", "fleet-f0"]}
const BASE = "https://core.test"
const API = "/api/internal/workspaces"
/** A first-party client of Core's sign-in server, as the Developer Console's server is. */
const WEB_CLIENT = "console"
/** The contract's principal for a person: nothing of Core's own (`tenantId`, `via`). */
const USER_PRINCIPAL_KEYS = ["email", "emailVerified", "isOrganizationAdmin", "kind", "mentraUserId"]

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- Fixtures --------------------------------------------------------------

interface Person {
  /** A Core access token from Core's sign-in server, as the Store receives it. */
  bearer: string
  sub: string
  email: string
  mentraUserId: string
}

/**
 * A person with a Supabase account (confirmed email unless told otherwise), signed in through Core's
 * sign-in server, and their Core access token. Their Core user is the one the phone has: `("mentra", sub)`.
 */
async function person(key: string, options: {email?: string; emailConfirmed?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  idp.registerUser({sub, email, emailConfirmed: options.emailConfirmed ?? true})
  const bearer = await coreAccessToken({sub, email, emailVerified: options.emailConfirmed ?? true, clientId: WEB_CLIENT})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {bearer, sub, email, mentraUserId}
}

function actorOf(p: Person, isOrganizationAdmin = false): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId: p.mentraUserId, email: p.email, emailVerified: true, isOrganizationAdmin}
}

let membershipCounter = 0
async function addMember(workspaceId: string, p: Person, role: string, fields: Record<string, unknown> = {}) {
  const membershipId = `wm_test_${membershipCounter++}`
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId: p.mentraUserId,
      email: p.email,
      role,
      status: "active",
      startedAt: new Date(),
      ...fields,
    }),
  )
  return membershipId
}

/** A workspace owned by "owner", with a developer, an admin and a plain member. */
async function newWorkspace(name = "Acme") {
  const owner = await person("owner")
  const developer = await person("developer")
  const admin = await person("admin")
  const member = await person("member")
  const stranger = await person("stranger")
  const workspace = await createWorkspace(actorOf(owner), {name})
  const workspaceId = workspace.workspaceId
  await addMember(workspaceId, developer, "developer")
  await addMember(workspaceId, admin, "admin")
  await addMember(workspaceId, member, "member")
  return {workspaceId, workspace, owner, developer, admin, member, stranger}
}

/** The PEM body of a key, as Core's key variables hold it. */
const pemBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")

/**
 * Run `use` with a real phone session for `sub`: Core's own token exchange of a Supabase session token,
 * signed with a key generated for this test. Core's key caches are reset on the way in and out.
 */
async function withPhoneCoreToken<T>(sub: string, use: (token: string) => Promise<T>): Promise<T> {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519")
  const restore = applyEnv({
    MENTRA_JWT_PRIVATE_KEY: pemBody(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_JWT_PUBLIC_KEY: pemBody(publicKey.export({type: "spki", format: "pem"}).toString()),
    REFRESH_TOKEN_PEPPER: "internal-api-test-pepper",
  })
  resetCoreKeyCaches()
  try {
    // A phone's Supabase session token: no `client_id`, so it may be exchanged for a phone session.
    const subjectToken = await idp.mint({sub, aud: "authenticated", role: "authenticated"})
    const {access_token: token} = await createSession({subjectToken})
    // It is a genuine Core access token for this person.
    const {payload} = await jose.jwtVerify(token, publicKey, {issuer: "cloud-core", audience: "cloud-core"})
    expect(payload.tenant_id).toBe("mentra")
    return await use(token)
  } finally {
    restore()
    resetCoreKeyCaches()
  }
}

// --- Calling the app -------------------------------------------------------

/** The `fetch` the contract client uses: every request goes straight to the real app. */
const coreFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch

function clientFor(service: string, options: {secret?: string} = {}): CoreWorkspaceClient {
  return createCoreWorkspaceClient({
    baseUrl: BASE,
    service,
    secret: options.secret ?? "store-s1",
    fetch: coreFetch,
  })
}

const store = () => clientFor("store")
const fleet = () => clientFor("fleet", {secret: "fleet-f1"})

async function expectClientError(promise: Promise<unknown>, code: CoreWorkspaceClientError["code"], status?: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CoreWorkspaceClientError)
  expect((error as CoreWorkspaceClientError).code).toBe(code)
  if (status !== undefined) expect((error as CoreWorkspaceClientError).status).toBe(status)
  return error as CoreWorkspaceClientError
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

interface RawOptions {
  /** `x-mentra-service`; defaults to "store". */
  service?: string
  /** Signing secret; defaults to the Store's primary secret. */
  secret?: string
  body?: unknown
  /** The body bytes exactly as sent (overrides `body`). */
  rawBody?: string
  timestampMs?: number
  /** Sign this path (and body) instead of what is sent, to model tampering in flight. */
  signedPath?: string
  signedBody?: string
  omit?: Array<keyof typeof SERVICE_HEADERS>
  headers?: Record<string, string>
}

/** One hand-signed request through the real app. */
async function raw(method: "GET" | "POST" | "PUT" | "DELETE", pathWithQuery: string, options: RawOptions = {}): Promise<Reply> {
  const service = options.service ?? "store"
  const body = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body))
  const timestampMs = options.timestampMs ?? Date.now()
  const headers: Record<string, string> = {
    [SERVICE_HEADERS.service]: service,
    [SERVICE_HEADERS.timestamp]: String(timestampMs),
    [SERVICE_HEADERS.signature]: signServiceRequest({
      secret: options.secret ?? "store-s1",
      method,
      pathWithQuery: options.signedPath ?? pathWithQuery,
      body: options.signedBody ?? body,
      timestampMs,
    }),
    ...options.headers,
  }
  for (const header of options.omit ?? []) delete headers[SERVICE_HEADERS[header]]
  const hasBody = method === "POST" || method === "PUT" || body !== ""
  if (hasBody) headers["content-type"] = "application/json"
  return send(method, pathWithQuery, headers, hasBody ? body : undefined)
}

async function send(method: string, pathWithQuery: string, headers: Record<string, string>, body?: string) {
  const response = await app.fetch(new Request(`${BASE}${pathWithQuery}`, {method, headers, body}))
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, json, text}
}

/** Signed headers for a request, to send under a different method or path than was signed. */
function signedHeaders(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const timestampMs = Date.now()
  return {
    [SERVICE_HEADERS.service]: "store",
    [SERVICE_HEADERS.timestamp]: String(timestampMs),
    [SERVICE_HEADERS.signature]: signServiceRequest({secret: "store-s1", method, pathWithQuery, body, timestampMs}),
  }
}

/** A cheap signed call that answers 200 when the service authenticates: a membership check of nothing. */
const PROBE_PATH = `${API}/memberships/check`
const PROBE_BODY = {mentraUserId: "mu_probe", workspaceIds: []}
const probe = (options: RawOptions = {}) => raw("POST", PROBE_PATH, {body: PROBE_BODY, ...options})

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspaces-internal-api")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({
    ...HOSTED_ENV,
    CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
    CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
    CLOUD_CORE_ENVIRONMENT: undefined,
    CLOUD_CORE_WORKSPACE_CREATION: undefined,
    CONSOLE2_URL: undefined,
    CLOUD_CORE_SERVICE_SECRETS: JSON.stringify(SERVICE_SECRETS),
  })
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

// --- Service authentication ------------------------------------------------

describe("service authentication", () => {
  test("an unsigned call is 401 service_unauthorized, whatever the route", async () => {
    for (const [method, path] of [
      ["POST", `${API}/authorize`],
      ["POST", `${API}/principal`],
      ["POST", `${API}/memberships/check`],
      ["POST", `${API}/credentials`],
      ["POST", `${API}/users/resolve-email`],
      ["GET", `${API}/workspaces/ws_1`],
      ["GET", `${API}/changes`],
      ["GET", `${API}/no-such-route`],
    ] as const) {
      const reply = await send(method, path, {}, method === "POST" ? "{}" : undefined)
      expect({path, status: reply.status, body: reply.json}).toEqual({
        path,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a missing header is 401", async () => {
    for (const omitted of ["service", "timestamp", "signature"] as const) {
      const reply = await probe({omit: [omitted]})
      expect({omitted, status: reply.status, body: reply.json}).toEqual({
        omitted,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a wrong secret is 401 service_unauthorized, which the client reports as such", async () => {
    const reply = await probe({secret: "not-the-secret"})
    expect(reply.status).toBe(401)
    expect(reply.json).toEqual({error: "service_unauthorized"})

    await expectClientError(
      clientFor("store", {secret: "not-the-secret"}).checkMemberships("mu_probe", []),
      "service_unauthorized",
      401,
    )
  })

  test("a timestamp more than 60 seconds from now is 401, in either direction", async () => {
    const stale = await probe({timestampMs: Date.now() - 61_000})
    const future = await probe({timestampMs: Date.now() + 61_000})
    const near = await probe({timestampMs: Date.now() - 30_000})

    expect(stale.status).toBe(401)
    expect(stale.json).toEqual({error: "service_unauthorized"})
    expect(future.status).toBe(401)
    expect(near.status).toBe(200)
  })

  test("a timestamp that is not a plain number of milliseconds is 401", async () => {
    for (const timestamp of ["", "abc", "1e12", "0x1", "-1", "1.5", " 1"]) {
      const reply = await probe({headers: {[SERVICE_HEADERS.timestamp]: timestamp}})
      expect({timestamp, status: reply.status}).toEqual({timestamp, status: 401})
    }
  })

  test("an unknown service is 401, even with a valid Store secret", async () => {
    for (const service of ["other", "core", "STORE", "FLEET", "", "__proto__", "constructor", "toString"]) {
      const reply = await probe({service, secret: "store-s1"})
      expect({service, status: reply.status, body: reply.json}).toEqual({
        service,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
    await expectClientError(clientFor("other", {secret: "store-s1"}).getWorkspace("ws_1"), "service_unauthorized", 401)
  })

  test("Fleet authenticates with its own secrets; neither service's secret works under the other's name", async () => {
    expect((await probe({service: "fleet", secret: "fleet-f1"})).status).toBe(200)
    expect((await probe({service: "fleet", secret: "fleet-f0"})).status).toBe(200)
    expect(await fleet().checkMemberships("mu_probe", [])).toEqual({})

    const storeAsFleet = await probe({service: "fleet", secret: "store-s1"})
    const fleetAsStore = await probe({service: "store", secret: "fleet-f1"})
    expect(storeAsFleet.status).toBe(401)
    expect(storeAsFleet.json).toEqual({error: "service_unauthorized"})
    expect(fleetAsStore.status).toBe(401)
    await expectClientError(clientFor("fleet", {secret: "store-s1"}).getWorkspace("ws_1"), "service_unauthorized", 401)
  })

  test("Fleet is a service Core knows only when it has a secret for it", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"]})

    expect((await probe({service: "fleet", secret: "fleet-f1"})).status).toBe(401)
    expect((await probe()).status).toBe(200)

    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({fleet: ["fleet-f1"]})
    expect((await probe({service: "fleet", secret: "fleet-f1"})).status).toBe(200)
    expect((await probe()).status).toBe(401)
  })

  test("a request signed for another body, path, query or method is 401", async () => {
    const swappedBody = await probe({signedBody: JSON.stringify({...PROBE_BODY, x: 1})})
    const swappedPath = await probe({signedPath: `${API}/principal`})
    const swappedQuery = await raw("GET", `${API}/workspaces/ws_1?x=2`, {signedPath: `${API}/workspaces/ws_1?x=1`})
    const swappedMethod = await send(
      "POST",
      `${API}/workspaces/ws_1`,
      signedHeaders("GET", `${API}/workspaces/ws_1`, ""),
      "",
    )

    expect(swappedBody.status).toBe(401)
    expect(swappedPath.status).toBe(401)
    expect(swappedQuery.status).toBe(401)
    expect(swappedMethod.status).toBe(401)
  })

  test("either secret of a rotation authenticates, and a retired one does not", async () => {
    expect((await probe({secret: "store-s1"})).status).toBe(200)
    expect((await probe({secret: "store-s0"})).status).toBe(200)
    expect(await clientFor("store", {secret: "store-s0"}).checkMemberships("mu_probe", [])).toEqual({})

    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"]})
    expect((await probe({secret: "store-s0"})).status).toBe(401)
    expect((await probe({secret: "store-s1"})).status).toBe(200)
  })

  test("a blank secret in the list never authenticates, even for a signature forged with it", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["", "  ", "store-s1"]})
    const timestampMs = Date.now()
    const body = JSON.stringify(PROBE_BODY)
    const bodyHash = createHash("sha256").update(body).digest("hex")
    // `signServiceRequest` refuses a blank secret, so forge the signature by hand.
    const forged = (secret: string) =>
      createHmac("sha256", secret).update(`${timestampMs}\nPOST\n${PROBE_PATH}\n${bodyHash}`).digest("base64url")

    for (const secret of ["", "  "]) {
      const reply = await send(
        "POST",
        PROBE_PATH,
        {
          [SERVICE_HEADERS.service]: "store",
          [SERVICE_HEADERS.timestamp]: String(timestampMs),
          [SERVICE_HEADERS.signature]: forged(secret),
          "content-type": "application/json",
        },
        body,
      )
      expect({secret, status: reply.status}).toEqual({secret, status: 401})
    }
    expect((await probe()).status).toBe(200)
  })

  test("an unset or empty configuration authenticates nobody", async () => {
    for (const configured of [undefined, "", "   ", "{}"]) {
      if (configured === undefined) delete process.env.CLOUD_CORE_SERVICE_SECRETS
      else process.env.CLOUD_CORE_SERVICE_SECRETS = configured
      const reply = await probe()
      expect({configured, status: reply.status, body: reply.json}).toEqual({
        configured,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
  })

  test("a service name Core does not know in the configuration is ignored, not used", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"], fleet: ["fleet-f1"], other: ["o-1"]})

    expect((await probe({service: "other", secret: "o-1"})).status).toBe(401)
    expect((await probe({service: "fleet", secret: "fleet-f1"})).status).toBe(200)
    expect((await probe()).status).toBe(200)
  })

  test("malformed configuration is 503 service_auth_misconfigured for every call, signed or not", async () => {
    const malformed = [
      "not json",
      "{",
      "[]",
      '"store-s1"',
      "null",
      "42",
      '{"store":"store-s1"}',
      '{"store":[1]}',
      '{"store":[null]}',
      '{"store":{"a":"b"}}',
      '{"store":[]}',
      '{"store":["store-s1"],"other":"o"}',
      // A list with nothing but blank secrets holds no usable secret: as malformed as an empty list.
      '{"store":[""]}',
      '{"store":["  "]}',
      '{"store":["", "   ", "\\t"]}',
      '{"store":["store-s1"],"other":[" "]}',
      '{"other":[""],"store":["store-s1"]}',
    ]
    for (const configured of malformed) {
      process.env.CLOUD_CORE_SERVICE_SECRETS = configured
      const signed = await probe()
      const unsigned = await send("GET", `${API}/workspaces/ws_1`, {})
      const post = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "mentra_user", mentraUserId: "mu_1"}},
      })
      for (const reply of [signed, unsigned, post]) {
        expect({configured, status: reply.status, body: reply.json}).toEqual({
          configured,
          status: 503,
          body: {error: "service_auth_misconfigured"},
        })
      }
    }
    // The client reports it as Core being unavailable, not as a bad secret.
    process.env.CLOUD_CORE_SERVICE_SECRETS = "not json"
    await expectClientError(store().getWorkspace("ws_1"), "core_unavailable", 503)
  })

  test("the configuration is read on every request", async () => {
    expect((await probe()).status).toBe(200)
    process.env.CLOUD_CORE_SERVICE_SECRETS = "oops"
    expect((await probe()).status).toBe(503)
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify(SERVICE_SECRETS)
    expect((await probe()).status).toBe(200)
  })
})

// --- POST /authorize -------------------------------------------------------

describe("POST /authorize", () => {
  test("a bearer for a member gets its role's capabilities, with the contract's principal", async () => {
    const {workspaceId, developer} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "bearer", token: developer.bearer},
      workspaceId,
      capability: "miniapps.publish",
    })

    expect(decision.allowed).toBe(true)
    expect(decision.principal).toEqual({
      kind: "user",
      mentraUserId: developer.mentraUserId,
      email: developer.email,
      emailVerified: true,
      isOrganizationAdmin: false,
    })
    expect(decision.workspace).toMatchObject({workspaceId, name: "Acme", status: "active"})
    expect(decision.membership).toEqual({membershipId: expect.stringMatching(/^wm_/), role: "developer"})
    expect([...decision.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())
  })

  test("a member without the capability is denied with capability_missing and the capabilities they do have", async () => {
    const {workspaceId, member} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "bearer", token: member.bearer},
      workspaceId,
      capability: "miniapps.publish",
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("capability_missing")
    expect([...decision.capabilities].sort()).toEqual([...capabilitiesForRole("member")].sort())
  })

  test("a signed-in person who is not a member is not_a_member, and learns nothing about the workspace", async () => {
    const {workspaceId, stranger} = await newWorkspace()

    const decision = await store().authorize({credential: {type: "bearer", token: stranger.bearer}, workspaceId})

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("not_a_member")
    expect(decision.workspace).toBeUndefined()
    expect(decision.capabilities).toEqual([])
  })

  test("an msk_ token is allowed for a package in its scope and package_out_of_scope for another", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {
      name: "CI",
      packageNames: ["com.acme.app"],
    })

    const inScope = await store().authorize({
      credential: {type: "bearer", token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.acme.app",
    })
    const outOfScope = await store().authorize({
      credential: {type: "bearer", token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.other.app",
    })

    expect(inScope.allowed).toBe(true)
    expect(inScope.principal).toMatchObject({kind: "credential", credentialKind: "workspace", workspaceId})
    expect(outOfScope.allowed).toBe(false)
    expect(outOfScope.reason).toBe("package_out_of_scope")
    expect(outOfScope.workspace).toBeUndefined()
    expect(outOfScope.capabilities).toEqual([])
  })

  test("a bearer that is not a valid identity is unauthenticated, and a bad or revoked key is credential_invalid", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential: revoked, token: revokedToken} = await createWorkspaceCredential(actorOf(developer), workspaceId, {
      name: "Old",
    })
    await revokeCredential(actorOf(developer), revoked.credentialId)
    const wrongSecret = await idp.mint(
      {sub: "supa-developer", aud: "authenticated", client_id: WEB_CLIENT},
      {alg: "RS256", key: "attacker"},
    )

    const unauthenticated = []
    for (const token of ["not-a-token", "   ", wrongSecret]) {
      unauthenticated.push(await store().authorize({credential: {type: "bearer", token}, workspaceId}))
    }
    const invalid = []
    for (const token of [`msk_local_${"0".repeat(26)}.${"A".repeat(43)}`, "mak_local_garbage", revokedToken]) {
      invalid.push(await store().authorize({credential: {type: "bearer", token}, workspaceId}))
    }

    for (const decision of unauthenticated) {
      expect(decision).toMatchObject({allowed: false, reason: "unauthenticated", principal: null, capabilities: []})
    }
    for (const decision of invalid) {
      expect(decision).toMatchObject({allowed: false, reason: "credential_invalid", principal: null, capabilities: []})
    }
  })

  test("a mentra_user credential authorizes as that user's membership, as a plain user", async () => {
    const {workspaceId, admin, stranger} = await newWorkspace()

    const decision = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: admin.mentraUserId},
      workspaceId,
      capability: "workspace.members.manage",
    })
    const denied = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: stranger.mentraUserId},
      workspaceId,
    })

    expect(decision.allowed).toBe(true)
    expect(decision.principal).toEqual({
      kind: "user",
      mentraUserId: admin.mentraUserId,
      email: null,
      emailVerified: false,
      isOrganizationAdmin: false,
    })
    expect(decision.membership?.role).toBe("admin")
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe("not_a_member")
  })

  test("a deleted account is no principal: its bearer, a vouched mentra_user and its memberships are refused", async () => {
    const {workspaceId, developer} = await newWorkspace()
    expect((await store().authorize({credential: {type: "bearer", token: developer.bearer}, workspaceId})).allowed).toBe(true)

    // Account deletion sets the tombstone before it ends any membership.
    await UserModel.updateOne({mentraUserId: developer.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})

    const asBearer = await store().authorize({credential: {type: "bearer", token: developer.bearer}, workspaceId})
    const vouched = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: developer.mentraUserId},
      workspaceId,
    })
    for (const decision of [asBearer, vouched]) {
      expect(decision).toMatchObject({allowed: false, reason: "unauthenticated", principal: null, capabilities: []})
    }
    expect(await store().resolvePrincipal(developer.bearer)).toBeNull()
    expect(await store().checkMemberships(developer.mentraUserId, [workspaceId])).toEqual({[workspaceId]: null})
  })

  test("a mentra_user credential never carries Organization Admin standing, even for an allowlisted person", async () => {
    const {workspaceId} = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})

    const asBearer = await store().authorize({
      credential: {type: "bearer", token: orgAdmin.bearer},
      workspaceId,
      capability: "workspace.delete",
    })
    const asMentraUser = await store().authorize({
      credential: {type: "mentra_user", mentraUserId: orgAdmin.mentraUserId},
      workspaceId,
      capability: "workspace.delete",
    })

    expect(asBearer.allowed).toBe(true)
    expect(asBearer.principal).toMatchObject({isOrganizationAdmin: true, emailVerified: true})
    expect(asBearer.membership).toBeNull()
    expect(asMentraUser.allowed).toBe(false)
    expect(asMentraUser.reason).toBe("not_a_member")
    expect(asMentraUser.principal).toMatchObject({isOrganizationAdmin: false})
  })

  test("an allowlisted email the account directory has not confirmed is no Organization Admin, whatever the token claims", async () => {
    const {workspaceId} = await newWorkspace()
    const claimant = await person("claimant", {email: ADMIN_EMAIL, emailConfirmed: false})
    const claiming = await coreAccessToken({
      sub: claimant.sub,
      email: ADMIN_EMAIL,
      emailVerified: false,
      clientId: WEB_CLIENT,
      claims: {email: ADMIN_EMAIL, email_verified: true},
    })

    for (const token of [claimant.bearer, claiming]) {
      const decision = await store().authorize({credential: {type: "bearer", token}, workspaceId, capability: "workspace.delete"})
      expect(decision).toMatchObject({allowed: false, reason: "not_a_member"})
      expect(decision.principal).toEqual({
        kind: "user",
        mentraUserId: claimant.mentraUserId,
        email: ADMIN_EMAIL,
        emailVerified: false,
        isOrganizationAdmin: false,
      })
    }
  })

  test("a workspace that does not exist or was deleted is denied with its own reason", async () => {
    const {workspaceId, owner} = await newWorkspace()
    const credential = {type: "mentra_user", mentraUserId: owner.mentraUserId} as const

    const missing = await store().authorize({credential, workspaceId: "ws_missing"})
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    const deleted = await store().authorize({credential, workspaceId})

    expect(missing).toMatchObject({allowed: false, reason: "workspace_not_found", workspace: null})
    expect(deleted).toMatchObject({allowed: false, reason: "workspace_deleted"})
    expect(deleted.workspace).toMatchObject({workspaceId, status: "deleted"})
  })

  test("with no workspace there is nothing to grant: allowed with no capabilities, and a capability is refused", async () => {
    const {developer} = await newWorkspace()
    const credential = {type: "bearer", token: developer.bearer} as const

    const allowed = await store().authorize({credential})
    const refused = await store().authorize({credential, capability: "workspace.read"})

    expect(allowed).toMatchObject({allowed: true, capabilities: []})
    expect(refused).toMatchObject({allowed: false, reason: "capability_missing"})
  })

  test("a capability Core does not know is never granted: capability_missing, with or without a workspace, even for an Organization Admin", async () => {
    const {workspaceId, owner, developer} = await newWorkspace()
    const admin = await person("root-admin", {email: ADMIN_EMAIL})
    const unknown = ["not.a.capability", "workspace.read ", "WORKSPACE.READ", "__proto__", "constructor", "toString"]

    for (const capability of unknown) {
      for (const who of [developer, owner, admin]) {
        const inWorkspace = await raw("POST", `${API}/authorize`, {
          body: {credential: {type: "bearer", token: who.bearer}, workspaceId, capability},
        })
        expect({capability, who: who.email, status: inWorkspace.status, allowed: inWorkspace.json?.allowed}).toEqual({
          capability,
          who: who.email,
          status: 200,
          allowed: false,
        })
        expect(inWorkspace.json.reason).toBe("capability_missing")
        // The denial still says what the person can do, so a caller can tell a typo from a missing role.
        expect(inWorkspace.json.capabilities.length).toBeGreaterThan(0)
        expect(inWorkspace.json.capabilities).not.toContain(capability)
      }
      const noWorkspace = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "bearer", token: developer.bearer}, capability},
      })
      expect({capability, allowed: noWorkspace.json?.allowed, reason: noWorkspace.json?.reason}).toEqual({
        capability,
        allowed: false,
        reason: "capability_missing",
      })
      const asUser = await raw("POST", `${API}/authorize`, {
        body: {credential: {type: "mentra_user", mentraUserId: developer.mentraUserId}, workspaceId, capability},
      })
      expect({capability, allowed: asUser.json?.allowed, reason: asUser.json?.reason}).toEqual({
        capability,
        allowed: false,
        reason: "capability_missing",
      })
    }

    // A real capability is unaffected.
    const known = await raw("POST", `${API}/authorize`, {
      body: {credential: {type: "bearer", token: developer.bearer}, workspaceId, capability: "miniapps.publish"},
    })
    expect(known.json).toMatchObject({allowed: true})
  })

  test("a request that is not shaped like an authorize request is 400 invalid_request", async () => {
    const bad: unknown[] = [
      {},
      {credential: null},
      {credential: "bearer"},
      {credential: {type: "basic", token: "x"}},
      {credential: {type: "bearer"}},
      {credential: {type: "bearer", token: 1}},
      {credential: {type: "mentra_user"}},
      {credential: {type: "mentra_user", mentraUserId: ""}},
      {credential: {type: "mentra_user", mentraUserId: "   "}},
      {credential: {type: "mentra_user", mentraUserId: 7}},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: 5},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: ["workspace.read"]},
      // A blank capability is not "no capability": it would otherwise read as an unconditional allow.
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: ""},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, capability: "   "},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: "ws_1", capability: ""},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, workspaceId: "ws_1", capability: "\t\n"},
      {credential: {type: "mentra_user", mentraUserId: "mu_1"}, packageName: {}},
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/authorize`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    for (const rawBody of ["", "not json", "[]", "null", "3"]) {
      const reply = await raw("POST", `${API}/authorize`, {rawBody})
      expect({rawBody, status: reply.status, error: reply.json?.error}).toEqual({
        rawBody,
        status: 400,
        error: "invalid_request",
      })
    }
  })

  test("an authorize answer has exactly the contract's fields, at every level", async () => {
    const {workspaceId, developer} = await newWorkspace()

    const reply = await raw("POST", `${API}/authorize`, {
      body: {credential: {type: "bearer", token: developer.bearer}, workspaceId},
    })

    expect(reply.status).toBe(200)
    expect(Object.keys(reply.json).sort()).toEqual(["allowed", "capabilities", "membership", "principal", "workspace"])
    expect(Object.keys(reply.json.principal).sort()).toEqual(USER_PRINCIPAL_KEYS)
    expect(Object.keys(reply.json.workspace).sort()).toEqual(["authorizationRevision", "name", "status", "workspaceId"])
  })
})

// --- POST /principal -------------------------------------------------------

describe("POST /principal", () => {
  test("a Supabase access token resolves to the contract's principal and the person's active workspaces", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const other = await createWorkspace(actorOf(developer), {name: "Second"})
    const gone = await createWorkspace(actorOf(developer), {name: "Gone"})
    await deleteWorkspace(actorOf(developer), gone.workspaceId, {confirmName: "Gone"})

    const resolved = await store().resolvePrincipal(developer.bearer)

    expect(resolved?.principal).toEqual({
      kind: "user",
      mentraUserId: developer.mentraUserId,
      email: developer.email,
      emailVerified: true,
      isOrganizationAdmin: false,
    })
    expect(resolved?.workspaces.map(workspace => workspace.workspaceId)).toEqual([workspaceId, other.workspaceId])
    expect(resolved?.workspaces[0]).toMatchObject({
      name: "Acme",
      status: "active",
      membership: {membershipId: expect.stringMatching(/^wm_/), role: "developer"},
    })
    expect(resolved?.workspaces[1]?.membership.role).toBe("owner")
    expect([...resolved!.workspaces[0]!.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())

    // On the wire too: none of Core's own fields (`tenantId`, `via`) leave Core.
    const reply = await raw("POST", `${API}/principal`, {body: {token: developer.bearer}})
    expect(Object.keys(reply.json).sort()).toEqual(["principal", "workspaces"])
    expect(Object.keys(reply.json.principal).sort()).toEqual(USER_PRINCIPAL_KEYS)
  })

  test("the person is the phone's Core user", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-first-sight"})
    const bearer = await coreAccessToken({sub: "supa-first-sight", email: "first@example.test", clientId: WEB_CLIENT})

    const resolved = await store().resolvePrincipal(bearer)

    const user = await UserModel.findOne({tenantId: "mentra", tenantUserId: "supa-first-sight"}).lean()
    expect(user!.mentraUserId).toBe(phoneUser.mentraUserId)
    expect(resolved?.principal).toEqual({
      kind: "user",
      mentraUserId: user!.mentraUserId,
      email: "first@example.test",
      emailVerified: true,
      isOrganizationAdmin: false,
    })
    expect(resolved?.workspaces).toEqual([])
  })

  test("an Organization Admin is one by their confirmed, allowlisted email", async () => {
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})

    const resolved = await store().resolvePrincipal(orgAdmin.bearer)

    expect(resolved?.principal).toEqual({
      kind: "user",
      mentraUserId: orgAdmin.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
    })
  })

  test("email verification is what Core recorded at sign-in, never the token's claims", async () => {
    const unconfirmed = await person("unconfirmed", {email: ADMIN_EMAIL, emailConfirmed: false})
    const claiming = await coreAccessToken({
      sub: unconfirmed.sub,
      email: ADMIN_EMAIL,
      emailVerified: false,
      clientId: WEB_CLIENT,
      claims: {email: ADMIN_EMAIL, email_verified: true},
    })

    for (const token of [unconfirmed.bearer, claiming]) {
      const resolved = await store().resolvePrincipal(token)
      expect(resolved?.principal).toMatchObject({email: ADMIN_EMAIL, emailVerified: false, isOrganizationAdmin: false})
    }
  })

  test("an msk_ token resolves to its credential principal with no workspace memberships", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {credential, token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    const resolved = await store().resolvePrincipal(token)

    expect(resolved?.principal).toEqual({
      kind: "credential",
      credentialId: credential.credentialId,
      credentialKind: "workspace",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: [],
      label: "CI",
    })
    expect(resolved?.workspaces).toEqual([])
  })

  test("a token Core does not accept is 401 invalid_token, which the client reports as null", async () => {
    await newWorkspace()
    const tokens = [
      "not-a-token",
      "",
      "   ",
      "msk_local_garbage",
      `mak_local_${"0".repeat(26)}.${"A".repeat(43)}`,
      // Signed with a key Core never published.
      await new jose.SignJWT({client_id: WEB_CLIENT, sub: "mu_forged", aud: "urn:mentra:core", iss: process.env.CLOUD_CORE_OIDC_ISSUER})
        .setProtectedHeader({alg: "EdDSA", kid: "mentra-oidc-1", typ: "at+jwt"})
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign((await jose.generateKeyPair("EdDSA")).privateKey),
      // Expired.
      await coreAccessToken({sub: "supa-owner", email: "owner@example.test", clientId: WEB_CLIENT, iat: Math.floor(Date.now() / 1000) - 7200}),
    ]
    for (const token of tokens) {
      const reply = await raw("POST", `${API}/principal`, {body: {token}})
      expect({token, status: reply.status, body: reply.json}).toEqual({
        token,
        status: 401,
        body: {error: "invalid_token"},
      })
    }
    expect(await store().resolvePrincipal("not-a-token")).toBeNull()
  })

  test("a phone Core access token is refused with 401 invalid_token", async () => {
    const owner = await person("phone-owner")

    await withPhoneCoreToken(owner.sub, async phoneToken => {
      const reply = await raw("POST", `${API}/principal`, {body: {token: phoneToken}})
      expect(reply.status).toBe(401)
      expect(reply.json).toEqual({error: "invalid_token"})
      expect(await store().resolvePrincipal(phoneToken)).toBeNull()
      expect(await store().authorize({credential: {type: "bearer", token: phoneToken}})).toMatchObject({
        allowed: false,
        reason: "unauthenticated",
        principal: null,
      })
    })
  })

  test("an ID token, Supabase tokens, an unknown client's and another environment's tokens are refused with 401 invalid_token", async () => {
    const owner = await person("owner")
    const restore = applyEnv({CLOUD_CORE_OIDC_ISSUER: "https://account.staging.test"})
    const otherEnvironment = await coreAccessToken({sub: owner.sub, email: owner.email, clientId: WEB_CLIENT})
    restore()
    const refused = {
      // An ID token is addressed to the client, not to Core's API.
      idToken: await coreAccessToken({sub: owner.sub, email: owner.email, clientId: WEB_CLIENT, claims: {aud: WEB_CLIENT}}),
      // A phone's Supabase session: only good for the phone's token exchange.
      phoneSession: await idp.mint({sub: owner.sub, aud: "authenticated", role: "authenticated", email: owner.email}),
      // A Supabase OAuth token: Supabase's OAuth server is not Core's sign-in server.
      supabaseOAuth: await idp.mint({sub: owner.sub, aud: "authenticated", client_id: WEB_CLIENT, email: owner.email}),
      // A client that is not registered at Core's sign-in server.
      otherClient: await coreAccessToken({sub: owner.sub, email: owner.email, clientId: "mobile-client"}),
      otherEnvironment,
    }

    for (const [kind, token] of Object.entries(refused)) {
      const reply = await raw("POST", `${API}/principal`, {body: {token}})
      expect({kind, status: reply.status, body: reply.json}).toEqual({kind, status: 401, body: {error: "invalid_token"}})
    }
    // The same person's web access token works.
    expect((await store().resolvePrincipal(owner.bearer))?.principal).toMatchObject({mentraUserId: owner.mentraUserId})
  })

  test("a request with no token string is 400", async () => {
    for (const body of [{}, {token: 5}, {token: null}, {token: ["a"]}, []]) {
      const reply = await raw("POST", `${API}/principal`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({body, status: 400, error: "invalid_request"})
    }
  })

  test("a service-level 401 is not reported as an invalid token", async () => {
    await expectClientError(
      clientFor("store", {secret: "wrong"}).resolvePrincipal("not-a-token"),
      "service_unauthorized",
      401,
    )
  })
})

// --- POST /memberships/check -----------------------------------------------

describe("POST /memberships/check", () => {
  test("answers a role and capabilities for each workspace the person is in and null for every other", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const second = await createWorkspace(actorOf(developer), {name: "Second"})
    const gone = await createWorkspace(actorOf(developer), {name: "Gone"})
    await deleteWorkspace(actorOf(developer), gone.workspaceId, {confirmName: "Gone"})
    const strangersOnly = await createWorkspace(actorOf(await person("someone-else")), {name: "Theirs"})

    const memberships = await store().checkMemberships(developer.mentraUserId, [
      workspaceId,
      second.workspaceId,
      gone.workspaceId,
      strangersOnly.workspaceId,
      "ws_unknown",
    ])

    expect(Object.keys(memberships)).toEqual([
      workspaceId,
      second.workspaceId,
      gone.workspaceId,
      strangersOnly.workspaceId,
      "ws_unknown",
    ])
    expect(memberships[workspaceId]?.role).toBe("developer")
    expect([...memberships[workspaceId]!.capabilities].sort()).toEqual([...capabilitiesForRole("developer")].sort())
    expect(memberships[second.workspaceId]?.role).toBe("owner")
    expect(memberships[gone.workspaceId]).toBeNull()
    expect(memberships[strangersOnly.workspaceId]).toBeNull()
    expect(memberships.ws_unknown).toBeNull()
  })

  test("the response is the raw map", async () => {
    const {workspaceId, member} = await newWorkspace()

    const reply = await raw("POST", `${API}/memberships/check`, {
      body: {mentraUserId: member.mentraUserId, workspaceIds: [workspaceId]},
    })

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      memberships: {[workspaceId]: {role: "member", capabilities: expect.arrayContaining(["workspace.read"])}},
    })
  })

  test("a membership that ended is null", async () => {
    const {workspaceId, developer, member} = await newWorkspace()
    await leaveWorkspace(actorOf(member), workspaceId)

    const left = await store().checkMemberships(member.mentraUserId, [workspaceId])
    const stillIn = await store().checkMemberships(developer.mentraUserId, [workspaceId])

    expect(left).toEqual({[workspaceId]: null})
    expect(stillIn[workspaceId]?.role).toBe("developer")
  })

  test("a user id nobody has, and an empty list, answer without error", async () => {
    const {workspaceId} = await newWorkspace()

    expect(await store().checkMemberships("mu_nobody", [workspaceId])).toEqual({[workspaceId]: null})
    expect(await store().checkMemberships("mu_nobody", [])).toEqual({})
  })

  test("a repeated workspace id answers once, and ids that are object keys with special meaning are plain keys", async () => {
    const {workspaceId, member} = await newWorkspace()

    const memberships = await store().checkMemberships(member.mentraUserId, [
      workspaceId,
      workspaceId,
      "__proto__",
      "constructor",
    ])

    expect(Object.keys(memberships).sort()).toEqual(["__proto__", "constructor", workspaceId].sort())
    expect(Object.getOwnPropertyDescriptor(memberships, "__proto__")?.value).toBeNull()
    expect(memberships[workspaceId]?.role).toBe("member")
  })

  test("up to 100 workspace ids are accepted and 101 are 400", async () => {
    const ids = (count: number) => Array.from({length: count}, (_, index) => `ws_${index}`)

    const hundred = await store().checkMemberships("mu_1", ids(100))
    const tooMany = await raw("POST", `${API}/memberships/check`, {
      body: {mentraUserId: "mu_1", workspaceIds: ids(101)},
    })

    expect(Object.keys(hundred)).toHaveLength(100)
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.error).toBe("invalid_request")
  })

  test("a request that is not a user id and a list of non-empty workspace id strings is 400", async () => {
    const bad: unknown[] = [
      {},
      {mentraUserId: "mu_1"},
      {workspaceIds: ["ws_1"]},
      {mentraUserId: "", workspaceIds: ["ws_1"]},
      {mentraUserId: "  ", workspaceIds: ["ws_1"]},
      {mentraUserId: 1, workspaceIds: ["ws_1"]},
      {mentraUserId: "mu_1", workspaceIds: "ws_1"},
      {mentraUserId: "mu_1", workspaceIds: [1]},
      {mentraUserId: "mu_1", workspaceIds: [null]},
      {mentraUserId: "mu_1", workspaceIds: [""]},
      {mentraUserId: "mu_1", workspaceIds: ["ws_1", ""]},
      {mentraUserId: "mu_1", workspaceIds: [["ws_1"]]},
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/memberships/check`, {body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
    }
  })
})

// --- GET /workspaces/:workspaceId ------------------------------------------

describe("GET /workspaces/:workspaceId", () => {
  test("returns the workspace summary", async () => {
    const {workspaceId, workspace} = await newWorkspace()

    expect(await store().getWorkspace(workspaceId)).toEqual({
      workspaceId,
      name: "Acme",
      status: "active",
      authorizationRevision: workspace.authorizationRevision,
    })
  })

  test("a deleted workspace is still described, with its status", async () => {
    const {workspaceId, owner} = await newWorkspace()
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})

    expect(await store().getWorkspace(workspaceId)).toMatchObject({workspaceId, status: "deleted"})
  })

  test("an unknown workspace is 404 workspace_not_found, which the client reports as null", async () => {
    await newWorkspace()

    const reply = await raw("GET", `${API}/workspaces/ws_missing`)

    expect(reply.status).toBe(404)
    expect(reply.json).toEqual({error: "workspace_not_found"})
    expect(await store().getWorkspace("ws_missing")).toBeNull()
  })

  test("an id that needs escaping in the path is found, and still verifies", async () => {
    await newWorkspace()
    const odd = "ws/odd id?x=1"
    await WorkspaceModel.create({
      workspaceId: odd,
      name: "Odd",
      status: "active",
      authorizationRevision: 0,
    })

    expect(await store().getWorkspace(odd)).toMatchObject({workspaceId: odd, name: "Odd"})
  })
})

// --- POST /credentials -----------------------------------------------------

describe("POST /credentials", () => {
  const input = (workspaceId: string, overrides: Record<string, unknown> = {}) => ({
    workspaceId,
    name: "Store package key",
    packageNames: ["com.acme.app"],
    issuedBy: {service: "store", actorEmail: "staff@example.test"},
    ...overrides,
  })

  test("the Store mints a package-restricted credential that validates as an msk_ token", async () => {
    const {workspaceId} = await newWorkspace()

    const minted = await store().mintServiceCredential({
      workspaceId,
      name: "Store package key",
      packageNames: ["com.acme.app"],
      issuedBy: {service: "store", actorEmail: "staff@example.test"},
    })

    expect(minted.credentialId).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/))
    expect(minted.token).toStartWith("msk_local_")
    expect(minted.token).toContain(minted.credentialId)

    const inScope = await store().authorize({
      credential: {type: "bearer", token: minted.token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.acme.app",
    })
    const outOfScope = await store().authorize({
      credential: {type: "bearer", token: minted.token},
      workspaceId,
      capability: "miniapps.publish",
      packageName: "com.other.app",
    })
    expect(inScope.allowed).toBe(true)
    expect(outOfScope.reason).toBe("package_out_of_scope")

    const row = await AccessCredentialModel.findOne({credentialId: minted.credentialId}).lean()
    expect(row).toMatchObject({
      workspaceId,
      packageNames: ["com.acme.app"],
      issuedByService: "store",
      createdByEmail: "staff@example.test",
      createdByMembershipId: null,
    })
  })

  test("the response is {credentialId, token}, created and never cached", async () => {
    const {workspaceId} = await newWorkspace()

    const reply = await raw("POST", `${API}/credentials`, {body: input(workspaceId)})

    expect(reply.status).toBe(201)
    expect(reply.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(reply.json).sort()).toEqual(["credentialId", "token"])
  })

  test("the audit trail names the authenticated service and the person who asked, never the token", async () => {
    const {workspaceId} = await newWorkspace()
    const minted = await store().mintServiceCredential({
      workspaceId,
      name: "Store package key",
      packageNames: ["com.acme.app"],
      issuedBy: {service: "store", actorEmail: "staff@example.test"},
    })

    const event = await WorkspaceAuditEventModel.findOne({action: "credential.created"}).lean()

    expect(event?.actor).toMatchObject({kind: "service", service: "store", email: "staff@example.test"})
    expect(event?.target).toMatchObject({credentialId: minted.credentialId, workspaceId})
    const stored = JSON.stringify(event)
    expect(stored).not.toContain(minted.token)
    expect(stored).not.toContain(minted.token.split(".")[1]!)
  })

  test("a credential cannot be issued in another service's name: a mismatched issuedBy.service is 403", async () => {
    const {workspaceId} = await newWorkspace()

    for (const service of ["fleet", "core", "", null, 7]) {
      const reply = await raw("POST", `${API}/credentials`, {
        body: input(workspaceId, {issuedBy: {service, actorEmail: "staff@example.test"}}),
      })
      expect({service, status: reply.status, error: reply.json?.error}).toEqual({
        service,
        status: 403,
        error: "forbidden",
      })
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("an omitted issuedBy.service is ignored: the issuer is the authenticated service", async () => {
    const {workspaceId} = await newWorkspace()

    const reply = await raw("POST", `${API}/credentials`, {
      body: input(workspaceId, {issuedBy: {actorEmail: "staff@example.test"}}),
    })

    expect(reply.status).toBe(201)
    const row = await AccessCredentialModel.findOne({credentialId: reply.json.credentialId}).lean()
    expect(row?.issuedByService).toBe("store")
  })

  test("a request that is not a valid credential request is 400", async () => {
    const {workspaceId} = await newWorkspace()
    const bad: unknown[] = [
      {},
      input(workspaceId, {workspaceId: undefined}),
      input(workspaceId, {workspaceId: 5}),
      input(workspaceId, {workspaceId: ""}),
      input(workspaceId, {workspaceId: "   "}),
      input(workspaceId, {workspaceId: "\t\n"}),
      input(workspaceId, {name: undefined}),
      input(workspaceId, {name: ""}),
      input(workspaceId, {packageNames: undefined}),
      input(workspaceId, {packageNames: "com.acme.app"}),
      input(workspaceId, {packageNames: [5]}),
      input(workspaceId, {packageNames: []}),
      input(workspaceId, {packageNames: ["not a package"]}),
      input(workspaceId, {issuedBy: undefined}),
      input(workspaceId, {issuedBy: "store"}),
      input(workspaceId, {issuedBy: {service: "store"}}),
      input(workspaceId, {issuedBy: {service: "store", actorEmail: ""}}),
      input(workspaceId, {issuedBy: {service: "store", actorEmail: "  "}}),
    ]
    for (const body of bad) {
      const reply = await raw("POST", `${API}/credentials`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("an unknown or deleted workspace is refused and nothing is created", async () => {
    const {workspaceId, owner} = await newWorkspace()

    const missing = await raw("POST", `${API}/credentials`, {body: input("ws_missing")})
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    const deleted = await raw("POST", `${API}/credentials`, {body: input(workspaceId)})

    expect(missing.status).toBe(404)
    expect(deleted.status).toBe(410)
    expect(deleted.json.error).toBe("workspace_deleted")
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("only a signed request from a service Core knows can mint", async () => {
    const {workspaceId} = await newWorkspace()

    await expectClientError(
      clientFor("store", {secret: "not-a-store-secret"}).mintServiceCredential(input(workspaceId)),
      "service_unauthorized",
      401,
    )
    await expectClientError(
      clientFor("fleet", {secret: "store-s1"}).mintServiceCredential(input(workspaceId)),
      "service_unauthorized",
      401,
    )
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("Fleet, though it authenticates, may not mint: 403 forbidden", async () => {
    const {workspaceId} = await newWorkspace()

    await expectClientError(fleet().mintServiceCredential(input(workspaceId)), "forbidden", 403)
    const reply = await raw("POST", `${API}/credentials`, {
      service: "fleet",
      secret: "fleet-f1",
      body: input(workspaceId, {issuedBy: {service: "fleet", actorEmail: "staff@example.test"}}),
    })
    expect({status: reply.status, body: reply.json}).toEqual({status: 403, body: {error: "forbidden"}})
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })
})

// --- Deletion holds --------------------------------------------------------

describe("PUT and DELETE /workspaces/:workspaceId/deletion-holds/:service", () => {
  const OWNS = "owns_miniapps"
  const holdPath = (workspaceId: string, service = "store") => `${API}/workspaces/${workspaceId}/deletion-holds/${service}`
  const holdEvents = (workspaceId: string) =>
    WorkspaceAuditEventModel.find({workspaceId, action: /^workspace\.deletion_hold_/}).sort({seq: 1}).lean()
  const storedHolds = async (workspaceId: string) =>
    (await WorkspaceModel.findOne({workspaceId}).lean())?.deletionHolds ?? []
  /** The next `asOf` for a client call, later than every one before. */
  const now = () => new Date(nextHoldAsOf())
  /** The next `asOf` for a raw request body. */
  const asOf = nextHoldAsOf

  test("the Store holds a workspace, replaces its hold and clears it, through the contract's client", async () => {
    const {workspaceId} = await newWorkspace()

    expect(await store().setDeletionHold(workspaceId, {reason: OWNS, count: 3, asOf: now()})).toEqual({
      workspaceId,
      holds: [{service: "store", reason: OWNS, count: 3}],
      ignored: false,
    })
    expect(await store().setDeletionHold(workspaceId, {reason: OWNS, count: 1, asOf: now()})).toEqual({
      workspaceId,
      holds: [{service: "store", reason: OWNS, count: 1}],
      ignored: false,
    })
    // Idempotent: the same hold again changes and records nothing.
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 1, asOf: now()})
    expect(await store().clearDeletionHold(workspaceId, {asOf: now()})).toEqual({workspaceId, holds: [], ignored: false})
    expect(await store().clearDeletionHold(workspaceId, {asOf: now()})).toEqual({workspaceId, holds: [], ignored: false})

    expect((await holdEvents(workspaceId)).map(event => [event.action, event.actor.service, event.after])).toEqual([
      ["workspace.deletion_hold_set", "store", {reason: OWNS, count: 3}],
      ["workspace.deletion_hold_set", "store", {reason: OWNS, count: 1}],
      ["workspace.deletion_hold_cleared", "store", null],
    ])
  })

  test("the answer is exactly {workspaceId, holds, ignored}", async () => {
    const {workspaceId} = await newWorkspace()
    const set = await raw("PUT", holdPath(workspaceId), {body: {reason: OWNS, count: 2, asOf: asOf()}})
    expect(set.status).toBe(200)
    expect(set.json).toEqual({workspaceId, holds: [{service: "store", reason: OWNS, count: 2}], ignored: false})
    const cleared = await raw("DELETE", holdPath(workspaceId), {body: {asOf: asOf()}})
    expect(cleared.status).toBe(200)
    expect(cleared.json).toEqual({workspaceId, holds: [], ignored: false})
  })

  test("a late call, older than one Core applied, is ignored: 200 with the holds Core keeps, and nothing changes", async () => {
    const {workspaceId} = await newWorkspace()
    // Computed first, applied last: the call a Store timeout leaves behind.
    const lateClear = new Date(Date.now() - 120_000)
    const lateSet = new Date(Date.now() - 60_000)
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 2, asOf: now()})

    expect(await store().clearDeletionHold(workspaceId, {asOf: lateClear})).toEqual({
      workspaceId,
      holds: [{service: "store", reason: OWNS, count: 2}],
      ignored: true,
    })
    expect(await storedHolds(workspaceId)).toEqual([{service: "store", reason: OWNS, count: 2}])

    // After a newer clear, a late set does not bring the hold back.
    await store().clearDeletionHold(workspaceId, {asOf: now()})
    const set = await raw("PUT", holdPath(workspaceId), {body: {reason: OWNS, count: 5, asOf: lateSet.toISOString()}})
    expect([set.status, set.json]).toEqual([200, {workspaceId, holds: [], ignored: true}])
    expect(await storedHolds(workspaceId)).toEqual([])

    expect((await holdEvents(workspaceId)).map(event => event.action)).toEqual([
      "workspace.deletion_hold_set",
      "workspace.deletion_hold_cleared",
    ])
  })

  test("a newer call is applied; the same call again with the same asOf is answered as applied", async () => {
    const {workspaceId} = await newWorkspace()
    const first = now()
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 2, asOf: first})
    const retried = await store().setDeletionHold(workspaceId, {reason: OWNS, count: 2, asOf: first})
    expect(retried).toEqual({workspaceId, holds: [{service: "store", reason: OWNS, count: 2}], ignored: false})
    const conflicting = await store().setDeletionHold(workspaceId, {reason: OWNS, count: 3, asOf: first})
    expect(conflicting.ignored).toBe(true)

    expect(await store().setDeletionHold(workspaceId, {reason: OWNS, count: 3, asOf: now()})).toEqual({
      workspaceId,
      holds: [{service: "store", reason: OWNS, count: 3}],
      ignored: false,
    })
  })

  test("a missing, malformed or far-future asOf is 400 invalid_request and writes nothing", async () => {
    const {workspaceId} = await newWorkspace()
    const tooLate = new Date(Date.now() + 10 * 60_000)
    await expectClientError(store().setDeletionHold(workspaceId, {reason: OWNS, count: 1, asOf: tooLate}), "bad_request", 400)
    await expectClientError(store().clearDeletionHold(workspaceId, {asOf: tooLate}), "bad_request", 400)
    for (const body of [{}, {asOf: "2026-10-14"}, {asOf: "2026-10-14T12:00:00+02:00"}, {asOf: 1760000000000}]) {
      const set = await raw("PUT", holdPath(workspaceId), {body: {reason: OWNS, ...body}})
      const clear = await raw("DELETE", holdPath(workspaceId), {body})
      expect({body, set: [set.status, set.json?.error], clear: [clear.status, clear.json?.error]}).toEqual({
        body,
        set: [400, "invalid_request"],
        clear: [400, "invalid_request"],
      })
    }
    // A clear with no body at all names no asOf.
    const empty = await raw("DELETE", holdPath(workspaceId))
    expect([empty.status, empty.json?.error]).toEqual([400, "invalid_request"])
    expect(await storedHolds(workspaceId)).toEqual([])
    expect(await holdEvents(workspaceId)).toEqual([])
  })

  test("a held workspace is refused deletion, and deletes once the hold is cleared", async () => {
    const {workspaceId, owner} = await newWorkspace()
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 3, asOf: now()})

    const refused = await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"}).catch(err => err)
    expect({code: refused.code, status: refused.status}).toEqual({code: "workspace_has_holds", status: 409})

    await store().clearDeletionHold(workspaceId, {asOf: now()})
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    expect((await getWorkspace(workspaceId))!.status).toBe("deleted")
  })

  test("Fleet holds a workspace under its own name, beside the Store's", async () => {
    const {workspaceId} = await newWorkspace()
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 1, asOf: now()})

    expect(await fleet().setDeletionHold(workspaceId, {reason: "manages_devices", asOf: now()})).toEqual({
      workspaceId,
      holds: [
        {service: "fleet", reason: "manages_devices"},
        {service: "store", reason: OWNS, count: 1},
      ],
      ignored: false,
    })
    // Clearing its own leaves the Store's.
    expect(await fleet().clearDeletionHold(workspaceId, {asOf: now()})).toEqual({
      workspaceId,
      holds: [{service: "store", reason: OWNS, count: 1}],
      ignored: false,
    })
  })

  test("a service may set or clear only its own hold: another service's name is 403 and changes nothing", async () => {
    const {workspaceId} = await newWorkspace()
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 1, asOf: now()})

    for (const [service, secret, named] of [
      ["fleet", "fleet-f1", "store"],
      ["store", "store-s1", "fleet"],
      ["store", "store-s1", "core"],
      ["store", "store-s1", "Store"],
    ] as const) {
      for (const method of ["PUT", "DELETE"] as const) {
        const reply = await raw(method, holdPath(workspaceId, named), {
          service,
          secret,
          body: method === "PUT" ? {reason: "manages_devices", asOf: asOf()} : {asOf: asOf()},
        })
        expect({service, named, method, status: reply.status, error: reply.json?.error}).toEqual({
          service,
          named,
          method,
          status: 403,
          error: "forbidden",
        })
      }
    }
    expect(await storedHolds(workspaceId)).toEqual([{service: "store", reason: OWNS, count: 1}])
    expect((await holdEvents(workspaceId)).map(event => event.action)).toEqual(["workspace.deletion_hold_set"])
  })

  test("only a signed request from a service Core knows reaches it", async () => {
    const {workspaceId} = await newWorkspace()

    await expectClientError(
      clientFor("store", {secret: "not-a-store-secret"}).setDeletionHold(workspaceId, {reason: OWNS, asOf: now()}),
      "service_unauthorized",
      401,
    )
    await expectClientError(
      clientFor("fleet", {secret: "store-s1"}).clearDeletionHold(workspaceId, {asOf: now()}),
      "service_unauthorized",
      401,
    )
    // No signature at all: a person's request, or anyone's.
    for (const method of ["PUT", "DELETE"]) {
      const unsigned = await send(
        method,
        holdPath(workspaceId),
        {"content-type": "application/json"},
        JSON.stringify({reason: OWNS, asOf: asOf()}),
      )
      expect({method, status: unsigned.status, body: unsigned.json}).toEqual({
        method,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
    // A service Core has no secret for, even with a valid Store secret.
    const unknown = await raw("PUT", holdPath(workspaceId, "billing"), {service: "billing", body: {reason: OWNS, asOf: asOf()}})
    expect(unknown.status).toBe(401)
    // A signed PUT replayed as a DELETE does not verify.
    const body = JSON.stringify({reason: OWNS, asOf: asOf()})
    const replayed = await send("DELETE", holdPath(workspaceId), signedHeaders("PUT", holdPath(workspaceId), body), body)
    expect(replayed.status).toBe(401)
    expect(await storedHolds(workspaceId)).toEqual([])
  })

  test("a malformed hold is 400 invalid_request and writes nothing", async () => {
    const {workspaceId} = await newWorkspace()
    const bad: unknown[] = [
      {asOf: asOf()},
      {reason: "", asOf: asOf()},
      {reason: "Owns Miniapps", asOf: asOf()},
      {reason: 5, asOf: asOf()},
      {reason: OWNS, count: 0, asOf: asOf()},
      {reason: OWNS, count: 2.5, asOf: asOf()},
      {reason: OWNS, count: "3", asOf: asOf()},
      [],
    ]
    for (const body of bad) {
      const reply = await raw("PUT", holdPath(workspaceId), {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({body, status: 400, error: "invalid_request"})
    }
    for (const rawBody of ["", "{nope"]) {
      for (const method of ["PUT", "DELETE"] as const) {
        const reply = await raw(method, holdPath(workspaceId), {rawBody})
        expect({rawBody, method, status: reply.status}).toEqual({rawBody, method, status: 400})
      }
    }
    expect(await storedHolds(workspaceId)).toEqual([])
  })

  test("an unknown workspace is 404 workspace_not_found; a deleted one takes no hold (410) and has none to clear", async () => {
    const missingSet = await raw("PUT", holdPath("ws_missing"), {body: {reason: OWNS, asOf: asOf()}})
    const missingClear = await raw("DELETE", holdPath("ws_missing"), {body: {asOf: asOf()}})
    expect([missingSet.status, missingSet.json?.error]).toEqual([404, "workspace_not_found"])
    expect([missingClear.status, missingClear.json?.error]).toEqual([404, "workspace_not_found"])
    await expectClientError(store().setDeletionHold("ws_missing", {reason: OWNS, asOf: now()}), "bad_request", 404)

    const {workspaceId, owner} = await newWorkspace()
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: "Acme"})
    const deleted = await raw("PUT", holdPath(workspaceId), {body: {reason: OWNS, count: 1, asOf: asOf()}})
    expect([deleted.status, deleted.json?.error]).toEqual([410, "workspace_deleted"])
    expect(await store().clearDeletionHold(workspaceId, {asOf: now()})).toEqual({workspaceId, holds: [], ignored: false})
  })

  test("an id that needs escaping in the path is found, and still verifies", async () => {
    const {workspaceId} = await newWorkspace()
    await WorkspaceModel.updateOne({workspaceId}, {$set: {workspaceId: "ws odd/id"}})
    await WorkspaceMembershipModel.updateMany({workspaceId}, {$set: {workspaceId: "ws odd/id"}})

    expect(await store().setDeletionHold("ws odd/id", {reason: OWNS, asOf: now()})).toEqual({
      workspaceId: "ws odd/id",
      holds: [{service: "store", reason: OWNS}],
      ignored: false,
    })
  })

  test("setting and clearing a hold are on the change feed as the contract describes them; an ignored call is not", async () => {
    const {workspaceId} = await newWorkspace()
    const late = new Date(Date.now() - 120_000)
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 2, asOf: now()})
    await store().clearDeletionHold(workspaceId, {asOf: now()})
    await store().setDeletionHold(workspaceId, {reason: OWNS, count: 9, asOf: late})

    const {events} = await fleet().listChanges({})
    const holds = events.filter(event => event.action.startsWith("workspace.deletion_hold_") && event.workspaceId === workspaceId)
    expect(holds.map(({action, workspaceId: id, target, before, after}) => ({action, id, target, before, after}))).toEqual([
      {
        action: "workspace.deletion_hold_set",
        id: workspaceId,
        target: {workspaceId, service: "store"},
        before: null,
        after: {reason: OWNS, count: 2},
      },
      {
        action: "workspace.deletion_hold_cleared",
        id: workspaceId,
        target: {workspaceId, service: "store"},
        before: {reason: OWNS, count: 2},
        after: null,
      },
    ])
  })
})

// --- POST /users/resolve-email ---------------------------------------------

describe("POST /users/resolve-email", () => {
  /** The account directory (GoTrue's admin user listing): one confirmed and one unconfirmed account. */
  const accounts = [
    {id: "gt_verified", email: "Verified@Example.test", email_confirmed_at: "2026-01-01T00:00:00Z"},
    // Confirmed by phone, not by email: `confirmed_at` alone does not prove the address.
    {id: "gt_phone_only", email: "phone-only@example.test", email_confirmed_at: null, confirmed_at: "2026-01-01T00:00:00Z"},
    {id: "gt_unverified", email: "unverified@example.test", email_confirmed_at: null},
  ]
  const lookups: string[] = []
  let directoryDown = false
  const directory = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/auth/v1/admin/users") return new Response(null, {status: 404})
      if (directoryDown) return new Response(null, {status: 503})
      if (req.headers.get("apikey") !== "sb_secret_directory_test") return new Response(null, {status: 401})
      lookups.push(url.searchParams.get("filter") ?? "")
      return Response.json({users: accounts})
    },
  })
  afterAll(() => directory.stop(true))
  beforeEach(() => {
    lookups.length = 0
    directoryDown = false
    process.env.SUPABASE_URL = directory.url.origin
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_directory_test"
  })

  test("the Store resolves a confirmed email to its Mentra user, created once and reused", async () => {
    const first = await store().resolveEmail("  verified@example.TEST ")
    const again = await store().resolveEmail("verified@example.test")

    expect(first).toEqual(expect.stringMatching(/^mu_/))
    expect(again).toBe(first)
    expect(lookups).toEqual(["verified@example.test", "verified@example.test"])
    const users = await UserModel.find({tenantId: "mentra", tenantUserId: "gt_verified"}).lean()
    expect(users.map(user => user.mentraUserId)).toEqual([first!])
  })

  test("it is the same Core user the person signs in as", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "gt_verified"})

    expect(await store().resolveEmail("verified@example.test")).toBe(mentraUserId)
    expect(await UserModel.countDocuments({})).toBe(1)
  })

  test("an account being deleted is nobody", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "gt_verified"})
    await UserModel.updateOne({mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})

    expect(await store().resolveEmail("verified@example.test")).toBeNull()
  })

  test("an unconfirmed or unknown email is nobody, and no Mentra user is created", async () => {
    expect(await store().resolveEmail("unverified@example.test")).toBeNull()
    expect(await store().resolveEmail("phone-only@example.test")).toBeNull()
    expect(await store().resolveEmail("nobody@example.test")).toBeNull()
    const reply = await raw("POST", `${API}/users/resolve-email`, {body: {email: "nobody@example.test"}})
    expect(reply.status).toBe(404)
    expect(reply.json).toEqual({error: "user_not_found"})
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("an account directory that cannot answer is an outage, never nobody", async () => {
    directoryDown = true
    const reply = await raw("POST", `${API}/users/resolve-email`, {body: {email: "verified@example.test"}})
    expect(reply.status).toBe(503)
    expect(reply.json?.error).not.toBe("user_not_found")
    await expectClientError(store().resolveEmail("verified@example.test"), "core_unavailable", 503)
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("a deployment without an account directory has nobody to resolve", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    expect(await store().resolveEmail("verified@example.test")).toBeNull()
    expect(lookups).toEqual([])
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("only a signed request from the Store may ask", async () => {
    await expectClientError(fleet().resolveEmail("verified@example.test"), "forbidden", 403)
    await expectClientError(
      clientFor("fleet", {secret: "store-s1"}).resolveEmail("verified@example.test"),
      "service_unauthorized",
      401,
    )
    await expectClientError(
      clientFor("store", {secret: "not-a-store-secret"}).resolveEmail("verified@example.test"),
      "service_unauthorized",
      401,
    )
    expect(lookups).toEqual([])
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("a body without an email address is 400 invalid_request", async () => {
    for (const body of [{}, {email: ""}, {email: "not-an-email"}, {email: 7}]) {
      const reply = await raw("POST", `${API}/users/resolve-email`, {body})
      expect({body, status: reply.status, error: reply.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    expect(lookups).toEqual([])
  })
})

// --- GET /changes ----------------------------------------------------------

describe("GET /changes", () => {
  /**
   * A workspace and three membership changes: the developer is made an admin, the member is removed and
   * the admin leaves. With the workspace's creation, the feed holds four events, in this order.
   */
  async function threeMembershipChanges() {
    const w = await newWorkspace()
    const revision = async () => (await getWorkspace(w.workspaceId))!.authorizationRevision
    const idOf = async (p: Person) =>
      (await WorkspaceMembershipModel.findOne({workspaceId: w.workspaceId, mentraUserId: p.mentraUserId}).lean())!.membershipId
    await changeRole(actorOf(w.owner), w.workspaceId, await idOf(w.developer), "admin", await revision())
    await removeMember(actorOf(w.owner), w.workspaceId, await idOf(w.member), await revision())
    await leaveWorkspace(actorOf(w.admin), w.workspaceId)
    return {...w, idOf}
  }

  const feedActions = ["workspace.created", "membership.role_changed", "membership.removed", "membership.left"]

  test("three membership changes appear in seq order, as the contract describes them", async () => {
    const w = await threeMembershipChanges()

    const {events, next} = await fleet().listChanges({})

    expect(events.map(event => [event.seq, event.action])).toEqual(feedActions.map((action, i) => [i + 1, action]))
    expect(next).toBeNull()
    expect(events.every(event => event.workspaceId === w.workspaceId)).toBe(true)
    expect(events[1]).toMatchObject({
      target: {mentraUserId: w.developer.mentraUserId},
      before: {role: "developer"},
      after: {role: "admin"},
    })
    expect(events[2]).toMatchObject({
      target: {mentraUserId: w.member.mentraUserId},
      before: {role: "member", status: "active"},
      after: {status: "ended", endedReason: "removed"},
    })
    expect(events[3]).toMatchObject({target: {mentraUserId: w.admin.mentraUserId}, after: {endedReason: "left"}})
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        ["action", "after", "before", "eventId", "occurredAt", "seq", "target", "workspaceId"],
      )
      expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt)
    }
    // The wire form is what the client returned: JSON of the same events.
    const reply = await raw("GET", `${API}/changes`, {service: "fleet", secret: "fleet-f1"})
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({events: JSON.parse(JSON.stringify(events)), next: null})
  })

  test("the Store may read the feed too", async () => {
    await threeMembershipChanges()

    expect((await store().listChanges({})).events.map(event => event.action)).toEqual(feedActions)
  })

  test("after pages through the feed without skipping or repeating an event", async () => {
    await threeMembershipChanges()

    const first = await fleet().listChanges({limit: 3})
    const second = await fleet().listChanges({after: first.next, limit: 3})
    const beyond = await fleet().listChanges({after: "4", limit: 3})
    const middle = await fleet().listChanges({after: "2"})

    expect(first.events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(first.next).toBe("3")
    expect(second.events.map(event => event.seq)).toEqual([4])
    expect(second.next).toBeNull()
    expect(beyond).toEqual({events: [], next: null})
    expect(middle.events.map(event => event.action)).toEqual(feedActions.slice(2))
    // One event at a time reaches the same end.
    const walked: number[] = []
    let after: string | null = null
    do {
      const page = await fleet().listChanges({after, limit: 1})
      walked.push(...page.events.map(event => event.seq))
      after = page.next
    } while (after !== null)
    expect(walked).toEqual([1, 2, 3, 4])
  })

  test("limit defaults to 100 and is clamped to between 1 and 500", async () => {
    const docs = Array.from({length: 600}, (_, i) => ({
      eventId: `01J${String(i).padStart(23, "0")}`,
      seq: i + 1,
      workspaceId: "ws_bulk",
      action: "bulk.event",
      actor: {kind: "system"},
      requestId: null,
      occurredAt: new Date(),
    }))
    await WorkspaceAuditEventModel.collection.insertMany(docs)
    const count = async (query: string) => (await raw("GET", `${API}/changes${query}`, {service: "fleet", secret: "fleet-f1"})).json.events.length

    expect(await count("")).toBe(100)
    expect(await count("?limit=1")).toBe(1)
    expect(await count("?limit=0")).toBe(1)
    expect(await count("?limit=-7")).toBe(1)
    expect(await count("?limit=500")).toBe(500)
    expect(await count("?limit=501")).toBe(500)
    expect(await count("?limit=100000")).toBe(500)
    expect((await fleet().listChanges({after: "550", limit: 100000})).next).toBeNull()
  })

  test("a limit or cursor that is not a number is 400 invalid_request", async () => {
    for (const query of [
      "?limit=abc",
      "?limit=",
      "?limit=1.5",
      "?limit=1e2",
      "?limit=0x10",
      "?limit=%201",
      "?after=abc",
      "?after=",
      "?after=-1",
      "?after=1.5",
      "?after=01",
      "?after=9007199254740993",
    ]) {
      const reply = await raw("GET", `${API}/changes${query}`, {service: "fleet", secret: "fleet-f1"})
      expect({query, status: reply.status, error: reply.json?.error}).toEqual({
        query,
        status: 400,
        error: "invalid_request",
      })
    }
  })

  test("an unsigned request is 401, as is one signed with another service's secret", async () => {
    await threeMembershipChanges()

    const unsigned = await send("GET", `${API}/changes`, {})
    const wrongSecret = await raw("GET", `${API}/changes`, {service: "fleet", secret: "store-s1"})
    const unknownSecret = await raw("GET", `${API}/changes`, {service: "fleet", secret: "not-a-secret"})
    const tampered = await raw("GET", `${API}/changes?after=0`, {
      service: "fleet",
      secret: "fleet-f1",
      signedPath: `${API}/changes?after=3`,
    })

    for (const reply of [unsigned, wrongSecret, unknownSecret, tampered]) {
      expect({status: reply.status, body: reply.json}).toEqual({status: 401, body: {error: "service_unauthorized"}})
    }
    await expectClientError(
      clientFor("fleet", {secret: "not-a-secret"}).listChanges({}),
      "service_unauthorized",
      401,
    )
  })

  test("credential-looking keys are removed at any depth, and the stored event is not changed", async () => {
    const {workspaceId} = await newWorkspace()
    await withTransaction(session =>
      recordWorkspaceEvent(session, {
        workspaceId,
        action: "test.secrets",
        actor: {kind: "system"},
        target: {credentialId: "c_1", token: "msk_t.s", inner: {list: [{password: "p", hashed: "h", keep: "yes"}]}},
        before: {secretValue: "s", role: "member"},
        after: {deep: {deeper: {deepest: {Token: "t", ok: 1}}}},
      }),
    )

    const reply = await raw("GET", `${API}/changes?limit=500`, {service: "fleet", secret: "fleet-f1"})
    const event = reply.json.events.find((e: {action: string}) => e.action === "test.secrets")

    expect(event).toMatchObject({
      target: {credentialId: "c_1", inner: {list: [{keep: "yes"}]}},
      before: {role: "member"},
      after: {deep: {deeper: {deepest: {ok: 1}}}},
    })
    for (const secret of ["msk_t", "password", "hashed", "secretValue", "Token"]) expect(reply.text).not.toContain(secret)
    const stored = await WorkspaceAuditEventModel.findOne({action: "test.secrets"}).lean()
    expect(JSON.stringify(stored)).toContain("msk_t.s")
  })

  test("events from before the feed and organization-level events are never listed", async () => {
    await WorkspaceAuditEventModel.collection.insertOne({
      eventId: "01H00000000000000000000001",
      workspaceId: "ws_old",
      action: "workspace.created",
      actor: {kind: "system"},
      requestId: null,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    await recordOrganizationEvent({workspaceId: null, action: "credential.created", actor: {kind: "system"}, target: {}})
    const w = await newWorkspace()

    const {events, next} = await fleet().listChanges({limit: 1})

    expect(events.map(event => [event.seq, event.workspaceId, event.action])).toEqual([
      [1, w.workspaceId, "workspace.created"],
    ])
    expect(next).toBe("1")
    expect(await fleet().listChanges({after: next, limit: 1})).toEqual({events: [], next: null})
  })

  test("a user.deleted tombstone is listed with no workspace and no snapshots", async () => {
    // Account deletion itself is exercised in account-deletion.integration.test.ts; this is the route's view of it.
    await withTransaction(session =>
      recordWorkspaceEvent(session, {
        workspaceId: null,
        action: "user.deleted",
        actor: {kind: "user", mentraUserId: "mu_gone"},
        target: {mentraUserId: "mu_gone"},
      }),
    )

    const {events} = await fleet().listChanges({})

    expect(events).toEqual([
      {
        eventId: expect.any(String),
        seq: 1,
        workspaceId: null,
        action: "user.deleted",
        occurredAt: expect.any(String),
        target: {mentraUserId: "mu_gone"},
        before: null,
        after: null,
      },
    ])
  })

  test("is a read: other methods are not routed", async () => {
    const reply = await raw("POST", `${API}/changes`, {service: "fleet", secret: "fleet-f1", body: {}})

    expect(reply.status).toBe(404)
  })
})

// --- Body limit ------------------------------------------------------------

describe("request body limit", () => {
  const BODY_LIMIT = 64 * 1024
  const padded = (bytes: number) => JSON.stringify({token: "x".repeat(bytes - '{"token":""}'.length)})

  test("a body of exactly 64 KiB is read, one byte more is 413 payload_too_large", async () => {
    const atLimit = padded(BODY_LIMIT)
    const overLimit = padded(BODY_LIMIT + 1)
    expect(Buffer.byteLength(atLimit)).toBe(BODY_LIMIT)

    const accepted = await raw("POST", `${API}/principal`, {rawBody: atLimit})
    const refused = await raw("POST", `${API}/principal`, {rawBody: overLimit})

    expect(accepted.status).toBe(401)
    expect(accepted.json).toEqual({error: "invalid_token"})
    expect(refused.status).toBe(413)
    expect(refused.json).toEqual({error: "payload_too_large"})
  })

  test("the limit is checked before authentication", async () => {
    const reply = await send("POST", `${API}/principal`, {"content-type": "application/json"}, padded(BODY_LIMIT + 1))

    expect(reply.status).toBe(413)
    expect(reply.json).toEqual({error: "payload_too_large"})
  })

  test("a declared Content-Length over the limit is refused without reading the body", async () => {
    const reply = await send(
      "POST",
      `${API}/principal`,
      {"content-type": "application/json", "content-length": String(BODY_LIMIT + 1)},
      "{}",
    )

    expect(reply.status).toBe(413)
    expect(reply.json).toEqual({error: "payload_too_large"})
  })
})
