/**
 * @fileoverview Integration tests for the "Mentra user" subject-token exchange.
 *
 * Covers the non-OEM subject tokens a Mentra phone presents at
 * POST /api/client/auth/exchange:
 *   - a Supabase session JWT (HS256, verified with SUPABASE_JWT_SECRET), and
 *   - a legacy mentra-core token (HS256, verified with MENTRA_CORE_JWT_SECRET).
 *
 * Both resolve to the built-in "mentra" OEM (tenantId "mentra"), which has no oems
 * record and no JWKS. This is the path the mobile app uses today, so it gates
 * the device e2e.
 *
 * Wires the core in-process via app.fetch; the OEM-signed path is covered by
 * oem-auth.integration.test.ts.
 *
 * It also covers Supabase tokens signed either way: HS256 with the project's
 * JWT secret, or RS256 / ES256 with the project's key set (a fake identity
 * provider serves it), so the project can switch signing keys with no Core change.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and drops that database afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/auth.mentra-user-exchange.integration.test.ts`
 */

import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// Crypto material must be set BEFORE importing core so the lazy key loader finds
// it. The HS256 secrets are read per verification, so order is not critical for
// them, but keeping the whole prelude here mirrors the OEM-auth test.
{
  const { privateKey: nodePriv, publicKey: nodePub } =
    crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    nodePriv.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    nodePub.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.SUPABASE_JWT_SECRET = "test-supabase-secret-not-for-production";
  process.env.MENTRA_CORE_JWT_SECRET =
    "test-mentra-core-secret-not-for-production";
  process.env.SUPABASE_URL = "https://testproj.supabase.co";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import { OemModel } from "../packages/core/src/models/oem.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import * as jose from "jose";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { resetKeySets } from "../packages/core/src/services/signin/key-sets";
import { installFakeIdp, type FakeIdp } from "./support/fake-idp";
import { assertConnectedTo, localTestMongoUrl } from "./support/local-mongo";
import { resetCoreKeyCaches } from "./support/key-caches";

let coreApp: ReturnType<typeof createApp>;
const databaseUrl = localTestMongoUrl("mentra-user-exchange");
let verified = false;

const SUPABASE_ISSUER = "https://testproj.supabase.co/auth/v1";
const SUPABASE_JWKS = "https://testproj.supabase.co/auth/v1/.well-known/jwks.json";

// === Test lifecycle ===

beforeAll(async () => {
  // This suite's keys were set when the file loaded; a suite before it may have cached its own.
  resetCoreKeyCaches();
  await connectMongo(databaseUrl);
  assertConnectedTo(databaseUrl, UserModel.db.name);
  verified = true;
  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);
  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });
});

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name);
    await UserModel.db.dropDatabase();
  }
  await disconnectMongo();
  resetCoreKeyCaches();
});

beforeEach(async () => {
  assertConnectedTo(databaseUrl, UserModel.db.name);
  await Promise.all([
    OemModel.deleteMany({}),
    UserModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    SeenJtiModel.deleteMany({}),
    RevokedJtiModel.deleteMany({}),
  ]);
});

// === Tests ===

