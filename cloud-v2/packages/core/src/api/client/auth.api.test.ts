import crypto from "node:crypto"
import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import * as jose from "jose"

import authApi from "./auth.api"
import type {AppEnv} from "../../types/hono.types"
import * as session from "../../services/session.service"
import * as trustedEmail from "../../services/account/trusted-email.service"

const SIGNING_ENV = ["MENTRA_MINIAPP_JWT_PRIVATE_KEY", "MENTRA_MINIAPP_JWT_PUBLIC_KEY"] as const
const savedEnv = Object.fromEntries(SIGNING_ENV.map((key) => [key, process.env[key]]))
const mocks: Array<{mockRestore(): void}> = []

beforeEach(() => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = stripPem(privateKey.export({type: "pkcs8", format: "pem"}).toString())
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = stripPem(publicKey.export({type: "spki", format: "pem"}).toString())
  session.resetSigningKeyCache()
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
})

async function mint(packageName: string): Promise<string> {
  const app = new Hono<AppEnv>().route("/", authApi)
  const response = await app.request("/miniapp-token", {
    method: "POST",
    headers: {Authorization: "Bearer access", "Content-Type": "application/json"},
    body: JSON.stringify({packageName}),
  })
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
