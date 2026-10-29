/**
 * @fileoverview The CLI's requests: sign-in at Core's sign-in server (an
 * OpenID Connect provider; the CLI is its public client), the Mentra Miniapp
 * Store's console and admin APIs, and, in Core mode, Core's own API.
 *
 * Store requests carry `Authorization: Bearer <Core access token or
 * MENTRA_CLI_TOKEN>` and the selected workspace as `x-mentra-workspace-id`.
 */

import type { CredentialView, PrincipalResponse, WorkspaceDetail } from "@mentra/workspace-contract";
import * as client from "openid-client";
import { isLoopbackHttp, type CliTarget } from "./config";
import type { CliCredentials } from "./credentials";

/** What a Store request needs: the bearer, the Store, and the workspace it acts in. */
export interface StoreCredentials {
  token: string;
  storeUrl: string;
  workspaceId?: string | null;
  /**
   * A stored login's way back from a refused access token: called when the Store answers 401 to
   * `refused`, for the access token to retry with, or null when there is none. It throws
   * `SessionExpiredError` when the sign-in has ended. `MENTRA_CLI_TOKEN` has none.
   */
  renewToken?: (refused: string) => Promise<string | null>;
}

/** What a Core request needs (Core mode). */
export interface CoreCredentials {
  token: string;
  coreUrl: string;
}

export interface DeveloperApp {
  id: string;
  packageName: string;
  name: string;
  description: string | null;
  status: "active" | "archived" | "suspended";
  activeRelease: DeveloperRelease | null;
  activeBetaRelease?: DeveloperRelease | null;
  latestRelease: DeveloperRelease | null;
  releaseCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeveloperRelease {
  id: string;
  version: string;
  releaseTrack: "stable" | "beta";
  status: "draft" | "submitted" | "in_review" | "accepted" | "rejected" | "published" | "suspended";
  releaseBundleAssetId: string | null;
  bundleSha256: string | null;
  bundleSizeBytes: number | null;
  manifestSha256?: string | null;
  publisherKeyFingerprint?: string | null;
  signedAt?: string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A workspace the caller belongs to, with their role in it. */
export type CliWorkspace = PrincipalResponse["workspaces"][number];

/** `GET /api/console/auth/me`: who is signed in, the workspaces they belong to and the one the Store resolved as selected. */
export interface ConsoleSessionResponse {
  user: { id: string; email: string; name?: string };
  workspaces: CliWorkspace[];
  activeWorkspaceId: string | null;
}

/** The workspace's package prefix, which scopes the miniapp package names it may publish. */
export interface PublishingProfile {
  workspaceId: string;
  packagePrefix: string;
  packagePrefixStatus: "unverified" | "verified" | "rejected";
}

export interface AdminUser {
  developerId: string;
  email: string;
}

export interface StoreAsset {
  id: string;
  role: "store_icon" | "store_cover" | "gallery_screenshot";
  fileName: string;
  sha256: string;
}

export interface StoreListingInput {
  subtitle?: string | null;
  longDescription?: string | null;
  categories?: string[];
  privacyPolicyUrl?: string | null;
  supportUrl?: string | null;
  websiteUrl?: string | null;
}

export interface StoreListing extends StoreListingInput {
  iconAssetId: string | null;
  coverAssetId: string | null;
  screenshotAssetIds: string[];
  assets: StoreAsset[];
}

export function getListing(credentials: StoreCredentials, packageName: string): Promise<{listing: StoreListing}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing`);
}

export function updateListing(credentials: StoreCredentials, packageName: string, input: StoreListingInput): Promise<{listing: StoreListing}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing`, {method: "PUT", body: JSON.stringify(input)});
}

export function uploadListingAsset(credentials: StoreCredentials, packageName: string, input: {role: StoreAsset["role"]; fileName: string; contentType: string; base64: string}): Promise<{asset: StoreAsset}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing/assets`, {method: "POST", body: JSON.stringify(input)});
}

export function deleteListingAsset(credentials: StoreCredentials, packageName: string, assetId: string): Promise<{ok: true}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing/assets/${encodeURIComponent(assetId)}`, {method: "DELETE"});
}

