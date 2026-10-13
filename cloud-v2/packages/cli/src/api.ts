import type { CredentialView, PrincipalResponse, WorkspaceDetail } from "@mentra/workspace-contract";
import type { CliConfig } from "./config";
import type { CliCredentials } from "./credentials";

const DEVICE_AUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface LoginTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: "Bearer";
  expires_in?: number;
  authentication_method?: string;
  organization_id?: string | null;
  user: {
    id: string;
    email: string;
    first_name?: string | null;
    last_name?: string | null;
  };
}

export interface PendingDeviceAuthorization {
  status: "pending";
  interval?: number;
}

export interface SlowDownDeviceAuthorization {
  status: "slow_down";
  interval?: number;
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

export function getListing(credentials: CliCredentials, packageName: string): Promise<{listing: StoreListing}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing`);
}

export function updateListing(credentials: CliCredentials, packageName: string, input: StoreListingInput): Promise<{listing: StoreListing}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing`, {method: "PUT", body: JSON.stringify(input)});
}

export function uploadListingAsset(credentials: CliCredentials, packageName: string, input: {role: StoreAsset["role"]; fileName: string; contentType: string; base64: string}): Promise<{asset: StoreAsset}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing/assets`, {method: "POST", body: JSON.stringify(input)});
}

export function deleteListingAsset(credentials: CliCredentials, packageName: string, assetId: string): Promise<{ok: true}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/listing/assets/${encodeURIComponent(assetId)}`, {method: "DELETE"});
}

