/**
 * @fileoverview End-to-end test for the enterprise trusted-issuer token exchange.
 *
 * Proves the (tenantId, env)-routed path through POST /api/client/auth/exchange:
 *   - the enterprise mints a JWT carrying tenantId + env (+ a real iss URL)
 *   - Core resolves EnterpriseOrg by tenantId == tenantId, then TrustedIssuer by
 *     (enterpriseOrgId, env), fetches the JWKS, and pins iss before minting
 *   - lookup misses, env mismatches, and iss mismatches are rejected
 *   - a token with no tenantId claim falls through to the legacy OEM path
 *
 * A local HTTP server serves the issuer's JWKS so Core's remote-JWKS fetcher has
 * a real endpoint. Signing uses node:crypto Ed25519 directly (the root tests dir
 * can't resolve jose). Prereq: a running Mongo (override via MONGO_URL). The test
 * wipes its own collections — do NOT point it at a real database.
 *
 * Run: `bun test tests/trusted-issuer-auth.integration.test.ts`
 */

import crypto from "node:crypto";
import http from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

// Crypto material must be set BEFORE importing core so the lazy key loader picks
// it up (mirrors oem-auth.integration.test.ts).
{
  const { privateKey: nodePriv, publicKey: nodePub } =
    crypto.generateKeyPairSync("ed25519");
  const strip = (pem: string) =>
    pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  process.env.MENTRA_JWT_PRIVATE_KEY = strip(
    nodePriv.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = strip(
    nodePub.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-test";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import { EnterpriseOrgModel } from "../packages/core/src/models/enterprise-org.model";
import { TrustedIssuerModel } from "../packages/core/src/models/trusted-issuer.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";

const TENANT_ID = "acme";
const ENV = "sandbox";
const ISSUER = "https://auth.acme.example/sandbox";
const KID = "acme-key-1";

let coreApp: ReturnType<typeof createApp>;
let issuerPrivateKey: crypto.KeyObject;
let issuerPublicJwk: Record<string, unknown>;
let jwksServer: http.Server;
let jwksUrl: string;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
  await Promise.all([
    EnterpriseOrgModel.syncIndexes(),
    TrustedIssuerModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);
  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });

  // The issuer's signing keypair. Export the public half as a JWK for the JWKS.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  issuerPrivateKey = privateKey;
  issuerPublicJwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    alg: "EdDSA",
    use: "sig",
    kid: KID,
  };

  // Serve the issuer JWKS so Core's remote-JWKS fetcher has a real endpoint.
  jwksServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [issuerPublicJwk] }));
  });
  await new Promise<void>(resolve => jwksServer.listen(0, "127.0.0.1", resolve));
  const addr = jwksServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  jwksUrl = `http://127.0.0.1:${port}/jwks`;
});

afterAll(async () => {
  await new Promise<void>(resolve => jwksServer.close(() => resolve()));
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    EnterpriseOrgModel.deleteMany({ tenantId: /^acme/ }),
    TrustedIssuerModel.deleteMany({ issuer: /^https:\/\/auth\.acme\.example/ }),
    UserModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    SeenJtiModel.deleteMany({}),
    RevokedJtiModel.deleteMany({}),
  ]);

  const enterpriseOrgId = `ent_${crypto.randomUUID()}`;
  await EnterpriseOrgModel.create({
    enterpriseOrgId,
    ownerUserId: "user_acme_owner",
    tenantId: TENANT_ID,
    displayName: "Acme Glass",
    slug: "acme-glass",
    status: "active",
  });
  // Seed the issuer directly so we can point jwksUrl at the local http server
  // (the service-layer normalizer requires https; the model does not).
  await TrustedIssuerModel.create({
    trustedIssuerId: `ti_${crypto.randomUUID()}`,
    enterpriseOrgId,
    environmentName: ENV,
    issuer: ISSUER,
    jwksUrl,
    subjectClaim: "sub",
    enabled: true,
    createdBy: "user_acme_owner",
  });
});

describe("enterprise trusted-issuer token exchange", () => {
  test("happy path: tenantId + env routes, iss pinned, tokens minted", async () => {
    const res = await exchange(mintEnterpriseJwt({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  test("unknown env → unauthorized", async () => {
    const res = await exchange(mintEnterpriseJwt({ env: "production" }));
    expect(res.status).toBe(401);
  });

  test("unknown tenantId → unauthorized", async () => {
    const res = await exchange(mintEnterpriseJwt({ tenantId: "not-acme" }));
    expect(res.status).toBe(401);
  });

  test("iss not matching the registered issuer → rejected", async () => {
    const res = await exchange(mintEnterpriseJwt({ iss: "https://auth.acme.example/other" }));
    expect(res.status).toBe(400);
  });

  test("missing env claim → invalid_request", async () => {
    const res = await exchange(mintEnterpriseJwt({ omitEnv: true }));
    expect(res.status).toBe(400);
  });

  test("no tenantId claim → falls through to legacy OEM path (unknown oem)", async () => {
    // No tenantId means the legacy iss==tenantId lookup runs, and no such OEM is seeded.
    const res = await exchange(mintRawJwt({ iss: "legacy-oem", extraClaims: {} }));
    expect(res.status).toBe(401);
  });

  test("enterprise session survives refresh (active org)", async () => {
    // Regression: refresh used to look the tenant up only in OemModel, but an
    // enterprise tenantId lives in EnterpriseOrg, so enterprise sessions died on
    // the first refresh after the access token expired.
    const exchanged = (await (await exchange(mintEnterpriseJwt({}))).json()) as {
      refresh_token: string;
    };
    expect(exchanged.refresh_token).toBeTruthy();

    const res = await refresh(exchanged.refresh_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  test("refresh is refused after the enterprise org is disabled", async () => {
    const exchanged = (await (await exchange(mintEnterpriseJwt({}))).json()) as {
      refresh_token: string;
    };
    await EnterpriseOrgModel.updateOne(
      { tenantId: TENANT_ID },
      { $set: { status: "disabled" } },
    );

    const res = await refresh(exchanged.refresh_token);
    expect(res.status).toBe(401);
  });
});

function mintEnterpriseJwt(overrides: {
  tenantId?: string;
  env?: string;
  iss?: string;
  omitEnv?: boolean;
}): string {
  const claims: Record<string, unknown> = { tenantId: overrides.tenantId ?? TENANT_ID };
  if (!overrides.omitEnv) claims.env = overrides.env ?? ENV;
  return mintRawJwt({ iss: overrides.iss ?? ISSUER, extraClaims: claims });
}

function mintRawJwt(args: { iss: string; extraClaims: Record<string, unknown> }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: KID };
  const payload = {
    iss: args.iss,
    sub: "acme-user-1",
    aud: "mentra",
    jti: `jti-${crypto.randomUUID()}`,
    iat: now,
    exp: now + 300,
    ...args.extraClaims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), issuerPrivateKey);
  return `${signingInput}.${b64url(signature)}`;
}

async function exchange(jwt: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: jwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });
  return coreApp.fetch(
    new Request("http://localhost/api/client/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

async function refresh(refreshToken: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return coreApp.fetch(
    new Request("http://localhost/api/client/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}
