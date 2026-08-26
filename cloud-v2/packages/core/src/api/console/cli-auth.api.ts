import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WorkOS } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  DeveloperOrgService,
  DeveloperOrgServiceError,
  type DeveloperOrgRecord,
} from "../../services/developer-orgs/developer-org.service";
import { DeveloperApiKeyService } from "../../services/developer-orgs/developer-api-key.service";
import { DeveloperOrgInvitationService } from "../../services/developer-orgs/developer-org-invitation.service";
import { sendMiniappBetaInviteEmail, sendOrgInviteEmail } from "../../services/email/email.service";
import { MiniAppBetaService, MiniAppBetaServiceError } from "../../services/miniapps/miniapp-beta.service";
import { MiniAppService, MiniAppServiceError, type DeveloperIdentity } from "../../services/miniapps/miniapp.service";
import {
  DeveloperSigningService,
  DeveloperSigningServiceError,
  canonicalJson,
  type DeveloperJwk,
} from "../../services/miniapps/developer-signing.service";
import { sha256Hex } from "../../services/storage/storage.service";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest, OauthServerError } from "../../types/oauth.types";

const app = new Hono<AppEnv>();
const SESSION_COOKIE = "mentra_console_session";
const STATE_COOKIE = "mentra_console_state";
const PKCE_VERIFIER_COOKIE = "mentra_console_pkce_verifier";
const RETURN_TO_COOKIE = "mentra_console_return_to";
const ORG_SELECTION_COOKIE = "mentra_console_org_selection";
const DEVELOPER_ORG_COOKIE = "mentra_console_developer_org";
const developerOrgs = new DeveloperOrgService();
const apiKeys = new DeveloperApiKeyService();
const invitations = new DeveloperOrgInvitationService();
const miniapps = new MiniAppService();
const miniappBetas = new MiniAppBetaService();
const signing = new DeveloperSigningService();
const MAX_RELEASE_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_RELEASE_REQUEST_BODY_BYTES = 72 * 1024 * 1024;
const MAX_STORE_ASSET_REQUEST_BODY_BYTES = 15 * 1024 * 1024;
const releaseBodyLimit = bodyLimit({
  maxSize: MAX_RELEASE_REQUEST_BODY_BYTES,
  onError: c =>
    c.json(
      {
        error: "invalid_request",
        error_description: `release request exceeds ${MAX_RELEASE_REQUEST_BODY_BYTES} bytes`,
      },
      413,
    ),
});
const storeAssetBodyLimit = bodyLimit({
  maxSize: MAX_STORE_ASSET_REQUEST_BODY_BYTES,
  onError: c =>
    c.json(
      {
        error: "invalid_request",
        error_description: `Store asset request exceeds ${MAX_STORE_ASSET_REQUEST_BODY_BYTES} bytes`,
      },
      413,
    ),
});

const upsertDeveloperOrgSchema = z.object({
  displayName: z.string().min(1),
  packagePrefix: z.string().min(1),
  createNew: z.boolean().optional().default(false),
});

const inviteOrgMemberSchema = z.object({
  email: z.string().email(),
});

const updateOrgMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

const createMiniAppSchema = z.object({
  packageName: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
});

const updateStoreListingSchema = z.object({
  subtitle: z.string().max(120).nullable().optional(),
  longDescription: z.string().max(10_000).nullable().optional(),
  categories: z.array(z.string().max(40)).max(5).optional(),
  privacyPolicyUrl: z.string().max(2_000).nullable().optional(),
  supportUrl: z.string().max(2_000).nullable().optional(),
  websiteUrl: z.string().max(2_000).nullable().optional(),
});

const createStoreAssetSchema = z.object({
  role: z.enum(["store_icon", "store_cover", "gallery_screenshot"]),
  fileName: z.string().min(1).max(120),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/avif"]),
  base64: z.string().min(1).max(14_000_000),
});

const createReleaseSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
  releaseTrack: z.enum(["stable", "beta"]).default("stable"),
  manifest: z.record(z.string(), z.unknown()),
  bundleBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_RELEASE_BUNDLE_BYTES * 4) / 3) + 4),
  fileName: z.string().min(1).optional(),
  signedBundle: z.object({
    signingKeyId: z.string().min(1),
    signature: z.string().min(1),
    payload: z.object({
      packageName: z.string().min(1),
      version: z.string().min(1),
      bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      createdAt: z.string().min(1),
    }),
  }),
});

const createReleaseMetadataSchema = createReleaseSchema.omit({ bundleBase64: true });

const registerSigningKeySchema = z.object({
  publicKeyJwk: z.record(z.string(), z.unknown()),
});

const createApiTokenSchema = z.object({
  name: z.string().min(1).max(80),
});

const updateBetaAccessSchema = z.object({ mode: z.enum(["private", "public"]) });
const inviteBetaTesterSchema = z.object({ email: z.string().email() });

app.get("/health", c => c.json({ status: "ok", service: "cloud-core-console" }));
app.get("/auth/cli-config", getCliConfig);
app.get("/auth/login", getLogin);
app.get("/auth/social/:provider", getSocialLogin);
app.get("/auth/callback", getCallback);
app.get("/auth/organization-selection", getOrganizationSelection);
app.post("/auth/organization-selection", postOrganizationSelection);
app.get("/auth/me", getMe);
app.post("/auth/developer-organization", postDeveloperOrganizationSelection);
app.get("/org", getOrg);
app.put("/org", putOrg);
app.get("/org/access", getOrgAccess);
app.post("/org/invitations", postOrgInvitation);
app.post("/org/invitations/accept", postAcceptInvitation);
app.delete("/org/invitations/:invitationId", deleteOrgInvitation);
app.delete("/org/members/:membershipId", deleteOrgMember);
app.patch("/org/members/:membershipId", patchOrgMember);
app.get("/apps", getApps);
app.post("/apps", postApps);
app.delete("/apps/:packageName", deleteApp);
app.get("/apps/:packageName/beta-access", getBetaAccess);
app.patch("/apps/:packageName/beta-access", patchBetaAccess);
app.post("/apps/:packageName/beta-invitations", postBetaInvitation);
app.delete("/apps/:packageName/beta-invitations/:invitationId", deleteBetaInvitation);
app.get("/apps/:packageName/listing", getStoreListing);
app.put("/apps/:packageName/listing", putStoreListing);
app.post("/apps/:packageName/listing/assets", storeAssetBodyLimit, postStoreAsset);
app.get("/apps/:packageName/listing/assets/:assetId", getStoreAsset);
app.delete("/apps/:packageName/listing/assets/:assetId", deleteStoreAsset);
app.get("/apps/:packageName/releases", getReleases);
app.post("/apps/:packageName/releases", releaseBodyLimit, postRelease);
app.post("/apps/:packageName/releases/:releaseId/submit", postSubmitRelease);
app.get("/signing-keys", getSigningKeys);
app.post("/signing-keys", postSigningKey);
app.get("/tokens", getTokens);
app.post("/tokens", postToken);
app.delete("/tokens/:tokenId", deleteToken);
app.post("/auth/magic/start", postMagicStart);
app.post("/auth/magic/verify", postMagicVerify);
app.post("/auth/logout", postLogout);

