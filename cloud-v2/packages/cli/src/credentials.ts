import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE = "mentra-cli-v2";
const NAME = "credentials";
const MENTRA_DIR = join(homedir(), ".mentra");
const CREDS_DIR = join(MENTRA_DIR, "cli-v2");
const CREDS_FILE = join(CREDS_DIR, "credentials.json");

export interface CliCredentials {
  token: string;
  refreshToken?: string;
  workosUserId: string;
  email: string;
  organizationId?: string | null;
  authenticationMethod?: string;
  coreUrl: string;
  storedAt: string;
  expiresAt?: string;
}

export async function saveCredentials(credentials: CliCredentials): Promise<"keychain" | "file"> {
  const payload = JSON.stringify(credentials);

  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SERVICE,
        name: NAME,
        value: payload,
      });
      return "keychain";
    }
  } catch {
    // Fall through to file storage.
  }

  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, `${payload}\n`, { mode: 0o600 });
  return "file";
}

export async function loadCredentials(): Promise<CliCredentials | null> {
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      const value = await Bun.secrets.get({
        service: SERVICE,
        name: NAME,
      });
      if (value) return JSON.parse(value) as CliCredentials;
    }
  } catch {
    // Fall through.
  }

  if (process.env.MENTRA_CLI_TOKEN) {
    return {
      token: process.env.MENTRA_CLI_TOKEN,
      workosUserId: process.env.MENTRA_CLI_WORKOS_USER_ID || "unknown",
      email: process.env.MENTRA_CLI_EMAIL || "unknown",
      organizationId: process.env.MENTRA_CLI_ORGANIZATION_ID,
      coreUrl: process.env.MENTRA_CORE_URL || "http://localhost:3000",
      storedAt: new Date().toISOString(),
    };
  }

  try {
    if (existsSync(CREDS_FILE)) {
      return JSON.parse(readFileSync(CREDS_FILE, "utf8")) as CliCredentials;
    }
  } catch {
    // Treat corrupt credentials as logged out.
  }

  return null;
}

export async function clearCredentials(): Promise<void> {
  try {
    if (typeof Bun !== "undefined" && Bun.secrets) {
      await Bun.secrets.set({
        service: SERVICE,
        name: NAME,
        value: "",
      });
    }
  } catch {
    // Ignore keychain failures; remove file fallback below.
  }

  if (existsSync(CREDS_FILE)) {
    rmSync(CREDS_FILE);
  }
}
