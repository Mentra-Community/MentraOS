/**
 * @fileoverview User auth — Mentra access-token middleware.
 *
 * Applied to routes that require an authenticated end-user (mobile client).
 * Reads `Authorization: Bearer <jwt>`, verifies the token via
 * `session.service.verifyAccessToken`, and exposes the identity at
 * `c.var.user` for downstream handlers.
 *
 * Verification covers:
 *   - signature against Mentra's public key
 *   - audience + issuer
 *   - expiry
 *   - revocation blacklist (`revokedJtis`)
 *
 * Any failure surfaces as the same `InvalidGrant` error the token endpoints
 * use, translated by the global error handler in `api/app.ts` to the RFC
 * shape. Missing or malformed Authorization headers surface as
 * `InvalidRequest`.
 */

import { createMiddleware } from "hono/factory";
import { InvalidRequest } from "../../types/oauth.types";
import { verifyAccessToken } from "../../services/session.service";
import type { AppEnv } from "../../types/hono.types";

const BEARER_PREFIX = "Bearer ";

export const userAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new InvalidRequest("missing or malformed Authorization header");
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    throw new InvalidRequest("Authorization header has empty bearer token");
  }

  const verified = await verifyAccessToken(token);

  c.set("user", {
    mentraUserId: verified.mentraUserId,
    tenantId: verified.tenantId,
    sessionId: verified.sessionId,
  });

  await next();
});