export function publishRelease(credentials: CliCredentials, packageName: string, releaseId: string): Promise<{release: DeveloperRelease}> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/releases/${encodeURIComponent(releaseId)}/publish`, {method: "POST"});
}

export function reviewRelease(credentials: CliCredentials, releaseId: string, action: "approve" | "reject" | "publish", notes?: string): Promise<{release: DeveloperRelease}> {
  return storeRequest(credentials, `/api/admin/submissions/${encodeURIComponent(releaseId)}/${action}`, {method: "POST", body: JSON.stringify({notes})});
}

export function createPublishingToken(credentials: CliCredentials, packageName: string, name: string): Promise<{token: {id: string; value: string; permissions: string[]}}> {
  return storeRequest(credentials, `/api/admin/apps/${encodeURIComponent(packageName)}/publishing-tokens`, {method: "POST", body: JSON.stringify({name})});
}

export function listWorkspaceCredentials(credentials: CliCredentials, workspaceId: string): Promise<{ items: CredentialView[] }> {
  return storeRequest(credentials, `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials`);
}

export function createWorkspaceCredential(
  credentials: CliCredentials,
  workspaceId: string,
  input: { name: string; packageNames?: string[]; expiresAt?: string },
): Promise<{ credential: CredentialView; token: string }> {
  return storeRequest(credentials, `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeWorkspaceCredential(credentials: CliCredentials, workspaceId: string, credentialId: string): Promise<void> {
  return storeRequest(
    credentials,
    `/api/console/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
}

export async function startLogin(config: CliConfig): Promise<DeviceAuthorizationResponse> {
  await ensureWorkosClientId(config);
  const body = new URLSearchParams({ client_id: config.workosClientId });
  const response = await fetch(`${config.workosApiBaseUrl}/user_management/authorize/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as DeviceAuthorizationResponse;
}

export async function pollLoginToken(
  config: CliConfig,
  deviceCode: string,
): Promise<LoginTokenResponse | PendingDeviceAuthorization | SlowDownDeviceAuthorization> {
  await ensureWorkosClientId(config);
  const body = new URLSearchParams({
    grant_type: DEVICE_AUTH_GRANT_TYPE,
    device_code: deviceCode,
    client_id: config.workosClientId,
  });
  const response = await fetch(`${config.workosApiBaseUrl}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json" },
    body,
  });
  if (response.status === 400 || response.status === 403) {
    const result = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (result.error === "authorization_pending") return { status: "pending" };
    if (result.error === "slow_down") return { status: "slow_down" };
    throw new Error(result.error_description || result.error || `HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as LoginTokenResponse;
}

export async function refreshLoginToken(
  config: CliConfig,
  refreshToken: string,
  organizationId?: string | null,
): Promise<LoginTokenResponse> {
  await ensureWorkosClientId(config);
  const body: Record<string, string> = {
    client_id: config.workosClientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  if (organizationId) body.organization_id = organizationId;

  const response = await fetch(`${config.workosApiBaseUrl}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as LoginTokenResponse;
}

export async function listApps(credentials: CliCredentials): Promise<{ apps: DeveloperApp[] }> {
  return storeRequest(credentials, "/api/console/apps");
}

export async function getAdminMe(
  credentials: CliCredentials,
): Promise<{ authenticated: true; admin: true; user: AdminUser | null }> {
  return storeRequest(credentials, "/api/admin/me");
}

export async function getConsoleSession(credentials: CliCredentials): Promise<ConsoleSessionResponse> {
  return storeRequest(credentials, "/api/console/auth/me");
}

/** Create a workspace. The caller becomes its owner. */
export async function createWorkspace(credentials: CliCredentials, name: string): Promise<WorkspaceDetail> {
  // Creating is not scoped to a workspace, so a stale selection must not ride along.
  return storeRequest({ ...credentials, workspaceId: null }, "/api/console/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** The package prefix of the workspace the credentials select (`x-mentra-workspace-id`). */
export async function getPublishingProfile(credentials: CliCredentials): Promise<PublishingProfile> {
  return storeRequest(credentials, "/api/console/publishing-profile");
}

/**
 * The publishing profile as `workspace show` reports it. The Store answers 404 `not_found` for a
 * workspace that has no package prefix yet and 403 to a role that cannot publish; neither is a
 * failure of the command.
 */
export async function readPublishingProfile(
  credentials: CliCredentials,
): Promise<{ state: "set"; profile: PublishingProfile } | { state: "not_set" } | { state: "hidden" }> {
  try {
    return { state: "set", profile: await getPublishingProfile(credentials) };
  } catch (error) {
    if (error instanceof StoreRequestError && error.status === 404 && error.code === "not_found") return { state: "not_set" };
    if (error instanceof StoreRequestError && error.status === 403) return { state: "hidden" };
    throw error;
  }
}

export async function setPackagePrefix(credentials: CliCredentials, packagePrefix: string): Promise<PublishingProfile> {
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
export async function resolveWorkspaceId(credentials: CliCredentials): Promise<string> {
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
  credentials: CliCredentials,
  input: { packageName: string; displayName: string; description?: string | null },
): Promise<{ app: DeveloperApp }> {
  return storeRequest(credentials, "/api/console/apps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteApp(credentials: CliCredentials, packageName: string): Promise<{ ok: true }> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}`, {
    method: "DELETE",
  });
}

export async function listReleases(
  credentials: CliCredentials,
  packageName: string,
): Promise<{ releases: DeveloperRelease[] }> {
  return storeRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/releases`);
}

export async function createRelease(
  credentials: CliCredentials,
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
  credentials: CliCredentials,
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

async function storeRequest<T>(credentials: CliCredentials, path: string, init?: RequestInit): Promise<T> {
  const response = await storeFetch(credentials, path, init);
  if (!response.ok) throw await storeError(credentials, response);
  // A DELETE answers 204 with nothing to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function storeFetch(credentials: CliCredentials, path: string, init?: RequestInit): Promise<Response> {
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

async function storeError(credentials: CliCredentials, response: Response): Promise<Error> {
  const body = await errorBody(response);
  if (response.status === 409 && body.error === "workspace_selection_required") {
    return new WorkspaceSelectionRequiredError(await availableWorkspaces(credentials));
  }
  return new StoreRequestError(response.status, body.error ?? null, errorText(body, response.status));
}

/** Best effort: the instruction is still useful without the ids, so a failed lookup must not replace it. */
async function availableWorkspaces(credentials: CliCredentials): Promise<CliWorkspace[]> {
  try {
    const response = await storeFetch(credentials, "/api/console/auth/me");
    return response.ok ? ((await response.json()) as ConsoleSessionResponse).workspaces : [];
  } catch {
    return [];
  }
}

async function ensureWorkosClientId(config: CliConfig): Promise<void> {
  if (config.workosClientId) return;

  const response = await fetch(`${config.storeUrl}/api/console/auth/cli-config`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = (await response.json()) as { workosClientId?: unknown };
  if (typeof body.workosClientId !== "string" || !body.workosClientId.trim()) {
    throw new Error("The Mentra Miniapp Store did not provide a WorkOS client id for CLI login");
  }
  // Cache the public client id on this command's config so polling does not
  // refetch the Store every interval. Environment overrides still win for local or
  // non-Mentra deployments.
  config.workosClientId = body.workosClientId.trim();
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
