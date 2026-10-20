import crypto from "node:crypto"
import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import * as jose from "jose"

import authApi from "./auth.api"
import type {AppEnv} from "../../types/hono.types"
import * as session from "../../services/session.service"
import * as trustedEmail from "../../services/account/trusted-email.service"
import * as featuresService from "../../services/licenses/features.service"

const SIGNING_ENV = ["MENTRA_MINIAPP_JWT_PRIVATE_KEY", "MENTRA_MINIAPP_JWT_PUBLIC_KEY"] as const
const savedEnv = Object.fromEntries(SIGNING_ENV.map((key) => [key, process.env[key]]))
const mocks: Array<{mockRestore(): void}> = []
let featuresFor: ReturnType<typeof spyOn<typeof featuresService, "featuresFor">>

beforeEach(() => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = stripPem(privateKey.export({type: "pkcs8", format: "pem"}).toString())
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = stripPem(publicKey.export({type: "spki", format: "pem"}).toString())
  session.resetSigningKeyCache()
  // A person with no license: the lookup that reads the database answers nothing unless a test says so.
  featuresFor = spyOn(featuresService, "featuresFor").mockResolvedValue([])
  mocks.push(featuresFor)
  mocks.push(
    spyOn(session, "verifyAccessToken").mockResolvedValue({
      mentraUserId: "mu_01TEST",
      tenantId: "mentra",
      sessionId: "sess",
      jti: "jti",
      exp: Math.floor(Date.now() / 1000) + 300,
    } as never),
  )
})

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
  for (const key of SIGNING_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  session.resetSigningKeyCache()
})

describe("POST /miniapp-token email claims", () => {
  test("stamps the verified account email on every miniapp audience", async () => {
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue("wearer@example.com"))

    for (const packageName of ["com.mentra.call", "com.example.notes"]) {
      const claims = await verifiedClaims(await mint(packageName), packageName)
      expect(claims).toMatchObject({
        sub: "mu_01TEST",
        aud: packageName,
        iss: "cloud-core",
        tenantId: "mentra",
        email: "wearer@example.com",
        email_verified: true,
      })
    }
  })

  test("omits both claims when there is no verified email", async () => {
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null))

    const claims = await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")
    expect(claims.sub).toBe("mu_01TEST")
    expect("email" in claims).toBe(false)
    expect("email_verified" in claims).toBe(false)
  })

  test("still issues the token when the account lookup fails", async () => {
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockRejectedValue(new Error("GoTrue timed out")))

    const claims = await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")
    expect(claims.sub).toBe("mu_01TEST")
    expect("email" in claims).toBe(false)
  })

  test("does not wait past the deadline for a stalled account lookup", async () => {
    let signal: AbortSignal | undefined
    mocks.push(
      spyOn(trustedEmail, "trustedAccountEmail").mockImplementation((_id, options) => {
        signal = options?.signal
        return new Promise(() => {})
      }),
    )

    const started = Date.now()
    const claims = await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")
    expect(Date.now() - started).toBeLessThan(3_000)
    expect("email" in claims).toBe(false)
    expect(signal?.aborted).toBe(true)
  })
})