export function publishRelease(credentials: StoreCredentials, packageName: string, releaseId: string): Promise<{release: DeveloperRelease}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/releases/${encodeURIComponent(releaseId)}/publish`, {method: "POST"});
}

export function reviewRelease(credentials: StoreCredentials, releaseId: string, action: "approve" | "reject" | "publish", notes?: string): Promise<{release: DeveloperRelease}> {
  return storeRequest(credentials, `/api/admin/submissions/${encodeURIComponent(releaseId)}/${action}`, {method: "POST", body: JSON.stringify({notes})});
}

export function createPublishingToken(credentials: StoreCredentials, packageName: string, name: string): Promise<{token: {id: string; value: string; permissions: string[]}}> {
  return storeRequest(credentials, `/api/admin/apps/${encodeURIComponent(packageName)}/publishing-tokens`, {method: "POST", body: JSON.stringify({name})});
}

export function listWorkspaceCredentials(credentials: StoreCredentials, workspaceId: string): Promise<{ items: CredentialView[] }> {
  return storeRequest(credentials, `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials`);
}

export function createWorkspaceCredential(
  credentials: StoreCredentials,
  workspaceId: string,
  input: { name: string; packageNames?: string[]; expiresAt?: string },
): Promise<{ credential: CredentialView; token: string }> {
  return storeRequest(credentials, `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeWorkspaceCredential(credentials: StoreCredentials, workspaceId: string, credentialId: string): Promise<void> {
  return storeRequest(
    credentials,
    `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

export async function listApps(credentials: StoreCredentials): Promise<{ apps: DeveloperApp[] }> {
  return storeRequest(credentials, "/api/console/apps");
}

/** The Store's `/api/admin/me`: the signed-in Store administrator. */
export async function getAdminMe(
  credentials: StoreCredentials,
): Promise<{ authenticated: true; admin: true; user: AdminUser | null }> {
  return storeRequest(credentials, "/api/admin/me");
}

/** What Core's `/api/admin/me` answers: who the token is and the organization capabilities it holds. */
export interface CoreAdminMe {
  authenticated: true;
  user: { mentraUserId: string; email: string | null; isOrganizationAdmin: boolean } | null;
  credential: { credentialId: string; credentialKind: "workspace" | "organization"; label: string } | null;
  organization: { capabilities: string[] };
}

/** Core's `/api/admin/me` (Core mode). */
export async function getCoreAdminMe(credentials: CoreCredentials): Promise<CoreAdminMe> {
  const response = await fetch(`${credentials.coreUrl}/api/admin/me`, {
    headers: { accept: "application/json", authorization: `Bearer ${credentials.token}` },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as CoreAdminMe;
}

export async function getConsoleSession(credentials: StoreCredentials): Promise<ConsoleSessionResponse> {
  return storeRequest(credentials, "/api/console/auth/me");
}

/** Create a workspace. The caller becomes its owner. */
export async function createWorkspace(credentials: StoreCredentials, name: string): Promise<WorkspaceDetail> {
  // Creating is not scoped to a workspace, so a stale selection must not ride along.
  return storeRequest({ ...credentials, workspaceId: null }, "/api/console/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** The package prefix of the workspace the credentials select (`x-mentra-workspace-id`). */
export async function getPublishingProfile(credentials: StoreCredentials): Promise<PublishingProfile> {
  return storeRequest(credentials, "/api/console/publishing-profile");
}

/**
 * The publishing profile as `workspace show` reports it. The Store answers 404 `not_found` for a
 * workspace that has no package prefix yet and 403 to a role that cannot publish; neither is a
 * failure of the command.
 */
export async function readPublishingProfile(
  credentials: StoreCredentials,
): Promise<{ state: "set"; profile: PublishingProfile } | { state: "not_set" } | { state: "hidden" }> {
  try {
    return { state: "set", profile: await getPublishingProfile(credentials) };
  } catch (error) {
    if (error instanceof StoreRequestError && error.status === 404 && error.code === "not_found") return { state: "not_set" };
    if (error instanceof StoreRequestError && error.status === 403) return { state: "hidden" };
    throw error;
  }
}

export async function setPackagePrefix(credentials: StoreCredentials, packagePrefix: string): Promise<PublishingProfile> {
  return storeRequest(credentials, "/api/console/publishing-profile", {
    method: "PUT",
    body: JSON.stringify({ packagePrefix }),
  });
}

/**
 * The workspace a workspace-scoped command acts in: the saved selection, else the one the Store
 * reports as active, else the caller's only workspace. With several and none selected the caller
 * must choose (`WorkspaceSelectionRequiredError`).
 */
export async function resolveWorkspaceId(credentials: StoreCredentials): Promise<string> {
  if (credentials.workspaceId) return credentials.workspaceId;
  const session = await getConsoleSession(credentials);
  const workspaceId = session.activeWorkspaceId ?? (session.workspaces.length === 1 ? session.workspaces[0]!.workspaceId : null);
  if (workspaceId) return workspaceId;
  if (session.workspaces.length === 0) {
    throw new Error("You do not belong to a workspace yet. Create one with `mentra workspace create <name>`.");
  }
  throw new WorkspaceSelectionRequiredError(session.workspaces);
}

export async function createApp(
  credentials: StoreCredentials,
  input: { packageName: string; displayName: string; description?: string | null },
): Promise<{ app: DeveloperApp }> {
  return storeRequest(credentials, "/api/console/apps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteApp(credentials: StoreCredentials, packageName: string): Promise<{ ok: true }> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}`, {
    method: "DELETE",
  });
}

