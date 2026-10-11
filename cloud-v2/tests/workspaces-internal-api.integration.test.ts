/**
 * @fileoverview Internal workspace service API tests (`/api/internal/workspaces`).
 *
 * The Store calls this API with the contract's `createCoreWorkspaceClient`.
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
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createSession, resetSigningKeyCache} from "../packages/core/src/services/session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {createWorkspaceCredential, revokeCredential} from "../packages/core/src/services/workspaces/credential.service"
import {
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
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
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
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
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const SERVICE_SECRETS = {store: ["store-s1", "store-s0"]}
const BASE = "https://core.test"
const API = "/api/internal/workspaces"
/** A web client of this deployment (`CLOUD_CORE_WEB_CLIENT_IDS`), as the Developer Console's server is. */
const WEB_CLIENT = "console-client"
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
  /** A Supabase access token issued to a web client, as the Store receives it. */
  bearer: string
  sub: string
  email: string
  mentraUserId: string
}

/**
 * A person with a Supabase account (confirmed email unless told otherwise) and a bearer token for a
 * web client. Their Core user is the one the phone has: `("mentra", sub)`.
 */
async function person(key: string, options: {email?: string; emailConfirmed?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  idp.registerUser({sub, email, emailConfirmed: options.emailConfirmed ?? true})
  const bearer = await idp.mint({sub, aud: "authenticated", client_id: WEB_CLIENT, email})
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
 * signed with a key generated for this test. The signing key cache is reset on the way in and out.
 */
async function withPhoneCoreToken<T>(sub: string, use: (token: string) => Promise<T>): Promise<T> {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519")
  const restore = applyEnv({
    MENTRA_JWT_PRIVATE_KEY: pemBody(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_JWT_PUBLIC_KEY: pemBody(publicKey.export({type: "spki", format: "pem"}).toString()),
    REFRESH_TOKEN_PEPPER: "internal-api-test-pepper",
  })
  resetSigningKeyCache()
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
    resetSigningKeyCache()
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
async function raw(method: "GET" | "POST", pathWithQuery: string, options: RawOptions = {}): Promise<Reply> {
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
  if (method === "POST") headers["content-type"] = "application/json"
  return send(method, pathWithQuery, headers, method === "POST" ? body : undefined)
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
    for (const service of ["other", "fleet", "core", "STORE", "", "__proto__", "constructor", "toString"]) {
      const reply = await probe({service, secret: "store-s1"})
      expect({service, status: reply.status, body: reply.json}).toEqual({
        service,
        status: 401,
        body: {error: "service_unauthorized"},
      })
    }
    await expectClientError(clientFor("fleet").getWorkspace("ws_1"), "service_unauthorized", 401)
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

    expect((await probe({service: "fleet", secret: "fleet-f1"})).status).toBe(401)
    expect((await probe({service: "other", secret: "o-1"})).status).toBe(401)
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
    const claiming = await idp.mint({
      sub: claimant.sub,
      aud: "authenticated",
      client_id: WEB_CLIENT,
      email: ADMIN_EMAIL,
      email_verified: true,
      user_metadata: {email_verified: true},
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

  test("an identity provider that cannot be asked is 503 temporarily_unavailable, retryable", async () => {
    const {workspaceId} = await newWorkspace()
    const newcomer = await person("newcomer")
    idp.outage = true

    const reply = await raw("POST", `${API}/authorize`, {
      body: {credential: {type: "bearer", token: newcomer.bearer}, workspaceId},
    })

    expect(reply.status).toBe(503)
    expect(reply.json).toMatchObject({error: "temporarily_unavailable"})
    await expectClientError(
      store().authorize({credential: {type: "bearer", token: newcomer.bearer}, workspaceId}),
      "core_unavailable",
      503,
    )

    // Once the provider answers, the same token works.
    idp.outage = false
    expect(await store().authorize({credential: {type: "bearer", token: newcomer.bearer}, workspaceId})).toMatchObject({
      allowed: false,
      reason: "not_a_member",
    })
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

  test("the person is the phone's Core user, created on first sight of the token", async () => {
    idp.registerUser({sub: "supa-first-sight", email: "first@example.test", emailConfirmed: true})
    const bearer = await idp.mint({sub: "supa-first-sight", aud: "authenticated", client_id: WEB_CLIENT})
    expect(await UserModel.countDocuments({tenantUserId: "supa-first-sight"})).toBe(0)

    const resolved = await store().resolvePrincipal(bearer)

    const user = await UserModel.findOne({tenantId: "mentra", tenantUserId: "supa-first-sight"}).lean()
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

  test("email verification comes from the account directory, never from the token", async () => {
    const unconfirmed = await person("unconfirmed", {email: ADMIN_EMAIL, emailConfirmed: false})
    const claiming = await idp.mint({
      sub: unconfirmed.sub,
      aud: "authenticated",
      client_id: WEB_CLIENT,
      email: ADMIN_EMAIL,
      email_verified: true,
      user_metadata: {email_verified: true},
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
      // Signed with a key the provider never published.
      await idp.mint({sub: "supa-owner", aud: "authenticated", client_id: WEB_CLIENT}, {alg: "RS256", key: "attacker"}),
      // Expired.
      await idp.mint({sub: "supa-owner", aud: "authenticated", client_id: WEB_CLIENT, iat: Math.floor(Date.now() / 1000) - 7200}),
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

  test("an ID token, a phone's Supabase session token and another client's token are refused with 401 invalid_token", async () => {
    const owner = await person("owner")
    const refused = {
      // An ID token is addressed to the client, not to Supabase's API.
      idToken: await idp.mint({sub: owner.sub, aud: WEB_CLIENT, client_id: WEB_CLIENT, email: owner.email}),
      // A phone's Supabase session: no client, so it is only good for the phone's token exchange.
      phoneSession: await idp.mint({sub: owner.sub, aud: "authenticated", role: "authenticated", email: owner.email}),
      // A client that is not one of this deployment's web clients.
      otherClient: await idp.mint({sub: owner.sub, aud: "authenticated", client_id: "mobile-client", email: owner.email}),
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

  test("an identity provider that cannot be asked is 503 temporarily_unavailable, not a 401 that reads as a bad token", async () => {
    const newcomer = await person("newcomer")
    idp.outage = true

    const reply = await raw("POST", `${API}/principal`, {body: {token: newcomer.bearer}})

    expect(reply.status).toBe(503)
    expect(reply.json).toMatchObject({error: "temporarily_unavailable"})
    await expectClientError(store().resolvePrincipal(newcomer.bearer), "core_unavailable", 503)
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
    await expectClientError(clientFor("fleet").mintServiceCredential(input(workspaceId)), "service_unauthorized", 401)
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
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
    await expectClientError(clientFor("fleet").resolveEmail("verified@example.test"), "service_unauthorized", 401)
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
