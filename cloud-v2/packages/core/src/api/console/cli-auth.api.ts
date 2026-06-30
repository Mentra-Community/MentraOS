import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WorkOS } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  DeveloperOrgService,
  DeveloperOrgServiceError,
  type DeveloperOrgRecord,
} from "../../services/developer-orgs/developer-org.service";
import {
  MiniAppService,
  MiniAppServiceError,
  type DeveloperIdentity,
} from "../../services/miniapps/miniapp.service";
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
const developerOrgs = new DeveloperOrgService();
const miniapps = new MiniAppService();
const signing = new DeveloperSigningService();

const upsertDeveloperOrgSchema = z.object({
  displayName: z.string().min(1),
  packagePrefix: z.string().min(1),
});

const inviteOrgMemberSchema = z.object({
  email: z.string().email(),
});

const createMiniAppSchema = z.object({
  packageName: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().nullable().optional(),
});

const createReleaseSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()),
  bundleBase64: z.string().min(1),
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

const registerSigningKeySchema = z.object({
  publicKeyJwk: z.record(z.string(), z.unknown()),
});

const createApiTokenSchema = z.object({
  name: z.string().min(1).max(80),
});

app.get("/health", (c) => c.json({ status: "ok", service: "cloud-core-console" }));
app.get("/auth/login", getLogin);
app.get("/auth/social/:provider", getSocialLogin);
app.get("/auth/callback", getCallback);
app.get("/auth/me", getMe);
app.get("/org", getOrg);
app.put("/org", putOrg);
app.get("/org/access", getOrgAccess);
app.post("/org/invitations", postOrgInvitation);
app.delete("/org/invitations/:invitationId", deleteOrgInvitation);
app.delete("/org/members/:membershipId", deleteOrgMember);
app.get("/apps", getApps);
app.post("/apps", postApps);
app.delete("/apps/:packageName", deleteApp);
app.get("/apps/:packageName/releases", getReleases);
app.post("/apps/:packageName/releases", postRelease);
app.post("/apps/:packageName/releases/:releaseId/submit", postSubmitRelease);
app.get("/signing-keys", getSigningKeys);
app.post("/signing-keys", postSigningKey);
app.get("/tokens", getTokens);
app.post("/tokens", postToken);
app.delete("/tokens/:tokenId", deleteToken);
app.post("/auth/magic/start", postMagicStart);
app.post("/auth/magic/verify", postMagicVerify);
app.post("/auth/logout", postLogout);

function getLogin(c: AppContext) {
  return redirectToWorkos(c, "authkit");
}

function getSocialLogin(c: AppContext) {
  const providerParam = c.req.param("provider");
  const provider = providerParam === "github"
    ? "GitHubOAuth"
    : providerParam === "google"
      ? "GoogleOAuth"
      : null;
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
    return redirectToConsoleLoginError(
      c,
      "Sign-in could not be completed. Please try again.",
      returnTo,
    );
  }
  if (!state || !expectedState || state !== expectedState) {
    return redirectToConsoleLoginError(
      c,
      "Sign-in expired. Please try again.",
      returnTo,
    );
  }
  if (!codeVerifier) {
    return redirectToConsoleLoginError(
      c,
      "Sign-in expired. Please try again.",
      returnTo,
    );
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
      return redirectToConsoleLoginError(
        c,
        "Sign-in expired or could not be completed. Please try again.",
        returnTo,
      );
    }
    throw error;
  }

  setSessionCookie(c, response.sealedSession);
  return c.redirect(returnTo ?? `${config.consoleUrl}/dashboard`);
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
  const developerOrg = await resolveDeveloperOrgForSession(authenticatedSession);

  return c.json({
    authenticated: true,
    user: {
      id: authenticatedSession.user.id,
      email: authenticatedSession.user.email,
      firstName: authenticatedSession.user.firstName,
      lastName: authenticatedSession.user.lastName,
    },
    onboardingRequired: developerOrg === null,
    organizationId: developerOrg?.id ?? null,
    packagePrefix: developerOrg?.packagePrefix ?? null,
    packagePrefixStatus: developerOrg?.packagePrefixStatus ?? null,
    organizations: developerOrg
      ? [
          {
            id: developerOrg.id,
            ownerUserId: developerOrg.ownerUserId,
            workosOrgId: developerOrg.workosOrgId,
            name: developerOrg.name,
            packagePrefix: developerOrg.packagePrefix,
            packagePrefixStatus: developerOrg.packagePrefixStatus,
            createdAt: developerOrg.createdAt,
            updatedAt: developerOrg.updatedAt,
          },
        ]
      : [],
  });
}

