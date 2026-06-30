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
 * Prereq: a running Mongo. Defaults to
 * `mongodb://127.0.0.1:27017/mentra-cloud-v2-test`; override via `MONGO_URL`.
 * The test wipes its own collections between cases — do NOT point at a real DB.
 *
 * Run: `bun test tests/auth.mentra-user-exchange.integration.test.ts`
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

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
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-test";
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
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";

let coreApp: ReturnType<typeof createApp>;

// === Test lifecycle ===

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
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
  await disconnectMongo();
});

beforeEach(async () => {
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
