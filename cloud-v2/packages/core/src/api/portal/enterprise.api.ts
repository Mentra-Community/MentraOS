import { Hono } from "hono";
import { z } from "zod";
import { authenticateConsoleSession } from "../console/cli-auth.api";
import {
  EnterpriseService,
  EnterpriseServiceError,
} from "../../services/enterprise/enterprise.service";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";

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
app.get("/me", getMe);
app.get("/org", getOrg);
app.put("/org", putOrg);
app.get("/trusted-issuers", getTrustedIssuers);
app.post("/trusted-issuers", postTrustedIssuer);
app.post("/trusted-issuers/validate", postValidateJwks);
app.patch("/trusted-issuers/:trustedIssuerId", patchTrustedIssuer);

async function getMe(c: AppContext) {
  const auth = await authenticateConsoleSession(c);
  if (!auth.authenticated) {
    return c.json({ authenticated: false, reason: auth.reason }, 401);
  }
  const org = await enterprise.getPrimaryOrgForUser(auth.user);
  return c.json({
    authenticated: true,
    user: auth.user,
    onboardingRequired: org === null,
    org,
  });
}

async function getOrg(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  return c.json({ org: await enterprise.getPrimaryOrgForUser(auth.user) });
}

async function putOrg(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  const parsed = upsertOrgSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid enterprise org payload");
  try {
    return c.json({ org: await enterprise.upsertPrimaryOrg(auth.user, parsed.data) });
  } catch (error) {
    return serviceError(error);
  }
}

async function getTrustedIssuers(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  try {
    return c.json(await enterprise.listTrustedIssuers(auth.user));
  } catch (error) {
    return serviceError(error);
  }
}

async function postTrustedIssuer(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  const parsed = upsertTrustedIssuerSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid trusted issuer payload");
  try {
    return c.json({ issuer: await enterprise.upsertTrustedIssuer(auth.user, parsed.data) }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function postValidateJwks(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  const parsed = validateJwksSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid jwks payload");
  try {
    return c.json({ validation: await enterprise.validateJwks(parsed.data.jwksUrl) });
  } catch (error) {
    return serviceError(error);
  }
}

async function patchTrustedIssuer(c: AppContext) {
  const auth = await requirePortalUser(c);
  if (!auth.ok) return auth.response;
  const trustedIssuerId = c.req.param("trustedIssuerId");
  if (!trustedIssuerId) throw new InvalidRequest("trustedIssuerId is required");
  const parsed = setIssuerEnabledSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid trusted issuer payload");
  try {
    return c.json({ issuer: await enterprise.setTrustedIssuerEnabled(auth.user, trustedIssuerId, parsed.data.enabled) });
  } catch (error) {
    return serviceError(error);
  }
}

async function requirePortalUser(c: AppContext): Promise<
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; response: Response }
> {
  const auth = await authenticateConsoleSession(c);
  if (!auth.authenticated) {
    return {
      ok: false,
      response: c.json({ error: "unauthorized", error_description: "portal session required" }, 401),
    };
  }
  return { ok: true, user: auth.user };
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