function getCliConfig(c: AppContext) {
  const workosClientId = process.env.WORKOS_CLIENT_ID;
  if (!workosClientId) throw new OauthServerError("WORKOS_CLIENT_ID is not configured");
  // WorkOS client ids are intentionally public OAuth configuration. Serving
  // this from the selected Core makes the published CLI self-configuring while
  // keeping each Mentra/OEM environment independent.
  return c.json({ workosClientId });
}

function getLogin(c: AppContext) {
  return redirectToWorkos(c, "authkit");
}

function getSocialLogin(c: AppContext) {
  const providerParam = c.req.param("provider");
  const provider = providerParam === "github" ? "GitHubOAuth" : providerParam === "google" ? "GoogleOAuth" : null;
  if (!provider) throw new InvalidRequest("unsupported social provider");
  return redirectToWorkos(c, provider);
}

async function redirectToWorkos(c: AppContext, provider: string) {
  const returnTo = safeReturnTo(c.req.query("return_to"));
  const config = workosConfig();
  const authUrl = await workos().userManagement.getAuthorizationUrlWithPKCE({
    provider,
    clientId: config.clientId,
    redirectUri: redirectUriForRequest(c),
    loginHint: c.req.query("login_hint"),
  });

  const state = authUrl.state;
  setCookie(c, STATE_COOKIE, state, {
    path: "/api/console/auth",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies(),
    maxAge: 10 * 60,
  });
  setCookie(c, PKCE_VERIFIER_COOKIE, authUrl.codeVerifier, {
    path: "/api/console/auth",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies(),
    maxAge: 10 * 60,
  });
  if (returnTo) {
    setCookie(c, RETURN_TO_COOKIE, returnTo, {
      path: "/api/console/auth",
      httpOnly: true,
      sameSite: "Lax",
      secure: shouldUseSecureCookies(),
      maxAge: 10 * 60,
    });
  } else {
    deleteCookie(c, RETURN_TO_COOKIE, { path: "/api/console/auth" });
  }

  return c.redirect(authUrl.url);
}

async function getCallback(c: AppContext) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, STATE_COOKIE);
  const codeVerifier = getCookie(c, PKCE_VERIFIER_COOKIE);
  const returnTo = safeReturnTo(getCookie(c, RETURN_TO_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: "/api/console/auth" });
  deleteCookie(c, PKCE_VERIFIER_COOKIE, { path: "/api/console/auth" });
  deleteCookie(c, RETURN_TO_COOKIE, { path: "/api/console/auth" });

  if (!code) {
    return redirectToConsoleLoginError(c, "Sign-in could not be completed. Please try again.", returnTo);
  }
  if (!state || !expectedState || state !== expectedState) {
    return redirectToConsoleLoginError(c, "Sign-in expired. Please try again.", returnTo);
  }
  if (!codeVerifier) {
    return redirectToConsoleLoginError(c, "Sign-in expired. Please try again.", returnTo);
  }

  const config = workosConfig();
  let response: Awaited<ReturnType<ReturnType<typeof workos>["userManagement"]["authenticateWithCode"]>>;
  try {
    response = await workos().userManagement.authenticateWithCode({
      code,
      codeVerifier,
      clientId: config.clientId,
      session: {
        sealSession: true,
        cookiePassword: config.cookiePassword,
      },
    });
  } catch (error) {
    if (isWorkosRequestError(error)) {
      const body = workosErrorBody(error);
      c.var.logger.warn(
        { status: workosErrorStatus(error), error: body.error, errorDescription: body.error_description },
        "WorkOS console callback exchange failed",
      );
      const selection = await filterOrganizationSelectionForCore(workosOrganizationSelection(error));
      if (selection) {
        if (selection.organizations.length === 1) {
          return completeOrganizationSelection(
            c,
            { ...selection, returnTo },
            selection.organizations[0].id,
            "redirect",
          );
        }
        setOrganizationSelectionCookie(c, selection, returnTo);
        return c.redirect(`${config.consoleUrl}/select-organization`);
      }
      return redirectToConsoleLoginError(c, "Sign-in expired or could not be completed. Please try again.", returnTo);
    }
    throw error;
  }

  setSessionCookie(c, response.sealedSession);
  return c.redirect(returnTo ?? `${config.consoleUrl}/dashboard`);
}

function getOrganizationSelection(c: AppContext) {
  const selection = getOrganizationSelectionCookie(c);
  if (!selection) {
    return c.json(
      { error: "organization_selection_expired", error_description: "Sign-in expired. Please try again." },
      401,
    );
  }

  return c.json({
    organizations: selection.organizations,
    returnTo: selection.returnTo,
  });
}

async function postOrganizationSelection(c: AppContext) {
  const selection = getOrganizationSelectionCookie(c);
  if (!selection) {
    return c.json(
      { error: "organization_selection_expired", error_description: "Sign-in expired. Please try again." },
      401,
    );
  }

  const body = await readJsonBody(c);
  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  if (!selection.organizations.some(org => org.id === organizationId)) {
    throw new InvalidRequest("choose a valid organization");
  }

  return completeOrganizationSelection(c, selection, organizationId, "json");
}

async function completeOrganizationSelection(
  c: AppContext,
  selection: StoredOrganizationSelection,
  organizationId: string,
  responseMode: "json" | "redirect",
): Promise<Response> {
  const config = workosConfig();
  let response: Awaited<
    ReturnType<ReturnType<typeof workos>["userManagement"]["authenticateWithOrganizationSelection"]>
  >;
  try {
    response = await workos().userManagement.authenticateWithOrganizationSelection({
      organizationId,
      pendingAuthenticationToken: selection.pendingAuthenticationToken,
      clientId: config.clientId,
      session: {
        sealSession: true,
        cookiePassword: config.cookiePassword,
      },
    });
  } catch (error) {
    if (isWorkosRequestError(error)) {
      const body = workosErrorBody(error);
      c.var.logger.warn(
        { status: workosErrorStatus(error), error: body.error, errorDescription: body.error_description },
        "WorkOS console organization selection failed",
      );
      deleteCookie(c, ORG_SELECTION_COOKIE, { path: "/api/console/auth" });
      return new Response(
        JSON.stringify({
          error: body.error,
          error_description: body.error_description || "Sign-in could not be completed.",
        }),
        {
          status: workosErrorStatus(error),
          headers: { "content-type": "application/json" },
        },
      );
    }
    throw error;
  }

  deleteCookie(c, ORG_SELECTION_COOKIE, { path: "/api/console/auth" });
  setSessionCookie(c, response.sealedSession);
  const redirectTo = selection.returnTo ?? `${config.consoleUrl}/dashboard`;
  return responseMode === "json" ? c.json({ redirectTo }) : c.redirect(redirectTo);
}

