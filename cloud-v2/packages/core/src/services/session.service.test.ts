import crypto from "node:crypto"
import {afterEach, describe, expect, spyOn, test} from "bun:test"
import * as jose from "jose"

import {RefreshTokenModel} from "../models/refresh-token.model"
import {RevokedJtiModel} from "../models/revoked-jti.model"
import {getPublicJwks, issueRuntimeToken, resetSigningKeyCache, revokeSession} from "./session.service"

const savedEnv = {
  MENTRA_JWT_PRIVATE_KEY: process.env.MENTRA_JWT_PRIVATE_KEY,
  MENTRA_JWT_PUBLIC_KEY: process.env.MENTRA_JWT_PUBLIC_KEY,
  MENTRA_MINIAPP_JWT_PRIVATE_KEY: process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY,
  MENTRA_MINIAPP_JWT_PUBLIC_KEY: process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY,
  MENTRA_ACCOUNT_JWT_PRIVATE_KEY: process.env.MENTRA_ACCOUNT_JWT_PRIVATE_KEY,
  MENTRA_ACCOUNT_JWT_PUBLIC_KEY: process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY,
  CLOUD_CORE_ISSUER: process.env.CLOUD_CORE_ISSUER,
}

afterEach(() => {
  restoreEnv("MENTRA_JWT_PRIVATE_KEY", savedEnv.MENTRA_JWT_PRIVATE_KEY)
  restoreEnv("MENTRA_JWT_PUBLIC_KEY", savedEnv.MENTRA_JWT_PUBLIC_KEY)
  restoreEnv("MENTRA_MINIAPP_JWT_PRIVATE_KEY", savedEnv.MENTRA_MINIAPP_JWT_PRIVATE_KEY)
  restoreEnv("MENTRA_MINIAPP_JWT_PUBLIC_KEY", savedEnv.MENTRA_MINIAPP_JWT_PUBLIC_KEY)
  restoreEnv("MENTRA_ACCOUNT_JWT_PRIVATE_KEY", savedEnv.MENTRA_ACCOUNT_JWT_PRIVATE_KEY)
  restoreEnv("MENTRA_ACCOUNT_JWT_PUBLIC_KEY", savedEnv.MENTRA_ACCOUNT_JWT_PUBLIC_KEY)
  restoreEnv("CLOUD_CORE_ISSUER", savedEnv.CLOUD_CORE_ISSUER)
  resetSigningKeyCache()
})

describe("Core JWKS", () => {
  test("publishes the kid used by Core-brokered runtime tokens", async () => {
    setSigningEnv()

    const [{token}, jwks] = await Promise.all([
      issueRuntimeToken({mentraUserId: "user-1", tenantId: "oem-1"}),
      getPublicJwks(),
    ])

    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as {
      kid: string
    }
    const kids = jwks.keys.map((key) => key.kid)

    expect(header.kid).toBe("cloud-core-runtime-1")
    expect(kids).toContain(header.kid)
    expect(kids).toContain("mentra-access-1")
    expect(kids).toContain("mentra-miniapp-1")
  })

  test("uses the deployment Core issuer and carries federated identity into Runtime", async () => {
    setSigningEnv()
    process.env.CLOUD_CORE_ISSUER = "https://core.workspace.example"

    const {token} = await issueRuntimeToken({
      mentraUserId: "mu_01TEST",
      tenantId: "acme-private",
      sessionId: "sess_01TEST",
      federatedIdentity: {
        providerId: "workforce",
        providerKind: "microsoft-entra",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
        subject: "employee-object-id",
        directoryTenantId: "tenant",
      },
    })

    expect(jose.decodeJwt(token)).toMatchObject({
      iss: "https://core.workspace.example",
      sub: "mu_01TEST",
      tenant_id: "acme-private",
      session_id: "sess_01TEST",
      federated_identity: {
        provider_kind: "microsoft-entra",
        subject: "employee-object-id",
        directory_tenant_id: "tenant",
      },
    })
  })
})

describe("revokeSession", () => {
  test("blacklists the access token before deleting the refresh token", async () => {
    const order: string[] = []
    const blacklist = spyOn(RevokedJtiModel, "updateOne").mockImplementation((() => {
      order.push("blacklist")
      return Promise.resolve({acknowledged: true})
    }) as never)
    const deleteRefresh = spyOn(RefreshTokenModel, "deleteOne").mockImplementation((() => {
      order.push("delete-refresh")
      return Promise.resolve({acknowledged: true, deletedCount: 1})
    }) as never)
    try {
      await revokeSession({sessionId: "sess_1", accessToken: {jti: "jti-1", expiresAt: 1_900_000_000}})
      expect(order).toEqual(["blacklist", "delete-refresh"])
      expect(blacklist).toHaveBeenCalledWith(
        {jti: "jti-1"},
        {$set: {expiresAt: new Date(1_900_000_000 * 1000)}},
        {upsert: true},
      )
    } finally {
      blacklist.mockRestore()
      deleteRefresh.mockRestore()
    }
  })

  test("keeps the refresh token when the blacklist write fails so the caller can retry", async () => {
    const blacklist = spyOn(RevokedJtiModel, "updateOne").mockImplementation((() =>
      Promise.reject(new Error("mongo unavailable"))) as never)
    const deleteRefresh = spyOn(RefreshTokenModel, "deleteOne").mockImplementation((() =>
      Promise.resolve({acknowledged: true, deletedCount: 1})) as never)
    try {
      await expect(
        revokeSession({sessionId: "sess_1", accessToken: {jti: "jti-1", expiresAt: 1_900_000_000}}),
      ).rejects.toThrow("mongo unavailable")
      expect(deleteRefresh).not.toHaveBeenCalled()
    } finally {
      blacklist.mockRestore()
      deleteRefresh.mockRestore()
    }
  })
})

function setSigningEnv(): void {
  const access = createEd25519Keypair()
  const miniapp = createEd25519Keypair()
  const account = createEd25519Keypair()
  process.env.MENTRA_JWT_PRIVATE_KEY = access.privateKey
  process.env.MENTRA_JWT_PUBLIC_KEY = access.publicKey
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = miniapp.privateKey
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = miniapp.publicKey
  // getPublicJwks now also publishes the account-token key (issue 019).
  process.env.MENTRA_ACCOUNT_JWT_PRIVATE_KEY = account.privateKey
  process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY = account.publicKey
  resetSigningKeyCache()
}

function createEd25519Keypair(): {privateKey: string; publicKey: string} {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  return {
    privateKey: stripPem(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    publicKey: stripPem(publicKey.export({type: "spki", format: "pem"}).toString()),
  }
}

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "")
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