describe("Mentra user exchange — Supabase session", () => {
  test("happy path: supabase JWT → mentra tokens, tenantId 'mentra'", async () => {
    const jwt = await mintHs256({ sub: "sb-user-1" });

    const res = await exchange(jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    const claims = decodeJwtPayload(body.access_token);
    expect(claims.tenant_id).toBe("mentra");
    expect(typeof claims.sub).toBe("string");
    expect(claims.sub as string).toMatch(/^mu_/);
  });

  test("same supabase sub resolves to the same mentra user", async () => {
    const first = (await (await exchange(mintHs256({ sub: "sb-stable" }))).json()) as {
      access_token: string;
    };
    const second = (await (await exchange(mintHs256({ sub: "sb-stable" }))).json()) as {
      access_token: string;
    };
    expect(decodeJwtPayload(first.access_token).sub).toBe(
      decodeJwtPayload(second.access_token).sub,
    );
  });

  test("wrong signing secret → invalid_grant", async () => {
    const forged = mintHs256({ sub: "sb-user-2", secret: "not-the-secret" });
    const res = await exchange(forged);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("refresh works for a mentra user (no oems record required)", async () => {
    const exchanged = (await (await exchange(mintHs256({ sub: "sb-user-3" }))).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const refreshed = await refresh(exchanged.refresh_token);
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(body.access_token).not.toBe(exchanged.access_token);
    expect(body.refresh_token).not.toBe(exchanged.refresh_token);
  });
});

describe("Mentra user exchange — legacy mentra-core token", () => {
  test("happy path: mentra-core HS256 token → mentra tokens", async () => {
    const jwt = mintHs256({
      sub: "core-user-1",
      secret: process.env.MENTRA_CORE_JWT_SECRET!,
      iss: "mentra-core",
    });
    const res = await exchange(jwt);
    expect(res.status).toBe(200);
    const claims = decodeJwtPayload(((await res.json()) as { access_token: string }).access_token);
    expect(claims.tenant_id).toBe("mentra");
  });
});

describe("Supabase tokens signed either way", () => {
  let idp: FakeIdp;

  beforeEach(async () => {
    resetKeySets();
    idp = await installFakeIdp({
      issuer: SUPABASE_ISSUER,
      jwksUrl: SUPABASE_JWKS,
      hs256Secret: process.env.SUPABASE_JWT_SECRET,
    });
  });
  afterEach(() => {
    idp.restore();
  });

  async function exchangeSupabaseToken(token: string): Promise<{ status: number; mentraUserId?: string; error?: string }> {
    const res = await exchange(token);
    const body = (await res.json()) as { access_token?: string; error?: string };
    return {
      status: res.status,
      mentraUserId: body.access_token ? (decodeJwtPayload(body.access_token).sub as string) : undefined,
      error: body.error,
    };
  }

  test("legacy and asymmetric Supabase tokens resolve the same Core user", async () => {
    const legacy = await exchangeSupabaseToken(await idp.mint({ sub: "supa-1", aud: "authenticated" }, { alg: "HS256" }));
    const modern = await exchangeSupabaseToken(await idp.mint({ sub: "supa-1", aud: "authenticated" }, { alg: "ES256" }));
    expect(legacy.status).toBe(200);
    expect(modern.status).toBe(200);
    expect(modern.mentraUserId).toBe(legacy.mentraUserId);
  });

  test("an RS256 token is accepted", async () => {
    const result = await exchangeSupabaseToken(await idp.mint({ sub: "supa-rs", aud: "authenticated" }, { alg: "RS256" }));
    expect(result.status).toBe(200);
    expect(result.mentraUserId).toMatch(/^mu_/);
  });

  test("after a key rotation, a token with the new kid is accepted after one key-set refresh", async () => {
    expect((await exchangeSupabaseToken(await idp.mint({ sub: "supa-rot", aud: "authenticated" }, { alg: "ES256" }))).status).toBe(200);
    const fetchesBefore = idp.jwksFetches;
    await idp.rotateKey();
    const rotated = await exchangeSupabaseToken(await idp.mint({ sub: "supa-rot", aud: "authenticated" }, { alg: "ES256" }));
    expect(rotated.status).toBe(200);
    expect(idp.jwksFetches).toBe(fetchesBefore + 1);
  });

  test("an asymmetric token whose aud is not 'authenticated' is refused", async () => {
    const result = await exchangeSupabaseToken(await idp.mint({ sub: "supa-aud", aud: "anon" }, { alg: "ES256" }));
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_grant");
  });

  test("alg none is refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = new jose.UnsecuredJWT({ sub: "supa-none", aud: "authenticated", iss: SUPABASE_ISSUER })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .encode();
    const result = await exchangeSupabaseToken(unsigned);
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_grant");
  });

  test("an HS256 token signed with another secret is refused", async () => {
    const forged = mintHs256({ sub: "supa-forged", secret: "another-secret", iss: SUPABASE_ISSUER });
    const result = await exchangeSupabaseToken(forged);
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_grant");
  });

  test("a jku header pointing at another key set is ignored: only the configured key set counts", async () => {
    const seen: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const token = await idp.mint(
        { sub: "supa-jku", aud: "authenticated" },
        { alg: "RS256", key: "attacker", header: { jku: "https://attacker.example/jwks.json" } },
      );
      const result = await exchangeSupabaseToken(token);
      expect(result.status).toBe(400);
      expect(result.error).toBe("invalid_grant");
      expect(seen.some(url => url.startsWith("https://attacker.example"))).toBe(false);
    } finally {
      globalThis.fetch = inner;
    }
  });

  test("a token Supabase issued to a web client never becomes a phone session", async () => {
    const result = await exchangeSupabaseToken(
      await idp.mint({ sub: "supa-web", aud: "authenticated", client_id: "admin-portal" }, { alg: "HS256" }),
    );
    expect(result.status).toBe(400);
    expect(result.error).toBe("invalid_grant");
  });
});

// === Helpers ===

/**
 * Mint an HS256 JWT shaped like the relevant subject token. Defaults to a
 * Supabase session (iss = the configured Supabase URL, signed with
 * SUPABASE_JWT_SECRET); override `secret`/`iss` for the mentra-core or forged
 * cases. Built with Node crypto so the test carries no extra JWT dependency.
 */
function mintHs256(args: { sub: string; secret?: string; iss?: string }): string {
  const secret = args.secret ?? process.env.SUPABASE_JWT_SECRET!;
  const iss = args.iss ?? `${process.env.SUPABASE_URL}/auth/v1`;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: args.sub,
      iss,
      aud: "authenticated",
      role: "authenticated",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${sig}`;
}

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Decode (without verifying) a JWT payload for assertions. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
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

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
