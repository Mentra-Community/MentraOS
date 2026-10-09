/**
 * @fileoverview The miniapp-token route without a database.
 *
 * A dev build of a package is that package: the phone decides which package is
 * running and applies the signer rule, and Core mints the same token as for an
 * installed miniapp. The revocation lookup is stubbed so the real middleware,
 * handler and signing keys run without Mongo; the cross-service flow against a
 * local Mongo is covered by `tests/cloud-client.miniapp-token.integration.test.ts`.
 */

import {afterAll, afterEach, beforeAll, expect, spyOn, test} from "bun:test"
import crypto from "node:crypto"
import {resetMentraKeyCache} from "@mentra/cloud-shared"
import {Hono} from "hono"
import * as jose from "jose"
import {RevokedJtiModel} from "../../models/revoked-jti.model"
import {resetSigningKeyCache} from "../../services/session.service"
import type {AppEnv} from "../../types/hono.types"
import authApi from "./auth.api"

const ENV_KEYS = [
  "MENTRA_JWT_PRIVATE_KEY",
  "MENTRA_JWT_PUBLIC_KEY",
  "MENTRA_MINIAPP_JWT_PRIVATE_KEY",
  "MENTRA_MINIAPP_JWT_PUBLIC_KEY",
  "CLOUD_CORE_ISSUER",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const access = crypto.generateKeyPairSync("ed25519")
const miniapp = crypto.generateKeyPairSync("ed25519")
const app = new Hono<AppEnv>().route("/api/client/auth", authApi)
let revokedLookup: ReturnType<typeof spyOn> | undefined
let fetchSpy: ReturnType<typeof spyOn> | undefined

function pemBody(key: crypto.KeyObject, type: "pkcs8" | "spki"): string {
  return key
    .export({type, format: "pem"})
    .toString()
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "")
}

async function accessToken(): Promise<string> {
  return new jose.SignJWT({tenant_id: "mentra", session_id: "sess_1"})
    .setProtectedHeader({alg: "EdDSA"})
    .setIssuer("cloud-core")
    .setAudience("cloud-core")
    .setSubject("mu_dev")
    .setJti("jti_1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(access.privateKey)
}

beforeAll(() => {
  process.env.MENTRA_JWT_PRIVATE_KEY = pemBody(access.privateKey, "pkcs8")
  process.env.MENTRA_JWT_PUBLIC_KEY = pemBody(access.publicKey, "spki")
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = pemBody(miniapp.privateKey, "pkcs8")
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = pemBody(miniapp.publicKey, "spki")
  delete process.env.CLOUD_CORE_ISSUER
  resetMentraKeyCache()
  resetSigningKeyCache()
})

afterEach(() => {
  revokedLookup?.mockRestore()
  fetchSpy?.mockRestore()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  resetMentraKeyCache()
  resetSigningKeyCache()
})

test("mints a package token from the access token and package name alone", async () => {
  revokedLookup = spyOn(RevokedJtiModel, "findOne").mockImplementation((() => ({lean: async () => null})) as never)
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("the miniapp-token route must not call another service")
  }) as never)

  // Fields other than packageName are ignored, never verified.
  for (const body of [{packageName: "com.example.dev"}, {packageName: "com.example.dev", devAttestation: "old-qr"}]) {
    const response = await app.request("/api/client/auth/miniapp-token", {
      method: "POST",
      headers: {authorization: `Bearer ${await accessToken()}`, "content-type": "application/json"},
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    const {token} = (await response.json()) as {token: string}
    const {payload} = await jose.jwtVerify(token, miniapp.publicKey, {audience: "com.example.dev", issuer: "cloud-core"})
    expect(payload.sub).toBe("mu_dev")
    expect(payload.tenantId).toBe("mentra")
  }
  expect(fetchSpy).not.toHaveBeenCalled()
})
