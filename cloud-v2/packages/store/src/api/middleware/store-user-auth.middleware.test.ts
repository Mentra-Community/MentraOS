import crypto from "node:crypto"
import {beforeAll, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import * as jose from "jose"

import {optionalStoreUserAuth, storeUserAuth} from "./store-user-auth.middleware"
import type {AppEnv} from "../../types/hono.types"

/**
 * A genuinely valid Cloud Core access token: correct key, issuer, audience and
 * claims. The Store used to accept exactly this, so a weaker fixture (an
 * unsigned or wrong-key token) would pass whether or not the Core branch is
 * still there, and would not guard the boundary at all.
 */
let coreAccessToken: string

beforeAll(async () => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  const spki = publicKey.export({type: "spki", format: "pem"}).toString()
  process.env.MENTRA_JWT_PUBLIC_KEY = spki
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "")

  const signingKey = await jose.importPKCS8(
    privateKey.export({type: "pkcs8", format: "pem"}).toString(),
    "EdDSA",
  )
  coreAccessToken = await new jose.SignJWT({tenant_id: "mentra", session_id: "session-1"})
    .setProtectedHeader({alg: "EdDSA", kid: "mentra-core-1"})
    .setIssuer("cloud-core")
    .setAudience("cloud-core")
    .setSubject("user-1")
    .setJti("jti-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey)
})

function app() {
  return new Hono<AppEnv>()
    .get("/guarded", storeUserAuth, (c) => c.json({ok: true}))
    .get("/public", optionalStoreUserAuth, (c) => c.json({user: c.var.user ?? null}))
}

describe("Store credential boundary", () => {
  test("refuses a valid Core access token instead of honouring another service's audience", async () => {
    // The Store's routes lived inside Core once, so `aud=cloud-core` was a
    // correct credential here. Accepting it after the extraction makes a leak
    // anywhere a leak everywhere — and is what forced the phone host to know
    // the Store's origin so it could police where that token travelled.
    const response = await app().request("/guarded", {
      headers: {authorization: `Bearer ${coreAccessToken}`},
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({error: "unauthorized"})
  })

  test.each([
    ["absent", undefined],
    ["not a bearer", "Basic abc"],
    ["an empty bearer", "Bearer   "],
  ])("answers 401 rather than throwing when the credential is %s", async (_label, authorization) => {
    const response = await app().request("/guarded", authorization ? {headers: {authorization}} : undefined)
    expect(response.status).toBe(401)
  })

  test("leaves an anonymous public request unauthenticated rather than rejecting it", async () => {
    const response = await app().request("/public")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({user: null})
  })
})
