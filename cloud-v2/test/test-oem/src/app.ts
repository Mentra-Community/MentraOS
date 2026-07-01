/**
 * @fileoverview TEST OEM Hono app and JWT-mint helper.
 *
 * Split from `index.ts` so tests can:
 *   - Import `createTestOemApp(...)` and exercise the HTTP surface via
 *     `app.fetch(new Request(...))` without binding a port, or
 *   - Skip HTTP entirely and call `mintJwt(...)` to get a signed JWT
 *     directly. The HTTP route uses the same helper under the hood.
 *
 * `index.ts` is the executable that wires loadKeypair → createTestOemApp →
 * Bun.serve for hand-runnable use.
 */

import { Hono, type Context } from "hono";
import * as jose from "jose";
import type { TestOemKeypair } from "./keypair";

const ALG = "EdDSA";
const DEFAULT_JWT_TTL_SEC = 5 * 60;
const DEFAULT_AUDIENCE = "mentra";

export interface MintJwtOptions {
  tenantUserId: string;
  /** Default 5 min. Use a negative value to mint an already-expired token. */
  ttlSec?: number;
  /** Default `"mentra"`. Override to test audience rejection. */
  audience?: string;
  /** Optional pass-through claims (e.g. `oem_display_name`). */
  extraClaims?: Record<string, unknown>;
  /** Optional jti override. Default: random UUID. */
  jti?: string;
}

export interface MintJwtResult {
  jwt: string;
  jti: string;
  tenantId: string;
  tenantUserId: string;
  ttlSec: number;
  audience: string;
}

export async function mintJwt(args: {
  keypair: TestOemKeypair;
  tenantId: string;
  options: MintJwtOptions;
}): Promise<MintJwtResult> {
  const { keypair, tenantId, options } = args;
  const ttlSec = options.ttlSec ?? DEFAULT_JWT_TTL_SEC;
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const jti = options.jti ?? `jti-${crypto.randomUUID()}`;
  const extraClaims = options.extraClaims ?? {};

  // For negative ttl we set exp manually so we can mint already-expired tokens
  // for rejection-path tests. jose's setExpirationTime accepts negative offsets
  // as strings but is unintuitive; clearer to compute and pass a Date.
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSec;

  const jwt = await new jose.SignJWT(extraClaims)
    .setProtectedHeader({ alg: ALG, kid: `${tenantId}-key-1` })
    .setIssuer(tenantId)
    .setSubject(options.tenantUserId)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(keypair.privateKey);

  return { jwt, jti, tenantId, tenantUserId: options.tenantUserId, ttlSec, audience };
}

export interface CreateTestOemAppOptions {
  tenantId: string;
  keypair: TestOemKeypair;
}

export function createTestOemApp(opts: CreateTestOemAppOptions): Hono {
  const { tenantId, keypair } = opts;
  const app = new Hono();

  app.get("/.well-known/jwks.json", getJwks);
  app.get("/test-oem/.well-known/jwks.json", getJwks);
  app.get("/test-oem/health", (c) => c.json({ ok: true, tenantId }));
  app.post("/test-oem/mint-jwt", postMintJwt);

  function getJwks(c: Context) {
    return c.json({ keys: [keypair.publicJwk] });
  }

  async function postMintJwt(c: Context) {
    const body = (await c.req.json().catch(() => ({}))) as Partial<MintJwtOptions>;
    if (typeof body.tenantUserId !== "string" || !body.tenantUserId) {
      return c.json({ error: "tenantUserId is required" }, 400);
    }
    const result = await mintJwt({
      keypair,
      tenantId,
      options: {
        tenantUserId: body.tenantUserId,
        ttlSec: body.ttlSec,
        audience: body.audience,
        extraClaims: body.extraClaims,
        jti: body.jti,
      },
    });
    return c.json(result);
  }

  return app;
}