export async function listReleases(
  credentials: StoreCredentials,
  packageName: string,
): Promise<{ releases: DeveloperRelease[] }> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/releases`);
}

export async function createRelease(
  credentials: StoreCredentials,
  input: {
    packageName: string;
    version: string;
    releaseTrack: "stable" | "beta";
    manifest: Record<string, unknown>;
    bundle: Uint8Array;
    fileName?: string;
  },
): Promise<{ release: DeveloperRelease }> {
  const form = new FormData();
  form.set("packageName", input.packageName);
  form.set("version", input.version);
  form.set("releaseTrack", input.releaseTrack);
  form.set("manifest", JSON.stringify(input.manifest));
  form.set("fileName", input.fileName ?? "bundle.zip");
  form.set("bundle", new Blob([input.bundle], { type: "application/zip" }), input.fileName ?? "bundle.zip");
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(input.packageName)}/releases`, {
    method: "POST",
    body: form,
  });
}

export async function submitRelease(
  credentials: StoreCredentials,
  input: {
    packageName: string;
    releaseId: string;
  },
): Promise<{ release: DeveloperRelease }> {
  return storeRequest(
    credentials,
    `/api/console/apps/${encodeURIComponent(input.packageName)}/releases/${encodeURIComponent(input.releaseId)}/submit`,
    { method: "POST" },
  );
}

/** The caller belongs to several workspaces and has not chosen one. The message says how to choose. */
export class WorkspaceSelectionRequiredError extends Error {
  constructor(readonly workspaces: Array<{ workspaceId: string; name: string }>) {
    super(
      workspaces.length === 0
        ? "Several workspaces are available and none is selected. Run `mentra workspace use <id>`; `mentra workspace list` shows the ids."
        : [
            "Several workspaces are available and none is selected. Run `mentra workspace use <id>` with one of:",
            ...workspaces.map((workspace) => `  ${workspace.workspaceId}\t${workspace.name}`),
          ].join("\n"),
    );
    this.name = "WorkspaceSelectionRequiredError";
  }
}