async function postMagicStart(c: AppContext) {
  const body = await readJsonBody(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) throw new InvalidRequest("email is required");

  try {
    await workos().userManagement.createMagicAuth({
      email,
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: c.req.header("user-agent"),
    });
  } catch (error) {
    return c.json(workosErrorBody(error), 400);
  }

  return c.json({ ok: true, email });
}

async function postMagicVerify(c: AppContext) {
  const body = await readJsonBody(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!email) throw new InvalidRequest("email is required");
  if (!code) throw new InvalidRequest("code is required");

  const config = workosConfig();
  let response;
  try {
    response = await workos().userManagement.authenticateWithMagicAuth({
      clientId: config.clientId,
      email,
      code,
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: c.req.header("user-agent"),
      session: {
        sealSession: true,
        cookiePassword: config.cookiePassword,
      },
    });
  } catch (error) {
    return c.json(workosErrorBody(error), 400);
  }

  setSessionCookie(c, response.sealedSession);
  return c.json({
    ok: true,
    user: {
      id: response.user.id,
      email: response.user.email,
      firstName: response.user.firstName,
      lastName: response.user.lastName,
    },
    organizationId: response.organizationId ?? null,
  });
}

async function getMe(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ authenticated: false, reason: authenticatedSession.reason }, 401);
  }
  const accessibleOrgs = await developerOrgs.listOrgsForUser(authenticatedSession.user);
  const developerOrg = await resolveDeveloperOrgForRequest(c, authenticatedSession, accessibleOrgs);
  // Keep the roster fresh: ensure a membership row for the current human user
  // and backfill their profile fields (skips API-key principals).
  if (developerOrg && !authenticatedSession.user.id.startsWith("api_key:")) {
    // Self-heal ONLY an ownerless org (a failed create-time ensureOwner): if any
    // owner already exists we must not re-grant owner to a demoted creator.
    if (
      authenticatedSession.user.id === developerOrg.ownerUserId &&
      (await developerOrgs.countOwners(developerOrg.id)) === 0
    ) {
      await developerOrgs.ensureOwner(developerOrg.id, authenticatedSession.user.id);
    }
    await developerOrgs.ensureMembership(developerOrg.id, authenticatedSession.user.id, {
      email: authenticatedSession.user.email,
      name: sessionDisplayName(authenticatedSession),
    });
  }
  const viewerRole = developerOrg ? await resolveOrgRole(authenticatedSession, developerOrg) : null;

  return c.json({
    authenticated: true,
    user: {
      id: authenticatedSession.user.id,
      email: authenticatedSession.user.email,
      firstName: authenticatedSession.user.firstName,
      lastName: authenticatedSession.user.lastName,
    },
    onboardingRequired: developerOrg === null,
    viewerRole,
    organizationId: developerOrg?.id ?? null,
    packagePrefix: developerOrg?.packagePrefix ?? null,
    packagePrefixStatus: developerOrg?.packagePrefixStatus ?? null,
    organizations: accessibleOrgs,
  });
}

async function postDeveloperOrganizationSelection(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated || authenticatedSession.developerOrgId) {
    return c.json({ error: "unauthorized", error_description: "interactive console session required" }, 401);
  }
  const body = await readJsonBody(c);
  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  const organizations = await developerOrgs.listOrgsForUser(authenticatedSession.user);
  const organization = organizations.find(candidate => candidate.id === organizationId);
  if (!organization) {
    return c.json({ error: "forbidden", error_description: "you do not have access to that organization" }, 403);
  }
  setDeveloperOrgCookie(c, organization.id);
  return c.json({ ok: true, organizationId: organization.id });
}

async function getOrg(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ error: "unauthorized", error_description: "console session required" }, 401);
  }

  const org = await resolveDeveloperOrgForRequest(c, authenticatedSession);
  return c.json({ org });
}

async function putOrg(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ error: "unauthorized", error_description: "console session required" }, 401);
  }

  const parsed = upsertDeveloperOrgSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid organization payload");
  if (parsed.data.createNew && authenticatedSession.developerOrgId) {
    return c.json(
      { error: "forbidden", error_description: "an interactive developer login is required to create an organization" },
      403,
    );
  }

  try {
    const orgInput = { displayName: parsed.data.displayName, packagePrefix: parsed.data.packagePrefix };
    const accessibleOrgs = await developerOrgs.listOrgsForUser(authenticatedSession.user);
    const existingOrg = parsed.data.createNew
      ? null
      : await resolveDeveloperOrgForRequest(c, authenticatedSession, accessibleOrgs);
    if (!parsed.data.createNew && !existingOrg && accessibleOrgs.length > 0) {
      return c.json(
        { error: "organization_selection_required", error_description: "select a developer organization first" },
        409,
      );
    }
    let org: DeveloperOrgRecord;
    if (existingOrg) {
      // Editing an existing org is owner-only, gated on the role not the
      // ownerUserId scalar. Self-heal the creator's owner row first: a failed
      // ensureOwner during creation must not permanently brick onboarding.
      let role = await resolveOrgRole(authenticatedSession, existingOrg);
      // Self-heal only an ownerless org — never re-grant owner to a demoted creator.
      if (
        role !== "owner" &&
        authenticatedSession.user.id === existingOrg.ownerUserId &&
        (await developerOrgs.countOwners(existingOrg.id)) === 0
      ) {
        await developerOrgs.ensureOwner(existingOrg.id, authenticatedSession.user.id);
        role = "owner";
      }
      if (role !== "owner") {
        return c.json({ error: "forbidden", error_description: "only owners can update the organization" }, 403);
      }
      org = await developerOrgs.updateOrg(existingOrg.id, authenticatedSession.user, orgInput);
    } else {
      org = await developerOrgs.createPrimaryOrg(authenticatedSession.user, orgInput);
    }
    const linkedOrg = await ensureWorkosOrgLinked(authenticatedSession, org);
    setDeveloperOrgCookie(c, linkedOrg.id);
    await syncWorkosOrgName(linkedOrg);
    return c.json({ org: linkedOrg });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function getOrgAccess(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;

  try {
    return c.json({
      org: developer.org,
      viewerRole: await resolveOrgRole(developer.auth, developer.org),
      members: await listOrgMembers(developer.org),
      invitations: await invitations.listPending(developer.org.id),
    });
  } catch (error) {
    return serviceError(error);
  }
}

async function postOrgInvitation(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!roleAtLeast(await resolveOrgRole(developer.auth, developer.org), "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can invite members" }, 403);
  }

  const parsed = inviteOrgMemberSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid invitation payload");

  const email = parsed.data.email.trim().toLowerCase();
  try {
    // Invitees join as `member`; an owner/admin promotes them afterwards.
    const { record, token } = await invitations.create(developer.org.id, email, "member", developer.auth.user.id);
    const inviteUrl = `${workosConfig().consoleUrl}/invite/${token}`;
    // Email is best-effort (Resend); inviteUrl is the copy-link fallback.
    void sendOrgInviteEmail({
      to: email,
      orgName: developer.org.name,
      inviterName: sessionDisplayName(developer.auth),
      role: record.role,
      acceptUrl: inviteUrl,
    });
    return c.json({ invitation: record, inviteUrl }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function postAcceptInvitation(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ error: "unauthorized", error_description: "console session required" }, 401);
  }

  const body = await readJsonBody(c);
  const token = typeof (body as { token?: unknown })?.token === "string" ? (body as { token: string }).token : "";
  if (!token) throw new InvalidRequest("token is required");

  try {
    const invite = await invitations.peek(token);
    if (!invite) {
      return c.json(
        { error: "invalid_invitation", error_description: "this invitation is invalid or has expired" },
        404,
      );
    }
    // The invite is addressed to a specific email; the signed-in account must match.
    if (authenticatedSession.user.email.trim().toLowerCase() !== invite.email) {
      return c.json(
        { error: "email_mismatch", error_description: "this invitation was sent to a different email address" },
        403,
      );
    }
    // Single-use: atomically claim the invite before creating the membership so
    // two concurrent accepts can't both enroll.
    if (!(await invitations.claim(invite.invitationId))) {
      return c.json({ error: "invalid_invitation", error_description: "this invitation has already been used" }, 404);
    }
    // Join with the invited role (role kept if already a member). If the write
    // fails, un-claim so the invitee can retry with the same link.
    try {
      await developerOrgs.ensureMembership(invite.orgId, authenticatedSession.user.id, {
        email: authenticatedSession.user.email,
        name: sessionDisplayName(authenticatedSession),
        roleIfNew: invite.role,
      });
    } catch (err) {
      await invitations.unclaim(invite.invitationId);
      throw err;
    }
    setDeveloperOrgCookie(c, invite.orgId);
    return c.json({ ok: true, org: await developerOrgs.getOrgById(invite.orgId) });
  } catch (error) {
    return serviceError(error);
  }
}

