/**
 * Environment configuration for the mentra-console MCP server (Cloud V2).
 *
 * The server talks to one Cloud V2 core deployment, selected by
 * MENTRA_CORE_URL (explicit base URL) or MENTRA_ENV (prod | staging | dev).
 * Report tools require MENTRA_ADMIN_TOKEN: an operator key with the incident
 * read scope (organization.incidents.read), either a mak_ key created in the
 * admin dashboard under Operator keys or an msk_ admin key whose
 * api-key@<keyId>.local address is on CLOUD_CORE_ADMIN_EMAILS, or a WorkOS
 * access token of an Organization Admin. Operator keys belong to one Core deployment (organization) — a key
 * created on prod will not authenticate against staging or dev.
 */

export const CORE_URLS: Record<string, string> = {
  prod: "https://core.mentraglass.com",
  staging: "https://core.staging.us-west-2.mentraglass.com",
  dev: "https://core.dev.us-west-2.mentraglass.com",
};

export type CapabilityGroup = "reports";

export interface ConsoleMcpConfig {
  coreUrl: string;
  adminToken?: string;
  capabilities: Record<CapabilityGroup, boolean>;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConsoleMcpConfig {
  const envName = env.MENTRA_ENV?.trim().toLowerCase();
  if (envName && !CORE_URLS[envName]) {
    throw new Error(
      `Unknown MENTRA_ENV "${envName}" — expected one of: ${Object.keys(CORE_URLS).join(", ")}`,
    );
  }

  const coreUrl = (env.MENTRA_CORE_URL?.trim() || CORE_URLS[envName || "prod"]).replace(/\/+$/, "");
  const adminToken = env.MENTRA_ADMIN_TOKEN?.trim() || undefined;

  return {
    coreUrl,
    adminToken,
    capabilities: {
      reports: Boolean(adminToken),
    },
  };
}

export function requireCapability(config: ConsoleMcpConfig, group: CapabilityGroup): void {
  if (!config.capabilities[group]) {
    throw new Error(
      `Capability "${group}" is not configured. Set MENTRA_ADMIN_TOKEN in the MCP server environment.`,
    );
  }
}