describe("POST /miniapp-token for development builds", () => {
  test("mints from the access token and package name alone, without verifying or calling anything else", async () => {
    // A dev build of a package is that package: the phone applies the signer
    // rule and Core mints exactly what it mints for the installed miniapp.
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null))
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("the miniapp-token route must not call another service")
    }) as never)
    mocks.push(fetchSpy)

    // A field left over from an older dev QR is ignored, never verified.
    for (const body of [{packageName: "com.example.dev"}, {packageName: "com.example.dev", devAttestation: "old-qr"}]) {
      const app = new Hono<AppEnv>().route("/", authApi)
      const response = await app.request("/miniapp-token", {
        method: "POST",
        headers: {Authorization: "Bearer access", "Content-Type": "application/json"},
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      const claims = await verifiedClaims(((await response.json()) as {token: string}).token, "com.example.dev")
      expect(claims).toMatchObject({sub: "mu_01TEST", aud: "com.example.dev", tenantId: "mentra"})
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("POST /miniapp-token features", () => {
  beforeEach(() => {
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null))
  })

  test("puts the person's licensed features for the package in the token, as sorted by the lookup", async () => {
    featuresFor.mockResolvedValue(["call.recording", "call.unlimited"])

    const before = Date.now()
    const claims = await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")
    expect(claims.features).toEqual(["call.recording", "call.unlimited"])

    expect(featuresFor).toHaveBeenCalledTimes(1)
    const args = featuresFor.mock.calls[0]![0]
    expect(args).toMatchObject({mentraUserId: "mu_01TEST", packageName: "com.mentra.call"})
    expect(args.now).toBeInstanceOf(Date)
    expect(args.now.getTime()).toBeGreaterThanOrEqual(before)
    expect(args.now.getTime()).toBeLessThanOrEqual(Date.now())
  })

  test("looks features up for the package the phone asked for", async () => {
    featuresFor.mockImplementation(async ({packageName}) =>
      packageName === "com.mentra.call" ? ["call.unlimited"] : [],
    )

    expect((await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")).features).toEqual([
      "call.unlimited",
    ])
    const other = await verifiedClaims(await mint("com.example.notes"), "com.example.notes")
    expect("features" in other).toBe(false)
    expect(featuresFor.mock.calls.map(([args]) => args.packageName)).toEqual(["com.mentra.call", "com.example.notes"])
  })

  test("leaves the features claim out when the person has none", async () => {
    featuresFor.mockResolvedValue([])

    const claims = await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")
    expect(claims.sub).toBe("mu_01TEST")
    expect("features" in claims).toBe(false)
  })

  test("keeps the other claims beside features", async () => {
    featuresFor.mockResolvedValue(["call.unlimited"])
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue("wearer@example.com"))

    expect(await verifiedClaims(await mint("com.mentra.call"), "com.mentra.call")).toMatchObject({
      sub: "mu_01TEST",
      aud: "com.mentra.call",
      tenantId: "mentra",
      email: "wearer@example.com",
      email_verified: true,
      features: ["call.unlimited"],
    })
  })

  test("answers 503 features_unavailable and mints nothing when the lookup fails", async () => {
    featuresFor.mockRejectedValue(new Error("mongo unavailable"))
    const issue = spyOn(session, "issueMiniappToken")
    mocks.push(issue)

    const response = await postMiniappToken({packageName: "com.mentra.call"})
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "features_unavailable"})
    expect(issue).not.toHaveBeenCalled()
  })

  test("the request after a failed lookup looks the features up again", async () => {
    featuresFor.mockRejectedValueOnce(new Error("mongo unavailable")).mockResolvedValue(["call.unlimited"])
    const issue = spyOn(session, "issueMiniappToken")
    mocks.push(issue)

    expect((await postMiniappToken({packageName: "com.mentra.call"})).status).toBe(503)
    expect(issue).toHaveBeenCalledTimes(0)
    const retry = await postMiniappToken({packageName: "com.mentra.call"})
    expect(retry.status).toBe(200)
    expect(issue).toHaveBeenCalledTimes(1)
    expect(featuresFor).toHaveBeenCalledTimes(2)
    expect((await verifiedClaims(((await retry.json()) as {token: string}).token, "com.mentra.call")).features).toEqual(
      ["call.unlimited"],
    )
  })

  test("answers 503 features_unavailable at the deadline, and mints nothing, when the lookup never settles", async () => {
    featuresFor.mockImplementation(() => new Promise(() => {}))
    const issue = spyOn(session, "issueMiniappToken")
    mocks.push(issue)

    const started = Date.now()
    const response = await postMiniappToken({packageName: "com.mentra.call"})
    const elapsed = Date.now() - started

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "features_unavailable"})
    // The same 1.5 s the email lookup gets: not before it, and not much after it.
    expect(elapsed).toBeGreaterThanOrEqual(1_400)
    expect(elapsed).toBeLessThan(3_000)
    expect(issue).not.toHaveBeenCalled()
  })

  test("a lookup that fails after its deadline is not an unhandled rejection", async () => {
    let failLate: (error: Error) => void = () => {}
    featuresFor.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failLate = reject
        }),
    )
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      expect((await postMiniappToken({packageName: "com.mentra.call"})).status).toBe(503)
      failLate(new Error("mongo came back with an error"))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("does not look features up for a request that has no package", async () => {
    // The route throws the RFC 400 for the app's error handler, which this bare router does not mount.
    expect((await postMiniappToken({})).status).not.toBe(200)
    expect(featuresFor).not.toHaveBeenCalled()
  })
})

async function postMiniappToken(body: unknown): Promise<Response> {
  const app = new Hono<AppEnv>().route("/", authApi)
  return app.request("/miniapp-token", {
    method: "POST",
    headers: {Authorization: "Bearer access", "Content-Type": "application/json"},
    body: JSON.stringify(body),
  })
}

async function mint(packageName: string): Promise<string> {
  const response = await postMiniappToken({packageName})
  expect(response.status).toBe(200)
  return ((await response.json()) as {token: string}).token
}

/** Verify signature, issuer and audience against the miniapp-token public key. */
async function verifiedClaims(token: string, audience: string): Promise<jose.JWTPayload> {
  const pem = `-----BEGIN PUBLIC KEY-----\n${process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  const key = await jose.importSPKI(pem, "EdDSA")
  return (await jose.jwtVerify(token, key, {issuer: "cloud-core", audience})).payload
}

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "")
}