async function storeRequest<T>(credentials: StoreCredentials, path: string, init?: RequestInit): Promise<T> {
  let response = await storeFetch(credentials, path, init);
  if (response.status === 401 && credentials.renewToken) {
    // Core no longer accepts this access token (the person's sign-ins were revoked, for example):
    // renew it, which ends the login when its grant is gone too, and retry once.
    const token = await credentials.renewToken(credentials.token);
    if (token && token !== credentials.token) {
      await response.body?.cancel();
      // The command's later requests carry the renewed token too.
      credentials.token = token;
      response = await storeFetch(credentials, path, init);
    }
  }
  if (!response.ok) throw await storeError(credentials, response);
  // A DELETE answers 204 with nothing to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function storeFetch(credentials: StoreCredentials, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${credentials.storeUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credentials.token}`,
      ...(credentials.workspaceId ? { "x-mentra-workspace-id": credentials.workspaceId } : {}),
      ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

/** The Store refused a request. `code` is its `error` field, when it sent one. */
export class StoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StoreRequestError";
  }
}

async function storeError(credentials: StoreCredentials, response: Response): Promise<Error> {
  const body = await errorBody(response);
  if (response.status === 409 && body.error === "workspace_selection_required") {
    return new WorkspaceSelectionRequiredError(await availableWorkspaces(credentials));
  }
  return new StoreRequestError(response.status, body.error ?? null, errorText(body, response.status));
}

/** Best effort: the instruction is still useful without the ids, so a failed lookup must not replace it. */
async function availableWorkspaces(credentials: StoreCredentials): Promise<CliWorkspace[]> {
  try {
    const response = await storeFetch(credentials, "/api/console/auth/me");
    return response.ok ? ((await response.json()) as ConsoleSessionResponse).workspaces : [];
  } catch {
    return [];
  }
}

// --- Sign-in at Core's sign-in server ---------------------------------------------

/** The algorithm Core's sign-in server signs ID tokens with. */
const ID_TOKEN_ALG = "EdDSA";
/** Seconds the CLI waits for the sign-in server before giving up on a request. */
const OIDC_TIMEOUT_SEC = 15;

/** Where `ensureOidcClient` finds the sign-in server and the CLI client. */
export interface OidcClientSettings {
  /** The issuer and client ID, when known (`MENTRA_CLI_OIDC_ISSUER` and `MENTRA_CLI_CLIENT_ID`, or a stored login's). */
  oidcIssuer?: string;
  cliClientId?: string;
  /** Asked for both otherwise: a Store's `/api/console/auth/cli-config`, or Core's `/api/cli/config`. */
  target?: CliTarget;
}

/** What a Store's `/api/console/auth/cli-config` and Core's `/api/cli/config` answer. */
export interface CliSignInConfig {
  issuer: string;
  clientId: string;
}

/** The sign-in server refused the stored login's refresh token; the person must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired. Run `mentra login`.");
    this.name = "SessionExpiredError";
  }
}

/**
 * The CLI as a public client (`none`) of its sign-in server: discovery from
 * the issuer, EdDSA ID tokens whose signatures are checked against the
 * issuer's key set. Plain HTTP only for a loopback issuer.
 */
export async function ensureOidcClient(settings: OidcClientSettings): Promise<client.Configuration> {
  const explicit = { issuer: settings.oidcIssuer?.trim() ?? "", clientId: settings.cliClientId?.trim() ?? "" };
  if (Boolean(explicit.issuer) !== Boolean(explicit.clientId)) {
    throw new Error("Set both MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID, or neither.");
  }
  let signIn: CliSignInConfig;
  if (explicit.issuer) signIn = explicit;
  else if (settings.target) signIn = await fetchCliSignInConfig(settings.target);
  else throw new Error("No sign-in server is configured. Run `mentra login`.");

  const issuer = issuerUrl(signIn.issuer);
  const config = await client.discovery(
    issuer,
    signIn.clientId,
    { id_token_signed_response_alg: ID_TOKEN_ALG },
    client.None(),
    {
      execute: [...(isLoopbackHttp(issuer) ? [client.allowInsecureRequests] : []), client.enableNonRepudiationChecks],
      timeout: OIDC_TIMEOUT_SEC,
    },
  );
  config.timeout = OIDC_TIMEOUT_SEC;
  return config;
}