async function deleteOrgInvitation(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!roleAtLeast(await resolveOrgRole(developer.auth, developer.org), "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can revoke invitations" }, 403);
  }
  const invitationId = c.req.param("invitationId");
  if (!invitationId) throw new InvalidRequest("invitationId is required");

  try {
    if (!(await invitations.revoke(developer.org.id, invitationId))) {
      return c.json({ error: "not_found", error_description: "invitation was not found" }, 404);
    }
    return c.json({ ok: true });
  } catch (error) {
    return serviceError(error);
  }
}

async function deleteOrgMember(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  const actorRole = await resolveOrgRole(developer.auth, developer.org);
  if (!roleAtLeast(actorRole, "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can remove members" }, 403);
  }
  const targetUserId = c.req.param("membershipId"); // the member's userId
  if (!targetUserId) throw new InvalidRequest("member id is required");
  const org = developer.org;

  try {
    const targetRole = await developerOrgs.getMemberRole(org.id, targetUserId);
    if (targetRole === null) {
      return c.json({ error: "not_found", error_description: "member was not found" }, 404);
    }
    // Removing an owner requires being an owner, and never the last one.
    if (targetRole === "owner") {
      if (actorRole !== "owner") {
        return c.json({ error: "forbidden", error_description: "only an owner can remove another owner" }, 403);
      }
      if (!(await developerOrgs.removeOwnerIfNotLast(org.id, targetUserId))) {
        return c.json({ error: "last_owner", error_description: "an organization must keep at least one owner" }, 409);
      }
    }
    // If we're removing the created-by pointer, hand it to another owner.
    if (targetUserId === org.ownerUserId) {
      const nextOwner = await developerOrgs.findAnotherOwner(org.id, targetUserId);
      if (!nextOwner) {
        return c.json({ error: "last_owner", error_description: "an organization must keep at least one owner" }, 409);
      }
      await developerOrgs.reassignCreator(org.id, nextOwner);
    }
    await developerOrgs.removeMemberRole(org.id, targetUserId);
    return c.json({ ok: true });
  } catch (error) {
    return serviceError(error);
  }
}

async function patchOrgMember(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  const actorRole = await resolveOrgRole(developer.auth, developer.org);
  if (!roleAtLeast(actorRole, "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can change member roles" }, 403);
  }
  const targetUserId = c.req.param("membershipId"); // the member's userId
  if (!targetUserId) throw new InvalidRequest("member id is required");

  const parsed = updateOrgMemberRoleSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid role payload");
  const org = developer.org;

  try {
    const newRole = parsed.data.role;
    const targetRole = await developerOrgs.getMemberRole(org.id, targetUserId);
    if (targetRole === null) {
      return c.json({ error: "not_found", error_description: "member was not found" }, 404);
    }
    // Granting or changing the owner role is owner-only (no admin can mint an
    // owner or demote one); admins may only move members between admin/member.
    if ((newRole === "owner" || targetRole === "owner") && actorRole !== "owner") {
      return c.json({ error: "forbidden", error_description: "only an owner can grant or change the owner role" }, 403);
    }
    // Demoting an owner is race-guarded so two concurrent requests can't both
    // pass a count check and leave the org with no owner.
    if (targetRole === "owner" && newRole !== "owner") {
      if (!(await developerOrgs.demoteOwner(org.id, targetUserId, newRole))) {
        return c.json({ error: "last_owner", error_description: "an organization must keep at least one owner" }, 409);
      }
    } else {
      await developerOrgs.setMemberRole(org.id, targetUserId, newRole);
    }
    return c.json({ ok: true, role: newRole });
  } catch (error) {
    return serviceError(error);
  }
}

async function getApps(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;

  return c.json({ apps: await miniapps.listMiniApps(developer.value) });
}

