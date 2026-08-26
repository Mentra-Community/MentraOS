import * as jose from "jose";
import { createMiddleware } from "hono/factory";
import { MINIAPP_TOKEN_KID } from "../../services/signing-keys.service";
import { verifyAccessToken, verifyMiniappToken } from "../../services/session.service";
import type { AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";

const BEARER_PREFIX = "Bearer ";
const DEFAULT_STORE_PACKAGE = "com.mentra.store";

/**
 * The Mentra Store calls catalog APIs with its package-scoped token, while
 * the host downloads protected bundles with its Core access token. Accept
 * exactly those two identities here; no other miniapp token is a Core
 * credential. OEM backends can configure their own Store audience list.
 */
export const storeUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new InvalidRequest("missing or malformed Authorization header");
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) throw new InvalidRequest("Authorization header has empty bearer token");

  let kid: string | undefined;
  try {
    kid = jose.decodeProtectedHeader(token).kid;
  } catch {
    throw new InvalidRequest("Authorization bearer token is malformed");
  }
  const verified =
    kid === MINIAPP_TOKEN_KID
      ? await verifyMiniappToken(token, configuredStorePackages())
      : await verifyAccessToken(token);
  c.set("user", {
    mentraUserId: verified.mentraUserId,
    tenantId: verified.tenantId,
    sessionId: "sessionId" in verified ? verified.sessionId : verified.jti,
  });
  await next();
});

export const optionalStoreUserAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.req.header("authorization")) return next();
  return storeUserAuth(c, next);
});

function configuredStorePackages(): string[] {
  const configured = process.env.CLOUD_STORE_MINIAPP_PACKAGE_NAMES?.split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return configured?.length ? configured : [DEFAULT_STORE_PACKAGE];
}
