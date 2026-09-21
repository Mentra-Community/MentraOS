/**
 * @fileoverview Public key discovery (JWKS).
 *
 * Mounted at the root so the path is the standard /.well-known/jwks.json.
 *
 *   GET /.well-known/jwks.json — Mentra's public keys in JWK form, each with a
 *                                `kid`.
 *
 * Two keys are published: the access-token key (internal services verify
 * access tokens with it) and the miniapp-token key (developer backends verify
 * miniapp tokens with it). Verifiers pick the key by the JWT header's `kid`,
 * which is what lets keys rotate without client coordination.
 *
 * This endpoint is public and unauthenticated by design: a JWKS only ever
 * exposes public halves, and any verifier must be able to fetch it.
 *
 * Spec: https://github.com/Mentra-Community/Mentra-Specs/blob/main/cloud/core/auth/spec.md ("GET /.well-known/jwks.json",
 *       "Signing keys")
 */

import { Hono } from "hono";
import { getPublicJwks } from "../services/session.service";
import type { AppEnv } from "../types/hono.types";

const app = new Hono<AppEnv>();

app.get("/.well-known/jwks.json", async (c) => {
  const jwks = await getPublicJwks();
  return c.json(jwks);
});

export default app;
