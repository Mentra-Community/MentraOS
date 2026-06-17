import * as jose from "jose";

const DEFAULT_CORE_URL = "http://localhost:3000";
const DEFAULT_ISSUER = "mentra";
const DEFAULT_CLOCK_TOLERANCE = "2 minutes";
const DEFAULT_ALGORITHMS = ["EdDSA"] as const;

export interface VerifiedMiniappToken {
  mentraUserId: string;
  oemId?: string;
  packageName: string;
  tokenId?: string;
  expiresAt?: number;
  issuedAt?: number;
  claims: jose.JWTPayload;
}

export interface MiniappAuthOptions {
  /**
   * The packageName this backend serves. Miniapp auth tokens are audience-pinned
   * to exactly one packageName, so this should be the miniapp's packageName.
   */
  packageName?: string;
  /**
   * Core base URL used to discover /.well-known/jwks.json. Ignored when
   * jwksUrl is set. Defaults to MENTRA_CORE_URL or http://localhost:3000.
   */
  coreUrl?: string;
  /**
   * Explicit JWKS URL. Useful for proxies, tests, or non-standard hosting.
   */
  jwksUrl?: string;
  /**
   * Expected token issuer. Core currently mints miniapp tokens with iss=mentra.
   */
  issuer?: string;
  /**
   * Allowed signature algorithms. Defaults to EdDSA.
   */
  algorithms?: string[];
  /**
   * jose clockTolerance option. Defaults to two minutes for mobile clock skew.
   */
  clockTolerance?: string | number;
  /**
   * Remote JWKS fetch timeout in milliseconds.
   */
  timeoutMs?: number;
  /**
   * Remote JWKS cache max age in milliseconds.
   */
  cacheMaxAgeMs?: number;
  /**
   * Remote JWKS cooldown duration in milliseconds.
   */
  cooldownMs?: number;
}

export class MiniappAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniappAuthError";
  }
}

export class MiniappAuthVerifier {
  private readonly packageName: string;
  private readonly issuer: string;
  private readonly algorithms: string[];
  private readonly clockTolerance: string | number;
  private readonly jwksUrl: string;
  private jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

  constructor(options: MiniappAuthOptions = {}) {
    this.packageName = resolvePackageName(options.packageName);
    this.issuer = options.issuer ?? env("MENTRA_MINIAPP_TOKEN_ISSUER") ?? DEFAULT_ISSUER;
    this.algorithms = options.algorithms ?? [...DEFAULT_ALGORITHMS];
    this.clockTolerance = options.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
    this.jwksUrl = resolveJwksUrl(options);
    this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUrl), {
      timeoutDuration: options.timeoutMs ?? 5_000,
      cacheMaxAge: options.cacheMaxAgeMs,
      cooldownDuration: options.cooldownMs ?? 30_000,
    });
  }

  async verifyToken(token: string): Promise<VerifiedMiniappToken> {
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, this.getJwks(), {
        issuer: this.issuer,
        audience: this.packageName,
        algorithms: this.algorithms,
        clockTolerance: this.clockTolerance,
      });
      payload = result.payload;
    } catch (err) {
      throw new MiniappAuthError(`miniapp token rejected: ${(err as Error).message}`);
    }

    const subject = stringClaim(payload.sub);
    if (!subject) {
      throw new MiniappAuthError("miniapp token missing subject");
    }

    return {
      mentraUserId: subject,
      oemId: stringClaim(payload.oemId),
      packageName: this.packageName,
      tokenId: stringClaim(payload.jti),
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
      claims: payload,
    };
  }

  async verifyAuthHeader(header: string | undefined | null): Promise<VerifiedMiniappToken> {
    return this.verifyToken(extractBearerToken(header));
  }

  private getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
    if (!this.jwks) {
      this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUrl));
    }
    return this.jwks;
  }
}

export function createMiniappAuthVerifier(options: MiniappAuthOptions = {}): MiniappAuthVerifier {
  return new MiniappAuthVerifier(options);
}

export async function verifyMiniappToken(
  token: string,
  options: MiniappAuthOptions = {},
): Promise<VerifiedMiniappToken> {
  return createMiniappAuthVerifier(options).verifyToken(token);
}

export async function verifyMiniappAuthHeader(
  header: string | undefined | null,
  options: MiniappAuthOptions = {},
): Promise<VerifiedMiniappToken> {
  return createMiniappAuthVerifier(options).verifyAuthHeader(header);
}

export function extractBearerToken(header: string | undefined | null): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) {
    throw new MiniappAuthError("missing bearer token");
  }
  return match[1];
}

export function miniappJwksUrl(options: Pick<MiniappAuthOptions, "coreUrl" | "jwksUrl"> = {}): string {
  return resolveJwksUrl(options);
}

function resolvePackageName(packageName?: string): string {
  const value =
    packageName ??
    env("MENTRA_PACKAGE_NAME") ??
    env("MINIAPP_PACKAGE_NAME") ??
    env("PACKAGE_NAME");
  if (!value) {
    throw new MiniappAuthError("packageName is required");
  }
  return value;
}

function resolveJwksUrl(options: Pick<MiniappAuthOptions, "coreUrl" | "jwksUrl">): string {
  const explicit = options.jwksUrl ?? env("MENTRA_JWKS_URL");
  if (explicit) return explicit;

  const coreUrl = trimTrailingSlash(options.coreUrl ?? env("MENTRA_CORE_URL") ?? DEFAULT_CORE_URL);
  return `${coreUrl}/.well-known/jwks.json`;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