/** Ask the target which sign-in server and CLI client to use. */
export async function fetchCliSignInConfig(target: CliTarget): Promise<CliSignInConfig> {
  const url = target.kind === "store" ? `${target.url}/api/console/auth/cli-config` : `${target.url}/api/cli/config`;
  const where = target.kind === "store" ? "The Mentra Miniapp Store" : "This Core";
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(`Could not reach ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await errorBody(response);
    if (body.error === "not_configured") throw new Error(`${where} at ${target.url} does not offer CLI sign-in.`);
    throw new Error(`${where} at ${target.url} did not provide CLI sign-in settings: ${errorText(body, response.status)}`);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<CliSignInConfig>;
  if (typeof body.issuer !== "string" || !body.issuer || typeof body.clientId !== "string" || !body.clientId) {
    throw new Error(`${where} at ${target.url} did not provide CLI sign-in settings.`);
  }
  return { issuer: body.issuer, clientId: body.clientId };
}

function issuerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The sign-in issuer is not a URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !isLoopbackHttp(url))) {
    throw new Error(`The sign-in issuer must be an HTTPS URL (plain HTTP only on this machine): ${value}`);
  }
  return url;
}

/**
 * Exchange the stored login's refresh token for new tokens. The sign-in
 * server rotates refresh tokens, so the result's `refreshToken` replaces the
 * stored one before its `token` is used. A refused refresh token
 * (`invalid_grant`) is a `SessionExpiredError`.
 */
export async function refreshLoginToken(credentials: CliCredentials): Promise<CliCredentials> {
  const config = await ensureOidcClient({ oidcIssuer: credentials.issuer, cliClientId: credentials.clientId });
  let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
  try {
    tokens = await client.refreshTokenGrant(config, credentials.refreshToken);
  } catch (error) {
    if (error instanceof client.ResponseBodyError && error.error === "invalid_grant") throw new SessionExpiredError();
    throw new Error(`Could not refresh the sign-in: ${describeOidcError(error)}`);
  }
  const claims = tokens.claims();
  // A refresh continues one person's login.
  if (claims && claims.sub !== credentials.mentraUserId) throw new SessionExpiredError();
  const storedAt = new Date();
  return {
    ...credentials,
    token: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credentials.refreshToken,
    expiresAt: new Date(expiresAtMs(tokens, storedAt.getTime())).toISOString(),
    email: typeof claims?.email === "string" ? claims.email : credentials.email,
    storedAt: storedAt.toISOString(),
  };
}

/**
 * Revoke this login's refresh token at the sign-in server's revocation
 * endpoint. Confirmed only when the server answered 200. This ends only this
 * login: the person's other CLI logins and the Developer Console keep theirs.
 */
export async function revokeLogin(credentials: CliCredentials): Promise<{ confirmed: boolean }> {
  try {
    const config = await ensureOidcClient({ oidcIssuer: credentials.issuer, cliClientId: credentials.clientId });
    if (!config.serverMetadata().revocation_endpoint) return { confirmed: false };
    await client.tokenRevocation(config, credentials.refreshToken, { token_type_hint: "refresh_token" });
    return { confirmed: true };
  } catch {
    return { confirmed: false };
  }
}

/** When the access token in `tokens` expires, in epoch milliseconds. */
export function expiresAtMs(tokens: { expiresIn(): number | undefined; access_token: string }, now = Date.now()): number {
  const expiresIn = tokens.expiresIn();
  if (typeof expiresIn === "number") return now + expiresIn * 1000;
  const exp = jwtExpiry(tokens.access_token);
  // Unknown: treat as expired, so the next command refreshes it.
  return exp ? exp * 1000 : now;
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

/** A short, printable reason for an openid-client failure. */
export function describeOidcError(error: unknown): string {
  if (error instanceof client.ResponseBodyError) return error.error;
  if (error instanceof client.AuthorizationResponseError) return error.error;
  if (error instanceof Error) return error.message;
  return String(error);
}

type ErrorBody = { error?: string; error_description?: string };

async function errorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

function errorText(body: ErrorBody, status: number): string {
  return body.error_description || body.error || `HTTP ${status}`;
}

async function errorMessage(response: Response): Promise<string> {
  return errorText(await errorBody(response), response.status);
}