async function getOrg(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ error: "unauthorized", error_description: "console session required" }, 401);
  }

  const org = await resolveDeveloperOrgForSession(authenticatedSession);
  return c.json({ org });
}

async function putOrg(c: AppContext) {
  const authenticatedSession = await authenticateConsoleSession(c);
  if (!authenticatedSession.authenticated) {
    return c.json({ error: "unauthorized", error_description: "console session required" }, 401);
  }

  const parsed = upsertDeveloperOrgSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid organization payload");

  try {
    const org = await developerOrgs.upsertPrimaryOrg(authenticatedSession.user, parsed.data);
    const linkedOrg = await ensureWorkosOrgLinked(authenticatedSession, org);
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
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    return c.json({
      org,
      members: await listWorkosOrgMembers(org),
      invitations: await listWorkosOrgInvitations(org),
    });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function postOrgInvitation(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!isOrgOwner(developer.auth, developer.org)) {
    return c.json({ error: "forbidden", error_description: "only the org owner can invite members" }, 403);
  }

  const parsed = inviteOrgMemberSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid invitation payload");

  try {
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const invitation = await workos().userManagement.sendInvitation({
      email: parsed.data.email.trim().toLowerCase(),
      organizationId: requireWorkosOrgId(org),
      inviterUserId: developer.auth.user.id,
    });
    return c.json({ invitation: serializeInvitation(invitation) }, 201);
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function deleteOrgInvitation(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!isOrgOwner(developer.auth, developer.org)) {
    return c.json({ error: "forbidden", error_description: "only the org owner can revoke invitations" }, 403);
  }
  const invitationId = c.req.param("invitationId");
  if (!invitationId) throw new InvalidRequest("invitationId is required");

  try {
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const invitation = await workos().userManagement.getInvitation(invitationId);
    if (invitation.organizationId !== org.workosOrgId) {
      return c.json({ error: "not_found", error_description: "invitation was not found" }, 404);
    }
    await workos().userManagement.revokeInvitation(invitationId);
    return c.json({ ok: true });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function deleteOrgMember(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!isOrgOwner(developer.auth, developer.org)) {
    return c.json({ error: "forbidden", error_description: "only the org owner can remove members" }, 403);
  }
  const membershipId = c.req.param("membershipId");
  if (!membershipId) throw new InvalidRequest("membershipId is required");

  try {
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const membership = await workos().userManagement.getOrganizationMembership(membershipId);
    if (membership.organizationId !== org.workosOrgId) {
      return c.json({ error: "not_found", error_description: "member was not found" }, 404);
    }
    if (membership.userId === org.ownerUserId) {
      return c.json({ error: "owner_required", error_description: "the org owner cannot be removed" }, 409);
    }
    await workos().userManagement.deleteOrganizationMembership(membershipId);
    return c.json({ ok: true });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
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

  const parsed = createReleaseSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid release payload");
  const pathPackageName = c.req.param("packageName");
  if (pathPackageName !== parsed.data.packageName) {
    throw new InvalidRequest("packageName must match URL");
  }

  try {
    const bundle = Uint8Array.from(Buffer.from(parsed.data.bundleBase64, "base64"));
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
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const tokens = await workos().apiKeys.listOrganizationApiKeys({
      organizationId: requireWorkosOrgId(org),
      limit: 100,
    });
    return c.json({ tokens: tokens.data.map(serializeApiToken) });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function postToken(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!isOrgOwner(developer.auth, developer.org)) {
    return c.json({ error: "forbidden", error_description: "only the org owner can create API keys" }, 403);
  }

  const parsed = createApiTokenSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new InvalidRequest(parsed.error.issues[0]?.message ?? "invalid API key payload");

  try {
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const token = await workos().apiKeys.createOrganizationApiKey({
      organizationId: requireWorkosOrgId(org),
      name: parsed.data.name.trim(),
    });
    return c.json({ token: serializeApiToken(token) }, 201);
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function deleteToken(c: AppContext) {
  const developer = await requireConsoleOrg(c);
  if (!developer.ok) return developer.response;
  if (!isOrgOwner(developer.auth, developer.org)) {
    return c.json({ error: "forbidden", error_description: "only the org owner can revoke API keys" }, 403);
  }

  const tokenId = c.req.param("tokenId");
  if (!tokenId) throw new InvalidRequest("tokenId is required");

  try {
    const org = await ensureWorkosOrgLinked(developer.auth, developer.org);
    const tokens = await workos().apiKeys.listOrganizationApiKeys({
      organizationId: requireWorkosOrgId(org),
      limit: 100,
    });
    if (!tokens.data.some(token => token.id === tokenId)) {
      return c.json({ error: "not_found", error_description: "API key was not found" }, 404);
    }
    await workos().apiKeys.deleteApiKey(tokenId);
    return c.json({ ok: true });
  } catch (error) {
    if (isWorkosRequestError(error)) return teamAccessError(error);
    return serviceError(error);
  }
}

async function ensureWorkosOrgLinked(
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
  org: DeveloperOrgRecord,
): Promise<DeveloperOrgRecord> {
  if (org.workosOrgId) {
    await ensureOwnerWorkosMembership(org);
    return org;
  }
  if (!isOrgOwner(authenticatedSession, org)) {
    throw new DeveloperOrgServiceError(
      "team_access_not_ready",
      "team access is not ready for this org yet",
      409,
    );
  }

  const createdOrg = await workos().organizations.createOrganization({
    name: org.name,
    externalId: org.id,
    metadata: {
      packagePrefix: org.packagePrefix,
    },
  });
  const linkedOrg = await developerOrgs.setWorkosOrgId(authenticatedSession.user, org.id, createdOrg.id);
  await ensureOwnerWorkosMembership(linkedOrg);
  return linkedOrg;
}

async function syncWorkosOrgName(org: DeveloperOrgRecord): Promise<void> {
  if (!org.workosOrgId) return;
  await workos().organizations.updateOrganization({
    organization: org.workosOrgId,
    name: org.name,
    metadata: {
      packagePrefix: org.packagePrefix,
    },
  });
}

async function ensureOwnerWorkosMembership(org: DeveloperOrgRecord): Promise<void> {
  const organizationId = requireWorkosOrgId(org);
  try {
    await workos().userManagement.createOrganizationMembership({
      organizationId,
      userId: org.ownerUserId,
    });
  } catch (error) {
    if (isConflictError(error)) return;
    throw error;
  }
}

async function listWorkosOrgMembers(org: DeveloperOrgRecord): Promise<ConsoleOrgMember[]> {
  const organizationId = requireWorkosOrgId(org);
  const memberships = await workos().userManagement.listOrganizationMemberships({
    organizationId,
    statuses: ["active", "inactive"],
    limit: 100,
  });

  const users = new Map<string, ConsoleOrgUser>();
  await Promise.all(
    memberships.data.map(async (membership) => {
      if (users.has(membership.userId)) return;
      try {
        const user = await workos().userManagement.getUser(membership.userId);
        users.set(membership.userId, {
          id: user.id,
          email: user.email,
          name: user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          avatarUrl: user.profilePictureUrl ?? null,
        });
      } catch {
        users.set(membership.userId, {
          id: membership.userId,
          email: null,
          name: null,
          avatarUrl: null,
        });
      }
    }),
  );

  return memberships.data.map((membership) => {
    const user = users.get(membership.userId) ?? {
      id: membership.userId,
      email: null,
      name: null,
      avatarUrl: null,
    };
    return {
      id: membership.id,
      userId: membership.userId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: membership.userId === org.ownerUserId ? "owner" : "member",
      status: membership.status,
      createdAt: membership.createdAt ?? null,
      updatedAt: membership.updatedAt ?? null,
    };
  });
}

async function listWorkosOrgInvitations(org: DeveloperOrgRecord): Promise<ConsoleOrgInvitation[]> {
  const invitations = await workos().userManagement.listInvitations({
    organizationId: requireWorkosOrgId(org),
    limit: 100,
  });
  return invitations.data.map(serializeInvitation);
}

function serializeInvitation(invitation: WorkosInvitationLike): ConsoleOrgInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    state: invitation.state,
    role: invitation.roleSlug ?? "member",
    expiresAt: invitation.expiresAt ?? null,
    createdAt: invitation.createdAt ?? null,
    updatedAt: invitation.updatedAt ?? null,
  };
}

function serializeApiToken(apiKey: WorkosApiKeyLike): ConsoleApiToken {
  return {
    id: apiKey.id,
    name: apiKey.name,
    obfuscatedValue: apiKey.obfuscatedValue ?? null,
    value: apiKey.value ?? null,
    permissions: apiKey.permissions ?? [],
    createdAt: apiKey.createdAt ?? null,
    updatedAt: apiKey.updatedAt ?? null,
    lastUsedAt: apiKey.lastUsedAt ?? null,
  };
}

function workosApiKeyOrganizationId(apiKey: WorkosApiKeyLike): string | null {
  const owner = apiKey.owner;
  if (owner?.type === "organization" && typeof owner.id === "string") return owner.id;
  if (owner?.type === "user" && typeof owner.organizationId === "string") return owner.organizationId;
  if (owner?.type === "user" && typeof owner.organization_id === "string") return owner.organization_id;
  return null;
}

function requireWorkosOrgId(org: DeveloperOrgRecord): string {
  if (!org.workosOrgId) {
    throw new DeveloperOrgServiceError("team_access_not_ready", "team access is not ready for this org yet", 409);
  }
  return org.workosOrgId;
}

function isOrgOwner(
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
  org: DeveloperOrgRecord,
): boolean {
  return authenticatedSession.user.id === org.ownerUserId;
}

type ConsoleOrgUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

type ConsoleOrgMember = {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: "owner" | "member";
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type ConsoleOrgInvitation = {
  id: string;
  email: string;
  state: string;
  role: string;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type ConsoleApiToken = {
  id: string;
  name: string;
  obfuscatedValue: string | null;
  value: string | null;
  permissions: string[];
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
};

type WorkosInvitationLike = {
  id: string;
  email: string;
  state: string;
  roleSlug?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type WorkosApiKeyLike = {
  id: string;
  owner?: {
    type?: string;
    id?: string;
    organizationId?: string;
    organization_id?: string;
  };
  name: string;
  obfuscatedValue?: string | null;
  value?: string | null;
  permissions?: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  lastUsedAt?: string | null;
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
    }
  | { authenticated: false; reason: string };

async function requireDeveloper(c: AppContext): Promise<
  | { ok: true; value: DeveloperIdentity }
  | { ok: false; response: Response }
> {
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

async function requireConsoleOrg(c: AppContext): Promise<
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
  const developerOrg = await resolveDeveloperOrgForSession(authenticatedSession);
  if (!developerOrg) {
    return {
      ok: false,
      response: c.json({ error: "organization_required", error_description: "create a developer org before using this API" }, 428),
    };
  }
  return { ok: true, auth: authenticatedSession, org: developerOrg };
}

async function resolveDeveloperOrgForSession(
  authenticatedSession: Extract<ConsoleAuthResult, { authenticated: true }>,
): Promise<DeveloperOrgRecord | null> {
  const ownedOrg = await developerOrgs.getPrimaryOrgForUser(authenticatedSession.user);
  if (ownedOrg) return ownedOrg;

  if (authenticatedSession.organizationId) {
    const sessionOrg = await developerOrgs.getOrgByWorkosOrgId(authenticatedSession.organizationId);
    if (sessionOrg) return sessionOrg;
  }

  try {
    const memberships = await workos().userManagement.listOrganizationMemberships({
      userId: authenticatedSession.user.id,
      statuses: ["active"],
      limit: 100,
    });
    for (const membership of memberships.data) {
      const org = await developerOrgs.getOrgByWorkosOrgId(membership.organizationId);
      if (org) return org;
    }
  } catch {
    // Fall through to onboardingRequired. Team lookup should not break basic sign-in.
  }

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
    const validation = await workos().apiKeys.createValidation({ value: token });
    const apiKey = validation.apiKey;
    if (!apiKey) return { authenticated: false, reason: "invalid_bearer_token" };

    const organizationId = workosApiKeyOrganizationId(apiKey);
    if (!organizationId) return { authenticated: false, reason: "api_key_missing_org" };

    return {
      authenticated: true,
      user: {
        id: `api_key:${apiKey.id}`,
        email: `${apiKey.name || "api-token"}@api-token.local`,
        firstName: apiKey.name || "API key",
        lastName: null,
      },
      organizationId,
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
  if (error instanceof MiniAppServiceError) {
    return new Response(
      JSON.stringify({ error: error.code, error_description: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (error instanceof DeveloperOrgServiceError) {
    return new Response(
      JSON.stringify({ error: error.code, error_description: error.message }),
      {
        status: error.status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (error instanceof DeveloperSigningServiceError) {
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

async function postLogout(c: AppContext) {
  const sessionData = getCookie(c, SESSION_COOKIE);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
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

function teamAccessError(error: unknown): Response {
  const body = workosErrorBody(error);
  return new Response(
    JSON.stringify({
      error: body.error || "team_access_failed",
      error_description: body.error_description === "WorkOS request failed"
        ? "team access request failed"
        : body.error_description,
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
  return new Set(
    allowedUrls.map(candidate => new URL(candidate).origin),
  );
}

function shouldUseSecureCookies(): boolean {
  return process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
}

export default app;
