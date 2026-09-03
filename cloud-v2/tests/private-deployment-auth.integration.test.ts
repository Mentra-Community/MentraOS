import crypto from "node:crypto"
import {readFileSync} from "node:fs"
import {afterAll, beforeAll, describe, expect, test} from "bun:test"
import * as jose from "jose"

import {createMentraAuth} from "../packages/auth/src/index"
import {startCore, type CoreHandle} from "../packages/core/src/index"
import {resetSigningKeyCache} from "../packages/core/src/services/session.service"
import {startRuntime, type RuntimeHandle} from "../packages/runtime/src/index"
import {resetOidcVerifierCache, resetRuntimeAuthCache} from "../packages/shared/src/index"

const RUN = process.env.RUN_PRIVATE_DEPLOYMENT_E2E === "true" && !!process.env.MONGO_URL
const describePrivateDeployment = RUN ? describe : describe.skip
const OIDC_ISSUER = "https://login.microsoftonline.com/private-test-tenant/v2.0"
const OIDC_JWKS = "https://login.microsoftonline.com/private-test-tenant/discovery/v2.0/keys"
const CORE_ISSUER = "https://core.private-test.example"
const CORE_CLIENT_ID = "private-test-core"
const MOBILE_CLIENT_ID = "private-test-mobile"

const savedFetch = globalThis.fetch
const savedEnv = new Map<string, string | undefined>()
let oidcPrivateKey: jose.KeyLike
let oidcPublicJwk: jose.JWK
let core: CoreHandle
let runtime: RuntimeHandle

