/**
 * @fileoverview The enterprise portal API (`/api/portal/*`).
 *
 * People sign in to the enterprise portal with the deployment's identity
 * provider (`/api/portal/auth/*`); every other route requires a signed-in
 * person (the enterprise portal session, or an identity-provider access token).
 * Core credentials get 403 and the admin portal's cookie authenticates nothing
 * here. Enterprise orgs are owned by Core users (`mentraUserId`).
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  EnterpriseService,
  EnterpriseServiceError,
  type EnterpriseUserIdentity,
} from "../../services/enterprise/enterprise.service";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";
import { requireUserPrincipal, userPrincipal } from "../middleware/principal.middleware";
import { createPortalAuthApi } from "../signin/portal-auth.api";

const app = new Hono<AppEnv>();
const enterprise = new EnterpriseService();

const upsertOrgSchema = z.object({
  displayName: z.string().min(1),
  tenantId: z.string().min(1),
});

const upsertTrustedIssuerSchema = z.object({
  environmentName: z.string().min(1),
  issuer: z.string().min(1),
  jwksUrl: z.string().min(1),
  subjectClaim: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const setIssuerEnabledSchema = z.object({
  enabled: z.boolean(),
});

const validateJwksSchema = z.object({
  jwksUrl: z.string().min(1),
});

app.get("/health", c => c.json({ status: "ok", service: "cloud-core-portal" }));
// Enterprise portal sign-in, ahead of the person gate.
app.route("/auth", createPortalAuthApi("portal"));
app.use("*", requireUserPrincipal("portal"));
app.get("/me", getMe);
app.get("/org", getOrg);
app.put("/org", putOrg);
app.get("/trusted-issuers", getTrustedIssuers);
app.post("/trusted-issuers", postTrustedIssuer);
app.post("/trusted-issuers/validate", postValidateJwks);
app.patch("/trusted-issuers/:trustedIssuerId", patchTrustedIssuer);

async function getMe(c: AppContext) {
  const user = portalUser(c);
  const org = await enterprise.getPrimaryOrgForUser(user);
  return c.json({
    authenticated: true,
    user: { id: user.mentraUserId, email: user.email },
    onboardingRequired: org === null,
    org,
  });
}

async function getOrg(c: AppContext) {
  const user = portalUser(c);
  return c.json({ org: await enterprise.getPrimaryOrgForUser(user) });
}

async function putOrg(c: AppContext) {
  const user = portalUser(c);
  const parsed = upsertOrgSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid enterprise org payload");
  try {
    return c.json({ org: await enterprise.upsertPrimaryOrg(user, parsed.data) });
  } catch (error) {
    return serviceError(error);
  }
}

async function getTrustedIssuers(c: AppContext) {
  const user = portalUser(c);
  try {
    return c.json(await enterprise.listTrustedIssuers(user));
  } catch (error) {
    return serviceError(error);
  }
}

async function postTrustedIssuer(c: AppContext) {
  const user = portalUser(c);
  const parsed = upsertTrustedIssuerSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid trusted issuer payload");
  try {
    return c.json({ issuer: await enterprise.upsertTrustedIssuer(user, parsed.data) }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function postValidateJwks(c: AppContext) {
  const user = portalUser(c);
  const parsed = validateJwksSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid jwks payload");
  try {
    return c.json({ validation: await enterprise.validateJwks(parsed.data.jwksUrl) });
  } catch (error) {
    return serviceError(error);
  }
}

async function patchTrustedIssuer(c: AppContext) {
  const user = portalUser(c);
  const trustedIssuerId = c.req.param("trustedIssuerId");
  if (!trustedIssuerId) throw new InvalidRequest("trustedIssuerId is required");
  const parsed = setIssuerEnabledSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid trusted issuer payload");
  try {
    return c.json({ issuer: await enterprise.setTrustedIssuerEnabled(user, trustedIssuerId, parsed.data.enabled) });
  } catch (error) {
    return serviceError(error);
  }
}

/** The signed-in person, as the enterprise service's actor. Behind `requireUserPrincipal`. */
function portalUser(c: AppContext): EnterpriseUserIdentity {
  const principal = userPrincipal(c);
  return { mentraUserId: principal.mentraUserId, email: principal.email };
}

async function readJsonBody(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new InvalidRequest("request body must be a JSON object");
}

function serviceError(error: unknown): Response {
  if (error instanceof EnterpriseServiceError) {
    return new Response(
      JSON.stringify({ error: error.code, error_description: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  throw error;
}

export default app;
