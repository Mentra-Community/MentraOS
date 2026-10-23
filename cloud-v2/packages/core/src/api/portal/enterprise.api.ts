/**
 * @fileoverview The workspace portal API (`/api/portal/*`).
 *
 * People sign in to the workspace portal with the deployment's identity
 * provider (`/api/portal/auth/*`); every other route requires a signed-in
 * person (the workspace portal session, or an identity-provider access token).
 * Core credentials get 403 and the admin portal's cookie authenticates nothing
 * here.
 *
 *  - `/me`: who is signed in, their enterprise org, whether they may create a workspace, and which
 *    portal modules to offer them (`modules: {billing, billingCatalog}`): `billing` where billing is ready and
 *    visible to them, `billingCatalog` where it is ready at all, because its catalog is an open read;
 *  - `/workspaces/*`: the workspace API (`workspaces.api.ts`), the same handlers
 *    `/api/workspaces` and `/api/admin/workspaces` serve;
 *  - `/billing/*`: the billing portal module, forwarded to the Mentra Miniapp Store (`portal-modules.api.ts`).
 *    Its public reads (`/billing/public/*`, a product's name) are mounted ahead of the person gate, for anyone;
 *  - `/org`, `/trusted-issuers`: enterprise orgs and their trusted issuers, owned
 *    by Core users (`mentraUserId`) and kept separate from workspaces.
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
import { portalModuleAvailability } from "../../services/portal-modules/portal-modules";
import { fleetInstalled } from "../../services/fleet/fleet-config";
import { SigninIdentityModel } from "../../models/signin-identity.model";
import { authorize, organizationView } from "../../services/workspaces/authorization.service";
import { listWorkspacesForUser } from "../../services/workspaces/workspace.service";
import { requireUserPrincipal, userPrincipal } from "../middleware/principal.middleware";
import { createPortalAuthApi } from "../signin/portal-auth.api";
import { createWorkspacesApi } from "../workspaces/workspaces.api";
import { portalFleetApi } from "../fleet/fleet-forwarding";
import { portalModuleApi, portalModulePublicApi } from "./portal-modules.api";

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
// What anyone may read of billing, signed in or not (a product's name for the sign-in page), ahead of the gate too.
app.route("/billing/public", portalModulePublicApi("billing"));
app.use("*", requireUserPrincipal("portal"));
app.route("/workspaces", createWorkspacesApi());
app.route("/billing", portalModuleApi("billing"));
// Fleet Management for a workspace's Admins and Owners: not a portal module, so it has its own mount.
app.route("/fleet", portalFleetApi);
app.get("/me", getMe);
app.get("/org", getOrg);
app.put("/org", putOrg);
app.get("/trusted-issuers", getTrustedIssuers);
app.post("/trusted-issuers", postTrustedIssuer);
app.post("/trusted-issuers/validate", postValidateJwks);
app.patch("/trusted-issuers/:trustedIssuerId", patchTrustedIssuer);

async function getMe(c: AppContext) {
  const user = portalUser(c);
  const principal = userPrincipal(c);
  const org = await enterprise.getPrimaryOrgForUser(user);
  return c.json({
    authenticated: true,
    // `mentraUserId` is the Fleet UI contract's name for `id`.
    user: {
      id: user.mentraUserId,
      mentraUserId: user.mentraUserId,
      email: user.email,
      // The name the person's last sign-in carried, which the portal shows in place of their address; null when
      // no sign-in has carried one.
      name: await signInName(user.mentraUserId),
      emailVerified: principal.emailVerified,
    },
    workspaceCreation: organizationView(principal).workspaceCreation,
    onboardingRequired: org === null,
    org,
    // What this person is offered of the portal modules: billing where it is installed, usable and visible to
    // them (`billing`), and its catalog wherever it is installed and usable, staff or not (`billingCatalog`).
    modules: portalModuleAvailability(principal),
    // What Fleet's UI needs of the caller (`FleetUiMe`): organization capabilities, the workspace(s) they may use
    // Fleet in with their capabilities there, and whether Fleet is installed.
    organization: { capabilities: organizationView(principal).capabilities },
    workspaces: await fleetWorkspacesOf(principal, c.req.query("workspaceId")),
    fleet: { installed: fleetInstalled() },
  });
}

/** The last name a sign-in carried for this person, trimmed; null when there is none. One indexed read. */
async function signInName(mentraUserId: string): Promise<string | null> {
  const identity = await SigninIdentityModel.findOne({ mentraUserId }, { name: 1 }).lean();
  const name = typeof identity?.name === "string" ? identity.name.trim() : "";
  return name === "" ? null : name;
}

/**
 * The workspaces the caller may use Fleet in: their own workspace(s), with the capabilities their role gives. For
 * an Organization Admin asking about the workspace the page is open on (`?workspaceId=`), exactly that workspace
 * with an Owner's capabilities, member or not; an unknown or deleted one is simply absent.
 */
async function fleetWorkspacesOf(principal: ReturnType<typeof userPrincipal>, openWorkspaceId: string | undefined) {
  if (principal.isOrganizationAdmin && openWorkspaceId) {
    const decision = await authorize(principal, { workspaceId: openWorkspaceId });
    if (!decision.allowed || !decision.workspace) return [];
    return [
      { workspaceId: decision.workspace.workspaceId, name: decision.workspace.name, capabilities: decision.capabilities },
    ];
  }
  const mine = await listWorkspacesForUser(principal.mentraUserId);
  return mine.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    capabilities: workspace.capabilities,
  }));
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
