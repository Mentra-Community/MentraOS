/**
 * @fileoverview OEM OAuth token endpoints.
 *
 * Mounted at: /api/oem/oauth
 *
 *   POST /token   — RFC 8693 token exchange. OEM-signed JWT in, Mentra
 *                   access + refresh tokens out.
 *   POST /refresh — RFC 6749 refresh flow. Old refresh token in, fresh
 *                   access + refresh out (rotated).
 *
 * Both endpoints accept `application/x-www-form-urlencoded`, per the RFCs.
 * Errors are translated to the RFC body shape by the global error handler
 * in `api/app.ts`.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("Endpoints")
 */

import { Hono } from "hono";
import {
  InvalidRequest,
  UnsupportedGrantType,
  type TokenResponse,
} from "../../types/oauth.types";
import {
  createSession,
  refreshSession,
} from "../../services/session.service";
import type { AppContext, AppEnv } from "../../types/hono.types";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

const app = new Hono<AppEnv>();

// === Routes ===

app.post("/token", postToken);
app.post("/refresh", postRefresh);

// === Handlers ===

async function postToken(c: AppContext) {
  const form = await c.req.parseBody();

  const grantType = stringField(form, "grant_type");
  if (grantType !== TOKEN_EXCHANGE_GRANT) {
    throw new UnsupportedGrantType(
      `grant_type must be '${TOKEN_EXCHANGE_GRANT}'`,
    );
  }

  const subjectTokenType = stringField(form, "subject_token_type");
  if (subjectTokenType !== JWT_TOKEN_TYPE) {
    throw new InvalidRequest(
      `subject_token_type must be '${JWT_TOKEN_TYPE}'`,
    );
  }

  const subjectToken = stringField(form, "subject_token");
  if (!subjectToken) {
    throw new InvalidRequest("subject_token is required");
  }

  const tokens = await createSession({ oemJwt: subjectToken });
  return c.json<TokenResponse>(tokens);
}

async function postRefresh(c: AppContext) {
  const form = await c.req.parseBody();

  const grantType = stringField(form, "grant_type");
  if (grantType !== "refresh_token") {
    throw new UnsupportedGrantType("grant_type must be 'refresh_token'");
  }

  const refreshToken = stringField(form, "refresh_token");
  if (!refreshToken) {
    throw new InvalidRequest("refresh_token is required");
  }

  const tokens = await refreshSession({ refreshToken });
  return c.json<TokenResponse>(tokens);
}

// === Helpers ===

function stringField(
  form: Record<string, string | File | (string | File)[]>,
  name: string,
): string | null {
  const v = form[name];
  return typeof v === "string" ? v : null;
}

export default app;
