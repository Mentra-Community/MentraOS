import type { CliConfig } from "./config";
import type { CliCredentials } from "./credentials";

const DEVICE_AUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type CliJwk = Record<string, unknown> & {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
};

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
  latestRelease: DeveloperRelease | null;
  releaseCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeveloperRelease {
  id: string;
  version: string;
  status: "draft" | "submitted" | "in_review" | "accepted" | "rejected" | "published" | "suspended";
  releaseBundleAssetId: string | null;
  bundleSha256: string | null;
  bundleSizeBytes: number | null;
  manifestSha256?: string | null;
  signingKeyId?: string | null;
  signedAt?: string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeveloperOrg {
  id: string;
  ownerUserId: string;
  workosOrgId: string | null;
  name: string;
  packagePrefix: string;
  packagePrefixStatus: "unverified" | "verified" | "rejected";
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeveloperSigningKey {
  id: string;
  orgId: string;
  workosUserId: string;
  publicKeyJwk: CliJwk;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SignedBundleMetadata {
  signingKeyId: string;
  signature: string;
  payload: {
    packageName: string;
    version: string;
    bundleSha256: string;
    manifestSha256: string;
    createdAt: string;
  };
}

export type PreinstallEnvironment = "debug" | "dev" | "staging" | "prod";
export type PreinstallPolicy = "install_once" | "keep_updated" | "mandatory";

export interface AdminUser {
  developerId: string;
  email: string;
}

export interface AdminRegistry {
  id: string;
  name: string;
  environment: PreinstallEnvironment;
  tenantId: string | null;
  status: "draft" | "active" | "archived";
  activeRevisionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminReleaseSummary {
  id: string;
  miniAppId?: string;
  packageName: string;
  displayName: string;
  version: string;
  status: DeveloperRelease["status"];
  bundleSha256: string | null;
  bundleSizeBytes: number | null;
  createdAt: string | null;
}

export interface AdminRegistryRevision {
  id: string;
  registryId: string;
  status: "draft" | "active" | "archived";
  reason: string | null;
  entries: Array<{
    id: string;
    miniAppId: string;
    releaseId: string;
    required: boolean;
    installPolicy: PreinstallPolicy;
    minMobileVersion: string | null;
    maxMobileVersion: string | null;
    priority: number;
  }>;
  promotedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function startLogin(config: CliConfig): Promise<DeviceAuthorizationResponse> {
  assertWorkosClientId(config);
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
  assertWorkosClientId(config);
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
  assertWorkosClientId(config);
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
  return coreRequest(credentials, "/api/console/apps");
}

export async function getAdminMe(
  credentials: CliCredentials,
): Promise<{ authenticated: true; admin: true; user: AdminUser | null }> {
  return coreRequest(credentials, "/api/admin/me");
}

export async function listAdminRegistries(credentials: CliCredentials): Promise<{ registries: AdminRegistry[] }> {
  return coreRequest(credentials, "/api/admin/preinstalled/registries");
}

export async function ensureAdminRegistry(
  credentials: CliCredentials,
  input: { environment: PreinstallEnvironment; name?: string; tenantId?: string | null },
): Promise<{ registry: AdminRegistry }> {
  return coreRequest(credentials, "/api/admin/preinstalled/registries", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAdminPreinstallReleases(
  credentials: CliCredentials,
): Promise<{ releases: AdminReleaseSummary[] }> {
  return coreRequest(credentials, "/api/admin/preinstalled/releases");
}

export async function listAdminRegistryRevisions(
  credentials: CliCredentials,
  registryId: string,
): Promise<{ revisions: AdminRegistryRevision[] }> {
  return coreRequest(credentials, `/api/admin/preinstalled/registries/${encodeURIComponent(registryId)}/revisions`);
}

export async function createAdminRegistryRevision(
  credentials: CliCredentials,
  registryId: string,
  input: {
    reason?: string | null;
    entries: Array<{
      releaseId: string;
      required?: boolean;
      installPolicy?: PreinstallPolicy;
      minMobileVersion?: string | null;
      maxMobileVersion?: string | null;
      priority?: number;
    }>;
  },
): Promise<{ revision: AdminRegistryRevision }> {
  return coreRequest(credentials, `/api/admin/preinstalled/registries/${encodeURIComponent(registryId)}/revisions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function promoteAdminRegistryRevision(
  credentials: CliCredentials,
  registryId: string,
  revisionId: string,
): Promise<{ registry: AdminRegistry; revision: AdminRegistryRevision }> {
  return coreRequest(
    credentials,
    `/api/admin/preinstalled/registries/${encodeURIComponent(registryId)}/revisions/${encodeURIComponent(revisionId)}/promote`,
    { method: "POST" },
  );
}

export async function getOrg(credentials: CliCredentials): Promise<{ org: DeveloperOrg | null }> {
  return coreRequest(credentials, "/api/console/org");
}

export async function upsertOrg(
  credentials: CliCredentials,
  input: { displayName: string; packagePrefix: string },
): Promise<{ org: DeveloperOrg }> {
  return coreRequest(credentials, "/api/console/org", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createApp(
  credentials: CliCredentials,
  input: { packageName: string; displayName: string; description?: string | null },
): Promise<{ app: DeveloperApp }> {
  return coreRequest(credentials, "/api/console/apps", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteApp(credentials: CliCredentials, packageName: string): Promise<{ ok: true }> {
  return coreRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}`, {
    method: "DELETE",
  });
}

export async function listReleases(
  credentials: CliCredentials,
  packageName: string,
): Promise<{ releases: DeveloperRelease[] }> {
  return coreRequest(credentials, `/api/console/apps/${encodeURIComponent(packageName)}/releases`);
}

export async function createRelease(
  credentials: CliCredentials,
  input: {
    packageName: string;
    version: string;
    manifest: Record<string, unknown>;
    bundle: Uint8Array;
    fileName?: string;
    signedBundle: SignedBundleMetadata;
  },
): Promise<{ release: DeveloperRelease }> {
  const form = new FormData();
  form.set("packageName", input.packageName);
  form.set("version", input.version);
  form.set("manifest", JSON.stringify(input.manifest));
  form.set("signedBundle", JSON.stringify(input.signedBundle));
  form.set("fileName", input.fileName ?? "bundle.zip");
  form.set("bundle", new Blob([input.bundle], { type: "application/zip" }), input.fileName ?? "bundle.zip");
  return coreRequest(credentials, `/api/console/apps/${encodeURIComponent(input.packageName)}/releases`, {
    method: "POST",
    body: form,
  });
}

export async function listSigningKeys(credentials: CliCredentials): Promise<{ keys: DeveloperSigningKey[] }> {
  return coreRequest(credentials, "/api/console/signing-keys");
}

export async function registerSigningKey(
  credentials: CliCredentials,
  input: { publicKeyJwk: CliJwk },
): Promise<{ key: DeveloperSigningKey }> {
  return coreRequest(credentials, "/api/console/signing-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function submitRelease(
  credentials: CliCredentials,
  input: {
    packageName: string;
    releaseId: string;
  },
): Promise<{ release: DeveloperRelease }> {
  return coreRequest(
    credentials,
    `/api/console/apps/${encodeURIComponent(input.packageName)}/releases/${encodeURIComponent(input.releaseId)}/submit`,
    { method: "POST" },
  );
}

async function coreRequest<T>(credentials: CliCredentials, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${credentials.coreUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credentials.token}`,
      ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

function assertWorkosClientId(config: CliConfig): void {
  if (!config.workosClientId) {
    throw new Error(
      "WORKOS_CLIENT_ID is not configured. Add the public AuthKit client id to Doppler cloud-v2/dev as WORKOS_CLIENT_ID.",
    );
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; error_description?: string };
    return body.error_description || body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
