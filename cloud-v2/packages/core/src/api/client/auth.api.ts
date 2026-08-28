/**
 * @fileoverview Client (device-called) auth endpoints.
 *
 * Mounted at: /api/client/auth
 *
 *   POST /exchange      — RFC 8693 token exchange. OEM-signed JWT (or other
 *                         supported subject token) in, Mentra access + refresh
 *                         tokens out.
 *   POST /refresh       — RFC 6749 refresh flow. Old refresh token in, fresh
 *                         access + refresh out (rotated).
 *   POST /runtime-token — Core access token (Bearer) in, short-lived Runtime
 *                         token out (`aud=cloud-runtime`).
 *   POST /miniapp-token — Access token (Bearer) + packageName in, a short-lived
 *                         miniapp-scoped Ed25519 JWT out.
 *
 * These are the paths the mobile client / device hits. Per auth/spec.md's
 * caller convention, device-called routes live under /api/client/*, while
 * /api/oem/* is reserved for the OEM's backend (jwks/me/sessions). The exchange
 * + refresh handlers moved here from /api/oem/oauth for that reason; the
 * mechanics are unchanged.
 *
 * exchange + refresh accept `application/x-www-form-urlencoded`, per the RFCs.
 * miniapp-token takes a JSON body. Errors are translated to the RFC body shape
 * by the global error handler in `api/app.ts`.
 *
 * Spec: docs/issues/001-cloud-core/auth/spec.md ("Endpoints")
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  InvalidRequest,
  UnsupportedGrantType,
  type TokenResponse,
} from "../../types/oauth.types";
import {
  createSession,
  refreshSession,
  issueMiniappToken,
  issueRuntimeToken,
} from "../../services/session.service";
import {
  StoreServiceError,
  verifyStoreDevAttestation,
  type StoreDevAttestation,
} from "../../services/store.client";
import { userAuth } from "../middleware/user-auth.middleware";
import type { AppContext, AppEnv } from "../../types/hono.types";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

const app = new Hono<AppEnv>();

// === Routes ===

app.post("/exchange", postExchange);
app.post("/refresh", postRefresh);

// miniapp-token requires a verified access token, so it sits behind userAuth,
// which populates `c.var.user` (mentraUserId + tenantId) from the Bearer token.
app.post("/runtime-token", userAuth, postRuntimeToken);
app.post("/miniapp-token", userAuth, postMiniappToken);

// === Handlers ===

async function postExchange(c: AppContext) {
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

  const tokens = await createSession({ subjectToken });
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

async function postMiniappToken(c: AppContext) {
  // userAuth guarantees `user` is set; this guard is for the type system and
  // for defense in depth if the middleware chain ever changes.
  const user = c.var.user;
  if (!user) {
    throw new InvalidRequest("missing authenticated user");
  }

  const body = await readJsonBody(c);
  const packageName =
    typeof body.packageName === "string" ? body.packageName.trim() : "";
  if (!packageName) {
    throw new InvalidRequest("packageName is required");
  }

  const devAttestation =
    typeof body.devAttestation === "string" ? parseDevAttestation(body.devAttestation) : null;
  if (devAttestation) {
    try {
      await verifyStoreDevAttestation(packageName, devAttestation);
    } catch (error) {
      if (error instanceof StoreServiceError) {
        return c.json(
          { error: error.code, error_description: error.message },
          error.status as ContentfulStatusCode,
        );
      }
      throw error;
    }
  }

  const { token, expiresAt } = await issueMiniappToken({
    mentraUserId: user.mentraUserId,
    tenantId: user.tenantId,
    packageName,
  });

  return c.json({ token, expiresAt });
}

async function postRuntimeToken(c: AppContext) {
  const user = c.var.user;
  if (!user) {
    throw new InvalidRequest("missing authenticated user");
  }

  const { token, expiresAt } = await issueRuntimeToken({
    mentraUserId: user.mentraUserId,
    tenantId: user.tenantId,
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  });
}

// === Helpers ===

function stringField(
  form: Record<string, string | File | (string | File)[]>,
  name: string,
): string | null {
  const v = form[name];
  return typeof v === "string" ? v : null;
}

/**
 * Parse a JSON request body, surfacing a malformed body as the RFC-shaped
 * `invalid_request` rather than a generic 500.
 */
async function readJsonBody(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the InvalidRequest below
  }
  throw new InvalidRequest("request body must be a JSON object");
}

function parseDevAttestation(value: string): StoreDevAttestation {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.packageName === "string" &&
      typeof parsed.devServerUrl === "string" &&
      typeof parsed.nonce === "string" &&
      typeof parsed.expiresAt === "string" &&
      typeof parsed.signingKeyId === "string" &&
      typeof parsed.signature === "string"
    ) {
      return parsed as unknown as StoreDevAttestation;
    }
  } catch {
    // fall through to InvalidRequest below
  }
  throw new InvalidRequest("devAttestation must be a signed mentra dev attestation");
}

export default app;
