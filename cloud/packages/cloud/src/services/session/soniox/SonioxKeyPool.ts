import crypto from "crypto";

export type SonioxCredentialRole = "primary" | "fallback";

export interface SonioxCredential {
  id: string;
  apiKey: string;
  role: SonioxCredentialRole;
}

type SonioxCredentialFailureKind =
  | "auth"
  | "concurrency"
  | "quota"
  | "rate_limit"
  | "transient";

interface SonioxCredentialState extends SonioxCredential {
  cooldownUntil: number;
  disabled: boolean;
  failureKind?: SonioxCredentialFailureKind;
  lastFailureMessage?: string;
}

export interface SonioxCredentialFailureClassification {
  kind: SonioxCredentialFailureKind;
  cooldownMs: number;
  disabled?: boolean;
}

const CONCURRENCY_COOLDOWN_MS = 5_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const QUOTA_COOLDOWN_MS = 30 * 60_000;
const TRANSIENT_COOLDOWN_MS = 10_000;
const sharedPools = new Map<string, SonioxKeyPool>();

export function parseSonioxFallbackApiKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function fingerprintSonioxKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

export function classifySonioxCredentialFailure(error: Error): SonioxCredentialFailureClassification {
  const message = error.message || "";
  const lower = message.toLowerCase();
  const code = extractSonioxErrorCode(message);

  if (
    code === 401 ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("bad api key") ||
    lower.includes("unauthorized")
  ) {
    return { kind: "auth", cooldownMs: Number.POSITIVE_INFINITY, disabled: true };
  }

  if (
    lower.includes("concurrent") ||
    lower.includes("concurrency") ||
    lower.includes("connection limit") ||
    lower.includes("stream limit") ||
    lower.includes("too many streams") ||
    lower.includes("maximum streams") ||
    lower.includes("max streams")
  ) {
    return { kind: "concurrency", cooldownMs: CONCURRENCY_COOLDOWN_MS };
  }

  if (
    code === 402 ||
    lower.includes("quota") ||
    lower.includes("budget") ||
    lower.includes("exhausted") ||
    lower.includes("credit") ||
    lower.includes("billing") ||
    lower.includes("spend") ||
    lower.includes("balance") ||
    lower.includes("usage limit") ||
    lower.includes("monthly limit")
  ) {
    return { kind: "quota", cooldownMs: QUOTA_COOLDOWN_MS };
  }

  if (
    code === 429 ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests")
  ) {
    return { kind: "rate_limit", cooldownMs: RATE_LIMIT_COOLDOWN_MS };
  }

  return { kind: "transient", cooldownMs: TRANSIENT_COOLDOWN_MS };
}

export function getSharedSonioxKeyPool(primaryApiKey: string, fallbackApiKeys: string[] = []): SonioxKeyPool {
  const poolKey = [
    fingerprintSonioxKey(primaryApiKey.trim()),
    ...fallbackApiKeys.map((key) => key.trim()).filter(Boolean).map(fingerprintSonioxKey),
  ].join(":");

  const existing = sharedPools.get(poolKey);
  if (existing) return existing;

  const pool = new SonioxKeyPool(primaryApiKey, fallbackApiKeys);
  sharedPools.set(poolKey, pool);
  return pool;
}

export function resetSharedSonioxKeyPoolsForTests(): void {
  sharedPools.clear();
}

export class SonioxKeyPool {
  private credentials: SonioxCredentialState[];
  private nextFallbackIndex = 0;

  constructor(primaryApiKey: string, fallbackApiKeys: string[] = []) {
    const seen = new Set<string>();
    const credentials: SonioxCredentialState[] = [];

    const addCredential = (apiKey: string, role: SonioxCredentialRole): void => {
      const trimmed = apiKey.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      credentials.push({
        id: fingerprintSonioxKey(trimmed),
        apiKey: trimmed,
        role,
        cooldownUntil: 0,
        disabled: false,
      });
    };

    addCredential(primaryApiKey, "primary");
    for (const key of fallbackApiKeys) {
      addCredential(key, "fallback");
    }

    this.credentials = credentials;
  }

  get size(): number {
    return this.credentials.length;
  }

  get hasFallbacks(): boolean {
    return this.credentials.some((credential) => credential.role === "fallback");
  }

  selectCredential(attempted = new Set<string>(), now = Date.now()): SonioxCredential | null {
    const primary = this.credentials.find((credential) => credential.role === "primary");
    if (primary && !attempted.has(primary.id) && this.isAvailable(primary, now)) {
      return this.toPublicCredential(primary);
    }

    const fallbackCredentials = this.credentials.filter((credential) => credential.role === "fallback");
    if (fallbackCredentials.length === 0) return null;

    for (let offset = 0; offset < fallbackCredentials.length; offset++) {
      const index = (this.nextFallbackIndex + offset) % fallbackCredentials.length;
      const credential = fallbackCredentials[index];
      if (attempted.has(credential.id) || !this.isAvailable(credential, now)) continue;

      this.nextFallbackIndex = (index + 1) % fallbackCredentials.length;
      return this.toPublicCredential(credential);
    }

    return null;
  }

  recordSuccess(credentialId: string): void {
    const credential = this.findCredential(credentialId);
    if (!credential || credential.disabled) return;
    credential.cooldownUntil = 0;
    credential.failureKind = undefined;
    credential.lastFailureMessage = undefined;
  }

  recordFailure(credentialId: string, error: Error, now = Date.now()): SonioxCredentialFailureClassification | null {
    const credential = this.findCredential(credentialId);
    if (!credential) return null;

    const classification = classifySonioxCredentialFailure(error);
    credential.failureKind = classification.kind;
    credential.lastFailureMessage = error.message;

    if (classification.disabled) {
      credential.disabled = true;
      credential.cooldownUntil = Number.POSITIVE_INFINITY;
    } else {
      credential.cooldownUntil = now + classification.cooldownMs;
    }

    return classification;
  }

  describeAvailability(now = Date.now()): Array<{
    id: string;
    role: SonioxCredentialRole;
    available: boolean;
    disabled: boolean;
    cooldownRemainingMs: number;
    failureKind?: SonioxCredentialFailureKind;
  }> {
    return this.credentials.map((credential) => ({
      id: credential.id,
      role: credential.role,
      available: this.isAvailable(credential, now),
      disabled: credential.disabled,
      cooldownRemainingMs:
        credential.cooldownUntil === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : Math.max(0, credential.cooldownUntil - now),
      failureKind: credential.failureKind,
    }));
  }

  private findCredential(credentialId: string): SonioxCredentialState | undefined {
    return this.credentials.find((credential) => credential.id === credentialId);
  }

  private isAvailable(credential: SonioxCredentialState, now: number): boolean {
    return !credential.disabled && credential.cooldownUntil <= now;
  }

  private toPublicCredential(credential: SonioxCredentialState): SonioxCredential {
    return {
      id: credential.id,
      apiKey: credential.apiKey,
      role: credential.role,
    };
  }
}

function extractSonioxErrorCode(message: string): number | null {
  const match = message.match(/Soniox error (\d+):/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