async function postApps(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;

  const parsed = createMiniAppSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid app payload");

  try {
    const appRecord = await miniapps.createMiniApp(developer.value, parsed.data);
    return c.json({ app: appRecord }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function deleteApp(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");

  try {
    return c.json(await miniapps.deleteMiniApp(developer.value, packageName));
  } catch (error) {
    return serviceError(error);
  }
}

async function getBetaAccess(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  try {
    return c.json(await miniappBetas.getAccess(developer.value, packageName));
  } catch (error) {
    return serviceError(error);
  }
}

async function patchBetaAccess(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  const parsed = updateBetaAccessSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid beta access payload");
  try {
    return c.json(await miniappBetas.setAccessMode(developer.value, packageName, parsed.data.mode));
  } catch (error) {
    return serviceError(error);
  }
}

async function postBetaInvitation(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  const parsed = inviteBetaTesterSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid beta invitation payload");
  try {
    const invitation = await miniappBetas.invite(developer.value, packageName, parsed.data.email);
    void sendMiniappBetaInviteEmail({
      to: invitation.email,
      packageName,
      inviterName: developer.value.email ?? "A Mentra developer",
    });
    return c.json({ invitation }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function deleteBetaInvitation(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  const invitationId = c.req.param("invitationId");
  if (!packageName || !invitationId) throw new InvalidRequest("packageName and invitationId are required");
  try {
    return c.json(await miniappBetas.revoke(developer.value, packageName, invitationId));
  } catch (error) {
    return serviceError(error);
  }
}

async function getStoreListing(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  try {
    return c.json({ listing: await miniapps.getStoreListing(developer.value, packageName) });
  } catch (error) {
    return serviceError(error);
  }
}

async function putStoreListing(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  const parsed = updateStoreListingSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid listing payload");
  try {
    return c.json({ listing: await miniapps.updateStoreListing(developer.value, packageName, parsed.data) });
  } catch (error) {
    return serviceError(error);
  }
}

async function postStoreAsset(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");
  const parsed = createStoreAssetSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid asset payload");
  try {
    const bytes = Uint8Array.from(Buffer.from(parsed.data.base64, "base64"));
    return c.json(
      {
        asset: await miniapps.createStoreAsset(developer.value, packageName, {
          role: parsed.data.role,
          fileName: parsed.data.fileName,
          contentType: parsed.data.contentType,
          bytes,
        }),
      },
      201,
    );
  } catch (error) {
    return serviceError(error);
  }
}

async function deleteStoreAsset(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  const assetId = c.req.param("assetId");
  if (!packageName || !assetId) throw new InvalidRequest("packageName and assetId are required");
  try {
    return c.json(await miniapps.deleteStoreAsset(developer.value, packageName, assetId));
  } catch (error) {
    return serviceError(error);
  }
}

async function getStoreAsset(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  const assetId = c.req.param("assetId");
  if (!packageName || !assetId) throw new InvalidRequest("packageName and assetId are required");
  try {
    const { asset, bytes } = await miniapps.getStoreAsset(developer.value, packageName, assetId);
    return new Response(bytes, {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.sizeBytes),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return serviceError(error);
  }
}

async function getReleases(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  if (!packageName) throw new InvalidRequest("packageName is required");

  try {
    return c.json({ releases: await miniapps.listReleases(developer.value, packageName) });
  } catch (error) {
    return serviceError(error);
  }
}

async function postRelease(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;

  const contentType = c.req.header("content-type") ?? "";
  let candidate: unknown;
  let multipartBundle: Uint8Array | undefined;
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    const manifest = parseFormJson(form.get("manifest"), "manifest");
    const signedBundle = parseFormJson(form.get("signedBundle"), "signedBundle");
    const bundle = form.get("bundle");
    if (!(bundle instanceof File)) throw new InvalidRequest("bundle file is required");
    multipartBundle = new Uint8Array(await bundle.arrayBuffer());
    candidate = {
      packageName: form.get("packageName"),
      version: form.get("version"),
      releaseTrack: form.get("releaseTrack") || "stable",
      fileName: form.get("fileName") || bundle.name,
      manifest,
      signedBundle,
    };
  } else {
    candidate = await readJsonBody(c);
  }
  const parsed = (multipartBundle ? createReleaseMetadataSchema : createReleaseSchema).safeParse(candidate);
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid release payload");
  const pathPackageName = c.req.param("packageName");
  if (pathPackageName !== parsed.data.packageName) {
    throw new InvalidRequest("packageName must match URL");
  }

  try {
    const bundle =
      multipartBundle ??
      Uint8Array.from(Buffer.from((parsed.data as z.infer<typeof createReleaseSchema>).bundleBase64, "base64"));
    assertSignedReleaseMatchesUpload(parsed.data.signedBundle.payload, {
      packageName: parsed.data.packageName,
      version: parsed.data.version,
      manifest: parsed.data.manifest,
      bundle,
    });
    await signing.verifyBundleSignature(developer.value, parsed.data.signedBundle);
    const release = await miniapps.createRelease(developer.value, {
      packageName: parsed.data.packageName,
      version: parsed.data.version,
      releaseTrack: parsed.data.releaseTrack,
      manifest: parsed.data.manifest,
      bundle,
      fileName: parsed.data.fileName,
      signedBundle: parsed.data.signedBundle,
    });
    return c.json({ release }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

function parseFormJson(value: string | File | null, field: string): unknown {
  if (typeof value !== "string") throw new InvalidRequest(`${field} is required`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new InvalidRequest(`${field} must be valid JSON`);
  }
}

function assertSignedReleaseMatchesUpload(
  payload: { packageName: string; version: string; bundleSha256: string; manifestSha256: string },
  input: { packageName: string; version: string; manifest: Record<string, unknown>; bundle: Uint8Array },
): void {
  if (payload.packageName !== input.packageName) {
    throw new InvalidRequest("signed packageName does not match release packageName");
  }
  if (payload.version !== input.version) {
    throw new InvalidRequest("signed version does not match release version");
  }
  const actualBundleSha = sha256Hex(input.bundle);
  if (payload.bundleSha256 !== actualBundleSha) {
    throw new InvalidRequest("signed bundleSha256 does not match uploaded bundle");
  }
  const actualManifestSha = sha256Hex(Buffer.from(canonicalJson(input.manifest)));
  if (payload.manifestSha256 !== actualManifestSha) {
    throw new InvalidRequest("signed manifestSha256 does not match uploaded manifest");
  }
}

async function getSigningKeys(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;

  try {
    return c.json({ keys: await signing.listKeys(developer.value) });
  } catch (error) {
    return serviceError(error);
  }
}

async function postSigningKey(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;

  const parsed = registerSigningKeySchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid signing key payload");

  try {
    const key = await signing.registerKey(developer.value, {
      publicKeyJwk: parsed.data.publicKeyJwk as DeveloperJwk,
    });
    return c.json({ key }, 201);
  } catch (error) {
    return serviceError(error);
  }
}

async function postSubmitRelease(c: AppContext) {
  const developer = await requireDeveloper(c);
  if (!developer.ok) return developer.response;
  const packageName = c.req.param("packageName");
  const releaseId = c.req.param("releaseId");
  if (!packageName) throw new InvalidRequest("packageName is required");
  if (!releaseId) throw new InvalidRequest("releaseId is required");

  try {
    return c.json({ release: await miniapps.submitRelease(developer.value, packageName, releaseId) });
  } catch (error) {
    return serviceError(error);
  }
}

async function getTokens(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;

  try {
    return c.json({ tokens: await apiKeys.list(developer.org.id, consoleEnvironmentLabel()) });
  } catch (error) {
    return serviceError(error);
  }
}

async function postToken(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!roleAtLeast(await resolveOrgRole(developer.auth, developer.org), "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can create API keys" }, 403);
  }

  const parsed = createApiTokenSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid API key payload");

  try {
    // Ensure the org is WorkOS-linked so the key authenticates back to it (the
    // runtime auth path still resolves orgs by workosOrgId for now).
    await ensureWorkosOrgLinked(developer.auth, developer.org);
    const token = await apiKeys.create(
      developer.org.id,
      parsed.data.name.trim(),
      developer.auth.user.id,
      consoleEnvironmentLabel(),
    );
    return c.json({ token }, 201);
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function deleteToken(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!roleAtLeast(await resolveOrgRole(developer.auth, developer.org), "admin")) {
    return c.json({ error: "forbidden", error_description: "only owners and admins can revoke API keys" }, 403);
  }

  const tokenId = c.req.param("tokenId");
  if (!tokenId) throw new InvalidRequest("tokenId is required");

  try {
    if (!(await apiKeys.revoke(developer.org.id, tokenId))) {
      return c.json({ error: "not_found", error_description: "API key was not found" }, 404);
    }
    return c.json({ ok: true });
  } catch (error) {
    return serviceError(error);
  }
}

async function ensureWorkosOrgLinked(
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
  org: DeveloperOrgRecord,
): Promise<DeveloperOrgRecord> {
  if (org.workosOrgId) return org;
  // Any owner (by role) may bootstrap the WorkOS org, not only the creator.
  if ((await resolveOrgRole(authenticatedSession, org)) !== "owner") {
    throw new DeveloperOrgServiceError("team_access_not_ready", "team access is not ready for this org yet", 409);
  }

  // The WorkOS org is kept only as the auth/SSO context (membership lives in our
  // DB now), created lazily and linked back onto our org.
  const createdOrg = await workos().organizations.createOrganization({
    name: org.name,
    externalId: org.id,
    metadata: workosOrgMetadata(org),
  });
  return developerOrgs.setWorkosOrgId(org.id, createdOrg.id);
}

async function syncWorkosOrgName(org: DeveloperOrgRecord): Promise<void> {
  if (!org.workosOrgId) return;
  await workos().organizations.updateOrganization({
    organization: org.workosOrgId,
    name: org.name,
    metadata: workosOrgMetadata(org),
  });
}

function workosOrgMetadata(org: DeveloperOrgRecord): Record<string, string> {
  return {
    packagePrefix: org.packagePrefix,
    mentraConsole: "console2",
    coreEnvironment: consoleEnvironmentLabel(),
  };
}

function consoleEnvironmentLabel(): string {
  const explicit = process.env.CLOUD_CORE_ENVIRONMENT;
  if (explicit) return explicit;

  const consoleUrl = process.env.CONSOLE2_URL;
  if (!consoleUrl) return "local";
  try {
    const host = new URL(consoleUrl).hostname;
    if (host.includes(".dev.")) return "dev";
    if (host.includes(".staging.")) return "staging";
    if (host === "console2.mentraglass.com") return "prod";
    if (host === "localhost" || host === "127.0.0.1") return "local";
    return host;
  } catch {
    return "local";
  }
}

async function listOrgMembers(org: DeveloperOrgRecord): Promise<ConsoleOrgMember[]> {
  const members = await developerOrgs.listMembers(org.id);
  return members.map(member => ({
    id: member.userId,
    userId: member.userId,
    email: member.email,
    name: member.name,
    avatarUrl: null,
    role: member.role,
    status: member.status,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  }));
}

type OrgRole = "owner" | "admin" | "member";
const ORG_ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * The caller's role in an org. `owner` comes from `DeveloperOrg.ownerUserId`
 * (single source of truth); everyone else is the admin/member overlay stored in
 * our DB (default `member`). WorkOS is identity/roster only and is not consulted
 * for roles.
 */
async function resolveOrgRole(
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
  org: DeveloperOrgRecord,
): Promise<OrgRole> {
  // Ownership is purely a membership role now; ownerUserId is just created-by.
  const role = await developerOrgs.getMemberRole(org.id, authenticatedSession.user.id);
  return role ?? "member";
}

function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[min];
}

function sessionDisplayName(auth: Extract<ConsoleAuthResult, { authenticated: true }>): string {
  return [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ").trim() || auth.user.email;
}

type ConsoleOrgMember = {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: OrgRole;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ConsoleAuthResult =
  | {
      authenticated: true;
      user: {
        id: string;
        email: string;
        firstName?: string | null;
        lastName?: string | null;
      };
      organizationId?: string | null;
      developerOrgId?: string | null;
    }
  | { authenticated: false; reason: string };

async function requireDeveloper(
  c: AppContext,
): Promise<{ ok: true; value: DeveloperIdentity } | { ok: false; response: Response }> {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer;

  return {
    ok: true,
    value: {
      developerId: developer.auth.user.id,
      email: developer.auth.user.email,
      orgId: developer.org.id,
      packagePrefix: developer.org.packagePrefix,
    },
  };
}

async function requireConsoleOrg(
  c: AppContext,
): Promise<
  | { ok: true; auth: Extract<ConsoleAuthResult, { authenticated: true }>; org: DeveloperOrgRecord }
  | { ok: false; response: Response }
> {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return {
      ok: false,
      response: c.json({ error: "unauthorized", error_description: "console session required" }, 401),
    };
  }
  const accessibleOrgs = await developerOrgs.listOrgsForUser(authenticatedSession.user);
  const developerOrg = await resolveDeveloperOrgForRequest(c, authenticatedSession, accessibleOrgs);
  if (!developerOrg) {
    const selectionRequired =
      (accessibleOrgs.length > 0 && Boolean(c.req.header("x-mentra-developer-org-id")?.trim())) ||
      (Boolean(bearerToken(c)) && accessibleOrgs.length > 1);
    return {
      ok: false,
      response: selectionRequired
        ? c.json(
            { error: "organization_selection_required", error_description: "select a developer organization first" },
            409,
          )
        : c.json(
            { error: "organization_required", error_description: "create a developer org before using this API" },
            428,
          ),
    };
  }
  return { ok: true, auth: authenticatedSession, org: developerOrg };
}

async function resolveDeveloperOrgForRequest(
  c: AppContext,
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
  knownOrganizations?: DeveloperOrgRecord[],
): Promise<DeveloperOrgRecord | null> {
  // API-key principals carry their org directly.
  if (authenticatedSession.developerOrgId) {
    const keyOrg = await developerOrgs.getOrgById(authenticatedSession.developerOrgId);
    if (keyOrg) return keyOrg;
  }

  const organizations = knownOrganizations ?? (await developerOrgs.listOrgsForUser(authenticatedSession.user));

  // CLI calls carry the developer-org id selected by `mentra org use`.
  // Validate it against the authenticated user's accessible roster instead of
  // depending on browser cookies or an arbitrary first-org fallback.
  const requestedDeveloperOrgId = c.req.header("x-mentra-developer-org-id")?.trim();
  if (requestedDeveloperOrgId) {
    return organizations.find(org => org.id === requestedDeveloperOrgId) ?? null;
  }

  const selectedId = getCookie(c, DEVELOPER_ORG_COOKIE);
  const selected = organizations.find(org => org.id === selectedId);
  if (selected) return selected;

  // A WorkOS-selected organization is the best initial choice when it maps to
  // an accessible developer org. Subsequent in-console selection uses the
  // separately validated developer-org cookie above.
  const workosSelected = organizations.find(org => org.workosOrgId === authenticatedSession.organizationId);
  if (workosSelected) return workosSelected;

  // A bearer caller with multiple accessible orgs must select one through its
  // developer-org context. Browser sessions retain the deterministic first-org
  // fallback until the validated developer-org cookie is set.
  if (bearerToken(c) && organizations.length > 1) return null;
  if (organizations[0]) return organizations[0];

  // NOTE: access requires a roster row (or being the creator). We intentionally
  // do NOT auto-join from a WorkOS org_id here — that would resurrect removed
  // members (whose vestigial WorkOS membership lingers) and grant access off
  // stale state. Real SSO provisioning will create a roster row explicitly.
  return null;
}

export async function authenticateConsoleSession(c: AppContext): Promise<ConsoleAuthResult> {
  const bearer = bearerToken(c);
  if (bearer) return authenticateBearerToken(bearer);

  const sessionData = getCookie(c, SESSION_COOKIE);
  if (!sessionData) return { authenticated: false, reason: "no_session_cookie_provided" };

  const session = workos().userManagement.loadSealedSession({
    sessionData,
    cookiePassword: workosConfig().cookiePassword,
  });
  const result = await session.authenticate();
  const failureReason = result.authenticated ? "unknown" : result.reason;
  let authenticatedSession: {
    user: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    };
    organizationId?: string | null;
  } | null = result.authenticated ? result : null;

  if (!result.authenticated && result.reason === "invalid_jwt") {
    const refreshed = await session.refresh();
    if (refreshed.authenticated) {
      setSessionCookie(c, refreshed.sealedSession);
      authenticatedSession = refreshed;
    } else {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return { authenticated: false, reason: refreshed.reason };
    }
  }
  if (!authenticatedSession) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return { authenticated: false, reason: failureReason };
  }

  return {
    authenticated: true,
    user: {
      id: authenticatedSession.user.id,
      email: authenticatedSession.user.email,
      firstName: authenticatedSession.user.firstName,
      lastName: authenticatedSession.user.lastName,
    },
    organizationId: authenticatedSession.organizationId ?? null,
  };
}

async function authenticateBearerToken(token: string): Promise<ConsoleAuthResult> {
  try {
    const config = workosConfig();
    const jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${config.clientId}`));
    const verified = await jwtVerify(token, jwks);
    const sub = typeof verified.payload.sub === "string" ? verified.payload.sub : "";
    if (!sub) return { authenticated: false, reason: "missing_sub" };

    let email = typeof verified.payload.email === "string" ? verified.payload.email : "";
    let firstName: string | null = typeof verified.payload.first_name === "string" ? verified.payload.first_name : null;
    let lastName: string | null = typeof verified.payload.last_name === "string" ? verified.payload.last_name : null;
    try {
      const user = await workos().userManagement.getUser(sub);
      email = user.email || email;
      firstName = user.firstName ?? firstName;
      lastName = user.lastName ?? lastName;
    } catch {
      // The verified token is enough for API auth; profile fetch only improves display data.
    }

    return {
      authenticated: true,
      user: {
        id: sub,
        email: email || "unknown",
        firstName,
        lastName,
      },
      organizationId: typeof verified.payload.org_id === "string" ? verified.payload.org_id : null,
    };
  } catch {
    return authenticateApiKeyToken(token);
  }
}

async function authenticateApiKeyToken(token: string): Promise<ConsoleAuthResult> {
  try {
    const validated = await apiKeys.validate(token, consoleEnvironmentLabel());
    if (!validated) return { authenticated: false, reason: "invalid_bearer_token" };
    return {
      authenticated: true,
      user: {
        id: `api_key:${validated.keyId}`,
        email: `api-key@${validated.keyId}.local`,
        firstName: "API key",
        lastName: null,
      },
      developerOrgId: validated.orgId,
    };
  } catch {
    return { authenticated: false, reason: "invalid_bearer_token" };
  }
}

function bearerToken(c: AppContext): string | null {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function serviceError(error: unknown): Response {
  if (error instanceof MiniAppBetaServiceError) {
    return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof MiniAppServiceError) {
    return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof DeveloperOrgServiceError) {
    return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof DeveloperSigningServiceError) {
    return new Response(JSON.stringify({ error: error.code, error_description: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json" },
    });
  }
  throw error;
}

async function postLogout(c: AppContext) {
  const sessionData = getCookie(c, SESSION_COOKIE);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, DEVELOPER_ORG_COOKIE, { path: "/" });
  if (!sessionData) return c.json({ ok: true, logoutUrl: null });

  const session = workos().userManagement.loadSealedSession({
    sessionData,
    cookiePassword: workosConfig().cookiePassword,
  });
  const logoutUrl = await session.getLogoutUrl({ returnTo: workosConfig().consoleUrl });
  return c.json({ ok: true, logoutUrl });
}

function workos(): WorkOS {
  const config = workosConfig();
  return new WorkOS(config.apiKey, { clientId: config.clientId });
}

function setSessionCookie(c: AppContext, sealedSession: string | undefined): void {
  if (!sealedSession) throw new OauthServerError("WorkOS did not return a sealed session");
  setCookie(c, SESSION_COOKIE, sealedSession, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies(),
    maxAge: 30 * 24 * 60 * 60,
  });
}

function setDeveloperOrgCookie(c: AppContext, organizationId: string): void {
  setCookie(c, DEVELOPER_ORG_COOKIE, organizationId, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies(),
    maxAge: 30 * 24 * 60 * 60,
  });
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

function workosErrorBody(error: unknown): { error: string; error_description: string } {
  const maybe = error as {
    error?: string;
    errorDescription?: string;
    message?: string;
  };
  return {
    error: maybe.error || "workos_error",
    error_description: maybe.errorDescription || maybe.message || "WorkOS request failed",
  };
}

type WorkosOrganizationChoice = {
  id: string;
  name: string;
};

type WorkosOrganizationSelection = {
  pendingAuthenticationToken: string;
  organizations: WorkosOrganizationChoice[];
};

type StoredOrganizationSelection = WorkosOrganizationSelection & {
  returnTo: string | null;
};

function workosOrganizationSelection(error: unknown): WorkosOrganizationSelection | null {
  const maybe = error as {
    code?: string;
    pendingAuthenticationToken?: string;
    rawData?: {
      code?: string;
      error?: string;
      pending_authentication_token?: string;
      organizations?: unknown;
    };
  };
  const code = maybe.code ?? maybe.rawData?.code ?? maybe.rawData?.error;
  const pendingAuthenticationToken = maybe.pendingAuthenticationToken ?? maybe.rawData?.pending_authentication_token;
  if (code !== "organization_selection_required" || !pendingAuthenticationToken) return null;

  const rawOrganizations = Array.isArray(maybe.rawData?.organizations) ? maybe.rawData.organizations : [];
  const organizations = rawOrganizations
    .map(org => {
      if (!org || typeof org !== "object") return null;
      const value = org as { id?: unknown; name?: unknown; organization_id?: unknown; organization_name?: unknown };
      const id =
        typeof value.id === "string"
          ? value.id
          : typeof value.organization_id === "string"
            ? value.organization_id
            : "";
      const name =
        typeof value.name === "string"
          ? value.name
          : typeof value.organization_name === "string"
            ? value.organization_name
            : id;
      return id ? { id, name } : null;
    })
    .filter((org): org is WorkosOrganizationChoice => Boolean(org));

  return organizations.length > 0 ? { pendingAuthenticationToken, organizations } : null;
}

async function filterOrganizationSelectionForCore(
  selection: WorkosOrganizationSelection | null,
): Promise<WorkosOrganizationSelection | null> {
  if (!selection || selection.organizations.length <= 1) return selection;

  const linkedOrganizations: WorkosOrganizationChoice[] = [];
  for (const organization of selection.organizations) {
    const linkedOrg = await developerOrgs.getOrgByWorkosOrgId(organization.id);
    if (linkedOrg) linkedOrganizations.push(organization);
  }

  if (linkedOrganizations.length === 0) return selection;
  return { ...selection, organizations: linkedOrganizations };
}

function setOrganizationSelectionCookie(
  c: AppContext,
  selection: WorkosOrganizationSelection,
  returnTo: string | null,
): void {
  setCookie(c, ORG_SELECTION_COOKIE, encodeOrganizationSelection({ ...selection, returnTo }), {
    path: "/api/console/auth",
    httpOnly: true,
    sameSite: "Lax",
    secure: shouldUseSecureCookies(),
    maxAge: 10 * 60,
  });
}

function getOrganizationSelectionCookie(c: AppContext): StoredOrganizationSelection | null {
  const value = getCookie(c, ORG_SELECTION_COOKIE);
  if (!value) return null;
  return decodeOrganizationSelection(value);
}

function encodeOrganizationSelection(selection: StoredOrganizationSelection): string {
  return Buffer.from(JSON.stringify(selection), "utf8").toString("base64url");
}

function decodeOrganizationSelection(value: string): StoredOrganizationSelection | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as {
      pendingAuthenticationToken?: unknown;
      organizations?: unknown;
      returnTo?: unknown;
    };
    if (typeof record.pendingAuthenticationToken !== "string") return null;
    if (!Array.isArray(record.organizations)) return null;
    const organizations = record.organizations
      .map(org => {
        if (!org || typeof org !== "object") return null;
        const value = org as { id?: unknown; name?: unknown };
        return typeof value.id === "string" && typeof value.name === "string"
          ? { id: value.id, name: value.name }
          : null;
      })
      .filter((org): org is WorkosOrganizationChoice => Boolean(org));
    if (organizations.length === 0) return null;
    return {
      pendingAuthenticationToken: record.pendingAuthenticationToken,
      organizations,
      returnTo: typeof record.returnTo === "string" ? safeReturnTo(record.returnTo) : null,
    };
  } catch {
    return null;
  }
}

function teamAccessError(error: unknown): Response {
  const body = workosErrorBody(error);
  return new Response(
    JSON.stringify({
      error: body.error || "team_access_failed",
      error_description:
        body.error_description === "WorkOS request failed" ? "team access request failed" : body.error_description,
    }),
    {
      status: workosErrorStatus(error),
      headers: { "content-type": "application/json" },
    },
  );
}

function isWorkosRequestError(error: unknown): boolean {
  const maybe = error as {
    status?: number;
    statusCode?: number;
    error?: string;
    errorDescription?: string;
  };
  return Boolean(maybe.status || maybe.statusCode || maybe.error || maybe.errorDescription);
}

function workosErrorStatus(error: unknown): number {
  const maybe = error as { status?: number; statusCode?: number };
  const status = maybe.status ?? maybe.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 400;
}

function redirectToConsoleLoginError(c: AppContext, message: string, returnTo: string | null): Response {
  const url = new URL(workosConfig().consoleUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("auth_error", message);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return c.redirect(url.toString());
}

function isConflictError(error: unknown): boolean {
  if (workosErrorStatus(error) === 409) return true;
  const maybe = error as { message?: string; errorDescription?: string; error?: string };
  const text = `${maybe.error ?? ""} ${maybe.errorDescription ?? ""} ${maybe.message ?? ""}`.toLowerCase();
  return text.includes("already") || text.includes("conflict");
}

function workosConfig(): {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  cookiePassword: string;
  consoleUrl: string;
} {
  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  const redirectUri = process.env.WORKOS_REDIRECT_URI || "http://localhost:3000/api/console/auth/callback";
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
  const consoleUrl = normalizeUrl(process.env.CONSOLE2_URL || "http://localhost:5173");

  if (!apiKey) throw new OauthServerError("WORKOS_API_KEY is not configured");
  if (!clientId) throw new OauthServerError("WORKOS_CLIENT_ID is not configured");
  if (!cookiePassword) throw new OauthServerError("WORKOS_COOKIE_PASSWORD is not configured");

  return { apiKey, clientId, redirectUri, cookiePassword, consoleUrl };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function redirectUriForRequest(c: AppContext): string {
  const publicOrigin = safeAllowedOrigin(c.req.header("x-mentra-public-origin"));
  if (publicOrigin) return `${publicOrigin}/api/console/auth/callback`;
  return workosConfig().redirectUri;
}

function safeReturnTo(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;

  const allowedOrigins = allowedConsoleOrigins();
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!isLocalhost && !allowedOrigins.has(url.origin)) return null;

  url.hash = "";
  return url.toString();
}

function safeAllowedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  return allowedConsoleOrigins().has(url.origin) ? url.origin : null;
}

function allowedConsoleOrigins(): Set<string> {
  const allowedUrls = [
    process.env.CONSOLE2_URL,
    process.env.ADMIN_URL,
    process.env.PORTAL_URL,
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return new Set(allowedUrls.map(candidate => new URL(candidate).origin));
}

function shouldUseSecureCookies(): boolean {
  return process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
}

export default app;
