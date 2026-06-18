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
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function startLogin(config: CliConfig): Promise<DeviceAuthorizationResponse> {
  assertWorkosClientId(config);
  const body = new URLSearchParams({ client_id: config.workosClientId });
  const response = await fetch(`${config.workosApiBaseUrl}/user_management/authorize/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (response.status === 400 || response.status === 403) {
    const result = await response.json().catch(() => ({})) as { error?: string; error_description?: string };
    if (result.error === "authorization_pending") return { status: "pending" };
    if (result.error === "slow_down") return { status: "slow_down" };
    throw new Error(result.error_description || result.error || `HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as LoginTokenResponse;
}

export async function listApps(credentials: CliCredentials): Promise<{ apps: DeveloperApp[] }> {
  return coreRequest(credentials, "/api/console/apps");
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
    bundleBase64: string;
    fileName?: string;
  },
): Promise<{ release: DeveloperRelease }> {
  return coreRequest(credentials, `/api/console/apps/${encodeURIComponent(input.packageName)}/releases`, {
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

async function coreRequest<T>(
  credentials: CliCredentials,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${credentials.coreUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credentials.token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return await response.json() as T;
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
