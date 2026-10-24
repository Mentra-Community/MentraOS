/**
 * @fileoverview The age a person declared: `GET` and `PUT /api/account/declared-age`, and the same two fields on
 * `GET /api/account/me`.
 *
 * Everything runs through the real app against a local replica set. The access token's verification is stubbed to
 * name the signed-in account, and the account directory (GoTrue) answers `/me`'s identity lookup.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The database is
 * dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/declared-age.integration.test.ts`
 */

import crypto from "node:crypto"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import * as jose from "jose"

import {resetAccountRateLimits} from "../packages/core/src/api/account/rate-limit"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {UserModel} from "../packages/core/src/models/user.model"
import * as gotrue from "../packages/core/src/services/account/gotrue.client"
import * as trustedEmail from "../packages/core/src/services/account/trusted-email.service"
import * as session from "../packages/core/src/services/session.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {applyEnv} from "./support/signin-harness"

setDefaultTimeout(30_000)

const BASE = "https://core.test"
const strip = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
/** Who the access token names, and its tenant. */
let signedIn = {mentraUserId: "mu_alice", tenantId: "mentra"}
const mocks: Array<{mockRestore(): void}> = []

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("declared-age")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await UserModel.createCollection()
  await UserModel.syncIndexes()
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  if (verified && UserModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  restoreEnv = applyEnv({
    CLOUD_CORE_ENABLED_FEATURES: undefined,
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  })
  session.resetSigningKeyCache()
  resetAccountRateLimits()
  signedIn = {mentraUserId: "mu_alice", tenantId: "mentra"}
  mocks.push(
    spyOn(session, "verifyAccessToken").mockImplementation(
      async () =>
        ({
          ...signedIn,
          sessionId: "sess",
          jti: "jti",
          exp: Math.floor(Date.now() / 1000) + 300,
        }) as never,
    ),
    spyOn(gotrue, "getUserById").mockImplementation(
      async (id) =>
        ({id, email: "alice@example.com", emailVerified: true, emailConfirmed: true, name: "Alice"}) as never,
    ),
    spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null),
  )
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await UserModel.deleteMany({})
  await UserModel.create([
    {mentraUserId: "mu_alice", tenantId: "mentra", tenantUserId: "sb-alice"},
    {mentraUserId: "mu_oem", tenantId: "acme-oem", tenantUserId: "acme-42"},
  ])
})

afterEach(() => {
  setSystemTime()
  for (const mock of mocks.splice(0)) mock.mockRestore()
  restoreEnv()
  session.resetSigningKeyCache()
})

