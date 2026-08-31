import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "./config";

const SERVICE = "mentra-cli-v2";
const LEGACY_NAME = "credentials";
const MENTRA_DIR = join(homedir(), ".mentra");
const CREDS_DIR = join(MENTRA_DIR, "cli-v2");
const LEGACY_CREDS_FILE = join(CREDS_DIR, "credentials.json");
const SIGNING_KEY_SERVICE = "mentra-cli-v2-signing";

export type CliJwk = Record<string, unknown> & {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
};

export interface CliCredentials {
  token: string;
  refreshToken?: string;
  workosUserId: string;
  email: string;
  organizationId?: string | null;
  developerOrgId?: string | null;
  authenticationMethod?: string;
  coreUrl: string;
  storeUrl: string;
  storedAt: string;
  expiresAt?: string;
}

export interface CliSigningKey {
  storeUrl: string;
  signingKeyId: string;
  publicKeyJwk: CliJwk;
  privateKeyJwk: CliJwk;
  createdAt: string;
}

export async function saveCredentials(credentials: CliCredentials): Promise<"keychain" | "file"> {
  const payload = JSON.stringify(credentials);
  const name = credentialName(credentials.coreUrl);

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SERVICE,
        name,
        value: payload,
      });
      return "keychain";
    }
  } catch {
    // Fall through to file storage.
  }

  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(credentialsFile(credentials.coreUrl), `${payload}\n`, { mode: 0o600 });
  return "file";
}

export async function loadCredentials(coreUrl?: string): Promise<CliCredentials | null> {
  const targetCoreUrl = coreUrl ? normalizeCoreUrl(coreUrl) : undefined;
  if (process.env.MENTRA_CLI_TOKEN) {
    return {
      token: process.env.MENTRA_CLI_TOKEN,
      workosUserId: process.env.MENTRA_CLI_WORKOS_USER_ID || "unknown",
      email: process.env.MENTRA_CLI_EMAIL || "unknown",
      organizationId: process.env.MENTRA_CLI_ORGANIZATION_ID,
      developerOrgId: process.env.MENTRA_CLI_DEVELOPER_ORG_ID,
      coreUrl: targetCoreUrl || getConfig().coreUrl,
      storeUrl: getConfig().storeUrl,
      storedAt: new Date().toISOString(),
    };
  }

  const scoped = targetCoreUrl ? await loadScopedCredentials(targetCoreUrl) : null;
  if (scoped) return scoped;

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({
        service: SERVICE,
        name: LEGACY_NAME,
      });
      if (value) {
        const legacy = JSON.parse(value) as CliCredentials;
        if (!targetCoreUrl || normalizeCoreUrl(legacy.coreUrl) === targetCoreUrl) return withCurrentStoreUrl(legacy);
      }
    }
  } catch {
    // Fall through.
  }

  try {
    if (existsSync(LEGACY_CREDS_FILE)) {
      const legacy = JSON.parse(readFileSync(LEGACY_CREDS_FILE, "utf8")) as CliCredentials;
      if (!targetCoreUrl || normalizeCoreUrl(legacy.coreUrl) === targetCoreUrl) return withCurrentStoreUrl(legacy);
    }
  } catch {
    // Treat corrupt credentials as logged out.
  }

  return null;
}

export async function clearCredentials(coreUrl?: string): Promise<void> {
  const targetCoreUrl = coreUrl ? normalizeCoreUrl(coreUrl) : undefined;

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SERVICE,
        name: targetCoreUrl ? credentialName(targetCoreUrl) : LEGACY_NAME,
        value: "",
      });
    }
  } catch {
    // Ignore keychain failures; remove file fallback below.
  }

  const path = targetCoreUrl ? credentialsFile(targetCoreUrl) : LEGACY_CREDS_FILE;
  if (existsSync(path)) {
    rmSync(path);
  }
}

export async function saveSigningKey(key: CliSigningKey): Promise<"keychain" | "file"> {
  const payload = JSON.stringify(key);
  const name = credentialName(key.storeUrl);

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SIGNING_KEY_SERVICE,
        name,
        value: payload,
      });
      return "keychain";
    }
  } catch {
    // Fall through to file storage.
  }

  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(signingKeyFile(key.storeUrl), `${payload}\n`, { mode: 0o600 });
  return "file";
}

export async function loadSigningKey(storeUrl: string): Promise<CliSigningKey | null> {
  const targetStoreUrl = normalizeCoreUrl(storeUrl);
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({
        service: SIGNING_KEY_SERVICE,
        name: credentialName(targetStoreUrl),
      });
      if (value) return JSON.parse(value) as CliSigningKey;
    }
  } catch {
    // Fall through.
  }

  try {
    const path = signingKeyFile(targetStoreUrl);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as CliSigningKey;
  } catch {
    // Treat corrupt key storage as missing.
  }

  return null;
}

async function loadScopedCredentials(coreUrl: string): Promise<CliCredentials | null> {
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({
        service: SERVICE,
        name: credentialName(coreUrl),
      });
      if (value) return withCurrentStoreUrl(JSON.parse(value) as CliCredentials);
    }
  } catch {
    // Fall through.
  }

  try {
    const path = credentialsFile(coreUrl);
    if (existsSync(path)) return withCurrentStoreUrl(JSON.parse(readFileSync(path, "utf8")) as CliCredentials);
  } catch {
    // Treat corrupt credentials as logged out.
  }

  return null;
}

function withCurrentStoreUrl(credentials: CliCredentials): CliCredentials {
  return {...credentials, storeUrl: getConfig().storeUrl};
}

function credentialName(coreUrl: string): string {
  return `credentials:${credentialKey(coreUrl)}`;
}

function credentialsFile(coreUrl: string): string {
  return join(CREDS_DIR, `credentials-${credentialKey(coreUrl)}.json`);
}

function signingKeyFile(coreUrl: string): string {
  return join(CREDS_DIR, `signing-key-${credentialKey(coreUrl)}.json`);
}

function credentialKey(coreUrl: string): string {
  return Buffer.from(normalizeCoreUrl(coreUrl)).toString("base64url");
}

function normalizeCoreUrl(coreUrl: string): string {
  const url = new URL(coreUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