describePrivateDeployment("Mentra Private Deployment identity path", () => {
  beforeAll(async () => {
    configureSigningKeys()
    const oidcKeys = await jose.generateKeyPair("RS256", {extractable: true})
    oidcPrivateKey = oidcKeys.privateKey
    oidcPublicJwk = await jose.exportJWK(oidcKeys.publicKey)

    setEnv(
      "CLOUD_CORE_OIDC_PROVIDERS",
      JSON.stringify([
        {
          id: "workforce",
          protocol: "oidc",
          providerKind: "microsoft-entra",
          tenantId: "private-test",
          issuer: OIDC_ISSUER,
          jwksUrl: OIDC_JWKS,
          audience: CORE_CLIENT_ID,
          subjectClaim: "oid",
          directoryTenantClaim: "tid",
          expectedDirectoryTenantId: "private-test-tenant",
          requiredScopes: ["mentra.session"],
          allowedClientIds: [MOBILE_CLIENT_ID],
        },
      ]),
    )
    setEnv("CLOUD_CORE_ISSUER", CORE_ISSUER)
    setEnv(
      "CLOUD_RUNTIME_AUTH_ISSUERS",
      JSON.stringify([
        {
          issuer: CORE_ISSUER,
          publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY",
          userIdClaim: "sub",
          tenantIdClaim: "tenant_id",
          algorithms: ["EdDSA"],
        },
      ]),
    )
    setEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", "cloud-runtime")
    setEnv("MEETING_PROVIDERS", "acs-teams")
    setEnv("ENTRA_TENANT_ID", "private-test-tenant")
    setEnv("ENTRA_CLIENT_ID", MOBILE_CLIENT_ID)
    setEnv(
      "ACS_CONNECTION_STRING",
      "endpoint=https://private-test.communication.azure.com/;accesskey=not-used-by-this-test",
    )

    globalThis.fetch = (async (input, init) => {
      if (String(input) === OIDC_JWKS) {
        return Response.json({
          keys: [{...oidcPublicJwk, alg: "RS256", kid: "private-test-key", use: "sig"}],
        })
      }
      return savedFetch(input, init)
    }) as typeof fetch

    resetSigningKeyCache()
    resetOidcVerifierCache()
    resetRuntimeAuthCache()
    core = await startCore({port: 0, mongoUrl: process.env.MONGO_URL})
    const manifest = readFileSync(
      new URL("../deploy/azure/enterprise-reference/mentra-deployment.json", import.meta.url),
      "utf8",
    )
    runtime = await startRuntime({
      httpPort: 0,
      services: new Set(["meetings"]),
      deploymentManifest: manifest,
    })
  })

  afterAll(async () => {
    await runtime?.stop()
    await core?.stop()
    globalThis.fetch = savedFetch
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetSigningKeyCache()
    resetOidcVerifierCache()
    resetRuntimeAuthCache()
  })

  test("exchanges OIDC through Core, brokers Runtime and miniapp tokens, refreshes, and revokes", async () => {
    const exchange = await postForm(`${core.url}/api/client/auth/exchange`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: await workforceToken(),
    })
    expect(exchange.status).toBe(200)
    const initial = (await exchange.json()) as {access_token: string; refresh_token: string}

    const runtimeTokenResponse = await fetch(`${core.url}/api/client/auth/runtime-token`, {
      method: "POST",
      headers: {authorization: `Bearer ${initial.access_token}`},
    })
    expect(runtimeTokenResponse.status).toBe(200)
    const runtimeToken = (await runtimeTokenResponse.json()) as {access_token: string}
    expect(jose.decodeJwt(runtimeToken.access_token)).toMatchObject({
      iss: CORE_ISSUER,
      tenant_id: "private-test",
      federated_identity: {
        provider_kind: "microsoft-entra",
        subject: "employee-object-id",
        directory_tenant_id: "private-test-tenant",
      },
    })

    const runtimeAuthResponse = await fetch(`http://127.0.0.1:${runtime.httpPort}/api/meetings/acs/teams-user-token`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runtimeToken.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(runtimeAuthResponse.status).toBe(400)

    const miniappResponse = await fetch(`${core.url}/api/client/auth/miniapp-token`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${initial.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({packageName: "com.example.remoteassist"}),
    })
    expect(miniappResponse.status).toBe(200)
    const miniappToken = (await miniappResponse.json()) as {token: string}
    const miniappAuth = createMentraAuth({
      packageName: "com.example.remoteassist",
      issuer: CORE_ISSUER,
      jwksUrl: `${core.url}/.well-known/jwks.json`,
    })
    await expect(miniappAuth.verifyToken(miniappToken.token)).resolves.toMatchObject({
      tenantId: "private-test",
    })

    const refresh = await postForm(`${core.url}/api/client/auth/refresh`, {
      grant_type: "refresh_token",
      refresh_token: initial.refresh_token,
    })
    expect(refresh.status).toBe(200)
    const rotated = (await refresh.json()) as {access_token: string; refresh_token: string}

    const revoke = await fetch(`${core.url}/api/client/auth/revoke`, {
      method: "POST",
      headers: {authorization: `Bearer ${rotated.access_token}`},
    })
    expect(revoke.status).toBe(200)

    const rejectedRefresh = await postForm(`${core.url}/api/client/auth/refresh`, {
      grant_type: "refresh_token",
      refresh_token: rotated.refresh_token,
    })
    expect(rejectedRefresh.status).toBe(400)
  })
})

async function workforceToken(): Promise<string> {
  return new jose.SignJWT({
    oid: "employee-object-id",
    tid: "private-test-tenant",
    azp: MOBILE_CLIENT_ID,
    scp: "mentra.session",
  })
    .setProtectedHeader({alg: "RS256", kid: "private-test-key"})
    .setIssuer(OIDC_ISSUER)
    .setAudience(CORE_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(oidcPrivateKey)
}

function configureSigningKeys(): void {
  const access = crypto.generateKeyPairSync("ed25519")
  const miniapp = crypto.generateKeyPairSync("ed25519")
  setEnv("MENTRA_JWT_PRIVATE_KEY", stripPem(access.privateKey.export({type: "pkcs8", format: "pem"}).toString()))
  setEnv("MENTRA_JWT_PUBLIC_KEY", stripPem(access.publicKey.export({type: "spki", format: "pem"}).toString()))
  setEnv(
    "MENTRA_MINIAPP_JWT_PRIVATE_KEY",
    stripPem(miniapp.privateKey.export({type: "pkcs8", format: "pem"}).toString()),
  )
  setEnv("MENTRA_MINIAPP_JWT_PUBLIC_KEY", stripPem(miniapp.publicKey.export({type: "spki", format: "pem"}).toString()))
  setEnv("REFRESH_TOKEN_PEPPER", "private-deployment-e2e-refresh-pepper")
}

function stripPem(value: string): string {
  return value.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")
}

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  process.env[name] = value
}

function postForm(url: string, values: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams(values),
  })
}