function call(method: "GET" | "PUT", path: string, body?: unknown): Promise<Response> {
  return app.request(`${BASE}${path}`, {
    method,
    headers: {"Authorization": "Bearer access", "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: typeof body === "string" ? body : JSON.stringify(body)}),
  })
}

async function declare(age: unknown): Promise<Response> {
  return call("PUT", "/api/account/declared-age", {age})
}

describe("the declared age", () => {
  test("is empty until the person answers", async () => {
    const response = await call("GET", "/api/account/declared-age")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({declaredAge: null, declaredAgeAt: null})
  })

  test("keeps the answer with the time it was given, and answers it back", async () => {
    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    const put = await declare(15)
    expect(put.status).toBe(200)
    expect(put.headers.get("cache-control")).toBe("no-store")
    expect(await put.json()).toEqual({declaredAge: 15, declaredAgeAt: "2026-10-24T08:00:00.000Z"})

    expect(await (await call("GET", "/api/account/declared-age")).json()).toEqual({
      declaredAge: 15,
      declaredAgeAt: "2026-10-24T08:00:00.000Z",
    })
    const user = await UserModel.findOne({mentraUserId: "mu_alice"}).lean()
    expect(user?.declaredAge).toBe(15)
    expect(user?.declaredAgeAt?.toISOString()).toBe("2026-10-24T08:00:00.000Z")
  })

  test("a later answer replaces the earlier one and its date", async () => {
    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    await declare(12)
    setSystemTime(new Date("2027-01-02T09:30:00.000Z"))
    expect(await (await declare(19)).json()).toEqual({declaredAge: 19, declaredAgeAt: "2027-01-02T09:30:00.000Z"})
  })

  test.each([
    ["zero", 0],
    ["an age past 120", 121],
    ["a fraction", 12.5],
    ["text", "15"],
    ["nothing", null],
  ])("refuses %s and keeps nothing", async (_label, age) => {
    const response = await declare(age)
    expect(response.status).toBe(400)
    expect(((await response.json()) as {error: string}).error).toBe("invalid_request")
    expect(await (await call("GET", "/api/account/declared-age")).json()).toEqual({declaredAge: null, declaredAgeAt: null})
  })

  test("refuses a body that isn't a JSON object", async () => {
    const response = await call("PUT", "/api/account/declared-age", "15")
    expect(response.status).toBe(400)
  })

  test("needs a signed-in account", async () => {
    const response = await app.request(`${BASE}/api/account/declared-age`, {method: "GET"})
    expect(response.status).toBe(400)
    expect(((await response.json()) as {error: string}).error).toBe("invalid_request")
  })

  test("is the signed-in account's own: another account sees none of it", async () => {
    await declare(30)
    signedIn = {mentraUserId: "mu_oem", tenantId: "acme-oem"}
    expect(await (await call("GET", "/api/account/declared-age")).json()).toEqual({declaredAge: null, declaredAgeAt: null})
  })

  test("an account from another app's sign-in keeps one too, though the rest of the account surface is Mentra's", async () => {
    signedIn = {mentraUserId: "mu_oem", tenantId: "acme-oem"}
    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    expect((await declare(40)).status).toBe(200)
    expect(await (await call("GET", "/api/account/declared-age")).json()).toEqual({
      declaredAge: 40,
      declaredAgeAt: "2026-10-24T08:00:00.000Z",
    })
    expect((await call("GET", "/api/account/me")).status).toBe(403)
  })

  test("a deleted account can't keep one", async () => {
    await UserModel.updateOne({mentraUserId: "mu_alice"}, {$set: {supportTelemetryDeletedAt: new Date()}})
    expect((await declare(15)).status).toBe(400)
    const user = await UserModel.findOne({mentraUserId: "mu_alice"}).lean()
    expect(user?.declaredAge).toBeNull()
  })
})

describe("GET /api/account/me", () => {
  test("carries both fields: empty until the person answers, then the answer and its date", async () => {
    const me = await call("GET", "/api/account/me")
    expect(me.headers.get("cache-control")).toBe("no-store")
    const before = (await me.json()) as Record<string, unknown>
    expect(before).toMatchObject({mentraUserId: "mu_alice", email: "alice@example.com", declaredAge: null, declaredAgeAt: null})

    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    await declare(17)
    const after = (await (await call("GET", "/api/account/me")).json()) as Record<string, unknown>
    expect(after).toMatchObject({
      mentraUserId: "mu_alice",
      email: "alice@example.com",
      declaredAge: 17,
      declaredAgeAt: "2026-10-24T08:00:00.000Z",
    })
  })
})

describe("what Core never shares", () => {
  test("a miniapp token carries nothing about the person's age", async () => {
    await declare(17)
    const response = await app.request(`${BASE}/api/client/auth/miniapp-token`, {
      method: "POST",
      headers: {"Authorization": "Bearer access", "Content-Type": "application/json"},
      body: JSON.stringify({packageName: "com.example.notes"}),
    })
    expect(response.status).toBe(200)
    const {token} = (await response.json()) as {token: string}
    const claims = jose.decodeJwt(token)
    expect(Object.keys(claims).filter((claim) => /age/i.test(claim))).toEqual([])
    expect(Object.values(claims)).not.toContain(17)
  })
})
